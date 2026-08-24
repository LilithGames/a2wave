import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

const mockVerifyToken = vi.fn()
const mockDbUser = vi.fn()

vi.mock('../../env.js', () => ({
  env: {
    NODE_ENV: 'production',
    E2E_STRICT_AUTH: true,
    AUTH_SECRET: 'test-secret-that-is-long-enough-for-prod',
  },
}))

const mockSignToken = vi.fn(async (_user?: unknown, _remember?: unknown) => 'renewed-token')

vi.mock('../../lib/auth.js', () => ({
  AUTH_COOKIE_NAME: '__Host-a2wave_session',
  LEGACY_AUTH_COOKIE_NAME: 'a2wave_session',
  verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
  signToken: (user: unknown, remember?: unknown) => mockSignToken(user, remember),
}))

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'id',
    role: 'role',
    tokenVersion: 'token_version',
    isActive: 'is_active',
  },
}))

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          asyncQuery({
            get: () => mockDbUser(),
          }),
      }),
    }),
  },
}))

const mockValidateAgentToken = vi.fn()

vi.mock('../../lib/agent-memory-token.js', () => ({
  validateAgentToken: (...args: unknown[]) => mockValidateAgentToken(...args),
}))

const mockSetAuthCookie = vi.fn()

vi.mock('../../lib/auth-cookie.js', () => ({
  isCookieSecure: () => true,
  setAuthCookie: (...args: unknown[]) => mockSetAuthCookie(...args),
}))

const { authMiddleware, memoryAuthMiddleware } = await import('../auth-middleware.js')

describe('memoryAuthMiddleware', () => {
  function makeLocalhostEnv(remoteAddress: string) {
    return { incoming: { socket: { remoteAddress } } }
  }

  function createMemoryApp(nodeEnv?: unknown) {
    const app = new Hono()
    app.use('*', async (c, next) => {
      if (nodeEnv !== undefined) {
        ;(c as unknown as { env: unknown }).env = nodeEnv
      }
      await next()
    })
    app.use('*', memoryAuthMiddleware)
    app.get('/test', (c) =>
      c.json({
        agentTokenId: c.get('agentTokenId' as never) ?? null,
        userId: c.get('userId' as never) ?? null,
      }),
    )
    return app
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyToken.mockResolvedValue({ sub: 'usr_1', tv: 0 })
    mockDbUser.mockReturnValue({ id: 'usr_1', role: 'user', tokenVersion: 0, isActive: true })
  })

  it('localhost + valid Bearer token → sets agentTokenId, skips cookie auth', async () => {
    mockValidateAgentToken.mockReturnValue('agt_test')
    const app = createMemoryApp(makeLocalhostEnv('127.0.0.1'))
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { agentTokenId: string | null }
    expect(body.agentTokenId).toBe('agt_test')
    expect(mockVerifyToken).not.toHaveBeenCalled()
  })

  it('localhost + Bearer that is not an agent token → falls back to JWT auth (CLI session token)', async () => {
    // The CLI always forwards the user's session JWT as a Bearer, even against a
    // localhost / same-host API. That is not an agent token, so it must fall through
    // to JWT verification instead of hard-401'ing.
    mockValidateAgentToken.mockReturnValue(null)
    const app = createMemoryApp(makeLocalhostEnv('127.0.0.1'))
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer user-session-jwt' },
    })
    expect(res.status).toBe(200)
    expect(mockVerifyToken).toHaveBeenCalledWith('user-session-jwt')
    const body = (await res.json()) as { userId: string | null; agentTokenId: string | null }
    expect(body.userId).toBe('usr_1')
    expect(body.agentTokenId).toBeNull()
  })

  it('localhost + Bearer that fails both agent-token and JWT checks → 401', async () => {
    mockValidateAgentToken.mockReturnValue(null)
    mockVerifyToken.mockRejectedValue(new Error('bad jwt'))
    const app = createMemoryApp(makeLocalhostEnv('127.0.0.1'))
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer garbage' },
    })
    expect(res.status).toBe(401)
  })

  it('localhost + no Bearer token → falls through to cookie auth', async () => {
    const app = createMemoryApp(makeLocalhostEnv('127.0.0.1'))
    const res = await app.request('/test', {
      headers: { Cookie: '__Host-a2wave_session=browser-token' },
    })
    expect(res.status).toBe(200)
    expect(mockVerifyToken).toHaveBeenCalledWith('browser-token')
    expect(mockValidateAgentToken).not.toHaveBeenCalled()
  })

  it('non-localhost + valid JWT cookie → falls through to cookie auth', async () => {
    const app = createMemoryApp(makeLocalhostEnv('203.0.113.5'))
    const res = await app.request('/test', {
      headers: { Cookie: '__Host-a2wave_session=browser-token' },
    })
    expect(res.status).toBe(200)
    expect(mockVerifyToken).toHaveBeenCalledWith('browser-token')
    expect(mockValidateAgentToken).not.toHaveBeenCalled()
  })

  it('non-localhost + no token → 401', async () => {
    const app = createMemoryApp(makeLocalhostEnv('203.0.113.5'))
    const res = await app.request('/test')
    expect(res.status).toBe(401)
  })
})

describe('authMiddleware cookie selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyToken.mockResolvedValue({ sub: 'usr_1', tv: 0 })
    mockDbUser.mockReturnValue({ id: 'usr_1', role: 'user', tokenVersion: 0, isActive: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function createApp() {
    const app = new Hono()
    app.use('*', authMiddleware)
    app.get('/protected', (c) => c.json({ userId: c.get('userId' as never) }))
    return app
  }

  it('does not accept the legacy cookie name in production', async () => {
    const res = await createApp().request('/protected', {
      headers: { Cookie: 'a2wave_session=legacy-token' },
    })

    expect(res.status).toBe(401)
    expect(mockVerifyToken).not.toHaveBeenCalled()
  })

  it('accepts the __Host cookie name in production', async () => {
    const res = await createApp().request('/protected', {
      headers: { Cookie: '__Host-a2wave_session=host-token' },
    })

    expect(res.status).toBe(200)
    expect(mockVerifyToken).toHaveBeenCalledWith('host-token')
  })
})

/**
 * Sliding expiry (part B): an actively used session is silently reissued once it
 * passes its half-life, so it never expires under a user who is still working.
 */
describe('authMiddleware sliding renewal', () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000)

  beforeEach(() => {
    vi.clearAllMocks()
    mockDbUser.mockReturnValue({ id: 'usr_1', role: 'user', tokenVersion: 0, isActive: true })
    mockSignToken.mockResolvedValue('renewed-token')
  })

  function createApp() {
    const app = new Hono()
    app.use('*', authMiddleware)
    app.get('/protected', (c) => c.json({ userId: c.get('userId' as never) }))
    return app
  }

  function requestWithCookie() {
    return createApp().request('/protected', {
      headers: { Cookie: '__Host-a2wave_session=browser-token' },
    })
  }

  it('reissues the cookie when the token is past its half-life', async () => {
    const now = nowSeconds()
    mockVerifyToken.mockResolvedValue({
      sub: 'usr_1',
      tv: 0,
      rm: true,
      iat: now - 5 * 24 * 60 * 60,
      exp: now + 2 * 24 * 60 * 60,
    })

    const res = await requestWithCookie()

    expect(res.status).toBe(200)
    expect(mockSignToken).toHaveBeenCalledTimes(1)
    expect(mockSetAuthCookie).toHaveBeenCalledTimes(1)
    expect(mockSetAuthCookie.mock.calls[0][1]).toBe('renewed-token')
  })

  it('does not reissue a freshly issued token', async () => {
    const now = nowSeconds()
    mockVerifyToken.mockResolvedValue({
      sub: 'usr_1',
      tv: 0,
      rm: true,
      iat: now - 60,
      exp: now + 7 * 24 * 60 * 60,
    })

    const res = await requestWithCookie()

    expect(res.status).toBe(200)
    expect(mockSignToken).not.toHaveBeenCalled()
    expect(mockSetAuthCookie).not.toHaveBeenCalled()
  })

  it('preserves remember=false on renewal instead of upgrading the session', async () => {
    const now = nowSeconds()
    mockVerifyToken.mockResolvedValue({
      sub: 'usr_1',
      tv: 0,
      rm: false,
      iat: now - 11 * 60 * 60,
      exp: now + 1 * 60 * 60,
    })

    await requestWithCookie()

    // The whole point: a renewed short session must stay short, and its cookie
    // must stay a session cookie. Otherwise sliding expiry quietly promotes
    // every shared-computer login into a persistent one.
    expect(mockSignToken.mock.calls[0][1]).toBe(false)
    expect(mockSetAuthCookie.mock.calls[0][2]).toBe(false)
  })

  it('treats a token with no rm claim as remembered (pre-existing sessions)', async () => {
    const now = nowSeconds()
    mockVerifyToken.mockResolvedValue({
      sub: 'usr_1',
      tv: 0,
      iat: now - 5 * 24 * 60 * 60,
      exp: now + 2 * 24 * 60 * 60,
    })

    await requestWithCookie()

    expect(mockSignToken.mock.calls[0][1]).toBe(true)
    expect(mockSetAuthCookie.mock.calls[0][2]).toBe(true)
  })

  it('never renews a Bearer-presented token (CLI owns its own lifetime)', async () => {
    const now = nowSeconds()
    mockVerifyToken.mockResolvedValue({
      sub: 'usr_1',
      tv: 0,
      rm: true,
      iat: now - 6 * 24 * 60 * 60,
      exp: now + 1 * 24 * 60 * 60,
    })

    const res = await createApp().request('/protected', {
      headers: { Authorization: 'Bearer stale-but-valid' },
    })

    // A Bearer caller has nowhere to receive a rotated cookie, and silently
    // extending a CLI credential's life server-side would be invisible.
    expect(res.status).toBe(200)
    expect(mockSignToken).not.toHaveBeenCalled()
    expect(mockSetAuthCookie).not.toHaveBeenCalled()
  })

  it('still serves the request when reissuing fails', async () => {
    const now = nowSeconds()
    mockVerifyToken.mockResolvedValue({
      sub: 'usr_1',
      tv: 0,
      rm: true,
      iat: now - 5 * 24 * 60 * 60,
      exp: now + 2 * 24 * 60 * 60,
    })
    mockSignToken.mockRejectedValue(new Error('signing key unavailable'))

    // Renewal is best-effort: the presented token is still valid, so a failure
    // to mint its replacement must not 500 an otherwise fine request.
    const res = await requestWithCookie()
    expect(res.status).toBe(200)
  })
})
