import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockDel = vi.fn()
const mockResolveAgentId = vi.fn()
const mockResolveUserId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    del: mockDel,
    resolveAgentId: mockResolveAgentId,
    resolveUserId: mockResolveUserId,
  }),
}))

const { agentsCommand } = await import('../agents.js')

type SubCmd = {
  run: (ctx: { args: Record<string, unknown> }) => Promise<void>
  subCommands?: Record<string, SubCmd>
}

const membersGroup = (agentsCommand.subCommands as Record<string, SubCmd>).members
const subs = membersGroup.subCommands as Record<string, SubCmd>

describe('agents members commands', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('members group registration', () => {
    it('exposes the four expected subcommands', () => {
      expect(Object.keys(subs).sort()).toEqual(['add', 'list', 'remove', 'update'])
    })
  })

  describe('list', () => {
    it('GETs /members and prints a header row plus owner-marked rows', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: [
          {
            userId: 'usr_owner',
            username: 'alice',
            displayName: 'Alice',
            email: 'a@x.com',
            role: 'owner',
            isOwner: true,
            createdAt: '2024-01-01',
          },
          {
            userId: 'usr_2',
            username: 'bob',
            displayName: null,
            email: null,
            role: 'editor',
            isOwner: false,
            createdAt: '2024-01-02',
          },
        ],
      })

      await subs.list.run({ args: { agent: 'agt_1' } })

      expect(mockResolveAgentId).toHaveBeenCalledWith('agt_1')
      expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_1/members')
      expect(consoleSpy).toHaveBeenCalledWith('userId  [role]  username  email')
      expect(consoleSpy).toHaveBeenCalledWith('* usr_owner  [owner]  alice  a@x.com')
      expect(consoleSpy).toHaveBeenCalledWith('  usr_2  [editor]  bob  ')
    })

    it('prints message when no members exist', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({ data: [] })

      await subs.list.run({ args: { agent: 'agt_1' } })

      expect(consoleSpy).toHaveBeenCalledWith('No members yet')
    })

    it('emits the raw payload with --json', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      const payload = { data: [{ userId: 'usr_1', username: 'a', role: 'editor' }] }
      mockGet.mockResolvedValueOnce(payload)

      await subs.list.run({ args: { agent: 'agt_1', json: true } })

      expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual(payload)
    })
  })

  describe('add', () => {
    it('happy path: resolves user, POSTs, prints "Added <username> as <role>"', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockResolveUserId.mockResolvedValueOnce('usr_42')
      mockPost.mockResolvedValueOnce({
        data: {
          userId: 'usr_42',
          username: 'alice',
          displayName: 'Alice',
          email: null,
          role: 'viewer',
          isOwner: false,
          createdAt: '2024-01-03',
        },
      })

      await subs.add.run({ args: { agent: 'agt_1', user: 'alice', role: 'viewer' } })

      expect(mockResolveUserId).toHaveBeenCalledWith('alice')
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/members', {
        userId: 'usr_42',
        role: 'viewer',
      })
      expect(consoleSpy).toHaveBeenCalledWith('Added alice as viewer')
    })

    it('rejects unknown role before any HTTP call', async () => {
      await expect(
        subs.add.run({ args: { agent: 'agt_1', user: 'usr_42', role: 'admin' } }),
      ).rejects.toThrow(/Invalid role/)

      expect(mockResolveAgentId).not.toHaveBeenCalled()
      expect(mockResolveUserId).not.toHaveBeenCalled()
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('passes through the user keyword to resolveUserId (lookup branch covered there)', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockResolveUserId.mockResolvedValueOnce('usr_99')
      mockPost.mockResolvedValueOnce({
        data: {
          userId: 'usr_99',
          username: 'carol',
          displayName: null,
          email: 'c@x.com',
          role: 'editor',
          isOwner: false,
          createdAt: '2024-01-04',
        },
      })

      await subs.add.run({ args: { agent: 'agt_1', user: 'usr_99', role: 'editor' } })

      expect(mockResolveUserId).toHaveBeenCalledWith('usr_99')
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/members', {
        userId: 'usr_99',
        role: 'editor',
      })
      expect(consoleSpy).toHaveBeenCalledWith('Added carol as editor')
    })

    it('propagates resolveUserId errors (e.g. 0 / multi matches) without calling POST', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockResolveUserId.mockRejectedValueOnce(new Error('User not found: ghost'))

      await expect(
        subs.add.run({ args: { agent: 'agt_1', user: 'ghost', role: 'viewer' } }),
      ).rejects.toThrow(/User not found/)
      expect(mockPost).not.toHaveBeenCalled()
    })
  })

  describe('update', () => {
    it('happy path: PATCHes new role and prints "Updated <username> to <role>"', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockResolveUserId.mockResolvedValueOnce('usr_2')
      mockPatch.mockResolvedValueOnce({
        data: {
          userId: 'usr_2',
          username: 'bob',
          displayName: null,
          email: null,
          role: 'editor',
          isOwner: false,
          createdAt: '2024-01-02',
        },
      })

      await subs.update.run({ args: { agent: 'agt_1', user: 'bob', role: 'editor' } })

      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1/members/usr_2', {
        role: 'editor',
      })
      expect(consoleSpy).toHaveBeenCalledWith('Updated bob to editor')
    })

    it('rejects unknown role', async () => {
      await expect(
        subs.update.run({ args: { agent: 'agt_1', user: 'usr_2', role: 'owner' } }),
      ).rejects.toThrow(/Invalid role/)
      expect(mockPatch).not.toHaveBeenCalled()
    })
  })

  describe('remove', () => {
    it('happy path: DELETEs and prints "Removed <userId>"', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockResolveUserId.mockResolvedValueOnce('usr_2')
      mockDel.mockResolvedValueOnce({ data: { removed: true, userId: 'usr_2' } })

      await subs.remove.run({ args: { agent: 'agt_1', user: 'bob' } })

      expect(mockDel).toHaveBeenCalledWith('/api/agents/agt_1/members/usr_2')
      expect(consoleSpy).toHaveBeenCalledWith('Removed usr_2')
    })
  })
})
