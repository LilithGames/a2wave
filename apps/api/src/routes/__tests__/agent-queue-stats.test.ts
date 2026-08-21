import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

/**
 * Same isolation rationale as agent-timeseries.test.ts: agents.test.ts mocks
 * the DB as a positional call chain, so this endpoint gets its own file.
 */

vi.mock('../../db/client.js', () => {
  const database = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  }
  database.transaction.mockImplementation((fn: (tx: typeof database) => unknown) => fn(database))
  return { db: database }
})

vi.mock('../../lib/id.js', () => ({ createId: vi.fn(() => 'test_id') }))
vi.mock('../../engine/index.js', () => ({
  engineRegistry: { get: vi.fn().mockReturnValue(true), types: [] },
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock('../../worker/index.js', () => ({ executeInWorker: vi.fn() }))
vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn(), logBackgroundAudit: vi.fn() }))

const mockCountOccupiedSlots = vi.hoisted(() => vi.fn())
vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: { countOccupiedSlots: mockCountOccupiedSlots },
}))

const { db } = await import('../../db/client.js')
const { AppError } = await import('../../lib/errors.js')

const mockDb = db as unknown as { select: Mock }

function makeApp(routes: import('hono').Hono): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, 'usr_admin' as never)
    c.set('userRole' as never, 'admin' as never)
    await next()
  })
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    return c.json({ error: 'Internal Server Error' }, 500)
  })
  app.route('/agents', routes)
  return app
}

function makeChain(getResult: unknown, allResult: unknown[] = []) {
  const nodes: Record<string, unknown>[] = []
  const self = () => nodes[0]
  const terminal: Record<string, unknown> = {
    get: vi.fn().mockReturnValue(getResult),
    all: vi.fn().mockReturnValue(allResult),
    groupBy: vi.fn(self),
    orderBy: vi.fn(self),
    where: vi.fn(self),
    innerJoin: vi.fn(self),
    limit: vi.fn(self),
  }
  nodes.push(asyncQuery(terminal))
  return asyncQuery({ from: vi.fn(self) })
}

const AGENT = { id: 'agt_test', userId: 'usr_admin', name: 'T', maxConcurrency: 2 }
const PATH = '/agents/agt_test/stats/queue'

let app: Hono

/** Wires the agent lookup, queued count, and FIFO-head row, in call order. */
function mockQueue(opts: { agent?: unknown; queuedCount?: number; head?: unknown }) {
  let call = 0
  mockDb.select.mockImplementation(() => {
    call++
    if (call === 1) return makeChain(opts.agent === undefined ? AGENT : opts.agent)
    if (call === 2) return makeChain({ value: opts.queuedCount ?? 0 })
    return makeChain(opts.head ?? undefined)
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockCountOccupiedSlots.mockResolvedValue(0)
  const mod = await import('../agents.js')
  app = makeApp(mod.default)
})

describe('GET /agents/:id/stats/queue', () => {
  it('returns 404 when the agent does not exist', async () => {
    mockQueue({ agent: null })
    expect((await app.request('/agents/agt_missing/stats/queue')).status).toBe(404)
  })

  it('reports queue depth, occupancy, and the concurrency limit', async () => {
    mockQueue({ queuedCount: 3, head: { queuedAt: new Date(Date.now() - 90_000) } })
    mockCountOccupiedSlots.mockResolvedValue(2)

    const res = await app.request(PATH)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      queued: number
      occupied: number
      maxConcurrency: number
      oldestWaitMs: number | null
    }
    expect(json.queued).toBe(3)
    expect(json.occupied).toBe(2)
    expect(json.maxConcurrency).toBe(2)
    expect(json.oldestWaitMs).toBeGreaterThanOrEqual(89_000)
  })

  it('reports a null oldest wait when nothing is queued', async () => {
    mockQueue({ queuedCount: 0 })
    const res = await app.request(PATH)
    const json = (await res.json()) as { queued: number; oldestWaitMs: number | null }
    expect(json.queued).toBe(0)
    expect(json.oldestWaitMs).toBeNull()
  })

  it('falls back to updatedAt for queued rows predating the queuedAt column', async () => {
    mockQueue({
      queuedCount: 1,
      head: { queuedAt: null, updatedAt: new Date(Date.now() - 30_000) },
    })
    const res = await app.request(PATH)
    const json = (await res.json()) as { oldestWaitMs: number | null }
    expect(json.oldestWaitMs).toBeGreaterThanOrEqual(29_000)
  })

  it('defaults the concurrency limit to 1 when the agent has none', async () => {
    mockQueue({ agent: { ...AGENT, maxConcurrency: null } })
    const res = await app.request(PATH)
    const json = (await res.json()) as { maxConcurrency: number }
    expect(json.maxConcurrency).toBe(1)
  })
})
