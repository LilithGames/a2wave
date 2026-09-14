import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPost = vi.fn()
// Publish consults GET /diagnose first; a clean report keeps these tests about
// the publish body itself. The preflight has its own file.
const mockGet = vi.fn(async () => ({ data: { ok: true, checks: [] } }))
const mockResolveAgentId = vi.fn(async (n: string) =>
  n.startsWith('agt_') ? n : `agt_resolved_${n}`,
)

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    resolveAgentId: mockResolveAgentId,
  }),
}))

const { agentsCommand } = await import('../agents.js')

type SubCmd = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
const subs = agentsCommand.subCommands as Record<string, SubCmd>

describe('agents lifecycle commands', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('publish', () => {
    it('POSTs /publish with empty body when no flags given (server defaults apply)', async () => {
      mockPost.mockResolvedValueOnce({ data: {} })
      await subs.publish.run({ args: { id: 'agt_1' } })
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/publish', {})
      expect(consoleSpy).toHaveBeenCalledWith('Published agt_1')
    })

    it('parses --channels into a string[] and forwards remaining flags', async () => {
      mockPost.mockResolvedValueOnce({ data: {} })
      await subs.publish.run({
        args: {
          id: 'agt_1',
          channels: 'api, feishu',
          'auth-type': 'api_key',
          description: 'Public docs',
          'regenerate-api-key': true,
        },
      })
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/publish', {
        channels: ['api', 'feishu'],
        authType: 'api_key',
        description: 'Public docs',
        regenerateApiKey: true,
      })
    })

    it('resolves name → id before POST', async () => {
      mockPost.mockResolvedValueOnce({ data: {} })
      await subs.publish.run({ args: { id: 'my-bot' } })
      expect(mockResolveAgentId).toHaveBeenCalledWith('my-bot')
      expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_resolved_my-bot/diagnose')
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_resolved_my-bot/publish', {})
    })
  })

  describe('stop', () => {
    it('POSTs /stop with empty body', async () => {
      mockPost.mockResolvedValueOnce({ data: {} })
      await subs.stop.run({ args: { id: 'agt_1' } })
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/stop', {})
      expect(consoleSpy).toHaveBeenCalledWith('Stopped agt_1')
    })
  })

  describe('resume', () => {
    it('POSTs /resume with empty body', async () => {
      mockPost.mockResolvedValueOnce({ data: {} })
      await subs.resume.run({ args: { id: 'agt_2' } })
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_2/resume', {})
      expect(consoleSpy).toHaveBeenCalledWith('Resumed agt_2')
    })
  })

  describe('clone', () => {
    it('POSTs /clone and prints source → new id mapping', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'agt_clone', name: 'my-bot (Copy)' } })
      await subs.clone.run({ args: { id: 'my-bot' } })
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_resolved_my-bot/clone', {})
      expect(consoleSpy).toHaveBeenCalledWith(
        'Cloned agt_resolved_my-bot → agt_clone (my-bot (Copy))',
      )
    })
  })

  describe('regenerate-api-key', () => {
    it('POSTs /regenerate-api-key and prints new key with rotation warning', async () => {
      mockPost.mockResolvedValueOnce({ data: { endpointApiKey: 'ak_NEW_KEY_xyz' } })
      await subs['regenerate-api-key'].run({ args: { id: 'agt_3' } })
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_3/regenerate-api-key', {})
      const messages = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0]))
      expect(messages.some((m: string) => /ak_NEW_KEY_xyz/.test(m))).toBe(true)
      expect(messages.some((m: string) => /old key is now invalid/.test(m))).toBe(true)
    })
  })
})
