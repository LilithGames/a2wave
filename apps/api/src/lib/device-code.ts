/**
 * Code generation and poll pacing for the RFC 8628 device authorization grant,
 * which is how `a2wave login` works on a machine that cannot host the loopback
 * SSO callback (SSH, container, CI).
 *
 * Two codes with deliberately different properties:
 *   - the *device code* is a bearer credential the CLI holds and never displays,
 *     so it is long and high-entropy;
 *   - the *user code* is transcribed by a human between a terminal and a browser,
 *     so it is short and drawn from an alphabet that survives being read aloud.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto'

/** How long a started login stays claimable. Long enough to walk to another machine. */
export const DEVICE_CODE_TTL_SECONDS = 600

/** Advertised poll interval, RFC 8628 §3.2 default. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5

/**
 * Crockford-style alphabet: I, O, U, 1 and 0 are removed. I/1 and O/0 are the
 * pairs a user confuses when retyping from a terminal, and U is dropped so a
 * random draw cannot spell an unfortunate word.
 */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZ23456789'

const USER_CODE_LENGTH = 8

/**
 * 8 characters of the alphabet above ~= 39 bits, hyphenated mid-way for legibility.
 * Guessing one is additionally bounded by the 10-minute TTL and by the fact that
 * a guess only helps an attacker who is also authenticated as the victim.
 */
export function generateUserCode(): string {
  let out = ''
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    out += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

/**
 * Accept the code as a user actually retypes it — lowercased, hyphen dropped,
 * space instead of hyphen, padded with whitespace — and reject everything else.
 *
 * Deliberately does NOT coerce I->1 or O->0: those characters are absent from the
 * alphabet, so coercing them would let two different inputs normalize onto one
 * row. An unreadable code should fail loudly and be retyped.
 */
export function normalizeUserCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, '')
  if (compact.length !== USER_CODE_LENGTH) return null
  for (const ch of compact) {
    if (!USER_CODE_ALPHABET.includes(ch)) return null
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}

/** 32 bytes of CSPRNG, base64url. This is what the CLI exchanges for a token. */
export function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Only the hash is persisted: a database read must not yield something that can
 * be replayed against the token endpoint. No salt — the input is already 256
 * bits of CSPRNG, so there is nothing to precompute.
 */
export function hashDeviceCode(deviceCode: string): string {
  return createHash('sha256').update(deviceCode).digest('hex')
}

/**
 * Whether this poll arrived inside the advertised interval, which the token
 * endpoint answers with `slow_down`.
 *
 * A `lastPolledAt` in the future means the clock moved backwards; that is treated
 * as "not too soon" rather than locking a well-behaved client out until the skew
 * elapses.
 */
export function isPolledTooSoon(lastPolledAt: Date | null, now: Date): boolean {
  if (!lastPolledAt) return false
  const elapsedMs = now.getTime() - lastPolledAt.getTime()
  if (elapsedMs < 0) return false
  return elapsedMs < DEVICE_POLL_INTERVAL_SECONDS * 1000
}
