import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPatch = vi.fn()
const mockResolveProviderId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    patch: mockPatch,
    resolveProviderId: mockResolveProviderId,
  }),
}))

const { providersCommand } = await import('../providers.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
function getSubCommand(name: string) {
  return (providersCommand.subCommands as Record<string, TestSubCommand>)[name]
}

describe('providersCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('list', () => {
    it('prints providers with their stable kind', async () => {
      mockGet.mockResolvedValueOnce({
        data: [{ id: 'prv_1', name: 'Claude Code', kind: 'claude-code' }],
      })
      await getSubCommand('list').run({ args: {} })
      expect(mockGet).toHaveBeenCalledWith('/api/providers?page=1&pageSize=100')
      expect(consoleSpy).toHaveBeenCalledWith('prv_1  Claude Code  (claude-code)')
    })
  })

  describe('login-status', () => {
    it('checks a valid engine', async () => {
      mockGet.mockResolvedValueOnce({ data: { installed: true, loggedIn: false } })
      await getSubCommand('login-status').run({ args: { engine: 'claude-code' } })
      expect(mockGet).toHaveBeenCalledWith('/api/providers/login-status/claude-code')
      expect(consoleSpy).toHaveBeenCalledWith('Installed:  true')
      expect(consoleSpy).toHaveBeenCalledWith('LoggedIn:   false')
    })

    it('rejects invalid engine', async () => {
      await expect(
        getSubCommand('login-status').run({ args: { engine: 'bogus' } }),
      ).rejects.toThrow('Invalid engine type')
    })

    it('accepts every Provider kind the platform defines', async () => {
      // The CLI ships standalone to the npm registry and deliberately does not
      // depend on @a2wave/shared, so its engine allowlist is a hand-maintained copy. Read
      // PROVIDER_KINDS straight from the shared source to fail loudly when a new
      // Provider is added upstream but not mirrored here — otherwise
      // `providers login-status <new-kind>` rejects a kind the server supports.
      const schemaPath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../packages/shared/src/schemas/provider.ts',
      )
      const source = readFileSync(schemaPath, 'utf8')
      const block = source.match(/export const PROVIDER_KINDS = \[([^\]]*)\]/)
      expect(block, 'PROVIDER_KINDS not found in shared provider schema').not.toBeNull()
      const platformKinds = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
      expect(platformKinds.length).toBeGreaterThan(0)

      for (const kind of platformKinds) {
        mockGet.mockResolvedValueOnce({ data: { installed: true, loggedIn: false } })
        await getSubCommand('login-status').run({ args: { engine: kind } })
        expect(mockGet).toHaveBeenCalledWith(`/api/providers/login-status/${kind}`)
      }
    })
  })

  describe('dependents', () => {
    it('lists dependent agents', async () => {
      mockResolveProviderId.mockResolvedValueOnce('prv_1')
      mockGet.mockResolvedValueOnce({ data: { agents: [{ id: 'agt_1', name: 'A' }] } })
      await getSubCommand('dependents').run({ args: { id: 'Claude Code' } })
      expect(mockGet).toHaveBeenCalledWith('/api/providers/prv_1/dependents')
      expect(consoleSpy).toHaveBeenCalledWith('agt_1  A')
    })
  })

  describe('set-models', () => {
    // Removed with the Provider PATCH route: the model catalog is probed from
    // the CLI per credential, so there is no stored allowlist left to edit.
    it('is no longer registered', () => {
      expect(getSubCommand('set-models')).toBeUndefined()
    })
  })

  // Both are pure reads an agent runs to decide what to do next — "is this CLI
  // logged in?", "who breaks if I retire this Provider?" — and both forced it
  // to scrape a column layout to find out.
  describe('--json', () => {
    it('login-status emits the raw payload', async () => {
      const payload = { installed: true, loggedIn: false, method: 'oauth' }
      mockGet.mockResolvedValueOnce({ data: payload })

      await getSubCommand('login-status').run({ args: { engine: 'codex', json: true } })

      expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual(payload)
    })

    it('dependents emits the raw payload, including the empty case', async () => {
      mockResolveProviderId.mockResolvedValueOnce('prv_1')
      mockGet.mockResolvedValueOnce({ data: { agents: [] } })

      await getSubCommand('dependents').run({ args: { id: 'p', json: true } })

      // The empty list must be a parseable `{agents: []}`, not the human
      // sentence "No agents depend on this provider".
      expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual({ agents: [] })
    })
  })
})
