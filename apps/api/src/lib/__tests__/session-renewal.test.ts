import { describe, expect, it } from 'vitest'

import type { JwtPayload } from '../auth.js'
import { shouldRenewSession } from '../session-renewal.js'

/**
 * Sliding renewal policy: a session that is more than half spent gets reissued
 * on its next request, so an actively used session never expires under the user
 * while an idle one still dies on schedule.
 */
describe('shouldRenewSession', () => {
  const now = 1_700_000_000

  function payload(over: Partial<JwtPayload> = {}): JwtPayload {
    return { sub: 'usr_1', role: 'user', tv: 0, iat: now - 100, exp: now + 100, ...over }
  }

  it('does not renew a freshly issued token', () => {
    // 10% elapsed — renewing here would reissue on nearly every request.
    expect(shouldRenewSession(payload({ iat: now - 10, exp: now + 90 }), now)).toBe(false)
  })

  it('does not renew at exactly half life (strictly past the midpoint)', () => {
    expect(shouldRenewSession(payload({ iat: now - 50, exp: now + 50 }), now)).toBe(false)
  })

  it('renews once more than half the lifetime has elapsed', () => {
    expect(shouldRenewSession(payload({ iat: now - 51, exp: now + 49 }), now)).toBe(true)
  })

  it('renews a token close to expiry', () => {
    expect(shouldRenewSession(payload({ iat: now - 99, exp: now + 1 }), now)).toBe(true)
  })

  it('does not renew an already expired token', () => {
    // Expired tokens are rejected upstream; renewing one here would resurrect a
    // dead session forever, which is the one thing sliding expiry must not do.
    expect(shouldRenewSession(payload({ iat: now - 200, exp: now - 1 }), now)).toBe(false)
  })

  it('returns false when iat is missing, rather than guessing a lifetime', () => {
    expect(shouldRenewSession({ exp: now + 10 } as never, now)).toBe(false)
  })

  it('returns false when exp is missing', () => {
    expect(shouldRenewSession({ iat: now - 10 } as never, now)).toBe(false)
  })

  it('returns false for a non-positive lifetime instead of dividing by zero', () => {
    expect(shouldRenewSession(payload({ iat: now, exp: now }), now)).toBe(false)
  })
})
