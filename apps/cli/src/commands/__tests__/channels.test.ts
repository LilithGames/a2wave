import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPatch = vi.fn()
const mockResolveAgentId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    patch: mockPatch,
    resolveAgentId: mockResolveAgentId,
  }),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(() => '{"appId":"cli_x","appSecret":"s"}') }
})

const { channelsCommand } = await import('../channels.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
function sub(name: string): TestSubCommand {
  return (channelsCommand.subCommands as Record<string, TestSubCommand>)[name]
}

describe('channelsCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveAgentId.mockResolvedValue('agt_1')
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('set', () => {
    it('patches one channel with a config file body', async () => {
      mockPatch.mockResolvedValueOnce({ data: { id: 'agt_1' } })
      await sub('set').run({
        args: { agent: 'bot', channel: 'feishu', 'config-file': './feishu.json' },
      })
      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1/channels/feishu', {
        config: { appId: 'cli_x', appSecret: 's' },
      })
    })

    it('builds the body from repeatable --set key=value pairs', async () => {
      mockPatch.mockResolvedValueOnce({ data: { id: 'agt_1' } })
      await sub('set').run({
        args: {
          agent: 'bot',
          channel: 'chat_app',
          set: ['welcomeMessage=hi', 'showThinking=false'],
        },
      })
      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1/channels/chat_app', {
        config: { welcomeMessage: 'hi', showThinking: false },
      })
    })

    it('rejects a channel with no saveable config, naming the valid ones', async () => {
      await expect(
        sub('set').run({ args: { agent: 'bot', channel: 'api', set: ['x=1'] } }),
      ).rejects.toThrow(/feishu/)
      expect(mockPatch).not.toHaveBeenCalled()
    })

    it('requires a config source', async () => {
      await expect(sub('set').run({ args: { agent: 'bot', channel: 'feishu' } })).rejects.toThrow(
        /--set|--config-file/,
      )
    })

    it('rejects both config sources at once', async () => {
      await expect(
        sub('set').run({
          args: { agent: 'bot', channel: 'feishu', set: ['a=1'], 'config-file': './x.json' },
        }),
      ).rejects.toThrow(/--set|--config-file/)
    })
  })

  describe('chat-app', () => {
    it('reads the published chat page profile', async () => {
      mockGet.mockResolvedValueOnce({
        data: { id: 'agt_1', name: 'Bot', welcomeMessage: 'hi', suggestedQuestions: ['a'] },
      })
      await sub('chat-app').run({ args: { agent: 'bot' } })
      expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_1/chat-app')
      expect(consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('hi')
    })

    it('emits the raw payload under --json', async () => {
      mockGet.mockResolvedValueOnce({ data: { id: 'agt_1', name: 'Bot' } })
      await sub('chat-app').run({ args: { agent: 'bot', json: true } })
      expect(JSON.parse(String(consoleSpy.mock.calls[0][0])).data.id).toBe('agt_1')
    })
  })
})
