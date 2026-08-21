import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AGENT_API_KEY_PREFIX,
  classifyKeyRecord,
  generateAgentApiKey,
  hashAgentApiKey,
  keyPrefixOf,
  MAX_ACTIVE_KEYS_PER_CHANNEL,
  shouldStampLastUsed,
} from '../agent-api-key.js'

describe('generateAgentApiKey', () => {
  it('prefixes by channel so a key is recognisable on sight', () => {
    expect(generateAgentApiKey('api').startsWith('ak_')).toBe(true)
    expect(generateAgentApiKey('a2a').startsWith('a2ak_')).toBe(true)
  })

  it('exposes the same prefixes the legacy columns used', () => {
    expect(AGENT_API_KEY_PREFIX).toEqual({ api: 'ak_', a2a: 'a2ak_' })
  })

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateAgentApiKey('api')))
    expect(keys.size).toBe(100)
  })
})

describe('hashAgentApiKey', () => {
  it('is the plain SHA-256 of the plaintext, matching what the backfill can compute', () => {
    const key = generateAgentApiKey('api')
    expect(hashAgentApiKey(key)).toBe(createHash('sha256').update(key).digest('hex'))
  })

  it('never returns the plaintext', () => {
    const key = generateAgentApiKey('api')
    expect(hashAgentApiKey(key)).not.toContain(key)
  })
})

describe('keyPrefixOf', () => {
  it('keeps enough to tell two keys apart', () => {
    const a = keyPrefixOf('ak_abcdefghijklmnop')
    const b = keyPrefixOf('ak_abcdefghijklmnop')
    expect(a).toBe(b)
    expect(keyPrefixOf('ak_abcdefgh')).not.toBe(keyPrefixOf('ak_zyxwvuts'))
  })

  it('stops far short of the secret', () => {
    const key = generateAgentApiKey('api')
    const prefix = keyPrefixOf(key)
    expect(prefix.length).toBeLessThan(key.length / 2)
    expect(key.startsWith(prefix)).toBe(true)
  })
})

describe('classifyKeyRecord', () => {
  const now = new Date('2026-06-01T00:00:00Z')

  it('accepts a live key', () => {
    expect(classifyKeyRecord({ revokedAt: null, expiresAt: null }, now)).toBe('valid')
  })

  it('accepts a key whose expiry is still ahead', () => {
    expect(
      classifyKeyRecord({ revokedAt: null, expiresAt: new Date('2026-06-02T00:00:00Z') }, now),
    ).toBe('valid')
  })

  it('reports expiry separately — it is an operational problem the caller can fix', () => {
    expect(
      classifyKeyRecord({ revokedAt: null, expiresAt: new Date('2026-05-31T00:00:00Z') }, now),
    ).toBe('expired')
  })

  it('treats the exact expiry instant as expired', () => {
    expect(classifyKeyRecord({ revokedAt: null, expiresAt: now }, now)).toBe('expired')
  })

  it('reports a revoked key as invalid, not expired: revoked and never-existed must be indistinguishable', () => {
    expect(
      classifyKeyRecord({ revokedAt: new Date('2026-01-01T00:00:00Z'), expiresAt: null }, now),
    ).toBe('invalid')
  })

  it('prefers revoked over expired — a revoked key must never hint that it was once real', () => {
    expect(
      classifyKeyRecord(
        {
          revokedAt: new Date('2026-01-01T00:00:00Z'),
          expiresAt: new Date('2026-05-31T00:00:00Z'),
        },
        now,
      ),
    ).toBe('invalid')
  })
})

describe('shouldStampLastUsed', () => {
  const now = new Date('2026-06-01T12:00:00Z')

  it('stamps a key that has never been used', () => {
    expect(shouldStampLastUsed(null, now)).toBe(true)
  })

  it('skips a key stamped seconds ago, so a hot endpoint does not write per request', () => {
    expect(shouldStampLastUsed(new Date('2026-06-01T11:59:30Z'), now)).toBe(false)
  })

  it('stamps again once the throttle window has passed', () => {
    expect(shouldStampLastUsed(new Date('2026-06-01T11:58:00Z'), now)).toBe(true)
  })

  it('stamps when the stored value is somehow in the future (clock skew must not wedge it forever)', () => {
    expect(shouldStampLastUsed(new Date('2026-06-01T13:00:00Z'), now)).toBe(true)
  })
})

describe('MAX_ACTIVE_KEYS_PER_CHANNEL', () => {
  it('is bounded — an unbounded list lets one leak seed unlimited backdoor keys', () => {
    expect(MAX_ACTIVE_KEYS_PER_CHANNEL).toBe(20)
  })
})
