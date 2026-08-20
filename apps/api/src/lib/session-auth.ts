import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { cliTokens, users } from '../db/schema.js'
import { verifyToken } from './auth.js'
import { hashCliToken, isCliToken } from './cli-token.js'

export interface AuthenticatedSessionUser {
  id: string
  role: string
}

/**
 * Authenticate an opaque CLI token.
 *
 * Kept out of the JWT path entirely: these are not signed, so there is nothing to
 * verify — validity is whatever the stored row says right now, which is what
 * makes individual revocation take effect immediately.
 */
async function authenticateCliToken(token: string): Promise<AuthenticatedSessionUser | null> {
  const [row] = await db
    .select({
      id: cliTokens.id,
      expiresAt: cliTokens.expiresAt,
      revokedAt: cliTokens.revokedAt,
      userId: users.id,
      role: users.role,
      isActive: users.isActive,
    })
    .from(cliTokens)
    .innerJoin(users, eq(cliTokens.userId, users.id))
    .where(eq(cliTokens.tokenHash, hashCliToken(token)))
    .limit(1)

  if (!row || row.revokedAt) return null
  // A null expiry means "no expiry" — deliberate, so a CI credential does not die
  // mid-quarter without warning. The management list surfaces age instead.
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null
  // Deliberately NOT gated on users.tokenVersion: a password change must not break
  // every pipeline. Cutting off automation is what per-token revoke is for.
  if (!row.isActive) return null

  // Best-effort: this is the only signal that tells a stale token from a live one,
  // so it must never fail the request that produced it.
  db.update(cliTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(cliTokens.id, row.id)))
    .catch(() => undefined)

  return { id: row.userId, role: row.role }
}

/** Validate a session JWT against the current user record and revocation state. */
export async function authenticateSessionToken(
  token: string,
): Promise<AuthenticatedSessionUser | null> {
  try {
    // Cheap prefix test, so an ordinary JWT request never pays for a CLI-token lookup.
    if (isCliToken(token)) return await authenticateCliToken(token)

    const payload = await verifyToken(token)
    const [user] = await db
      .select({
        id: users.id,
        role: users.role,
        tokenVersion: users.tokenVersion,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)

    if (!user?.isActive || (payload.tv ?? -1) !== user.tokenVersion) return null
    return { id: user.id, role: user.role }
  } catch {
    return null
  }
}
