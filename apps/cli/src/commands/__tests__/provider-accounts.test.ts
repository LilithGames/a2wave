import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  resolveProviderId: vi.fn(),
  connect: vi.fn(),
  readSecret: vi.fn(),
  createClient: vi.fn(),
}))
vi.mock('../../client.js', () => ({ urlArg: {}, createClient: mocks.createClient }))
vi.mock('../../config.js', () => ({
  resolveUrl: (url?: string) => url ?? 'https://default.example',
}))
vi.mock('../../lib/provider-oauth-login.js', () => ({ connectProviderOauth: mocks.connect }))
vi.mock('../../lib/prompt.js', () => ({ readSecret: mocks.readSecret }))
vi.mock('../oauth.js', () => ({ openBrowser: vi.fn() }))

const { providerAccountsCommand } = await import('../provider-accounts.js')
type Command = { run: (context: { args: Record<string, unknown> }) => Promise<void> }
const command = (name: string) =>
  (providerAccountsCommand.subCommands as Record<string, Command>)[name]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createClient.mockReturnValue(mocks)
  mocks.resolveProviderId.mockResolvedValue('prv_codex')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('provider accounts commands', () => {
  it('lists account metadata as JSON', async () => {
    mocks.get.mockResolvedValue({ data: [{ id: 'poa_one', label: 'Work', status: 'ready' }] })
    await command('list').run({ args: { provider: 'Codex CLI', json: true } })
    expect(mocks.get).toHaveBeenCalledWith('/api/providers/prv_codex/oauth-accounts')
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      data: [{ id: 'poa_one', label: 'Work', status: 'ready' }],
    })
  })
  it('connects a Web login with its one-time code, without borrowing another a2wave session', async () => {
    mocks.readSecret.mockResolvedValue('one-time-code')
    mocks.connect.mockResolvedValue({ accountId: 'poa_one' })
    await command('login').run({
      args: { server: 'https://remote.example', 'login-id': 'pol_one' },
    })
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        server: 'https://remote.example',
        loginId: 'pol_one',
        loginToken: 'one-time-code',
      }),
    )
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('one-time-code')
  })
  it('starts a new login through the existing authenticated CLI when no Web login is supplied', async () => {
    mocks.post.mockResolvedValue({ data: { loginId: 'pol_two', loginToken: 'private-code' } })
    mocks.connect.mockResolvedValue({ accountId: 'poa_two' })
    await command('login').run({ args: { provider: 'Codex CLI', label: 'Personal', json: true } })
    expect(mocks.post).toHaveBeenCalledWith('/api/providers/prv_codex/oauth-accounts/login', {
      label: 'Personal',
    })
    expect(mocks.readSecret).not.toHaveBeenCalled()
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toEqual({
      data: { accountId: 'poa_two' },
    })
  })
  it('honors the parsed --no-browser flag', async () => {
    mocks.post.mockResolvedValue({ data: { loginId: 'pol_two', loginToken: 'private-code' } })
    mocks.connect.mockResolvedValue({ accountId: 'poa_two' })
    await command('login').run({ args: { provider: 'Codex CLI', browser: false } })
    expect(mocks.connect.mock.calls[0][0].openBrowser('http://127.0.0.1:123/auth/start')).toBe(
      false,
    )
  })
  it('renames and disconnects only the specified Provider account', async () => {
    mocks.patch.mockResolvedValue({ data: { id: 'poa_one', label: 'Team' } })
    mocks.del.mockResolvedValue({ data: { id: 'poa_one' } })
    await command('rename').run({
      args: { provider: 'Codex CLI', id: 'poa_one', label: 'Team', json: true },
    })
    await command('delete').run({
      args: { provider: 'Codex CLI', id: 'poa_one', force: true, json: true },
    })
    expect(mocks.patch).toHaveBeenCalledWith('/api/providers/prv_codex/oauth-accounts/poa_one', {
      label: 'Team',
    })
    expect(mocks.del).toHaveBeenCalledWith('/api/providers/prv_codex/oauth-accounts/poa_one')
  })
  it('rejects an interactive connection-code prompt in JSON mode', async () => {
    await expect(
      command('login').run({ args: { 'login-id': 'pol_one', json: true } }),
    ).rejects.toThrow('--code-stdin')
    expect(mocks.readSecret).not.toHaveBeenCalled()
  })
})
