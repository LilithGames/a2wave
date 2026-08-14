import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockDel = vi.fn()
const mockResolveSkillGroupId = vi.fn()
const mockResolveSkillId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    del: mockDel,
    resolveSkillGroupId: mockResolveSkillGroupId,
    resolveSkillId: mockResolveSkillId,
  }),
}))

const { skillGroupsCommand } = await import('../skill-groups.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
function sub(name: string): TestSubCommand {
  return (skillGroupsCommand.subCommands as Record<string, TestSubCommand>)[name]
}

describe('skillGroupsCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveSkillGroupId.mockResolvedValue('skg_1')
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('list', () => {
    it('paginates and prints groups', async () => {
      mockGet.mockResolvedValueOnce({
        data: [{ id: 'skg_1', name: 'feishu-tools', description: 'Lark', icon: 'package' }],
      })
      await sub('list').run({ args: {} })
      expect(mockGet).toHaveBeenCalledWith('/api/skill-groups?page=1&pageSize=100')
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('feishu-tools'))
    })

    it('warns when the owner cannot bind every member', async () => {
      mockGet.mockResolvedValueOnce({
        data: [{ id: 'skg_1', name: 'g', ownerCanBindAllSkills: false }],
      })
      await sub('list').run({ args: {} })
      expect(consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(
        /unbindable/i,
      )
    })

    it('prints an empty message', async () => {
      mockGet.mockResolvedValueOnce({ data: [] })
      await sub('list').run({ args: {} })
      expect(consoleSpy).toHaveBeenCalledWith('No Skill Groups')
    })
  })

  describe('get', () => {
    it('resolves the name and lists member skill ids', async () => {
      mockGet
        .mockResolvedValueOnce({ data: { id: 'skg_1', name: 'g', icon: 'package' } })
        .mockResolvedValueOnce({ data: ['skl_a', 'skl_b'] })
      await sub('get').run({ args: { id: 'g' } })
      expect(mockGet).toHaveBeenNthCalledWith(1, '/api/skill-groups/skg_1')
      expect(mockGet).toHaveBeenNthCalledWith(2, '/api/skill-groups/skg_1/skills')
      expect(consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain(
        'skl_a',
      )
    })
  })

  describe('create', () => {
    it('resolves each --skill by name into skillIds', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_a').mockResolvedValueOnce('skl_b')
      mockPost.mockResolvedValueOnce({ data: { id: 'skg_9', name: 'g' } })
      await sub('create').run({ args: { name: 'g', description: 'd', skill: ['a', 'b'] } })
      expect(mockPost).toHaveBeenCalledWith('/api/skill-groups', {
        name: 'g',
        description: 'd',
        skillIds: ['skl_a', 'skl_b'],
      })
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('skg_9'))
    })

    it('requires --name', async () => {
      await expect(sub('create').run({ args: {} })).rejects.toThrow(/--name/)
    })
  })

  describe('update', () => {
    it('patches only the given fields', async () => {
      mockPatch.mockResolvedValueOnce({ data: { id: 'skg_1', name: 'renamed' } })
      await sub('update').run({ args: { id: 'g', name: 'renamed' } })
      expect(mockPatch).toHaveBeenCalledWith('/api/skill-groups/skg_1', { name: 'renamed' })
    })

    it('rejects an empty update', async () => {
      await expect(sub('update').run({ args: { id: 'g' } })).rejects.toThrow(/field/)
    })

    it('sends an empty skillIds when asked to clear members', async () => {
      mockPatch.mockResolvedValueOnce({ data: { id: 'skg_1' } })
      await sub('update').run({ args: { id: 'g', 'clear-skills': true } })
      expect(mockPatch).toHaveBeenCalledWith('/api/skill-groups/skg_1', { skillIds: [] })
    })
  })

  describe('delete', () => {
    it('refuses without --force in a non-interactive shell', async () => {
      await expect(sub('delete').run({ args: { id: 'g' } })).rejects.toThrow(/--force/)
      expect(mockDel).not.toHaveBeenCalled()
    })

    it('deletes with --force', async () => {
      mockDel.mockResolvedValueOnce({})
      await sub('delete').run({ args: { id: 'g', force: true } })
      expect(mockDel).toHaveBeenCalledWith('/api/skill-groups/skg_1')
      expect(consoleSpy).toHaveBeenCalledWith('Skill Group deleted ✓')
    })
  })
})
