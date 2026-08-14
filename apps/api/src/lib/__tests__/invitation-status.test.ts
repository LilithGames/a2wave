import { describe, expect, it } from 'vitest'
import { invitationStatusOf, serializeInvitation } from '../invitation-status.js'

const NOW = new Date('2026-01-01T00:00:00.000Z')
const FUTURE = new Date('2026-01-02T00:00:00.000Z')
const PAST = new Date('2025-12-31T00:00:00.000Z')

function row(overrides: Partial<Parameters<typeof invitationStatusOf>[0]> = {}) {
  return {
    acceptedAt: null,
    revokedAt: null,
    expiresAt: FUTURE,
    ...overrides,
  }
}

describe('invitationStatusOf', () => {
  it('reports pending while unconsumed and not yet expired', () => {
    expect(invitationStatusOf(row(), NOW)).toBe('pending')
  })

  it('reports expired once expiresAt is in the past', () => {
    expect(invitationStatusOf(row({ expiresAt: PAST }), NOW)).toBe('expired')
  })

  it('treats the exact expiry instant as expired', () => {
    expect(invitationStatusOf(row({ expiresAt: NOW }), NOW)).toBe('expired')
  })

  it('reports revoked', () => {
    expect(invitationStatusOf(row({ revokedAt: PAST }), NOW)).toBe('revoked')
  })

  it('reports accepted', () => {
    expect(invitationStatusOf(row({ acceptedAt: PAST }), NOW)).toBe('accepted')
  })

  it('lets accepted outrank expiry', () => {
    expect(invitationStatusOf(row({ acceptedAt: PAST, expiresAt: PAST }), NOW)).toBe('accepted')
  })

  it('lets revoked outrank expiry', () => {
    expect(invitationStatusOf(row({ revokedAt: PAST, expiresAt: PAST }), NOW)).toBe('revoked')
  })

  it('lets accepted outrank revoked', () => {
    expect(invitationStatusOf(row({ acceptedAt: PAST, revokedAt: PAST }), NOW)).toBe('accepted')
  })

  it('defaults `now` to the current time', () => {
    expect(invitationStatusOf(row({ expiresAt: new Date(Date.now() + 60_000) }))).toBe('pending')
    expect(invitationStatusOf(row({ expiresAt: new Date(Date.now() - 60_000) }))).toBe('expired')
  })
})

describe('serializeInvitation', () => {
  const base = {
    id: 'inv_1',
    code: 'secret-code',
    email: 'a@b.com',
    role: 'user' as const,
    note: 'contractor',
    invitedBy: 'usr_admin',
    acceptedUserId: null,
    acceptedAt: null,
    revokedAt: null,
    expiresAt: FUTURE,
    createdAt: PAST,
  }

  it('includes the code and a derived status', () => {
    const out = serializeInvitation({ ...base, invitedByName: 'Alice', invitedByUsername: 'alice' })
    expect(out).toEqual({
      id: 'inv_1',
      code: 'secret-code',
      email: 'a@b.com',
      role: 'user',
      status: invitationStatusOf(base),
      note: 'contractor',
      invitedBy: 'usr_admin',
      invitedByName: 'Alice',
      acceptedUserId: null,
      acceptedAt: null,
      expiresAt: FUTURE,
      createdAt: PAST,
    })
  })

  it('prefers displayName for invitedByName', () => {
    expect(
      serializeInvitation({ ...base, invitedByName: 'Alice', invitedByUsername: 'alice' })
        .invitedByName,
    ).toBe('Alice')
  })

  it('falls back to the username when displayName is empty', () => {
    expect(
      serializeInvitation({ ...base, invitedByName: null, invitedByUsername: 'alice' })
        .invitedByName,
    ).toBe('alice')
    expect(
      serializeInvitation({ ...base, invitedByName: '', invitedByUsername: 'alice' }).invitedByName,
    ).toBe('alice')
  })

  it('falls back to null when neither name is present', () => {
    expect(serializeInvitation(base).invitedByName).toBeNull()
    expect(
      serializeInvitation({ ...base, invitedByName: null, invitedByUsername: null }).invitedByName,
    ).toBeNull()
  })

  it('normalizes a missing invitedBy to null', () => {
    expect(serializeInvitation({ ...base, invitedBy: undefined }).invitedBy).toBeNull()
  })

  it('reflects a revoked row in status', () => {
    expect(serializeInvitation({ ...base, revokedAt: PAST }).status).toBe('revoked')
  })
})
