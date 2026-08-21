/**
 * End-to-end check that a reaped run is actually resumable afterwards.
 *
 * The unit tests assert the reaper calls markForResume and requeueRun. That is
 * not the same claim as "the next execution resumes": those two writes have to
 * survive into the row the resumed process re-reads, through a metadata CAS
 * and a status CAS that clears neighbouring columns. Production showed a run
 * requeued by this pass re-executing with no resumeAttempts recorded, which is
 * only visible if the chain is exercised against a real database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const Database = (await import('better-sqlite3')).default
  const sqlite = new Database(':memory:')
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
      queued_at integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE run_steps (
      id text PRIMARY KEY NOT NULL,
      run_id text NOT NULL,
      agent_id text,
      "order" integer NOT NULL,
      input text,
      output text,
      status text NOT NULL DEFAULT 'pending',
      duration_ms integer,
      wait_ms integer,
      created_at integer NOT NULL
    );
  `)
  const schema = await import('../../db/schema.js')
  return { db: drizzle(sqlite, { schema }), sqlite, sqliteDatabase: sqlite, isPostgres: false }
})

vi.mock('../../engine/execution-lease-registry.js', () => ({ listActiveExecutionLeases: () => [] }))
vi.mock('../../lib/scm-workload-lifecycle.js', () => ({
  withScmWorkloadAdmission: vi.fn(),
  activateScmWorkload: vi.fn(),
  activateScmWorkloadInMutation: vi.fn(),
  releaseReservedScmWorkload: vi.fn(),
}))
vi.mock('../scm-path-plan.js', () => ({
  withScmPathMutation: async (fn: (tx: unknown) => Promise<unknown>) => {
    const { db } = await import('../../db/client.js')
    return await fn(db)
  },
}))
vi.mock('../scm-lease-sweeper.js', () => ({ syncReapedRunExternalState: vi.fn() }))

const { db } = await import('../../db/client.js')
const { runs, runSteps } = await import('../../db/schema.js')
const { reapOrphanedRuns } = await import('../orphaned-run-reaper.js')
const { resumeChatIdFromRow } = await import('../resume-chat-id.js')

const NOW = new Date('2026-08-20T10:00:00Z')
const LONG_AGO = new Date('2026-08-20T08:00:00Z')

describe('reaper → requeue → resume, against a real database', () => {
  beforeEach(async () => {
    await db.delete(runSteps)
    await db.delete(runs)
    await db.insert(runs).values({
      id: 'run_1',
      intent: 'review the merge request',
      status: 'running',
      ownerInstanceId: 'dead-instance',
      executionMetadata: { liveChatId: 'sess_live' },
      initiatorAgentId: 'agt_1',
      createdAt: LONG_AGO,
      updatedAt: LONG_AGO,
    } as never)
  })

  it('leaves a row the next execution reads as a resume', async () => {
    const { defaultReaperDepsForTest } = await import('../orphaned-run-reaper.js')
    const reaped = await reapOrphanedRuns({
      ...defaultReaperDepsForTest,
      listCandidates: async () => [
        { id: 'run_1', agentId: 'agt_1', ownerInstanceId: 'dead-instance', startedAt: LONG_AGO },
      ],
      loadLiveness: async () => new Map(),
      canJudgePeers: () => true,
      isRunLocallyActive: () => false,
      afterRunSettled: vi.fn(async () => {}),
      now: () => NOW,
    })

    expect(reaped).toEqual([{ runId: 'run_1', agentId: 'agt_1', resumed: true }])

    // What executeChatRun does on the next turn: read the row, decide.
    const row = (await db.select().from(runs))[0]
    expect(row?.status).toBe('queued')
    expect(resumeChatIdFromRow(row as never)).toBe('sess_live')
  })
})
