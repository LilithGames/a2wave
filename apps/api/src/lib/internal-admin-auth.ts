import { hkdfSync, timingSafeEqual } from 'node:crypto'
import { env } from '../env.js'

export const INTERNAL_ADMIN_TOKEN_ENV = 'A2WAVE_INTERNAL_ADMIN_TOKEN'
export const INTERNAL_ADMIN_TOKEN_HEADER = 'x-a2wave-internal-admin-token'

/** Credential for the non-admin `/api/internal/*` surface (agent-router MCP). */
export const INTERNAL_TOKEN_ENV = 'A2WAVE_INTERNAL_TOKEN'
export const INTERNAL_TOKEN_HEADER = 'x-a2wave-internal-token'

/**
 * Both credentials are DERIVED from `AUTH_SECRET`, not randomly generated per
 * process.
 *
 * They reach their MCP process through the workspace MCP config file, which
 * sits on storage every API replica shares. A per-process random secret is
 * therefore wrong by construction here: the later replica's sync overwrites the
 * shared file with its own value, and the MCP the FIRST replica spawned then
 * presents a token that replica rejects — a 403 from its own localhost API.
 * Every replica of one deployment already shares `AUTH_SECRET` (it signs the
 * sessions), so a derived token is identical everywhere and accepted
 * everywhere.
 *
 * The derivation keeps the properties the random value had: the secret is never
 * written to `process.env`, the database or the logs, and it is handed only to
 * the seeded SYSTEM builtin MCP rows. Distinct `info` strings keep the two
 * credentials independent, so the weaker router token cannot be replayed
 * against the platform-admin surface even though both come from one root.
 */
const HKDF_SALT = 'a2wave-internal-auth-v1'
const TOKEN_BYTES = 32

function deriveToken(info: string): string {
  return Buffer.from(
    hkdfSync('sha256', env.AUTH_SECRET, Buffer.from(HKDF_SALT), Buffer.from(info), TOKEN_BYTES),
  ).toString('base64url')
}

function matchesSecret(secret: string, candidate: string | undefined): boolean {
  if (!candidate) return false
  const actual = Buffer.from(secret)
  const provided = Buffer.from(candidate)
  return actual.length === provided.length && timingSafeEqual(actual, provided)
}

export function getInternalAdminToken(): string {
  return deriveToken('internal-admin-token')
}

export function verifyInternalAdminToken(candidate: string | undefined): boolean {
  return matchesSecret(getInternalAdminToken(), candidate)
}

export function getInternalToken(): string {
  return deriveToken('internal-token')
}

export function verifyInternalToken(candidate: string | undefined): boolean {
  return matchesSecret(getInternalToken(), candidate)
}
