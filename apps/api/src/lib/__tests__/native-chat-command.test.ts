import { beforeEach, describe, expect, it, vi } from 'vitest'
import { interceptNativeChatCommand } from '../native-chat-command.js'

const mockSelect = vi.hoisted(() => vi.fn())
vi.mock('../../db/client.js', () => ({ db: { select: () => mockSelect() } }))
vi.mock('../../db/schema.js', () => ({ agents: { id: 'agents.id' } }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockBuildReport = vi.hoisted(() => vi.fn())
vi.mock('../agent-self-report.js', () => ({
  buildAgentSelfReport: (agent: unknown) => mockBuildReport(agent),
  formatAgentSelfReport: (_r: unknown, lang: string) => `[${lang}] status`,
}))

const AGENT = {
  id: 'agt_1',
  userId: 'usr_1',
  name: 'Reviewer',
  commandReplyLanguage: 'auto',
}

function stubAgent(agent: unknown = AGENT) {
  mockSelect.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => (agent ? [agent] : []) }) }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  stubAgent()
  mockBuildReport.mockResolvedValue({})
})

describe('interceptNativeChatCommand', () => {
  it('answers /status without reaching the agent', async () => {
    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: '/status',
      chatType: 'p2p',
    })

    expect(r).toEqual({ handled: true, reply: '[en] status' })
  })

  it('works in a group chat, where a stalled queue is usually noticed', async () => {
    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: '/status',
      chatType: 'group',
    })

    expect(r.handled).toBe(true)
  })

  it('resolves the reply language from the agent setting', async () => {
    stubAgent({ ...AGENT, commandReplyLanguage: 'zh' })

    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: '/status',
      chatType: 'p2p',
    })

    expect(r).toEqual({ handled: true, reply: '[zh] status' })
  })

  it('resolves auto from the invoking message', async () => {
    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: '/状态',
      chatType: 'p2p',
    })

    expect(r).toEqual({ handled: true, reply: '[zh] status' })
  })

  it('leaves ordinary text alone', async () => {
    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: 'what is the status of the migration?',
      chatType: 'p2p',
    })

    expect(r).toEqual({ handled: false })
    expect(mockBuildReport).not.toHaveBeenCalled()
  })

  it('does not swallow a message that merely mentions the command mid-sentence', async () => {
    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: 'please run /status on the other bot',
      chatType: 'p2p',
    })

    expect(r).toEqual({ handled: false })
  })

  it('does not match a longer command that shares the prefix', async () => {
    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: '/statuses',
      chatType: 'p2p',
    })

    expect(r).toEqual({ handled: false })
  })

  it('falls through when the agent row is gone rather than replying with an error', async () => {
    stubAgent(null)

    const r = await interceptNativeChatCommand({
      agentId: 'agt_gone',
      text: '/status',
      chatType: 'p2p',
    })

    expect(r).toEqual({ handled: false })
  })

  it('reports a generic failure instead of leaking internals', async () => {
    mockBuildReport.mockRejectedValue(new Error('db down at 10.0.0.4:5432'))

    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: '/status',
      chatType: 'p2p',
    })

    expect(r).toMatchObject({ handled: true })
    expect(JSON.stringify(r)).not.toContain('10.0.0.4')
  })
})

describe('interceptNativeChatCommand — side-effecting commands', () => {
  it('strips /new and asks the caller to reset the session', async () => {
    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: '/new summarise yesterday',
      chatType: 'p2p',
    })

    expect(r).toEqual({ handled: false, intent: 'summarise yesterday', resetSession: true })
  })

  it('substitutes the fallback text for a bare /new so the run still has a prompt', async () => {
    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: '/new',
      chatType: 'p2p',
    })

    expect(r).toMatchObject({ handled: false, resetSession: true })
    expect((r as { intent?: string }).intent).toBeTruthy()
  })

  it('honours allowedContexts: /new is p2p-only, so a group message stays untouched', async () => {
    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: '/new start over',
      chatType: 'group',
    })

    expect(r).toEqual({ handled: false })
  })

  it('does not reset the session for ordinary text', async () => {
    const r = await interceptNativeChatCommand({
      agentId: 'agt_1',
      text: 'start a new thread please',
      chatType: 'p2p',
    })

    expect(r).toEqual({ handled: false })
  })
})
