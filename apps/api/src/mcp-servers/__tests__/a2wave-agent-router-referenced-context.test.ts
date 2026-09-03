import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
          validateHop: (hop) =>
            core.assertSafeHttpUrl(hop, { allowPrivateAddresses: allowPrivateTargets }),
        }),
  }
})

import {
  A2WAVE_REFERENCED_CONTEXT_ENV,
  A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI,
} from '../../a2a/referenced-context.js'
import type { RouteTarget } from '../a2wave-agent-router.js'
import { invokeAgentHandler } from '../a2wave-agent-router.js'

const extensionUri = A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.unstubAllEnvs())

function standardAgentCard(interfaceUrl: string, extensions: Array<Record<string, unknown>> = []) {
  return {
    name: 'Standard Agent',
    description: 'External standards-compatible agent',
    supportedInterfaces: [
      { url: interfaceUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
    version: '1.0.0',
    capabilities: { streaming: true, extensions },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  }
}

function standardArtifactStream(text: string) {
  const events = [
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        artifactUpdate: {
          taskId: 'task-reference',
          contextId: 'context-reference',
          artifact: {
            artifactId: 'artifact-reference',
            parts: [{ text, mediaType: 'text/plain' }],
          },
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        statusUpdate: {
          taskId: 'task-reference',
          contextId: 'context-reference',
          status: { state: 'TASK_STATE_COMPLETED' },
        },
      },
    },
  ]
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`
}

function setReferencedContext(value: Record<string, unknown>) {
  vi.stubEnv(
    A2WAVE_REFERENCED_CONTEXT_ENV,
    Buffer.from(JSON.stringify(value)).toString('base64url'),
  )
}

function remoteTarget(name: string, overrides: Partial<RouteTarget> = {}): RouteTarget {
  return {
    type: 'remote',
    name,
    url: 'https://v1.example.com/cards/agent.json',
    connectionMode: 'agent_card',
    ...overrides,
  }
}

function mockRemoteWithReference(
  referencedExtension: Record<string, unknown> = { uri: extensionUri, required: false },
) {
  const spy = vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith('/cards/agent.json')) {
      return new Response(
        JSON.stringify(standardAgentCard('https://v1.example.com/a2a', [referencedExtension])),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(standardArtifactStream('peer response'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

describe('A2A referenced-context router forwarding', () => {
  it('forwards opted-in referenced context to a local Agent over A2A v1', async () => {
    const referencedContext = { source: 'feishu', text: 'Local quoted alert' }
    setReferencedContext(referencedContext)
    const spy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string)
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            message: { messageId: 'result', role: 'ROLE_AGENT', parts: [{ text: 'done' }] },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = spy as unknown as typeof fetch

    await invokeAgentHandler({
      agentId: 'agt_1',
      message: 'Analyze it',
      includeReferencedContext: true,
    })

    const call = spy.mock.calls[0]
    const body = JSON.parse(call[1].body)
    expect(new Headers(call[1].headers).get('A2A-Extensions')).toBe(extensionUri)
    expect(body.params.message.metadata).toEqual({ [extensionUri]: referencedContext })
  })

  it('forwards context only when opted in and advertised by a remote Agent Card', async () => {
    const referencedContext = {
      source: 'feishu',
      text: 'Grafana alert: payment callback timed out.',
      messageId: 'om_alert',
      messageType: 'interactive',
      senderType: 'app',
      truncated: false,
    }
    setReferencedContext(referencedContext)
    const spy = mockRemoteWithReference()

    await invokeAgentHandler(
      {
        agentId: 'remote:referenced-v1',
        message: 'Analyze the quoted alert',
        includeReferencedContext: true,
      },
      [remoteTarget('referenced-v1')],
    )

    const call = spy.mock.calls[1]
    const body = JSON.parse(call[1].body)
    expect(new Headers(call[1].headers).get('A2A-Extensions')).toBe(extensionUri)
    expect(body.params.message.extensions).toEqual([extensionUri])
    expect(body.params.message.metadata).toEqual({ [extensionUri]: referencedContext })
  })

  it('truncates context to the smaller limit advertised by the remote Agent Card', async () => {
    const referencedContext = {
      source: 'feishu',
      text: '0123456789abcdef',
      messageId: 'om_alert',
      truncated: false,
    }
    setReferencedContext(referencedContext)
    const spy = mockRemoteWithReference({
      uri: extensionUri,
      required: false,
      params: { maxTextChars: 8 },
    })

    await invokeAgentHandler(
      {
        agentId: 'remote:bounded-reference-v1',
        message: 'Analyze',
        includeReferencedContext: true,
      },
      [remoteTarget('bounded-reference-v1')],
    )

    const body = JSON.parse(spy.mock.calls[1][1].body)
    expect(body.params.message.metadata[extensionUri]).toEqual({
      ...referencedContext,
      text: '01234567',
      truncated: true,
    })
  })

  it('rejects an invalid referenced-context limit advertised by a remote Agent Card', async () => {
    setReferencedContext({ source: 'feishu', text: 'Alert body' })
    const spy = mockRemoteWithReference({
      uri: extensionUri,
      required: false,
      params: { maxTextChars: 0 },
    })

    const result = await invokeAgentHandler(
      {
        agentId: 'remote:invalid-reference-limit',
        message: 'Analyze',
        includeReferencedContext: true,
      },
      [remoteTarget('invalid-reference-limit')],
    )

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0].text).toContain('invalid referenced-context text limit')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not forward available context unless the tool call opts in', async () => {
    setReferencedContext({ source: 'feishu', text: 'Private alert body' })
    const spy = mockRemoteWithReference()

    await invokeAgentHandler({ agentId: 'remote:reference-default-off', message: 'hello' }, [
      remoteTarget('reference-default-off'),
    ])

    const call = spy.mock.calls[1]
    const body = JSON.parse(call[1].body)
    expect(new Headers(call[1].headers).has('A2A-Extensions')).toBe(false)
    expect(body.params.message).not.toHaveProperty('extensions')
    expect(body.params.message).not.toHaveProperty('metadata')
  })

  it('errors before transport when opted-in context is unavailable', async () => {
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:missing-reference', message: 'Analyze', includeReferencedContext: true },
      [remoteTarget('missing-reference')],
    )

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0].text).toContain('referenced context is unavailable')
    expect(spy).not.toHaveBeenCalled()
  })

  it('errors when the discovered peer lacks referenced-context support', async () => {
    setReferencedContext({ source: 'feishu', text: 'Alert body' })
    const spy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      {
        agentId: 'remote:no-reference-support',
        message: 'Analyze',
        includeReferencedContext: true,
      },
      [remoteTarget('no-reference-support')],
    )

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0].text).toContain('does not advertise referenced-context support')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('sends context to a direct v1 endpoint only after explicit route opt-in', async () => {
    const referencedContext = { source: 'feishu', text: 'Direct quoted alert' }
    setReferencedContext(referencedContext)
    const spy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            message: { messageId: 'result', role: 'ROLE_AGENT', parts: [{ text: 'done' }] },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    globalThis.fetch = spy as unknown as typeof fetch

    await invokeAgentHandler(
      { agentId: 'remote:direct-v1-reference', message: 'Analyze', includeReferencedContext: true },
      [
        remoteTarget('direct-v1-reference', {
          url: 'https://direct.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
          referencedContext: true,
        }),
      ],
    )

    const call = spy.mock.calls[0]
    const body = JSON.parse(call[1].body)
    expect(new Headers(call[1].headers).get('A2A-Extensions')).toBe(extensionUri)
    expect(body.params.message.metadata).toEqual({ [extensionUri]: referencedContext })
  })
})
