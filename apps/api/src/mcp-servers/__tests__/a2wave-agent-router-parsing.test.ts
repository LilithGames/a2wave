import { describe, expect, it, vi } from 'vitest'
import {
  collectSSEResult,
  extractTextFromA2AResponse,
  parseRouteTargets,
} from '../a2wave-agent-router.js'

function makeResponse(body: string) {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

describe('collectSSEResult', () => {
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

    const result = await collectSSEResult(makeResponse(body))
    expect(extractTextFromA2AResponse(result).content[0].text).toBe('Hello from agent')
  })
})

describe('parseRouteTargets', () => {
  it('returns null when env is undefined', () => {
    expect(parseRouteTargets(undefined)).toBeNull()
  })

  it('returns null when env is empty string', () => {
    expect(parseRouteTargets('')).toBeNull()
  })

  it('parses valid JSON', () => {
    const targets = [{ type: 'local', agentId: 'agt_1' }]
    expect(parseRouteTargets(JSON.stringify(targets))).toEqual(targets)
  })

  it('returns null and logs error for invalid JSON', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseRouteTargets('not-json')).toBeNull()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'))
    spy.mockRestore()
  })
})
