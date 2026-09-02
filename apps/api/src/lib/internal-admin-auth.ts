import { randomBytes, timingSafeEqual } from 'node:crypto'

export const INTERNAL_ADMIN_TOKEN_ENV = 'A2WAVE_INTERNAL_ADMIN_TOKEN'
export const INTERNAL_ADMIN_TOKEN_HEADER = 'x-a2wave-internal-admin-token'

/** Credential for the non-admin `/api/internal/*` surface (agent-router MCP). */
export const INTERNAL_TOKEN_ENV = 'A2WAVE_INTERNAL_TOKEN'
export const INTERNAL_TOKEN_HEADER = 'x-a2wave-internal-token'

// Generated once per API process. It is intentionally not written to
// process.env, SQLite or logs; only the seeded platform-admin MCP receives it.
const internalAdminToken = randomBytes(32).toString('base64url')

// A SECOND, weaker process credential for the rest of the internal surface.
// The agent-router MCP runs for every Agent, so handing it the admin token would
// give any Agent's router process the platform-admin data plane; a separate
// secret keeps that privilege boundary intact while both stay process-scoped and
// live only here.
const internalToken = randomBytes(32).toString('base64url')

function matchesSecret(secret: string, candidate: string | undefined): boolean {
  if (!candidate) return false
  const actual = Buffer.from(secret)
  const provided = Buffer.from(candidate)
  return actual.length === provided.length && timingSafeEqual(actual, provided)
}

export function getInternalAdminToken(): string {
  return internalAdminToken
}

export function verifyInternalAdminToken(candidate: string | undefined): boolean {
  return matchesSecret(internalAdminToken, candidate)
}

export function getInternalToken(): string {
  return internalToken
}

export function verifyInternalToken(candidate: string | undefined): boolean {
  return matchesSecret(internalToken, candidate)
}
