import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({ get: mockGet }),
}))

const mockResolveUrl = vi.fn(() => 'https://a2wave.example')
vi.mock('../../config.js', () => ({
  resolveUrl: (...a: unknown[]) => mockResolveUrl(...(a as [])),
}))

const { whoamiCommand } = await import('../whoami.js')

type TestCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
const whoami = whoamiCommand as unknown as TestCommand

describe('whoamiCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveUrl.mockReturnValue('https://a2wave.example')
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  // The whole point of whoami is that it is CHEAP. An agent calls it before a
  // risky write to confirm who it is acting as; making it pay for a health
  // probe, an SSO cache read and a token parse would defeat that — `status`
  // already answers the broader question.
  it('makes exactly one request, to /api/auth/me', async () => {
    mockGet.mockResolvedValueOnce({ data: { id: 'usr_1', username: 'bob', role: 'admin' } })

    await whoami.run({ args: {} })

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet).toHaveBeenCalledWith('/api/auth/me')
  })

  it('prints the identity and the instance it applies to', async () => {
    mockGet.mockResolvedValueOnce({
      data: { id: 'usr_1', username: 'bob', displayName: 'Bob', role: 'admin' },
    })

    await whoami.run({ args: {} })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('bob')
    expect(out).toContain('admin')
    // "Who am I" is meaningless without "where" — the same account can be an
    // admin on one instance and a viewer on another.
    expect(out).toContain('https://a2wave.example')
  })

  it('emits a machine-readable payload with --json', async () => {
    mockGet.mockResolvedValueOnce({
      data: { id: 'usr_1', username: 'bob', displayName: 'Bob', role: 'admin' },
    })

    await whoami.run({ args: { json: true } })

    const parsed = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))
    expect(parsed.user).toEqual({
      id: 'usr_1',
      username: 'bob',
      displayName: 'Bob',
      role: 'admin',
    })
    expect(parsed.url).toBe('https://a2wave.example')
  })

  it('surfaces admin-ness as a boolean an agent can branch on', async () => {
    // An agent deciding whether to attempt an admin-only route should not have
    // to know that the string is spelled "admin".
    mockGet.mockResolvedValueOnce({ data: { id: 'usr_1', username: 'bob', role: 'admin' } })
    await whoami.run({ args: { json: true } })
    expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0])).isAdmin).toBe(true)

    mockGet.mockResolvedValueOnce({ data: { id: 'usr_2', username: 'ann', role: 'user' } })
    await whoami.run({ args: { json: true } })
    expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0])).isAdmin).toBe(false)
  })

  it('never prints the token', async () => {
    mockGet.mockResolvedValueOnce({
      data: { id: 'usr_1', username: 'bob', role: 'admin', token: 'sk-live-secret' },
    })

    await whoami.run({ args: { json: true } })

    expect(String(consoleSpy.mock.calls.at(-1)?.[0])).not.toContain('sk-live-secret')
  })
})
