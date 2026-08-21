import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

type Json = Record<string, unknown>

/**
 * Deliberately a separate file from agents.test.ts.
 *
 * That file mocks the DB as a *positional* call chain (`switch (statsCallNo)`),
 * so any query added to a handler there silently remaps every later case — tests
 * keep passing while asserting the wrong thing. The timeseries endpoint gets its
 * own chain builder here so the two suites cannot interfere.
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

const { db } = await import('../../db/client.js')
const { AppError } = await import('../../lib/errors.js')

const mockDb = db as unknown as { select: Mock }

function makeApp(
  routes: import('hono').Hono,
  auth: { userId: string; role: 'admin' | 'user' } = { userId: 'usr_admin', role: 'admin' },
): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, auth.userId as never)
    c.set('userRole' as never, auth.role as never)
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

/** Satisfies from → where → { get, all, groupBy, innerJoin } in any order. */
function makeChain(getResult: unknown, allResult: unknown[]) {
  // Every builder step must hand back an awaitable node — `innerJoin` in
  // particular is not one of asyncQuery's auto-chained methods, so an unwrapped
  // return value would break the `.innerJoin().where().groupBy()` queries.
  const nodes: Record<string, unknown>[] = []
  const self = () => nodes[0]
  const terminal: Record<string, unknown> = {
    get: vi.fn().mockReturnValue(getResult),
    all: vi.fn().mockReturnValue(allResult),
    groupBy: vi.fn(self),
    orderBy: vi.fn(self),
    where: vi.fn(self),
    innerJoin: vi.fn(self),
  }
  nodes.push(asyncQuery(terminal))
  return asyncQuery({ from: vi.fn(self) })
}

const AGENT = { id: 'agt_test', userId: 'usr_admin', name: 'T' }
const PATH = '/agents/agt_test/stats/timeseries'
const UTC = 'tzOffset=0'

/** Bucket start (seconds) for a UTC day. */
const day = (iso: string) => Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 1000)

let app: Hono

beforeEach(async () => {
  vi.clearAllMocks()
  const mod = await import('../agents.js')
  app = makeApp(mod.default)
})

describe('GET /agents/:id/stats/timeseries — access control', () => {
  it('returns 404 when the agent does not exist', async () => {
    mockDb.select.mockReturnValue(makeChain(undefined, []))
    const res = await app.request(
      `/agents/agt_missing/stats/timeseries?from=2026-07-01&to=2026-07-07&${UTC}`,
    )
    expect(res.status).toBe(404)
  })

  it('allows a viewer member to read the series', async () => {
    const mod = await import('../agents.js')
    app = makeApp(mod.default, { userId: 'usr_viewer', role: 'user' })
    mockDb.select.mockImplementation((selection?: Record<string, unknown>) => {
      // requireAgentRead resolves the agent, then the membership row.
      if (!selection) return makeChain({ ...AGENT, userId: 'usr_owner' }, [])
      if ('role' in (selection ?? {})) return makeChain({ role: 'viewer' }, [])
      return makeChain(undefined, [])
    })
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-07&${UTC}`)
    expect(res.status).toBe(200)
  })
})

describe('GET /agents/:id/stats/timeseries — validation', () => {
  beforeEach(() => {
    mockDb.select.mockImplementation((selection?: Record<string, unknown>) =>
      selection ? makeChain(undefined, []) : makeChain(AGENT, []),
    )
  })

  it('rejects a missing range', async () => {
    expect((await app.request(`${PATH}?${UTC}`)).status).toBe(400)
  })

  it('rejects from > to', async () => {
    const res = await app.request(`${PATH}?from=2026-07-07&to=2026-07-01&${UTC}`)
    expect(res.status).toBe(400)
  })

  it('rejects an unknown bucket unit', async () => {
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-02&bucket=week&${UTC}`)
    expect(res.status).toBe(400)
  })

  it('rejects a range that exceeds the bucket cap', async () => {
    // 90 days of hourly buckets is ~2160 — far past MAX_BUCKETS.
    const res = await app.request(`${PATH}?from=2026-01-01&to=2026-03-31&bucket=hour&${UTC}`)
    expect(res.status).toBe(400)
  })

  it('rejects an out-of-range timezone offset', async () => {
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-02&tzOffset=999999`)
    expect(res.status).toBe(400)
  })

  it.each([
    ['a month that does not exist', '2026-13-45'],
    ['a day past the end of the month', '2026-02-31'],
  ])('rejects %s rather than returning an empty chart', async (_label, badDate) => {
    // These pass the shape regex. Before the calendar-date check they produced
    // NaN bounds, an empty bucket loop, and a 200 with no points — which the UI
    // renders as "no data in the selected range", i.e. bad input silently
    // misreported as a quiet agent.
    const res = await app.request(`${PATH}?from=${badDate}&to=${badDate}&${UTC}`)
    expect(res.status).toBe(400)
  })

  it('rejects an absurd range without materializing its buckets', async () => {
    // The guard must be O(1): bucketSequence() for this range would push ~79M
    // numbers into an array before any length check could reject it. If this
    // ever regresses, the test does not fail — it exhausts memory and dies.
    const started = Date.now()
    const res = await app.request(`${PATH}?from=1000-01-01&to=9999-12-31&bucket=hour&${UTC}`)
    expect(res.status).toBe(400)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('GET /agents/:id/stats/timeseries — shape and gap filling', () => {
  /** Wires the agent lookup plus the five aggregate queries, in call order. */
  function mockAggregates(opts: {
    runRows?: unknown[]
    askerRows?: unknown[]
    tokenRows?: unknown[]
    durationRows?: unknown[]
    latencyRows?: unknown[]
  }) {
    let call = 0
    mockDb.select.mockImplementation(() => {
      call++
      if (call === 1) return makeChain(AGENT, [])
      if (call === 2) return makeChain(undefined, opts.runRows ?? [])
      if (call === 3) return makeChain(undefined, opts.askerRows ?? [])
      if (call === 4) return makeChain(undefined, opts.tokenRows ?? [])
      if (call === 5) return makeChain(undefined, opts.durationRows ?? [])
      return makeChain(undefined, opts.latencyRows ?? [])
    })
  }

  it('emits one zero-filled point per day when there are no runs', async () => {
    mockAggregates({})
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-07&${UTC}`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as Json & { points: Json[] }
    expect(json.bucket).toBe('day')
    expect(json.points).toHaveLength(7)
    expect(json.points[0].total).toBe(0)
    expect(json.points[0].askers).toBe(0)
  })

  it('fills the gap between two populated days', async () => {
    mockAggregates({
      runRows: [
        { bucket: day('2026-07-01'), status: 'completed', cnt: 3 },
        { bucket: day('2026-07-03'), status: 'failed', cnt: 1 },
      ],
    })
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-03&${UTC}`)
    const json = (await res.json()) as Json & {
      points: { total: number; runs: Record<string, number> }[]
    }
    expect(json.points).toHaveLength(3)
    expect(json.points[0].runs.completed).toBe(3)
    expect(json.points[1].total).toBe(0) // the filled gap
    expect(json.points[2].runs.failed).toBe(1)
  })

  it('reports avgDurationMs as null rather than 0 on days with no completed turns', async () => {
    mockAggregates({
      durationRows: [{ bucket: day('2026-07-02'), avgMs: 4210, samples: 6 }],
    })
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-03&${UTC}`)
    const json = (await res.json()) as Json & {
      points: { avgDurationMs: number | null; durationSamples: number }[]
    }
    // A 0 here would draw the latency line to the axis and read as "instant".
    expect(json.points[0].avgDurationMs).toBeNull()
    expect(json.points[0].durationSamples).toBe(0)
    expect(json.points[1].avgDurationMs).toBe(4210)
  })

  it('aggregates queue wait and execution latency per bucket', async () => {
    const b1 = day('2026-07-01')
    mockAggregates({
      latencyRows: [
        { bucket: b1, waitMs: 1_000, durationMs: 3_000 },
        { bucket: b1, waitMs: 3_000, durationMs: 5_000 },
      ],
    })
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-02&${UTC}`)
    const json = (await res.json()) as Json & {
      points: {
        latency: {
          waitAvgMs: number | null
          execAvgMs: number | null
          e2eP50Ms: number | null
          samples: number
        }
      }[]
    }
    expect(json.points[0].latency.waitAvgMs).toBe(2_000)
    expect(json.points[0].latency.execAvgMs).toBe(4_000)
    // Nearest-rank P50 of [4000, 8000] is the first value.
    expect(json.points[0].latency.e2eP50Ms).toBe(4_000)
    expect(json.points[0].latency.samples).toBe(2)
    // The gap day carries nulls, never 0 — "no turns" is not "instant turns".
    expect(json.points[1].latency.waitAvgMs).toBeNull()
    expect(json.points[1].latency.samples).toBe(0)
  })

  it('summarizes end-to-end percentiles across the whole range', async () => {
    // Percentiles cannot be recombined from per-bucket percentiles, so the
    // range headline ships precomputed.
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({
      bucket: day('2026-07-01'),
      waitMs: 0,
      durationMs: i * 1_000,
    }))
    mockAggregates({ latencyRows: rows })
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-01&${UTC}`)
    const json = (await res.json()) as Json & {
      latencySummary: { e2eP50Ms: number | null; e2eP90Ms: number | null; samples: number }
    }
    expect(json.latencySummary.e2eP50Ms).toBe(5_000)
    expect(json.latencySummary.e2eP90Ms).toBe(9_000)
    expect(json.latencySummary.samples).toBe(10)
  })

  it('reports a null latency summary when no measured turns exist', async () => {
    mockAggregates({})
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-01&${UTC}`)
    const json = (await res.json()) as Json & {
      latencySummary: { e2eP50Ms: number | null; e2eP90Ms: number | null; samples: number }
    }
    expect(json.latencySummary).toEqual({ e2eP50Ms: null, e2eP90Ms: null, samples: 0 })
  })

  it('carries token totals through from the step-level aggregate', async () => {
    mockAggregates({
      tokenRows: [{ bucket: day('2026-07-01'), input: 8100, output: 2300 }],
    })
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-02&${UTC}`)
    const json = (await res.json()) as Json & {
      points: { tokens: Record<string, number> }[]
    }
    expect(json.points[0].tokens.input).toBe(8100)
    expect(json.points[0].tokens.output).toBe(2300)
    expect(json.points[1].tokens.input).toBe(0)
  })

  it('returns 24 hourly points for a single day', async () => {
    mockAggregates({})
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-01&bucket=hour&${UTC}`)
    const json = (await res.json()) as Json & { points: Json[] }
    expect(json.bucket).toBe('hour')
    expect(json.points).toHaveLength(24)
  })

  it('shifts day boundaries by the supplied timezone offset', async () => {
    mockAggregates({})
    const res = await app.request(`${PATH}?from=2026-07-01&to=2026-07-01&tzOffset=28800`)
    const json = (await res.json()) as Json & { points: { ts: string }[] }
    // Local midnight of Jul 1 in UTC+8 is 2026-06-30T16:00Z.
    expect(json.points[0].ts).toBe('2026-06-30T16:00:00.000Z')
  })

  it('keeps day boundaries at real local midnight across a DST switch', async () => {
    mockAggregates({})
    // America/Los_Angeles springs forward on 2026-03-08. With a single scalar
    // offset every boundary after the switch lands an hour off; with the zone
    // the server resolves each midnight independently.
    const res = await app.request(
      `${PATH}?from=2026-03-07&to=2026-03-10&tz=America%2FLos_Angeles&tzOffset=-28800`,
    )
    const json = (await res.json()) as Json & { points: { ts: string }[] }
    expect(json.points.map((p) => p.ts)).toEqual([
      '2026-03-07T08:00:00.000Z', // 00:00 PST
      '2026-03-08T08:00:00.000Z', // 00:00 PST — 23-hour day
      '2026-03-09T07:00:00.000Z', // 00:00 PDT
      '2026-03-10T07:00:00.000Z',
    ])
  })

  it('falls back to the numeric offset when the zone is unusable', async () => {
    mockAggregates({})
    const res = await app.request(
      `${PATH}?from=2026-07-01&to=2026-07-01&tz=Not%2FAZone&tzOffset=28800`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as Json & { points: { ts: string }[] }
    expect(json.points[0].ts).toBe('2026-06-30T16:00:00.000Z')
  })
})
