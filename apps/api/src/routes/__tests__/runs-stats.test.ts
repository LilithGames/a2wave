import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

type Json = Record<string, unknown>

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn((prefix?: string) => `${prefix}_test1`),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('../../worker/index.js', () => ({
  executeInWorker: vi.fn(),
}))

vi.mock('../../lib/settings.js', () => ({
  getCategorySettings: vi.fn().mockReturnValue({ workspacePath: '/tmp/workspace' }),
}))

vi.mock('../../lib/slug.js', () => ({
  slugify: vi.fn((s: string) => s.toLowerCase().replace(/\s+/g, '-')),
}))

vi.mock('../../engine/index.js', () => ({
  engineRegistry: { get: vi.fn().mockReturnValue({ kill: vi.fn() }), types: [] },
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: vi.fn().mockReturnValue('acquired'),
  scheduleNext: vi.fn(),
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

vi.mock('@a2wave/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@a2wave/shared')>()
  return {
    ...actual,
  }
})

vi.mock('../../lib/owner-filter.js', () => ({
  getCurrentUserId: vi.fn(() => 'usr_admin'),
}))
// Admin-equivalent visibility (no WHERE) so the aggregate SQL is what's asserted;
// the filter's own semantics are covered by agent-access.test.ts.
vi.mock('../../lib/agent-access.js', () => ({
  getRunReadFilter: vi.fn(() => undefined),
  loadAgentWithPerm: vi.fn(() => null),
  requireAgentWrite: vi.fn(),
  // runs.ts imports this too. A full mock factory that omits it makes any future
  // cancel/execute case added here die with Vitest's "No export is defined on the
  // mock" instead of a readable assertion failure.
  hasAgentScopedAccess: vi.fn(() => true),
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

import { db } from '../../db/client.js'

import { asyncQuery } from '../../test/async-query.js'

const mockDb = db as unknown as {
  select: Mock
  insert: Mock
  update: Mock
}

/** Chain for GROUP BY queries: select().from().where().groupBy().all() */
function makeGroupByChain(result: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        groupBy: vi.fn().mockReturnValue(
          asyncQuery({
            all: vi.fn().mockReturnValue(result),
          }),
        ),
      }),
    }),
  }
}

/** Chain for simple .get() queries: select().from().where().get() */
function makeGetChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        asyncQuery({
          get: vi.fn().mockReturnValue(result),
        }),
      ),
    }),
  }
}

/** Chain for joined .get() queries used by per-turn daily token attribution. */
function makeJoinGetChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(result),
          }),
        ),
      }),
    }),
  }
}

const NOW = new Date('2025-06-15T10:00:00Z')

describe('GET /runs/stats', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const mod = await import('../runs.js')
    app = new Hono().route('/runs', mod.default)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns correct structure with empty data', async () => {
    mockDb.select
      .mockReturnValueOnce(makeGroupByChain([])) // global status GROUP BY
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // today count
      .mockReturnValueOnce(makeGroupByChain([])) // today status GROUP BY
      .mockReturnValueOnce(makeGetChain({ avg: null })) // avg duration
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // asker count
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // today asker count
      .mockReturnValueOnce(makeGetChain(undefined)) // tokens aggregate
      .mockReturnValueOnce(makeJoinGetChain(undefined)) // today tokens aggregate
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // failed in the last 7 days

    const res = await app.request('/runs/stats')
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    expect(json).toEqual({
      total: 0,
      successRate: 0,
      avgDuration: 0,
      todayRuns: 0,
      byStatus: {
        completed: 0,
        failed: 0,
        running: 0,
        pending: 0,
        queued: 0,
        cancelled: 0,
      },
      todayByStatus: {
        completed: 0,
        failed: 0,
        running: 0,
        pending: 0,
        queued: 0,
        cancelled: 0,
      },
      askerCount: 0,
      todayAskerCount: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      todayTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      recentFailed: 0,
    })
  })

  it('returns tokens and todayTokens aggregates from SUM rows', async () => {
    mockDb.select
      .mockReturnValueOnce(makeGroupByChain([]))
      .mockReturnValueOnce(makeGetChain({ cnt: 0 }))
      .mockReturnValueOnce(makeGroupByChain([]))
      .mockReturnValueOnce(makeGetChain({ avg: null }))
      .mockReturnValueOnce(makeGetChain({ cnt: 0 }))
      .mockReturnValueOnce(makeGetChain({ cnt: 0 }))
      .mockReturnValueOnce(
        makeGetChain({
          input: 1200,
          output: 300,
          reasoning: 200,
          cacheRead: 5000,
          cacheWrite: 800,
        }),
      )
      .mockReturnValueOnce(
        makeJoinGetChain({ input: 100, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: 0 }),
      )
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // failed in the last 7 days

    const res = await app.request('/runs/stats')
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    expect(json.tokens).toEqual({
      input: 1200,
      output: 300,
      reasoning: 200,
      cacheRead: 5000,
      cacheWrite: 800,
    })
    expect(json.todayTokens).toEqual({
      input: 100,
      output: 20,
      reasoning: 10,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('calculates stats correctly with known data', async () => {
    const statusRows = [
      { status: 'completed', cnt: 2 },
      { status: 'failed', cnt: 1 },
      { status: 'running', cnt: 1 },
      { status: 'pending', cnt: 1 },
      { status: 'cancelled', cnt: 1 },
    ]
    const todayStatusRows = [
      { status: 'completed', cnt: 2 },
      { status: 'running', cnt: 1 },
      { status: 'pending', cnt: 1 },
    ]

    mockDb.select
      .mockReturnValueOnce(makeGroupByChain(statusRows)) // global status GROUP BY
      .mockReturnValueOnce(makeGetChain({ cnt: 4 })) // today count (run_1..4)
      .mockReturnValueOnce(makeGroupByChain(todayStatusRows)) // today status GROUP BY
      .mockReturnValueOnce(makeGetChain({ avg: 4000 })) // avg duration
      .mockReturnValueOnce(makeGetChain({ cnt: 3 })) // asker count
      .mockReturnValueOnce(makeGetChain({ cnt: 2 })) // today asker count
      .mockReturnValueOnce(makeGetChain(undefined)) // tokens aggregate
      .mockReturnValueOnce(makeJoinGetChain(undefined)) // today tokens aggregate
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // failed in the last 7 days

    const res = await app.request('/runs/stats')
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    expect(json.total).toBe(6)
    expect(json.successRate).toBe(33) // 2/6 = 33%
    expect(json.avgDuration).toBe(4000)
    expect(json.todayRuns).toBe(4)
    expect(json.askerCount).toBe(3)
    expect(json.todayAskerCount).toBe(2)

    const byStatus = json.byStatus as Json
    expect(byStatus.completed).toBe(2)
    expect(byStatus.failed).toBe(1)
    expect(byStatus.running).toBe(1)
    expect(byStatus.pending).toBe(1)
    expect(byStatus.cancelled).toBe(1)

    const todayByStatus = json.todayByStatus as Json
    expect(todayByStatus.completed).toBe(2)
    expect(todayByStatus.running).toBe(1)
    expect(todayByStatus.pending).toBe(1)
    expect(todayByStatus.queued).toBe(0)
    expect(todayByStatus.failed).toBe(0)
  })

  it('handles runs with no durationMs in result', async () => {
    const statusRows = [{ status: 'completed', cnt: 2 }]

    mockDb.select
      .mockReturnValueOnce(makeGroupByChain(statusRows))
      .mockReturnValueOnce(makeGetChain({ cnt: 2 }))
      .mockReturnValueOnce(makeGroupByChain(statusRows))
      .mockReturnValueOnce(makeGetChain({ avg: null })) // no durationMs in JSON
      .mockReturnValueOnce(makeGetChain({ cnt: 1 })) // asker count
      .mockReturnValueOnce(makeGetChain({ cnt: 1 })) // today asker count
      .mockReturnValueOnce(makeGetChain(undefined)) // tokens aggregate
      .mockReturnValueOnce(makeJoinGetChain(undefined)) // today tokens aggregate
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // failed in the last 7 days

    const res = await app.request('/runs/stats')
    const json = (await res.json()) as Json
    expect(json.avgDuration).toBe(0)
    expect(json.successRate).toBe(100)
  })

  it('calculates 100% success rate when all runs completed', async () => {
    const statusRows = [{ status: 'completed', cnt: 2 }]

    mockDb.select
      .mockReturnValueOnce(makeGroupByChain(statusRows))
      .mockReturnValueOnce(makeGetChain({ cnt: 2 }))
      .mockReturnValueOnce(makeGroupByChain(statusRows))
      .mockReturnValueOnce(makeGetChain({ avg: 1500 }))
      .mockReturnValueOnce(makeGetChain({ cnt: 1 })) // asker count
      .mockReturnValueOnce(makeGetChain({ cnt: 1 })) // today asker count
      .mockReturnValueOnce(makeGetChain(undefined)) // tokens aggregate
      .mockReturnValueOnce(makeJoinGetChain(undefined)) // today tokens aggregate
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // failed in the last 7 days

    const res = await app.request('/runs/stats')
    const json = (await res.json()) as Json
    expect(json.successRate).toBe(100)
    expect(json.avgDuration).toBe(1500)
  })

  it('todayByStatus is scoped to today and may differ from global byStatus', async () => {
    // Simulate the bug pattern: global has stale stuck pending, today has none
    const globalStatusRows = [
      { status: 'completed', cnt: 10 },
      { status: 'pending', cnt: 7 }, // stuck across days
    ]
    const todayStatusRows = [
      { status: 'completed', cnt: 1 },
      // pending=0 today
    ]

    mockDb.select
      .mockReturnValueOnce(makeGroupByChain(globalStatusRows))
      .mockReturnValueOnce(makeGetChain({ cnt: 1 }))
      .mockReturnValueOnce(makeGroupByChain(todayStatusRows))
      .mockReturnValueOnce(makeGetChain({ avg: 2000 }))
      .mockReturnValueOnce(makeGetChain({ cnt: 1 })) // asker count
      .mockReturnValueOnce(makeGetChain({ cnt: 1 })) // today asker count
      .mockReturnValueOnce(makeGetChain(undefined)) // tokens aggregate
      .mockReturnValueOnce(makeJoinGetChain(undefined)) // today tokens aggregate
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // failed in the last 7 days

    const res = await app.request('/runs/stats')
    const json = (await res.json()) as Json

    expect((json.byStatus as Json).pending).toBe(7)
    expect((json.todayByStatus as Json).pending).toBe(0)
    expect((json.todayByStatus as Json).queued).toBe(0)
  })

  it('recentFailed counts failed runs created in the last 7 days only', async () => {
    const recentFailedChain = makeGetChain({ cnt: 4 })
    mockDb.select
      .mockReturnValueOnce(makeGroupByChain([{ status: 'failed', cnt: 543 }]))
      .mockReturnValueOnce(makeGetChain({ cnt: 0 }))
      .mockReturnValueOnce(makeGroupByChain([]))
      .mockReturnValueOnce(makeGetChain({ avg: null }))
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // asker count
      .mockReturnValueOnce(makeGetChain({ cnt: 0 })) // today asker count
      .mockReturnValueOnce(makeGetChain(undefined)) // tokens aggregate
      .mockReturnValueOnce(makeJoinGetChain(undefined)) // today tokens aggregate
      .mockReturnValueOnce(recentFailedChain)

    const res = await app.request('/runs/stats')
    const json = (await res.json()) as Json

    expect((json.byStatus as Json).failed).toBe(543)
    expect(json.recentFailed).toBe(4)
    const where = recentFailedChain.from.mock.results[0]?.value.where.mock.calls[0]?.[0]
    const sevenDaysAgo = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000)
    expect(collectDates(where).map((d) => d.getTime())).toEqual([sevenDaysAgo.getTime()])
    expect(collectStrings(where)).toContain('failed')
  })
})

/** Every Date bound into a Drizzle condition tree. */
function collectDates(node: unknown, seen = new Set<unknown>()): Date[] {
  if (node instanceof Date) return [node]
  if (!node || typeof node !== 'object' || seen.has(node)) return []
  seen.add(node)
  return Object.values(node).flatMap((v) => collectDates(v, seen))
}

/** Every string param bound into a Drizzle condition tree. */
function collectStrings(node: unknown, seen = new Set<unknown>()): string[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return []
  seen.add(node)
  const own =
    'value' in node && typeof (node as { value: unknown }).value === 'string'
      ? [(node as { value: string }).value]
      : []
  return [...own, ...Object.values(node).flatMap((v) => collectStrings(v, seen))]
}
