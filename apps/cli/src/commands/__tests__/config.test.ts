import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLoadConfig = vi.fn()
const mockSaveConfig = vi.fn()

const mockSaveProfile = vi.fn()
const mockResolveProfileUrl = vi.fn()

vi.mock('../../config.js', () => ({
  loadConfig: () => mockLoadConfig(),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  saveProfile: (...args: unknown[]) => mockSaveProfile(...args),
  resolveProfileUrl: (...args: unknown[]) => mockResolveProfileUrl(...args),
}))

const { configCommand } = await import('../config.js')

type SubCmd = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> | void }
const subs = configCommand.subCommands as Record<string, SubCmd>

describe('config command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('set-url', () => {
    it('writes the URL to config (preserving token)', () => {
      mockLoadConfig.mockImplementation(() => ({ token: 'tok', url: 'https://old' }))
      subs['set-url'].run({ args: { url: 'https://new.host/' } })
      // trailing slash is stripped
      expect(mockSaveConfig).toHaveBeenCalledWith({ token: 'tok', url: 'https://new.host' })
    })

    it('initializes config when none exists', () => {
      mockLoadConfig.mockImplementation(() => null)
      subs['set-url'].run({ args: { url: 'http://localhost:3502' } })
      expect(mockSaveConfig).toHaveBeenCalledWith({ token: '', url: 'http://localhost:3502' })
    })

    it('rejects URLs without http(s):// prefix', () => {
      mockLoadConfig.mockImplementation(() => ({ token: 'tok' }))
      expect(() => subs['set-url'].run({ args: { url: 'just-a-host.com' } })).toThrow(
        /must start with http/,
      )
      expect(mockSaveConfig).not.toHaveBeenCalled()
    })

    it('rejects empty URL', () => {
      mockLoadConfig.mockImplementation(() => ({ token: 'tok' }))
      expect(() => subs['set-url'].run({ args: { url: '   ' } })).toThrow(/must not be empty/)
      expect(mockSaveConfig).not.toHaveBeenCalled()
    })
  })

  describe('get', () => {
    it('prints url and masked token (last 4 chars only)', () => {
      mockLoadConfig.mockImplementation(() => ({
        url: 'http://localhost:3502',
        token: 'eyJabcdefghijk1234',
      }))
      subs.get.run({ args: {} })
      expect(logSpy).toHaveBeenCalledWith('url:   http://localhost:3502')
      expect(logSpy).toHaveBeenCalledWith('token: ***1234')
    })

    it('shows <unset> for missing fields', () => {
      mockLoadConfig.mockImplementation(() => ({ token: 'abc' }))
      subs.get.run({ args: {} })
      expect(logSpy).toHaveBeenCalledWith('url:   <unset>')
    })

    it('handles no config gracefully', () => {
      mockLoadConfig.mockImplementation(() => null)
      subs.get.run({ args: {} })
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('not configured'))
    })

    it('masks short token to **** instead of leaking', () => {
      mockLoadConfig.mockImplementation(() => ({ token: 'abc' }))
      subs.get.run({ args: {} })
      expect(logSpy).toHaveBeenCalledWith('token: ****')
    })
  })

  describe('unset-url', () => {
    it('removes url field, preserves token', () => {
      mockLoadConfig.mockImplementation(() => ({ url: 'http://x', token: 'tok' }))
      subs['unset-url'].run({ args: {} })
      const written = (mockSaveConfig.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>
      expect(written.url).toBeUndefined()
      expect(written.token).toBe('tok')
    })

    it('no-op when no config exists', () => {
      mockLoadConfig.mockImplementation(() => null)
      subs['unset-url'].run({ args: {} })
      expect(mockSaveConfig).not.toHaveBeenCalled()
    })
  })
  // Profiles are named aliases over URL-keyed credentials, for humans switching
  // contexts. An agent almost never wants "a profile" — it wants "this URL with
  // the right token" — so these must not complicate the common path.
  describe('profiles', () => {
    it('add stores a profile', () => {
      subs['add-profile'].run({ args: { name: 'staging', url: 'https://b.example' } })
      expect(mockSaveProfile).toHaveBeenCalledWith('staging', 'https://b.example')
    })

    it('add rejects a URL without a scheme, like set-url does', () => {
      expect(() => subs['add-profile'].run({ args: { name: 'x', url: 'b.example' } })).toThrow(
        /http/,
      )
      expect(mockSaveProfile).not.toHaveBeenCalled()
    })

    it('use points the default URL at the profile', () => {
      mockResolveProfileUrl.mockReturnValue('https://b.example')
      mockLoadConfig.mockReturnValue({ token: 'tok', url: 'https://a.example' })

      subs.use.run({ args: { name: 'staging' } })

      expect(mockResolveProfileUrl).toHaveBeenCalledWith('staging')
      expect(mockSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://b.example', currentProfile: 'staging' }),
      )
    })

    it('list prints each profile with its URL', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      mockLoadConfig.mockReturnValue({
        token: 'tok',
        profiles: { prod: { url: 'https://a.example' }, staging: { url: 'https://b.example' } },
        currentProfile: 'prod',
      })

      subs.list.run({ args: {} })

      const out = log.mock.calls.map((c) => String(c[0])).join('\n')
      expect(out).toContain('prod')
      expect(out).toContain('https://b.example')
      log.mockRestore()
    })

    it('list emits machine-readable output with --json', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      mockLoadConfig.mockReturnValue({
        token: 'tok',
        profiles: { prod: { url: 'https://a.example' } },
        currentProfile: 'prod',
      })

      subs.list.run({ args: { json: true } })

      const parsed = JSON.parse(String(log.mock.calls.at(-1)?.[0]))
      expect(parsed.current).toBe('prod')
      expect(parsed.profiles).toEqual({ prod: { url: 'https://a.example' } })
      log.mockRestore()
    })

    it('list says so plainly when there are none', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      mockLoadConfig.mockReturnValue({ token: 'tok' })

      subs.list.run({ args: {} })

      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/no profiles/i)
      log.mockRestore()
    })
  })
})
