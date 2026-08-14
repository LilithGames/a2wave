import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockGetRaw = vi.fn()
const mockResolveSkillId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    getRaw: mockGetRaw,
    resolveSkillId: mockResolveSkillId,
  }),
}))

const { skillsCommand } = await import('../skills.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
function sub(path: string): TestSubCommand {
  let node = skillsCommand as unknown as { subCommands?: Record<string, unknown> }
  for (const seg of path.split(' ')) {
    node = (node.subCommands as Record<string, typeof node>)[seg]
  }
  return node as unknown as TestSubCommand
}

describe('skills files', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveSkillId.mockResolvedValue('skl_1')
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('list', () => {
    it('flattens the directory tree into paths', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          path: '',
          entries: [
            { name: 'SKILL.md', type: 'file', size: 42 },
            {
              name: 'refs',
              type: 'directory',
              entries: [{ name: 'a.md', type: 'file', size: 7 }],
            },
          ],
        },
      })
      await sub('files list').run({ args: { id: 'my-skill' } })
      expect(mockGet).toHaveBeenCalledWith('/api/skills/skl_1/files')
      const printed = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(printed).toContain('SKILL.md')
      expect(printed).toContain('refs/a.md')
    })

    it('reports a Skill with no file storage', async () => {
      mockGet.mockResolvedValueOnce({ data: { path: '', entries: [] } })
      await sub('files list').run({ args: { id: 'my-skill' } })
      expect(consoleSpy).toHaveBeenCalledWith('No files')
    })
  })

  describe('get', () => {
    it('prints the raw text body (this route is not JSON)', async () => {
      mockGetRaw.mockResolvedValueOnce({
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => 'file body',
      })
      await sub('files get').run({ args: { id: 'my-skill', file: 'refs/a.md' } })
      expect(mockGetRaw).toHaveBeenCalledWith('/api/skills/skl_1/files/refs/a.md')
      expect(consoleSpy).toHaveBeenCalledWith('file body')
    })

    it('refuses to dump a binary body onto the terminal', async () => {
      mockGetRaw.mockResolvedValueOnce({
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        text: async () => ' ',
      })
      await expect(
        sub('files get').run({ args: { id: 'my-skill', file: 'logo.png' } }),
      ).rejects.toThrow(/binary/i)
    })

    it('caps the human output and names the escape', async () => {
      const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
      mockGetRaw.mockResolvedValueOnce({
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => body,
      })
      await sub('files get').run({ args: { id: 'my-skill', file: 'big.md' } })
      const printed = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(printed).not.toContain('line 399')
      expect(printed).toContain('--full')
    })

    it('leaves the content whole under --json', async () => {
      const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
      mockGetRaw.mockResolvedValueOnce({
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => body,
      })
      await sub('files get').run({ args: { id: 'my-skill', file: 'big.md', json: true } })
      const emitted = String(consoleSpy.mock.calls[0][0])
      expect(emitted).toContain('line 399')
      expect(JSON.parse(emitted).data.path).toBe('big.md')
    })
  })
})
