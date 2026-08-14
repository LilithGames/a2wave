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
  createRouterInvocationHandlers,
  getAgentCardHandler,
  invokeAgentHandler,
  streamSSEWithCallback,
} from '../a2wave-agent-router.js'
import type { RouteTarget } from '../a2wave-agent-router.js'
import { createRouterInvocationRegistry } from '../agent-router-lifecycle.js'

beforeEach(() => {
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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

function standardArtifactStream(text: string, id = 1, includeTerminalStatus = true) {
  const events = [
    JSON.stringify({
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
    }),
  ]
  if (includeTerminalStatus) {
    events.push(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          statusUpdate: {
            taskId: 'task-1',
            contextId: 'context-1',
            status: { state: 'TASK_STATE_COMPLETED' },
          },
        },
      }),
    )
  }
  return `${events.map((event) => `data: ${event}`).join('\n\n')}\n\n`
}

function mockStandardJsonRpcResult(result: Record<string, unknown>) {
  globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const request = JSON.parse(init?.body as string)
    const responseResult = request.method === 'GetTask' && 'task' in result ? result.task : result
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result: responseResult }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    )
  }) as unknown as typeof fetch
}

function completedStandardTask(
  overrides: {
    artifacts?: unknown[]
    history?: unknown[]
  } = {},
) {
  return {
    task: {
      id: 'task-local',
      contextId: 'context-local',
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: overrides.artifacts ?? [],
      history: overrides.history ?? [],
    },
  }
}

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
  it('inherits the caller signal without adding an independent five-minute local deadline', async () => {
    const caller = new AbortController()
    mockStandardJsonRpcResult({
      message: {
        messageId: 'message-local',
        role: 'ROLE_AGENT',
        parts: [{ text: 'done', mediaType: 'text/plain' }],
      },
    })

    await invokeAgentHandler({ agentId: 'agt_1', message: 'long-running work' }, null, {
      signal: caller.signal,
    })

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[1].signal).toBe(caller.signal)
  })

  it('cancels a known local Task when the parent invocation is canceled', async () => {
    const methods: string[] = []
    const spy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      const state = request.method === 'CancelTask' ? 'TASK_STATE_CANCELED' : 'TASK_STATE_WORKING'
      const task = {
        id: 'task-local-cancel',
        contextId: 'context-local-cancel',
        status: { state },
        artifacts: [],
        history: [],
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'SendMessage' ? { task } : task,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = spy as unknown as typeof fetch
    const caller = new AbortController()
    caller.abort(new Error('parent run canceled'))

    const result = await invokeAgentHandler(
      { agentId: 'agt_1', message: 'stop with the parent' },
      null,
      { signal: caller.signal },
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('task-local-cancel')
    expect(methods).toEqual(['SendMessage', 'CancelTask'])
  })

  it('starts a durable local Task with the standard SendMessage method', async () => {
    mockStandardJsonRpcResult({
      message: {
        messageId: 'message-local',
        role: 'ROLE_AGENT',
        parts: [{ text: 'done', mediaType: 'text/plain' }],
      },
    })

    await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.method).toBe('SendMessage')
    expect(body.params.message.role).toBe('ROLE_USER')
    expect(body.params.message.messageId).toBeDefined()
    expect(body.params.message.parts[0].text).toBe('hi')
    expect(body.params.configuration.returnImmediately).toBe(true)
  })

  it('rejects an oversized local Task response before the SDK buffers its JSON body', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string)
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            message: {
              messageId: 'message-oversized-local',
              role: 'ROLE_AGENT',
              parts: [
                { text: 'small body with an oversized declared length', mediaType: 'text/plain' },
              ],
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(16 * 1024 * 1024 + 1),
          },
        },
      )
    }) as unknown as typeof fetch

    await expect(
      invokeAgentHandler({ agentId: 'agt_1', message: 'return a bounded result' }, null),
    ).rejects.toThrow('Remote A2A result exceeds the 16777216-byte response limit')
  })

  it('includes X-Streaming-Card-Id header when env var is set', async () => {
    process.env.A2WAVE_STREAMING_CARD_ID = 'card_test_123'
    try {
      mockStandardJsonRpcResult({
        message: {
          messageId: 'message-local',
          role: 'ROLE_AGENT',
          parts: [{ text: 'done', mediaType: 'text/plain' }],
        },
      })

      await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(new Headers(fetchCall[1].headers).get('X-Streaming-Card-Id')).toBe('card_test_123')
    } finally {
      delete process.env.A2WAVE_STREAMING_CARD_ID
    }
  })

  it('forwards caller agent headers with ascii-safe encoded name', async () => {
    process.env.A2WAVE_CALLER_AGENT_ID = 'agt_gateway'
    process.env.A2WAVE_CALLER_AGENT_NAME = '网关测试Agent'
    try {
      mockStandardJsonRpcResult({
        message: {
          messageId: 'message-local',
          role: 'ROLE_AGENT',
          parts: [{ text: 'done', mediaType: 'text/plain' }],
        },
      })

      await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(new Headers(fetchCall[1].headers).get('X-A2WAVE-Caller-Agent-Id')).toBe('agt_gateway')
      expect(new Headers(fetchCall[1].headers).get(A2WAVE_CALLER_AGENT_NAME_B64_HEADER)).toBe(
        encodeCallerAgentNameHeader('网关测试Agent'),
      )
    } finally {
      delete process.env.A2WAVE_CALLER_AGENT_ID
      delete process.env.A2WAVE_CALLER_AGENT_NAME
    }
  })

  it('does not include X-Streaming-Card-Id header when env var is not set', async () => {
    delete process.env.A2WAVE_STREAMING_CARD_ID

    mockStandardJsonRpcResult({
      message: {
        messageId: 'message-local',
        role: 'ROLE_AGENT',
        parts: [{ text: 'done', mediaType: 'text/plain' }],
      },
    })

    await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(new Headers(fetchCall[1].headers).has('X-Streaming-Card-Id')).toBe(false)
  })

  it('extracts text from artifacts', async () => {
    mockStandardJsonRpcResult(
      completedStandardTask({
        artifacts: [
          {
            artifactId: 'artifact-local',
            parts: [{ text: 'Hello from agent', mediaType: 'text/plain' }],
          },
        ],
      }),
    )

    const result = await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    expect(result.content[0].text).toBe('Hello from agent')
  })

  it('extracts text from artifacts using kind field', async () => {
    mockStandardJsonRpcResult(
      completedStandardTask({
        artifacts: [
          {
            artifactId: 'artifact-kind',
            parts: [{ kind: 'text', text: 'Hello via kind', mediaType: 'text/plain' }],
          },
        ],
      }),
    )

    const result = await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    expect(result.content[0].text).toBe('Hello via kind')
  })

  it('falls back to history when no artifacts', async () => {
    mockStandardJsonRpcResult(
      completedStandardTask({
        history: [
          {
            messageId: 'user-message',
            role: 'ROLE_USER',
            parts: [{ text: 'hi', mediaType: 'text/plain' }],
          },
          {
            messageId: 'agent-message',
            role: 'ROLE_AGENT',
            parts: [{ text: 'Response from history', mediaType: 'text/plain' }],
          },
        ],
      }),
    )

    const result = await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    expect(result.content[0].text).toBe('Response from history')
  })

  it('returns raw result when no text found', async () => {
    mockStandardJsonRpcResult(completedStandardTask())

    const result = await invokeAgentHandler({ agentId: 'agt_1', message: 'hi' }, null)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.result.task.taskId).toBe('task-local')
  })

  it('throws on agent not found for local agent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch

    await expect(invokeAgentHandler({ agentId: 'agt_xxx', message: 'hi' }, null)).rejects.toThrow(
      'Status: 404',
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

    const caller = new AbortController()
    const result = await invokeAgentHandler(
      { agentId: 'remote:qa-bot', message: 'test' },
      targets,
      { signal: caller.signal },
    )

    expect(result.content[0].text).toBe('Remote response')
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[0]).toBe('https://qa.example.com/a2a')
    expect(fetchCall[1].signal).toBe(caller.signal)
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
    const spy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const request = JSON.parse(init?.body as string)
      if (request.method === 'GetTask') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              id: 'task-empty',
              contextId: 'context-empty',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [],
              history: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
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

  it('polls a non-terminal standard Task until it completes without resending the message', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'long-running-v1',
        url: 'https://direct.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    const methods: string[] = []
    const spy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      const task =
        request.method === 'GetTask'
          ? {
              id: 'task-long',
              contextId: 'context-long',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [
                {
                  artifactId: 'artifact-long',
                  parts: [{ text: 'completed after polling', mediaType: 'text/plain' }],
                },
              ],
              history: [],
            }
          : {
              id: 'task-long',
              contextId: 'context-long',
              status: { state: 'TASK_STATE_WORKING' },
              artifacts: [],
              history: [],
            }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'SendMessage' ? { task } : task,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:long-running-v1', message: 'take your time' },
      targets,
    )

    expect(result.content[0].text).toBe('completed after polling')
    expect(methods).toEqual(['SendMessage', 'GetTask'])
  })

  it('recovers by Task ID when a stream closes after only an artifact update', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'artifact-eof-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const methods: string[] = []
    const spy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      if (request.method === 'SendStreamingMessage') {
        return new Response(standardArtifactStream('partial artifact', request.id, false), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      const task = {
        id: 'task-1',
        contextId: 'context-1',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [
          {
            artifactId: 'artifact-final',
            parts: [{ text: 'recovered after clean EOF', mediaType: 'text/plain' }],
          },
        ],
        history: [],
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: task }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:artifact-eof-v1', message: 'finish the Task after this stream' },
      targets,
    )

    expect(result.content[0].text).toBe('recovered after clean EOF')
    expect(methods).toEqual(['SendStreamingMessage', 'GetTask'])
  })

  it('forwards unchanged polling progress only once', async () => {
    vi.useFakeTimers()
    process.env.A2WAVE_STREAMING_CARD_ID = 'card_poll_dedup'
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'poll-progress-v1',
          url: 'https://direct.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      let getTaskCalls = 0
      const updates: string[] = []
      const spy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/internal/streaming-card/')) {
          if (init?.method === 'PUT') {
            updates.push(JSON.parse(init.body as string).content)
          }
          return new Response('{}', { status: 200 })
        }
        const request = JSON.parse(init?.body as string)
        if (request.method === 'GetTask') getTaskCalls += 1
        const completed = getTaskCalls >= 2
        const task = {
          id: 'task-progress',
          contextId: 'context-progress',
          status: {
            state: completed ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING',
            ...(!completed && {
              message: {
                messageId: 'progress-message',
                role: 'ROLE_AGENT',
                parts: [{ text: 'Still working', mediaType: 'text/plain' }],
              },
            }),
          },
          artifacts: completed
            ? [
                {
                  artifactId: 'artifact-progress',
                  parts: [{ text: 'finished', mediaType: 'text/plain' }],
                },
              ]
            : [],
          history: [],
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: request.method === 'SendMessage' ? { task } : task,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })
      globalThis.fetch = spy as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:poll-progress-v1', message: 'report progress without duplicates' },
        targets,
      )
      await vi.advanceTimersByTimeAsync(1_001)
      const result = await invocation

      expect(result.content[0].text).toBe('finished')
      expect(updates).toEqual(['Still working'])
    } finally {
      Reflect.deleteProperty(process.env, 'A2WAVE_STREAMING_CARD_ID')
      vi.useRealTimers()
    }
  })

  it('does not write remote error details into lifecycle stderr', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'safe-lifecycle-log-v1',
          url: 'https://direct.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      let getTaskCalls = 0
      const spy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        if (request.method === 'GetTask') {
          getTaskCalls += 1
          if (getTaskCalls === 1) {
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32603, message: 'must-not-log-api-key-or-request-body' },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }
        }
        const task = {
          id: 'task-safe-log',
          contextId: 'context-safe-log',
          status: {
            state: request.method === 'SendMessage' ? 'TASK_STATE_WORKING' : 'TASK_STATE_COMPLETED',
          },
          artifacts:
            request.method === 'SendMessage'
              ? []
              : [
                  {
                    artifactId: 'artifact-safe-log',
                    parts: [{ text: 'finished safely', mediaType: 'text/plain' }],
                  },
                ],
          history: [],
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: request.method === 'SendMessage' ? { task } : task,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })
      globalThis.fetch = spy as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:safe-lifecycle-log-v1', message: 'keep this request private' },
        targets,
      )
      await vi.advanceTimersByTimeAsync(1_001)
      const result = await invocation
      const emittedStderr = stderr.mock.calls.flat().join('\n')

      expect(result.content[0].text).toBe('finished safely')
      expect(emittedStderr).toContain('a2a.task.poll_retry')
      expect(emittedStderr).not.toContain('must-not-log-api-key-or-request-body')
      expect(emittedStderr).not.toContain('keep this request private')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a known standard Task when the parent invocation is canceled', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'cancel-v1',
        url: 'https://direct.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    const methods: string[] = []
    const spy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      const state = request.method === 'CancelTask' ? 'TASK_STATE_CANCELED' : 'TASK_STATE_WORKING'
      const task = {
        id: 'task-cancel',
        contextId: 'context-cancel',
        status: { state },
        artifacts: [],
        history: [],
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'SendMessage' ? { task } : task,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = spy as unknown as typeof fetch
    const caller = new AbortController()
    caller.abort(new Error('parent run canceled'))

    const result = await invokeAgentHandler(
      { agentId: 'remote:cancel-v1', message: 'stop with the parent' },
      targets,
      { signal: caller.signal },
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('task-cancel')
    expect(methods).toEqual(['SendMessage', 'CancelTask'])
  })

  it('cancels the downstream Task when the parent aborts during polling', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'poll-cancel-v1',
        url: 'https://direct.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    const caller = new AbortController()
    const methods: string[] = []
    const spy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      const task = {
        id: 'task-poll-cancel',
        contextId: 'context-poll-cancel',
        status: {
          state: request.method === 'CancelTask' ? 'TASK_STATE_CANCELED' : 'TASK_STATE_WORKING',
        },
        artifacts: [],
        history: [],
      }
      if (request.method === 'GetTask') {
        caller.abort(new Error('parent run timed out'))
        throw new Error('poll interrupted')
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'SendMessage' ? { task } : task,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:poll-cancel-v1', message: 'stop if the parent times out' },
      targets,
      { signal: caller.signal },
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('task-poll-cancel')
    expect(methods).toEqual(['SendMessage', 'GetTask', 'CancelTask'])
  })

  it('cancels a known Task when the Agent Router process starts shutting down', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'process-timeout-v1',
        url: 'https://direct.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    const registry = createRouterInvocationRegistry()
    const handlers = createRouterInvocationHandlers(targets, registry)
    const methods: string[] = []
    const pollingStarted = deferred<void>()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const spy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      const task = {
        id: 'task-process-timeout',
        contextId: 'context-process-timeout',
        status: {
          state: request.method === 'CancelTask' ? 'TASK_STATE_CANCELED' : 'TASK_STATE_WORKING',
        },
        artifacts: [],
        history: [],
      }
      if (request.method === 'GetTask') {
        pollingStarted.resolve()
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason ?? new Error('poll canceled')),
            { once: true },
          )
        })
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'SendMessage' ? { task } : task,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const invocation = handlers.invokeAgent(
      { agentId: 'remote:process-timeout-v1', message: 'long-running work' },
      {},
    )
    await pollingStarted.promise
    await registry.shutdown(new Error('Claude Code execution timed out'))

    const result = await invocation
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('task-process-timeout')
    expect(methods).toEqual(['SendMessage', 'GetTask', 'CancelTask'])
    expect(timeoutSpy).toHaveBeenCalledWith(3_000)
  })

  it('stops retrying a permanent Task lifecycle protocol error', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'unsupported-task-v1',
          url: 'https://direct.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      const methods: string[] = []
      const spy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        if (request.method === 'SendMessage') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                task: {
                  id: 'task-unsupported',
                  contextId: 'context-unsupported',
                  status: { state: 'TASK_STATE_WORKING' },
                  artifacts: [],
                  history: [],
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        const message =
          request.method === 'CancelTask'
            ? 'cleanup cancellation failed'
            : request.method === 'SubscribeToTask'
              ? 'resubscription is not supported'
              : 'original Task recovery failure'
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })
      globalThis.fetch = spy as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:unsupported-task-v1', message: 'do not retry forever' },
        targets,
        { signal: caller.signal },
      )
      await vi.advanceTimersByTimeAsync(3_001)
      caller.abort(new Error('test cleanup'))
      const result = await invocation

      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(result.content[0].text).toContain('task-unsupported')
      expect(result.content[0].text).toContain('original Task recovery failure')
      expect(result.content[0].text).not.toContain('cleanup cancellation failed')
      expect(methods).toEqual([
        'SendMessage',
        'GetTask',
        'SubscribeToTask',
        'GetTask',
        'CancelTask',
      ])
    } finally {
      caller.abort(new Error('test cleanup'))
      vi.useRealTimers()
    }
  })

  it('recovers instead of polling forever after a malformed Task response', async () => {
    vi.useFakeTimers()
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'malformed-task-v1',
          url: 'https://direct.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      const methods: string[] = []
      let getTaskCalls = 0
      const spy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        if (request.method === 'SendMessage') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                task: {
                  id: 'task-malformed',
                  contextId: 'context-malformed',
                  status: { state: 'TASK_STATE_WORKING' },
                  artifacts: [],
                  history: [],
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (request.method === 'SubscribeToTask') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32601, message: 'SubscribeToTask is not supported' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        getTaskCalls += 1
        if (getTaskCalls === 1) {
          return new Response('{not-json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        const task = {
          id: 'task-malformed',
          contextId: 'context-malformed',
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [
            {
              artifactId: 'artifact-malformed',
              parts: [{ text: 'recovered after malformed response', mediaType: 'text/plain' }],
            },
          ],
          history: [],
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: task }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
      globalThis.fetch = spy as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:malformed-task-v1', message: 'recover by Task ID' },
        targets,
      )
      await vi.advanceTimersByTimeAsync(1_001)
      const result = await invocation

      expect(result.content[0].text).toBe('recovered after malformed response')
      expect(methods).toEqual(['SendMessage', 'GetTask', 'SubscribeToTask', 'GetTask'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a valid JSON null Task response as deterministic instead of retrying it', async () => {
    vi.useFakeTimers()
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'null-task-v1',
          url: 'https://direct.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      const methods: string[] = []
      let getTaskCalls = 0
      const spy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        if (request.method === 'SendMessage') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                task: {
                  id: 'task-null',
                  contextId: 'context-null',
                  status: { state: 'TASK_STATE_WORKING' },
                  artifacts: [],
                  history: [],
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (request.method === 'GetTask') {
          getTaskCalls += 1
          if (getTaskCalls === 1) {
            return new Response('null', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
        }
        const task = {
          id: 'task-null',
          contextId: 'context-null',
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [
            {
              artifactId: 'artifact-null',
              parts: [{ text: 'recovered after null response', mediaType: 'text/plain' }],
            },
          ],
          history: [],
        }
        if (request.method === 'SubscribeToTask') {
          return new Response(
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { task },
            })}\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: task }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
      globalThis.fetch = spy as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:null-task-v1', message: 'recover by Task ID' },
        targets,
      )
      await vi.advanceTimersByTimeAsync(1_001)
      const result = await invocation

      expect(result.content[0].text).toBe('recovered after null response')
      expect(methods).toEqual(['SendMessage', 'GetTask', 'SubscribeToTask'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('enforces one cumulative event budget across submission and resubscription', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'cumulative-budget-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const methods: string[] = []
    const encoder = new TextEncoder()
    const statusEvent = (id: number, state = 'TASK_STATE_WORKING') =>
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          statusUpdate: {
            taskId: 'task-cumulative-budget',
            contextId: 'context-cumulative-budget',
            status: { state },
          },
        },
      })}\n\n`
    const spy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      if (request.method === 'CancelTask') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              id: 'task-cumulative-budget',
              contextId: 'context-cumulative-budget',
              status: { state: 'TASK_STATE_CANCELED' },
              artifacts: [],
              history: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (request.method === 'SendStreamingMessage') {
        let sent = false
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true
                controller.enqueue(
                  encoder.encode(
                    Array.from({ length: 6_000 }, () => statusEvent(request.id)).join(''),
                  ),
                )
                return
              }
              controller.error(new Error('connection reset after the initial event budget'))
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      const events = Array.from({ length: 5_000 }, () => statusEvent(request.id))
      events.push(statusEvent(request.id, 'TASK_STATE_COMPLETED'))
      return new Response(events.join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:cumulative-budget-v1', message: 'respect one invocation budget' },
      targets,
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('10000-event limit')
    expect(methods).toEqual(['SendStreamingMessage', 'SubscribeToTask', 'CancelTask'])
  })

  it('falls back to GetTask when a resubscription stays idle without replaying the message', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'reconnect-v1',
          url: 'https://v1.example.com/cards/agent.json',
          connectionMode: 'agent_card',
        },
      ]
      const methods: string[] = []
      const encoder = new TextEncoder()
      const spy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/cards/agent.json')) {
          return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        if (request.method === 'SendStreamingMessage') {
          let sentWorking = false
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!sentWorking) {
                  sentWorking = true
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        jsonrpc: '2.0',
                        id: request.id,
                        result: {
                          statusUpdate: {
                            taskId: 'task-reconnect',
                            contextId: 'context-reconnect',
                            status: { state: 'TASK_STATE_WORKING' },
                          },
                        },
                      })}\n\n`,
                    ),
                  )
                  return
                }
                controller.error(new Error('connection reset'))
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        if (request.method === 'SubscribeToTask') {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener(
                  'abort',
                  () => controller.error(new Error('resubscription aborted')),
                  { once: true },
                )
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        const task = {
          id: 'task-reconnect',
          contextId: 'context-reconnect',
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [
            {
              artifactId: 'artifact-reconnect',
              parts: [{ text: 'recovered result', mediaType: 'text/plain' }],
            },
          ],
          history: [],
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: task }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
      globalThis.fetch = spy as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:reconnect-v1', message: 'survive a disconnect' },
        targets,
        { signal: caller.signal },
      )
      await vi.advanceTimersByTimeAsync(30_001)
      const observedMethods = [...methods]
      caller.abort(new Error('test cleanup'))
      const result = await invocation

      expect(result.content[0].text).toBe('recovered result')
      expect(observedMethods).toEqual(['SendStreamingMessage', 'SubscribeToTask', 'GetTask'])
    } finally {
      caller.abort(new Error('test cleanup'))
      vi.useRealTimers()
    }
  })

  it('treats an idle stream with a known Task ID as a reconnect signal', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'idle-v1',
          url: 'https://v1.example.com/cards/agent.json',
          connectionMode: 'agent_card',
        },
      ]
      const methods: string[] = []
      const encoder = new TextEncoder()
      const spy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/cards/agent.json')) {
          return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        if (request.method === 'SendStreamingMessage') {
          let sentWorking = false
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sentWorking) return
                sentWorking = true
                init?.signal?.addEventListener(
                  'abort',
                  () => controller.error(new Error('stream aborted')),
                  { once: true },
                )
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      jsonrpc: '2.0',
                      id: request.id,
                      result: {
                        statusUpdate: {
                          taskId: 'task-idle',
                          contextId: 'context-idle',
                          status: { state: 'TASK_STATE_WORKING' },
                        },
                      },
                    })}\n\n`,
                  ),
                )
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return new Response(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              task: {
                id: 'task-idle',
                contextId: 'context-idle',
                status: { state: 'TASK_STATE_COMPLETED' },
                artifacts: [
                  {
                    artifactId: 'artifact-idle',
                    parts: [{ text: 'recovered after idle', mediaType: 'text/plain' }],
                  },
                ],
                history: [],
              },
            },
          })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      })
      globalThis.fetch = spy as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:idle-v1', message: 'recover an idle stream' },
        targets,
        { signal: caller.signal },
      )
      await vi.advanceTimersByTimeAsync(30_001)
      const observedMethods = [...methods]
      caller.abort(new Error('test cleanup'))
      const result = await invocation

      expect(result.content[0].text).toBe('recovered after idle')
      expect(observedMethods).toEqual(['SendStreamingMessage', 'SubscribeToTask'])
    } finally {
      caller.abort(new Error('test cleanup'))
      vi.useRealTimers()
    }
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

  it('returns a message-only stream result without waiting for stream EOF', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'message-only-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const cancelSpy = vi.fn()
    const encoder = new TextEncoder()
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const request = JSON.parse(init?.body as string)
      const requestSignal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal?.addEventListener(
            'abort',
            () => controller.error(requestSignal.reason ?? new Error('request aborted')),
            { once: true },
          )
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  message: {
                    messageId: 'message-only-result',
                    role: 'ROLE_AGENT',
                    parts: [{ text: 'final message response', mediaType: 'text/plain' }],
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
    }) as unknown as typeof fetch
    const caller = new AbortController()
    const cleanupTimer = setTimeout(
      () => caller.abort(new Error('message-only regression cleanup')),
      100,
    )

    const result = await invokeAgentHandler(
      { agentId: 'remote:message-only-v1', message: 'return one message' },
      targets,
      { signal: caller.signal },
    )
    clearTimeout(cleanupTimer)

    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(result.content[0].text).toBe('final message response')
    expect(cancelSpy).toHaveBeenCalledOnce()
  })

  it('merges standard artifact chunks without reserializing accumulated output', async () => {
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
      'data: {"jsonrpc":"2.0","id":1,"result":{"artifactUpdate":{"taskId":"task-1","contextId":"context-1","artifact":{"artifactId":"artifact-1","parts":[{"text":"lo","mediaType":"text/plain"}]},"append":true,"lastChunk":false}}}',
      'data: {"jsonrpc":"2.0","id":1,"result":{"artifactUpdate":{"taskId":"task-1","contextId":"context-1","artifact":{"artifactId":"artifact-1","parts":[{"text":"!","mediaType":"text/plain"}]},"append":true,"lastChunk":true}}}',
      'data: {"jsonrpc":"2.0","id":1,"result":{"statusUpdate":{"taskId":"task-1","contextId":"context-1","status":{"state":"TASK_STATE_COMPLETED"}}}}',
    ].join('\n\n')}\n\n`
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
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
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const serializedArtifactPartCounts: number[] = []
    const originalStringify = JSON.stringify
    vi.spyOn(JSON, 'stringify').mockImplementation(((
      ...args: Parameters<typeof JSON.stringify>
    ) => {
      const [value] = args
      if (
        typeof value === 'object' &&
        value !== null &&
        'artifactId' in value &&
        value.artifactId === 'artifact-1' &&
        'parts' in value &&
        Array.isArray(value.parts)
      ) {
        serializedArtifactPartCounts.push(value.parts.length)
      }
      return originalStringify(...args)
    }) as typeof JSON.stringify)

    const result = await invokeAgentHandler(
      { agentId: 'remote:chunked-v1', message: 'hello' },
      targets,
    )

    expect(result.content[0].text).toBe('Hello!')
    expect(serializedArtifactPartCounts.length).toBeGreaterThan(0)
    expect(Math.max(...serializedArtifactPartCounts)).toBe(1)
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
    const legacyStream = `${[
      'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"artifact-update","taskId":"task-1","contextId":"context-1","artifact":{"artifactId":"artifact-1","parts":[{"kind":"text","text":"legacy response"}]}}}',
      'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update","taskId":"task-1","contextId":"context-1","status":{"state":"completed"},"final":true}}',
    ].join('\n\n')}\n\n`
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
