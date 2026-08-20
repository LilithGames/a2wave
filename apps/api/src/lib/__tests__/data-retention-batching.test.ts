/**
 * Integration test for data-retention batch deletion, run against a real
 * in-memory SQLite (drizzle) so the actual IN (...) parameter binding is
 * exercised — a mock cannot reproduce the "too many SQL variables" limit.
 *
 * Regression: the retention sweep collected the ENTIRE backlog of doomed runs
 * and passed every id to a single IN (...), which throws once the count exceeds
 * better-sqlite3's MAX_VARIABLE_NUMBER (32766). Because each sweep re-selects the
 * full backlog, that state never self-heals. The fix deletes in fixed batches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const Database = (await import('better-sqlite3')).default
  const sqlite = new Database(':memory:')
  // Minimal schema: runs plus the artifacts/artifact_shares the active-share
  // exclusion joins against. No FKs needed — we only test the delete batching.
  sqlite.exec(`
    CREATE TABLE runs (
      id text PRIMARY KEY NOT NULL,
      intent text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      result text,
      execution_metadata text,
      trigger_source text,
      trigger_session_id text,
      trigger_event_id text,
      work_dir text,
      owner_instance_id text,
      worktree_config text,
      initiator_agent_id text,
      user_id text,
      trigger_user_name text,
      trigger_agent_name text,
      input_tokens integer,
      output_tokens integer,
      reasoning_tokens integer,
      cache_read_tokens integer,
      cache_write_tokens integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE artifacts (
      id text PRIMARY KEY NOT NULL,
      run_id text,
      storage_path text NOT NULL
    );
    CREATE TABLE artifact_shares (
      id text PRIMARY KEY NOT NULL,
      artifact_id text NOT NULL,
      expires_at integer NOT NULL,
      revoked_at integer
    );
    CREATE TABLE audit_logs (
      id text PRIMARY KEY NOT NULL,
      created_at integer
    );
  `)
  return { db: drizzle(sqlite) }
})

vi.mock('../artifact-storage.js', () => ({
  // Files are irrelevant here; just assert it is only ever handed bounded batches.
  // Async like the real one, so an unawaited call site is observable.
  purgeArtifactFilesForRuns: vi.fn(async (ids: string[]) => ids.length),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { db } from '../../db/client.js'
import { runs } from '../../db/schema.js'
import { purgeArtifactFilesForRuns } from '../artifact-storage.js'
import { runDataRetentionSweep } from '../data-retention.js'

beforeEach(() => {
  db.delete(runs).run()
  vi.mocked(purgeArtifactFilesForRuns).mockClear()
})

describe('data retention — batch deletion', () => {
  it('deletes a backlog larger than one batch without exceeding the SQL variable limit', async () => {
    // 1200 terminal runs, all older than the cutoff → 3 batches of 500/500/200.
    const old = new Date('2020-01-01T00:00:00.000Z')
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `run_${String(i).padStart(5, '0')}`,
      intent: 'test',
      status: 'completed' as const,
      createdAt: old,
      updatedAt: old,
    }))
    // Insert in chunks so THIS setup insert also stays under the variable limit.
    for (let i = 0; i < rows.length; i += 200) {
      db.insert(runs)
        .values(rows.slice(i, i + 200))
        .run()
    }

    const now = new Date('2026-01-01T00:00:00.000Z') // well past the cutoff
    const result = await runDataRetentionSweep({ enabled: true, retentionDays: 30 }, now)

    expect((await result).runs).toBe(1200)
    expect(db.select({ id: runs.id }).from(runs).all()).toHaveLength(0)

    // Every purge call must have received a bounded batch (never the whole set).
    for (const call of vi.mocked(purgeArtifactFilesForRuns).mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(500)
    }
    // 1200 / 500 → 3 batches.
    expect(vi.mocked(purgeArtifactFilesForRuns)).toHaveBeenCalledTimes(3)
  })

  // Regression: purgeArtifactFilesForRuns became async during the PostgreSQL
  // migration but the call site kept firing it without await, so the cascade
  // DELETE wiped the artifact rows first — the purge then read an empty set and
  // the files were stranded on disk forever.
  it('finishes purging a batch before deleting its runs', async () => {
    const old = new Date('2020-01-01T00:00:00.000Z')
    db.insert(runs)
      .values([
        { id: 'run_purge', intent: 'test', status: 'completed', createdAt: old, updatedAt: old },
      ])
      .run()

    let runsStillPresentWhenPurgeFinished: number | undefined
    vi.mocked(purgeArtifactFilesForRuns).mockImplementationOnce(async (ids: string[]) => {
      // Yield so an unawaited caller would have raced ahead to the DELETE.
      await new Promise((resolve) => setTimeout(resolve, 0))
      runsStillPresentWhenPurgeFinished = db.select({ id: runs.id }).from(runs).all().length
      return ids.length
    })

    const now = new Date('2026-01-01T00:00:00.000Z')
    await runDataRetentionSweep({ enabled: true, retentionDays: 30 }, now)

    // The run row must survive until the purge has read the artifacts it owns.
    expect(runsStillPresentWhenPurgeFinished).toBe(1)
    expect(db.select({ id: runs.id }).from(runs).all()).toHaveLength(0)
  })

  it('leaves runs newer than the cutoff untouched', async () => {
    const recent = new Date('2025-12-25T00:00:00.000Z')
    db.insert(runs)
      .values([
        {
          id: 'run_recent',
          intent: 'test',
          status: 'completed',
          createdAt: recent,
          updatedAt: recent,
        },
      ])
      .run()

    const now = new Date('2026-01-01T00:00:00.000Z') // 30-day cutoff = 2025-12-02
    const result = await runDataRetentionSweep({ enabled: true, retentionDays: 30 }, now)

    expect((await result).runs).toBe(0)
    expect(db.select({ id: runs.id }).from(runs).all()).toHaveLength(1)
  })
})
