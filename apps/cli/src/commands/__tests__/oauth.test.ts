import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSaveConfig = vi.fn()
const mockLoadConfig = vi.fn()
vi.mock('../../config.js', () => ({
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  loadConfig: () => mockLoadConfig(),
  clearConfig: vi.fn(),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const mockExecFileSync = vi.fn()
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}))

const {
  readTokenCache,
  oauthLogin,
  waitForCallback,
  resolveSsoEntryUrl,
  buildSsoRedirectUrl,
  openBrowser,
} = await import('../oauth.js')

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    fn()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

describe('readTokenCache', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'a2wave-oauth-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when file is missing', () => {
    expect(readTokenCache(join(dir, 'missing.json'))).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    const p = join(dir, 'bad.json')
    writeFileSync(p, 'not-json{')
    expect(readTokenCache(p)).toBeNull()
  })

  it('returns access_token when expires_at is in the future (ISO)', () => {
    const p = join(dir, 'a.json')
    const exp = new Date(Date.now() + 3_600_000).toISOString()
    writeFileSync(p, JSON.stringify({ access_token: 'jwt-1', expires_at: exp }))
    expect(readTokenCache(p)).toBe('jwt-1')
  })

  it('returns null when token expires within the 60s safety window', () => {
    const p = join(dir, 'b.json')
    const exp = new Date(Date.now() + 30_000).toISOString()
    writeFileSync(p, JSON.stringify({ access_token: 'jwt-2', expires_at: exp }))
    expect(readTokenCache(p)).toBeNull()
  })

  it('returns null when expires_at is invalid', () => {
    const p = join(dir, 'c.json')
    writeFileSync(p, JSON.stringify({ access_token: 'jwt-3', expires_at: 'not-a-date' }))
    expect(readTokenCache(p)).toBeNull()
  })

  it('returns token when no expires_at field present (best effort)', () => {
    const p = join(dir, 'd.json')
    writeFileSync(p, JSON.stringify({ access_token: 'jwt-4' }))
    expect(readTokenCache(p)).toBe('jwt-4')
  })
})

/** Build a minimal RS256-style JWT (only payload matters for our parsing). */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('oauthLogin', () => {
  let dir: string
  let cachePath: string
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue(null)
    dir = mkdtempSync(join(tmpdir(), 'a2wave-oauth-login-'))
    cachePath = join(dir, 'gateway.json')
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    warnSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('preserves existing config.url, only updates token', async () => {
    mockLoadConfig.mockReturnValue({ url: 'https://existing.host', token: 'old-token' })
    const jwt = makeJwt({ email: 'a@b.com', exp: Math.floor(Date.now() / 1000) + 3600 })
    await oauthLogin({ idaasToken: jwt, cachePath })
    expect(mockSaveConfig).toHaveBeenCalledWith({ url: 'https://existing.host', token: jwt })
  })

  it('with no existing config: writes only token (url undefined), prints config-set hint', async () => {
    const jwt = makeJwt({ email: 'a@b.com', exp: Math.floor(Date.now() / 1000) + 3600 })
    await oauthLogin({ idaasToken: jwt, cachePath })
    expect(mockSaveConfig).toHaveBeenCalledWith({ token: jwt })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('url not set'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('a2wave config set-url'))
  })

  it('with --idaas-token: writes the token to the shared cache and reports email', async () => {
    const jwt = makeJwt({
      email: 'me@example.com',
      sub: 'sub-x',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    await oauthLogin({ idaasToken: jwt, cachePath })

    expect(existsSync(cachePath)).toBe(true)
    const written = JSON.parse(readFileSync(cachePath, 'utf-8'))
    expect(written.access_token).toBe(jwt)
    expect(written.expires_at).toBeTruthy()

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Login successful ✓'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('me@example.com'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('manual'))
  })

  it('tightens permissions when overwriting an existing shared cache', async () => {
    writeFileSync(cachePath, '{}')
    chmodSync(cachePath, 0o644)
    const jwt = makeJwt({ email: 'me@example.com', exp: Math.floor(Date.now() / 1000) + 3600 })

    await oauthLogin({ idaasToken: jwt, cachePath })

    expect(statSync(cachePath).mode & 0o777).toBe(0o600)
  })

  it('with --idaas-token but no exp: completes login without throwing (cache write swallows error)', async () => {
    const jwt = makeJwt({ email: 'noexp@example.com' })
    await oauthLogin({ idaasToken: jwt, cachePath })
    // Cache write fails (no exp → getJwtExpiry throws), warning is shown but login still succeeds
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Login successful ✓'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to write shared cache'))
  })

  it('with cache hit: reuses token, source=cache', async () => {
    const jwt = makeJwt({ email: 'cached@example.com', exp: Math.floor(Date.now() / 1000) + 3600 })
    const exp = new Date(Date.now() + 3_600_000).toISOString()
    writeFileSync(cachePath, JSON.stringify({ access_token: jwt, expires_at: exp }))

    await oauthLogin({ cachePath })

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('cached@example.com'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('cache'))
  })

  it('with --no-browser and missing cache: throws helpful message', async () => {
    await expect(oauthLogin({ cacheOnly: true, cachePath })).rejects.toThrow(
      /No valid SSO token found/,
    )
  })

  it('falls back to sub when email is missing in token claims', async () => {
    const jwt = makeJwt({ sub: 'fallback-sub', exp: Math.floor(Date.now() / 1000) + 3600 })
    await oauthLogin({ idaasToken: jwt, cachePath })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('fallback-sub'))
  })

  it('shows <unknown> when JWT is malformed but does not throw', async () => {
    await oauthLogin({ idaasToken: 'not-a-valid-jwt', cachePath })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('<unknown>'))
  })
})

describe('resolveSsoEntryUrl', () => {
  function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue(null)
    delete process.env.A2WAVE_SSO_URL
    delete process.env.A2WAVE_URL
  })

  afterEach(() => {
    delete process.env.A2WAVE_SSO_URL
    delete process.env.A2WAVE_URL
  })

  it('env A2WAVE_SSO_URL wins; no HTTP request is made', async () => {
    process.env.A2WAVE_SSO_URL = 'https://sso.example.com/login?enterpriseId=acme'
    await expect(resolveSsoEntryUrl()).resolves.toBe(
      'https://sso.example.com/login?enterpriseId=acme',
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('blank env A2WAVE_SSO_URL is ignored and reports it as unset', async () => {
    process.env.A2WAVE_SSO_URL = '   '
    await expect(resolveSsoEntryUrl()).rejects.toThrow(/A2WAVE_SSO_URL is not set/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // The browser flow needs an IdP entry that redirects back to the CLI's loopback
  // listener; the platform's own OIDC login ends in a browser session instead, so
  // there is nothing to fall back to — the error must point at the headless paths.
  it('throws with --idaas-token guidance when $A2WAVE_SSO_URL is unset', async () => {
    mockLoadConfig.mockReturnValue({ url: 'https://a2wave.test', token: '' })
    await expect(resolveSsoEntryUrl()).rejects.toThrow(/--idaas-token/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // Device login needs nothing configured up front, so it is the one path that
  // just works here. It must be offered first; before this it was missing from
  // the list entirely and users were sent to set up an IdP entry instead.
  it('offers --device first when $A2WAVE_SSO_URL is unset', async () => {
    mockLoadConfig.mockReturnValue({ url: 'https://a2wave.test', token: '' })
    const err = await resolveSsoEntryUrl().catch((e: Error) => e)
    const message = (err as Error).message

    expect(message).toContain('--device')
    expect(message.indexOf('--device')).toBeLessThan(message.indexOf('--idaas-token'))
    expect(message.indexOf('--device')).toBeLessThan(
      message.indexOf('A2WAVE_SSO_URL=<IdP SSO URL>'),
    )
  })

  // The old line read "use username/password: a2wave login", which is the exact
  // command that just failed — it looped the user back into this same error.
  it('names --password for the password path, not bare `a2wave login`', async () => {
    mockLoadConfig.mockReturnValue({ url: 'https://a2wave.test', token: '' })
    const err = await resolveSsoEntryUrl().catch((e: Error) => e)
    const message = (err as Error).message

    expect(message).toMatch(/a2wave login --password/)
    expect(message).not.toMatch(/username\/password: a2wave login$/m)
  })
})

describe('openBrowser', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset()
  })

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<h1>x', 'not a url'])(
    'refuses to hand %s to the system opener',
    (target) => {
      // The URL comes from a server response (verificationUriComplete). Handing an
      // arbitrary scheme to the OS opener turns a login into script/file execution.
      withPlatform('darwin', () => {
        expect(openBrowser(target)).toBe(false)
      })
      expect(mockExecFileSync).not.toHaveBeenCalled()
    },
  )

  it('opens an http(s) URL through the platform opener on darwin', () => {
    withPlatform('darwin', () => {
      expect(openBrowser('https://a2wave.example.com/device?code=X')).toBe(true)
    })
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'open',
      ['https://a2wave.example.com/device?code=X'],
      expect.anything(),
    )
  })

  it('never routes a URL through cmd.exe on win32', () => {
    // libuv quotes only arguments containing whitespace or a quote, so `&`, `|` and
    // `^` in a server-supplied URL would reach cmd.exe's own parser as operators.
    withPlatform('win32', () => {
      expect(openBrowser('https://a2wave.example.com/device?a=1&b=2')).toBe(true)
    })
    const [command, args] = mockExecFileSync.mock.calls[0] as [string, string[]]
    expect(command).not.toMatch(/cmd/i)
    expect(command).toBe('rundll32')
    expect(args).toEqual([
      'url.dll,FileProtocolHandler',
      'https://a2wave.example.com/device?a=1&b=2',
    ])
  })
})

describe('buildSsoRedirectUrl scheme guard', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd'])('rejects %s as an SSO entry', (entry) => {
    expect(() => buildSsoRedirectUrl(entry, 'http://localhost:20265/callback', 'n')).toThrow(
      /http/i,
    )
  })
})
