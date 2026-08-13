/**
 * Route tests for evaluation tasks: creation, listing, review and cancel.
 *
 * The runner is mocked so tasks resolve synchronously and deterministically —
 * these tests cover the HTTP/persistence contract, not engine behaviour.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const Database = (await import('better-sqlite3')).default
  const sqlite = new Database(':memory:')

  const { getTableConfig } = await import('drizzle-orm/sqlite-core')
  // Import the SQLite tables directly, not the dialect-dispatching `schema.js`:
  // this factory emits SQLite DDL for the in-memory database below, so under a
  // PostgreSQL DATABASE_URL the dispatched schema would hand pg tables to
  // `getTableConfig` from sqlite-core and throw during module mocking.
  const {
    agents: agentsTable,
    runs: runsTable,
    scmSources: scmSourcesTable,
    scmWorkloadLeases: scmWorkloadLeasesTable,
  } = await import('../../db/schema.sqlite.js')
  const columnsOf = (table: Parameters<typeof getTableConfig>[0]) =>
    getTableConfig(table)
      .columns.map(
        (col) => `\`${col.name}\` ${col.getSQLType()}${col.primary ? ' PRIMARY KEY NOT NULL' : ''}`,
      )
      .join(', ')
  sqlite.exec(`CREATE TABLE agents (${columnsOf(agentsTable)});`)
  // Present so a test can assert evaluation never writes to it: the runs table
  // drives run-queue concurrency and restart recovery, and evaluation keeps its
  // own queue precisely so the two cannot starve each other.
  sqlite.exec(`CREATE TABLE runs (${columnsOf(runsTable)});`)
  // Decides whether an SCM Agent's evaluation gets a worktree: only git
  // implements one, so the source row's type drives workspace isolation.
  sqlite.exec(`CREATE TABLE scm_sources (${columnsOf(scmSourcesTable)});`)
  sqlite.exec(`CREATE TABLE scm_workload_leases (${columnsOf(scmWorkloadLeasesTable)});`)
  sqlite.exec(`
    -- email/display_name feed the RunChannelContext a gateway-enabled Agent
    -- needs to sign its per-run token.
    CREATE TABLE users (
      id text PRIMARY KEY NOT NULL,
      username text,
      display_name text,
      email text
    );
    -- Empty on purpose: the evaluation queue reads its concurrency from here and
    -- must fall back to SETTINGS_DEFAULTS when nothing has been configured.
    CREATE TABLE settings (
      category text NOT NULL,
      key text NOT NULL,
      value text NOT NULL,
      updated_at integer,
      PRIMARY KEY (category, key)
    );
    CREATE TABLE agent_members (
      agent_id text NOT NULL,
      user_id text NOT NULL,
      role text DEFAULT 'viewer' NOT NULL,
      created_by text,
      created_at integer,
      updated_at integer,
      PRIMARY KEY (agent_id, user_id)
    );
  `)
  // The evaluation tables arrive in 0078 and are altered by later migrations.
  // Replaying every migration from that point forward — rather than pinning one
  // filename — keeps this fixture from drifting the next time a column is added.
  const evaluationMigrations = ['0078_magenta_rhodey.sql', '0079_harsh_amphibian.sql']
  for (const file of evaluationMigrations) {
    const migration = readFileSync(join(process.cwd(), 'drizzle', file), 'utf-8').replace(
      /-->\s*statement-breakpoint/g,
      '',
    )
    sqlite.exec(migration)
  }

  // `isPostgres` / `sqliteDatabase` are read by db/transaction.ts, which the
  // route pulls in transitively. Omitting them makes the whole suite fail to
  // import rather than fail an assertion.
  return { db: drizzle(sqlite), isPostgres: false, sqliteDatabase: sqlite }
})

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn(), logBackgroundAudit: vi.fn() }))

// Only the capture is stubbed; applyEvaluationSnapshot stays real, since these
// tests assert that the frozen snapshot is what actually drives execution.
vi.mock('../../lib/evaluation-snapshot.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/evaluation-snapshot.js')
  return {
    ...actual,
    // The route persists the stored shape, whose capturedAt is an ISO string —
    // the JSON column round-trips a Date to one anyway.
    buildStoredEvaluationSnapshot: vi.fn(async () => ({
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      systemPrompt: 'You are helpful.',
      capturedAt: '2026-07-20T00:00:00.000Z',
    })),
  }
})

/** The subset of replayCase's params these tests assert on. */
type ReplayCall = {
  workDir: string
  agentConfig: { systemPrompt?: string; model?: string }
  isCancelled?: () => boolean | Promise<boolean>
}

/** Default replay behaviour, re-applied after each `mockReset` in beforeEach. */
const replayCaseDefault = async (_params: ReplayCall) => ({
  status: 'completed' as const,
  actualTurns: [{ request: 'hi', expectedResponse: 'hello', actualResponse: 'Hello!' }],
  error: null,
  durationMs: 5,
})

const replayCaseMock = vi.fn(replayCaseDefault)

vi.mock('../../lib/evaluation-runner.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/evaluation-runner.js')
  return {
    ...actual,
    replayCase: (...args: unknown[]) => replayCaseMock(...(args as [ReplayCall])),
  }
})

vi.mock('../../lib/agent-helpers.js', () => ({
  buildAgentConfig: vi.fn(() => ({
    engineType: 'claude-code',
    model: 'm',
    systemPrompt: 'live prompt',
    providerId: 'prv_1',
  })),
  // Evaluation must run in the same workspace a normal run would get, so the
  // engine's skills/MCP/KB sync is not silently short-circuited by an empty one.
  // Mirrors the real signature: worktree params yield a worktree path.
  resolveWorkDir: vi.fn(async (_agent: unknown, worktree?: { name: string }) =>
    worktree ? `/tmp/worktrees/${worktree.name}` : '/tmp/eval-workspace',
  ),
  resolveProviderBinding: vi.fn(() => null),
  applyProviderBinding: vi.fn(),
}))

const removeWorkspaceMock = vi.fn(async () => {})
const removeOwnedSourceWorkspaceGuardedMock = vi.fn(async () => {})

vi.mock('../../lib/scm-source.js', () => ({
  createScmSource: vi.fn(() => ({
    type: 'git',
    removeWorkspace: (...args: unknown[]) => removeWorkspaceMock(...(args as [])),
  })),
}))

vi.mock('../../lib/scm-workspace-removal.js', () => ({
  removeOwnedSourceWorkspaceGuarded: (...args: unknown[]) =>
    removeOwnedSourceWorkspaceGuardedMock(...(args as [])),
}))

import { db } from '../../db/client.js'
import {
  evaluationResults,
  evaluationSets,
  evaluationTasks,
  runs,
  scmWorkloadLeases,
} from '../../db/schema.js'
import { EVALUATION_MAX_QUEUE_LENGTH } from '../../engine/evaluation-queue.js'
import { resolveWorkDir } from '../../lib/agent-helpers.js'
import { logAudit, logBackgroundAudit } from '../../lib/audit.js'
import { AppError } from '../../lib/errors.js'
import { buildStoredEvaluationSnapshot } from '../../lib/evaluation-snapshot.js'
import evaluationRoutes from '../evaluation.js'

const OWNER = 'usr_owner'
const OTHER = 'usr_other'
const AGENT_ID = 'agt_1'
const OTHER_AGENT_ID = 'agt_2'

function appAs(userId: string, role: 'admin' | 'user' = 'user') {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, userId as never)
    c.set('userRole' as never, role as never)
    await next()
  })
  app.route('/api/agents', evaluationRoutes)
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    throw err
  })
  return app
}

/** Creates a set with `caseCount` cases and returns its id. */
async function seedSet(app: Hono, agentId: string, caseCount: number) {
  const created = (await (
    await app.request(`/api/agents/${agentId}/evaluation-sets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'set' }),
    })
  ).json()) as { data: { id: string } }
  const setId = created.data.id

  for (let i = 0; i < caseCount; i++) {
    await app.request(`/api/agents/${agentId}/evaluation-sets/${setId}/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `case-${i}`,
        sortOrder: i,
        turns: [{ request: 'hi', expectedResponse: 'hello' }],
      }),
    })
  }
  return setId
}

/**
 * Waits for the fire-and-forget runner to reach a given state.
 *
 * Bounded by WALL TIME, not by a tick count. The previous version spun 100
 * `setImmediate` ticks, which the doc comment itself argued against — and
 * `setImmediate` does not advance real time, so on a loaded runner the whole
 * budget could be spent while a genuinely pending promise (a real timer, an I/O
 * callback) had not resolved yet. That made this file flaky as a unit: three
 * different assertions failed across three consecutive CI runs, none
 * reproducible locally.
 *
 * Yielding with `setTimeout(0)` lets the macrotask queue drain between polls,
 * so a slow machine simply takes more iterations instead of failing.
 *
 * The budget is deliberately BELOW vitest's 5000ms default (this file sets no
 * `testTimeout`). At 5000 the two raced and vitest always won, so the label —
 * whose entire purpose is to say WHICH condition hung — could never print.
 * The real margin is smaller still: the test clock starts before `waitFor` is
 * reached, since `seedSet` and `createTask` post first.
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for: ${label}`)
}

/**
 * The audit entry for one task.
 *
 * Never read `mock.calls[0]`: tasks are fire-and-forget, so an earlier test's
 * run can still be in flight and land its entry first. Matching on resourceId
 * makes each assertion independent of what else is running.
 */
function auditFor(taskId: string) {
  return vi
    .mocked(logBackgroundAudit)
    .mock.calls.map((c) => c[0])
    .find((entry) => entry.resourceId === taskId)
}

function createTask(app: Hono, agentId: string, body: unknown) {
  return app.request(`/api/agents/${agentId}/evaluation-tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  // `mockReset`, not `mockClear`: clear wipes calls but NOT the one-shot queue,
  // so a `...Once` queued by a test that never consumed it (four sites queue
  // one — two rejections, two blocking implementations) fires in whichever test
  // runs next. That is the same leak class as the audit-entry bug fixed above,
  // and it is what made `stops a cancelled loop between cases` see two replay
  // calls instead of one. Reset drops the queue, so the default is re-applied.
  replayCaseMock.mockReset()
  replayCaseMock.mockImplementation(replayCaseDefault)
  removeWorkspaceMock.mockClear()
  removeOwnedSourceWorkspaceGuardedMock.mockClear()
  // Cleared so `auditFor()` only ever sees entries from the current test. The
  // assertions match by resourceId rather than position (see auditFor), because
  // clearing alone is not enough: tasks are fire-and-forget, so an earlier
  // test's runner can land its entry AFTER this clear. Reading `calls[0]` was
  // the actual cause of this file's CI flakiness — three different assertions
  // failed across three consecutive runs, reproducible with --sequence.shuffle.
  vi.mocked(logBackgroundAudit).mockClear()
  // A `...Once` queued by a workspace test would otherwise fire in whichever
  // test runs next, failing it for a reason that has nothing to do with it.
  vi.mocked(resolveWorkDir).mockReset()
  vi.mocked(resolveWorkDir).mockImplementation(
    async (_agent: unknown, worktree?: { name: string }) =>
      worktree ? `/tmp/worktrees/${worktree.name}` : '/tmp/eval-workspace',
  )
  db.delete(evaluationResults).run()
  db.delete(evaluationTasks).run()
  db.delete(evaluationSets).run()
  db.run(sql`DELETE FROM scm_sources`)
  db.run(sql`DELETE FROM agent_members`)
  db.run(sql`DELETE FROM agents`)
  db.run(sql`DELETE FROM users`)
  db.run(sql`DELETE FROM settings`)
  db.run(sql`INSERT INTO users (id, username) VALUES (${OWNER}, 'owner')`)
  db.run(sql`INSERT INTO users (id, username) VALUES (${OTHER}, 'other')`)
  db.run(sql`INSERT INTO agents (id, user_id, name) VALUES (${AGENT_ID}, ${OWNER}, 'A')`)
  db.run(sql`INSERT INTO agents (id, user_id, name) VALUES (${OTHER_AGENT_ID}, ${OTHER}, 'B')`)
})

describe('POST /:agentId/evaluation-tasks', () => {
  it('creates a task with a config snapshot and one result row per case', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 3)

    const res = await createTask(app, AGENT_ID, { setId, name: 'baseline' })
    expect(res.status).toBe(201)

    const body = (await res.json()) as {
      data: { id: string; configSnapshot: Record<string, unknown>; setName: string }
    }
    expect(body.data.id).toMatch(/^evt_/)
    expect(body.data.configSnapshot.model).toBe('claude-opus-4-8')
    expect(body.data.setName).toBe('set')

    const results = db.select().from(evaluationResults).all()
    expect(results).toHaveLength(3)
  })

  it('rolls back the task when any result snapshot cannot be persisted', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 2)
    db.run(sql`
      CREATE TRIGGER fail_evaluation_result_snapshot
      BEFORE INSERT ON evaluation_results
      BEGIN
        SELECT RAISE(ABORT, 'result snapshot failure');
      END
    `)

    try {
      await expect(createTask(app, AGENT_ID, { setId })).rejects.toThrow('result snapshot failure')
    } finally {
      db.run(sql`DROP TRIGGER fail_evaluation_result_snapshot`)
    }

    expect(db.select().from(evaluationTasks).all()).toHaveLength(0)
    expect(db.select().from(evaluationResults).all()).toHaveLength(0)
  })

  it('rolls back the SCM lease when the Agent binding changes before admission', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    db.run(
      sql`INSERT INTO scm_sources (id, name, type, config, local_path)
          VALUES ('scm_late', 'late repo', 'git', '{}', '/tmp/late-checkout')`,
    )
    vi.mocked(buildStoredEvaluationSnapshot).mockImplementationOnce(async () => {
      db.run(
        sql`UPDATE agents SET workspace_type = 'scm', scm_source_id = 'scm_late'
            WHERE id = ${AGENT_ID}`,
      )
      return {
        providerId: 'prv_1',
        providerName: 'Claude Code',
        model: 'claude-opus-4-8',
        systemPrompt: 'You are helpful.',
        capturedAt: '2026-07-20T00:00:00.000Z',
      }
    })

    const response = await createTask(app, AGENT_ID, { setId })

    expect(response.status).toBe(409)
    expect(db.select().from(evaluationTasks).all()).toHaveLength(0)
    expect(db.select().from(scmWorkloadLeases).all()).toHaveLength(0)
  })

  /**
   * Regression: `buildEvaluationSnapshot` is async, and the insert used to pass
   * the unawaited Promise through an `as never` cast. A Promise JSON-serialises
   * to `{}`, so every task persisted an empty snapshot — the frozen
   * provider/model/prompt this feature is built on was silently never stored,
   * and the execution audit reported null provider and model.
   */
  it('persists the frozen provider, model and prompt rather than an empty object', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    await createTask(app, AGENT_ID, { setId })

    const stored = db.select().from(evaluationTasks).all()[0].configSnapshot
    expect(stored).toEqual({
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      systemPrompt: 'You are helpful.',
      capturedAt: '2026-07-20T00:00:00.000Z',
    })
  })

  it('never stores provider credentials in the snapshot', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    await createTask(app, AGENT_ID, { setId })

    const task = db.select().from(evaluationTasks).all()[0]
    const serialized = JSON.stringify(task.configSnapshot)
    expect(serialized).not.toMatch(/apiKey|oauthToken|providerBaseUrl/i)
  })

  it('rejects a set with no cases', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 0)

    const res = await createTask(app, AGENT_ID, { setId })
    expect(res.status).toBe(400)
    // An error code, not a sentence: the web client maps it through i18n, so a
    // human-readable English string here would reach a Chinese UI untranslated.
    expect((await res.json()).error).toBe('EVALUATION_SET_EMPTY')
  })

  it('rejects a set belonging to another agent', async () => {
    const otherApp = appAs(OTHER)
    const foreignSetId = await seedSet(otherApp, OTHER_AGENT_ID, 1)

    const res = await createTask(appAs(OWNER), AGENT_ID, { setId: foreignSetId })
    expect(res.status).toBe(404)
  })

  it('rejects a viewer', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    db.run(
      sql`INSERT INTO agent_members (agent_id, user_id, role) VALUES (${AGENT_ID}, ${OTHER}, 'viewer')`,
    )

    const res = await createTask(appAs(OTHER), AGENT_ID, { setId })
    expect(res.status).toBe(403)
  })

  it('requires a setId', async () => {
    const res = await createTask(appAs(OWNER), AGENT_ID, {})
    expect(res.status).toBe(400)
  })

  it('queues a submission once the agent is at its evaluation concurrency limit', async () => {
    db.run(
      sql`INSERT INTO settings (category, key, value) VALUES ('evaluation', 'maxConcurrency', '1')`,
    )
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)

    // Occupy the single slot with a task the mocked runner leaves in flight.
    db.run(
      sql`INSERT INTO evaluation_tasks (id, agent_id, set_id, set_name, status, config_snapshot, created_at, updated_at)
          VALUES ('evt_busy', ${AGENT_ID}, ${setId}, 'set', 'running', '{}', 1, 1)`,
    )

    const res = await createTask(app, AGENT_ID, { setId })
    expect(res.status).toBe(201)
    expect((await res.json()).data.status).toBe('queued')
  })

  it('leaves no audit entry behind when the queue rejects the submission', async () => {
    db.run(
      sql`INSERT INTO settings (category, key, value) VALUES ('evaluation', 'maxConcurrency', '1')`,
    )
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    db.run(
      sql`INSERT INTO evaluation_tasks (id, agent_id, set_id, set_name, status, config_snapshot, created_at, updated_at)
          VALUES ('evt_busy', ${AGENT_ID}, ${setId}, 'set', 'running', '{}', 1, 1)`,
    )
    for (let i = 0; i < EVALUATION_MAX_QUEUE_LENGTH; i++) {
      db.run(
        sql`INSERT INTO evaluation_tasks (id, agent_id, set_id, set_name, status, config_snapshot, created_at, updated_at)
            VALUES (${`evt_q${i}`}, ${AGENT_ID}, ${setId}, 'set', 'queued', '{}', 1, 1)`,
      )
    }
    vi.mocked(logAudit).mockClear()

    const res = await createTask(app, AGENT_ID, { setId })
    expect(res.status).toBe(429)
    expect((await res.json()).error).toBe('EVALUATION_QUEUE_FULL')

    // The row was rolled back, so an audit entry naming it would point an
    // auditor at a task id that was never persisted.
    expect(vi.mocked(logAudit)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'evaluation_task.create' }),
    )
  })

  it('runs immediately when another agent is the busy one', async () => {
    db.run(
      sql`INSERT INTO settings (category, key, value) VALUES ('evaluation', 'maxConcurrency', '1')`,
    )
    db.run(
      sql`INSERT INTO evaluation_tasks (id, agent_id, set_id, set_name, status, config_snapshot, created_at, updated_at)
          VALUES ('evt_busy', ${OTHER_AGENT_ID}, NULL, 'set', 'running', '{}', 1, 1)`,
    )

    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)

    const res = await createTask(app, AGENT_ID, { setId })
    expect(res.status).toBe(201)
    expect((await res.json()).data.status).not.toBe('queued')
  })
})

describe('POST /:agentId/evaluation-tasks/:taskId/cancel', () => {
  it('settles a queued task immediately, since no loop is running to notice', async () => {
    db.run(
      sql`INSERT INTO settings (category, key, value) VALUES ('evaluation', 'maxConcurrency', '1')`,
    )
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    db.run(
      sql`INSERT INTO evaluation_tasks (id, agent_id, set_id, set_name, status, config_snapshot, created_at, updated_at)
          VALUES ('evt_busy', ${AGENT_ID}, ${setId}, 'set', 'running', '{}', 1, 1)`,
    )
    const queued = (await (await createTask(app, AGENT_ID, { setId })).json()).data as {
      id: string
      status: string
    }
    expect(queued.status).toBe('queued')

    const res = await app.request(`/api/agents/${AGENT_ID}/evaluation-tasks/${queued.id}/cancel`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    const row = db
      .select()
      .from(evaluationTasks)
      .all()
      .find((t) => t.id === queued.id)
    expect(row?.status).toBe('cancelled')
    // Persisted rather than held in memory, so a restart cannot lose the intent.
    expect(row?.cancelRequestedAt).toBeTruthy()
  })

  it('rejects cancelling an already finished task', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    await waitFor(
      () =>
        db
          .select()
          .from(evaluationTasks)
          .all()
          .find((t) => t.id === task.id)?.status === 'completed',
      'the task to complete',
    )

    const res = await app.request(`/api/agents/${AGENT_ID}/evaluation-tasks/${task.id}/cancel`, {
      method: 'POST',
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('EVALUATION_TASK_NOT_RUNNING')
  })

  it('settles the result rows of a cancelled queued task', async () => {
    db.run(
      sql`INSERT INTO settings (category, key, value) VALUES ('evaluation', 'maxConcurrency', '1')`,
    )
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 3)
    db.run(
      sql`INSERT INTO evaluation_tasks (id, agent_id, set_id, set_name, status, config_snapshot, created_at, updated_at)
          VALUES ('evt_busy', ${AGENT_ID}, ${setId}, 'set', 'running', '{}', 1, 1)`,
    )
    const queued = (await (await createTask(app, AGENT_ID, { setId })).json()).data as {
      id: string
    }

    await app.request(`/api/agents/${AGENT_ID}/evaluation-tasks/${queued.id}/cancel`, {
      method: 'POST',
    })

    // A row left at `pending` has no loop behind it any more, so the detail page
    // would render it as still waiting under a task badged Cancelled.
    const rows = db
      .select()
      .from(evaluationResults)
      .all()
      .filter((r) => r.taskId === queued.id)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true)
  })
})

describe('execution honours the frozen snapshot and a real workspace', () => {
  it('drives the run from the snapshot, not the live config edited since', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    await waitFor(() => replayCaseMock.mock.calls.length > 0, 'the first case to start')

    // The snapshot mock froze 'You are helpful.' at creation; buildAgentConfig
    // reports a different live prompt. A task promises to have run the former,
    // and creation can precede execution by minutes of queueing.
    expect(replayCaseMock.mock.calls[0]?.[0].agentConfig.systemPrompt).toBe('You are helpful.')

    const row = db
      .select()
      .from(evaluationTasks)
      .all()
      .find((t) => t.id === task.id)
    expect(row?.configSnapshot.systemPrompt).toBe('You are helpful.')
  })

  /**
   * The runner asks this predicate before turn 0 of every case. It resolves
   * cancellation from the DB, so it is async — and the runner has to await it.
   * Asserting the resolved value here pins the half of that contract the route
   * owns: a live, uncancelled task must answer `false`, otherwise every case
   * aborts with "Evaluation cancelled" before invoking the Agent once.
   */
  it('hands the runner a cancellation predicate that resolves false for a live task', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    await createTask(app, AGENT_ID, { setId })
    await waitFor(() => replayCaseMock.mock.calls.length > 0, 'the first case to start')

    const isCancelled = replayCaseMock.mock.calls[0]?.[0].isCancelled
    expect(isCancelled).toBeTypeOf('function')
    await expect(isCancelled?.()).resolves.toBe(false)
  })

  /** Points the agent at a git code source, the way an SCM Agent is configured. */
  function linkGitScmSource(sourceId = 'scm_git_1'): void {
    db.run(
      sql`INSERT INTO scm_sources (id, name, type, config, local_path)
          VALUES (${sourceId}, 'repo', 'git', '{}', ${`/tmp/checkout-${sourceId}`})`,
    )
    db.run(
      sql`UPDATE agents SET workspace_type = 'scm', scm_source_id = ${sourceId}
          WHERE id = ${AGENT_ID}`,
    )
  }

  it('gives a git SCM agent its own worktree off the shared checkout', async () => {
    linkGitScmSource()
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    await waitFor(() => replayCaseMock.mock.calls.length > 0, 'the first case to start')

    // An SCM Agent exists to work on a checkout, so it needs real source rather
    // than an empty scratch dir — but running in the shared one lets a chat run
    // mutate the tree mid-evaluation. A worktree gives it both.
    // ephemeral: this worktree belongs to one replay and is removed after it.
    expect(vi.mocked(resolveWorkDir)).toHaveBeenCalledWith(expect.anything(), {
      name: `eval-${task.id}`,
      cleanup: 'ephemeral',
    })
    expect(replayCaseMock.mock.calls[0]?.[0].workDir).toBe(`/tmp/worktrees/eval-${task.id}`)
  })

  it('removes the worktree through the durable guarded-removal protocol', async () => {
    linkGitScmSource('scm_git_2')
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    await waitFor(
      () => removeOwnedSourceWorkspaceGuardedMock.mock.calls.length > 0,
      'the guarded worktree cleanup',
    )

    // `rm -rf` on a worktree leaves the parent repo holding a stale admin entry
    // that blocks the next checkout of that branch until `git worktree prune`.
    expect(removeOwnedSourceWorkspaceGuardedMock).toHaveBeenCalledWith({
      sourceId: 'scm_git_2',
      name: `eval-${task.id}`,
      scm: expect.anything(),
      workload: expect.objectContaining({ type: 'evaluation', workloadId: task.id }),
    })
    expect(removeWorkspaceMock).not.toHaveBeenCalled()
  })

  it('fails the task when its worktree cannot be created', async () => {
    linkGitScmSource('scm_git_3')
    vi.mocked(resolveWorkDir).mockRejectedValueOnce(new Error('disk full'))
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }

    // Silently falling back to the shared checkout would produce a result that
    // looks normal but was measured under conditions the user did not ask for.
    await waitFor(
      () =>
        db
          .select()
          .from(evaluationTasks)
          .all()
          .find((t) => t.id === task.id)?.status === 'failed',
      'the task to fail',
    )
    expect(replayCaseMock).not.toHaveBeenCalled()
  })

  it('gives each task its own workspace under the resolved base', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    await waitFor(() => replayCaseMock.mock.calls.length > 0, 'the first case to start')

    // An empty workDir makes base-engine skip skills/MCP/KB sync entirely, so
    // the Agent would be evaluated as a bare model. A shared one lets two
    // concurrent evaluations sync conflicting .mcp.json/skills into one cwd.
    expect(replayCaseMock.mock.calls[0]?.[0].workDir).toBe(
      `/tmp/eval-workspace/evaluations/${task.id}`,
    )
  })
})

describe('execution is audited without writing to the runs table', () => {
  it('records the billable work a task actually performed', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 2)
    vi.mocked(logBackgroundAudit).mockClear()

    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    // Select THIS task's entry rather than calls[0]. Tasks are fire-and-forget,
    // so an earlier test's run can still be in flight and land its audit after
    // the mockClear above — which made this read a different task's row and is
    // why the file failed on a different assertion each CI run.
    await waitFor(() => auditFor(task.id) !== undefined, 'the audit entry')

    // Evaluation writes no `runs` row on purpose, so this entry is the only
    // record that real Agent work was done (Iron Rule 5).
    const entry = auditFor(task.id)
    if (!entry) throw new Error('Expected the evaluation execution audit entry')
    expect(entry.action).toBe('evaluation_task.execute')
    expect(entry.resourceId).toBe(task.id)
    expect(entry.userId).toBe(OWNER)
    expect(entry.details).toMatchObject({
      agentId: AGENT_ID,
      status: 'completed',
      casesRun: 2,
      turnsReplayed: 2,
      model: 'claude-opus-4-8',
    })
    // `turnsReplayed` counts turns, not worker processes: executeWithRetry can
    // start several per turn, so this must not be read as a billing figure.
    expect(entry.details).not.toHaveProperty('agentInvocations')
  })

  it('still accounts for the spend when the run fails partway', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 3)
    replayCaseMock.mockRejectedValueOnce(new Error('engine exploded'))
    vi.mocked(logBackgroundAudit).mockClear()

    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    await waitFor(() => auditFor(task.id) !== undefined, 'the audit entry')

    // A task that burned calls before dying is exactly the one an auditor needs.
    const entry = auditFor(task.id)
    if (!entry) throw new Error('Expected the failed evaluation audit entry')
    expect(entry.details).toMatchObject({ status: 'failed' })
  })

  it('never records evaluation runs in the runs table', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    // Wait on THIS task's audit entry, like its two siblings. Waiting on "any
    // entry" lets a foreign one satisfy the predicate before this task's runner
    // has started, so a regression that writes the `runs` row late — after the
    // audit entry in the `finally` — would slip through.
    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    await waitFor(() => auditFor(task.id) !== undefined, 'the audit entry')

    // The runs table drives run-queue concurrency and restart recovery, so a
    // 50-case evaluation landing there would starve interactive chat.
    expect(db.select().from(runs).all()).toHaveLength(0)
  })
})

describe('terminal paths settle their result rows', () => {
  it('marks every unfinished case failed when the run blows up', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 3)
    replayCaseMock.mockRejectedValueOnce(new Error('engine exploded'))

    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    // The runner is fire-and-forget; let its rejection settle.
    await waitFor(
      () =>
        db
          .select()
          .from(evaluationTasks)
          .all()
          .find((t) => t.id === task.id)?.status === 'failed',
      'the task to fail',
    )

    const row = db
      .select()
      .from(evaluationTasks)
      .all()
      .find((t) => t.id === task.id)
    expect(row?.status).toBe('failed')

    // Nothing is left claiming to still be waiting under a Failed badge.
    const results = db
      .select()
      .from(evaluationResults)
      .all()
      .filter((r) => r.taskId === task.id)
    expect(results.some((r) => r.status === 'pending')).toBe(false)
    expect(results.every((r) => r.status === 'failed')).toBe(true)
  })
})

describe('GET /:agentId/evaluation-tasks', () => {
  it('lists newest first and excludes other agents tasks', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    await createTask(app, AGENT_ID, { setId, name: 'first' })
    await createTask(app, AGENT_ID, { setId, name: 'second' })

    const otherApp = appAs(OTHER)
    const otherSetId = await seedSet(otherApp, OTHER_AGENT_ID, 1)
    await createTask(otherApp, OTHER_AGENT_ID, { setId: otherSetId, name: 'theirs' })

    const res = await app.request(`/api/agents/${AGENT_ID}/evaluation-tasks`)
    const body = (await res.json()) as { data: { name: string }[] }

    expect(body.data).toHaveLength(2)
    expect(body.data.map((t) => t.name)).not.toContain('theirs')
  })
})

describe('GET /:agentId/evaluation-tasks/:taskId', () => {
  it('returns the task together with its results', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 2)
    const created = (await (await createTask(app, AGENT_ID, { setId })).json()) as {
      data: { id: string }
    }

    const res = await app.request(`/api/agents/${AGENT_ID}/evaluation-tasks/${created.data.id}`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: { results: unknown[] } }
    expect(body.data.results).toHaveLength(2)
  })

  it('lets a viewer read results', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    const created = (await (await createTask(app, AGENT_ID, { setId })).json()) as {
      data: { id: string }
    }
    db.run(
      sql`INSERT INTO agent_members (agent_id, user_id, role) VALUES (${AGENT_ID}, ${OTHER}, 'viewer')`,
    )

    const res = await appAs(OTHER).request(
      `/api/agents/${AGENT_ID}/evaluation-tasks/${created.data.id}`,
    )
    expect(res.status).toBe(200)
  })
})

describe('PATCH review', () => {
  /**
   * Seeds a task and waits for its case to actually finish.
   *
   * A verdict is only accepted once the case has an answer to judge, so a test
   * that reviewed the row while it was still `pending` would be asserting
   * against a state the API now rejects.
   */
  async function seedTaskWithResult() {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    const created = (await (await createTask(app, AGENT_ID, { setId })).json()) as {
      data: { id: string }
    }
    await waitFor(
      () => db.select().from(evaluationResults).all()[0]?.status === 'completed',
      'the case to complete',
    )
    const resultId = db.select().from(evaluationResults).all()[0].id
    return { app, taskId: created.data.id, resultId }
  }

  it('records a pass verdict stamped with the reviewer', async () => {
    const { app, taskId, resultId } = await seedTaskWithResult()

    const res = await app.request(
      `/api/agents/${AGENT_ID}/evaluation-tasks/${taskId}/results/${resultId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: 'pass', note: 'looks right' }),
      },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { review: { verdict: string; note: string; reviewedBy: string } }
    }
    expect(body.data.review.verdict).toBe('pass')
    expect(body.data.review.note).toBe('looks right')
    expect(body.data.review.reviewedBy).toBe(OWNER)
  })

  it('ignores a caller-supplied reviewer identity', async () => {
    const { app, taskId, resultId } = await seedTaskWithResult()

    const res = await app.request(
      `/api/agents/${AGENT_ID}/evaluation-tasks/${taskId}/results/${resultId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: 'pass', reviewedBy: 'usr_impostor' }),
      },
    )

    const body = (await res.json()) as { data: { review: { reviewedBy: string } } }
    expect(body.data.review.reviewedBy).toBe(OWNER)
  })

  it('recomputes the task summary after a verdict', async () => {
    const { app, taskId, resultId } = await seedTaskWithResult()

    await app.request(`/api/agents/${AGENT_ID}/evaluation-tasks/${taskId}/results/${resultId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'pass' }),
    })

    const task = db.select().from(evaluationTasks).all()[0]
    expect(task.summary).toMatchObject({ total: 1, passed: 1, failed: 0, unreviewed: 0 })
  })

  it('refuses a verdict on a case that has not produced an answer', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    const resultId = db.select().from(evaluationResults).all()[0].id

    // Force the row back to a non-terminal state: a verdict recorded here would
    // still be counted in the pass rate once the case actually runs.
    db.update(evaluationResults)
      .set({ status: 'running' })
      .where(eq(evaluationResults.id, resultId))
      .run()

    const res = await app.request(
      `/api/agents/${AGENT_ID}/evaluation-tasks/${task.id}/results/${resultId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: 'pass' }),
      },
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('EVALUATION_RESULT_NOT_REVIEWABLE')
  })

  it('rejects an invalid verdict', async () => {
    const { app, taskId, resultId } = await seedTaskWithResult()

    const res = await app.request(
      `/api/agents/${AGENT_ID}/evaluation-tasks/${taskId}/results/${resultId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: 'maybe' }),
      },
    )
    expect(res.status).toBe(400)
  })

  it('rejects a viewer', async () => {
    const { taskId, resultId } = await seedTaskWithResult()
    db.run(
      sql`INSERT INTO agent_members (agent_id, user_id, role) VALUES (${AGENT_ID}, ${OTHER}, 'viewer')`,
    )

    const res = await appAs(OTHER).request(
      `/api/agents/${AGENT_ID}/evaluation-tasks/${taskId}/results/${resultId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: 'pass' }),
      },
    )
    expect(res.status).toBe(403)
  })

  it('404s for a result from a different task', async () => {
    const { app, resultId } = await seedTaskWithResult()
    const setId = await seedSet(app, AGENT_ID, 1)
    const other = (await (await createTask(app, AGENT_ID, { setId })).json()) as {
      data: { id: string }
    }

    const res = await app.request(
      `/api/agents/${AGENT_ID}/evaluation-tasks/${other.data.id}/results/${resultId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: 'pass' }),
      },
    )
    expect(res.status).toBe(404)
  })
})

describe('DELETE /:agentId/evaluation-tasks/:taskId', () => {
  it('deletes the task and cascades its results', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 2)
    const created = (await (await createTask(app, AGENT_ID, { setId })).json()) as {
      data: { id: string }
    }
    // A running task is deliberately undeletable, so let it finish first.
    await waitFor(
      () =>
        db
          .select()
          .from(evaluationTasks)
          .all()
          .find((t) => t.id === created.data.id)?.status === 'completed',
      'the task to complete',
    )

    const res = await app.request(`/api/agents/${AGENT_ID}/evaluation-tasks/${created.data.id}`, {
      method: 'DELETE',
    })

    expect(res.status).toBe(200)
    expect(db.select().from(evaluationTasks).all()).toHaveLength(0)
    expect(db.select().from(evaluationResults).all()).toHaveLength(0)
  })

  it('refuses to delete a running task, so its slot cannot be double-booked', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 2)

    let releaseFirstCase: () => void = () => {}
    const firstCaseStarted = new Promise<void>((resolveStarted) => {
      replayCaseMock.mockImplementationOnce(async () => {
        resolveStarted()
        await new Promise<void>((r) => {
          releaseFirstCase = r
        })
        return { status: 'completed' as const, actualTurns: [], error: null, durationMs: 1 }
      })
    })

    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    await firstCaseStarted

    const res = await app.request(`/api/agents/${AGENT_ID}/evaluation-tasks/${task.id}`, {
      method: 'DELETE',
    })

    // Slots are counted from `running` rows, so deleting the row would free the
    // slot while its subprocess is still alive and let the next submission
    // start alongside it, over the configured limit.
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('EVALUATION_TASK_RUNNING')

    releaseFirstCase()
    await waitFor(
      () =>
        db
          .select()
          .from(evaluationTasks)
          .all()
          .find((t) => t.id === task.id)?.status === 'completed',
      'the task to finish',
    )
  })

  it('stops a cancelled loop between cases instead of running them all', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 4)

    // Hold the first case open so the cancel lands mid-run, exactly as it does
    // when a user cancels a task they can see executing.
    let releaseFirstCase: () => void = () => {}
    const firstCaseStarted = new Promise<void>((resolveStarted) => {
      replayCaseMock.mockImplementationOnce(async () => {
        resolveStarted()
        await new Promise<void>((r) => {
          releaseFirstCase = r
        })
        return { status: 'completed' as const, actualTurns: [], error: null, durationMs: 1 }
      })
    })

    const task = (await (await createTask(app, AGENT_ID, { setId })).json()).data as { id: string }
    await firstCaseStarted
    expect(replayCaseMock).toHaveBeenCalledTimes(1)

    await app.request(`/api/agents/${AGENT_ID}/evaluation-tasks/${task.id}/cancel`, {
      method: 'POST',
    })
    releaseFirstCase()
    await waitFor(
      () =>
        db
          .select()
          .from(evaluationTasks)
          .all()
          .find((t) => t.id === task.id)?.status === 'cancelled',
      'the cancelled task to settle',
    )

    // The case in flight finishes, then the loop stops: cases 2-4 are never
    // started, so the user is not billed for work they asked to stop.
    expect(replayCaseMock).toHaveBeenCalledTimes(1)
  })
})

describe('task history survives set deletion', () => {
  it('keeps the task and its denormalized set name', async () => {
    const app = appAs(OWNER)
    const setId = await seedSet(app, AGENT_ID, 1)
    await createTask(app, AGENT_ID, { setId })

    await app.request(`/api/agents/${AGENT_ID}/evaluation-sets/${setId}`, { method: 'DELETE' })

    const tasks = db.select().from(evaluationTasks).all()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].setName).toBe('set')
    expect(tasks[0].setId).toBeNull()
  })
})
