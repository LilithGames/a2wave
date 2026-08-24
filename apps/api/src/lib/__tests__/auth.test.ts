import { afterEach, describe, expect, it, vi } from 'vitest'

const envMock = {
  AUTH_SECRET: 'test-secret-for-auth-tests',
  AUTH_SESSION_TTL_DAYS: 1,
}

vi.mock('../../env.js', () => ({
  get env() {
    return envMock
  },
}))

import {
  AUTH_COOKIE_NAME,
  getAuthSessionTtlSeconds,
  getShortSessionTtlSeconds,
  hashPassword,
  LEGACY_AUTH_COOKIE_NAME,
  PASSWORD_POLICY,
  signToken,
  validatePassword,
  verifyPassword,
  verifyToken,
} from '../auth.js'

afterEach(() => {
  envMock.AUTH_SESSION_TTL_DAYS = 1
})

describe('validatePassword', () => {
  it('rejects passwords shorter than the minimum length', async () => {
    const result = validatePassword('Aa1aaa')
    expect(result).toEqual({ valid: false, message: 'PASSWORD_TOO_SHORT' })
  })

  it('rejects passwords missing an uppercase letter', async () => {
    const result = validatePassword('abcdefg1')
    expect(result).toEqual({ valid: false, message: 'PASSWORD_NEED_UPPER' })
  })

  it('rejects passwords missing a lowercase letter', async () => {
    const result = validatePassword('ABCDEFG1')
    expect(result).toEqual({ valid: false, message: 'PASSWORD_NEED_LOWER' })
  })

  it('rejects passwords missing a digit', async () => {
    const result = validatePassword('Abcdefgh')
    expect(result).toEqual({ valid: false, message: 'PASSWORD_NEED_DIGIT' })
  })

  it('accepts a password that satisfies every rule', async () => {
    expect(validatePassword('Aa1aaaaa')).toEqual({ valid: true })
  })

  it('exposes the policy constants for callers', async () => {
    expect(PASSWORD_POLICY.minLength).toBe(8)
    expect(PASSWORD_POLICY.requireUppercase).toBe(true)
    expect(PASSWORD_POLICY.requireLowercase).toBe(true)
    expect(PASSWORD_POLICY.requireDigit).toBe(true)
  })
})

describe('hashPassword / verifyPassword', () => {
  it('produces a hash that verifies against the original plaintext', async () => {
    const hashed = await hashPassword('Aa1aaaaa')
    expect(hashed).not.toBe('Aa1aaaaa')
    expect(await verifyPassword(hashed, 'Aa1aaaaa')).toBe(true)
  })

  it('rejects a wrong plaintext', async () => {
    const hashed = await hashPassword('Aa1aaaaa')
    expect(await verifyPassword(hashed, 'Bb2bbbbb')).toBe(false)
  })
})

describe('signToken / verifyToken', () => {
  it('round-trips the JWT payload (sub / role / tv)', async () => {
    const token = await signToken({ id: 'usr_1', role: 'admin', tokenVersion: 3 })
    expect(typeof token).toBe('string')
    expect(token.split('.')).toHaveLength(3)

    const payload = await verifyToken(token)
    expect(payload.sub).toBe('usr_1')
    expect(payload.role).toBe('admin')
    expect(payload.tv).toBe(3)
    expect(payload.iat).toBeGreaterThan(0)
    expect(payload.exp).toBeGreaterThan(payload.iat)
    // Default remains 24h for deployments that do not set AUTH_SESSION_TTL_DAYS.
    expect(payload.exp - payload.iat).toBe(24 * 60 * 60)
  })

  it('uses the configured auth session ttl for JWT expiry', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 7
    const token = await signToken({ id: 'usr_1', role: 'admin', tokenVersion: 3 })
    const payload = await verifyToken(token)

    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60)
  })

  it('rejects a tampered token', async () => {
    const token = await signToken({ id: 'usr_1', role: 'user', tokenVersion: 1 })
    const tampered = `${token}x`
    await expect(verifyToken(tampered)).rejects.toBeDefined()
  })
})

describe('getAuthSessionTtlSeconds', () => {
  it('derives seconds from the shared auth session ttl env', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 30
    expect(getAuthSessionTtlSeconds()).toBe(30 * 24 * 60 * 60)
  })
})

describe('cookie name constants', () => {
  it('matches the documented secure/__Host- / legacy contract', async () => {
    expect(AUTH_COOKIE_NAME).toBe('__Host-a2wave_session')
    expect(LEGACY_AUTH_COOKIE_NAME).toBe('a2wave_session')
  })
})

describe('short session ttl (remember=false)', () => {
  it('exposes a 12h short-session ttl independent of AUTH_SESSION_TTL_DAYS', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 30
    expect(getShortSessionTtlSeconds()).toBe(12 * 60 * 60)
  })

  it('signs a short-lived token when remember is false', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 7
    const token = await signToken({ id: 'usr_1', role: 'user', tokenVersion: 1 }, false)
    const payload = await verifyToken(token)

    expect(payload.exp - payload.iat).toBe(12 * 60 * 60)
  })

  it('signs a full-ttl token when remember is true', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 7
    const token = await signToken({ id: 'usr_1', role: 'user', tokenVersion: 1 }, true)
    const payload = await verifyToken(token)

    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60)
  })

  it('defaults to the full ttl when remember is omitted, preserving existing callers', async () => {
    envMock.AUTH_SESSION_TTL_DAYS = 7
    const token = await signToken({ id: 'usr_1', role: 'user', tokenVersion: 1 })
    const payload = await verifyToken(token)

    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60)
  })

  it('records the remember choice in the payload so renewal can preserve it', async () => {
    const remembered = await verifyToken(
      await signToken({ id: 'usr_1', role: 'user', tokenVersion: 1 }, true),
    )
    const shortLived = await verifyToken(
      await signToken({ id: 'usr_1', role: 'user', tokenVersion: 1 }, false),
    )

    expect(remembered.rm).toBe(true)
    expect(shortLived.rm).toBe(false)
  })
})
