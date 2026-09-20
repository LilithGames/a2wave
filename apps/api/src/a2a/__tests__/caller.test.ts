import type { Context } from 'hono'
/**
 * Tests for the small helpers exported from `caller.ts` after the unified
 * `RunChannelContext` migration.
 *
 * The legacy `extractA2ACallerInfo` was retired — its security responsibility
 * (refusing to honor `X-A2WAVE-Caller-Agent-*` under OAuth) now lives in
 * `buildGatewayChannel` and is covered by `lib/__tests__/run-channel.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  A2WAVE_CALLER_AGENT_ID_HEADER,
  A2WAVE_CALLER_AGENT_NAME_B64_HEADER,
  A2WAVE_CALLER_AGENT_NAME_HEADER,
  encodeCallerAgentNameHeader,
  extractCallerAgentFromHeaders,
  X_A2WAVE_CHANNEL_B64_HEADER,
} from '../caller.js'

function makeCtx(headers: Record<string, string> = {}): Context {
  return {
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
    },
  } as unknown as Context
}

describe('encodeCallerAgentNameHeader', () => {
  it('base64url-encodes ASCII names', async () => {
    const enc = encodeCallerAgentNameHeader('Router')
    // Decoding back is a stable round-trip check.
    expect(Buffer.from(enc, 'base64url').toString('utf8')).toBe('Router')
  })

  it('round-trips unicode (CJK + em-dash) without loss', async () => {
    const orig = '代理 — name with unicode'
    const enc = encodeCallerAgentNameHeader(orig)
    expect(Buffer.from(enc, 'base64url').toString('utf8')).toBe(orig)
  })

  it('produces base64url alphabet only (no +/= padding)', async () => {
    const enc = encodeCallerAgentNameHeader('?weird/name+stuff')
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('extractCallerAgentFromHeaders', () => {
  it('returns undefined when neither id nor name header is set', async () => {
    expect(extractCallerAgentFromHeaders(makeCtx({}))).toBeUndefined()
  })

  it('returns agentId only when only the id header is set', async () => {
    const out = extractCallerAgentFromHeaders(
      makeCtx({ [A2WAVE_CALLER_AGENT_ID_HEADER]: 'agt_router_1' }),
    )
    expect(out).toEqual({ agentId: 'agt_router_1' })
  })

  it('returns agentName only when only the plain name header is set', async () => {
    const out = extractCallerAgentFromHeaders(
      makeCtx({ [A2WAVE_CALLER_AGENT_NAME_HEADER]: 'Router' }),
    )
    expect(out).toEqual({ agentName: 'Router' })
  })

  it('returns both when id + plain name headers are set', async () => {
    const out = extractCallerAgentFromHeaders(
      makeCtx({
        [A2WAVE_CALLER_AGENT_ID_HEADER]: 'agt_x',
        [A2WAVE_CALLER_AGENT_NAME_HEADER]: 'X',
      }),
    )
    expect(out).toEqual({ agentId: 'agt_x', agentName: 'X' })
  })

  it('decodes base64url name header for unicode-safe transport', async () => {
    const encoded = encodeCallerAgentNameHeader('网关测试 Agent')
    const out = extractCallerAgentFromHeaders(
      makeCtx({
        [A2WAVE_CALLER_AGENT_ID_HEADER]: 'agt_gateway',
        [A2WAVE_CALLER_AGENT_NAME_B64_HEADER]: encoded,
      }),
    )
    expect(out).toEqual({ agentId: 'agt_gateway', agentName: '网关测试 Agent' })
  })

  it('plain name header takes precedence over base64 (when both present)', async () => {
    const encoded = encodeCallerAgentNameHeader('From-B64')
    const out = extractCallerAgentFromHeaders(
      makeCtx({
        [A2WAVE_CALLER_AGENT_NAME_HEADER]: 'From-Plain',
        [A2WAVE_CALLER_AGENT_NAME_B64_HEADER]: encoded,
      }),
    )
    expect(out).toEqual({ agentName: 'From-Plain' })
  })
})

describe('header constant exports', () => {
  it('exposes the wire-protocol constants other modules pin against', async () => {
    expect(A2WAVE_CALLER_AGENT_ID_HEADER).toBe('X-A2WAVE-Caller-Agent-Id')
    expect(A2WAVE_CALLER_AGENT_NAME_HEADER).toBe('X-A2WAVE-Caller-Agent-Name')
    expect(A2WAVE_CALLER_AGENT_NAME_B64_HEADER).toBe('X-A2WAVE-Caller-Agent-Name-B64')
    expect(X_A2WAVE_CHANNEL_B64_HEADER).toBe('X-A2WAVE-Channel-B64')
  })
})
