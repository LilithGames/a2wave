import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockLoadConfig = vi.fn()
vi.mock('../../config.js', () => ({
  loadConfig: () => mockLoadConfig(),
}))

const mockExistsSync = vi.fn<(p: string) => boolean>()
const mockReadFileSync = vi.fn<(p: string) => string>()
vi.mock('node:fs', () => ({
  existsSync: (p: string) => mockExistsSync(p),
  readFileSync: (p: string) => mockReadFileSync(p),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const { runChecks } = await import('../checks.js')
type CheckReport = Awaited<ReturnType<typeof runChecks>>
type Check = CheckReport['checks'][number]

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

/**
 * Reflect.deleteProperty rather than `delete`: the lint rule forbids the
 * operator, and these vars have to be genuinely absent — resolveUrlForStatus
 * reads them with ?.trim(), so setting them to the string 'undefined' would
 * make a URL out of nothing.
 */
function clearUrlEnv(): void {
  Reflect.deleteProperty(process.env, 'A2WAVE_URL')
  Reflect.deleteProperty(process.env, 'A2WAVE_OAUTH_CACHE_PATH')
}

function byName(report: CheckReport, name: string): Check {
  const found = report.checks.find((c) => c.name === name)
  if (!found) throw new Error(`no check named ${name}; got ${report.checks.map((c) => c.name)}`)
  return found
}

describe('runChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockLoadConfig.mockReturnValue(null)
    clearUrlEnv()
  })
  afterEach(() => {
    clearUrlEnv()
  })

  it('returns the five checks in dependency order', async () => {
    const report = await runChecks()
    expect(report.checks.map((c) => c.name)).toEqual([
      'instance.url',
      'instance.health',
      'sso.cache',
      'credentials.token',
      'user.identity',
    ])
  })

  it('no URL and no credentials: url fails, dependents warn, ok is false', async () => {
    const report = await runChecks()
    expect(byName(report, 'instance.url').status).toBe('fail')
    expect(byName(report, 'instance.url').hint).toBe('a2wave config set-url <URL>')
    expect(byName(report, 'instance.health').status).toBe('warn')
    expect(byName(report, 'instance.health').message).toMatch(/URL/)
    expect(byName(report, 'user.identity').status).toBe('warn')
    expect(report.ok).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('a warn alone never makes ok false', async () => {
    process.env.A2WAVE_URL = 'http://api.test'
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const report = await runChecks()
    // No credentials => credentials.token warns, user.identity warns, but the
    // instance is fine, so the rollup must stay true.
    expect(byName(report, 'credentials.token').status).toBe('warn')
    expect(byName(report, 'user.identity').status).toBe('warn')
    expect(report.checks.some((c) => c.status === 'fail')).toBe(false)
    expect(report.ok).toBe(true)
  })

  it('records the URL and its source in detail', async () => {
    process.env.A2WAVE_URL = 'http://api.test/'
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const report = await runChecks()
    const url = byName(report, 'instance.url')
    expect(url.status).toBe('pass')
    expect(url.detail).toMatchObject({ url: 'http://api.test', source: 'env' })
  })

  it('--url override wins and is reported as source=flag', async () => {
    process.env.A2WAVE_URL = 'http://from-env'
    mockLoadConfig.mockReturnValue({ url: 'http://from-config', token: '' })
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const report = await runChecks({ urlOverride: 'http://from-flag' })
    expect(byName(report, 'instance.url').detail).toMatchObject({
      url: 'http://from-flag',
      source: 'flag',
    })
  })

  it('unreachable instance is a fail carrying the network message', async () => {
    process.env.A2WAVE_URL = 'http://api.test'
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const report = await runChecks()
    const health = byName(report, 'instance.health')
    expect(health.status).toBe('fail')
    expect(health.message).toContain('ECONNREFUSED')
    expect(health.hint).toBeTruthy()
    expect(report.ok).toBe(false)
  })

  it('does not tell you to set a URL that is already set', async () => {
    // A reachability failure is not fixed by `config set-url` — we only got far
    // enough to dial the host because the URL resolved. An agent acting on a
    // hint that cannot work is worse off than one given no hint at all.
    process.env.A2WAVE_URL = 'http://api.test'
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const report = await runChecks()
    expect(byName(report, 'instance.health').hint).not.toContain('config set-url')
  })

  it('a non-2xx health response fails with the status in detail', async () => {
    process.env.A2WAVE_URL = 'http://api.test'
    mockFetch.mockResolvedValueOnce(new Response('nope', { status: 503 }))
    const report = await runChecks()
    const health = byName(report, 'instance.health')
    expect(health.status).toBe('fail')
    expect(health.detail).toMatchObject({ httpStatus: 503 })
  })

  it('a valid SSO cache passes and exposes the email plus a MASKED token', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const jwt = makeJwt('RS256', { email: 'me@l.com', exp })
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ access_token: jwt }))
    const report = await runChecks()
    const sso = byName(report, 'sso.cache')
    expect(sso.status).toBe('pass')
    expect(sso.detail).toMatchObject({ email: 'me@l.com' })
    expect(sso.detail?.token).not.toBe(jwt)
    expect(String(sso.detail?.token)).toContain('…')
    expect(JSON.stringify(report)).not.toContain(jwt)
  })

  it('a missing SSO cache warns rather than fails — SSO is optional', async () => {
    const report = await runChecks()
    const sso = byName(report, 'sso.cache')
    expect(sso.status).toBe('warn')
    expect(sso.hint).toBe('a2wave login')
  })

  it('an expired SSO cache token warns with an expired message', async () => {
    const exp = Math.floor(Date.now() / 1000) - 60
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ access_token: makeJwt('RS256', { exp }) }))
    const report = await runChecks()
    const sso = byName(report, 'sso.cache')
    expect(sso.status).toBe('warn')
    expect(sso.message).toContain('expired')
  })

  it('an unparseable SSO cache file warns and says so', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not-json{')
    const report = await runChecks()
    expect(byName(report, 'sso.cache').message).toContain('cannot be parsed')
  })

  it('an HS256 credential is labelled a self-signed token', async () => {
    const jwt = makeJwt('HS256', { exp: Math.floor(Date.now() / 1000) + 3600 })
    mockLoadConfig.mockReturnValue({ url: 'http://api.test', token: jwt })
    mockFetch
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'usr_1', username: 't', role: 'user' } }))
    const report = await runChecks()
    const cred = byName(report, 'credentials.token')
    expect(cred.status).toBe('pass')
    expect(cred.detail).toMatchObject({ kind: 'a2wave', alg: 'HS256' })
    expect(JSON.stringify(report)).not.toContain(jwt)
  })

  it('an RS256 credential is labelled SSO and names the algorithm', async () => {
    const jwt = makeJwt('RS256', { exp: Math.floor(Date.now() / 1000) + 3600 })
    mockLoadConfig.mockReturnValue({ url: 'http://api.test', token: jwt })
    mockFetch
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ data: { token: 'a2w_x' } }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { id: 'usr_1', username: 'tate', role: 'admin' } }),
      )
    const report = await runChecks()
    expect(byName(report, 'credentials.token').detail).toMatchObject({
      kind: 'sso',
      alg: 'RS256',
    })
  })

  it('an expired credential fails — the CLI cannot call anything with it', async () => {
    const jwt = makeJwt('HS256', { exp: Math.floor(Date.now() / 1000) - 60 })
    mockLoadConfig.mockReturnValue({ url: 'http://api.test', token: jwt })
    mockFetch
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    const report = await runChecks()
    const cred = byName(report, 'credentials.token')
    expect(cred.status).toBe('fail')
    expect(cred.hint).toBe('a2wave login')
    expect(report.ok).toBe(false)
  })

  it('a successful identity probe reports role and id', async () => {
    const jwt = makeJwt('HS256', { exp: Math.floor(Date.now() / 1000) + 3600 })
    mockLoadConfig.mockReturnValue({ url: 'http://api.test', token: jwt })
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 })).mockResolvedValueOnce(
      jsonResponse({
        data: { id: 'usr_1', username: 'tate', displayName: 'Tate', role: 'admin' },
      }),
    )
    const report = await runChecks()
    const user = byName(report, 'user.identity')
    expect(user.status).toBe('pass')
    expect(user.detail).toMatchObject({ id: 'usr_1', username: 'tate', role: 'admin' })
    expect(report.ok).toBe(true)
  })

  it('a 401 from /auth/me is a fail with the reason in the message', async () => {
    const jwt = makeJwt('HS256', { exp: Math.floor(Date.now() / 1000) + 3600 })
    mockLoadConfig.mockReturnValue({ url: 'http://api.test', token: jwt })
    mockFetch
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    const report = await runChecks()
    const user = byName(report, 'user.identity')
    expect(user.status).toBe('fail')
    expect(user.message).toContain('/auth/me HTTP 401')
    expect(user.hint).toBe('a2wave login')
  })

  it('the identity probe never runs when the instance is unreachable', async () => {
    const jwt = makeJwt('HS256', { exp: Math.floor(Date.now() / 1000) + 3600 })
    mockLoadConfig.mockReturnValue({ url: 'http://api.test', token: jwt })
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const report = await runChecks()
    expect(byName(report, 'user.identity').status).toBe('warn')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('every non-pass check carries a runnable hint, and no check carries ANSI', async () => {
    const report = await runChecks()
    for (const check of report.checks) {
      if (check.status !== 'pass') {
        expect(check.hint, `${check.name} needs a hint`).toBeTruthy()
        // A hint is a RUNNABLE next step, not prose. Every remediation this CLI
        // offers is one of its own commands or an env-var export.
        expect(check.hint).toMatch(/^(a2wave |export )/)
      }
    }
    // Colour belongs to the renderer: an ANSI escape inside a machine payload is
    // garbage to every consumer that is not a terminal.
    expect(JSON.stringify(report)).not.toContain(String.fromCharCode(27))
  })
})
