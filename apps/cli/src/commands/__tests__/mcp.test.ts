import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockDel = vi.fn()
const mockResolveMcpServerId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    del: mockDel,
    resolveMcpServerId: mockResolveMcpServerId,
  }),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(() => '{"name":"from-file","type":"stdio","command":"node"}'),
  }
})

const { mcpCommand } = await import('../mcp.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
function getSubCommand(name: string) {
  return (mcpCommand.subCommands as Record<string, TestSubCommand>)[name]
}

describe('mcpCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('list', () => {
    it('prints servers with type and flags', async () => {
      mockGet.mockResolvedValueOnce({
        data: [
          { id: 'mcp_1', name: 'A', type: 'stdio', isEnabled: true, usageScope: 'admin-only' },
        ],
      })
      await getSubCommand('list').run({ args: {} })
      expect(mockGet).toHaveBeenCalledWith('/api/mcp-servers?page=1&pageSize=100')
      expect(consoleSpy).toHaveBeenCalledWith('mcp_1  [stdio]  A  (enabled,admin-only)')
    })

    it('prints empty message', async () => {
      mockGet.mockResolvedValueOnce({ data: [] })
      await getSubCommand('list').run({ args: {} })
      expect(consoleSpy).toHaveBeenCalledWith('No MCP Servers')
    })
  })

  describe('create', () => {
    it('builds stdio body from flags', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'mcp_9', name: 'srv' } })
      await getSubCommand('create').run({
        args: {
          name: 'srv',
          type: 'stdio',
          command: 'node',
          arg: ['server.js', '--port'],
          env: 'KEY=val',
        },
      })
      expect(mockPost).toHaveBeenCalledWith('/api/mcp-servers', {
        name: 'srv',
        type: 'stdio',
        command: 'node',
        args: ['server.js', '--port'],
        env: { KEY: 'val' },
      })
      expect(consoleSpy).toHaveBeenCalledWith('MCP Server created ✓  mcp_9  srv')
    })

    it('maps --endpoint to body.url', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'mcp_9', name: 'srv' } })
      await getSubCommand('create').run({
        args: { name: 'srv', type: 'http', endpoint: 'https://x.test/mcp' },
      })
      expect(mockPost).toHaveBeenCalledWith('/api/mcp-servers', {
        name: 'srv',
        type: 'http',
        url: 'https://x.test/mcp',
      })
    })

    it('rejects group type without config-file', async () => {
      await expect(
        getSubCommand('create').run({ args: { name: 'g', type: 'group' } }),
      ).rejects.toThrow('group')
    })

    it('requires --name', async () => {
      await expect(getSubCommand('create').run({ args: { type: 'stdio' } })).rejects.toThrow('name')
    })

    it('reads full body from --config-file', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'mcp_9', name: 'from-file' } })
      await getSubCommand('create').run({ args: { 'config-file': './mcp.json' } })
      expect(mockPost).toHaveBeenCalledWith('/api/mcp-servers', {
        name: 'from-file',
        type: 'stdio',
        command: 'node',
      })
    })
  })

  describe('update', () => {
    it('patches resolved id', async () => {
      mockResolveMcpServerId.mockResolvedValueOnce('mcp_1')
      mockPatch.mockResolvedValueOnce({})
      await getSubCommand('update').run({ args: { id: 'A', description: 'new' } })
      expect(mockPatch).toHaveBeenCalledWith('/api/mcp-servers/mcp_1', { description: 'new' })
    })

    it('rejects empty update', async () => {
      mockResolveMcpServerId.mockResolvedValueOnce('mcp_1')
      await expect(getSubCommand('update').run({ args: { id: 'A' } })).rejects.toThrow('field')
    })
  })

  describe('delete', () => {
    it('deletes resolved id', async () => {
      mockResolveMcpServerId.mockResolvedValueOnce('mcp_1')
      mockDel.mockResolvedValueOnce({})
      // `--force` is now required: delete is high-risk-write, and this suite
      // runs without a TTY exactly as an agent does.
      await getSubCommand('delete').run({ args: { id: 'A', force: true } })
      expect(mockDel).toHaveBeenCalledWith('/api/mcp-servers/mcp_1')
      expect(consoleSpy).toHaveBeenCalledWith('MCP Server deleted ✓')
    })
  })

  describe('tools', () => {
    it('lists tool names', async () => {
      mockResolveMcpServerId.mockResolvedValueOnce('mcp_1')
      mockGet.mockResolvedValueOnce({
        data: { tools: [{ name: 'search', description: 'find things' }] },
      })
      await getSubCommand('tools').run({ args: { id: 'A' } })
      expect(mockGet).toHaveBeenCalledWith('/api/mcp-servers/mcp_1/tools')
      expect(consoleSpy).toHaveBeenCalledWith('search  find things')
    })
  })
})
