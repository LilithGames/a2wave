/**
 * Integration tests for the reaper's two real database functions, run against
 * a real in-memory SQLite so the actual predicates and CAS are exercised.
 *
 * The unit tests inject fakes for `listCandidates` / `claimRun`, which leaves
 * the halves that touch the database unverified — and that is precisely where
 * a wrong predicate silently does nothing (a candidate query that returns no
 * rows reaps nothing and looks exactly like a healthy system).
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
    CREATE TABLE run_steps (
      id text PRIMARY KEY NOT NULL,
      run_id text NOT NULL,
      agent_id text,
      "order" integer NOT NULL,
      input text,
      output text,
      status text NOT NULL DEFAULT 'pending',
      duration_ms integer,
      created_at integer NOT NULL
    );
  `)
  const schema = await import('../../db/schema.js')
  return { db: drizzle(sqlite, { schema }), sqlite, isPostgres: false }
})

// The mutation lock is a no-op here: these tests exercise the SQL, and the
// real lock needs SCM path state this fixture deliberately does not build.
vi.mock('../scm-path-plan.js', () => ({
  withScmPathMutation: async (fn: (tx: unknown) => Promise<unknown>) => {
    const { db } = await import('../../db/client.js')
    return fn(db)
  },
}))
vi.mock('../scm-lease-sweeper.js', () => ({ syncReapedRunExternalState: vi.fn() }))

const { db } = await import('../../db/client.js')
const { runs, runSteps } = await import('../../db/schema.js')
const { claimRunForReap, listOrphanedRunCandidates } = await import('../orphaned-run-reaper.js')

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

describe('listOrphanedRunCandidates', () => {
  beforeEach(async () => {
    await db.delete(runSteps)
    await db.delete(runs)
  })

  it('returns a stamped running run that has no step row yet', async () => {
    // The regression this guards: run_steps is written well after the run
    // reaches 'running', so a crash in that window leaves zero steps. An inner
    // join would hide it forever — the likeliest crash window of all.
    await seedRun()

    const candidates = await listOrphanedRunCandidates()

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ id: 'run_1', agentId: 'agt_1' })
  })

  it('returns one candidate for a run with several steps', async () => {
    await seedRun()
    for (const order of [1, 2, 3]) {
      await db.insert(runSteps).values({
        id: `rst_${order}`,
        runId: 'run_1',
        agentId: 'agt_1',
        order,
        status: 'running',
        createdAt: NOW,
      } as never)
    }

    expect(await listOrphanedRunCandidates()).toHaveLength(1)
  })

  it('excludes runs with no owner stamped', async () => {
    await seedRun({ ownerInstanceId: null })

    expect(await listOrphanedRunCandidates()).toEqual([])
  })

  it('excludes queued and pending runs even when an owner is stamped', async () => {
    // A stale owner on a non-running row is a leftover from an earlier turn of
    // a reused conversation row; reaping it would drop a live instance's work.
    await seedRun({ id: 'run_q', status: 'queued' })
    await seedRun({ id: 'run_p', status: 'pending' })

    expect(await listOrphanedRunCandidates()).toEqual([])
  })

  it('excludes terminal runs', async () => {
    await seedRun({ id: 'run_done', status: 'completed' })
    await seedRun({ id: 'run_failed', status: 'failed' })

    expect(await listOrphanedRunCandidates()).toEqual([])
  })

  it('skips a run with no initiating Agent', async () => {
    // Nothing to requeue after settling; startup recovery archives these.
    await seedRun({ initiatorAgentId: null })

    expect(await listOrphanedRunCandidates()).toEqual([])
  })
})

describe('claimRunForReap', () => {
  beforeEach(async () => {
    await db.delete(runSteps)
    await db.delete(runs)
  })

  it('fails the run and its running steps, recording the structured reason', async () => {
    await seedRun()
    await db.insert(runSteps).values({
      id: 'rst_1',
      runId: 'run_1',
      agentId: 'agt_1',
      order: 1,
      status: 'running',
      createdAt: NOW,
    } as never)

    expect(await claimRunForReap('run_1')).toBe(true)

    const [run] = await db.select().from(runs)
    expect(run?.status).toBe('failed')
    expect((run?.result as { error?: { code?: string } })?.error?.code).toBe(
      'INSTANCE_STOPPED_DURING_EXEC',
    )
    const [step] = await db.select().from(runSteps)
    expect(step?.status).toBe('failed')
  })

  it('loses the CAS when the run already reached a terminal state', async () => {
    // Completion can win between the liveness read and this write.
    await seedRun({ status: 'completed' })

    expect(await claimRunForReap('run_1')).toBe(false)
    const [run] = await db.select().from(runs)
    expect(run?.status).toBe('completed')
  })

  it('leaves steps of other runs untouched', async () => {
    await seedRun()
    await db.insert(runSteps).values({
      id: 'rst_other',
      runId: 'run_other',
      agentId: 'agt_1',
      order: 1,
      status: 'running',
      createdAt: NOW,
    } as never)

    expect(await claimRunForReap('run_1')).toBe(true)

    const [step] = await db.select().from(runSteps)
    expect(step?.status).toBe('running')
  })
})
