/**
 * Named, individually revocable API keys for an Agent's inbound channels.
 *
 * Replaces the single plaintext `agents.endpoint_api_key` / `a2a_endpoint_api_key`
 * columns, where rotating meant breaking every integration at once and a database
 * read yielded working credentials for every published Agent. Same shape as
 * `cli_tokens`: only the SHA-256 is persisted, a short prefix is kept for display,
 * and each key carries a name, an optional expiry, and a last-used stamp.
 */
import { createHash, randomBytes } from 'node:crypto'

/** The two inbound channels that authenticate with a key. They never share one. */
export type AgentApiKeyChannel = 'api' | 'a2a'

/**
 * Per-channel plaintext prefixes, unchanged from the legacy columns so existing
 * keys stay recognisable and the backfill needs no rewriting.
 */
export const AGENT_API_KEY_PREFIX: Record<AgentApiKeyChannel, string> = {
  api: 'ak_',
  a2a: 'a2ak_',
}

/** How much of the plaintext the management list may show. */
const DISPLAY_PREFIX_LENGTH = 11

/**
 * Bounded so a single leaked credential cannot be used to seed unlimited backdoor
 * keys and drown the list an operator would use to spot them.
 */
export const MAX_ACTIVE_KEYS_PER_CHANNEL = 20

/**
 * Max length of a key's description.
 *
 * Deliberately short: this string is rendered in the key list *and* as the trigger
 * source in run history, where a long value would wrap the row or be truncated to
 * something unrecognisable. 24 leaves room for both scripts — "Nightly sync job" is
 * 16, and a Chinese label like "数据平台定时同步" is 8.
 */
export const MAX_KEY_NAME_LENGTH = 24

/** Don't rewrite `lastUsedAt` more often than this; a hot endpoint would write per request. */
const LAST_USED_THROTTLE_MS = 60_000

/** 24 bytes of CSPRNG behind the channel prefix, matching the legacy key length. */
export function generateAgentApiKey(channel: AgentApiKeyChannel): string {
  return `${AGENT_API_KEY_PREFIX[channel]}${randomBytes(24).toString('base64url')}`
}

/**
 * Only the hash is persisted. No salt — the input is already CSPRNG output, so
 * there is nothing to precompute, and a salt-free hash is what lets the lookup be
 * a single indexed `WHERE key_hash = ?` instead of a scan over every row.
 */
export function hashAgentApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** The part shown in the list — enough to tell two keys apart, far short of the secret. */
export function keyPrefixOf(key: string): string {
  return key.slice(0, DISPLAY_PREFIX_LENGTH)
}

export type KeyVerdict = 'valid' | 'expired' | 'invalid'

/**
 * Why expiry and revocation are reported differently: an expired key is an
 * operational problem the caller can fix themselves, and folding it into a generic
 * failure sends integrators hunting for a credential bug that isn't there. Revoked
 * must stay indistinguishable from never-existed, or the endpoint becomes an oracle
 * for which keys were once real.
 */
export function classifyKeyRecord(
  record: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date,
): KeyVerdict {
  if (record.revokedAt) return 'invalid'
  if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) return 'expired'
  return 'valid'
}

/**
 * `lastUsedAt` is the only signal separating a live key from a forgotten one, so it
 * has to be written — but not on every request. A future stored value (clock skew,
 * a restored backup) also stamps, otherwise the field would freeze permanently.
 */
export function shouldStampLastUsed(lastUsedAt: Date | null, now: Date): boolean {
  if (!lastUsedAt) return true
  const elapsed = now.getTime() - lastUsedAt.getTime()
  return elapsed < 0 || elapsed >= LAST_USED_THROTTLE_MS
}
