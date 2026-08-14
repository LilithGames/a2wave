import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockPut = vi.fn()
const mockDel = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    put: mockPut,
    del: mockDel,
  }),
}))

const mockRequireConfirmation = vi.fn()
const mockReadJsonFile = vi.fn()

vi.mock('../../lib/args.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/args.js')>('../../lib/args.js')
  return {
    ...actual,
    requireConfirmation: (risk: string, message: string, force: boolean) =>
      mockRequireConfirmation(risk, message, force),
    readJsonFile: (path: string, flag?: string) => mockReadJsonFile(path, flag),
  }
})

const { apiCommand } = await import('../api.js')

type Runnable = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
const run = (args: Record<string, unknown>) => (apiCommand as unknown as Runnable).run({ args })

describe('apiCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockRequireConfirmation.mockResolvedValue(undefined)
  })

  describe('method dispatch', () => {
    it('routes GET through the client and prints the payload as JSON', async () => {
      mockGet.mockResolvedValueOnce({ data: [{ id: 'agt_1' }] })
      await run({ method: 'GET', path: '/api/agents' })
      expect(mockGet).toHaveBeenCalledWith('/api/agents')
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ data: [{ id: 'agt_1' }] }))
    })

    it('accepts a lowercase method and normalizes it', async () => {
      mockGet.mockResolvedValueOnce({ ok: true })
      await run({ method: 'get', path: '/api/health' })
      expect(mockGet).toHaveBeenCalledWith('/api/health')
    })

    it('rejects an unsupported method', async () => {
      await expect(run({ method: 'TRACE', path: '/api/agents' })).rejects.toThrow(
        /Unsupported method/,
      )
      expect(mockGet).not.toHaveBeenCalled()
    })

    it('routes POST with a parsed --body', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'agt_2' } })
      await run({ method: 'POST', path: '/api/agents', body: '{"name":"bot"}', yes: true })
      expect(mockPost).toHaveBeenCalledWith('/api/agents', { name: 'bot' })
    })

    it('routes PATCH, PUT and DELETE through their client verbs', async () => {
      mockPatch.mockResolvedValueOnce({})
      await run({ method: 'PATCH', path: '/api/agents/agt_1', body: '{"name":"x"}', yes: true })
      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', { name: 'x' })

      mockPut.mockResolvedValueOnce({})
      await run({ method: 'PUT', path: '/api/settings', body: '{"a":1}', yes: true })
      expect(mockPut).toHaveBeenCalledWith('/api/settings', { a: 1 })

      mockDel.mockResolvedValueOnce({})
      await run({ method: 'DELETE', path: '/api/agents/agt_1', yes: true })
      expect(mockDel).toHaveBeenCalledWith('/api/agents/agt_1')
    })

    it('rejects an unparseable --body before any request', async () => {
      await expect(
        run({ method: 'POST', path: '/api/agents', body: 'not json', yes: true }),
      ).rejects.toThrow(/--body is not valid JSON/)
      expect(mockPost).not.toHaveBeenCalled()
    })
  })

  describe('path guard', () => {
    // Without this guard, `api GET https://evil.example/x` would send the
    // bearer token to a third-party host.
    const hostile = [
      'https://evil.example/api/agents',
      'http://evil.example/api/agents',
      '//evil.example/api/agents',
      'file:///etc/passwd',
      'evil.example://api/agents',
    ]

    for (const path of hostile) {
      it(`refuses to send credentials to ${path}`, async () => {
        await expect(run({ method: 'GET', path })).rejects.toThrow(/must start with \/api\//)
        expect(mockGet).not.toHaveBeenCalled()
      })
    }

    it('rejects a relative path that never reaches the API surface', async () => {
      await expect(run({ method: 'GET', path: 'agents' })).rejects.toThrow(
        /must start with \/api\//,
      )
      expect(mockGet).not.toHaveBeenCalled()
    })
  })

  describe('write confirmation', () => {
    it('downgrades a GET to the read risk, so nothing is asked', async () => {
      // The command carries `high-risk-write` because a leaf gets one static
      // label and an arbitrary write is the worst case. The GET path passes
      // 'read', which requireConfirmation lets through untouched.
      mockGet.mockResolvedValueOnce({})
      await run({ method: 'GET', path: '/api/agents' })
      expect(mockRequireConfirmation).toHaveBeenCalledWith('read', expect.any(String), false)
    })

    it('confirms every non-GET, passing --yes as force', async () => {
      mockDel.mockResolvedValueOnce({})
      await run({ method: 'DELETE', path: '/api/agents/agt_1', yes: true })
      expect(mockRequireConfirmation).toHaveBeenCalledWith(
        'high-risk-write',
        expect.any(String),
        true,
      )
    })

    it('aborts the request when confirmation is declined', async () => {
      mockRequireConfirmation.mockRejectedValueOnce(new Error('Cancelled.'))
      await expect(run({ method: 'POST', path: '/api/agents', body: '{}' })).rejects.toThrow(
        'Cancelled.',
      )
      expect(mockPost).not.toHaveBeenCalled()
    })
  })

  describe('body sources', () => {
    it('rejects --body together with --body-file', async () => {
      await expect(
        run({ method: 'POST', path: '/api/agents', body: '{}', 'body-file': 'b.json', yes: true }),
      ).rejects.toThrow(/mutually exclusive/)
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('reads --body-file through readJsonFile', async () => {
      mockReadJsonFile.mockReturnValueOnce({ name: 'from-file' })
      mockPost.mockResolvedValueOnce({})
      await run({ method: 'POST', path: '/api/agents', 'body-file': 'b.json', yes: true })
      expect(mockReadJsonFile).toHaveBeenCalledWith('b.json', 'body-file')
      expect(mockPost).toHaveBeenCalledWith('/api/agents', { name: 'from-file' })
    })

    it('sends an empty object when a write carries no body', async () => {
      mockPost.mockResolvedValueOnce({})
      await run({ method: 'POST', path: '/api/agents/agt_1/publish', yes: true })
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/publish', {})
    })
  })

  describe('query flags', () => {
    it('appends repeatable --query pairs to the path', async () => {
      mockGet.mockResolvedValueOnce({})
      await run({ method: 'GET', path: '/api/runs', query: ['page=2', 'pageSize=50'] })
      expect(mockGet).toHaveBeenCalledWith('/api/runs?page=2&pageSize=50')
    })

    it('merges with a query string already present in the path', async () => {
      mockGet.mockResolvedValueOnce({})
      await run({ method: 'GET', path: '/api/runs?status=failed', query: 'page=2' })
      expect(mockGet).toHaveBeenCalledWith('/api/runs?status=failed&page=2')
    })

    it('url-encodes values so a token or space cannot break the path', async () => {
      mockGet.mockResolvedValueOnce({})
      await run({ method: 'GET', path: '/api/user-lookup', query: 'q=a b&c' })
      expect(mockGet).toHaveBeenCalledWith('/api/user-lookup?q=a%20b%26c')
    })

    it('rejects a --query pair without an =', async () => {
      await expect(run({ method: 'GET', path: '/api/runs', query: 'page' })).rejects.toThrow(
        /--query must be key=value/,
      )
    })
  })

  describe('output', () => {
    // `api` can reach endpoints the redaction denylist has never seen, and that
    // denylist fails open — so redaction matters more here than anywhere else.
    it('redacts credentials by default', async () => {
      mockGet.mockResolvedValueOnce({ data: { appSecret: 'sk-live-1' } })
      await run({ method: 'GET', path: '/api/agents/agt_1' })
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ data: { appSecret: '********' } }))
    })

    it('prints credentials verbatim with --show-secrets', async () => {
      mockGet.mockResolvedValueOnce({ data: { appSecret: 'sk-live-1' } })
      await run({ method: 'GET', path: '/api/agents/agt_1', 'show-secrets': true })
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ data: { appSecret: 'sk-live-1' } }))
    })

    it('prints JSON even without --json, since there is no human path', async () => {
      mockGet.mockResolvedValueOnce({ data: 1 })
      await run({ method: 'GET', path: '/api/agents' })
      expect(consoleSpy).toHaveBeenCalledWith('{"data":1}')
    })

    it('honours --json-pretty and --fields', async () => {
      mockGet.mockResolvedValueOnce({ data: { id: 'agt_1', name: 'bot' } })
      await run({ method: 'GET', path: '/api/agents/agt_1', fields: 'data.id' })
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ data: { id: 'agt_1' } }))
    })
  })

  describe('help text', () => {
    it('argues for the typed command first', async () => {
      const description =
        apiCommand.meta && 'description' in apiCommand.meta
          ? String(apiCommand.meta.description)
          : ''
      expect(description.toLowerCase()).toMatch(/typed command/)
    })

    it('declares meta.name matching its subCommands key', () => {
      expect(apiCommand.meta && 'name' in apiCommand.meta ? apiCommand.meta.name : undefined).toBe(
        'api',
      )
    })
  })
})
