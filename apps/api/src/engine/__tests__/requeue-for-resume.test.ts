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

vi.mock('../execution-lease-registry.js', () => ({ listActiveExecutionLeases: () => [] }))
vi.mock('../../lib/scm-workload-lifecycle.js', () => ({
  withScmWorkloadAdmission: vi.fn(),
  activateScmWorkload: vi.fn(),
  activateScmWorkloadInMutation: vi.fn(),
  releaseReservedScmWorkload: vi.fn(),
}))
vi.mock('../../lib/scm-path-plan.js', () => ({ withScmPathMutation: vi.fn() }))

const { db } = await import('../../db/client.js')
const { runs, runSteps } = await import('../../db/schema.js')
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
    await db.delete(runSteps)
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

  it('stamps queuedAt so the resumed turn wait counts from the requeue', async () => {
    // The requeue IS this turn's queue entry: the interrupted attempt's own
    // wait was already consumed into its step, so measuring from the requeue
    // is what keeps the resumed step's wait_ms honest.
    await seedRun()
    await taskQueueDb.requeueForResume('run_1')
    expect((await loadRun())?.queuedAt).toBeInstanceOf(Date)
  })

  it('settles the step the killed process left running', async () => {
    // The resumed execution appends a new step; leaving this one 'running'
    // would strand it forever and read as permanently in-flight in the UI.
    await seedRun()
    await db.insert(runSteps).values({
      id: 'stp_1',
      runId: 'run_1',
      order: 1,
      status: 'running',
      createdAt: NOW,
    } as never)

    await taskQueueDb.requeueForResume('run_1')

    expect((await db.select().from(runSteps))[0]?.status).toBe('failed')
  })

  it('leaves steps alone when the run was already settled by someone else', async () => {
    await seedRun({ status: 'completed' })
    await db.insert(runSteps).values({
      id: 'stp_1',
      runId: 'run_1',
      order: 1,
      status: 'running',
      createdAt: NOW,
    } as never)

    await taskQueueDb.requeueForResume('run_1')

    expect((await db.select().from(runSteps))[0]?.status).toBe('running')
  })

  it('only acts on a running row, so it cannot revive a settled run', async () => {
    // Guards against a late recovery pass requeueing a run another replica has
    // already completed or failed.
    await seedRun({ status: 'completed' })
    await taskQueueDb.requeueForResume('run_1')
    expect((await loadRun())?.status).toBe('completed')
  })
})

describe('taskQueueDb.requeueForResume — owner fence', () => {
  beforeEach(async () => {
    await db.delete(runSteps)
    await db.delete(runs)
  })

  it('refuses to requeue a run another replica re-promoted under its own id', async () => {
    // ABA: the reaper judged 'dead-instance' dead, but between its scan and
    // this write replica C requeued and re-promoted the run, stamping itself.
    // A status-only CAS would requeue C's live run out from under it.
    await seedRun({ ownerInstanceId: 'instance-c' })

    expect(
      await taskQueueDb.requeueForResume('run_1', 'INSTANCE_STOPPED_DURING_EXEC', 'dead-instance'),
    ).toBe(false)
    const run = await loadRun()
    expect(run?.status).toBe('running')
    expect(run?.ownerInstanceId).toBe('instance-c')
  })

  it('requeues when the expected owner still matches', async () => {
    await seedRun()

    expect(
      await taskQueueDb.requeueForResume('run_1', 'INSTANCE_STOPPED_DURING_EXEC', 'dead-instance'),
    ).toBe(true)
    expect((await loadRun())?.status).toBe('queued')
  })

  it('requeues regardless of owner when no expected owner is given', async () => {
    // Startup recovery is the single-owner case: this process IS the previous
    // owner, and there is no peer whose claim could be fenced against.
    await seedRun({ ownerInstanceId: 'anything' })

    expect(await taskQueueDb.requeueForResume('run_1')).toBe(true)
    expect((await loadRun())?.status).toBe('queued')
  })
})

describe('taskQueueDb.requeueForResume — the resume mark is part of the transition', () => {
  beforeEach(async () => {
    await db.delete(runSteps)
    await db.delete(runs)
  })

  it('stamps resumePending itself, leaving no window for a straggler to erase it', async () => {
    // Production showed the mark missing by the time execution read the row:
    // the reaper wrote it in a separate transaction, and the dying CLI's
    // fire-and-forget session tap merged its own snapshot over the top in the
    // gap. Writing it inside the same UPDATE removes the gap entirely.
    await seedRun()
    await taskQueueDb.requeueForResume('run_1', 'INSTANCE_STOPPED_DURING_EXEC')
    expect((await loadRun())?.executionMetadata).toMatchObject({
      liveChatId: 'sess_live',
      resumePending: 'INSTANCE_STOPPED_DURING_EXEC',
    })
  })

  it('leaves metadata alone when no interruption code is supplied', async () => {
    await seedRun()
    await taskQueueDb.requeueForResume('run_1')
    expect((await loadRun())?.executionMetadata).toEqual({ liveChatId: 'sess_live' })
  })
})
