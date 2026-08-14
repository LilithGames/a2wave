import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSaveConfig = vi.fn()
const mockClearConfig = vi.fn()
const mockLoadConfig = vi.fn()

const mockResolveUrl = vi.fn(() => 'https://a2wave.test')
const mockSaveCredential = vi.fn()
vi.mock('../../config.js', () => ({
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  saveCredential: (...args: unknown[]) => mockSaveCredential(...args),
  clearConfig: () => mockClearConfig(),
  loadConfig: () => mockLoadConfig(),
  resolveUrl: () => mockResolveUrl(),
}))

const mockOauthLogin = vi.fn()
vi.mock('../oauth.js', () => ({
  oauthLogin: (...args: unknown[]) => mockOauthLogin(...args),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const mockQuestion = vi.fn()
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: mockQuestion,
    close: vi.fn(),
  }),
}))

const { logoutCommand, loginCommand } = await import('../login.js')

describe('logoutCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('revokes the server token when config has URL and token, then clears local config', async () => {
    mockLoadConfig.mockReturnValue({ url: 'https://a2wave.test', token: 'jwt-local' })
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { message: 'ok' } }), { status: 200 }),
    )

    await logoutCommand.run!({} as never)

    expect(mockFetch).toHaveBeenCalledWith(
      'https://a2wave.test/api/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-local' }),
      }),
    )
    expect(mockClearConfig).toHaveBeenCalled()
  })

  it('still clears local config when server revoke fails', async () => {
    mockLoadConfig.mockReturnValue({ url: 'https://a2wave.test', token: 'jwt-local' })
    mockFetch.mockRejectedValueOnce(new Error('network down'))

    await logoutCommand.run!({} as never)

    expect(mockClearConfig).toHaveBeenCalled()
  })
})

describe('loginCommand — OAuth (default)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('with no args: calls oauthLogin with no params (pure SSO, no URL touched)', async () => {
    await loginCommand.run!({ args: {} } as never)

    expect(mockOauthLogin).toHaveBeenCalledWith({
      idaasToken: undefined,
      cacheOnly: false,
      url: undefined,
    })
  })

  it('--idaas-token forwards into oauthLogin', async () => {
    await loginCommand.run!({ args: { 'idaas-token': 'jwt-x' } } as never)
    expect(mockOauthLogin).toHaveBeenCalledWith(expect.objectContaining({ idaasToken: 'jwt-x' }))
  })

  it('--no-browser maps to cacheOnly:true', async () => {
    await loginCommand.run!({ args: { browser: false } } as never)
    expect(mockOauthLogin).toHaveBeenCalledWith(expect.objectContaining({ cacheOnly: true }))
  })

  it('does not accept --url anymore (login is pure IDaaS, URL handled by config / commands)', async () => {
    // --url is no longer an OAuth login argument; the oauthLogin call must not include any url field
    await loginCommand.run!({ args: {} } as never)
    expect(mockOauthLogin).toHaveBeenCalledWith(
      expect.not.objectContaining({ url: expect.anything() }),
    )
  })

  it('does not call fetch (no a2wave URL is touched in OAuth path)', async () => {
    await loginCommand.run!({ args: {} } as never)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('loginCommand — help copy (OSS generalization)', () => {
  it('meta description names no third-party platform; describes an SSO token cache', () => {
    const desc = (loginCommand.meta as { description: string }).description
    expect(desc).not.toMatch(/atlas/i)
    expect(desc).toContain('SSO')
  })

  it('--idaas-token description says "manually pass an IdP-issued JWT"', () => {
    const args = loginCommand.args as Record<string, { description?: string }>
    expect(args['idaas-token'].description).toContain('IdP-issued JWT')
  })
})

describe('loginCommand — --password (legacy)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  function mockPasswordPrompt(password: string) {
    // Both the command and readSecret refuse to prompt without a TTY, so the
    // fake terminal has to claim to be one.
    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const originalSetRawMode = process.stdin.setRawMode
    const originalResume = process.stdin.resume
    const originalSetEncoding = process.stdin.setEncoding
    const originalOn = process.stdin.on
    const originalPause = process.stdin.pause
    const originalRemoveListener = process.stdin.removeListener

    process.stdin.setRawMode = vi.fn().mockReturnValue(process.stdin) as never
    process.stdin.resume = vi.fn().mockReturnValue(process.stdin) as never
    process.stdin.setEncoding = vi.fn().mockReturnValue(process.stdin) as never
    process.stdin.pause = vi.fn() as never
    process.stdin.removeListener = vi.fn().mockReturnValue(process.stdin) as never
    process.stdin.isRaw = false
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    let dataListener: ((ch: string) => void) | null = null
    process.stdin.on = vi.fn().mockImplementation((event: string, cb: (ch: string) => void) => {
      if (event === 'data') dataListener = cb
      return process.stdin
    }) as never

    return {
      async type() {
        await vi.waitFor(() => {
          if (!dataListener) throw new Error('not yet')
        })
        for (const ch of password) dataListener!(ch)
        dataListener!('\n')
      },
      restore() {
        process.stdin.setRawMode = originalSetRawMode
        process.stdin.resume = originalResume
        process.stdin.setEncoding = originalSetEncoding
        process.stdin.pause = originalPause
        process.stdin.removeListener = originalRemoveListener
        process.stdin.on = originalOn
        Object.defineProperty(process.stdin, 'isTTY', {
          value: originalIsTTY,
          configurable: true,
        })
      },
    }
  }

  it('--password without a TTY errors out instead of echoing the password', async () => {
    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    mockResolveUrl.mockReturnValue('https://a2wave.example.com')
    try {
      await expect(
        (loginCommand.run as (c: { args: Record<string, unknown> }) => Promise<void>)({
          args: { password: true },
        }),
      ).rejects.toThrow(/not a terminal/i)
      // Must fail before asking anything, and before any network call
      expect(mockFetch).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
    }
  })

  it('--password with no URL anywhere: resolveUrl throws three-way hint', async () => {
    mockResolveUrl.mockImplementationOnce(() => {
      throw new Error('No a2wave instance URL specified')
    })
    await expect(loginCommand.run!({ args: { password: true } } as never)).rejects.toThrow(
      /No a2wave instance URL specified/,
    )
    expect(mockOauthLogin).not.toHaveBeenCalled()
  })

  it('with --password and resolved URL: prompts username + password and POSTs /api/auth/login', async () => {
    mockResolveUrl.mockReturnValueOnce('https://a2wave.test')
    mockQuestion.mockResolvedValueOnce('admin')
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { token: 'jwt-pw' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const sim = mockPasswordPrompt('pass')
    try {
      const promise = loginCommand.run!({ args: { password: true } } as never)
      await sim.type()
      await promise
    } finally {
      sim.restore()
    }

    expect(mockOauthLogin).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledWith(
      'https://a2wave.test/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'pass' }),
      }),
    )
    expect(mockSaveConfig).toHaveBeenCalledWith({ url: 'https://a2wave.test', token: 'jwt-pw' })
    // ALSO filed against its own URL. Without this, logging into a second
    // deployment overwrote the first one's token and `--url` back to it sent a
    // credential that no longer belonged to it.
    expect(mockSaveCredential).toHaveBeenCalledWith('https://a2wave.test', 'jwt-pw')
    expect(consoleSpy).toHaveBeenCalledWith('Login successful ✓')
  })

  it('throws on password login failure', async () => {
    mockResolveUrl.mockReturnValueOnce('https://a2wave.test')
    mockQuestion.mockResolvedValueOnce('admin')
    mockFetch.mockResolvedValueOnce(new Response('Invalid credentials', { status: 401 }))

    const sim = mockPasswordPrompt('wrong')
    try {
      const promise = loginCommand.run!({ args: { password: true } } as never)
      await sim.type()
      await expect(promise).rejects.toThrow('Login failed (401)')
    } finally {
      sim.restore()
    }
  })
})
