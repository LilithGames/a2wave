import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPreviousSession = vi.hoisted(() => vi.fn())

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => {
              const row = mockPreviousSession()
              return Promise.resolve(row == null ? [] : [row])
            },
          }),
        }),
      }),
    }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  runs: {
    id: {},
    result: {},
    conversationId: {},
    initiatorAgentId: {},
    triggerSource: {},
    triggerSessionId: {},
    status: {},
    createdAt: {},
  },
}))

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  lt: vi.fn(() => ({})),
}))

import type { GatewayCaller } from '../../middleware/gateway-auth.js'
import { buildOAuthTriggerSessionId, resolveOAuthConversation } from '../oauth-session.js'

function caller(input: { issuer: string; sub: string }): GatewayCaller {
  return {
    kind: 'idaas_user',
    userInfo: {
      issuer: input.issuer,
      sub: input.sub,
    },
  } as GatewayCaller
}

describe('oauth-session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPreviousSession.mockReturnValue(undefined)
  })

  it('isolates the same client session id by agent and OAuth user', async () => {
    const base = buildOAuthTriggerSessionId({
      agentId: 'agt_1',
      caller: caller({ issuer: 'https://idaas.example.com/', sub: 'user_1' }),
      sessionId: 'sess_shared',
    })

    expect(base).toMatch(/^oauth:[a-f0-9]{32}$/)
    expect(
      buildOAuthTriggerSessionId({
        agentId: 'agt_2',
        caller: caller({ issuer: 'https://idaas.example.com/', sub: 'user_1' }),
        sessionId: 'sess_shared',
      }),
    ).not.toBe(base)
    expect(
      buildOAuthTriggerSessionId({
        agentId: 'agt_1',
        caller: caller({ issuer: 'https://idaas.example.com/', sub: 'user_2' }),
        sessionId: 'sess_shared',
      }),
    ).not.toBe(base)
    expect(
      buildOAuthTriggerSessionId({
        agentId: 'agt_1',
        caller: caller({ issuer: 'https://other-issuer.example.com/', sub: 'user_1' }),
        sessionId: 'sess_shared',
      }),
    ).not.toBe(base)
  })

  it('starts a new conversation without a recoverable completed session', async () => {
    await expect(
      resolveOAuthConversation({
        agentId: 'agt_1',
        triggerSessionId: 'oauth:key',
        runId: 'run_new',
        resetSession: false,
      }),
    ).resolves.toEqual({ previousChatId: null, conversationId: 'run_new' })
  })

  it('starts a standalone conversation when the caller omitted sessionId', async () => {
    await expect(
      resolveOAuthConversation({
        agentId: 'agt_1',
        runId: 'run_new',
        resetSession: false,
      }),
    ).resolves.toEqual({ previousChatId: null, conversationId: 'run_new' })
    expect(mockPreviousSession).not.toHaveBeenCalled()
  })

  it('continues the persisted conversation of the previous completed session', async () => {
    mockPreviousSession.mockReturnValue({
      id: 'run_previous',
      result: { chatId: 'chat_previous' },
      conversationId: 'run_first',
    })

    await expect(
      resolveOAuthConversation({
        agentId: 'agt_1',
        triggerSessionId: 'oauth:key',
        runId: 'run_new',
        resetSession: false,
      }),
    ).resolves.toEqual({ previousChatId: 'chat_previous', conversationId: 'run_first' })
  })

  it('uses the previous run id for a legacy conversation row', async () => {
    mockPreviousSession.mockReturnValue({
      id: 'run_previous',
      result: { chatId: 'chat_previous' },
      conversationId: null,
    })

    await expect(
      resolveOAuthConversation({
        agentId: 'agt_1',
        triggerSessionId: 'oauth:key',
        runId: 'run_new',
        resetSession: false,
      }),
    ).resolves.toEqual({ previousChatId: 'chat_previous', conversationId: 'run_previous' })
  })

  it('starts a new conversation on explicit reset without looking up the old one', async () => {
    mockPreviousSession.mockReturnValue({
      id: 'run_previous',
      result: { chatId: 'chat_previous' },
      conversationId: 'run_first',
    })

    await expect(
      resolveOAuthConversation({
        agentId: 'agt_1',
        triggerSessionId: 'oauth:key',
        runId: 'run_new',
        resetSession: true,
      }),
    ).resolves.toEqual({ previousChatId: null, conversationId: 'run_new' })
    expect(mockPreviousSession).not.toHaveBeenCalled()
  })
})
