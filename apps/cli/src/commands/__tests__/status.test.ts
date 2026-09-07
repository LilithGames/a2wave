import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../../errors.js'

const mockLoadConfig = vi.fn()
vi.mock('../../config.js', () => ({
  loadConfig: () => mockLoadConfig(),
  resolveCredential: (url: string) => {
    // Mirrors the real resolver's one load-bearing rule: the legacy top-level
    // token belongs to `config.url` and to no other instance.
    const key = url.replace(/\/+$/, '')
    const config = mockLoadConfig() as { url?: string; token?: string } | null
    if (config?.token && config.url && config.url.replace(/\/+$/, '') === key) return config.token
    throw new CliError(
      config?.token ? `No stored credential for ${key}.` : 'Not logged in. Run: a2wave login',
      {
        type: 'auth',
        subtype: config?.token ? 'no_credential_for_url' : 'not_logged_in',
        hint: `a2wave login --url ${key}`,
      },
    )
  },
}))

const mockExistsSync = vi.fn<(p: string) => boolean>()
const mockReadFileSync = vi.fn<(p: string) => string>()
vi.mock('node:fs', () => ({
  existsSync: (p: string) => mockExistsSync(p),
  readFileSync: (p: string) => mockReadFileSync(p),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const { statusCommand } = await import('../status.js')

function makeJwt(alg: 'RS256' | 'HS256', claims: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url')
  const b = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${h}.${b}.signature`
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function runStatus(args: Record<string, unknown> = {}): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.join(' '))
  })
  try {
    // citty's run receives ctx { args, cmd, ... }; only args is used here for simplicity
    await (statusCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({ args })
  } finally {
    spy.mockRestore()
  }
  return lines.join('\n')
}

describe('a2wave status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockLoadConfig.mockReturnValue(null)
    delete process.env.A2WAVE_URL
    delete process.env.A2WAVE_OAUTH_CACHE_PATH
  })
  afterEach(() => {
    delete process.env.A2WAVE_URL
    delete process.env.A2WAVE_OAUTH_CACHE_PATH
  })

  it('not logged in + no URL: prints not set / not logged in, no requests made', async () => {
    const out = await runStatus()
    expect(out).toContain('URL:')
    expect(out).toContain('not set')
    expect(out).toContain('Token:')
    expect(out).toContain('not logged in')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('URL from env: source=env, runs the health probe', async () => {
    process.env.A2WAVE_URL = 'http://api.test'
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const out = await runStatus()
    expect(out).toContain('http://api.test')
    expect(out).toContain('source: env')
    expect(out).toContain('✓ ok (HTTP 200)')
    expect(mockFetch).toHaveBeenCalledWith('http://api.test/api/health', expect.anything())
  })

  it('URL probe degrades gracefully on network error, does not throw', async () => {
    process.env.A2WAVE_URL = 'http://api.test'
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const out = await runStatus()
    expect(out).toContain('✗ unreachable')
    expect(out).toContain('ECONNREFUSED')
  })

  it('valid SSO cache: shows ✓ valid + email + time left', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const jwt = makeJwt('RS256', { email: 'me@l.com', exp })
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ access_token: jwt, expires_at: new Date(exp * 1000).toISOString() }),
    )
    const out = await runStatus()
    expect(out).toMatch(/SSO token cache[\s\S]*✓ valid/)
    expect(out).toContain('me@l.com')
    expect(out).toContain('left')
  })

  it('SSO cache path resolution: env A2WAVE_OAUTH_CACHE_PATH takes precedence', async () => {
    process.env.A2WAVE_OAUTH_CACHE_PATH = '/custom/sso-cache.json'
    mockExistsSync.mockImplementation((p: string) => p === '/custom/sso-cache.json')
    mockReadFileSync.mockReturnValue(JSON.stringify({ access_token: 'tok' }))
    const out = await runStatus()
    expect(out).toContain('/custom/sso-cache.json')
  })

  it('SSO cache path resolution: falls back to the default ~/.a2wave/oauth.json', async () => {
    const out = await runStatus()
    expect(out).toContain('oauth.json')
  })

  // Regression: status used to report a third-party credential file as its own
  // cache whenever one happened to exist in the home directory.
  it('never reports a third-party credential cache, even when one exists', async () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.atlas-ai-gateway-oauth.json'))
    mockReadFileSync.mockReturnValue(JSON.stringify({ access_token: 'tok' }))
    const out = await runStatus()
    expect(out).not.toContain('atlas')
  })

  it('expired SSO cache token: shows ✗ expired', async () => {
    const exp = Math.floor(Date.now() / 1000) - 60
    const jwt = makeJwt('RS256', { email: 'old@l.com', exp })
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ access_token: jwt }))
    const out = await runStatus()
    expect(out).toContain('✗ expired')
  })

  it('SSO cache file exists but JSON is corrupt: shows ✗ cannot be parsed', async () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('oauth.json'))
    mockReadFileSync.mockReturnValue('not-json{')
    const out = await runStatus()
    expect(out).toContain('✗ file exists but cannot be parsed')
  })

  it('a2wave credential is RS256: labeled SSO JWT, exchanges first then calls /auth/me', async () => {
    const jwt = makeJwt('RS256', { exp: Math.floor(Date.now() / 1000) + 3600 })
    mockLoadConfig.mockReturnValue({ url: 'http://api.test', token: jwt })
    mockFetch
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // /api/health
      .mockResolvedValueOnce(jsonResponse({ data: { token: 'a2w_x' } })) // /oauth/exchange
      .mockResolvedValueOnce(
        jsonResponse({
          data: { id: 'usr_1', username: 'tate', displayName: 'Tate', role: 'admin' },
        }),
      )

    const out = await runStatus()
    expect(out).toContain('SSO JWT (RS256)')
    expect(out).toContain('a2wave 24h short-lived token is exchanged on every API call')
    expect(out).toContain('tate')
    expect(out).toContain('Tate')
    expect(out).toContain('admin')
    expect(out).toContain('usr_1')
    expect(out).toContain('exchanged the SSO JWT')
  })

  it('SSO scenario: a2wave credential is explicitly marked when same source as the SSO cache', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const jwt = makeJwt('RS256', { email: 'me@l.com', exp })
    mockLoadConfig.mockReturnValue({ url: 'http://api.test', token: jwt })
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ access_token: jwt, expires_at: new Date(exp * 1000).toISOString() }),
    )
    mockFetch
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ data: { token: 'a2w_x' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'usr_1', username: 't', role: 'user' } }))

    const out = await runStatus()
    expect(out).toContain('same source as the SSO cache')
  })

  it('a2wave credential is HS256: used directly, no exchange', async () => {
    const jwt = makeJwt('HS256', { exp: Math.floor(Date.now() / 1000) + 3600 })
    mockLoadConfig.mockReturnValue({ url: 'http://api.test', token: jwt })
    mockFetch
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // /api/health
      .mockResolvedValueOnce(
        jsonResponse({ data: { id: 'usr_1', username: 'tate', role: 'user' } }),
      )

    const out = await runStatus()
    expect(out).toContain('a2wave self-signed token (HS256)')
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls.some((c) => /oauth\/exchange/.test(c[0]))).toBe(false)
  })

  it('/auth/me 401: reports the reason without throwing', async () => {
    const jwt = makeJwt('HS256', { exp: Math.floor(Date.now() / 1000) + 3600 })
    mockLoadConfig.mockReturnValue({ url: 'http://api.test', token: jwt })
    mockFetch
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))

    const out = await runStatus()
    expect(out).toContain('✗ /auth/me HTTP 401')
  })

  it('--url has the highest precedence, marked source=flag', async () => {
    process.env.A2WAVE_URL = 'http://from-env'
    mockLoadConfig.mockReturnValue({ url: 'http://from-config', token: '' })
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const out = await runStatus({ url: 'http://from-flag' })
    expect(out).toContain('http://from-flag')
    expect(out).toContain('source: flag')
  })

  it('names the wrong-instance credential instead of claiming you are logged out', async () => {
    // The stored login belongs to another instance, so the diagnostic must say
    // so rather than sending the user through a login they already completed.
    const jwt = makeJwt('HS256', { exp: Math.floor(Date.now() / 1000) + 3600 })
    mockLoadConfig.mockReturnValue({ url: 'http://instance-a.test', token: jwt })
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const out = await runStatus({ url: 'http://instance-b.test' })
    expect(out).toContain('No stored credential for http://instance-b.test')
    expect(out).toContain('a2wave login --url http://instance-b.test')
    expect(out).not.toContain(jwt)
  })
})
