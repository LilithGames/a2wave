import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockGetRaw = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockDel = vi.fn()
const mockPostFormData = vi.fn()
const mockResolveKbDocumentId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    getRaw: mockGetRaw,
    post: mockPost,
    patch: mockPatch,
    del: mockDel,
    postFormData: mockPostFormData,
    resolveKbDocumentId: mockResolveKbDocumentId,
  }),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(() => Buffer.from('# doc')) }
})

const { kbCommand } = await import('../kb.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
function getSubCommand(name: string) {
  return (kbCommand.subCommands as Record<string, TestSubCommand>)[name]
}

describe('kbCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('list', () => {
    it('prints docs with sourceType and syncStatus', async () => {
      mockGet.mockResolvedValueOnce({
        data: [{ id: 'kbd_1', name: 'Doc', sourceType: 'feishu', syncStatus: 'synced' }],
      })
      await getSubCommand('list').run({ args: {} })
      expect(mockGet).toHaveBeenCalledWith('/api/kb-documents?page=1&pageSize=100')
      expect(consoleSpy).toHaveBeenCalledWith('kbd_1  [feishu]  Doc  sync=synced')
    })
  })

  describe('create', () => {
    it('creates feishu doc', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'kbd_9', name: 'Doc' } })
      await getSubCommand('create').run({
        args: {
          name: 'Doc',
          'feishu-url': 'https://feishu.test/x',
          'feishu-app-id': 'app1',
          'auto-sync': true,
        },
      })
      expect(mockPost).toHaveBeenCalledWith('/api/kb-documents', {
        name: 'Doc',
        sourceType: 'feishu',
        feishuUrl: 'https://feishu.test/x',
        feishuAppId: 'app1',
        autoSync: true,
      })
    })

    it('creates notion doc', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'kbd_9', name: 'Doc' } })
      await getSubCommand('create').run({
        args: {
          name: 'Doc',
          'notion-url': 'https://www.notion.so/x',
          'notion-token': 'ntn_tok',
        },
      })
      expect(mockPost).toHaveBeenCalledWith('/api/kb-documents', {
        name: 'Doc',
        sourceType: 'notion',
        notionUrl: 'https://www.notion.so/x',
        notionToken: 'ntn_tok',
      })
    })

    it('rejects when neither or both source urls are provided', async () => {
      await expect(getSubCommand('create').run({ args: { name: 'Doc' } })).rejects.toThrow(
        'Exactly one of',
      )
      await expect(
        getSubCommand('create').run({
          args: {
            name: 'Doc',
            'feishu-url': 'https://feishu.test/x',
            'notion-url': 'https://www.notion.so/x',
          },
        }),
      ).rejects.toThrow('Exactly one of')
      expect(mockPost).not.toHaveBeenCalled()
    })
  })

  describe('upload', () => {
    it('uploads a .md file', async () => {
      mockPostFormData.mockResolvedValueOnce({ data: { id: 'kbd_9', name: 'notes' } })
      await getSubCommand('upload').run({ args: { file: '/path/notes.md' } })
      expect(mockPostFormData).toHaveBeenCalledWith(
        '/api/kb-documents/upload',
        expect.any(FormData),
      )
    })

    it('rejects unsupported ext', async () => {
      await expect(getSubCommand('upload').run({ args: { file: '/path/x.pdf' } })).rejects.toThrow(
        '.md',
      )
    })
  })

  describe('update', () => {
    it('patches metadata', async () => {
      mockResolveKbDocumentId.mockResolvedValueOnce('kbd_1')
      mockPatch.mockResolvedValueOnce({})
      await getSubCommand('update').run({ args: { id: 'Doc', 'auto-sync': false } })
      expect(mockPatch).toHaveBeenCalledWith('/api/kb-documents/kbd_1', { autoSync: false })
    })

    it('rejects empty update', async () => {
      mockResolveKbDocumentId.mockResolvedValueOnce('kbd_1')
      await expect(getSubCommand('update').run({ args: { id: 'Doc' } })).rejects.toThrow(
        'Specify at least one field to update: --name, --description, --notion-url, --notion-token, --auto-sync, --sync-interval',
      )
    })

    it('rotates the Notion URL and token', async () => {
      mockResolveKbDocumentId.mockResolvedValueOnce('kbd_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: {
          id: 'Doc',
          'notion-url': 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'notion-token': 'ntn_replacement',
        },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/kb-documents/kbd_1', {
        notionUrl: 'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        notionToken: 'ntn_replacement',
      })
    })

    it('rejects a whitespace-only Notion token', async () => {
      mockResolveKbDocumentId.mockResolvedValueOnce('kbd_1')

      await expect(
        getSubCommand('update').run({ args: { id: 'Doc', 'notion-token': '   ' } }),
      ).rejects.toThrow('Specify at least one field to update')
      expect(mockPatch).not.toHaveBeenCalled()
    })
  })

  describe('sync', () => {
    it('posts sync', async () => {
      mockResolveKbDocumentId.mockResolvedValueOnce('kbd_1')
      mockPost.mockResolvedValueOnce({})
      await getSubCommand('sync').run({ args: { id: 'Doc' } })
      expect(mockPost).toHaveBeenCalledWith('/api/kb-documents/kbd_1/sync', {})
    })
  })

  describe('content', () => {
    it('prints text from getRaw', async () => {
      mockResolveKbDocumentId.mockResolvedValueOnce('kbd_1')
      mockGetRaw.mockResolvedValueOnce({ text: async () => 'full body' })
      await getSubCommand('content').run({ args: { id: 'Doc' } })
      expect(mockGetRaw).toHaveBeenCalledWith('/api/kb-documents/kbd_1/content')
      expect(consoleSpy).toHaveBeenCalledWith('full body')
    })
  })
})
