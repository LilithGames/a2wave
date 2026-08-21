import { describe, expect, it } from 'vitest'
import { keyState } from '../publish/api-key-list'

const base = {
  id: 'aak_1',
  channel: 'api' as const,
  name: 'CI pipeline',
  keyPrefix: 'ak_9f3a2b1',
  expiresAt: null,
  lastUsedAt: null,
  lastUsedIp: null,
  revokedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
}

const now = new Date('2026-06-01T00:00:00Z')

describe('keyState', () => {
  it('treats a key with no expiry as active', () => {
    expect(keyState(base, now)).toBe('active')
  })

  it('treats a distant expiry as active', () => {
    expect(keyState({ ...base, expiresAt: '2026-12-01T00:00:00Z' }, now)).toBe('active')
  })

  it('flags a key expiring within the week, so it can be rotated before calls start failing', () => {
    expect(keyState({ ...base, expiresAt: '2026-06-05T00:00:00Z' }, now)).toBe('expiring')
  })

  it('flags a past expiry', () => {
    expect(keyState({ ...base, expiresAt: '2026-05-01T00:00:00Z' }, now)).toBe('expired')
  })

  it('reports revoked ahead of expired — a revoked key is gone regardless of its expiry', () => {
    expect(
      keyState(
        { ...base, expiresAt: '2026-05-01T00:00:00Z', revokedAt: '2026-04-01T00:00:00Z' },
        now,
      ),
    ).toBe('revoked')
  })
})
