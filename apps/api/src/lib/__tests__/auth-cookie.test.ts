import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const envMock: {
  NODE_ENV: string
  AUTH_SECRET: string
  AUTH_COOKIE_SECURE: string | undefined
  AUTH_SESSION_TTL_DAYS: number
} = {
  NODE_ENV: 'production',
  AUTH_SECRET: 'test-secret-for-auth-cookie-tests',
  AUTH_COOKIE_SECURE: undefined,
  AUTH_SESSION_TTL_DAYS: 1,
}

vi.mock('../../env.js', () => ({
  get env() {
    return envMock
  },
}))

const setCookieMock = vi.fn()
const deleteCookieMock = vi.fn()

vi.mock('hono/cookie', () => ({
  setCookie: (...args: unknown[]) => setCookieMock(...args),
  deleteCookie: (...args: unknown[]) => deleteCookieMock(...args),
}))

import {
  AUTH_COOKIE_NAME,
  getAuthSessionTtlSeconds,
  LEGACY_AUTH_COOKIE_NAME,
  signToken,
  verifyToken,
} from '../auth.js'
import { clearAuthCookie, isCookieSecure, setAuthCookie } from '../auth-cookie.js'

const fakeCtx = {} as Context

beforeEach(() => {
  setCookieMock.mockClear()
  deleteCookieMock.mockClear()
})

afterEach(() => {
  envMock.NODE_ENV = 'production'
  envMock.AUTH_SECRET = 'test-secret-for-auth-cookie-tests'
  envMock.AUTH_COOKIE_SECURE = undefined
  envMock.AUTH_SESSION_TTL_DAYS = 1
})

describe('isCookieSecure', () => {
  it('returns true when AUTH_COOKIE_SECURE="true" (explicit override wins)', async () => {
    envMock.AUTH_COOKIE_SECURE = 'true'
    envMock.NODE_ENV = 'development'
    expect(isCookieSecure()).toBe(true)
  })

  it('returns false when AUTH_COOKIE_SECURE="false" (explicit override wins in prod)', async () => {
    envMock.AUTH_COOKIE_SECURE = 'false'
    envMock.NODE_ENV = 'production'
    expect(isCookieSecure()).toBe(false)
  })

  it('defaults to NODE_ENV=production → secure', async () => {
    envMock.AUTH_COOKIE_SECURE = undefined
    envMock.NODE_ENV = 'production'
    expect(isCookieSecure()).toBe(true)
  })

  it('defaults to NODE_ENV!=production → not secure', async () => {
    envMock.AUTH_COOKIE_SECURE = undefined
    envMock.NODE_ENV = 'development'
    expect(isCookieSecure()).toBe(false)
  })
})

describe('setAuthCookie', () => {
  it('uses the __Host- name and Secure attribute in secure mode', async () => {
    envMock.NODE_ENV = 'production'
    envMock.AUTH_COOKIE_SECURE = undefined
    setAuthCookie(fakeCtx, 'tok-abc')
    expect(setCookieMock).toHaveBeenCalledTimes(1)
    const [, name, token, opts] = setCookieMock.mock.calls[0]
    expect(name).toBe(AUTH_COOKIE_NAME)
    expect(token).toBe('tok-abc')
    expect(opts).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 24 * 60 * 60,
    })
  })

  it('uses the shared auth session ttl for maxAge', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 7
    setAuthCookie(fakeCtx, 'tok-ttl')
    const [, , , opts] = setCookieMock.mock.calls[0]

    expect(opts).toMatchObject({
      maxAge: 7 * 24 * 60 * 60,
    })
  })

  it('keeps cookie maxAge consistent with JWT expiry', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 14
    const expectedTtl = getAuthSessionTtlSeconds()

    const token = await signToken({ id: 'usr_1', role: 'admin', tokenVersion: 1 })
    const payload = await verifyToken(token)
    setAuthCookie(fakeCtx, token)
    const [, , , opts] = setCookieMock.mock.calls[0]

    expect(payload.exp - payload.iat).toBe(expectedTtl)
    expect(opts).toMatchObject({ maxAge: expectedTtl })
  })

  it('falls back to the legacy name in non-secure mode (HTTP entrypoint)', async () => {
    envMock.NODE_ENV = 'development'
    envMock.AUTH_COOKIE_SECURE = undefined
    setAuthCookie(fakeCtx, 'tok-xyz')
    const [, name, , opts] = setCookieMock.mock.calls[0]
    expect(name).toBe(LEGACY_AUTH_COOKIE_NAME)
    expect(opts).toMatchObject({ secure: false })
  })
})

describe('clearAuthCookie', () => {
  it('deletes both the __Host- and legacy cookies regardless of current secure config', async () => {
    envMock.NODE_ENV = 'development'
    envMock.AUTH_COOKIE_SECURE = 'false'
    clearAuthCookie(fakeCtx)
    expect(deleteCookieMock).toHaveBeenCalledTimes(2)
    const [hostCall, legacyCall] = deleteCookieMock.mock.calls
    expect(hostCall[1]).toBe(AUTH_COOKIE_NAME)
    expect(hostCall[2]).toMatchObject({ path: '/', secure: true })
    expect(legacyCall[1]).toBe(LEGACY_AUTH_COOKIE_NAME)
    expect(legacyCall[2]).toMatchObject({ path: '/' })
  })
})

describe('setAuthCookie remember semantics', () => {
  it('omits maxAge entirely when remember=false, making it a session cookie', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 7
    setAuthCookie(fakeCtx, 'tok-short', false)
    const [, , , opts] = setCookieMock.mock.calls[0]

    // A session cookie is expressed by the ABSENCE of maxAge/expires — setting
    // either one turns it into a persistent cookie that survives browser close.
    expect(opts.maxAge).toBeUndefined()
    expect(opts.expires).toBeUndefined()
    expect(opts).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' })
  })

  it('uses the full session ttl for maxAge when remember=true', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 7
    setAuthCookie(fakeCtx, 'tok-long', true)
    const [, , , opts] = setCookieMock.mock.calls[0]

    expect(opts).toMatchObject({ maxAge: 7 * 24 * 60 * 60 })
  })

  it('keeps the __Host- / legacy name contract regardless of remember', async () => {
    envMock.NODE_ENV = 'production'
    setAuthCookie(fakeCtx, 'tok-a', false)
    expect(setCookieMock.mock.calls[0][1]).toBe(AUTH_COOKIE_NAME)

    setCookieMock.mockClear()
    envMock.NODE_ENV = 'development'
    setAuthCookie(fakeCtx, 'tok-b', false)
    expect(setCookieMock.mock.calls[0][1]).toBe(LEGACY_AUTH_COOKIE_NAME)
  })

  it('keeps a short-lived cookie consistent with its JWT expiry', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 7
    const token = await signToken({ id: 'usr_1', role: 'admin', tokenVersion: 1 }, false)
    const payload = await verifyToken(token)
    setAuthCookie(fakeCtx, token, false)
    const [, , , opts] = setCookieMock.mock.calls[0]

    // The browser drops the cookie at browser close; the server refuses the token
    // 12h after issuance. Neither side can outlive the other's intent.
    expect(payload.exp - payload.iat).toBe(12 * 60 * 60)
    expect(opts.maxAge).toBeUndefined()
  })
})
