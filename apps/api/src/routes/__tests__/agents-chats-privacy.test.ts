/**
 * Ownership scoping for the chat history reads.
 *
 * `GET /:id/chats` and `/:id/chats/:runId/messages` are guarded by
 * `requireAgentRead`, which answers "may this caller use the Agent" — not "whose
 * conversations may they read". `runs.intent` is the question text verbatim, so
 * without a `runs.userId` predicate any member of a shared Agent can read what
 * their colleagues asked it. The chat_app channel makes that load-bearing: it
 * routes many users' private conversations into one Agent's run stream.
 *
 * These tests inspect the compiled SQL rather than mock return values, because
 * the shared `makeSelectChain` mock ignores its `where` argument — a behavioural
 * assertion would pass with or without the predicate.
 */
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  // db/transaction.ts reads isPostgres + sqliteDatabase at module load.
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))
vi.mock('../../lib/id.js', () => ({ createId: vi.fn((p?: string) => `${p ?? ''}_test`) }))
vi.mock('../../engine/index.js', () => ({
  engineRegistry: { get: vi.fn().mockReturnValue(true), types: ['cursor'] },
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../worker/index.js', () => ({ executeInWorker: vi.fn() }))
vi.mock('../../lib/agent-helpers.js', () => ({
  resolveWorkDir: vi.fn().mockResolvedValue('/tmp/work'),
  WorktreeOccupiedError: class extends Error {},
  injectScmEnv: vi.fn(),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor', maxRetries: 0 }),
  resolveEngineType: vi.fn(() => 'cursor'),
}))
vi.mock('../../lib/git-workspace.js', () => ({
  WorktreeBranchLockedError: class extends Error {},
  WorktreeDirtyError: class extends Error {},
}))
vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: vi.fn().mockReturnValue('queue_full'),
  scheduleNext: vi.fn(),
}))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))
vi.mock('../../lib/execute-chat-run.js', () => ({ executeChatRun: vi.fn() }))
vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/feishu-service.js', () => ({
  normalizeFeishuConfig: (v: unknown) => v,
  feishuConnectionManager: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getFeishuConnectionStatuses: vi.fn().mockReturnValue([]),
    isRegistered: vi.fn().mockReturnValue(false),
    isSocketOpen: vi.fn().mockReturnValue(false),
  },
}))
vi.mock('../../lib/schedule-trigger.js', () => ({
  scheduleTriggerManager: { start: vi.fn(), stop: vi.fn() },
}))
vi.mock('../../lib/feishu-diagnose.js', () => ({
  runAgentFeishuDiagnose: vi.fn().mockResolvedValue({ ok: true, meta: {}, checks: [] }),
}))
vi.mock('../../lib/agent-execution-diagnose.js', () => ({
  collectAgentExecutionChecks: vi.fn().mockReturnValue([]),
}))

import { db } from '../../db/client.js'
import { AppError } from '../../lib/errors.js'
import { asyncQuery } from '../../test/async-query.js'
import { createTestAgent } from '../../test/factories.js'

/**
 * These tests build their app with a dynamic `import()` of a large route module.
 * Evaluating it is CPU-bound and happens while the rest of the api suite runs in
 * parallel, so the work is real but the wall-clock is dominated by contention,
 * not by anything under test. Vitest's 5s default was tight enough that a loaded
 * machine tipped these into "Test timed out" — a flake whose only signal is how
 * busy the box was. The file-level budget bounds a genuine hang without letting
 * scheduling noise fail a passing assertion.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const mockDb = db as unknown as { select: Mock }

const CALLER_ID = 'usr_caller'

/**
 * Captures `where(...)` arguments, keyed by the projection the query used.
 *
 * Keying matters: for a non-admin, `loadAgentWithPerm` runs a membership lookup
 * that binds the caller id for its own reasons. Pooling every predicate together
 * let that unrelated query satisfy the assertion, so the test passed even with
 * the chats filter removed.
 */
const whereArgsByKey = new Map<string, unknown[]>()
let currentKey = 'agent'

function capturingChain(rows: unknown) {
  const asArray = Array.isArray(rows) ? rows : rows != null ? [rows] : []
  const terminal = {
    get: vi.fn().mockReturnValue(Array.isArray(rows) ? rows[0] : rows),
    all: vi.fn().mockReturnValue(asArray),
    orderBy: vi.fn().mockReturnValue(
      asyncQuery({
        all: vi.fn().mockReturnValue(asArray),
        limit: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(asArray) })),
      }),
    ),
    limit: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(asArray) })),
  }
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation((cond: unknown) => {
        const bucket = whereArgsByKey.get(currentKey) ?? []
        bucket.push(cond)
        whereArgsByKey.set(currentKey, bucket)
        return terminal
      }),
    }),
  }
}

async function makeApp(role: 'admin' | 'user'): Promise<Hono> {
  const mod = await import('../agents.js')
  const app = new Hono()
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    return c.json({ error: 'Internal Server Error' }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('userRole' as never, role)
    c.set('userId' as never, CALLER_ID)
    await next()
  })
  app.route('/agents', mod.default)
  return app
}

/**
 * Whether any captured predicate binds the caller's id as a parameter.
 *
 * Walks the drizzle SQL tree by hand: the condition objects hold back-references
 * to their table, so they cannot be serialised, and only the bound `Param`
 * values carry the id we care about.
 */
function capturedSqlBindsCaller(key: string): boolean {
  const seen = new Set<unknown>()
  function holdsCallerId(node: unknown): boolean {
    if (node === CALLER_ID) return true
    if (node === null || typeof node !== 'object') return false
    if (seen.has(node)) return false
    seen.add(node)
    // `Param` wraps the literal; `SQL` exposes its parts as `queryChunks`.
    const candidates = [
      (node as { value?: unknown }).value,
      ...((node as { queryChunks?: unknown[] }).queryChunks ?? []),
    ]
    return candidates.some(holdsCallerId)
  }
  return (whereArgsByKey.get(key) ?? []).some(holdsCallerId)
}

/**
 * Whether the predicate also narrows by trigger source, which is what keeps the
 * caller-id arm from swallowing channels that never record a caller.
 */
function capturedSqlBindsChannelScope(key: string): boolean {
  const seen = new Set<unknown>()
  const SESSION_CHANNELS = ['chat_app', 'debug']
  function holdsChannel(node: unknown): boolean {
    if (typeof node === 'string' && SESSION_CHANNELS.includes(node)) return true
    if (node === null || typeof node !== 'object') return false
    if (seen.has(node)) return false
    seen.add(node)
    // `notInArray` nests its values as an array of Params, so array elements
    // have to be walked too — not just `value` and `queryChunks`.
    if (Array.isArray(node)) return node.some(holdsChannel)
    const candidates = [
      (node as { value?: unknown }).value,
      ...((node as { queryChunks?: unknown[] }).queryChunks ?? []),
    ]
    return candidates.some(holdsChannel)
  }
  return (whereArgsByKey.get(key) ?? []).some(holdsChannel)
}

/**
 * Mock `select` so each query lands in its own bucket:
 *   - `select({ id, intent, ... })` → the chats list
 *   - `select()` (no projection)    → the agent row, then the single run row
 */
function primeSelect(agentRow: unknown, runRow: unknown) {
  let bareSelectCalls = 0
  mockDb.select.mockImplementation((projection?: Record<string, unknown>) => {
    if (projection && 'intent' in projection) {
      currentKey = 'chatsList'
      return capturingChain([])
    }
    if (projection && 'role' in projection) {
      currentKey = 'membership'
      return capturingChain(undefined)
    }
    if (!projection) {
      bareSelectCalls += 1
      // First bare select resolves the agent; the second reads the run row.
      currentKey = bareSelectCalls === 1 ? 'agent' : 'runRow'
      return capturingChain(bareSelectCalls === 1 ? agentRow : runRow)
    }
    currentKey = 'other'
    return capturingChain([])
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  whereArgsByKey.clear()
  currentKey = 'agent'
})

describe('chat history is scoped to the caller', () => {
  /**
   * Admin deliberately included: read permission on an Agent is permission to
   * use it, not to read colleagues' questions. Owners who need usage figures
   * have GET /:id/stats; auditors have the run list and the audit log.
   */
  for (const role of ['user', 'admin'] as const) {
    it(`filters GET /:id/chats by the caller for a ${role}`, async () => {
      const app = await makeApp(role)
      // Owned by someone else, so a non-admin reaches it via membership — the
      // path where an unrelated caller-id binding used to mask a missing filter.
      primeSelect(createTestAgent({ id: 'agt_1', userId: CALLER_ID }), undefined)

      const res = await app.request('/agents/agt_1/chats')

      expect(res.status).toBe(200)
      expect(capturedSqlBindsCaller('chatsList')).toBe(true)
    })
  }

  /**
   * The privacy scope must key on the *channel*, not on `runs.userId` alone.
   *
   * Only the session-authenticated surfaces (chat_app, debug) record the actual
   * caller there. Feishu, gateway and OAuth leave it NULL; A2A, schedule, Slack
   * and Discord stamp the agent owner. A bare `userId = me` therefore hides an
   * Agent's entire production traffic from its own owner — the exact defect
   * `getRunReadFilter` in agent-access.ts documents having already fixed once.
   */
  it('does not hide runs from channels that never record the caller', async () => {
    const app = await makeApp('user')
    primeSelect(createTestAgent({ id: 'agt_1', userId: CALLER_ID }), undefined)

    const res = await app.request('/agents/agt_1/chats')

    expect(res.status).toBe(200)
    // The predicate narrows by caller AND by trigger source. Without the second
    // arm it collapses to `user_id = me`, which a NULL can never satisfy, so
    // Feishu/gateway conversations disappear for everyone including the owner.
    expect(capturedSqlBindsCaller('chatsList')).toBe(true)
    expect(capturedSqlBindsChannelScope('chatsList')).toBe(true)
  })

  it('filters the message read by the caller, so a lifted run id reads nothing', async () => {
    const app = await makeApp('user')
    primeSelect(createTestAgent({ id: 'agt_1', userId: CALLER_ID }), undefined)

    const res = await app.request('/agents/agt_1/chats/run_from_someone_else/messages')

    // The run row lookup found nothing once scoped to the caller.
    expect(res.status).toBe(404)
    expect(capturedSqlBindsCaller('runRow')).toBe(true)
  })
})
