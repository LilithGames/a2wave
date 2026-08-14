import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPut = vi.fn()
const mockPost = vi.fn()
const mockDel = vi.fn()
const mockResolveAgentId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    put: mockPut,
    post: mockPost,
    del: mockDel,
    resolveAgentId: mockResolveAgentId,
  }),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(() => 'content from file') }
})

const { memoryCommand } = await import('../memory.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
function sub(path: string): TestSubCommand {
  let node = memoryCommand as unknown as { subCommands?: Record<string, unknown> }
  for (const seg of path.split(' ')) {
    node = (node.subCommands as Record<string, typeof node>)[seg]
  }
  return node as unknown as TestSubCommand
}

describe('memoryCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveAgentId.mockResolvedValue('agt_1')
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('files list', () => {
    it('lists memory files', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ name: 'MEMORY.md', size: 12 }] })
      await sub('files list').run({ args: { agent: 'bot' } })
      expect(mockGet).toHaveBeenCalledWith('/api/memories/agt_1')
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('MEMORY.md'))
    })

    it('prints an empty message', async () => {
      mockGet.mockResolvedValueOnce({ data: [] })
      await sub('files list').run({ args: { agent: 'bot' } })
      expect(consoleSpy).toHaveBeenCalledWith('No memory files')
    })
  })

  describe('files get', () => {
    it('reads a nested file path verbatim', async () => {
      mockGet.mockResolvedValueOnce({ data: { filename: 'notes/a.md', content: 'hello' } })
      await sub('files get').run({ args: { agent: 'bot', file: 'notes/a.md' } })
      expect(mockGet).toHaveBeenCalledWith('/api/memories/agt_1/files/notes/a.md')
      expect(consoleSpy).toHaveBeenCalledWith('hello')
    })

    it('caps the human output and names the escape', async () => {
      const content = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
      mockGet.mockResolvedValueOnce({ data: { filename: 'big.md', content } })
      await sub('files get').run({ args: { agent: 'bot', file: 'big.md' } })
      const printed = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(printed).not.toContain('line 399')
      expect(printed).toContain('--full')
    })

    it('leaves the payload whole under --json', async () => {
      const content = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
      mockGet.mockResolvedValueOnce({ data: { filename: 'big.md', content } })
      await sub('files get').run({ args: { agent: 'bot', file: 'big.md', json: true } })
      expect(consoleSpy.mock.calls[0][0]).toContain('line 399')
    })

    it('--full prints everything', async () => {
      const content = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
      mockGet.mockResolvedValueOnce({ data: { filename: 'big.md', content } })
      await sub('files get').run({ args: { agent: 'bot', file: 'big.md', full: true } })
      expect(consoleSpy.mock.calls.join('\n')).toContain('line 399')
    })
  })

  describe('files put', () => {
    it('writes content from --content', async () => {
      mockPut.mockResolvedValueOnce({ data: { filename: 'a.md', size: 5 } })
      await sub('files put').run({ args: { agent: 'bot', file: 'a.md', content: 'hi' } })
      expect(mockPut).toHaveBeenCalledWith('/api/memories/agt_1/files/a.md', { content: 'hi' })
    })

    it('writes content from --content-file', async () => {
      mockPut.mockResolvedValueOnce({ data: { filename: 'a.md', size: 5 } })
      await sub('files put').run({ args: { agent: 'bot', file: 'a.md', 'content-file': './x.md' } })
      expect(mockPut).toHaveBeenCalledWith('/api/memories/agt_1/files/a.md', {
        content: 'content from file',
      })
    })

    it('sends append when asked', async () => {
      mockPut.mockResolvedValueOnce({ data: { filename: 'a.md', size: 5 } })
      await sub('files put').run({
        args: { agent: 'bot', file: 'a.md', content: 'hi', append: true },
      })
      expect(mockPut).toHaveBeenCalledWith('/api/memories/agt_1/files/a.md', {
        content: 'hi',
        append: true,
      })
    })

    it('requires exactly one content source', async () => {
      await expect(sub('files put').run({ args: { agent: 'bot', file: 'a.md' } })).rejects.toThrow(
        /--content/,
      )
      await expect(
        sub('files put').run({
          args: { agent: 'bot', file: 'a.md', content: 'x', 'content-file': './y' },
        }),
      ).rejects.toThrow(/--content/)
    })
  })

  describe('files delete', () => {
    it('refuses without --force in a non-interactive shell', async () => {
      await expect(
        sub('files delete').run({ args: { agent: 'bot', file: 'a.md' } }),
      ).rejects.toThrow(/--force/)
      expect(mockDel).not.toHaveBeenCalled()
    })

    it('deletes with --force', async () => {
      mockDel.mockResolvedValueOnce({ data: { deleted: 'a.md' } })
      await sub('files delete').run({ args: { agent: 'bot', file: 'a.md', force: true } })
      expect(mockDel).toHaveBeenCalledWith('/api/memories/agt_1/files/a.md')
    })
  })

  describe('topics list', () => {
    it('lists topics and honours --status', async () => {
      mockGet.mockResolvedValueOnce({
        data: { mode: 'topic_v2', invalidFiles: [], topics: [{ topicId: 't1', title: 'Billing' }] },
      })
      await sub('topics list').run({ args: { agent: 'bot', status: 'archived' } })
      expect(mockGet).toHaveBeenCalledWith('/api/memories/agt_1/topics?status=archived')
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Billing'))
    })

    it('rejects an unknown --status', async () => {
      await expect(
        sub('topics list').run({ args: { agent: 'bot', status: 'nope' } }),
      ).rejects.toThrow(/--status/)
    })
  })

  describe('topics recall', () => {
    it('encodes the query', async () => {
      mockGet.mockResolvedValueOnce({ data: { topicId: 't1', title: 'A', content: 'body' } })
      await sub('topics recall').run({ args: { agent: 'bot', query: 'a b' } })
      expect(mockGet).toHaveBeenCalledWith('/api/memories/agt_1/topics/recall?q=a%20b')
    })

    it('reports no match when data is null', async () => {
      mockGet.mockResolvedValueOnce({ data: null })
      await sub('topics recall').run({ args: { agent: 'bot', query: 'zzz' } })
      expect(consoleSpy).toHaveBeenCalledWith('No matching topic')
    })
  })

  describe('topics remember', () => {
    it('sends a remember write built from flags', async () => {
      mockPost.mockResolvedValueOnce({ data: { created: true, topic: { topicId: 't1' } } })
      await sub('topics remember').run({
        args: {
          agent: 'bot',
          title: 'Billing',
          item: ['invoices are monthly', 'net 30'],
          keyword: 'billing',
        },
      })
      expect(mockPost).toHaveBeenCalledWith('/api/memories/agt_1/topics/remember', {
        action: 'remember',
        title: 'Billing',
        keywords: ['billing'],
        items: ['invoices are monthly', 'net 30'],
      })
    })

    it('sends a replace write with --topic and --content', async () => {
      mockPost.mockResolvedValueOnce({ data: { created: false, topic: { topicId: 't1' } } })
      await sub('topics remember').run({
        args: { agent: 'bot', topic: 't1', content: 'new body', replace: true },
      })
      expect(mockPost).toHaveBeenCalledWith('/api/memories/agt_1/topics/remember', {
        action: 'replace',
        topicId: 't1',
        content: 'new body',
      })
    })

    it('requires --topic and --content for a replace', async () => {
      await expect(
        sub('topics remember').run({ args: { agent: 'bot', replace: true, content: 'x' } }),
      ).rejects.toThrow(/--topic/)
    })

    it('requires --title or --topic plus at least one --item for a remember', async () => {
      await expect(sub('topics remember').run({ args: { agent: 'bot' } })).rejects.toThrow(/--item/)
    })
  })
})
