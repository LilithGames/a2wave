/**
 * Integration test for requeueForResume against real SQLite.
 *
 * The function exists to clear two fields besides the status, and a fake would
 * happily agree with SQL that cleared neither. Both omissions are silent: a
 * stale result judges the resumed run by the old error, and a stale owner
 * leaves the row matching the orphaned-run reaper's dead-owner predicate, so
 * the reaper settles a run recovery just rescued.
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
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
  `)
  const schema = await import('../../db/schema.js')
  return { db: drizzle(sqlite, { schema }), sqlite, sqliteDatabase: sqlite, isPostgres: false }
})

vi.mock('../execution-lease-registry.js', () => ({ listActiveExecutionLeases: () => [] }))
vi.mock('../../lib/scm-workload-lifecycle.js', () => ({
  withScmWorkloadAdmission: vi.fn(),
  activateScmWorkload: vi.fn(),
  activateScmWorkloadInMutation: vi.fn(),
  releaseReservedScmWorkload: vi.fn(),
}))
vi.mock('../../lib/scm-path-plan.js', () => ({ withScmPathMutation: vi.fn() }))

const { db } = await import('../../db/client.js')
const { runs } = await import('../../db/schema.js')
const { taskQueueDb } = await import('../task-queue-db.js')

const NOW = new Date('2026-08-20T10:00:00Z')

async function seedRun(overrides: Record<string, unknown> = {}) {
  await db.insert(runs).values({
    id: 'run_1',
    intent: 'review',
    status: 'running',
    ownerInstanceId: 'dead-instance',
    result: { error: { code: 'SERVER_RESTART_DURING_EXEC' } },
    executionMetadata: { liveChatId: 'sess_live' },
    initiatorAgentId: 'agt_1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never)
}

async function loadRun() {
  return (await db.select().from(runs))[0]
}

describe('taskQueueDb.requeueForResume', () => {
  beforeEach(async () => {
    await db.delete(runs)
  })

  it('returns the run to the queue', async () => {
    await seedRun()
    await taskQueueDb.requeueForResume('run_1')
    expect((await loadRun())?.status).toBe('queued')
  })

  it('clears the stale result so the resumed run is not judged by the old error', async () => {
    await seedRun()
    await taskQueueDb.requeueForResume('run_1')
    expect((await loadRun())?.result).toBeNull()
  })

  it('drops the dead owner so the orphaned-run reaper cannot settle it', async () => {
    await seedRun()
    await taskQueueDb.requeueForResume('run_1')
    expect((await loadRun())?.ownerInstanceId).toBeNull()
  })

  it('keeps the session id the resume depends on', async () => {
    await seedRun()
    await taskQueueDb.requeueForResume('run_1')
    expect((await loadRun())?.executionMetadata).toMatchObject({ liveChatId: 'sess_live' })
  })

  it('only acts on a running row, so it cannot revive a settled run', async () => {
    // Guards against a late recovery pass requeueing a run another replica has
    // already completed or failed.
    await seedRun({ status: 'completed' })
    await taskQueueDb.requeueForResume('run_1')
    expect((await loadRun())?.status).toBe('completed')
  })
})
