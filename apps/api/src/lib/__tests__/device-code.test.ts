import { describe, expect, it } from 'vitest'
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  isPolledTooSoon,
  normalizeUserCode,
} from '../device-code.js'

describe('generateUserCode', () => {
  it('is 8 chars in two hyphenated groups', () => {
    expect(generateUserCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  })

  it('never emits characters that are ambiguous when read aloud or retyped', () => {
    const codes = Array.from({ length: 200 }, () => generateUserCode()).join('')
    // I/1 and O/0 are the pairs a user transcribing from a terminal confuses.
    expect(codes).not.toMatch(/[IOU10]/)
  })

  it('does not repeat within a reasonable sample', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateUserCode()))
    expect(codes.size).toBe(500)
  })
})

describe('normalizeUserCode', () => {
  it('accepts the code as the user actually retypes it', () => {
    expect(normalizeUserCode(' wdjb-mjht ')).toBe('WDJB-MJHT')
    expect(normalizeUserCode('wdjbmjht')).toBe('WDJB-MJHT')
    expect(normalizeUserCode('WDJB MJHT')).toBe('WDJB-MJHT')
  })

  it('rejects anything that is not exactly eight code characters', () => {
    expect(normalizeUserCode('WDJB')).toBeNull()
    expect(normalizeUserCode('WDJB-MJHT-EXTRA')).toBeNull()
    expect(normalizeUserCode('')).toBeNull()
  })

  it('rejects excluded characters rather than silently coercing them', () => {
    // Coercing I→1 would let two distinct codes normalize onto one row.
    expect(normalizeUserCode('WDJB-MJHI')).toBeNull()
  })
})

describe('generateDeviceCode', () => {
  it('carries at least 256 bits of entropy as url-safe text', () => {
    const code = generateDeviceCode()
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(code.length).toBeGreaterThanOrEqual(43)
  })

  it('is unique per call', () => {
    expect(generateDeviceCode()).not.toBe(generateDeviceCode())
  })
})

describe('hashDeviceCode', () => {
  it('is a stable hex sha256', () => {
    expect(hashDeviceCode('abc')).toBe(hashDeviceCode('abc'))
    expect(hashDeviceCode('abc')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates distinct codes', () => {
    expect(hashDeviceCode('abc')).not.toBe(hashDeviceCode('abd'))
  })
})

describe('isPolledTooSoon', () => {
  const now = new Date('2026-01-01T00:00:00Z')

  it('allows the first poll', () => {
    expect(isPolledTooSoon(null, now)).toBe(false)
  })

  it('rejects a poll inside the advertised interval', () => {
    const last = new Date(now.getTime() - 1000)
    expect(isPolledTooSoon(last, now)).toBe(true)
  })

  it('allows a poll at exactly the advertised interval', () => {
    const last = new Date(now.getTime() - DEVICE_POLL_INTERVAL_SECONDS * 1000)
    expect(isPolledTooSoon(last, now)).toBe(false)
  })

  it('tolerates a clock that moved backwards instead of locking the client out', () => {
    const last = new Date(now.getTime() + 60_000)
    expect(isPolledTooSoon(last, now)).toBe(false)
  })
})

describe('constants', () => {
  it('expires well inside a coffee break, and polls at the RFC 8628 default', () => {
    expect(DEVICE_CODE_TTL_SECONDS).toBe(600)
    expect(DEVICE_POLL_INTERVAL_SECONDS).toBe(5)
  })
})
