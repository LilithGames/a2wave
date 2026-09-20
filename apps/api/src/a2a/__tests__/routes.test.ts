import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

type Json = Record<string, unknown>

const mockSerializeAgentCard = vi.hoisted(() => vi.fn((card: unknown) => card))

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('../../middleware/gateway-auth.js', () => ({
  validateGatewayAuth: vi.fn(),
  normalizeAuthType: (v: string | null | undefined) =>
    v === 'none' || v === 'oauth' ? v : 'api_key',
}))

vi.mock('../agent-card.js', () => ({
  buildAgentCard: vi.fn(),
  serializeAgentCard: mockSerializeAgentCard,
}))

vi.mock('../executor.js', () => ({
  // biome-ignore lint/complexity/useArrowFunction: 需要 function 表达式才能用作 `new` 构造器
  A2waveAgentExecutor: vi.fn(function () {}),
}))

vi.mock('../../worker/index.js', () => ({
  executeInWorker: vi.fn(),
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  resolveWorkDir: vi.fn().mockResolvedValue('/tmp/work'),
  injectScmEnv: vi.fn(),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor' }),
}))

vi.mock('../../engine/index.js', () => ({
  engineRegistry: { get: vi.fn().mockReturnValue(true) },
}))

vi.mock('@a2wave/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@a2wave/shared')>()
  return {
    ...actual,
  }
})

vi.mock('../sqlite-task-store.js', () => ({
  SqliteTaskStore: vi.fn(function (this: { cleanup: () => Promise<number> }) {
    this.cleanup = vi.fn().mockResolvedValue(0)
  }),
}))

const mockHandle = vi.fn()
vi.mock('@a2a-js/sdk/server', () => ({
  DefaultExecutionEventBusManager: class {},
  // biome-ignore lint/complexity/useArrowFunction: 需要 function 表达式才能用作 `new` 构造器
  DefaultRequestHandler: vi.fn(function () {}),
  JsonRpcTransportHandler: vi.fn(function (this: { handle: typeof mockHandle }) {
    this.handle = mockHandle
  }),
  ServerCallContext: vi.fn(function (
    this: {
      requestedVersion: string
      tenant?: string
      user?: unknown
      state: Map<string, unknown>
    },
    options: {
      requestedVersion?: string
      tenant?: string
      user?: unknown
      state?: Map<string, unknown>
    } = {},
  ) {
    this.requestedVersion = options.requestedVersion ?? '0.3'
    this.tenant = options.tenant
    this.user = options.user
    this.state = options.state ?? new Map()
  }),
  validateVersion: vi.fn(),
}))

vi.mock('@a2a-js/sdk/compat/v0_3', () => ({
  isLegacyJsonRpcMethod: (method: unknown) => typeof method === 'string' && method.includes('/'),
  isV1JsonRpcMethod: (method: unknown) => typeof method === 'string' && /^[A-Z]/.test(method),
}))

vi.mock('@a2a-js/sdk/compat/v0_3/server', () => ({
  LegacyJsonRpcTransportHandler: vi.fn(function (this: { handle: typeof mockHandle }) {
    this.handle = mockHandle
  }),
}))

function makeDbChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        asyncQuery({
          get: vi.fn().mockReturnValue(result),
          all: vi.fn().mockReturnValue(result ? [result] : []),
        }),
      ),
    }),
  }
}

import { db } from '../../db/client.js'
import { validateGatewayAuth } from '../../middleware/gateway-auth.js'
import { asyncQuery } from '../../test/async-query.js'
import { buildAgentCard } from '../agent-card.js'

const publishedAgent = {
  id: 'agt_test1',
  name: 'Test Agent',
  description: 'A test agent',
  publishDescription: 'Published desc',
  publishStatus: 'published',
  publishChannels: ['a2a'],
  publishAuthType: 'none',
  publishIpWhitelist: [],
  endpointApiKey: null,
  a2aSkills: [{ id: 'skl_1', name: 'Code', description: 'Codes', tags: ['dev'] }],
  config: {},
  providerId: null,
  systemPrompt: null,
  skills: [],
  env: null,
  workspaceType: 'temp' as const,
  scmSourceId: null,
}

describe('A2A routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSerializeAgentCard.mockImplementation((card: unknown) => card)
    ;(validateGatewayAuth as Mock).mockResolvedValue({})
    ;(buildAgentCard as Mock).mockReturnValue({
      name: 'Test Agent',
      description: 'Published desc',
      url: 'http://localhost/api/a2a/agt_test1',
      version: '1.0.0',
    })
    mockHandle.mockReset()

    const mod = await import('../../routes/a2a.js')
    const a2aRoutes = mod.default

    app = new Hono()
    app.route('/api/a2a', a2aRoutes)
  })

  describe('GET /:agentId/.well-known/agent-card.json', () => {
    it('returns 404 when agent does not exist', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/a2a/agt_missing/.well-known/agent-card.json')

      expect(res.status).toBe(404)
      const json = (await res.json()) as Json
      expect(json.error).toBe('Agent not found')
    })

    it('returns 403 when agent is not published', async () => {
      const draftAgent = { ...publishedAgent, publishStatus: 'draft' }
      ;(db.select as Mock).mockReturnValue(makeDbChain(draftAgent))

      const res = await app.request('/api/a2a/agt_test1/.well-known/agent-card.json')

      expect(res.status).toBe(403)
      const json = (await res.json()) as Json
      expect(json.error).toBe('Agent is not published')
    })

    it('returns 403 when a2a channel is not enabled', async () => {
      const apiOnlyAgent = { ...publishedAgent, publishChannels: ['api'] }
      ;(db.select as Mock).mockReturnValue(makeDbChain(apiOnlyAgent))

      const res = await app.request('/api/a2a/agt_test1/.well-known/agent-card.json')

      expect(res.status).toBe(403)
      const json = (await res.json()) as Json
      expect(json.error).toBe('A2A not enabled for this agent')
    })

    it('returns auth error when validateGatewayAuth fails', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        error: { error: 'Missing Authorization header', status: 401 },
      })

      const res = await app.request('/api/a2a/agt_test1/.well-known/agent-card.json')

      expect(res.status).toBe(401)
      const json = (await res.json()) as Json
      expect(json.error).toBe('Missing Authorization header')
    })

    it('returns agent card JSON on success', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))

      const res = await app.request('/api/a2a/agt_test1/.well-known/agent-card.json')

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      expect(json.name).toBe('Test Agent')
      expect(json.version).toBe('1.0.0')
      expect(buildAgentCard).toHaveBeenCalledWith(publishedAgent, expect.any(String))
      expect(mockSerializeAgentCard).toHaveBeenCalledWith(expect.anything(), '0.3')
    })

    it('returns the v1 card when the standard version header is present', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))

      const res = await app.request('/api/a2a/agt_test1/.well-known/agent-card.json', {
        headers: { 'A2A-Version': '1.0' },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('vary')).toContain('A2A-Version')
      expect(mockSerializeAgentCard).toHaveBeenCalledWith(expect.anything(), '1.0')
    })
  })

  describe('POST /:agentId', () => {
    it('returns 404 when agent does not exist', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/a2a/agt_missing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks.send', id: '1' }),
      })

      expect(res.status).toBe(404)
    })

    it('returns 403 when agent is not published', async () => {
      const draftAgent = { ...publishedAgent, publishStatus: 'draft' }
      ;(db.select as Mock).mockReturnValue(makeDbChain(draftAgent))

      const res = await app.request('/api/a2a/agt_test1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks.send', id: '1' }),
      })

      expect(res.status).toBe(403)
    })

    it('returns 403 when a2a channel is not enabled', async () => {
      const apiOnlyAgent = { ...publishedAgent, publishChannels: ['api'] }
      ;(db.select as Mock).mockReturnValue(makeDbChain(apiOnlyAgent))

      const res = await app.request('/api/a2a/agt_test1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks.send', id: '1' }),
      })

      expect(res.status).toBe(403)
    })

    it('returns JSON-RPC response for non-streaming result', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      mockHandle.mockResolvedValue({ jsonrpc: '2.0', id: '1', result: { status: 'completed' } })

      const res = await app.request('/api/a2a/agt_test1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks.send', id: '1' }),
      })

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      expect(json.jsonrpc).toBe('2.0')
      expect((json.result as Json).status).toBe('completed')
    })

    it('returns SSE stream for async generator result', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))

      async function* mockGenerator() {
        yield { jsonrpc: '2.0', id: '1', result: { state: 'working' } }
        yield { jsonrpc: '2.0', id: '1', result: { state: 'completed' } }
      }
      mockHandle.mockResolvedValue(mockGenerator())

      const res = await app.request('/api/a2a/agt_test1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks.sendSubscribe', id: '1' }),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
    })

    it('returns auth error when validateGatewayAuth fails', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        error: { error: 'Invalid token', status: 403 },
      })

      const res = await app.request('/api/a2a/agt_test1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks.send', id: '1' }),
      })

      expect(res.status).toBe(403)
      const json = (await res.json()) as Json
      expect(json.error).toBe('Invalid token')
    })

    it('handles null publishChannels as api-only (no a2a)', async () => {
      const nullChannelsAgent = { ...publishedAgent, publishChannels: null }
      ;(db.select as Mock).mockReturnValue(makeDbChain(nullChannelsAgent))

      const res = await app.request('/api/a2a/agt_test1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks.send', id: '1' }),
      })

      expect(res.status).toBe(403)
      const json = (await res.json()) as Json
      expect(json.error).toBe('A2A not enabled for this agent')
    })

    it('authenticates with the independent A2A auth fields, NOT the REST endpointApiKey', async () => {
      // Decoupling guard: A2A inbound must validate against a2aAuthType /
      // a2aEndpointApiKey, never the REST channel's publishAuthType/endpointApiKey.
      const agent = {
        ...publishedAgent,
        publishAuthType: 'none', // REST channel is public…
        endpointApiKey: null,
        a2aAuthType: 'api_key', // …but A2A requires its own key
        a2aEndpointApiKey: 'a2ak_secret',
      }
      ;(db.select as Mock).mockReturnValue(makeDbChain(agent))

      await app.request('/api/a2a/agt_test1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer a2ak_secret' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks.send', id: '1' }),
      })

      const passedAgent = (validateGatewayAuth as Mock).mock.calls[0][0]
      expect(passedAgent.publishAuthType).toBe('api_key')
      expect(passedAgent.endpointApiKey).toBe('a2ak_secret')
    })
  })
})
