/**
 * Integration test for the dead-instance reaper's Run claim, against a real
 * in-memory SQLite so the actual CAS predicate is exercised.
 *
 * The unit tests inject a fake `claimRun`, which leaves the half that touches
 * the database unverified — and this predicate has two jobs that pull in
 * opposite directions: fence the write on the owner the liveness verdict was
 * made against, while still settling a pending/queued row that carries no
 * owner at all.
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
  return { db: drizzle(sqlite, { schema }), sqlite, isPostgres: false }
})

// The mutation lock is a no-op here: this test exercises the SQL, and the real
// lock needs SCM path state the fixture deliberately does not build.
vi.mock('../scm-path-plan.js', () => ({
  withScmPathMutation: async (fn: (tx: unknown) => Promise<unknown>) => {
    const { db } = await import('../../db/client.js')
    return fn(db)
  },
}))
vi.mock('../audit.js', () => ({ writeBackgroundAudit: vi.fn() }))
vi.mock('../../a2a/sqlite-task-store.js', () => ({ SqliteTaskStore: class {} }))

const { db } = await import('../../db/client.js')
const { runs, runSteps } = await import('../../db/schema.js')
const { claimRunForReap } = await import('../scm-lease-sweeper.js')

const NOW = new Date('2026-08-20T10:00:00Z')

async function seedRun(overrides: Record<string, unknown> = {}) {
  await db.insert(runs).values({
    id: 'run_1',
    intent: 'review',
    status: 'running',
    ownerInstanceId: 'instance-b',
    initiatorAgentId: 'agt_1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never)
}

describe('claimRunForReap', () => {
  beforeEach(async () => {
    await db.delete(runSteps)
    await db.delete(runs)
  })

  it('fails the run and its running steps when the expected owner still holds it', async () => {
    await seedRun()
    await db.insert(runSteps).values({
      id: 'rst_1',
      runId: 'run_1',
      agentId: 'agt_1',
      order: 1,
      status: 'running',
      createdAt: NOW,
    } as never)

    expect(await claimRunForReap('run_1', 'instance-b')).toBe(true)

    const [run] = await db.select().from(runs)
    expect(run?.status).toBe('failed')
    expect((run?.result as { error?: { code?: string } })?.error?.code).toBe(
      'INSTANCE_STOPPED_DURING_EXEC',
    )
    expect((await db.select().from(runSteps))[0]?.status).toBe('failed')
  })

  it('loses the CAS when another replica re-promoted the run under its own id', async () => {
    // ABA: the lease named 'instance-b' and the heartbeat proved it dead, but
    // replica C requeued and re-promoted the run in the meantime. Its process
    // is alive; failing that run is exactly what the owner fence prevents.
    await seedRun({ ownerInstanceId: 'instance-c' })

    expect(await claimRunForReap('run_1', 'instance-b')).toBe(false)
    expect((await db.select().from(runs))[0]?.status).toBe('running')
  })

  it('still settles a queued or pending run, which carries no owner at all', async () => {
    // Ownership is stamped only while a run is running, so a lease of a dead
    // instance whose run sits pending or queued has a NULL owner column. An
    // equality-only fence would strand exactly the rows this pass exists for.
    await seedRun({ id: 'run_q', status: 'queued', ownerInstanceId: null })
    await seedRun({ id: 'run_p', status: 'pending', ownerInstanceId: null })

    expect(await claimRunForReap('run_q', 'instance-b')).toBe(true)
    expect(await claimRunForReap('run_p', 'instance-b')).toBe(true)

    const settled = await db.select().from(runs)
    expect(settled.map((run) => run.status)).toEqual(['failed', 'failed'])
  })

  it('loses the CAS when the run already reached a terminal state', async () => {
    await seedRun({ status: 'completed' })

    expect(await claimRunForReap('run_1', 'instance-b')).toBe(false)
    expect((await db.select().from(runs))[0]?.status).toBe('completed')
  })
})
