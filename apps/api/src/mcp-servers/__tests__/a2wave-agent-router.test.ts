import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/streaming-safe-fetch.js', async () => {
  const core = await vi.importActual<typeof import('../../lib/url-safety-core.js')>(
    '../../lib/url-safety-core.js',
  )
  return {
    parseTrustedHostnames: (raw?: string) => new Set((raw ?? '').split(',').filter(Boolean)),
    createStreamingSafeFetch:
      ({ allowPrivateTargets }: { allowPrivateTargets?: boolean }) =>
      (url: string | URL, init?: RequestInit) =>
        core.safeFetch(url.toString(), {
          ...init,
          validateHop: (hop) => {
            core.assertSafeHttpUrl(hop, { allowPrivateAddresses: allowPrivateTargets })
          },
        }),
  }
})
import {
  A2WAVE_CALLER_AGENT_NAME_B64_HEADER,
  encodeCallerAgentNameHeader,
} from '../../a2a/caller.js'
import { A2WAVE_CALLER_PROVENANCE_EXTENSION_URI } from '../../a2a/provenance.js'
import {
  collectSSEResult,
  getAgentCardHandler,
  invokeAgentHandler,
  invokeAgentsParallelHandler,
  listAgentsHandler,
  parseRouteTargets,
  streamSSEWithCallback,
} from '../a2wave-agent-router.js'
import type { RouteTarget } from '../a2wave-agent-router.js'

beforeEach(() => {
  vi.restoreAllMocks()
})

function mockFetch(response: {
  ok: boolean
  status?: number
  body?: unknown
  contentType?: string
}) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: () => Promise.resolve(response.body),
    text: () =>
      Promise.resolve(
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? ''),
      ),
    headers: new Headers({ 'content-type': response.contentType ?? 'application/json' }),
  }) as unknown as typeof fetch
}

function standardAgentCard(
  interfaceUrl: string,
  protocolVersion = '1.0',
  streaming = true,
  extensions: Array<Record<string, unknown>> = [],
) {
  return {
    name: 'Standard Agent',
    description: 'External standards-compatible agent',
    supportedInterfaces: [
      {
        url: interfaceUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion,
      },
    ],
    version: '1.0.0',
    capabilities: { streaming, extensions },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  }
}

function standardArtifactStream(text: string, id = 1) {
  return [
    `data: ${JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        artifactUpdate: {
          taskId: 'task-1',
          contextId: 'context-1',
          artifact: {
            artifactId: 'artifact-1',
            parts: [{ text, mediaType: 'text/plain' }],
          },
        },
      },
    })}`,
    '',
  ].join('\n')
}

describe('listAgentsHandler', () => {
  it('returns all agents when targets is null (legacy mode)', async () => {
    const agents = [
      {
        id: 'agt_1',
        name: 'Agent A',
        description: 'desc',
        publishDescription: null,
        a2aSkills: [],
      },
    ]
    mockFetch({ ok: true, body: { data: agents } })

    const result = await listAgentsHandler(null)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toEqual(agents)
  })

  it('returns empty array when no agents in legacy mode', async () => {
    mockFetch({ ok: true, body: { data: [] } })

    const result = await listAgentsHandler(null)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toEqual([])
  })

  it('throws on fetch failure in legacy mode', async () => {
    mockFetch({ ok: false, status: 500, body: 'Internal error' })

    await expect(listAgentsHandler(null)).rejects.toThrow('HTTP 500')
  })

  it('returns empty list when routeTargets is empty array', async () => {
    const result = await listAgentsHandler([])

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toEqual([])
  })

  it('filters local agents by configured agentId and passes ids param', async () => {
    const filteredAgents = [
      { id: 'agt_1', name: 'Agent A' },
      { id: 'agt_3', name: 'Agent C' },
    ]
    mockFetch({ ok: true, body: { data: filteredAgents } })

    const targets: RouteTarget[] = [
      { type: 'local', agentId: 'agt_1' },
      { type: 'local', agentId: 'agt_3' },
    ]

    const result = await listAgentsHandler(targets)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].id).toBe('agt_1')
    expect(parsed[1].id).toBe('agt_3')

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[0]).toContain('/api/internal/agents?ids=agt_1,agt_3')
  })

  it('includes remote agents with remote: prefix ID', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'external-qa',
        url: 'https://qa.example.com/a2a',
        description: 'QA Bot',
      },
    ]

    const result = await listAgentsHandler(targets)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual({
      id: 'remote:external-qa',
      name: 'external-qa',
      description: 'QA Bot',
      type: 'remote',
    })
  })

  it('combines local and remote agents', async () => {
    const filteredAgents = [{ id: 'agt_1', name: 'Agent A' }]
    mockFetch({ ok: true, body: { data: filteredAgents } })

    const targets: RouteTarget[] = [
      { type: 'local', agentId: 'agt_1' },
      {
        type: 'remote',
        name: 'remote-bot',
        url: 'https://remote.example.com',
        description: 'Remote',
      },
    ]

    const result = await listAgentsHandler(targets)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].id).toBe('agt_1')
    expect(parsed[1].id).toBe('remote:remote-bot')

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[0]).toContain('/api/internal/agents?ids=agt_1')
  })

  it('does not fetch from API when only remote targets configured', async () => {
    const targets: RouteTarget[] = [{ type: 'remote', name: 'bot', url: 'https://example.com' }]

    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await listAgentsHandler(targets)

    expect(spy).not.toHaveBeenCalled()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveLength(1)
  })
})

describe('getAgentCardHandler', () => {
  it('returns agent card for local agent', async () => {
    const card = { name: 'Agent A', description: 'desc', skills: [], capabilities: {} }
    mockFetch({ ok: true, body: card })

    const result = await getAgentCardHandler({ agentId: 'agt_1' }, null)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.name).toBe('Agent A')
  })

  it('throws when local agent not found', async () => {
    mockFetch({ ok: false, status: 404, body: { error: 'Agent not found' } })

    await expect(getAgentCardHandler({ agentId: 'agt_xxx' }, null)).rejects.toThrow('HTTP 404')
  })

  it('returns card from route config for remote agent', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'qa-bot',
        url: 'https://qa.example.com/a2a',
        description: 'QA assistant',
      },
    ]

    const result = await getAgentCardHandler({ agentId: 'remote:qa-bot' }, targets)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.name).toBe('qa-bot')
    expect(parsed.description).toBe('QA assistant')
    expect(parsed.url).toBe('https://qa.example.com/a2a')
    expect(parsed.type).toBe('remote')
  })

  it('discovers and returns a standard remote Agent Card', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'standard-bot',
        url: 'https://standard.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify(standardAgentCard('https://standard.example.com/a2a/jsonrpc')),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as unknown as typeof fetch

    const result = await getAgentCardHandler({ agentId: 'remote:standard-bot' }, targets)

    expect('isError' in result).toBe(false)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.name).toBe('Standard Agent')
    expect(parsed.supportedInterfaces[0]).toMatchObject({
      url: 'https://standard.example.com/a2a/jsonrpc',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    })
    expect(parsed.connectionMode).toBe('agent_card')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects an Agent Card whose declared size exceeds the discovery budget', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'oversized-card',
        url: 'https://standard.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '99999999' },
      }),
    ) as unknown as typeof fetch

    const result = await getAgentCardHandler({ agentId: 'remote:oversized-card' }, targets)

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('response limit')
  })

  it('rejects an unsafe JSON-RPC interface advertised by a public Agent Card', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'unsafe-card',
        url: 'https://standard.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(standardAgentCard('http://169.254.169.254/a2a')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch

    const result = await getAgentCardHandler({ agentId: 'remote:unsafe-card' }, targets)

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toMatch(/rejected/i)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('returns error when remote agent not in targets', async () => {
    const targets: RouteTarget[] = []

    const result = await getAgentCardHandler({ agentId: 'remote:unknown' }, targets)

    expect((result as any).isError).toBe(true)
    expect(result.content[0].text).toContain('not found')
  })
})

describe('invokeAgentHandler', () => {
  it('sends message/stream with messageId and kind fields for local agent', async () => {
    mockFetch({
      ok: true,
      body: { result: { artifacts: [], history: [] } },
    })

    await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.method).toBe('message/stream')
    expect(body.params.message.kind).toBe('message')
    expect(body.params.message.messageId).toBeDefined()
    expect(body.params.message.parts[0].kind).toBe('text')
  })

  it('includes X-Streaming-Card-Id header when env var is set', async () => {
    process.env.A2WAVE_STREAMING_CARD_ID = 'card_test_123'
    try {
      mockFetch({
        ok: true,
        body: { result: { artifacts: [], history: [] } },
      })

      await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(fetchCall[1].headers['X-Streaming-Card-Id']).toBe('card_test_123')
    } finally {
      delete process.env.A2WAVE_STREAMING_CARD_ID
    }
  })

  it('forwards caller agent headers with ascii-safe encoded name', async () => {
    process.env.A2WAVE_CALLER_AGENT_ID = 'agt_gateway'
    process.env.A2WAVE_CALLER_AGENT_NAME = '网关测试Agent'
    try {
      mockFetch({
        ok: true,
        body: { result: { artifacts: [], history: [] } },
      })

      await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(fetchCall[1].headers['X-A2WAVE-Caller-Agent-Id']).toBe('agt_gateway')
      expect(fetchCall[1].headers[A2WAVE_CALLER_AGENT_NAME_B64_HEADER]).toBe(
        encodeCallerAgentNameHeader('网关测试Agent'),
      )
    } finally {
      delete process.env.A2WAVE_CALLER_AGENT_ID
      delete process.env.A2WAVE_CALLER_AGENT_NAME
    }
  })

  it('does not include X-Streaming-Card-Id header when env var is not set', async () => {
    delete process.env.A2WAVE_STREAMING_CARD_ID

    mockFetch({
      ok: true,
      body: { result: { artifacts: [], history: [] } },
    })

    await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[1].headers['X-Streaming-Card-Id']).toBeUndefined()
  })

  it('extracts text from artifacts', async () => {
    mockFetch({
      ok: true,
      body: {
        result: {
          artifacts: [{ parts: [{ type: 'text', text: 'Hello from agent' }] }],
        },
      },
    })

    const result = await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    expect(result.content[0].text).toBe('Hello from agent')
  })

  it('extracts text from artifacts using kind field', async () => {
    mockFetch({
      ok: true,
      body: {
        result: {
          artifacts: [{ parts: [{ kind: 'text', text: 'Hello via kind' }] }],
        },
      },
    })

    const result = await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    expect(result.content[0].text).toBe('Hello via kind')
  })

  it('falls back to history when no artifacts', async () => {
    mockFetch({
      ok: true,
      body: {
        result: {
          artifacts: [],
          history: [
            { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
            { role: 'agent', parts: [{ type: 'text', text: 'Response from history' }] },
          ],
        },
      },
    })

    const result = await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    expect(result.content[0].text).toBe('Response from history')
  })

  it('returns raw result when no text found', async () => {
    const rawResult = { result: { artifacts: [], history: [] } }
    mockFetch({ ok: true, body: rawResult })

    const result = await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.result).toBeDefined()
  })

  it('throws on agent not found for local agent', async () => {
    mockFetch({ ok: false, status: 404, body: { error: 'Agent not found' } })

    await expect(invokeAgentHandler({ agentId: 'agt_xxx', message: 'hi' }, null)).rejects.toThrow(
      'HTTP 404',
    )
  })

  it('sends request to remote URL for remote agent', async () => {
    const targets: RouteTarget[] = [
      { type: 'remote', name: 'qa-bot', url: 'https://qa.example.com/a2a' },
    ]

    mockFetch({
      ok: true,
      body: {
        result: {
          artifacts: [{ parts: [{ type: 'text', text: 'Remote response' }] }],
        },
      },
    })

    const result = await invokeAgentHandler({ agentId: 'remote:qa-bot', message: 'test' }, targets)

    expect(result.content[0].text).toBe('Remote response')
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[0]).toBe('https://qa.example.com/a2a')
  })

  it('allows an ordinary private-network endpoint by default', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'internal-bot',
        url: 'http://10.20.30.40:8080/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            message: {
              messageId: 'internal-message',
              role: 'ROLE_AGENT',
              parts: [{ text: 'internal response', mediaType: 'text/plain' }],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:internal-bot', message: 'hello' },
      targets,
    )

    expect(result.content[0].text).toBe('internal response')
    expect(globalThis.fetch).toHaveBeenCalledWith('http://10.20.30.40:8080/a2a', expect.any(Object))
  })

  it('invokes a discovered v1.0 Agent Card JSON-RPC interface', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'v1-bot',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const spy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(standardArtifactStream('v1 standard response'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler({ agentId: 'remote:v1-bot', message: 'hello' }, targets)

    expect(result.content[0].text).toBe('v1 standard response')
    expect(spy).toHaveBeenCalledTimes(2)
    const rpcCall = spy.mock.calls[1]
    expect(rpcCall[0]).toBe('https://v1.example.com/a2a')
    const body = JSON.parse(rpcCall[1]?.body as string)
    expect(body.method).toBe('SendStreamingMessage')
    expect(body.params.message.role).toBe('ROLE_USER')
    expect(body.params.message.parts[0].text).toBe('hello')
    expect(new Headers(rpcCall[1]?.headers).get('A2A-Version')).toBe('1.0')
  })

  it('sends display-only provenance when a discovered v1 Agent Card supports it', async () => {
    const extensionUri = A2WAVE_CALLER_PROVENANCE_EXTENSION_URI
    vi.stubEnv('A2WAVE_CALLER_AGENT_ID', 'agt_sdk_manager')
    vi.stubEnv('A2WAVE_CALLER_AGENT_NAME', 'SDK Manager大神')
    vi.stubEnv(
      'A2WAVE_CHANNEL_B64',
      Buffer.from(
        JSON.stringify({
          channel_type: 'feishu',
          channel_info: { sender_open_id: 'ou_private' },
          user_info: {
            email: 'private@example.com',
            mobile: '13800000000',
            name: '张鑫',
            source: 'feishu',
            source_id: 'ou_private',
          },
          display_name: '张鑫',
        }),
        'utf8',
      ).toString('base64url'),
    )
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'provenance-v1',
          url: 'https://v1.example.com/cards/agent.json',
          connectionMode: 'agent_card',
        },
      ]
      const spy = vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/cards/agent.json')) {
          return new Response(
            JSON.stringify(
              standardAgentCard('https://v1.example.com/a2a', '1.0', true, [
                { uri: extensionUri, required: false },
              ]),
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(standardArtifactStream('provenance response'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })
      globalThis.fetch = spy as unknown as typeof fetch

      await invokeAgentHandler({ agentId: 'remote:provenance-v1', message: 'trace me' }, targets)

      const requestInit = spy.mock.calls[1][1] as RequestInit
      const body = JSON.parse(requestInit.body as string)
      expect(new Headers(requestInit.headers).get('A2A-Extensions')).toBe(extensionUri)
      expect(body.params.message.extensions).toEqual([extensionUri])
      expect(body.params.message.metadata).toEqual({
        [extensionUri]: {
          userName: '张鑫',
          callerAgent: { id: 'agt_sdk_manager', name: 'SDK Manager大神' },
        },
      })
      expect(JSON.stringify(body.params.message.metadata)).not.toContain('private@example.com')
      expect(JSON.stringify(body.params.message.metadata)).not.toContain('13800000000')
      expect(JSON.stringify(body.params.message.metadata)).not.toContain('ou_private')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('sends the caller Agent without inventing an original user name', async () => {
    const extensionUri = A2WAVE_CALLER_PROVENANCE_EXTENSION_URI
    vi.stubEnv('A2WAVE_CALLER_AGENT_ID', 'agt_automation')
    vi.stubEnv('A2WAVE_CALLER_AGENT_NAME', 'Automation Router')
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'agent-only-v1',
          url: 'https://v1.example.com/cards/agent.json',
          connectionMode: 'agent_card',
        },
      ]
      const spy = vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/cards/agent.json')) {
          return new Response(
            JSON.stringify(
              standardAgentCard('https://v1.example.com/a2a', '1.0', true, [
                { uri: extensionUri, required: false },
              ]),
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(standardArtifactStream('agent-only response'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })
      globalThis.fetch = spy as unknown as typeof fetch

      await invokeAgentHandler({ agentId: 'remote:agent-only-v1', message: 'run' }, targets)

      const body = JSON.parse(spy.mock.calls[1][1]?.body as string)
      expect(body.params.message.metadata).toEqual({
        [extensionUri]: {
          callerAgent: { id: 'agt_automation', name: 'Automation Router' },
        },
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not send provenance when a discovered Agent Card lacks extension support', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'plain-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    vi.stubEnv('A2WAVE_CALLER_AGENT_ID', 'agt_private')
    vi.stubEnv('A2WAVE_CALLER_AGENT_NAME', 'Private Router')
    try {
      const spy = vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/cards/agent.json')) {
          return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(standardArtifactStream('plain response'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })
      globalThis.fetch = spy as unknown as typeof fetch

      await invokeAgentHandler({ agentId: 'remote:plain-v1', message: 'hello' }, targets)

      const requestInit = spy.mock.calls[1][1] as RequestInit
      const body = JSON.parse(requestInit.body as string)
      expect(new Headers(requestInit.headers).has('A2A-Extensions')).toBe(false)
      expect(body.params.message).not.toHaveProperty('extensions')
      expect(body.params.message).not.toHaveProperty('metadata')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('accepts a completed standard stream with no text or artifacts', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'empty-complete-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const spy = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            task: {
              id: 'task-empty',
              contextId: 'context-empty',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [],
              history: [],
            },
          },
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:empty-complete-v1', message: 'do something with no output' },
      targets,
    )

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.result.task).toMatchObject({
      taskId: 'task-empty',
      contextId: 'context-empty',
    })
  })

  it('uses SendMessage when a discovered standard Agent Card disables streaming', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'non-streaming-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const spy = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(
          JSON.stringify(standardAgentCard('https://v1.example.com/a2a', '1.0', false)),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            message: {
              messageId: 'message-1',
              role: 'ROLE_AGENT',
              parts: [{ text: 'non-streaming response', mediaType: 'text/plain' }],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:non-streaming-v1', message: 'hello' },
      targets,
    )

    expect(result.content[0].text).toBe('non-streaming response')
    expect(JSON.parse(spy.mock.calls[1][1]?.body as string).method).toBe('SendMessage')
  })

  it('preserves a non-streaming input-required status as an actionable failure', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'input-required-v1',
        url: 'https://direct.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            task: {
              id: 'task-input',
              contextId: 'context-input',
              status: {
                state: 'TASK_STATE_INPUT_REQUIRED',
                message: {
                  messageId: 'ask-1',
                  role: 'ROLE_AGENT',
                  parts: [{ text: 'Which repository should I inspect?', mediaType: 'text/plain' }],
                },
              },
              artifacts: [],
              history: [],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:input-required-v1', message: 'inspect the code' },
      targets,
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('Remote task requires additional input')
    expect(result.content[0].text).toContain('Which repository should I inspect?')
    expect(result.content[0].text).toContain('taskId: task-input')
    expect(result.content[0].text).toContain('contextId: context-input')
  })

  it('returns an auth-required stream update without waiting for the stream to close', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'auth-required-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const cancelSpy = vi.fn()
    const encoder = new TextEncoder()
    const spy = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                result: {
                  statusUpdate: {
                    taskId: 'task-auth',
                    contextId: 'context-auth',
                    status: {
                      state: 'TASK_STATE_AUTH_REQUIRED',
                      message: {
                        messageId: 'auth-1',
                        role: 'ROLE_AGENT',
                        parts: [
                          { text: 'Authenticate with the remote service', mediaType: 'text/plain' },
                        ],
                      },
                    },
                  },
                },
              })}\n\n`,
            ),
          )
        },
        cancel: cancelSpy,
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await Promise.race([
      invokeAgentHandler(
        { agentId: 'remote:auth-required-v1', message: 'read remote data' },
        targets,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('auth-required response timed out')), 1000),
      ),
    ])

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('Remote task requires authentication')
    expect(result.content[0].text).toContain('Authenticate with the remote service')
    expect(result.content[0].text).toContain('taskId: task-auth')
    expect(result.content[0].text).toContain('contextId: context-auth')
    expect(cancelSpy).toHaveBeenCalledOnce()
  })

  it('merges standard artifact chunks by artifactId before extracting text', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'chunked-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const stream = `${[
      'data: {"jsonrpc":"2.0","id":1,"result":{"artifactUpdate":{"taskId":"task-1","contextId":"context-1","artifact":{"artifactId":"artifact-1","parts":[{"text":"Hel","mediaType":"text/plain"}]},"append":false,"lastChunk":false}}}',
      'data: {"jsonrpc":"2.0","id":1,"result":{"artifactUpdate":{"taskId":"task-1","contextId":"context-1","artifact":{"artifactId":"artifact-1","parts":[{"text":"lo","mediaType":"text/plain"}]},"append":true,"lastChunk":true}}}',
    ].join('\n\n')}\n\n`
    const spy = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:chunked-v1', message: 'hello' },
      targets,
    )

    expect(result.content[0].text).toBe('Hello')
  })

  it('uses configured credentials for same-origin Agent Card discovery and invocation', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'secure-v1',
        url: 'https://secure.example.com/cards/agent.json',
        connectionMode: 'agent_card',
        apiKey: 'secure-token',
      },
    ]
    const spy = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://secure.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(standardArtifactStream('secure response'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:secure-v1', message: 'hello' },
      targets,
    )

    expect(result.content[0].text).toBe('secure response')
    expect(new Headers(spy.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      'Bearer secure-token',
    )
    expect(new Headers(spy.mock.calls[1][1]?.headers).get('Authorization')).toBe(
      'Bearer secure-token',
    )
  })

  it('uses the v0.3 compatibility transport for a legacy discovered Agent Card', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'legacy-card-bot',
        url: 'https://legacy.example.com/.well-known/agent-card.json',
        connectionMode: 'agent_card',
      },
    ]
    const legacyCard = {
      name: 'Legacy Agent',
      description: 'v0.3 agent',
      url: 'https://legacy.example.com/a2a',
      protocolVersion: '0.3.0',
      version: '1.0.0',
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    }
    const legacyStream = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"artifact-update","taskId":"task-1","contextId":"context-1","artifact":{"artifactId":"artifact-1","parts":[{"kind":"text","text":"legacy response"}]}}}',
      '',
    ].join('\n')
    const spy = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('agent-card.json')) {
        return new Response(JSON.stringify(legacyCard), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(legacyStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:legacy-card-bot', message: 'hello' },
      targets,
    )

    expect(result.content[0].text).toBe('legacy response')
    const body = JSON.parse(spy.mock.calls[1][1]?.body as string)
    expect(body.method).toBe('message/stream')
    expect(body.params.message.kind).toBe('message')
    expect(new Headers(spy.mock.calls[1][1]?.headers).get('A2A-Version')).toBe('0.3')
  })

  it('supports a direct v1.0 endpoint without Agent Card discovery', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'direct-v1',
        url: 'https://direct.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    const spy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            message: {
              messageId: 'message-1',
              role: 'ROLE_AGENT',
              parts: [{ text: 'direct v1 response', mediaType: 'text/plain' }],
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:direct-v1', message: 'hello' },
      targets,
    )

    expect(result.content[0].text).toBe('direct v1 response')
    expect(spy).toHaveBeenCalledTimes(1)
    const body = JSON.parse(spy.mock.calls[0][1]?.body as string)
    expect(body.method).toBe('SendMessage')
  })

  it.each([
    {
      title: 'does not infer provenance support from direct A2A 1.0 alone',
      callerProvenance: undefined,
      shouldSend: false,
    },
    {
      title: 'sends provenance when the direct endpoint explicitly opts in',
      callerProvenance: true,
      shouldSend: true,
    },
  ])('$title', async ({ callerProvenance, shouldSend }) => {
    const extensionUri = A2WAVE_CALLER_PROVENANCE_EXTENSION_URI
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'direct-v1-provenance',
        url: 'https://direct.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
        ...(callerProvenance ? { callerProvenance } : {}),
      },
    ]
    vi.stubEnv('A2WAVE_CALLER_AGENT_ID', 'agt_direct_caller')
    vi.stubEnv('A2WAVE_CALLER_AGENT_NAME', 'Direct Caller')
    try {
      const spy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              message: {
                messageId: 'message-direct-provenance',
                role: 'ROLE_AGENT',
                parts: [{ text: 'direct provenance response', mediaType: 'text/plain' }],
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      globalThis.fetch = spy as unknown as typeof fetch

      await invokeAgentHandler(
        { agentId: 'remote:direct-v1-provenance', message: 'hello' },
        targets,
      )

      const requestInit = spy.mock.calls[0][1] as RequestInit
      const body = JSON.parse(requestInit.body as string)
      if (shouldSend) {
        expect(new Headers(requestInit.headers).get('A2A-Extensions')).toBe(extensionUri)
        expect(body.params.message).toMatchObject({
          extensions: [extensionUri],
          metadata: {
            [extensionUri]: {
              callerAgent: { id: 'agt_direct_caller', name: 'Direct Caller' },
            },
          },
        })
      } else {
        expect(new Headers(requestInit.headers).has('A2A-Extensions')).toBe(false)
        expect(body.params.message).not.toHaveProperty('extensions')
        expect(body.params.message).not.toHaveProperty('metadata')
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects a standard result whose declared size exceeds the result budget', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'oversized-result',
        url: 'https://direct.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '99999999' },
      }),
    ) as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:oversized-result', message: 'hello' },
      targets,
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('response limit')
  })

  it('marks a v1.0 JSON-RPC error as an MCP tool failure', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'protocol-error',
        url: 'https://error.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'Method not found' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    ) as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:protocol-error', message: 'hello' },
      targets,
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('Method not found')
  })

  it('marks a legacy JSON-RPC error response as an MCP tool failure', async () => {
    const targets: RouteTarget[] = [
      { type: 'remote', name: 'legacy-error', url: 'https://legacy.example.com/a2a' },
    ]
    mockFetch({
      ok: true,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
    })

    const result = await invokeAgentHandler(
      { agentId: 'remote:legacy-error', message: 'hello' },
      targets,
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toBe('A2A protocol error (-32601): Method not found')
  })

  it.each(['failed', 'canceled', 'rejected', 'auth-required', 'input-required'])(
    'marks a legacy JSON %s terminal task as an MCP tool failure',
    async (state) => {
      const targets: RouteTarget[] = [
        { type: 'remote', name: 'legacy-json-terminal', url: 'https://legacy.example.com/a2a' },
      ]
      mockFetch({
        ok: true,
        body: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            kind: 'task',
            id: 'task-1',
            contextId: 'context-1',
            status: { state },
            artifacts: [],
            history: [
              {
                kind: 'message',
                role: 'agent',
                parts: [{ kind: 'text', text: 'terminal JSON details' }],
              },
            ],
          },
        },
      })

      const result = await invokeAgentHandler(
        { agentId: 'remote:legacy-json-terminal', message: 'hello' },
        targets,
      )

      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(result.content[0].text).toContain('terminal JSON details')
    },
  )

  it.each(['failed', 'canceled', 'rejected', 'auth-required', 'input-required'])(
    'marks a legacy %s terminal task as an MCP tool failure',
    async (state) => {
      const targets: RouteTarget[] = [
        { type: 'remote', name: 'legacy-terminal', url: 'https://legacy.example.com/a2a' },
      ]
      const stream = [
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            kind: 'status-update',
            status: {
              state,
              message: {
                role: 'agent',
                parts: [{ kind: 'text', text: 'terminal details' }],
              },
            },
          },
        })}`,
        '',
      ].join('\n')
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ) as unknown as typeof fetch

      const result = await invokeAgentHandler(
        { agentId: 'remote:legacy-terminal', message: 'hello' },
        targets,
      )

      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(result.content[0].text).toContain('terminal details')
    },
  )

  it('returns a legacy interrupted status without waiting for stream EOF', async () => {
    const encoder = new TextEncoder()
    const cancelSpy = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                kind: 'status-update',
                taskId: 'task-input',
                contextId: 'context-input',
                status: {
                  state: 'input-required',
                  message: {
                    kind: 'message',
                    role: 'agent',
                    parts: [{ kind: 'text', text: 'Which repository?' }],
                  },
                },
              },
            })}\n\n`,
          ),
        )
      },
      cancel: cancelSpy,
    })

    const result = await Promise.race([
      streamSSEWithCallback(
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('legacy interrupted response timed out')), 1000),
      ),
    ])

    expect(result.failure).toBe('Remote task requires additional input')
    expect(result.result.history[0].parts[0].text).toBe('Which repository?')
    expect(cancelSpy).toHaveBeenCalledOnce()
  })

  it('SECURITY: rejects a remote target pointing at cloud metadata (SSRF)', async () => {
    const targets: RouteTarget[] = [
      { type: 'remote', name: 'evil', url: 'http://169.254.169.254/latest/meta-data/' },
    ]
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler({ agentId: 'remote:evil', message: 'x' }, targets)

    expect((result as any).isError).toBe(true)
    expect(result.content[0].text).toMatch(/rejected/i)
    // Crucially: the platform must NEVER have issued the outbound request.
    expect(spy).not.toHaveBeenCalled()
  })

  it.each([
    ['loopback', 'http://127.0.0.1:8080/a2a'],
    ['link-local', 'http://169.254.1.1/a2a'],
    ['localhost', 'http://localhost/a2a'],
    ['ipv6-loopback', 'http://[::1]/a2a'],
    ['non-http', 'file:///etc/passwd'],
  ])('SECURITY: rejects remote target (%s) without fetching', async (_label, url) => {
    const targets: RouteTarget[] = [{ type: 'remote', name: 'tgt', url }]
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler({ agentId: 'remote:tgt', message: 'x' }, targets)

    expect((result as any).isError).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('SECURITY: does not follow a 302 redirect into cloud metadata (redirect SSRF)', async () => {
    // The static target is a public URL the tenant controls; it replies 302 to an
    // internal metadata endpoint. Default fetch would follow it — the guard must
    // re-validate the Location, reject it, and never fetch the metadata host.
    const targets: RouteTarget[] = [
      { type: 'remote', name: 'redir', url: 'https://attacker.example.com/a2a' },
    ]
    const spy = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler({ agentId: 'remote:redir', message: 'x' }, targets)

    expect((result as any).isError).toBe(true)
    // Exactly one outbound request (the public URL); the metadata host was never hit.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('https://attacker.example.com/a2a')
    expect(spy.mock.calls[0][1].redirect).toBe('manual')
  })

  it('SECURITY: follows a safe public→public redirect chain', async () => {
    const targets: RouteTarget[] = [
      { type: 'remote', name: 'hop', url: 'https://a.example.com/a2a' },
    ]
    const spy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://b.example.com/a2a' }),
        text: () => Promise.resolve(''),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({ result: { artifacts: [{ parts: [{ type: 'text', text: 'ok' }] }] } }),
      })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler({ agentId: 'remote:hop', message: 'x' }, targets)

    expect(result.content[0].text).toBe('ok')
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1][0]).toBe('https://b.example.com/a2a')
  })

  it('SECURITY: strips configured credentials from cross-origin redirects', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'credential-hop',
        url: 'https://a.example.com/a2a',
        apiKey: 'secret-token',
      },
    ]
    const spy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'https://b.example.com/a2a' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: { artifacts: [{ parts: [{ type: 'text', text: 'ok' }] }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:credential-hop', message: 'x' },
      targets,
    )

    expect(result.content[0].text).toBe('ok')
    expect(new Headers(spy.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      'Bearer secret-token',
    )
    expect(new Headers(spy.mock.calls[1][1]?.headers).has('Authorization')).toBe(false)
  })

  it('SECURITY: refuses to send configured credentials to a cross-origin Card interface', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'credential-card',
        url: 'https://cards.example.com/agent.json',
        connectionMode: 'agent_card',
        apiKey: 'secret-token',
      },
    ]
    const spy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(standardAgentCard('https://runtime.example.com/a2a')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:credential-card', message: 'x' },
      targets,
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toMatch(/different origin/i)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(new Headers(spy.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      'Bearer secret-token',
    )
  })

  it('SECURITY: validates the same interface that ClientFactory selects from multiple v1 entries', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'multi-interface-card',
        url: 'https://cards.example.com/agent.json',
        connectionMode: 'agent_card',
        apiKey: 'secret-token',
      },
    ]
    const card = standardAgentCard('https://cards.example.com/first')
    card.supportedInterfaces.push({
      url: 'https://runtime.example.com/selected',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    })
    const spy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(card), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:multi-interface-card', message: 'x' },
      targets,
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toMatch(/different origin/i)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('parses SSE response and extracts artifact text from remote agent', async () => {
    const targets: RouteTarget[] = [
      { type: 'remote', name: 'sse-bot', url: 'https://sse.example.com/a2a' },
    ]

    const sseBody = [
      'data: {"jsonrpc":"2.0","result":{"kind":"status-update","taskId":"t1","status":{"state":"working"},"final":false}}',
      'data: {"jsonrpc":"2.0","result":{"kind":"artifact-update","taskId":"t1","artifact":{"parts":[{"kind":"text","text":"SSE result"}]}}}',
      'data: {"jsonrpc":"2.0","result":{"kind":"status-update","taskId":"t1","status":{"state":"completed"},"final":true},"id":"1"}',
      '',
    ].join('\n')

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(sseBody),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    }) as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:sse-bot', message: 'hello' },
      targets,
    )

    expect(result.content[0].text).toBe('SSE result')
  })

  it('includes Authorization header when apiKey is set', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'secure-bot',
        url: 'https://secure.example.com/a2a',
        apiKey: 'sk-test-123',
      },
    ]

    mockFetch({
      ok: true,
      body: { result: { artifacts: [{ parts: [{ type: 'text', text: 'ok' }] }] } },
    })

    await invokeAgentHandler({ agentId: 'remote:secure-bot', message: 'hello' }, targets)

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[1].headers.Authorization).toBe('Bearer sk-test-123')
  })

  it('does not include Authorization header when apiKey is not set', async () => {
    const targets: RouteTarget[] = [
      { type: 'remote', name: 'open-bot', url: 'https://open.example.com/a2a' },
    ]

    mockFetch({
      ok: true,
      body: { result: { artifacts: [{ parts: [{ type: 'text', text: 'ok' }] }] } },
    })

    await invokeAgentHandler({ agentId: 'remote:open-bot', message: 'hello' }, targets)

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[1].headers.Authorization).toBeUndefined()
  })

  it('does not disclose private a2wave context headers to a remote service', async () => {
    process.env.A2WAVE_STREAMING_CARD_ID = 'card-private'
    process.env.A2WAVE_CALLER_AGENT_ID = 'agt-private'
    process.env.A2WAVE_CALLER_AGENT_NAME = '私有 Agent'
    process.env.A2WAVE_CHANNEL_B64 = 'private-channel'
    try {
      const targets: RouteTarget[] = [
        { type: 'remote', name: 'external', url: 'https://external.example.com/a2a' },
      ]
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('external.example.com')) {
          return new Response(
            'data: {"jsonrpc":"2.0","result":{"kind":"artifact-update","artifact":{"parts":[{"kind":"text","text":"ok"}]}}}\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch

      await invokeAgentHandler({ agentId: 'remote:external', message: 'hello' }, targets)

      const remoteCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
        String(call[0]).includes('external.example.com'),
      )
      const headers = new Headers(remoteCall?.[1]?.headers)
      expect(headers.has('X-Streaming-Card-Id')).toBe(false)
      expect(headers.has('X-A2WAVE-Caller-Agent-Id')).toBe(false)
      expect(headers.has('X-A2WAVE-Caller-Agent-Name-B64')).toBe(false)
      expect(headers.has('X-A2WAVE-Channel-B64')).toBe(false)
    } finally {
      delete process.env.A2WAVE_STREAMING_CARD_ID
      delete process.env.A2WAVE_CALLER_AGENT_ID
      delete process.env.A2WAVE_CALLER_AGENT_NAME
      delete process.env.A2WAVE_CHANNEL_B64
    }
  })

  it('returns structured error for remote agent not in targets', async () => {
    const result = await invokeAgentHandler({ agentId: 'remote:unknown', message: 'hi' }, [])

    expect((result as any).isError).toBe(true)
    expect(result.content[0].text).toContain('not found')
  })

  it('sanitizes remoteName with special characters in childId for streaming card', async () => {
    process.env.A2WAVE_STREAMING_CARD_ID = 'card_special'
    try {
      const targets: RouteTarget[] = [
        { type: 'remote', name: 'bot/with#special?chars', url: 'https://special.example.com/a2a' },
      ]

      const sseBody = [
        'data: {"jsonrpc":"2.0","result":{"kind":"artifact-update","artifact":{"parts":[{"kind":"text","text":"ok"}]}}}',
        '',
      ].join('\n')

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('special.example.com')) {
          return {
            ok: true,
            status: 200,
            text: () => Promise.resolve(sseBody),
            headers: new Headers({ 'content-type': 'text/event-stream' }),
          }
        }
        return { ok: true, json: () => Promise.resolve({}) }
      })

      await invokeAgentHandler(
        { agentId: 'remote:bot/with#special?chars', message: 'test' },
        targets,
      )

      const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      const childCreateCall = fetchCalls.find(
        (c: any[]) => String(c[0]).includes('/child') && !String(c[0]).includes('/child/'),
      )
      expect(childCreateCall).toBeDefined()
      const body = JSON.parse(childCreateCall![1].body)
      expect(body.childId).toMatch(/^remote_bot_with_special_chars_\d+$/)
      expect(body.label).toBe('bot/with#special?chars')
    } finally {
      delete process.env.A2WAVE_STREAMING_CARD_ID
    }
  })

  it('returns structured error on remote network failure', async () => {
    const targets: RouteTarget[] = [
      { type: 'remote', name: 'down-bot', url: 'https://down.example.com/a2a' },
    ]

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await invokeAgentHandler(
      { agentId: 'remote:down-bot', message: 'hello' },
      targets,
    )

    expect((result as any).isError).toBe(true)
    expect(result.content[0].text).toContain('ECONNREFUSED')
    expect(result.content[0].text).toContain('down-bot')
  })

  it('uses message/stream method for remote agent', async () => {
    const targets: RouteTarget[] = [
      { type: 'remote', name: 'method-bot', url: 'https://method.example.com/a2a' },
    ]

    mockFetch({
      ok: true,
      body: { result: { artifacts: [{ parts: [{ type: 'text', text: 'ok' }] }] } },
    })

    await invokeAgentHandler({ agentId: 'remote:method-bot', message: 'hello' }, targets)

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.method).toBe('message/stream')
  })

  it('returns structured error when remote returns non-OK status', async () => {
    const targets: RouteTarget[] = [
      { type: 'remote', name: 'error-bot', url: 'https://error.example.com/a2a' },
    ]

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('Service Unavailable'),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:error-bot', message: 'hello' },
      targets,
    )

    expect((result as any).isError).toBe(true)
    expect(result.content[0].text).toContain('HTTP 503')
  })
})

describe('collectSSEResult', () => {
  function makeResponse(body: string) {
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }

  it('collects artifacts from SSE stream', async () => {
    const body = [
      'data: {"jsonrpc":"2.0","result":{"kind":"status-update","status":{"state":"working"}}}',
      'data: {"jsonrpc":"2.0","result":{"kind":"artifact-update","artifact":{"parts":[{"kind":"text","text":"final answer"}]}}}',
      'data: {"jsonrpc":"2.0","result":{"kind":"status-update","status":{"state":"completed"}}}',
      '',
    ].join('\n')

    const result = await collectSSEResult(makeResponse(body))
    expect(result.result.artifacts).toHaveLength(1)
    expect(result.result.artifacts[0].parts[0].text).toBe('final answer')
  })

  it('merges chunked legacy artifact updates before extracting text', async () => {
    const body = [
      'data: {"jsonrpc":"2.0","result":{"kind":"artifact-update","artifact":{"artifactId":"artifact-1","parts":[{"kind":"text","text":"hello"}]},"append":false,"lastChunk":false}}',
      'data: {"jsonrpc":"2.0","result":{"kind":"artifact-update","artifact":{"artifactId":"artifact-1","parts":[{"kind":"text","text":" world"}]},"append":true,"lastChunk":true}}',
      '',
    ].join('\n')

    const result = await collectSSEResult(makeResponse(body))
    const { extractTextFromA2AResponse } = await import('../a2wave-agent-router.js')

    expect(result.result.artifacts).toHaveLength(1)
    expect(result.result.artifacts[0].parts).toHaveLength(2)
    expect(extractTextFromA2AResponse(result).content[0].text).toBe('hello world')
  })

  it('collects working messages as history', async () => {
    const body = [
      'data: {"jsonrpc":"2.0","result":{"kind":"status-update","status":{"state":"working","message":{"role":"agent","parts":[{"kind":"text","text":"thinking..."}]}}}}',
      'data: {"jsonrpc":"2.0","result":{"kind":"status-update","status":{"state":"completed"}}}',
      '',
    ].join('\n')

    const result = await collectSSEResult(makeResponse(body))
    expect(result.result.history).toHaveLength(1)
    expect(result.result.history[0].parts[0].text).toBe('thinking...')
  })

  it('returns null for empty SSE stream', async () => {
    const result = await collectSSEResult(makeResponse(''))
    expect(result).toBeNull()
  })

  it('returns error event when present', async () => {
    const body = [
      'data: {"jsonrpc":"2.0","error":{"code":-32600,"message":"Bad request"}}',
      '',
    ].join('\n')

    const result = await collectSSEResult(makeResponse(body))
    expect(result.error.code).toBe(-32600)
  })

  it('skips non-JSON lines', async () => {
    const body = [
      ': comment',
      'data: not-json',
      'data: {"jsonrpc":"2.0","result":{"kind":"artifact-update","artifact":{"parts":[{"kind":"text","text":"ok"}]}}}',
      '',
    ].join('\n')

    const result = await collectSSEResult(makeResponse(body))
    expect(result.result.artifacts).toHaveLength(1)
    expect(result.result.artifacts[0].parts[0].text).toBe('ok')
  })

  it('works end-to-end with extractTextFromA2AResponse', async () => {
    const body = [
      'data: {"jsonrpc":"2.0","result":{"kind":"status-update","status":{"state":"working"}}}',
      'data: {"jsonrpc":"2.0","result":{"kind":"artifact-update","artifact":{"parts":[{"kind":"text","text":"Hello from agent"}]}}}',
      'data: {"jsonrpc":"2.0","result":{"kind":"status-update","status":{"state":"completed"}}}',
      '',
    ].join('\n')

    const sseResult = await collectSSEResult(makeResponse(body))
    const { extractTextFromA2AResponse } = await import('../a2wave-agent-router.js')
    const final = extractTextFromA2AResponse(sseResult)
    expect(final.content[0].text).toBe('Hello from agent')
  })
})

describe('parseRouteTargets', () => {
  it('returns null when env is undefined', async () => {
    expect(parseRouteTargets(undefined)).toBeNull()
  })

  it('returns null when env is empty string', async () => {
    expect(parseRouteTargets('')).toBeNull()
  })

  it('parses valid JSON', async () => {
    const targets = [{ type: 'local', agentId: 'agt_1' }]
    expect(parseRouteTargets(JSON.stringify(targets))).toEqual(targets)
  })

  it('returns null and logs error for invalid JSON', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseRouteTargets('not-json')).toBeNull()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'))
    spy.mockRestore()
  })
})

describe('streamSSEWithCallback', () => {
  function makeSSEResponse(lines: string[]): Response {
    const text = `${lines.join('\n')}\n`
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }

  it('calls onUpdate for each status-update event with text', async () => {
    const updates: string[] = []
    const res = makeSSEResponse([
      'data: {"result":{"kind":"status-update","status":{"state":"working","message":{"kind":"message","role":"agent","parts":[{"kind":"text","text":"hello"}]}}}}',
      'data: {"result":{"kind":"status-update","status":{"state":"working","message":{"kind":"message","role":"agent","parts":[{"kind":"text","text":"hello world"}]}}}}',
    ])

    const result = await streamSSEWithCallback(res, (content) => updates.push(content))

    expect(updates).toEqual(['hello', 'hello world'])
    expect(result.result.history).toHaveLength(2)
  })

  it('collects artifacts', async () => {
    const res = makeSSEResponse([
      'data: {"result":{"kind":"artifact-update","artifact":{"parts":[{"kind":"text","text":"final"}]}}}',
    ])

    const result = await streamSSEWithCallback(res)

    expect(result.result.artifacts).toHaveLength(1)
    expect(result.result.artifacts[0].parts[0].text).toBe('final')
  })

  it('merges append chunks for one legacy artifact', async () => {
    const res = makeSSEResponse([
      'data: {"result":{"kind":"artifact-update","artifact":{"artifactId":"artifact-1","parts":[{"kind":"text","text":"hello"}]},"append":false,"lastChunk":false}}',
      'data: {"result":{"kind":"artifact-update","artifact":{"artifactId":"artifact-1","parts":[{"kind":"text","text":" world"}]},"append":true,"lastChunk":true}}',
    ])

    const result = await streamSSEWithCallback(res)

    expect(result.result.artifacts).toHaveLength(1)
    expect(result.result.artifacts[0].parts.map((part: { text: string }) => part.text)).toEqual([
      'hello',
      ' world',
    ])
  })

  it('returns error events', async () => {
    const res = makeSSEResponse(['data: {"error":{"code":-32000,"message":"fail"}}'])

    const result = await streamSSEWithCallback(res)

    expect(result.error).toBeDefined()
  })

  it('returns null when no events', async () => {
    const res = makeSSEResponse(['', 'not-data-line'])

    const result = await streamSSEWithCallback(res)

    expect(result).toBeNull()
  })

  it('falls back to collectSSEResult when body is null', async () => {
    const res = {
      body: null,
      text: () =>
        Promise.resolve(
          [
            'data: {"result":{"kind":"artifact-update","artifact":{"artifactId":"artifact-1","parts":[{"kind":"text","text":"hello"}]},"append":false,"lastChunk":false}}',
            'data: {"result":{"kind":"artifact-update","artifact":{"artifactId":"artifact-1","parts":[{"kind":"text","text":" world"}]},"append":true,"lastChunk":true}}',
            '',
          ].join('\n'),
        ),
    } as unknown as Response

    const result = await streamSSEWithCallback(res)

    expect(result.result.artifacts).toHaveLength(1)
    expect(result.result.artifacts[0].parts).toHaveLength(2)
  })

  it('skips malformed JSON lines without throwing', async () => {
    const updates: string[] = []
    const res = makeSSEResponse([
      'data: not-json',
      'data: {"result":{"kind":"status-update","status":{"state":"working","message":{"kind":"message","role":"agent","parts":[{"kind":"text","text":"ok"}]}}}}',
    ])

    const result = await streamSSEWithCallback(res, (c) => updates.push(c))

    expect(updates).toEqual(['ok'])
    expect(result.result.history).toHaveLength(1)
  })

  it('processes remaining buffer that lacks trailing newline', async () => {
    const encoder = new TextEncoder()
    const chunk =
      'data: {"result":{"kind":"artifact-update","artifact":{"parts":[{"kind":"text","text":"buffered"}]}}}'
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const res = new Response(stream, { headers: { 'content-type': 'text/event-stream' } })

    const result = await streamSSEWithCallback(res)

    expect(result.result.artifacts).toHaveLength(1)
    expect(result.result.artifacts[0].parts[0].text).toBe('buffered')
  })

  it('calls onUpdate for status-update in remaining buffer', async () => {
    const updates: string[] = []
    const encoder = new TextEncoder()
    const chunk =
      'data: {"result":{"kind":"status-update","status":{"state":"working","message":{"kind":"message","role":"agent","parts":[{"kind":"text","text":"final update"}]}}}}'
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const res = new Response(stream, { headers: { 'content-type': 'text/event-stream' } })

    await streamSSEWithCallback(res, (content) => updates.push(content))

    expect(updates).toEqual(['final update'])
  })

  it('handles error in remaining buffer', async () => {
    const encoder = new TextEncoder()
    const chunk = 'data: {"error":{"code":-32000,"message":"oops"}}'
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const res = new Response(stream, { headers: { 'content-type': 'text/event-stream' } })

    const result = await streamSSEWithCallback(res)

    expect(result.error).toBeDefined()
    expect(result.error.code).toBe(-32000)
  })
})

describe('invokeAgentsParallelHandler', () => {
  it('runs multiple invocations concurrently and returns combined results', async () => {
    const targets: RouteTarget[] = [
      { type: 'local', agentId: 'agt_1' },
      { type: 'local', agentId: 'agt_2' },
    ]

    // Track call order to verify concurrency
    const callOrder: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const agentId = url.includes('agt_1') ? 'agt_1' : 'agt_2'
      callOrder.push(`start:${agentId}`)
      await new Promise((r) => setTimeout(r, 10))
      callOrder.push(`end:${agentId}`)
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            result: { artifacts: [{ parts: [{ kind: 'text', text: `result from ${agentId}` }] }] },
          }),
        text: () => Promise.resolve(''),
        headers: new Headers({ 'content-type': 'application/json' }),
      }
    })

    const result = await invokeAgentsParallelHandler(
      {
        invocations: [
          { agentId: 'agt_1', message: 'hello' },
          { agentId: 'agt_2', message: 'world' },
        ],
      },
      targets,
    )

    expect(result.content[0].text).toContain('result from agt_1')
    expect(result.content[0].text).toContain('result from agt_2')
    expect((result as any).isError).toBeUndefined()
  })

  it('sets isError when any invocation fails', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({ result: { artifacts: [{ parts: [{ kind: 'text', text: 'ok' }] }] } }),
          text: () => Promise.resolve(''),
          headers: new Headers({ 'content-type': 'application/json' }),
        }
      }
      return {
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
        headers: new Headers({ 'content-type': 'text/plain' }),
      }
    })

    const result = await invokeAgentsParallelHandler(
      {
        invocations: [
          { agentId: 'agt_1', message: 'hello' },
          { agentId: 'agt_2', message: 'world' },
        ],
      },
      null,
    )

    expect((result as any).isError).toBe(true)
    expect(result.content[0].text).toContain('agt_1')
    expect(result.content[0].text).toContain('agt_2')
  })

  it('handles thrown errors gracefully', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const result = await invokeAgentsParallelHandler(
      {
        invocations: [{ agentId: 'agt_1', message: 'hello' }],
      },
      null,
    )

    expect((result as any).isError).toBe(true)
    expect(result.content[0].text).toContain('Error: network down')
  })
})
