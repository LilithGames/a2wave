/**
 * Long-lived, individually revocable CLI credentials.
 *
 * A session JWT is the wrong shape for automation: it expires on the session TTL
 * and every one of a user's tokens dies at once when `users.tokenVersion` bumps,
 * so a password change silently breaks every pipeline. These are opaque,
 * server-side, and named, so one can be revoked without touching the others.
 */
import { createHash, randomBytes } from 'node:crypto'

/**
 * Marks the credential as an a2wave CLI token wherever it surfaces — a log, a CI
 * secret store, a pasted snippet. Also lets the auth path tell it apart from a
 * session JWT without a database read.
 */
export const CLI_TOKEN_PREFIX = 'a2wc_'

/** How much of the plaintext is safe to display in a list. */
const DISPLAY_PREFIX_LENGTH = CLI_TOKEN_PREFIX.length + 6

/** 32 bytes of CSPRNG behind the prefix. */
export function generateCliToken(): string {
  return `${CLI_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** Whether this bearer value is a CLI token rather than a session JWT. */
export function isCliToken(token: string): boolean {
  return token.startsWith(CLI_TOKEN_PREFIX)
}

/**
 * Only the hash is persisted: a database read must not yield a working
 * credential. No salt — the input is already 256 bits of CSPRNG, so there is
 * nothing to precompute.
 */
export function hashCliToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * The part shown in the management list. Enough to tell two tokens apart, far
 * short of the secret — this string is rendered to anyone who can see the list.
 */
export function tokenPrefixOf(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LENGTH)
}
