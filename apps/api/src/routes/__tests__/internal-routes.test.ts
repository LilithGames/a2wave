/**
 * Covers /internal/agents, /internal/a2a/:agentId/card and /internal/a2a/:agentId
 * — the parts not exercised by internal-streaming-card.test.ts.
 */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: { select: (...a: unknown[]) => dbSelect(...a) },
}))

vi.mock('../../db/schema.js', () => ({
  agents: { id: 'agents.id' },
}))

const buildAgentCardMock = vi.fn()
vi.mock('../../a2a/agent-card.js', () => ({
  buildAgentCard: (...a: unknown[]) => buildAgentCardMock(...a),
  serializeAgentCard: (card: unknown) => card,
}))

const handleA2ARequestMock = vi.fn()
vi.mock('../../a2a/handle-request.js', () => ({
  handleA2ARequest: (...a: unknown[]) => handleA2ARequestMock(...a),
}))

vi.mock('../../a2a/run-recording.js', () => ({
  createRecordedA2AExecuteFn: vi.fn(() => async () => ({})),
  createRecordedA2ACancelFn: vi.fn(() => async () => 'cancelled'),
}))

const { FakeTaskStore } = vi.hoisted(() => {
  class FakeTaskStore {
    async cleanup() {}
  }
  return { FakeTaskStore }
})
vi.mock('../../a2a/sqlite-task-store.js', () => ({
  SqliteTaskStore: FakeTaskStore,
}))

vi.mock('../../lib/streaming-card-registry.js', () => ({
  getStreamingCard: vi.fn(),
  shouldShowRemoteChildOutput: vi.fn(),
}))

vi.mock('../internal-admin.js', () => ({
  default: new Hono().get('/probe', (c) => c.json({ ok: true })),
}))

const mockEnv = vi.hoisted(() => ({ TRUSTED_PROXY: false }))
vi.mock('../../env.js', () => ({ env: mockEnv }))

import {
  getInternalAdminToken,
  getInternalToken,
  INTERNAL_ADMIN_TOKEN_HEADER,
  INTERNAL_TOKEN_HEADER,
} from '../../lib/internal-admin-auth.js'
import internalRoutes from '../internal.js'

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const k of [
    'from',
    'where',
    'limit',
    'orderBy',
    'offset',
    'groupBy',
    'having',
    'returning',
  ]) {
    c[k] = vi.fn((): unknown => __chain)
  }
  c.get = vi.fn()
  c.all = vi.fn()

  // Awaiting the chain yields what `.get()`/`.all()` was configured to return,
  // as an array — production code destructures `[row]` from `.limit(1)` now.
  // The original mock fns stay reachable, so existing assertions are unaffected.
  let __settled: Promise<unknown[]> | undefined
  const __rows = (): unknown[] => {
    // `get` before `all`: mocks often define both, with `all` a placeholder.
    const get = c.get as undefined | (() => unknown)
    if (get) {
      const row = get()
      if (row != null) return [row]
    }
    const all = c.all as undefined | (() => unknown)
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    if (get) return []
    const run = c.run as undefined | (() => unknown)
    if (run) {
      const res = run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 1
      return Array.from({ length: changes }, () => ({}))
    }
    return []
  }
  const __chain = Object.assign(
    {
      // Lazy: resolving eagerly would consume a queued `get` per intermediate
      // node while the chain is still being built.
      // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable — it stands in for drizzle's awaitable query builder.
      then: (f?: (v: unknown[]) => unknown, r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.then(f, r)
      },
      catch: (r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.catch(r)
      },
    },
    c,
  )
  for (const k of Object.keys(c)) {
    const fn = c[k] as unknown
    if (typeof fn === 'function' && !['get', 'all', 'run'].includes(k)) {
      ;(__chain as Record<string, unknown>)[k] = fn
    }
  }
  return __chain as unknown as typeof c
}

function queueSelects(...returns: Array<{ get?: unknown; all?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => {
    const cfg = returns[i++] ?? {}
    const c = makeChain()
    if ('get' in cfg) c.get.mockReturnValue(cfg.get)
    if ('all' in cfg) c.all.mockReturnValue(cfg.all)
    return c
  })
}

beforeEach(() => {
  mockEnv.TRUSTED_PROXY = false
  dbSelect.mockReset()
  buildAgentCardMock.mockReset()
  handleA2ARequestMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Functional tests need to pass the (now fail-closed) localhost guard, so they
// inject a loopback remoteAddress — matching how the real node-server adapter
// populates c.env.incoming.socket for the platform-admin MCP's 127.0.0.1 call.
function buildApp() {
  const app = new Hono()
  app.use('*', (c, next) => {
    ;(c as unknown as { env: unknown }).env = {
      incoming: { socket: { remoteAddress: '127.0.0.1' } },
    }
    return next()
  })
  return app.route('/internal', internalRoutes)
}

// Every in-process caller (the agent-router MCP) carries the process-scoped
// internal token; a loopback socket alone no longer authenticates a request.
function request(path: string, init: RequestInit = {}) {
  return buildApp().request(path, {
    ...init,
    headers: {
      ...((init.headers as Record<string, string>) ?? {}),
      [INTERNAL_TOKEN_HEADER]: getInternalToken(),
    },
  })
}

describe('localhost guard', () => {
  it('fails CLOSED when the remote address is absent (P1)', async () => {
    // A missing remoteAddress must NOT be treated as localhost. The only real
    // caller (platform-admin MCP) reaches this over a real 127.0.0.1 socket, so
    // an absent address means an unexpected transport / in-memory construction —
    // deny it rather than expose unredacted settings + the JWT signing key.
    // Use a bare app (no injected address) to reproduce the absent case.
    queueSelects({ all: [] })
    const bareApp = new Hono().route('/internal', internalRoutes)
    const res = await bareApp.request('/internal/agents')
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/localhost-only/)
  })

  it('blocks remote callers with 403', async () => {
    // Now simulate a non-localhost address by injecting middleware ahead.
    const app = new Hono()
    app.use('*', (c, next) => {
      ;(c as unknown as { env: unknown }).env = {
        incoming: { socket: { remoteAddress: '203.0.113.5' } },
      }
      return next()
    })
    app.route('/internal', internalRoutes)
    queueSelects({ all: [] })
    const blocked = await app.request('/internal/agents')
    expect(blocked.status).toBe(403)
    expect((await blocked.json()).error).toMatch(/localhost-only/)
  })

  it('permits IPv6 loopback', async () => {
    const app = new Hono()
    app.use('*', (c, next) => {
      ;(c as unknown as { env: unknown }).env = {
        incoming: { socket: { remoteAddress: '::1' } },
      }
      return next()
    })
    app.route('/internal', internalRoutes)
    queueSelects({ all: [] })
    const res = await app.request('/internal/agents', {
      headers: { [INTERNAL_TOKEN_HEADER]: getInternalToken() },
    })
    expect(res.status).toBe(200)
  })

  it('denies a loopback peer that forwarded an X-Forwarded-For when a proxy is trusted', async () => {
    // With nginx/Caddy on the same host every internet request arrives from
    // 127.0.0.1. A forwarded request is by definition NOT a local caller, so the
    // loopback peer must not be read as one.
    mockEnv.TRUSTED_PROXY = true
    queueSelects({ all: [] })
    const res = await request('/internal/agents', {
      headers: { 'X-Forwarded-For': '203.0.113.5' },
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/localhost-only/)
  })
})

describe('internal credential guard', () => {
  it('rejects a loopback caller with no internal token (anonymous A2A invoke)', async () => {
    queueSelects({ get: { id: 'agt_1', publishStatus: 'published', publishChannels: ['a2a'] } })
    const res = await buildApp().request('/internal/a2a/agt_1', { method: 'POST' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/internal credential/)
    expect(handleA2ARequestMock).not.toHaveBeenCalled()
  })

  it('rejects a loopback caller with a wrong internal token', async () => {
    queueSelects({ all: [] })
    const res = await buildApp().request('/internal/agents', {
      headers: { [INTERNAL_TOKEN_HEADER]: 'wrong-token' },
    })
    expect(res.status).toBe(403)
  })

  it('accepts the stronger platform-admin credential on a non-admin route', async () => {
    queueSelects({ all: [] })
    const res = await buildApp().request('/internal/agents', {
      headers: { [INTERNAL_ADMIN_TOKEN_HEADER]: getInternalAdminToken() },
    })
    expect(res.status).toBe(200)
  })

  it('rejects the streaming-card endpoints without the internal token', async () => {
    const res = await buildApp().request('/internal/streaming-card/card_1/child', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId: 'c1' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('internal admin credential guard', () => {
  it('rejects a loopback caller without the platform-admin credential', async () => {
    const res = await request('/internal/admin/probe')
    expect(res.status).toBe(403)
  })

  it('rejects a loopback caller with the wrong credential', async () => {
    const res = await request('/internal/admin/probe', {
      headers: { [INTERNAL_ADMIN_TOKEN_HEADER]: 'wrong-token' },
    })
    expect(res.status).toBe(403)
  })

  it('allows platform-admin with the process credential', async () => {
    const res = await request('/internal/admin/probe', {
      headers: { [INTERNAL_ADMIN_TOKEN_HEADER]: getInternalAdminToken() },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('GET /internal/agents', () => {
  it('lists only published a2a agents', async () => {
    queueSelects({
      all: [
        { id: 'agt_1', name: 'a', publishStatus: 'published', publishChannels: ['a2a'] },
        { id: 'agt_2', name: 'b', publishStatus: 'published', publishChannels: ['api'] },
        { id: 'agt_3', name: 'c', publishStatus: 'draft', publishChannels: ['a2a'] },
        { id: 'agt_4', name: 'd', publishStatus: 'published', publishChannels: null },
      ],
    })
    const res = await request('/internal/agents')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.map((a: { id: string }) => a.id)).toEqual(['agt_1'])
  })

  it('filters by ids query param', async () => {
    queueSelects({
      all: [
        { id: 'agt_1', name: 'a', publishStatus: 'published', publishChannels: ['a2a'] },
        { id: 'agt_2', name: 'b', publishStatus: 'published', publishChannels: ['a2a'] },
      ],
    })
    const res = await request('/internal/agents?ids=agt_2,agt_3')
    const body = (await res.json()) as any
    expect(body.data.map((a: { id: string }) => a.id)).toEqual(['agt_2'])
  })
})

describe('GET /internal/a2a/:agentId/card', () => {
  it('returns 404 when agent is missing', async () => {
    queueSelects({ get: undefined })
    const res = await request('/internal/a2a/agt_x/card')
    expect(res.status).toBe(404)
  })

  it('returns 403 when not published', async () => {
    queueSelects({ get: { id: 'agt_1', publishStatus: 'draft' } })
    const res = await request('/internal/a2a/agt_1/card')
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error).toBe('Agent is not published')
  })

  it('returns 403 when a2a channel not enabled', async () => {
    queueSelects({ get: { id: 'agt_1', publishStatus: 'published', publishChannels: ['api'] } })
    const res = await request('/internal/a2a/agt_1/card')
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error).toBe('A2A not enabled for this agent')
  })

  it('returns the agent card on success', async () => {
    queueSelects({
      get: { id: 'agt_1', publishStatus: 'published', publishChannels: ['a2a'], name: 'A' },
    })
    buildAgentCardMock.mockReturnValue({ name: 'A', skills: [] })
    const res = await request('/internal/a2a/agt_1/card')
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({ name: 'A', skills: [] })
    expect(buildAgentCardMock).toHaveBeenCalled()
  })
})

describe('POST /internal/a2a/:agentId', () => {
  it('returns 404 when agent is missing', async () => {
    queueSelects({ get: undefined })
    const res = await request('/internal/a2a/agt_x', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when a2a is not enabled', async () => {
    queueSelects({ get: { id: 'agt_1', publishStatus: 'published', publishChannels: ['api'] } })
    const res = await request('/internal/a2a/agt_1', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('forwards to handleA2ARequest on success', async () => {
    queueSelects({
      get: { id: 'agt_1', publishStatus: 'published', publishChannels: ['a2a'] },
    })
    handleA2ARequestMock.mockImplementation((c: { json: (b: unknown) => Response }) =>
      c.json({ ok: true }),
    )
    const res = await request('/internal/a2a/agt_1', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({ ok: true })
    expect(handleA2ARequestMock).toHaveBeenCalled()
  })
})
