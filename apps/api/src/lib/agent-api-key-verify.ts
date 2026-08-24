/**
 * Inbound API-key verification for the REST gateway and A2A channels.
 *
 * The lookup is a single indexed read on `key_hash`, not a scan: the stored hash is
 * unsalted (the input is already CSPRNG output), so the candidate's hash can be
 * computed once and matched directly. That also makes the comparison constant-time
 * for free — hex digests of equal length, compared by the database.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agentApiKeys } from '../db/schema.js'
import { runExclusive } from '../db/transaction.js'
import {
  AGENT_API_KEY_PREFIX,
  type AgentApiKeyChannel,
  classifyKeyRecord,
  hashAgentApiKey,
  shouldStampLastUsed,
} from './agent-api-key.js'
import { findLegacyPlaintextKey } from './backfill-agent-api-keys.js'
import { logger } from './logger.js'

export type VerifyFailureReason = 'invalid' | 'expired'

export type VerifyResult =
  | {
      ok: true
      keyId: string
      keyName: string
      /**
       * True when this key IS the Agent's legacy single-column credential, which
       * `backfillAgentApiKeys()` copied into this table at boot. Derived from the
       * hash rather than the row's name, because the name is an editable label:
       * keying on it would let a rename silently re-scope a live credential.
       * Callers that partition state per key must keep migrated keys on the
       * pre-migration scope, or an upgrade orphans everything in flight.
       */
      isLegacyMigrated: boolean
    }
  | { ok: false; reason: VerifyFailureReason }

const INVALID: VerifyResult = { ok: false, reason: 'invalid' }

/**
 * Verify a presented key against an Agent's keys on one channel.
 *
 * Channel is part of the lookup, not a post-check: an A2A key presented to the REST
 * gateway simply does not match, which keeps the two channels as decoupled as the
 * separate legacy columns were.
 */
export async function verifyAgentApiKey(
  agentId: string,
  channel: AgentApiKeyChannel,
  plaintext: string,
  opts?: { clientIp?: string },
): Promise<VerifyResult> {
  // Cheap short-circuit: a key for the other channel, or anything not ours, is
  // rejected without a query.
  if (!plaintext.startsWith(AGENT_API_KEY_PREFIX[channel])) return INVALID

  const keyHash = hashAgentApiKey(plaintext)
  const [row] = await db
    .select({
      id: agentApiKeys.id,
      name: agentApiKeys.name,
      expiresAt: agentApiKeys.expiresAt,
      lastUsedAt: agentApiKeys.lastUsedAt,
      revokedAt: agentApiKeys.revokedAt,
    })
    .from(agentApiKeys)
    .where(
      and(
        eq(agentApiKeys.keyHash, keyHash),
        eq(agentApiKeys.agentId, agentId),
        eq(agentApiKeys.channel, channel),
      ),
    )
    .limit(1)

  if (!row) return INVALID

  const now = new Date()
  const verdict = classifyKeyRecord(
    { revokedAt: row.revokedAt ?? null, expiresAt: row.expiresAt ?? null },
    now,
  )
  if (verdict !== 'valid')
    return { ok: false, reason: verdict === 'expired' ? 'expired' : 'invalid' }

  await stampLastUsed(row.id, row.lastUsedAt ?? null, now, opts?.clientIp)

  const legacyPlaintext = await findLegacyPlaintextKey(agentId, channel)
  const isLegacyMigrated = legacyPlaintext ? hashAgentApiKey(legacyPlaintext) === keyHash : false

  return { ok: true, keyId: row.id, keyName: row.name, isLegacyMigrated }
}

/**
 * Best-effort, throttled last-used telemetry. It must never fail the request that
 * produced it — a locked database at stamp time is not a reason to reject a
 * credential that already verified.
 */
async function stampLastUsed(
  keyId: string,
  lastUsedAt: Date | null,
  now: Date,
  clientIp?: string,
): Promise<void> {
  if (!shouldStampLastUsed(lastUsedAt, now)) return
  try {
    // runExclusive: this is a non-transactional write racing whatever transaction the
    // surrounding request may hold; on SQLite a bare update would join and be erased
    // by its ROLLBACK.
    await runExclusive(async () =>
      db
        .update(agentApiKeys)
        .set({ lastUsedAt: now, ...(clientIp ? { lastUsedIp: clientIp } : {}) })
        .where(eq(agentApiKeys.id, keyId)),
    )
  } catch (err) {
    logger.debug({ keyId, err }, 'Failed to stamp agent API key lastUsedAt (ignored)')
  }
}
