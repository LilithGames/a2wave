import { beforeEach, describe, expect, it, vi } from 'vitest'
import { statusCommandPlugin } from '../status.js'

const mockBuildReport = vi.hoisted(() => vi.fn())
vi.mock('../../../../agent-self-report.js', () => ({
  buildAgentSelfReport: (agent: unknown) => mockBuildReport(agent),
  formatAgentSelfReport: (report: { rendered?: string }, lang: string) =>
    `[${lang}] ${report.rendered ?? 'report'}`,
}))

const AGENT = { id: 'agt_1', userId: 'usr_1', commandReplyLanguage: 'auto' }

function respondCtx(overrides: Record<string, unknown> = {}) {
  return {
    commandName: 'status',
    agentEngineType: 'claude-code',
    rawText: '/status',
    strippedText: '',
    agent: AGENT,
    ...overrides,
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildReport.mockResolvedValue({ rendered: 'report' })
})

describe('statusCommandPlugin', () => {
  it('matches both the English and Chinese prefixes', () => {
    expect(statusCommandPlugin.prefixes).toContain('/status')
    expect(statusCommandPlugin.prefixes).toContain('/状态')
  })

  it('is available in every context, including group chats', () => {
    // Unlike /new, a status query is equally meaningful in a shared channel.
    expect(statusCommandPlugin.allowedContexts).toBeUndefined()
  })

  it('answers from the report rather than reaching the LLM', async () => {
    const answer = await statusCommandPlugin.respond?.(respondCtx())

    expect(mockBuildReport).toHaveBeenCalledWith(AGENT)
    expect(answer).toBe('[en] report')
  })

  it('honours an explicit agent language setting', async () => {
    const answer = await statusCommandPlugin.respond?.(
      respondCtx({ agent: { ...AGENT, commandReplyLanguage: 'zh' } }),
    )

    expect(answer).toBe('[zh] report')
  })

  it('resolves auto from the invoking message', async () => {
    const answer = await statusCommandPlugin.respond?.(
      respondCtx({ rawText: '/状态', strippedText: '' }),
    )

    expect(answer).toBe('[zh] report')
  })

  it('has no session or run-config side effects', () => {
    // A status query must not reset the conversation the user is having.
    expect(statusCommandPlugin.emptyTextFallback).toBeUndefined()
    expect(statusCommandPlugin.longRunningAck).toBeUndefined()
  })
})
