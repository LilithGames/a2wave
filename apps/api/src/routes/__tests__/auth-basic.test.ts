/**
 * Covers the basic /auth/* endpoints (status / setup / login / me / locale)
 * that the existing auth-change-password.test.ts and auth-oauth.test.ts files
 * don't reach.
 */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
const dbInsert = vi.fn()
const dbUpdate = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    insert: (...a: unknown[]) => dbInsert(...a),
    update: (...a: unknown[]) => dbUpdate(...a),
  },
}))

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'users.id',
    username: 'users.username',
    passwordHash: 'users.passwordHash',
    idaasSub: 'users.idaasSub',
    tokenVersion: 'users.tokenVersion',
  },
}))

const logAuditMock = vi.fn()
vi.mock('../../lib/audit.js', () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}))

vi.mock('../../lib/audit-actions.js', () => ({
  AUDIT_ACTIONS: {
    AUTH_LOGIN: 'auth.login',
    AUTH_OAUTH_LOGIN: 'auth.oauth.login',
    AUTH_OAUTH_USER_PROVISIONED: 'auth.oauth.provisioned',
    AUTH_OAUTH_EXCHANGE_FAILED: 'auth.oauth.exchange.failed',
    AUTH_PASSWORD_LOGIN_DISABLED_ATTEMPT: 'auth.login.password-disabled-attempt',
    AUTH_SETUP_COMPLETED: 'auth.setup.completed',
  },
}))

const setAuthCookieMock = vi.fn()
const clearAuthCookieMock = vi.fn()
vi.mock('../../lib/auth-cookie.js', () => ({
  setAuthCookie: (...a: unknown[]) => setAuthCookieMock(...a),
  clearAuthCookie: (...a: unknown[]) => clearAuthCookieMock(...a),
}))

const loadAuthSettingsMock = vi.fn()
vi.mock('../../lib/auth-settings.js', () => ({
  loadAuthSettings: () => loadAuthSettingsMock(),
  isEmailDomainAllowed: vi.fn(() => true),
}))

const hashPasswordMock = vi.fn(async (_p?: unknown) => 'hashed')
const signTokenMock = vi.fn(async (_u?: unknown, _r?: unknown) => 'TOKEN')
const validatePasswordMock = vi.fn()
const verifyPasswordMock = vi.fn()
vi.mock('../../lib/auth.js', () => ({
  hashPassword: (p: string) => hashPasswordMock(p),
  signToken: (u: unknown, r?: unknown) => signTokenMock(u, r),
  validatePassword: (p: string) => validatePasswordMock(p),
  verifyPassword: (h: string, p: string) => verifyPasswordMock(h, p),
}))

vi.mock('../../lib/id.js', () => ({
  createId: (p?: string) => `${p}_test_${Math.random().toString(36).slice(2, 6)}`,
}))

vi.mock('../../lib/oauth-config.js', () => ({
  getIdaasJwtStrategy: () => null,
}))

const isSetupRequiredMock = vi.fn()
vi.mock('../../lib/setup.js', () => ({
  isSetupRequired: () => isSetupRequiredMock(),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../env.js', () => ({
  env: { CORS_ORIGIN: 'http://localhost:3501' },
}))

import authRoutes from '../auth.js'

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn<(...a: unknown[]) => unknown>>> = {}
  // `limit` and `orderBy` are part of the chain now: production code spells a
  // single-row lookup `.limit(1)` and awaits it, rather than calling `.get()`.
  for (const k of ['from', 'where', 'set', 'values', 'returning', 'limit', 'orderBy']) {
    c[k] = vi.fn((): unknown => chain)
  }
  c.get = vi.fn<(...a: unknown[]) => unknown>()
  c.run = vi.fn<(...a: unknown[]) => unknown>()
  // Awaiting the chain resolves to the row list `.get()`/`.run()` would produce,
  // so `const [row] = await db.select()...limit(1)` sees the configured row.
  // For a write, production counts `.returning()` rows instead of reading a
  // driver row count, so surface one placeholder row per mocked `changes`.
  const chain = Object.assign(
    Promise.resolve().then(() => {
      const row = c.get()
      if (row !== undefined) return row === null ? [] : [row]
      const res = c.run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 0
      return Array.from({ length: changes }, () => ({}))
    }),
    c,
  )
  return chain as unknown as typeof c
}

function queueSelects(...returns: Array<{ get?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => {
    const cfg = returns[i++] ?? {}
    const c = makeChain()
    if ('get' in cfg) c.get.mockReturnValue(cfg.get)
    return c
  })
}

beforeEach(() => {
  dbSelect.mockReset()
  dbInsert.mockReset().mockImplementation(() => makeChain())
  dbUpdate.mockReset().mockImplementation(() => {
    const chain = makeChain()
    chain.run.mockReturnValue({ changes: 1 })
    return chain
  })
  logAuditMock.mockReset()
  setAuthCookieMock.mockReset()
  clearAuthCookieMock.mockReset()
  loadAuthSettingsMock.mockReset()
  hashPasswordMock.mockReset().mockImplementation(async () => 'hashed')
  signTokenMock.mockReset().mockImplementation(async () => 'TOKEN')
  validatePasswordMock.mockReset()
  verifyPasswordMock.mockReset()
  isSetupRequiredMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp(opts: { userId?: string } = {}) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (opts.userId) c.set('userId' as never, opts.userId as never)
    await next()
  })
  app.route('/auth', authRoutes)
  return app
}

describe('GET /auth/status', () => {
  it('returns needSetup=true when admin has no password', async () => {
    isSetupRequiredMock.mockReturnValue(true)
    const res = await buildApp().request('/auth/status', undefined, {
      incoming: { socket: { remoteAddress: '203.0.113.5' } },
    } as never)
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({ data: { needSetup: true } })
  })

  it('returns needSetup=false after initialization', async () => {
    isSetupRequiredMock.mockReturnValue(false)
    const res = await buildApp().request('/auth/status', undefined, {
      incoming: { socket: { remoteAddress: '203.0.113.5' } },
    } as never)
    expect(((await res.json()) as any).data).toEqual({ needSetup: false })
  })
})

describe('POST /auth/setup', () => {
  function post(body: unknown, remoteAddress = '127.0.0.1', headers: Record<string, string> = {}) {
    return buildApp().request(
      '/auth/setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress } } } as never,
    )
  }

  // The endpoint is unauthenticated during the first-boot window, so "closed for
  // good once a password exists" is the ONLY thing standing between a live
  // deployment and an admin takeover. Three separate assertions, because a
  // status code alone would still pass if the write leaked through.
  it('refuses when setup is already done', async () => {
    isSetupRequiredMock.mockReturnValue(false)
    const res = await post({ password: 'Aa1aaaaa', confirmPassword: 'Aa1aaaaa' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('SETUP_ALREADY_COMPLETED')
  })

  it('touches nothing at all once a password exists', async () => {
    isSetupRequiredMock.mockReturnValue(false)
    validatePasswordMock.mockReturnValue({ valid: true })

    await post({ password: 'Attacker1', confirmPassword: 'Attacker1' })

    // No hash computed, no row written, no session minted, no cookie set: the
    // request must not have reached any of it.
    expect(hashPasswordMock).not.toHaveBeenCalled()
    expect(dbUpdate).not.toHaveBeenCalled()
    expect(signTokenMock).not.toHaveBeenCalled()
    expect(setAuthCookieMock).not.toHaveBeenCalled()
  })

  it('re-reads the live state on every call rather than caching it', async () => {
    // isSetupRequired() must be consulted per request. Were it hoisted to a
    // module-level or boot-time value, an instance that booted uninitialized
    // would keep accepting setup forever after the password was set.
    isSetupRequiredMock.mockReturnValue(false)

    await post({ password: 'Aa1aaaaa', confirmPassword: 'Aa1aaaaa' })
    await post({ password: 'Aa1aaaaa', confirmPassword: 'Aa1aaaaa' })

    expect(isSetupRequiredMock).toHaveBeenCalledTimes(2)
  })

  it('refuses malformed body', async () => {
    isSetupRequiredMock.mockReturnValue(true)
    const res = await post({ password: 'Aa1aaaaa' })
    expect(res.status).toBe(400)
  })

  it('rejects a text/plain loopback setup body before hashing the password', async () => {
    isSetupRequiredMock.mockReturnValue(true)

    const res = await post({ password: 'Aa1aaaaa', confirmPassword: 'Aa1aaaaa' }, '127.0.0.1', {
      'content-type': 'text/plain',
    })

    expect(res.status).toBe(415)
    expect(hashPasswordMock).not.toHaveBeenCalled()
  })

  it('refuses when password and confirmation differ', async () => {
    isSetupRequiredMock.mockReturnValue(true)
    const res = await post({ password: 'Aa1aaaaa', confirmPassword: 'Bb1bbbbb' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('PASSWORD_MISMATCH')
  })

  it('refuses when password fails the policy', async () => {
    isSetupRequiredMock.mockReturnValue(true)
    validatePasswordMock.mockReturnValue({ valid: false, message: 'PASSWORD_TOO_SHORT' })
    const res = await post({ password: 'short', confirmPassword: 'short' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('PASSWORD_TOO_SHORT')
  })

  it('returns 500 if the admin row is missing (race)', async () => {
    isSetupRequiredMock.mockReturnValue(true)
    validatePasswordMock.mockReturnValue({ valid: true })
    queueSelects({ get: undefined })
    const res = await post({ password: 'Aa1aaaaa', confirmPassword: 'Aa1aaaaa' })
    expect(res.status).toBe(500)
    expect(((await res.json()) as any).error).toBe('ADMIN_NOT_FOUND')
  })

  it('hashes the password, signs a token, sets cookie, and returns the user', async () => {
    isSetupRequiredMock.mockReturnValue(true)
    validatePasswordMock.mockReturnValue({ valid: true })
    queueSelects(
      { get: { id: 'usr_admin', username: 'admin', displayName: 'A', role: 'admin' } },
      { get: { id: 'usr_admin', role: 'admin', tokenVersion: 0 } },
    )
    const res = await post({ password: 'Aa1aaaaa', confirmPassword: 'Aa1aaaaa' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.token).toBe('TOKEN')
    expect(body.data.user).toMatchObject({ id: 'usr_admin', username: 'admin', role: 'admin' })
    expect(setAuthCookieMock).toHaveBeenCalled()
    expect(hashPasswordMock).toHaveBeenCalledWith('Aa1aaaaa')
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.setup.completed', resourceId: 'usr_admin' }),
    )
  })

  it('accepts a remote setup request with no bootstrap credential', async () => {
    // The deliberate trade: first-time setup is unauthenticated, so a Docker
    // install never has to stop and read the container logs. Whoever reaches an
    // uninitialized instance first claims admin.
    isSetupRequiredMock.mockReturnValue(true)
    validatePasswordMock.mockReturnValue({ valid: true })
    queueSelects(
      { get: { id: 'usr_admin', username: 'admin', displayName: 'A', role: 'admin' } },
      { get: { id: 'usr_admin', role: 'admin', tokenVersion: 0 } },
    )

    const res = await post({ password: 'Aa1aaaaa', confirmPassword: 'Aa1aaaaa' }, '203.0.113.5')

    expect(res.status).toBe(200)
    expect(hashPasswordMock).toHaveBeenCalledWith('Aa1aaaaa')
  })

  it('uses a conditional update so only one concurrent setup request can win', async () => {
    isSetupRequiredMock.mockReturnValue(true)
    validatePasswordMock.mockReturnValue({ valid: true })
    queueSelects({
      get: { id: 'usr_admin', username: 'admin', displayName: 'A', role: 'admin' },
    })
    dbUpdate.mockImplementationOnce(() => {
      const chain = makeChain()
      chain.run.mockReturnValue({ changes: 0 })
      return chain
    })

    const res = await post({ password: 'Aa1aaaaa', confirmPassword: 'Aa1aaaaa' })

    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toBe('SETUP_ALREADY_COMPLETED')
    expect(signTokenMock).not.toHaveBeenCalled()
    expect(setAuthCookieMock).not.toHaveBeenCalled()
  })

  it('guards the write with passwordHash IS NULL, not just the pre-flight read', async () => {
    // The pre-flight isSetupRequired() is a TOCTOU check: two concurrent
    // requests can both pass it. The conditional UPDATE is what makes only one
    // win, so the isNull() term must be part of the statement itself.
    isSetupRequiredMock.mockReturnValue(true)
    validatePasswordMock.mockReturnValue({ valid: true })
    queueSelects(
      { get: { id: 'usr_admin', username: 'admin', displayName: 'A', role: 'admin' } },
      { get: { id: 'usr_admin', role: 'admin', tokenVersion: 0 } },
    )

    await post({ password: 'Aa1aaaaa', confirmPassword: 'Aa1aaaaa' })

    // drizzle-orm is real here, so inspect the compiled SQL the UPDATE carried.
    const updateChain = dbUpdate.mock.results[0]?.value as {
      set: { mock: { results: { value: { where: { mock: { calls: unknown[][] } } } }[] } }
    }
    const whereArg = updateChain.set.mock.results[0].value.where.mock.calls[0][0]
    expect(JSON.stringify(whereArg)).toMatch(/passwordHash/)
    expect(JSON.stringify(whereArg)).toMatch(/is null/i)
  })
})

describe('POST /auth/login', () => {
  function post(body: unknown) {
    return buildApp().request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('refuses when body is malformed', async () => {
    loadAuthSettingsMock.mockReturnValue({ passwordLoginEnabled: true })
    const res = await post({ username: 'a' })
    expect(res.status).toBe(400)
  })

  it('returns 403 when password login is disabled by policy', async () => {
    loadAuthSettingsMock.mockReturnValue({ passwordLoginEnabled: false })
    const res = await post({ username: 'a', password: 'p' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error).toBe('PASSWORD_LOGIN_DISABLED')
    expect(logAuditMock).toHaveBeenCalled()
  })

  it('returns 401 when user does not exist or has no password', async () => {
    loadAuthSettingsMock.mockReturnValue({ passwordLoginEnabled: true })
    queueSelects({ get: undefined })
    const res = await post({ username: 'ghost', password: 'p' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error).toBe('INVALID_CREDENTIALS')
  })

  it('returns 403 when account is disabled', async () => {
    loadAuthSettingsMock.mockReturnValue({ passwordLoginEnabled: true })
    queueSelects({
      get: {
        id: 'usr_1',
        username: 'bob',
        passwordHash: 'h',
        isActive: false,
        role: 'user',
        tokenVersion: 0,
      },
    })
    const res = await post({ username: 'bob', password: 'p' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error).toBe('ACCOUNT_DISABLED')
  })

  it('returns 401 when password mismatch', async () => {
    loadAuthSettingsMock.mockReturnValue({ passwordLoginEnabled: true })
    queueSelects({
      get: {
        id: 'usr_1',
        username: 'bob',
        passwordHash: 'h',
        isActive: true,
        role: 'user',
        tokenVersion: 0,
      },
    })
    verifyPasswordMock.mockResolvedValue(false)
    const res = await post({ username: 'bob', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error).toBe('INVALID_CREDENTIALS')
  })

  function activeUser() {
    return {
      id: 'usr_1',
      username: 'bob',
      passwordHash: 'h',
      isActive: true,
      role: 'user',
      tokenVersion: 1,
      displayName: 'Bob',
      email: 'bob@example.com',
      idaasSub: null,
      onboarding: {},
    }
  }

  it('passes remember=true through to signToken and setAuthCookie', async () => {
    loadAuthSettingsMock.mockReturnValue({ passwordLoginEnabled: true })
    queueSelects({ get: activeUser() })
    verifyPasswordMock.mockResolvedValue(true)

    const res = await post({ username: 'bob', password: 'p', remember: true })

    expect(res.status).toBe(200)
    expect(signTokenMock.mock.calls[0][1]).toBe(true)
    expect(setAuthCookieMock.mock.calls[0][2]).toBe(true)
  })

  it('passes remember=false through to signToken and setAuthCookie', async () => {
    loadAuthSettingsMock.mockReturnValue({ passwordLoginEnabled: true })
    queueSelects({ get: activeUser() })
    verifyPasswordMock.mockResolvedValue(true)

    const res = await post({ username: 'bob', password: 'p', remember: false })

    expect(res.status).toBe(200)
    expect(signTokenMock.mock.calls[0][1]).toBe(false)
    expect(setAuthCookieMock.mock.calls[0][2]).toBe(false)
  })

  it('defaults remember to false when the field is absent (safe default)', async () => {
    loadAuthSettingsMock.mockReturnValue({ passwordLoginEnabled: true })
    queueSelects({ get: activeUser() })
    verifyPasswordMock.mockResolvedValue(true)

    const res = await post({ username: 'bob', password: 'p' })

    // Omitting the field must not silently grant the long session — an older
    // client that never learned about the checkbox gets the safer lifetime.
    expect(res.status).toBe(200)
    expect(signTokenMock.mock.calls[0][1]).toBe(false)
    expect(setAuthCookieMock.mock.calls[0][2]).toBe(false)
  })

  it('rejects a non-boolean remember instead of coercing it', async () => {
    loadAuthSettingsMock.mockReturnValue({ passwordLoginEnabled: true })
    const res = await post({ username: 'bob', password: 'p', remember: 'yes' })
    expect(res.status).toBe(400)
  })

  it('returns user data + token on success', async () => {
    loadAuthSettingsMock.mockReturnValue({ passwordLoginEnabled: true })
    queueSelects({
      get: {
        id: 'usr_1',
        username: 'bob',
        passwordHash: 'h',
        isActive: true,
        role: 'user',
        tokenVersion: 1,
        displayName: 'Bob',
        email: 'bob@example.com',
        idaasSub: 'sub_bob',
      },
    })
    verifyPasswordMock.mockResolvedValue(true)
    const res = await post({ username: 'bob', password: 'right' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.token).toBe('TOKEN')
    // idaasBound must be present so the web can seed its me-cache without a refetch flash.
    expect(body.data.user).toMatchObject({
      id: 'usr_1',
      username: 'bob',
      role: 'user',
      email: 'bob@example.com',
      idaasBound: true,
    })
    expect(setAuthCookieMock).toHaveBeenCalled()
    expect(logAuditMock).toHaveBeenCalled()
  })
})

describe('GET /auth/me', () => {
  it('returns 404 when current user not found', async () => {
    queueSelects({ get: undefined })
    const res = await buildApp({ userId: 'usr_missing' }).request('/auth/me')
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error).toBe('USER_NOT_FOUND')
  })

  it('returns user information (incl. email/idaasBound) without sensitive fields', async () => {
    queueSelects({
      get: {
        id: 'usr_1',
        username: 'bob',
        displayName: 'Bob',
        role: 'user',
        locale: 'en',
        isActive: true,
        createdAt: '2025',
        email: 'bob@example.com',
        idaasSub: 'sub_bob',
        passwordHash: 'h',
      },
    })
    const res = await buildApp({ userId: 'usr_1' }).request('/auth/me')
    const body = (await res.json()) as any
    expect(body.data).toEqual({
      id: 'usr_1',
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      locale: 'en',
      onboarding: {},
      isActive: true,
      createdAt: '2025',
      email: 'bob@example.com',
      idaasBound: true,
    })
    // idaasSub itself is not leaked; only the boolean idaasBound is exposed.
    expect(body.data.idaasSub).toBeUndefined()
    expect(body.data.passwordHash).toBeUndefined()
  })
})

describe('PATCH /auth/locale', () => {
  function patch(body: unknown) {
    return buildApp({ userId: 'usr_1' }).request('/auth/locale', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('refuses invalid locale', async () => {
    const res = await patch({ locale: 'fr' })
    expect(res.status).toBe(400)
  })

  it('updates and returns the new locale', async () => {
    const res = await patch({ locale: 'en' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data).toEqual({ locale: 'en' })
  })
})

describe('PATCH /auth/onboarding', () => {
  function patch(body: unknown) {
    return buildApp({ userId: 'usr_1' }).request('/auth/onboarding', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('refuses invalid status', async () => {
    const res = await patch({ guide: 'newbie', status: 'nope' })
    expect(res.status).toBe(400)
  })

  it('merges the new guide status into existing onboarding map', async () => {
    queueSelects({ get: { id: 'usr_1', onboarding: { other: 'completed' } } })
    const res = await patch({ guide: 'newbie', status: 'completed' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data.onboarding).toEqual({
      other: 'completed',
      newbie: 'completed',
    })
  })
})
