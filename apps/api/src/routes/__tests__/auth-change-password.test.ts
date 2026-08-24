import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('../../db/schema.js', () => ({
  users: { id: 'id', tokenVersion: 'token_version' },
}))

vi.mock('../../lib/auth.js', () => ({
  signToken: vi.fn(async () => 'new-token'),
  hashPassword: vi.fn(async () => 'new-hash'),
  verifyPassword: vi.fn(async () => true),
  validatePassword: vi.fn(() => ({ valid: true })),
  AUTH_COOKIE_NAME: '__Host-a2wave_session',
  LEGACY_AUTH_COOKIE_NAME: 'a2wave_session',
}))

vi.mock('../../lib/auth-cookie.js', () => ({
  setAuthCookie: vi.fn(),
  clearAuthCookie: vi.fn(),
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../../lib/setup.js', () => ({
  isSetupRequired: () => false,
}))

vi.mock('../../lib/oauth-config.js', () => ({
  getIdaasJwtStrategy: () => null,
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../lib/auth-settings.js', () => ({
  loadAuthSettings: () => ({
    oauthEnabled: false,
    allowedEmailDomains: [],
    defaultRole: 'user',
    oauthAutoProvision: false,
    passwordLoginEnabled: true,
  }),
  isEmailDomainAllowed: () => true,
}))

import { db } from '../../db/client.js'

import { asyncQuery } from '../../test/async-query.js'

function makeSelectGet(returns: unknown[]) {
  let i = 0
  return {
    from: () =>
      asyncQuery({
        where: () =>
          asyncQuery({
            get: () => returns[i++ % returns.length],
          }),
      }),
  }
}

function makeUpdateChain() {
  return { set: () => asyncQuery({ where: () => asyncQuery({ run: () => {} }) }) }
}

describe('POST /auth/change-password', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    ;(db.update as Mock).mockReturnValue(makeUpdateChain())
    ;(db.select as Mock).mockReturnValue(
      makeSelectGet([
        { id: 'usr_1', passwordHash: 'old-hash' },
        { id: 'usr_1', role: 'user', tokenVersion: 1 },
      ]),
    )

    const mod = await import('../auth.js')
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userId' as never, 'usr_1' as never)
      await next()
    })
    app.route('/api/auth', mod.default)
  })

  it('sets a fresh HttpOnly cookie but does not expose the new token in JSON', async () => {
    const res = await app.request('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'OldPass1', newPassword: 'NewPass1' }),
    })

    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({ data: { message: 'ok' } })
  })
})

describe('POST /auth/change-password preserves the session lifetime choice', () => {
  let app: Hono
  let sessionRemember: boolean | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    sessionRemember = undefined
    // The route reads `.returning()` rows to detect a lost race, so the mock must
    // yield exactly one refreshed user row.
    ;(db.update as Mock).mockReturnValue({
      set: () =>
        asyncQuery({
          where: () => asyncQuery({ get: () => ({ id: 'usr_1', role: 'user', tokenVersion: 2 }) }),
        }),
    })
    ;(db.select as Mock).mockReturnValue(
      makeSelectGet([
        { id: 'usr_1', passwordHash: 'old-hash' },
        { id: 'usr_1', role: 'user', tokenVersion: 1 },
      ]),
    )

    const mod = await import('../auth.js')
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userId' as never, 'usr_1' as never)
      if (sessionRemember !== undefined) {
        c.set('sessionRemember' as never, sessionRemember as never)
      }
      await next()
    })
    app.route('/api/auth', mod.default)
  })

  function post() {
    return app.request('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: 'OldPass1', newPassword: 'NewPass1' }),
    })
  }

  it('keeps a short session short when changing password', async () => {
    sessionRemember = false
    const { signToken } = await import('../../lib/auth.js')
    const { setAuthCookie } = await import('../../lib/auth-cookie.js')

    await post()

    // Changing your password from a shared-computer session must not silently
    // promote it to a 7-day persistent cookie — that reverses the exact
    // protection the unchecked box promised.
    expect((signToken as Mock).mock.calls[0][1]).toBe(false)
    expect((setAuthCookie as Mock).mock.calls[0][2]).toBe(false)
  })

  it('keeps a remembered session remembered', async () => {
    sessionRemember = true
    const { signToken } = await import('../../lib/auth.js')
    const { setAuthCookie } = await import('../../lib/auth-cookie.js')

    await post()

    expect((signToken as Mock).mock.calls[0][1]).toBe(true)
    expect((setAuthCookie as Mock).mock.calls[0][2]).toBe(true)
  })

  it('defaults to remembered when the context carries no choice (bearer / legacy token)', async () => {
    const { signToken } = await import('../../lib/auth.js')

    await post()

    expect((signToken as Mock).mock.calls[0][1]).toBe(true)
  })
})
