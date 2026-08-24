import type { JwtPayload } from './auth.js'

/**
 * Fraction of a session's lifetime that must elapse before the next request
 * reissues it. At 0.5 an active user is refreshed at most once per half-life —
 * frequent enough that a session never dies under active use, rare enough that
 * the common request path does no signing work.
 */
const RENEW_AFTER_ELAPSED_FRACTION = 0.5

/**
 * Decide whether a still-valid session token should be reissued (sliding
 * expiry).
 *
 * Deliberately a pure function of the payload and the clock so the policy is
 * testable without a request, a database, or a signing key.
 *
 * Returns false for anything malformed or already expired: renewal is an
 * optimisation on top of a token that has *already* passed verification, so
 * when in doubt it must do nothing and leave the existing token alone. In
 * particular an expired token is never renewed — that would let one stale
 * cookie resurrect a session indefinitely, defeating the TTL entirely.
 */
export function shouldRenewSession(payload: JwtPayload, nowSeconds: number): boolean {
  const { iat, exp } = payload
  if (typeof iat !== 'number' || typeof exp !== 'number') return false

  const lifetime = exp - iat
  if (lifetime <= 0) return false

  // Already expired (or exactly at expiry): not ours to revive.
  if (nowSeconds >= exp) return false

  const elapsed = nowSeconds - iat
  return elapsed > lifetime * RENEW_AFTER_ELAPSED_FRACTION
}
