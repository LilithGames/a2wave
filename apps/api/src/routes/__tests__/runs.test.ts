import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { runs } from '../../db/schema.js'

type Json = Record<string, unknown>
const { cancelMock } = vi.hoisted(() => ({ cancelMock: vi.fn().mockResolvedValue(false) }))

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  // `db/transaction.js` reads these at module load to pick a backend, and its
  // SQLite branch drives BEGIN/COMMIT on the raw handle. Without a stand-in
  // handle every transactional route throws before its own mocks are consulted.
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../lib/id.js', () => {
  let counter = 0
  return {
    createId: vi.fn((prefix?: string) => {
      counter++
      return prefix ? `${prefix}_test${counter}` : `test${counter}`
    }),
  }
})

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  resolveWorkDir: vi.fn().mockResolvedValue('/tmp/work'),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor' }),
}))

vi.mock('../../engine/index.js', () => ({
  engineRegistry: {
    cancel: cancelMock,
    types: [],
  },
}))

vi.mock('../../engine/execution-lease-registry.js', () => ({
  cancelExecutionLease: vi.fn().mockResolvedValue(undefined),
  bindExecutionLeaseTask: vi.fn(),
  hasExecutionLease: vi.fn().mockReturnValue(false),
  reserveExecutionLease: vi.fn(),
  reserveExecutionLeaseForAgent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/scm-workload-lifecycle.js', () => ({
  activateScmWorkload: vi.fn().mockResolvedValue(undefined),
  releaseReservedScmWorkload: vi.fn().mockResolvedValue(false),
  releaseReservedScmWorkloadInMutation: vi.fn().mockResolvedValue(false),
  withScmWorkloadAdmission: vi.fn(async (_input, callback) => {
    const { db } = await import('../../db/client.js')
    return callback(db, {
      workspaceType: 'temp',
      scmSourceId: null,
      leaseId: null,
      alreadyReserved: false,
    })
  }),
}))

const mockTryAcquireSlot = vi.hoisted(() => vi.fn().mockReturnValue('acquired'))
vi.mock('../../engine/task-queue.js', () => ({
  scheduleNext: vi.fn(),
  tryAcquireSlot: mockTryAcquireSlot,
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

vi.mock('../../lib/execute-chat-run.js', () => ({
  executeChatRun: vi.fn().mockResolvedValue(undefined),
}))

const mockRunWithLifecycle = vi.hoisted(() => vi.fn())
vi.mock('../../lib/run-launcher.js', () => ({
  runWithLifecycle: mockRunWithLifecycle,
}))

const mockRegisterPendingContext = vi.hoisted(() => vi.fn())
vi.mock('../../lib/pending-job-registry.js', () => ({
  registerPendingContext: mockRegisterPendingContext,
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../../lib/owner-filter.js', () => ({
  getCurrentUserId: vi.fn().mockReturnValue(undefined),
}))

// Partial mock: only the run visibility filter is stubbed (its SQL semantics are
// covered by agent-access.test.ts). requireAgentWrite / loadAgentWithPerm stay
// REAL so the permission suites below assert actual permission behaviour.
const mockGetRunReadFilter = vi.hoisted(() => vi.fn(() => undefined))
vi.mock('../../lib/agent-access.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRunReadFilter: mockGetRunReadFilter,
}))

function makeSelectChain(result: unknown) {
  const orderByFn = vi.fn().mockReturnValue(
    asyncQuery({
      all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
      limit: vi.fn().mockReturnValue(
        asyncQuery({
          get: vi.fn().mockReturnValue(Array.isArray(result) ? result[0] : result),
          offset: vi.fn().mockReturnValue(
            asyncQuery({
              all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
            }),
          ),
        }),
      ),
    }),
  )

  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(Array.isArray(result) ? result[0] : result),
            all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
            orderBy: orderByFn,
          }),
        ),
        leftJoin: vi.fn().mockReturnValue(
          asyncQuery({
            where: vi.fn().mockReturnValue(
              asyncQuery({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockReturnValue(
                      asyncQuery({
                        all: vi
                          .fn()
                          .mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
                      }),
                    ),
                  }),
                }),
              }),
            ),
          }),
        ),
        orderBy: orderByFn,
        all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
      }),
    ),
  }
}

function makeInsertChain(returnValue?: unknown) {
  return {
    values: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(returnValue ?? {}),
          }),
        ),
        run: vi.fn(),
      }),
    ),
  }
}

const setCalls: unknown[] = []
/** Parallel array: whereCalls[i] is the where-clause of setCalls[i]. */
const whereCalls: unknown[] = []

/**
 * `changes` is configurable so a test can express the CAS *losing* the race
 * (0 rows updated). Defaulting to 1 keeps every existing caller unchanged.
 */
function makeUpdateChain(changes = 1) {
  return {
    set: vi.fn().mockImplementation((arg: unknown) => {
      setCalls.push(arg)
      return asyncQuery({
        where: vi.fn().mockImplementation((cond: unknown) => {
          whereCalls.push(cond)
          // `changes` still drives the row count: `asyncQuery` turns a legacy
          // `{ changes: n }` into n placeholder rows, so a compare-and-set that
          // counts `.returning()` rows still sees 0 when the race was lost.
          return asyncQuery({ run: vi.fn().mockReturnValue({ changes }) })
        }),
      })
    }),
  }
}

/**
 * Select mock that resolves each lookup by what its WHERE clause binds, not by
 * call order. Positional queues cannot express permission scenarios where the
 * *order* of lookups depends on the very guard under test — such a queue passes
 * with or without the guard and would not catch its removal.
 *
 * Routing: a `usr_` parameter means a membership lookup; an `agt_` parameter
 * means an agent lookup by that id; anything else is run-scoped, resolved as the
 * run first and its latest step second (that order holds regardless of guards,
 * since guards bind agent/user ids).
 */
async function selectByBoundId(fixture: {
  run: unknown
  step?: unknown
  agents?: Record<string, unknown>
  members?: Record<string, { role: string }>
}) {
  const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
  const dialect = new SQLiteSyncDialect()
  let runScopedLookups = 0
  mockDb.select.mockImplementation(() =>
    asyncQuery({
      from: vi.fn().mockReturnValue(
        asyncQuery({
          where: vi.fn().mockImplementation((cond: unknown) => {
            const params = (dialect.sqlToQuery(cond as never).params as unknown[]).filter(
              (p): p is string => typeof p === 'string',
            )
            const agentId = params.find((p) => p.startsWith('agt_'))
            const isMembershipLookup = params.some((p) => p.startsWith('usr_'))
            let row: unknown
            if (isMembershipLookup) row = agentId ? fixture.members?.[agentId] : undefined
            else if (agentId) row = fixture.agents?.[agentId]
            else row = runScopedLookups++ === 0 ? fixture.run : fixture.step

            const terminal = () => ({
              get: vi.fn().mockReturnValue(row),
              all: vi.fn().mockReturnValue(row ? [row] : []),
            })
            return asyncQuery({
              ...terminal(),
              orderBy: vi.fn().mockReturnValue(
                asyncQuery({
                  ...terminal(),
                  limit: vi.fn().mockReturnValue(asyncQuery(terminal())),
                }),
              ),
            })
          }),
        }),
      ),
    }),
  )
}

import { db } from '../../db/client.js'
import { engineRegistry } from '../../engine/index.js'
import { scheduleNext } from '../../engine/task-queue.js'
import { buildAgentConfig } from '../../lib/agent-helpers.js'
import { logAudit } from '../../lib/audit.js'
import { executeChatRun } from '../../lib/execute-chat-run.js'
import { createId } from '../../lib/id.js'
import { getCurrentUserId } from '../../lib/owner-filter.js'

import { asyncQuery } from '../../test/async-query.js'

const mockGetCurrentUserId = getCurrentUserId as unknown as Mock

const mockDb = db as unknown as {
  select: Mock
  insert: Mock
  update: Mock
}

// Every suite in this file shares one `mockDb.select`, and `vi.clearAllMocks()`
// does NOT drain `mockReturnValueOnce` queues. A guard that returns early leaves
// its unconsumed entries behind, where they resurface as baffling failures in a
// LATER suite — that is exactly how the round-1 execute-guard fixture bug first
// manifested (four cancel tests broke). Reset the builders outright before every
// test so suites cannot bleed into one another.
beforeEach(() => {
  mockDb.select.mockReset()
  mockDb.insert.mockReset()
  mockDb.update.mockReset()
})

const SAMPLE_RUN = {
  id: 'run_1',
  intent: 'Fix the bug',
  status: 'completed' as const,
  result: { output: 'Done' },
  initiatorAgentId: 'agt_1',
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
}

describe('GET /runs', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockTryAcquireSlot.mockReturnValue('acquired')
    const mod = await import('../runs.js')
    app = new Hono().route('/runs', mod.default)
  })

  it('returns paginated runs list', async () => {
    const countChain = {
      from: vi.fn().mockReturnValue(
        asyncQuery({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockReturnValue({ count: 1 }),
            }),
          ),
        }),
      ),
    }

    const dataChain = {
      from: vi.fn().mockReturnValue(
        asyncQuery({
          leftJoin: vi.fn().mockReturnValue(
            asyncQuery({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockReturnValue(
                      asyncQuery({
                        all: vi
                          .fn()
                          .mockReturnValue([
                            { ...SAMPLE_RUN, agentName: 'Agent', agentIcon: '🤖' },
                          ]),
                      }),
                    ),
                  }),
                }),
              }),
            }),
          ),
        }),
      ),
    }

    mockDb.select.mockReturnValueOnce(countChain).mockReturnValueOnce(dataChain)

    const res = await app.request('/runs')
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    expect(json.data).toBeDefined()
    expect(json.pagination).toBeDefined()

    const pagination = json.pagination as Json
    expect(pagination.total).toBe(1)
    expect(pagination.page).toBe(1)
    expect(mockDb.select).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ triggerAgentName: expect.anything() }),
    )
  })

  it('respects page and pageSize query params', async () => {
    const countChain = {
      from: vi.fn().mockReturnValue(
        asyncQuery({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockReturnValue({ count: 50 }),
            }),
          ),
        }),
      ),
    }

    const dataChain = {
      from: vi.fn().mockReturnValue(
        asyncQuery({
          leftJoin: vi.fn().mockReturnValue(
            asyncQuery({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockReturnValue(
                      asyncQuery({
                        all: vi.fn().mockReturnValue([]),
                      }),
                    ),
                  }),
                }),
              }),
            }),
          ),
        }),
      ),
    }

    mockDb.select.mockReturnValueOnce(countChain).mockReturnValueOnce(dataChain)

    const res = await app.request('/runs?page=2&pageSize=10')
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    const pagination = json.pagination as Json
    expect(pagination.page).toBe(2)
    expect(pagination.pageSize).toBe(10)
    expect(pagination.totalPages).toBe(5)
  })
})

describe('GET /runs/leaderboard', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../runs.js')
    app = new Hono().route('/runs', mod.default)
  })

  /**
   * Mock chain for one leaderboard query:
   * select().from().innerJoin().where().groupBy() → then either .orderBy().limit().all()
   * (byRuns) or .having().orderBy().limit().all() (byUsers). Both terminal shapes are
   * wired so a single chain serves whichever the handler calls. `spies` lets the test
   * assert HAVING/ordering wiring.
   */
  function makeLeaderboardChain(rows: unknown[]) {
    const tail = {
      orderBy: vi.fn().mockReturnValue(
        asyncQuery({
          limit: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(rows) })),
        }),
      ),
    }
    const having = vi.fn().mockReturnValue(tail)
    const groupBy = vi.fn().mockReturnValue(asyncQuery({ ...tail, having }))
    const where = vi.fn().mockReturnValue(asyncQuery({ groupBy }))
    const chain = {
      from: vi.fn().mockReturnValue(
        asyncQuery({
          innerJoin: vi.fn().mockReturnValue(asyncQuery({ where })),
        }),
      ),
    }
    return { chain, having, groupBy, where }
  }

  it('returns byRuns and byUsers leaderboards', async () => {
    const byRuns = makeLeaderboardChain([
      { agentId: 'agt_1', name: 'Alpha', icon: '🤖', count: 7 },
      { agentId: 'agt_2', name: 'Beta', icon: '🚀', count: 4 },
    ])
    const byUsers = makeLeaderboardChain([{ agentId: 'agt_2', name: 'Beta', icon: '🚀', count: 3 }])
    const byTokens = makeLeaderboardChain([
      { agentId: 'agt_1', name: 'Alpha', icon: '🤖', count: 1500 },
    ])
    mockDb.select
      .mockReturnValueOnce(byRuns.chain)
      .mockReturnValueOnce(byUsers.chain)
      .mockReturnValueOnce(byTokens.chain)

    const res = await app.request('/runs/leaderboard')
    expect(res.status).toBe(200)

    const json = (await res.json()) as {
      byRuns: unknown[]
      byUsers: unknown[]
      byTokens: unknown[]
    }
    expect(json.byRuns).toEqual([
      { agentId: 'agt_1', name: 'Alpha', icon: '🤖', count: 7 },
      { agentId: 'agt_2', name: 'Beta', icon: '🚀', count: 4 },
    ])
    expect(json.byUsers).toEqual([{ agentId: 'agt_2', name: 'Beta', icon: '🚀', count: 3 }])
    expect(json.byTokens).toEqual([{ agentId: 'agt_1', name: 'Alpha', icon: '🤖', count: 1500 }])

    // byUsers/byTokens must filter out zero entries via HAVING; byRuns must not.
    expect(byUsers.having).toHaveBeenCalledTimes(1)
    expect(byRuns.having).not.toHaveBeenCalled()
    expect(byTokens.having).toHaveBeenCalledTimes(1)

    const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
    const tokenSelection = mockDb.select.mock.calls[2]?.[0] as { count: SQL }
    const tokenSql = new SQLiteSyncDialect().sqlToQuery(tokenSelection.count).sql
    expect(tokenSql).toContain('input_tokens')
    expect(tokenSql).toContain('output_tokens')
    expect(tokenSql).toContain('reasoning_tokens')
    expect(tokenSql).toContain('cache_read_tokens')
    expect(tokenSql).toContain('cache_write_tokens')
  })

  it('returns empty arrays when there are no runs', async () => {
    mockDb.select
      .mockReturnValueOnce(makeLeaderboardChain([]).chain)
      .mockReturnValueOnce(makeLeaderboardChain([]).chain)
      .mockReturnValueOnce(makeLeaderboardChain([]).chain)

    const res = await app.request('/runs/leaderboard')
    expect(res.status).toBe(200)

    const json = (await res.json()) as {
      byRuns: unknown[]
      byUsers: unknown[]
      byTokens: unknown[]
    }
    expect(json.byRuns).toEqual([])
    expect(json.byUsers).toEqual([])
    expect(Array.isArray(json.byTokens)).toBe(true)
    expect(json.byTokens).toEqual([])
  })

  it('passes the visibility filter to both queries (data isolation)', async () => {
    // 数据隔离唯一防线：非 admin 时 getRunReadFilter 返回一条 SQL，
    // Every leaderboard query must apply the same visibility filter to prevent data leakage.
    const FILTER_SENTINEL = { __runReadFilter: true } as never
    mockGetRunReadFilter.mockReturnValue(FILTER_SENTINEL)
    const byRuns = makeLeaderboardChain([])
    const byUsers = makeLeaderboardChain([])
    const byTokens = makeLeaderboardChain([])
    mockDb.select
      .mockReturnValueOnce(byRuns.chain)
      .mockReturnValueOnce(byUsers.chain)
      .mockReturnValueOnce(byTokens.chain)

    const res = await app.request('/runs/leaderboard')
    expect(res.status).toBe(200)

    expect(byRuns.where).toHaveBeenCalledWith(FILTER_SENTINEL)
    expect(byUsers.where).toHaveBeenCalledWith(FILTER_SENTINEL)
    expect(byTokens.where).toHaveBeenCalledWith(FILTER_SENTINEL)
  })
})

describe('GET /runs/:id', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../runs.js')
    app = new Hono().route('/runs', mod.default)
  })

  it('returns 404 when run does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(undefined))

    const res = await app.request('/runs/run_nonexistent')
    expect(res.status).toBe(404)

    const json = (await res.json()) as Json
    expect(json.error).toBe('Run not found')
  })

  it('returns run with steps and messages', async () => {
    mockDb.select
      .mockReturnValueOnce(
        makeSelectChain({
          ...SAMPLE_RUN,
          executionMetadata: { oauthPreviousChatId: 'chat_internal' },
        }),
      )
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]))

    const res = await app.request('/runs/run_1')
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.id).toBe('run_1')
    expect(data.intent).toBe('Fix the bug')
    expect(data.executionMetadata).toBeUndefined()
  })
})

describe('POST /runs', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../runs.js')
    app = new Hono()
    // The route guards `initiatorAgentId` with requireAgentWrite, which reads the
    // caller identity off the context. Production always has it (auth middleware),
    // so injecting it here keeps these cases about the *input schema* rather than
    // about an unauthenticated caller. Permission itself is covered by the
    // dedicated suite below.
    app.use('*', async (c, next) => {
      c.set('userRole' as never, 'admin')
      c.set('userId' as never, 'usr_admin')
      await next()
    })
    app.route('/runs', mod.default)
  })

  it('returns 400 for missing intent', async () => {
    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for empty intent', async () => {
    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when initiatorAgentId is missing', async () => {
    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'Review code' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for a whitespace-only intent', async () => {
    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: '   ', initiatorAgentId: 'agt_1' }),
    })
    expect(res.status).toBe(400)
  })

  it('creates a new run with a valid intent and agent', async () => {
    const newRun = {
      id: 'run_test1',
      intent: 'Review code',
      initiatorAgentId: 'agt_1',
      status: 'pending',
    }
    // requireAgentWrite loads the agent first; admin short-circuits to owner, so
    // no membership lookup follows.
    mockDb.select.mockReturnValueOnce(
      makeSelectChain({ id: 'agt_1', userId: 'usr_admin', status: 'active', config: {} }),
    )
    mockDb.insert.mockReturnValue(makeInsertChain(newRun))

    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'Review code', initiatorAgentId: 'agt_1' }),
    })
    expect(res.status).toBe(201)

    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.id).toBe('run_test1')
    expect(data.intent).toBe('Review code')
    expect(data.initiatorAgentId).toBe('agt_1')
  })
})

/**
 * `POST /runs` takes `initiatorAgentId` straight from the body. Before runs became
 * visible through the *agent* (getRunReadFilter), a row planted on someone else's
 * agent stayed invisible to that agent's owner, because the old getOwnerFilter
 * scoped by runs.user_id — the planter's id. Deriving read access from the agent
 * turns the same row into pollution the victim now sees: it lands in their run
 * list, their stats and the leaderboard, carrying whatever `intent` text was sent.
 *
 * Write (not read) is the right bar, and it costs no legitimate caller: the CLI
 * creates a run and immediately executes it, and execute already demands write on
 * the same agent — so anyone this guard rejects would have failed one step later.
 */
describe('POST /runs — initiatorAgentId permission', () => {
  async function makeAppAsRole(role: 'admin' | 'user', userId: string): Promise<Hono> {
    const mod = await import('../runs.js')
    const app = new Hono()
    app.onError((err, c) => {
      const anyErr = err as { statusCode?: number; message?: string; code?: string }
      if (typeof anyErr.statusCode === 'number') {
        return c.json({ error: anyErr.message, code: anyErr.code }, anyErr.statusCode as never)
      }
      return c.json({ error: 'Internal Server Error' }, 500)
    })
    app.use('*', async (c, next) => {
      c.set('userRole' as never, role)
      c.set('userId' as never, userId)
      await next()
    })
    app.route('/runs', mod.default)
    return app
  }

  function postRun(app: Hono, initiatorAgentId: string) {
    return app.request('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'planted', initiatorAgentId }),
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRunReadFilter.mockReturnValue(undefined)
  })

  it('stranger planting a run on a foreign agent → 404, nothing inserted', async () => {
    const foreignAgent = { id: 'agt_victim', userId: 'usr_owner', status: 'active', config: {} }
    // 1st select → agent lookup; 2nd → membership lookup finds nothing.
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(foreignAgent))
      .mockReturnValueOnce(makeSelectChain(undefined))

    const res = await postRun(await makeAppAsRole('user', 'usr_attacker'), 'agt_victim')

    expect(res.status).toBe(404)
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('viewer member → 403, nothing inserted', async () => {
    const sharedAgent = { id: 'agt_shared', userId: 'usr_owner', status: 'active', config: {} }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(sharedAgent))
      .mockReturnValueOnce(makeSelectChain({ role: 'viewer' }))

    const res = await postRun(await makeAppAsRole('user', 'usr_viewer'), 'agt_shared')

    expect(res.status).toBe(403)
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('unknown agent id → 404, nothing inserted', async () => {
    mockDb.select.mockReturnValueOnce(makeSelectChain(undefined))

    const res = await postRun(await makeAppAsRole('user', 'usr_someone'), 'agt_ghost')

    expect(res.status).toBe(404)
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('editor member → 201, run created', async () => {
    const sharedAgent = { id: 'agt_shared', userId: 'usr_owner', status: 'active', config: {} }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(sharedAgent))
      .mockReturnValueOnce(makeSelectChain({ role: 'editor' }))
    mockDb.insert.mockReturnValue(makeInsertChain({ id: 'run_ok', initiatorAgentId: 'agt_shared' }))

    const res = await postRun(await makeAppAsRole('user', 'usr_editor'), 'agt_shared')

    expect(res.status).toBe(201)
    expect(mockDb.insert).toHaveBeenCalled()
  })

  it('agent owner → 201, membership is never consulted', async () => {
    const ownAgent = { id: 'agt_mine', userId: 'usr_owner', status: 'active', config: {} }
    mockDb.select.mockReturnValueOnce(makeSelectChain(ownAgent))
    mockDb.insert.mockReturnValue(makeInsertChain({ id: 'run_ok', initiatorAgentId: 'agt_mine' }))

    const res = await postRun(await makeAppAsRole('user', 'usr_owner'), 'agt_mine')

    expect(res.status).toBe(201)
    expect(mockDb.select).toHaveBeenCalledTimes(1)
  })
})

describe('POST /runs/:id/cancel', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../runs.js')
    // These cases assert cancellation *mechanics*; run as admin so canCancelRun
    // short-circuits and no membership lookup perturbs the db.select sequence.
    // Authorization itself is covered by the suite at the bottom of this file.
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userRole' as never, 'admin')
      c.set('userId' as never, 'usr_admin')
      await next()
    })
    app.route('/runs', mod.default)
  })

  it('returns 404 when run does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(undefined))

    const res = await app.request('/runs/run_nonexistent/cancel', { method: 'POST' })
    expect(res.status).toBe(404)

    const json = (await res.json()) as Json
    expect(json.error).toBe('Run not found')
  })

  it('returns 400 when run is already completed', async () => {
    mockDb.select.mockReturnValue(makeSelectChain({ ...SAMPLE_RUN, status: 'completed' }))

    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })
    expect(res.status).toBe(400)

    const json = (await res.json()) as Json
    expect(json.error).toContain('not cancellable')
  })

  it('returns 400 when run is already failed', async () => {
    mockDb.select.mockReturnValue(makeSelectChain({ ...SAMPLE_RUN, status: 'failed' }))

    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('cancels a running run successfully', async () => {
    const runningRun = { ...SAMPLE_RUN, status: 'running', initiatorAgentId: 'agt_1' }
    const step = { id: 'rst_1', runId: 'run_1', order: 1, status: 'running' }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(runningRun)) // 1. load run
      .mockReturnValueOnce(makeSelectChain({ status: 'running' })) // 2. re-read status after drain
      .mockReturnValueOnce(makeSelectChain(step)) // 3. latest step
    mockDb.update.mockReturnValue(makeUpdateChain())

    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.status).toBe('cancelled')
    expect(data.runId).toBe('run_1')
  })

  it('cancels a queued run successfully', async () => {
    const queuedRun = { ...SAMPLE_RUN, status: 'queued', initiatorAgentId: 'agt_1' }

    mockDb.select
      .mockReturnValueOnce(makeSelectChain(queuedRun)) // 1. load run
      .mockReturnValueOnce(makeSelectChain({ status: 'queued' })) // 2. re-read status
    mockDb.update.mockReturnValue(makeUpdateChain())

    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.status).toBe('cancelled')
  })

  it('advances the queue immediately after cancelling a queued run', async () => {
    const queuedRun = { ...SAMPLE_RUN, status: 'queued', initiatorAgentId: 'agt_1' }

    mockDb.select
      .mockReturnValueOnce(makeSelectChain(queuedRun))
      .mockReturnValueOnce(makeSelectChain({ status: 'queued' })) // re-read status
    mockDb.update.mockReturnValue(makeUpdateChain())

    await app.request('/runs/run_1/cancel', { method: 'POST' })

    expect(scheduleNext).toHaveBeenCalled()
  })

  it('advances the queue after a running process cancellation settles', async () => {
    const runningRun = { ...SAMPLE_RUN, status: 'running', initiatorAgentId: 'agt_1' }
    const step = { id: 'rst_1', runId: 'run_1', order: 1, status: 'running' }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(runningRun))
      .mockReturnValueOnce(makeSelectChain({ status: 'running' })) // re-read status after drain
      .mockReturnValueOnce(makeSelectChain(step))
    mockDb.update.mockReturnValue(makeUpdateChain())

    await app.request('/runs/run_1/cancel', { method: 'POST' })

    expect(scheduleNext).toHaveBeenCalledOnce()
  })

  it('returns before a running CLI process finishes its shutdown grace period', async () => {
    const runningRun = { ...SAMPLE_RUN, status: 'running', initiatorAgentId: 'agt_1' }
    const step = { id: 'rst_1', runId: 'run_1', order: 1, status: 'running' }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(runningRun))
      .mockReturnValueOnce(makeSelectChain({ status: 'running' })) // re-read status after drain
      .mockReturnValueOnce(makeSelectChain(step))
    mockDb.update.mockReturnValue(makeUpdateChain())

    let resolveCancellation!: (value: boolean) => void
    const cancellation = new Promise<boolean>((resolve) => {
      resolveCancellation = resolve
    })
    cancelMock.mockReturnValue(cancellation)

    const responsePromise = app.request('/runs/run_1/cancel', { method: 'POST' })
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      responsePromise,
      new Promise<'blocked'>((resolve) => {
        timeoutId = setTimeout(() => resolve('blocked'), 50)
      }),
    ])

    if (timeoutId) clearTimeout(timeoutId)
    resolveCancellation(false)
    cancelMock.mockResolvedValue(false)

    expect(outcome).not.toBe('blocked')
    expect((outcome as Response).status).toBe(200)
  })

  it('cancels the chat task using the chat/ taskId format', async () => {
    const runningRun = { ...SAMPLE_RUN, status: 'running', initiatorAgentId: 'agt_1' }
    const step = { id: 'rst_1', runId: 'run_1', order: 1, status: 'running' }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(runningRun))
      .mockReturnValueOnce(makeSelectChain({ status: 'running' })) // re-read status after drain
      .mockReturnValueOnce(makeSelectChain(step))
    mockDb.update.mockReturnValue(makeUpdateChain())

    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(cancelMock).toHaveBeenCalledWith('chat/run_1/rst_1')
  })

  it('cancels Feishu and invoke task variants without selecting an engine', async () => {
    const runningRun = { ...SAMPLE_RUN, status: 'running', initiatorAgentId: 'agt_1' }
    const step = { id: 'rst_1', runId: 'run_1', order: 1, status: 'running' }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(runningRun))
      .mockReturnValueOnce(makeSelectChain({ status: 'running' })) // re-read status after drain
      .mockReturnValueOnce(makeSelectChain(step))
    mockDb.update.mockReturnValue(makeUpdateChain())

    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(cancelMock).toHaveBeenCalledWith('feishu/run_1/rst_1')
    expect(cancelMock).toHaveBeenCalledWith('invoke/run_1/rst_1')
    expect(cancelMock).toHaveBeenCalledWith('run_1/rst_1')
  })

  it('does not resolve Provider config before cancellation', async () => {
    const runningRun = { ...SAMPLE_RUN, status: 'running', initiatorAgentId: 'agt_1' }
    const step = { id: 'rst_1', runId: 'run_1', order: 1, status: 'running' }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(runningRun))
      .mockReturnValueOnce(makeSelectChain({ status: 'running' })) // re-read status after drain
      .mockReturnValueOnce(makeSelectChain(step))
    mockDb.update.mockReturnValue(makeUpdateChain())
    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(buildAgentConfig).not.toHaveBeenCalled()
    expect(cancelMock).toHaveBeenCalledWith('invoke/run_1/rst_1')
  })

  it('follows the re-read status: queued→running during the drain cancels the process (P2 TOCTOU)', async () => {
    // Snapshot reads 'queued', but by the time we re-read after the drain the
    // scheduler has promoted it to 'running'. The cancel must follow the current
    // status: kill the process (cancelMock) rather than treat it as a queued run
    // and merely advance the queue while a real child keeps running.
    const snapshotRun = { ...SAMPLE_RUN, status: 'queued', initiatorAgentId: 'agt_1' }
    const step = { id: 'rst_1', runId: 'run_1', order: 1, status: 'running' }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(snapshotRun)) // 1. load run (queued snapshot)
      .mockReturnValueOnce(makeSelectChain({ status: 'running' })) // 2. re-read → promoted
      .mockReturnValueOnce(makeSelectChain(step)) // 3. latest step
    mockDb.update.mockReturnValue(makeUpdateChain())

    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })
    expect(res.status).toBe(200)
    // Running path taken: the live child process is cancelled. (Before the fix
    // this promoted-queued run would have hit the queued branch and never
    // signalled the process — a cancel that silently no-ops.)
    expect(cancelMock).toHaveBeenCalledWith('run_1/rst_1')
  })
})

describe('POST /runs/:id/execute', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    setCalls.length = 0
    mockRunWithLifecycle.mockResolvedValue({
      success: true,
      output: 'done',
      durationMs: 100,
    })
    const mod = await import('../runs.js')
    app = new Hono().route('/runs', mod.default)
  })

  it('returns 400 for invalid JSON body', async () => {
    const run = { ...SAMPLE_RUN, status: 'pending', initiatorAgentId: 'agt_1' }
    const agent = { id: 'agt_1', type: 'cursor', status: 'active', name: 'A' }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(run))
      .mockReturnValueOnce(makeSelectChain(agent))

    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    expect(res.status).toBe(400)
  })

  it('sync execution delegates finalization to the shared lifecycle', async () => {
    // 使用与现有流式测试相同的 mock 模式：同一对象既充当 run 又充当 agent
    const runAndAgent = {
      id: 'run_1',
      intent: 'task',
      status: 'active', // 不在 ['running','completed','failed','cancelled'] 中，过重入检查
      initiatorAgentId: 'agt_1',
      type: 'cursor',
      name: 'A',
      config: {},
    }
    mockDb.select.mockReturnValue(makeSelectChain(runAndAgent))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockRunWithLifecycle.mockResolvedValue({ success: true, output: 'done', durationMs: 100 })

    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agt_1' }),
    })

    expect(res.status).toBe(200)
    expect(mockRunWithLifecycle).toHaveBeenCalledOnce()
  })

  it('sync 执行成功返回 result 和 durationMs', async () => {
    const runAndAgent = {
      id: 'run_1',
      intent: 'task',
      status: 'active',
      initiatorAgentId: 'agt_1',
      type: 'cursor',
      name: 'A',
      config: {},
    }
    mockDb.select.mockReturnValue(makeSelectChain(runAndAgent))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockRunWithLifecycle.mockResolvedValue({
      success: true,
      output: 'task done',
      chatId: 'ch_1',
      durationMs: 250,
    })

    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agt_1' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.output).toBe('task done')
    expect(typeof data.durationMs).toBe('number')
  })

  it('stream 执行成功返回 SSE done 事件', async () => {
    const runAndAgent = {
      id: 'run_1',
      intent: 'task',
      status: 'active',
      initiatorAgentId: 'agt_1',
      type: 'cursor',
      name: 'A',
      config: {},
    }
    mockDb.select.mockReturnValue(makeSelectChain(runAndAgent))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockRunWithLifecycle.mockResolvedValue({
      success: true,
      output: 'stream result',
      durationMs: 300,
    })

    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, agentId: 'agt_1' }),
    })

    const text = await res.text()
    expect(text).toContain('event: done')
    expect(text).toContain('"output":"stream result"')
  })

  it('stream 执行时转发日志事件', async () => {
    const runAndAgent = {
      id: 'run_1',
      intent: 'task',
      status: 'active',
      initiatorAgentId: 'agt_1',
      type: 'cursor',
      name: 'A',
      config: {},
    }
    mockDb.select.mockReturnValue(makeSelectChain(runAndAgent))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockRunWithLifecycle.mockImplementation(
      (
        _taskId: string,
        _payload: unknown,
        _params: unknown,
        options?: { onLogEntry?: (entry: unknown) => void },
      ) => {
        options?.onLogEntry?.({ type: 'system', subtype: 'init', model: 'gpt-4', ts: Date.now() })
        return Promise.resolve({ success: true, output: 'ok', durationMs: 100 })
      },
    )

    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, agentId: 'agt_1' }),
    })

    const text = await res.text()
    expect(text).toContain('event: log')
  })

  it('sync lifecycle failure returns an error response', async () => {
    const runAndAgent = {
      id: 'run_1',
      intent: 'task',
      status: 'active',
      initiatorAgentId: 'agt_1',
      type: 'cursor',
      name: 'A',
      config: {},
    }
    mockDb.select.mockReturnValue(makeSelectChain(runAndAgent))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockRunWithLifecycle.mockResolvedValue({
      success: false,
      error: 'worker crashed',
      durationMs: 100,
    })

    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agt_1' }),
    })

    expect(res.status).toBe(500)
    expect(mockRunWithLifecycle).toHaveBeenCalledOnce()
  })

  it('sync lifecycle failure exposes its public error', async () => {
    const runAndAgent = {
      id: 'run_1',
      intent: 'task',
      status: 'active',
      initiatorAgentId: 'agt_1',
      type: 'cursor',
      name: 'A',
      config: {},
    }
    mockDb.select.mockReturnValue(makeSelectChain(runAndAgent))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockRunWithLifecycle.mockResolvedValue({
      success: false,
      error: 'cursor crashed',
      durationMs: 100,
    })

    const response = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agt_1' }),
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ error: 'cursor crashed' })
  })

  it('sync engine failure is returned from the shared lifecycle', async () => {
    const runAndAgent = {
      id: 'run_1',
      intent: 'task',
      status: 'active',
      initiatorAgentId: 'agt_1',
      type: 'cursor',
      name: 'A',
      config: {},
    }
    mockDb.select.mockReturnValue(makeSelectChain(runAndAgent))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockRunWithLifecycle.mockResolvedValue({
      success: false,
      output: '',
      error: 'agent failed',
      durationMs: 100,
    })

    const response = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agt_1' }),
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ error: 'agent failed' })
  })

  it('stream lifecycle failure emits an error event', async () => {
    const runAndAgent = {
      id: 'run_1',
      intent: 'task',
      status: 'active',
      initiatorAgentId: 'agt_1',
      type: 'cursor',
      name: 'A',
      config: {},
    }
    mockDb.select.mockReturnValue(makeSelectChain(runAndAgent))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockRunWithLifecycle.mockResolvedValue({
      success: false,
      error: 'stream worker crashed',
      durationMs: 100,
    })

    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, agentId: 'agt_1' }),
    })
    expect(await res.text()).toContain('stream worker crashed')
  })

  it('emits error SSE event when worker returns success=false in stream mode', async () => {
    const rowForRunAndAgent = {
      id: 'run_1',
      intent: 'Fix the bug',
      status: 'active',
      initiatorAgentId: 'agt_1',
      type: 'cursor',
      name: 'A',
      config: {},
    }
    mockDb.select.mockReturnValue(makeSelectChain(rowForRunAndAgent))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockRunWithLifecycle.mockResolvedValue({
      success: false,
      output: '',
      error: 'boom',
      durationMs: 12,
    })

    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, agentId: 'agt_1' }),
    })
    const text = await res.text()
    expect(text).toContain('event: error')
  })
})

const mockExecuteChatRun = executeChatRun as unknown as Mock

const ORIGINAL_RUN = {
  id: 'run_1',
  intent: 'Fix the bug',
  status: 'completed',
  result: { output: 'Done' },
  initiatorAgentId: 'agt_1',
  triggerSource: 'api' as string | null,
  triggerUserName: 'Alice' as string | null,
  triggerAgentName: 'Router Agent' as string | null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
}

const FIRST_STEP = {
  id: 'rst_1',
  agentId: 'agt_1',
  input: { message: 'Fix the bug', context: { key: 'value' } },
}

const ACTIVE_AGENT = {
  id: 'agt_1',
  name: 'Test Agent',
  status: 'active',
  type: 'cursor',
}

describe('POST /runs/:id/rerun', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../runs.js')
    // Mount onError + an admin identity: rerun now runs through requireAgentWrite,
    // whose typed errors need the global handler, and admin resolves to 'owner'
    // in one agent lookup — keeping these tests focused on rerun's own branches.
    app = new Hono()
    app.onError((err, c) => {
      const anyErr = err as { statusCode?: number; message?: string; code?: string }
      if (typeof anyErr.statusCode === 'number') {
        return c.json({ error: anyErr.message, code: anyErr.code }, anyErr.statusCode as never)
      }
      return c.json({ error: 'Internal Server Error' }, 500)
    })
    app.use('*', async (c, next) => {
      c.set('userRole' as never, 'admin')
      c.set('userId' as never, 'usr_admin')
      await next()
    })
    app.route('/runs', mod.default)
  })

  it('returns 404 when run does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(undefined))

    const res = await app.request('/runs/run_nonexistent/rerun', { method: 'POST' })
    expect(res.status).toBe(404)

    const json = (await res.json()) as Json
    expect(json.error).toBe('Run not found')
  })

  it('returns 400 when agent cannot be determined', async () => {
    const runWithoutAgent = { ...ORIGINAL_RUN, initiatorAgentId: null }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(runWithoutAgent)) // run
      .mockReturnValueOnce(makeSelectChain(undefined)) // first step (no agentId)

    const res = await app.request('/runs/run_1/rerun', { method: 'POST' })
    expect(res.status).toBe(400)

    const json = (await res.json()) as Json
    expect(json.error).toBe('Cannot determine agent for rerun')
  })

  it('returns 404 when agent does not exist', async () => {
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(ORIGINAL_RUN)) // run
      .mockReturnValueOnce(makeSelectChain(FIRST_STEP)) // first step
      .mockReturnValueOnce(makeSelectChain(undefined)) // agent not found

    const res = await app.request('/runs/run_1/rerun', { method: 'POST' })
    expect(res.status).toBe(404)

    const json = (await res.json()) as Json
    expect(json.error).toBe('Agent not found')
  })

  it('returns 400 when agent is not active', async () => {
    const stoppedAgent = { ...ACTIVE_AGENT, status: 'stopped' }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(ORIGINAL_RUN)) // run
      .mockReturnValueOnce(makeSelectChain(FIRST_STEP)) // first step
      .mockReturnValueOnce(makeSelectChain(stoppedAgent)) // agent

    const res = await app.request('/runs/run_1/rerun', { method: 'POST' })
    expect(res.status).toBe(400)

    const json = (await res.json()) as Json
    expect(json.error as string).toContain('not active')
  })

  it('creates a new run and calls executeChatRun with original context', async () => {
    const newRun = { id: 'run_new1', intent: 'Fix the bug', status: 'pending' }
    const insertChain = makeInsertChain(newRun)
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(ORIGINAL_RUN))
      .mockReturnValueOnce(makeSelectChain(FIRST_STEP))
      .mockReturnValueOnce(makeSelectChain(ACTIVE_AGENT))
    mockDb.insert.mockReturnValue(insertChain)

    const res = await app.request('/runs/run_1/rerun', { method: 'POST' })
    expect(res.status).toBe(201)

    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.id).toBe('run_new1')
    expect(mockExecuteChatRun).toHaveBeenCalledWith('agt_1', expect.any(String), { key: 'value' })

    // Reruns preserve the original visible caller provenance so the new row
    // remains attributable in the same way as the source run.
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerUserName: 'Alice',
        triggerAgentName: 'Router Agent',
      }),
    )
  })

  it('queues a rerun through the shared concurrency limiter', async () => {
    mockTryAcquireSlot.mockReturnValueOnce('queued')
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(ORIGINAL_RUN))
      .mockReturnValueOnce(makeSelectChain(FIRST_STEP))
      .mockReturnValueOnce(makeSelectChain(ACTIVE_AGENT))
    mockDb.insert.mockReturnValue(
      makeInsertChain({ id: 'run_new', intent: 'Fix the bug', status: 'pending' }),
    )

    const res = await app.request('/runs/run_1/rerun', { method: 'POST' })

    expect(res.status).toBe(202)
    expect(mockExecuteChatRun).not.toHaveBeenCalled()
    expect(mockRegisterPendingContext).toHaveBeenCalledWith(expect.any(String), { key: 'value' })
  })

  it('enriches Feishu context with receive_id when triggerSource is feishu', async () => {
    const feishuRun = { ...ORIGINAL_RUN, triggerSource: 'feishu' }
    const feishuStep = {
      ...FIRST_STEP,
      input: { message: 'Fix the bug', context: { chat_id: 'chat_123', sender_id: 'user_1' } },
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(feishuRun))
      .mockReturnValueOnce(makeSelectChain(feishuStep))
      .mockReturnValueOnce(makeSelectChain(ACTIVE_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain({ id: 'run_new', intent: 'Fix the bug' }))

    await app.request('/runs/run_1/rerun', { method: 'POST' })

    expect(mockExecuteChatRun).toHaveBeenCalledWith('agt_1', expect.any(String), {
      chat_id: 'chat_123',
      sender_id: 'user_1',
      receive_id_type: 'chat_id',
      receive_id: 'chat_123',
    })
  })

  it('does not overwrite receive_id_type when already present in Feishu context', async () => {
    const feishuRun = { ...ORIGINAL_RUN, triggerSource: 'feishu' }
    const feishuStep = {
      ...FIRST_STEP,
      input: {
        message: 'Fix the bug',
        context: { chat_id: 'chat_123', receive_id_type: 'open_id', receive_id: 'user_456' },
      },
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(feishuRun))
      .mockReturnValueOnce(makeSelectChain(feishuStep))
      .mockReturnValueOnce(makeSelectChain(ACTIVE_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain({ id: 'run_new', intent: 'Fix the bug' }))

    await app.request('/runs/run_1/rerun', { method: 'POST' })

    expect(mockExecuteChatRun).toHaveBeenCalledWith('agt_1', expect.any(String), {
      chat_id: 'chat_123',
      receive_id_type: 'open_id',
      receive_id: 'user_456',
    })
  })

  it('passes undefined context when step has no context field', async () => {
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(ORIGINAL_RUN)) // run
      .mockReturnValueOnce(makeSelectChain({ agentId: 'agt_1', input: {} })) // step without context
      .mockReturnValueOnce(makeSelectChain(ACTIVE_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain({ id: 'run_new', intent: 'Fix the bug' }))

    await app.request('/runs/run_1/rerun', { method: 'POST' })

    expect(mockExecuteChatRun).toHaveBeenCalledWith('agt_1', expect.any(String), undefined)
  })

  it('rerun keeps external-uri step attachments (A2A uri ref 重放，review 回归)', async () => {
    // A2A 外部 uri 附件的审计 ref 无 token 但有 uri——materializer 能按 uri 重新抓取。
    // 修复前 token-only 过滤把它静默丢掉（带 URL 附件的 run 重跑变纯文本）。
    const a2aRun = { ...ORIGINAL_RUN, triggerSource: 'a2a' }
    const stepWithUriRef = {
      agentId: 'agt_1',
      input: {
        message: 'turn 1',
        context: { key: 'value' },
        attachments: [
          { uri: 'https://example.com/pic.png', name: 'pic.png', mimeType: 'image/png' },
          { name: 'inline-bytes.bin', mimeType: 'application/octet-stream' }, // 无 token 无 uri → 仍丢
        ],
      },
    }
    const insertChain = makeInsertChain({ id: 'run_new', intent: 'Fix the bug' })
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(a2aRun))
      .mockReturnValueOnce(makeSelectChain(stepWithUriRef))
      .mockReturnValueOnce(makeSelectChain(ACTIVE_AGENT))
    mockDb.insert.mockReturnValue(insertChain)

    await app.request('/runs/run_1/rerun', { method: 'POST' })

    const values = insertChain.values.mock.calls[0]?.[0] as {
      executionMetadata?: { attachments?: Array<Record<string, unknown>> }
    }
    expect(values.executionMetadata?.attachments).toEqual([
      { uri: 'https://example.com/pic.png', name: 'pic.png', mimeType: 'image/png' },
    ])
  })

  it('carries executed-turn step attachments forward when no queued turn is pending', async () => {
    // Baseline: 已执行轮的 step 带附件、run 行无 queuedTurn marker → 以 step 附件为准。
    const debugRun = { ...ORIGINAL_RUN, triggerSource: 'debug', userId: 'usr_1' }
    const stepWithA = {
      agentId: 'agt_1',
      input: {
        message: 'turn 1',
        context: { key: 'value' },
        attachments: [{ token: 'tok_A', name: 'a.png', mimeType: 'image/png' }],
      },
    }
    const insertChain = makeInsertChain({ id: 'run_new', intent: 'Fix the bug' })
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(debugRun))
      .mockReturnValueOnce(makeSelectChain(stepWithA))
      .mockReturnValueOnce(makeSelectChain(ACTIVE_AGENT))
    mockDb.insert.mockReturnValue(insertChain)

    await app.request('/runs/run_1/rerun', { method: 'POST' })

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMetadata: expect.objectContaining({
          attachments: [{ token: 'tok_A', name: 'a.png', mimeType: 'image/png' }],
        }),
      }),
    )
  })

  it('rerun uses the queued turn attachments, not the stale prior-turn step (regression)', async () => {
    // 多轮会话：第 1 轮 step 带附件 A；第 2 轮排队带附件 B 但被取消（从未落 step）。
    // 此时 run.intent=第2轮、executionMetadata={queuedTurn, attachments:[B]}，最新 step 仍是第1轮。
    // rerun 必须带第 2 轮的 B，而不是旧 step 的 A。
    const queuedThenCancelledRun = {
      ...ORIGINAL_RUN,
      triggerSource: 'debug',
      userId: 'usr_1',
      status: 'cancelled',
      intent: 'turn 2 text',
      executionMetadata: {
        queuedTurn: true,
        attachments: [{ token: 'tok_B', name: 'b.png', mimeType: 'image/png' }],
        attachmentConsumerId: 'usr_1',
      },
    }
    const priorTurnStepWithA = {
      agentId: 'agt_1',
      input: {
        message: 'turn 1 text',
        context: { key: 'value' },
        attachments: [{ token: 'tok_A', name: 'a.png', mimeType: 'image/png' }],
      },
    }
    const insertChain = makeInsertChain({ id: 'run_new', intent: 'turn 2 text' })
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(queuedThenCancelledRun))
      .mockReturnValueOnce(makeSelectChain(priorTurnStepWithA))
      .mockReturnValueOnce(makeSelectChain(ACTIVE_AGENT))
    mockDb.insert.mockReturnValue(insertChain)

    await app.request('/runs/run_1/rerun', { method: 'POST' })

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'turn 2 text',
        executionMetadata: expect.objectContaining({
          attachments: [{ token: 'tok_B', name: 'b.png', mimeType: 'image/png' }],
        }),
      }),
    )
    // 绝不带旧轮附件 A。
    const values = insertChain.values.mock.calls[0]?.[0] as {
      executionMetadata?: { attachments?: Array<{ token: string }> }
    }
    const tokens = values.executionMetadata?.attachments?.map((a) => a.token) ?? []
    expect(tokens).not.toContain('tok_A')
  })

  /**
   * A rerun carries `triggerSource` forward, so a chat_app run re-executes as
   * chat_app — bypassing the per-turn gates the chat endpoint applies. These two
   * cases pin the re-check against the Agent's *current* config: revoking the
   * channel or switching attachments off is a withdrawal of consent, and a
   * replay must not undo it.
   */
  it('refuses to rerun a chat_app run once the channel is revoked', async () => {
    const chatAppRun = {
      ...ORIGINAL_RUN,
      triggerSource: 'chat_app',
      userId: 'usr_1',
      status: 'completed',
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(chatAppRun))
      .mockReturnValueOnce(makeSelectChain({ agentId: 'agt_1', input: { message: 'hi' } }))
      .mockReturnValueOnce(
        makeSelectChain({ ...ACTIVE_AGENT, publishChannels: ['api'], publishStatus: 'published' }),
      )
    const insertChain = makeInsertChain({ id: 'run_new' })
    mockDb.insert.mockReturnValue(insertChain)

    const res = await app.request('/runs/run_1/rerun', { method: 'POST' })

    expect(res.status).toBe(400)
    expect(insertChain.values).not.toHaveBeenCalled()
  })

  it('drops chat_app attachments when the Agent no longer allows them', async () => {
    const chatAppRun = {
      ...ORIGINAL_RUN,
      triggerSource: 'chat_app',
      userId: 'usr_1',
      status: 'completed',
      executionMetadata: {
        attachments: [{ token: 'tok_secret', name: 'payroll.pdf', mimeType: 'application/pdf' }],
        attachmentConsumerId: 'usr_1',
      },
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(chatAppRun))
      .mockReturnValueOnce(makeSelectChain({ agentId: 'agt_1', input: { message: 'hi' } }))
      .mockReturnValueOnce(
        makeSelectChain({
          ...ACTIVE_AGENT,
          publishChannels: ['chat_app'],
          publishStatus: 'published',
          chatAppConfig: { allowAttachments: false },
        }),
      )
    const insertChain = makeInsertChain({ id: 'run_new' })
    mockDb.insert.mockReturnValue(insertChain)

    await app.request('/runs/run_1/rerun', { method: 'POST' })

    const values = insertChain.values.mock.calls[0]?.[0] as {
      executionMetadata?: { attachments?: unknown[] }
    }
    expect(values.executionMetadata?.attachments ?? []).toEqual([])
    expect(JSON.stringify(values)).not.toContain('tok_secret')
  })

  it('rerun of a no-attachment queued turn does not replay the prior-turn attachments (regression)', async () => {
    // 子场景：第 2 轮不带附件排队后取消。executionMetadata 只有 queuedTurn marker（无 attachments）。
    // rerun 必须是纯文本，绝不重放第 1 轮 step 的附件 A。
    const queuedNoAttachRun = {
      ...ORIGINAL_RUN,
      triggerSource: 'debug',
      userId: 'usr_1',
      status: 'cancelled',
      intent: 'turn 2 text (no attachment)',
      executionMetadata: { queuedTurn: true },
    }
    const priorTurnStepWithA = {
      agentId: 'agt_1',
      input: {
        message: 'turn 1 text',
        context: { key: 'value' },
        attachments: [{ token: 'tok_A', name: 'a.png', mimeType: 'image/png' }],
      },
    }
    const insertChain = makeInsertChain({ id: 'run_new', intent: 'turn 2 text (no attachment)' })
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(queuedNoAttachRun))
      .mockReturnValueOnce(makeSelectChain(priorTurnStepWithA))
      .mockReturnValueOnce(makeSelectChain(ACTIVE_AGENT))
    mockDb.insert.mockReturnValue(insertChain)

    await app.request('/runs/run_1/rerun', { method: 'POST' })

    // 无附件 → insert 不应带任何 executionMetadata.attachments。
    const values = insertChain.values.mock.calls[0]?.[0] as {
      executionMetadata?: { attachments?: unknown[] }
    }
    expect(values.executionMetadata?.attachments ?? []).toEqual([])
  })
})

describe('resolveRerunConsumerId (rerun 附件消费者身份复原)', () => {
  const baseRun = (overrides: Record<string, unknown>) =>
    ({
      id: 'run_x',
      triggerSource: 'oauth',
      userId: null,
      executionMetadata: null,
      ...overrides,
    }) as unknown as typeof runs.$inferSelect

  it('优先用持久化的 attachmentConsumerId', async () => {
    const { resolveRerunConsumerId } = await import('../runs.js')
    const run = baseRun({
      triggerSource: 'oauth',
      executionMetadata: { attachmentConsumerId: 'oauth:iss:sub-1' },
    })
    expect(resolveRerunConsumerId(run, 'agt_1', undefined)).toBe('oauth:iss:sub-1')
  })

  it('OAuth run 无持久化时从 channel context 复原 oauth:<issuer>:<sub>', async () => {
    const { resolveRerunConsumerId } = await import('../runs.js')
    const run = baseRun({ triggerSource: 'oauth', executionMetadata: null })
    const ctx = {
      channel: { channel_type: 'oauth', channel_info: { oauth: { issuer: 'iss', sub: 'sub-2' } } },
    }
    // 关键：绝不退回 agent:<id>（那会与真实 uploaderId 不符、附件被丢，review [P1]）。
    expect(resolveRerunConsumerId(run, 'agt_1', ctx)).toBe('oauth:iss:sub-2')
  })

  it('OAuth run 既无持久化也无 context → undefined（调用方据此丢附件而非用错身份）', async () => {
    const { resolveRerunConsumerId } = await import('../runs.js')
    const run = baseRun({ triggerSource: 'oauth', executionMetadata: null })
    expect(resolveRerunConsumerId(run, 'agt_1', undefined)).toBeUndefined()
  })

  it('debug run → 原 run 的 userId', async () => {
    const { resolveRerunConsumerId } = await import('../runs.js')
    const run = baseRun({ triggerSource: 'debug', userId: 'usr_9', executionMetadata: null })
    expect(resolveRerunConsumerId(run, 'agt_1', undefined)).toBe('usr_9')
  })

  // 对话网页与调试同为登录态入口：附件由登录用户暂存，rerun 必须仍以该用户消费，
  // 否则落到 agent:<id> 分支、与 uploaderId 不符导致附件被静默丢弃。
  it('chat_app run → 原 run 的 userId（不得退回 agent:<id>）', async () => {
    const { resolveRerunConsumerId } = await import('../runs.js')
    const run = baseRun({ triggerSource: 'chat_app', userId: 'usr_9', executionMetadata: null })
    expect(resolveRerunConsumerId(run, 'agt_1', undefined)).toBe('usr_9')
  })

  it('gateway(api_key)/a2a run → agent:<id>', async () => {
    const { resolveRerunConsumerId } = await import('../runs.js')
    const run = baseRun({ triggerSource: 'a2a', executionMetadata: null })
    expect(resolveRerunConsumerId(run, 'agt_1', undefined)).toBe('agent:agt_1')
  })

  it('OAuth 鉴权的 A2A run → 从 channel context 复原 oauth:<issuer>:<sub>（review [P1] 连带）', async () => {
    // OAuth-A2A 的附件 uploaderId=oauth:<iss>:<sub>（OAuth 上传端点）；rerun 若退回
    // agent:<id>，消费鉴权拒绝、附件静默丢——与 A2A materialize 硬编码是同一根因。
    const { resolveRerunConsumerId } = await import('../runs.js')
    const run = baseRun({ triggerSource: 'a2a', executionMetadata: null })
    const ctx = {
      channel: {
        channel_type: 'a2a',
        channel_info: { auth: 'oauth', oauth: { issuer: 'iss', sub: 'sub-7' } },
      },
    }
    expect(resolveRerunConsumerId(run, 'agt_1', ctx)).toBe('oauth:iss:sub-7')
  })

  it('多跳转发的 A2A run（auth=api_key 带 upstream oauth 审计元数据）→ 仍用 agent:<id>', async () => {
    // isTrustedHop 场景：channel_info.oauth 记录的是 **upstream** 的 oauth 身份（审计链），
    // 当前 hop 鉴权是 api_key、附件经 gateway 上传端点 uploaderId=agent:<id>。
    // 若误按 oauth 元数据推 consumerId 会反向修出新 bug。
    const { resolveRerunConsumerId } = await import('../runs.js')
    const run = baseRun({ triggerSource: 'a2a', executionMetadata: null })
    const ctx = {
      channel: {
        channel_type: 'a2a',
        channel_info: { auth: 'api_key', oauth: { issuer: 'iss-up', sub: 'sub-up' } },
      },
    }
    expect(resolveRerunConsumerId(run, 'agt_1', ctx)).toBe('agent:agt_1')
  })
})

// ============================================================================
// P0-3 regression: execute/rerun must enforce agent write permission.
//
// Before the fix, `POST /runs/:id/execute` and `/rerun` resolved the target
// agent with a bare `eq(agents.id, agentId)` and NO permission check — the
// `ownerFilter` only scoped the *run*, which the caller created themselves.
// A non-admin could therefore execute ANY agent in the instance (with its
// credentials, skills and SCM workspace) by pointing execute at a foreign
// agentId. These tests drive the REAL agent-access helper so the assertion is
// about actual permission SQL semantics, not a mock echo.
// ============================================================================
describe('POST /runs/:id/execute — agent permission (P0-3)', () => {
  async function makeAppAsRole(role: 'admin' | 'user', userId: string): Promise<Hono> {
    const mod = await import('../runs.js')
    const app = new Hono()
    app.onError((err, c) => {
      const anyErr = err as { statusCode?: number; message?: string; code?: string }
      if (typeof anyErr.statusCode === 'number') {
        return c.json({ error: anyErr.message, code: anyErr.code }, anyErr.statusCode as never)
      }
      return c.json({ error: 'Internal Server Error' }, 500)
    })
    app.use('*', async (c, next) => {
      c.set('userRole' as never, role)
      c.set('userId' as never, userId)
      await next()
    })
    app.route('/runs', mod.default)
    return app
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRunReadFilter.mockReturnValue(undefined)
    mockRunWithLifecycle.mockReset()
  })

  it('non-admin caller executing a foreign agent → 404, does not execute', async () => {
    // The caller's own agent-less run — canMutateRun passes on the run itself,
    // so the assertion isolates the *target agent* check.
    const pendingRun = {
      id: 'run_1',
      status: 'pending',
      userId: 'usr_attacker',
      initiatorAgentId: null,
      config: {},
    }
    const foreignAgent = {
      id: 'agt_victim',
      userId: 'usr_owner',
      status: 'active',
      type: 'cursor',
      name: 'Victim',
      config: {},
    }
    // 1st select → run lookup; 2nd → agent-access loads the agent;
    // 3rd → membership lookup returns nothing (caller is a stranger).
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(pendingRun))
      .mockReturnValueOnce(makeSelectChain(foreignAgent))
      .mockReturnValueOnce(makeSelectChain(undefined))
    mockDb.select.mockReturnValue(makeSelectChain([]))

    const app = await makeAppAsRole('user', 'usr_attacker')
    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agt_victim' }),
    })

    expect(res.status).toBe(404)
    expect(mockRunWithLifecycle).not.toHaveBeenCalled()
  })

  it('viewer member executing an agent → 403, does not execute', async () => {
    const pendingRun = {
      id: 'run_1',
      status: 'pending',
      userId: 'usr_viewer',
      initiatorAgentId: null,
      config: {},
    }
    const foreignAgent = {
      id: 'agt_shared',
      userId: 'usr_owner',
      status: 'active',
      type: 'cursor',
      name: 'Shared',
      config: {},
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(pendingRun))
      .mockReturnValueOnce(makeSelectChain(foreignAgent))
      .mockReturnValueOnce(makeSelectChain({ role: 'viewer' }))
    mockDb.select.mockReturnValue(makeSelectChain([]))

    const app = await makeAppAsRole('user', 'usr_viewer')
    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agt_shared' }),
    })

    expect(res.status).toBe(403)
    expect(mockRunWithLifecycle).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Cancel authorization.
//
// Run READ visibility is derived from agent permission (getRunReadFilter), which
// is deliberately broader than cancel: a viewer member can list an agent's runs
// but must not be able to kill runs other people started — while still being
// able to stop the debug run they started themselves. These tests drive the REAL
// agent-access helpers so they assert actual permission semantics.
// ============================================================================
describe('POST /runs/:id/cancel — cancel authorization', () => {
  async function makeAppAsRole(role: 'admin' | 'user', userId: string): Promise<Hono> {
    const mod = await import('../runs.js')
    mockGetCurrentUserId.mockReturnValue(userId)
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userRole' as never, role)
      c.set('userId' as never, userId)
      await next()
    })
    app.route('/runs', mod.default)
    return app
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRunReadFilter.mockReturnValue(undefined)
    mockDb.update.mockReturnValue(makeUpdateChain())
  })

  // Restore the file-wide default so this suite's identity does not leak.
  afterEach(() => mockGetCurrentUserId.mockReturnValue(undefined))

  it('viewer member cannot cancel a run someone else triggered → 403', async () => {
    const run = {
      ...SAMPLE_RUN,
      status: 'queued',
      userId: 'usr_someone',
      initiatorAgentId: 'agt_shared',
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(run)) // 1. load run
      .mockReturnValueOnce(makeSelectChain({ id: 'agt_shared', userId: 'usr_owner' })) // 2. agent
      .mockReturnValueOnce(makeSelectChain({ role: 'viewer' })) // 3. membership

    const app = await makeAppAsRole('user', 'usr_viewer')
    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })

    expect(res.status).toBe(403)
    expect(scheduleNext).not.toHaveBeenCalled()
  })

  it('viewer member CAN cancel the debug run they triggered themselves', async () => {
    // `viewer can read + chat debug` — they must stay able to stop their own run.
    const run = {
      ...SAMPLE_RUN,
      status: 'queued',
      userId: 'usr_viewer',
      initiatorAgentId: 'agt_shared',
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(run)) // 1. load run
      .mockReturnValueOnce(makeSelectChain({ status: 'queued' })) // 2. re-read status

    const app = await makeAppAsRole('user', 'usr_viewer')
    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })

    expect(res.status).toBe(200)
    // Ownership of the run short-circuits before any membership lookup.
    expect(mockDb.select).toHaveBeenCalledTimes(2)
  })

  it('editor member can cancel a run someone else triggered', async () => {
    const run = {
      ...SAMPLE_RUN,
      status: 'queued',
      userId: 'usr_someone',
      initiatorAgentId: 'agt_shared',
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(run)) // 1. load run
      .mockReturnValueOnce(makeSelectChain({ id: 'agt_shared', userId: 'usr_owner' })) // 2. agent
      .mockReturnValueOnce(makeSelectChain({ role: 'editor' })) // 3. membership
      .mockReturnValueOnce(makeSelectChain({ status: 'queued' })) // 4. re-read status

    const app = await makeAppAsRole('user', 'usr_editor')
    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })

    expect(res.status).toBe(200)
  })

  it('agent owner can cancel a channel run that carries no trigger identity', async () => {
    // Feishu / gateway / OAuth runs have runs.user_id = NULL — authorization has
    // to come from the agent, not from the run's (absent) trigger identity.
    const run = { ...SAMPLE_RUN, status: 'queued', userId: null, initiatorAgentId: 'agt_mine' }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(run)) // 1. load run
      .mockReturnValueOnce(makeSelectChain({ id: 'agt_mine', userId: 'usr_alice' })) // 2. agent
      .mockReturnValueOnce(makeSelectChain({ status: 'queued' })) // 3. re-read status

    const app = await makeAppAsRole('user', 'usr_alice')
    const res = await app.request('/runs/run_1/cancel', { method: 'POST' })

    expect(res.status).toBe(200)
  })
})

// ============================================================================
// Cross-agent execute hijack.
//
// getRunReadFilter lets a viewer *see* runs of a shared agent, but execute
// MUTATES the source run (status CAS pending/queued → running, plus a new step
// attributed to the target agent) while `agentId` is overridable by the request
// body. Authorizing only the target agent therefore let a viewer of agent A
// hijack A's queued run by pointing execute at an agent B they own.
// ============================================================================
describe('POST /runs/:id/execute — source-run write permission', () => {
  async function makeAppAsRole(role: 'admin' | 'user', userId: string): Promise<Hono> {
    const mod = await import('../runs.js')
    mockGetCurrentUserId.mockReturnValue(userId)
    const app = new Hono()
    app.onError((err, c) => {
      const anyErr = err as { statusCode?: number; message?: string; code?: string }
      if (typeof anyErr.statusCode === 'number') {
        return c.json({ error: anyErr.message, code: anyErr.code }, anyErr.statusCode as never)
      }
      return c.json({ error: 'Internal Server Error' }, 500)
    })
    app.use('*', async (c, next) => {
      c.set('userRole' as never, role)
      c.set('userId' as never, userId)
      await next()
    })
    app.route('/runs', mod.default)
    return app
  }

  const ownedAgent = {
    id: 'agt_owned',
    userId: 'usr_viewer',
    status: 'active',
    type: 'cursor',
    name: 'Owned by the caller',
    config: {},
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRunReadFilter.mockReturnValue(undefined)
    mockRunWithLifecycle.mockReset()
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockDb.insert.mockReturnValue(makeInsertChain())
  })

  afterEach(() => mockGetCurrentUserId.mockReturnValue(undefined))

  it('viewer of the run’s agent cannot execute it through an agent they own', async () => {
    await selectByBoundId({
      // Someone else's queued run on an agent where the caller is only a viewer.
      run: {
        id: 'run_1',
        status: 'queued',
        userId: 'usr_someone',
        initiatorAgentId: 'agt_shared',
        intent: 'do the thing',
        config: {},
      },
      agents: { agt_shared: { id: 'agt_shared', userId: 'usr_owner' }, agt_owned: ownedAgent },
      members: { agt_shared: { role: 'viewer' } },
    })

    const app = await makeAppAsRole('user', 'usr_viewer')
    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The hijack vector: an agent the caller legitimately owns, so the target
      // agent check alone would pass.
      body: JSON.stringify({ agentId: 'agt_owned' }),
    })

    expect(res.status).toBe(403)
    expect(mockRunWithLifecycle).not.toHaveBeenCalled()
    // The source run must not be transitioned out of `queued`.
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('editor of the run’s agent may execute it', async () => {
    await selectByBoundId({
      run: {
        id: 'run_1',
        status: 'queued',
        userId: 'usr_someone',
        initiatorAgentId: 'agt_shared',
        intent: 'do the thing',
        config: {},
      },
      agents: {
        agt_shared: {
          id: 'agt_shared',
          userId: 'usr_owner',
          status: 'active',
          type: 'cursor',
          name: 'Shared',
          config: {},
        },
      },
      members: { agt_shared: { role: 'editor' } },
    })
    mockRunWithLifecycle.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 })

    const app = await makeAppAsRole('user', 'usr_editor')
    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    expect(mockRunWithLifecycle).toHaveBeenCalled()
  })

  it('the run’s own trigger may still execute it on an agent they own', async () => {
    // The legitimate REST/CLI flow: POST /runs (no initiatorAgentId) then execute.
    await selectByBoundId({
      run: {
        id: 'run_1',
        status: 'pending',
        userId: 'usr_alice',
        initiatorAgentId: null,
        intent: 'do the thing',
        config: {},
      },
      agents: { agt_owned: { ...ownedAgent, userId: 'usr_alice' } },
      members: {},
    })
    mockRunWithLifecycle.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 })

    const app = await makeAppAsRole('user', 'usr_alice')
    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agt_owned' }),
    })

    expect(res.status).toBe(200)
    expect(mockRunWithLifecycle).toHaveBeenCalled()
  })
})

// ============================================================================
// Visibility-filter wiring.
//
// agent-access.test.ts proves the predicate is CORRECT; nothing proved it is
// APPLIED. A mutation check showed the gap: stripping getRunReadFilter from
// every read route left the whole suite green except the one leaderboard test
// that happened to assert its where-argument — i.e. a refactor could expose
// every run in the instance to every authenticated user without a red test.
//
// These cases render each route's actual WHERE clause and look for a sentinel
// fragment, so they fail if any single route drops the filter.
// ============================================================================
describe('read routes apply the visibility filter', () => {
  const SENTINEL_MARKER = '__visibility_sentinel__'
  const SENTINEL = sql`${sql.raw(SENTINEL_MARKER)} = 1`

  /** Chain that records every `.where()` argument and tolerates any builder shape. */
  function makeCapturingChain(result: unknown) {
    const wheres: unknown[] = []
    const chain: Record<string, unknown> = {}
    for (const key of [
      'from',
      'leftJoin',
      'innerJoin',
      'orderBy',
      'groupBy',
      'having',
      'limit',
      'offset',
    ]) {
      // Return the awaitable node, not the bare literal: a query may terminate
      // at any of these (e.g. `.groupBy()` on the stats aggregate), and only the
      // wrapped node resolves to a row array.
      chain[key] = vi.fn(() => awaitable)
    }
    chain.where = vi.fn((cond: unknown) => {
      wheres.push(cond)
      return awaitable
    })
    chain.get = vi.fn(() => (Array.isArray(result) ? result[0] : result))
    chain.all = vi.fn(() => (Array.isArray(result) ? result : result ? [result] : []))
    // One shared node so every step keeps accumulating into the same `wheres`.
    const awaitable = asyncQuery(chain)
    return { chain: awaitable, wheres }
  }

  async function assertEveryWhereIsScoped(wheres: unknown[], expectedCount: number) {
    const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
    const dialect = new SQLiteSyncDialect()
    expect(wheres.length).toBe(expectedCount)
    for (const [index, cond] of wheres.entries()) {
      expect(dialect.sqlToQuery(cond as never).sql, `where clause #${index + 1}`).toContain(
        SENTINEL_MARKER,
      )
    }
  }

  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockGetRunReadFilter.mockReturnValue(SENTINEL as never)
    const mod = await import('../runs.js')
    app = new Hono().route('/runs', mod.default)
  })

  afterEach(() => mockGetRunReadFilter.mockReturnValue(undefined))

  it('GET /runs scopes both the count and the page query', async () => {
    const { chain, wheres } = makeCapturingChain([])
    mockDb.select.mockReturnValue(chain)

    const res = await app.request('/runs')
    expect(res.status).toBe(200)
    await assertEveryWhereIsScoped(wheres, 2)
  })

  it('GET /runs/stats scopes every aggregate', async () => {
    const { chain, wheres } = makeCapturingChain([])
    mockDb.select.mockReturnValue(chain)

    const res = await app.request('/runs/stats')
    expect(res.status).toBe(200)
    // Eight aggregates: status counts, today count, today status counts, avg
    // duration, askers, today askers, token totals, today token totals.
    await assertEveryWhereIsScoped(wheres, 8)
  })

  it.each([
    ['GET /runs/:id', '/runs/run_1'],
    ['GET /runs/:id/logs', '/runs/run_1/logs'],
    ['GET /runs/:id/logs/download', '/runs/run_1/logs/download'],
  ])('%s scopes the run lookup', async (_label, path) => {
    // Return no row: the lookup's WHERE is what matters, and a 404 keeps the
    // assertion independent of each route's downstream queries.
    const { chain, wheres } = makeCapturingChain(undefined)
    mockDb.select.mockReturnValue(chain)

    await app.request(path)
    await assertEveryWhereIsScoped(wheres, 1)
  })

  it.each([
    ['POST /runs/:id/execute', '/runs/run_1/execute'],
    ['POST /runs/:id/rerun', '/runs/run_1/rerun'],
    ['POST /runs/:id/cancel', '/runs/run_1/cancel'],
  ])('%s scopes the run lookup too', async (_label, path) => {
    const { chain, wheres } = makeCapturingChain(undefined)
    mockDb.select.mockReturnValue(chain)

    await app.request(path, { method: 'POST' })
    await assertEveryWhereIsScoped(wheres, 1)
  })
})

// ============================================================================
// Rerun source-run permission.
//
// rerun resolves its target agent from the run's LATEST STEP, which diverges
// from runs.initiator_agent_id only when a prior execute used the `agentId`
// override. In that corner, authorizing the step's agent alone let a viewer of
// the run's own agent replay that run — carrying its channel context, so the
// replay posts back into the original agent's Feishu chat.
// ============================================================================
describe('POST /runs/:id/rerun — source-run write permission', () => {
  async function makeAppAsRole(role: 'admin' | 'user', userId: string): Promise<Hono> {
    const mod = await import('../runs.js')
    mockGetCurrentUserId.mockReturnValue(userId)
    const app = new Hono()
    app.onError((err, c) => {
      const anyErr = err as { statusCode?: number; message?: string; code?: string }
      if (typeof anyErr.statusCode === 'number') {
        return c.json({ error: anyErr.message, code: anyErr.code }, anyErr.statusCode as never)
      }
      return c.json({ error: 'Internal Server Error' }, 500)
    })
    app.use('*', async (c, next) => {
      c.set('userRole' as never, role)
      c.set('userId' as never, userId)
      await next()
    })
    app.route('/runs', mod.default)
    return app
  }

  const feishuRun = {
    id: 'run_1',
    status: 'completed',
    userId: 'usr_someone',
    initiatorAgentId: 'agt_shared',
    triggerSource: 'feishu',
    intent: 'do the thing',
    executionMetadata: null,
    config: {},
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRunReadFilter.mockReturnValue(undefined)
    mockDb.insert.mockReturnValue(makeInsertChain())
  })

  afterEach(() => mockGetCurrentUserId.mockReturnValue(undefined))

  it('viewer of the run’s agent cannot rerun it via the step’s agent', async () => {
    await selectByBoundId({
      run: feishuRun,
      // A prior execute override left the latest step on a different agent.
      step: { agentId: 'agt_owned', input: { context: { chat_id: 'oc_shared' } } },
      agents: {
        agt_shared: { id: 'agt_shared', userId: 'usr_owner' },
        agt_owned: {
          id: 'agt_owned',
          userId: 'usr_viewer',
          status: 'active',
          name: 'Owned',
          maxConcurrency: 1,
        },
      },
      members: { agt_shared: { role: 'viewer' } },
    })

    const app = await makeAppAsRole('user', 'usr_viewer')
    const res = await app.request('/runs/run_1/rerun', { method: 'POST' })

    expect(res.status).toBe(403)
    expect(mockDb.insert).not.toHaveBeenCalled()
    expect(executeChatRun).not.toHaveBeenCalled()
  })

  it('editor of the run’s agent may rerun it', async () => {
    await selectByBoundId({
      run: feishuRun,
      step: { agentId: 'agt_shared', input: { context: { chat_id: 'oc_shared' } } },
      agents: {
        agt_shared: {
          id: 'agt_shared',
          userId: 'usr_owner',
          status: 'active',
          name: 'Shared',
          maxConcurrency: 1,
        },
      },
      members: { agt_shared: { role: 'editor' } },
    })

    const app = await makeAppAsRole('user', 'usr_editor')
    const res = await app.request('/runs/run_1/rerun', { method: 'POST' })

    expect(res.status).toBe(201)
    expect(executeChatRun).toHaveBeenCalled()
  })
})

// ============================================================================
// Audit coverage.
//
// Iron Rule 5: any route that creates, updates or deletes state must leave an
// audit trail (docs/agent/audit-logging.md). `execute` transitions the run to
// `running`, inserts a step and spends the target agent's credentials, yet wrote
// no entry — leaving "who ran this agent" unanswerable while sibling mutations
// (`run.create`, `run.rerun`, `run.cancel`) were all audited.
// ============================================================================
describe('POST /runs/:id/execute — audit trail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRunReadFilter.mockReturnValue(undefined)
    mockGetCurrentUserId.mockReturnValue('usr_alice')
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockRunWithLifecycle.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 })
  })

  afterEach(() => mockGetCurrentUserId.mockReturnValue(undefined))

  it('records run.execute with the agent that actually ran', async () => {
    await selectByBoundId({
      run: {
        id: 'run_1',
        status: 'pending',
        userId: 'usr_alice',
        initiatorAgentId: null,
        intent: 'do the thing',
        config: {},
      },
      agents: {
        agt_owned: {
          id: 'agt_owned',
          userId: 'usr_alice',
          status: 'active',
          type: 'cursor',
          name: 'Owned',
          config: {},
        },
      },
    })

    const mod = await import('../runs.js')
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userRole' as never, 'user')
      c.set('userId' as never, 'usr_alice')
      await next()
    })
    app.route('/runs', mod.default)

    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agt_owned' }),
    })
    expect(res.status).toBe(200)

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'run.execute',
        resource: 'run',
        resourceId: 'run_1',
        // The agent that ran can differ from the run's initiator, so the entry
        // must name it — that is the whole point of auditing this route.
        details: expect.objectContaining({ agentId: 'agt_owned' }),
      }),
    )
  })

  /**
   * The audit call sits AFTER the status CAS precisely so a request that loses the
   * race cannot claim an execution that never happened. Nothing pinned that
   * ordering: the default update chain always reports `changes: 1`, so no existing
   * test ever reached the 409 branch. Move `logAudit` above the CAS and every other
   * test still passes — this one does not.
   */
  it('a request that loses the status CAS returns 409 and writes no audit entry', async () => {
    await selectByBoundId({
      run: {
        id: 'run_1',
        status: 'pending',
        userId: 'usr_alice',
        initiatorAgentId: null,
        intent: 'do the thing',
        config: {},
      },
      agents: {
        agt_owned: {
          id: 'agt_owned',
          userId: 'usr_alice',
          status: 'active',
          type: 'cursor',
          name: 'Owned',
          config: {},
        },
      },
    })
    // A concurrent request already flipped the row to `running`, so this CAS
    // matches nothing.
    mockDb.update.mockReturnValue(makeUpdateChain(0))

    const mod = await import('../runs.js')
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userRole' as never, 'user')
      c.set('userId' as never, 'usr_alice')
      await next()
    })
    app.route('/runs', mod.default)

    const res = await app.request('/runs/run_1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agt_owned' }),
    })

    expect(res.status).toBe(409)
    expect(logAudit).not.toHaveBeenCalled()
    expect(mockRunWithLifecycle).not.toHaveBeenCalled()
  })
})
