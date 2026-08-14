import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPatch = vi.fn()
const mockPost = vi.fn()
const mockDel = vi.fn()
const mockPostFormData = vi.fn()
const mockResolveSkillId = vi.fn()
const mockResolveSkillGroupId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    patch: mockPatch,
    post: mockPost,
    del: mockDel,
    postFormData: mockPostFormData,
    resolveSkillId: mockResolveSkillId,
    resolveSkillGroupId: mockResolveSkillGroupId,
  }),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((path: string, encoding?: string) => {
      if (encoding === 'utf-8') return '# Skill Content'
      return Buffer.from('file-bytes')
    }),
  }
})

const { skillsCommand } = await import('../skills.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }

function getSubCommand(name: string) {
  const subCommands = skillsCommand.subCommands as Record<string, TestSubCommand>
  return subCommands[name]
}

describe('skillsCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('list', () => {
    it('prints skills with id, name, and description', async () => {
      mockGet.mockResolvedValueOnce({
        data: [
          { id: 'skl_1', name: 'Skill A', description: 'Does A', visibility: 'private' },
          { id: 'skl_2', name: 'Skill B', description: null, visibility: 'all-users' },
        ],
      })

      await getSubCommand('list').run({ args: {} })

      expect(mockGet).toHaveBeenCalledWith('/api/skills?page=1&pageSize=100')
      expect(consoleSpy).toHaveBeenCalledWith('skl_1  Skill A  [private]  Does A')
      expect(consoleSpy).toHaveBeenCalledWith('skl_2  Skill B  [all-users]')
    })

    it('prints message when no skills exist', async () => {
      mockGet.mockResolvedValueOnce({ data: [] })

      await getSubCommand('list').run({ args: {} })

      expect(consoleSpy).toHaveBeenCalledWith('No Skills yet')
    })
  })

  describe('get', () => {
    it('prints skill details', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'skl_1',
          name: 'Skill A',
          description: 'Does A',
          visibility: 'all-users',
          updatedAt: '2025-01-01',
          content: '# Hello',
        },
      })

      await getSubCommand('get').run({ args: { id: 'skl_1' } })

      expect(mockResolveSkillId).toHaveBeenCalledWith('skl_1')
      expect(consoleSpy).toHaveBeenCalledWith('ID:          skl_1')
      expect(consoleSpy).toHaveBeenCalledWith('Name:        Skill A')
      expect(consoleSpy).toHaveBeenCalledWith('Visibility:  all-users')
      expect(consoleSpy).toHaveBeenCalledWith('\n--- Content ---')
      expect(consoleSpy).toHaveBeenCalledWith('# Hello')
    })

    it('resolves skill by name', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'skl_1',
          name: 'Skill A',
          description: null,
          visibility: 'private',
          updatedAt: '2025-01-01',
        },
      })

      await getSubCommand('get').run({ args: { id: 'Skill A' } })

      expect(mockResolveSkillId).toHaveBeenCalledWith('Skill A')
    })
  })

  describe('update', () => {
    it('patches skill with --content', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'skl_1', content: 'new content' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/skills/skl_1', { content: 'new content' })
      expect(consoleSpy).toHaveBeenCalledWith('Skill updated ✓')
    })

    it('patches skill with --name and --description', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'skl_1', name: 'New Name', description: 'New Desc' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/skills/skl_1', {
        name: 'New Name',
        description: 'New Desc',
      })
    })

    it('patches visibility explicitly', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'skl_1', visibility: 'all-users' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/skills/skl_1', {
        visibility: 'all-users',
      })
    })

    it('reads content from file with --content-file', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'skl_1', 'content-file': './SKILL.md' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/skills/skl_1', { content: '# Skill Content' })
    })

    it('uploads file with --file for .md', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockPostFormData.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'skl_1', file: '/path/to/skill.md' },
      })

      expect(mockPostFormData).toHaveBeenCalledWith(
        '/api/skills/skl_1/reupload',
        expect.any(FormData),
      )
      expect(consoleSpy).toHaveBeenCalledWith('Skill file replaced ✓')
    })

    it('uploads file with --file for .zip', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockPostFormData.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'skl_1', file: '/path/to/skill.zip' },
      })

      expect(mockPostFormData).toHaveBeenCalledWith(
        '/api/skills/skl_1/reupload',
        expect.any(FormData),
      )
      expect(consoleSpy).toHaveBeenCalledWith('Skill file replaced ✓')
    })

    it('rejects --file combined with --visibility before resolving or uploading', async () => {
      await expect(
        getSubCommand('update').run({
          args: { id: 'skl_1', file: '/path/to/skill.zip', visibility: 'all-users' },
        }),
      ).rejects.toThrow('--file and --visibility cannot be used together')

      expect(mockResolveSkillId).not.toHaveBeenCalled()
      expect(mockPostFormData).not.toHaveBeenCalled()
      expect(mockPatch).not.toHaveBeenCalled()
    })

    it('rejects an invalid visibility before patching', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')

      await expect(
        getSubCommand('update').run({
          args: { id: 'skl_1', visibility: 'organization' },
        }),
      ).rejects.toThrow('--visibility must be private or all-users')

      expect(mockPatch).not.toHaveBeenCalled()
    })

    it('rejects unsupported file types', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')

      await expect(
        getSubCommand('update').run({
          args: { id: 'skl_1', file: '/path/to/skill.txt' },
        }),
      ).rejects.toThrow('Only .md or .zip files are supported')
    })

    it('throws when no update fields specified', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')

      await expect(getSubCommand('update').run({ args: { id: 'skl_1' } })).rejects.toThrow(
        'Specify at least one field to update',
      )
    })
  })

  describe('create', () => {
    it('creates skill from fields', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'skl_9', name: 'New' } })

      await getSubCommand('create').run({
        args: { name: 'New', description: 'desc', content: 'body' },
      })

      expect(mockPost).toHaveBeenCalledWith('/api/skills', {
        name: 'New',
        description: 'desc',
        content: 'body',
      })
      expect(consoleSpy).toHaveBeenCalledWith('Skill created ✓  skl_9  New')
    })

    it('resolves --group to groupId', async () => {
      mockResolveSkillGroupId.mockResolvedValueOnce('skg_1')
      mockPost.mockResolvedValueOnce({ data: { id: 'skl_9', name: 'New' } })

      await getSubCommand('create').run({ args: { name: 'New', group: 'My Group' } })

      expect(mockResolveSkillGroupId).toHaveBeenCalledWith('My Group')
      expect(mockPost).toHaveBeenCalledWith('/api/skills', { name: 'New', groupId: 'skg_1' })
    })

    it('creates an all-users Skill when requested by an administrator', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'skl_9', name: 'Shared' } })

      await getSubCommand('create').run({
        args: { name: 'Shared', visibility: 'all-users' },
      })

      expect(mockPost).toHaveBeenCalledWith('/api/skills', {
        name: 'Shared',
        visibility: 'all-users',
      })
    })

    it('uploads with --file', async () => {
      mockPostFormData.mockResolvedValueOnce({ data: { id: 'skl_9', name: 'From Zip' } })

      await getSubCommand('create').run({ args: { file: '/path/to/skill.zip' } })

      expect(mockPostFormData).toHaveBeenCalledWith('/api/skills/upload', expect.any(FormData))
    })

    it('installs a remote Skill with the wave-compatible --url form', async () => {
      const inspection = {
        inputUrl: 'https://skills.sh/acme/tools/demo-skill',
        repository: 'acme/tools',
        requestedRef: 'main',
        revision: 'a'.repeat(40),
        candidates: [
          {
            name: 'demo-skill',
            description: 'Demo',
            path: 'skills/demo-skill',
            digest: `sha256:${'b'.repeat(64)}`,
            fileCount: 2,
            totalBytes: 100,
          },
        ],
      }
      mockPost
        .mockResolvedValueOnce({ data: inspection })
        .mockResolvedValueOnce({ data: [{ id: 'skl_remote', name: 'demo-skill' }] })

      await getSubCommand('create').run({ args: { url: inspection.inputUrl } })

      expect(mockPost).toHaveBeenNthCalledWith(1, '/api/skills/remote/inspect', {
        url: inspection.inputUrl,
      })
      expect(mockPost).toHaveBeenNthCalledWith(
        2,
        '/api/skills/remote/install',
        expect.objectContaining({
          revision: inspection.revision,
          selections: [
            {
              path: 'skills/demo-skill',
              digest: inspection.candidates[0].digest,
            },
          ],
        }),
      )
    })

    it('requires --name when not uploading', async () => {
      await expect(getSubCommand('create').run({ args: { description: 'x' } })).rejects.toThrow(
        '--name',
      )
    })
  })

  describe('install', () => {
    const inspection = {
      inputUrl: 'https://github.com/acme/tools',
      repository: 'acme/tools',
      requestedRef: 'main',
      revision: 'a'.repeat(40),
      candidates: [
        {
          name: 'demo-skill',
          description: 'Demo',
          path: 'skills/demo-skill',
          digest: `sha256:${'b'.repeat(64)}`,
          fileCount: 2,
          totalBytes: 100,
        },
      ],
    }

    it('rejects conflicting --skill and --all selectors', async () => {
      await expect(
        getSubCommand('install').run({
          args: { source: inspection.inputUrl, skill: 'demo-skill', all: true },
        }),
      ).rejects.toThrow('cannot be used together')
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('previews and installs the only candidate', async () => {
      mockPost
        .mockResolvedValueOnce({ data: inspection })
        .mockResolvedValueOnce({ data: [{ id: 'skl_remote', name: 'demo-skill' }] })

      await getSubCommand('install').run({ args: { source: inspection.inputUrl } })

      expect(mockPost).toHaveBeenNthCalledWith(1, '/api/skills/remote/inspect', {
        url: inspection.inputUrl,
      })
      expect(mockPost).toHaveBeenNthCalledWith(
        2,
        '/api/skills/remote/install',
        expect.objectContaining({
          requestedRef: 'main',
          revision: inspection.revision,
          selections: [
            {
              path: 'skills/demo-skill',
              digest: inspection.candidates[0].digest,
            },
          ],
        }),
      )
      expect(consoleSpy).toHaveBeenCalledWith('Skill installed ✓  skl_remote  demo-skill')
    })

    it('passes all-users visibility to remote installation', async () => {
      mockPost
        .mockResolvedValueOnce({ data: inspection })
        .mockResolvedValueOnce({ data: [{ id: 'skl_remote', name: 'demo-skill' }] })

      await getSubCommand('install').run({
        args: { source: inspection.inputUrl, visibility: 'all-users' },
      })

      expect(mockPost).toHaveBeenNthCalledWith(
        2,
        '/api/skills/remote/install',
        expect.objectContaining({ visibility: 'all-users' }),
      )
    })

    it('requires --skill or --all when multiple candidates are found', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          ...inspection,
          candidates: [
            ...inspection.candidates,
            {
              ...inspection.candidates[0],
              name: 'other-skill',
              path: 'skills/other-skill',
            },
          ],
        },
      })

      await expect(
        getSubCommand('install').run({ args: { source: inspection.inputUrl } }),
      ).rejects.toThrow('--skill')
    })

    it('selects by repository path and resolves the optional group', async () => {
      mockResolveSkillGroupId.mockResolvedValueOnce('skg_tools')
      mockPost
        .mockResolvedValueOnce({ data: inspection })
        .mockResolvedValueOnce({ data: [{ id: 'skl_remote', name: 'demo-skill' }] })

      await getSubCommand('install').run({
        args: {
          source: inspection.inputUrl,
          skill: 'skills/demo-skill',
          group: 'Tools',
        },
      })

      expect(mockResolveSkillGroupId).toHaveBeenCalledWith('Tools')
      expect(mockPost).toHaveBeenNthCalledWith(
        2,
        '/api/skills/remote/install',
        expect.objectContaining({ groupId: 'skg_tools' }),
      )
    })
  })

  describe('remote updates', () => {
    const updateCheck = {
      latestRevision: 'c'.repeat(40),
      latestDigest: `sha256:${'d'.repeat(64)}`,
      updateAvailable: true,
      sourceDirty: true,
      conflicts: ['SKILL.md'],
      files: [
        {
          path: 'SKILL.md',
          localChange: 'modified',
          remoteChange: 'modified',
          conflict: true,
        },
      ],
    }

    it('prints explicit file differences when checking for updates', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_remote')
      mockPost.mockResolvedValueOnce({ data: updateCheck })

      await getSubCommand('check-update').run({ args: { id: 'demo-skill' } })

      expect(mockPost).toHaveBeenCalledWith('/api/skills/skl_remote/remote/check', {})
      expect(consoleSpy).toHaveBeenCalledWith(`Update available ✓  ${updateCheck.latestRevision}`)
      expect(consoleSpy).toHaveBeenCalledWith(
        'SKILL.md  local=modified  upstream=modified  CONFLICT',
      )
    })

    it('requires an explicit conflict strategy before updating', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_remote')
      mockPost.mockResolvedValueOnce({ data: updateCheck })

      await expect(
        getSubCommand('update-remote').run({
          args: { id: 'demo-skill', strategy: 'abort' },
        }),
      ).rejects.toThrow('preserve-local')
      expect(mockPost).toHaveBeenCalledTimes(1)
    })

    it('updates after preserving local conflicting files', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_remote')
      mockPost.mockResolvedValueOnce({ data: updateCheck }).mockResolvedValueOnce({ data: {} })

      await getSubCommand('update-remote').run({
        args: { id: 'demo-skill', strategy: 'preserve-local' },
      })

      expect(mockPost).toHaveBeenNthCalledWith(2, '/api/skills/skl_remote/remote/update', {
        revision: updateCheck.latestRevision,
        digest: updateCheck.latestDigest,
        strategy: 'preserve_local',
      })
      expect(consoleSpy).toHaveBeenCalledWith(
        `Remote Skill updated ✓  ${updateCheck.latestRevision}`,
      )
    })
  })

  describe('delete', () => {
    it('deletes resolved skill with --force', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockDel.mockResolvedValueOnce({})

      await getSubCommand('delete').run({ args: { id: 'Skill A', force: true } })

      expect(mockResolveSkillId).toHaveBeenCalledWith('Skill A')
      expect(mockDel).toHaveBeenCalledWith('/api/skills/skl_1')
      expect(consoleSpy).toHaveBeenCalledWith('Skill deleted ✓')
    })

    it('refuses to delete without --force in a non-interactive shell', async () => {
      mockResolveSkillId.mockResolvedValueOnce('skl_1')

      await expect(getSubCommand('delete').run({ args: { id: 'Skill A' } })).rejects.toThrow(
        /--force/,
      )
      expect(mockDel).not.toHaveBeenCalled()
    })
  })
})
