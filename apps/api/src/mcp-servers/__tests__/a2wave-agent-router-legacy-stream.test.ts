import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeAgentsParallelHandler, streamSSEWithCallback } from '../a2wave-agent-router.js'
import type { RouteTarget } from '../a2wave-agent-router.js'

beforeEach(() => {
  vi.restoreAllMocks()
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

    const result = await streamSSEWithCallback(res, (content) => updates.push(content))

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
    const callOrder: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const agentId = url.includes('agt_1') ? 'agt_1' : 'agt_2'
      const request = JSON.parse(init?.body as string)
      callOrder.push(`start:${agentId}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
      callOrder.push(`end:${agentId}`)
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            message: {
              messageId: `message-${agentId}`,
              role: 'ROLE_AGENT',
              parts: [{ text: `result from ${agentId}`, mediaType: 'text/plain' }],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
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
    expect((result as { isError?: boolean }).isError).toBeUndefined()
  })

  it('sets isError when any invocation fails', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      callCount++
      if (callCount === 1) {
        const request = JSON.parse(init?.body as string)
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              message: {
                messageId: 'message-ok',
                role: 'ROLE_AGENT',
                parts: [{ text: 'ok', mediaType: 'text/plain' }],
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
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

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('agt_1')
    expect(result.content[0].text).toContain('agt_2')
  })

  it('handles thrown errors gracefully', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const result = await invokeAgentsParallelHandler(
      { invocations: [{ agentId: 'agt_1', message: 'hello' }] },
      null,
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('Error: network down')
  })
})
