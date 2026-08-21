/**
 * One-shot migration of the legacy single-key columns into `agent_api_keys`.
 *
 * `agents.endpoint_api_key` / `a2a_endpoint_api_key` held the credential in
 * plaintext, which is the only reason this migration can run unattended: the hash
 * is computable from what is already in the database, so no integration has to
 * rotate anything and nobody has to be told. That window closes for good once the
 * legacy columns are cleared — this is the last chance to take it.
 *
 * Neither SQLite nor a stock PostgreSQL can compute SHA-256 in SQL (pgcrypto is not
 * guaranteed present), so the hashing happens here in Node rather than in the `.sql`
 * migration, following backfill-workspaces-path.ts.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agentApiKeys, agents } from '../db/schema.js'
import { runExclusive } from '../db/transaction.js'
import { type AgentApiKeyChannel, hashAgentApiKey, keyPrefixOf } from './agent-api-key.js'
import { createId } from './id.js'
import { logger } from './logger.js'

/**
 * The label a migrated key gets. Names are required everywhere else, and this is
 * what an operator sees next to a key they never explicitly created — it has to say
 * where it came from, not just "Default".
 */
export const MIGRATED_KEY_NAME = 'Migrated key'

export interface LegacyKeyRow {
  id: string
  endpointApiKey: string | null
  a2aEndpointApiKey: string | null
}

export interface PlannedApiKey {
  id: string
  agentId: string
  channel: AgentApiKeyChannel
  keyHash: string
  keyPrefix: string
  name: string
  expiresAt: null
  createdAt: Date
  revokedAt?: undefined
  lastUsedAt?: undefined
}

/**
 * Pure planner: legacy rows in, insertable records out.
 *
 * `alreadyMigrated` carries the hashes already present in `agent_api_keys`, which is
 * what makes a re-run a no-op — the legacy columns stay populated through Phase 2's
 * dual-read, so "has a legacy key" cannot itself mean "not yet migrated".
 */
export function planAgentApiKeyBackfill(
  rows: ReadonlyArray<LegacyKeyRow>,
  alreadyMigrated: ReadonlySet<string>,
  now: Date,
): PlannedApiKey[] {
  const planned: PlannedApiKey[] = []
  // `key_hash` is UNIQUE, so a duplicate inside one batch would abort the whole
  // insert. Two Agents sharing a legacy key should not happen, but a hand-edited
  // database or a cloned row makes it possible, and losing the entire migration to
  // it would be far worse than migrating the key once.
  const seen = new Set(alreadyMigrated)

  for (const row of rows) {
    const candidates: Array<[AgentApiKeyChannel, string | null]> = [
      ['api', row.endpointApiKey],
      ['a2a', row.a2aEndpointApiKey],
    ]

    for (const [channel, plaintext] of candidates) {
      // An empty or whitespace-only column is not a usable credential; migrating it
      // would create a key that authenticates nothing and confuses the list.
      if (!plaintext?.trim()) continue

      const keyHash = hashAgentApiKey(plaintext)
      if (seen.has(keyHash)) continue
      seen.add(keyHash)

      planned.push({
        id: createId('aak'),
        agentId: row.id,
        channel,
        keyHash,
        keyPrefix: keyPrefixOf(plaintext),
        name: MIGRATED_KEY_NAME,
        // Deliberately never expiring. These keys are in active use by integrations
        // that were never told about an expiry; inventing one would turn a silent
        // migration into a scheduled outage.
        expiresAt: null,
        createdAt: now,
      })
    }
  }

  return planned
}

/** Idempotent: a key whose hash is already present is never re-planned. */
export async function backfillAgentApiKeys(): Promise<number> {
  const rows = await db
    .select({
      id: agents.id,
      endpointApiKey: agents.endpointApiKey,
      a2aEndpointApiKey: agents.a2aEndpointApiKey,
    })
    .from(agents)

  const legacyRows = rows.filter((r) => r.endpointApiKey?.trim() || r.a2aEndpointApiKey?.trim())
  if (legacyRows.length === 0) return 0

  const existing = await db.select({ keyHash: agentApiKeys.keyHash }).from(agentApiKeys)
  const planned = planAgentApiKeyBackfill(
    legacyRows,
    new Set(existing.map((e) => e.keyHash)),
    new Date(),
  )
  if (planned.length === 0) return 0

  // `runExclusive` for the same reason as backfill-workspaces-path: this runs at boot
  // with the port already open, and on SQLite a bare write issued inside another
  // request's transaction would be erased by its ROLLBACK after we counted it done.
  await runExclusive(async () => db.insert(agentApiKeys).values(planned))

  logger.info(
    { count: planned.length },
    'Migrated legacy Agent endpoint keys into agent_api_keys (plaintext columns retained for dual-read)',
  )
  return planned.length
}

/**
 * Whether an Agent still has a legacy plaintext key on this channel. Phase 2's
 * dual-read consults it only after the hashed lookup misses.
 */
export async function findLegacyPlaintextKey(
  agentId: string,
  channel: AgentApiKeyChannel,
): Promise<string | null> {
  const column = channel === 'api' ? agents.endpointApiKey : agents.a2aEndpointApiKey
  const [row] = await db.select({ key: column }).from(agents).where(eq(agents.id, agentId)).limit(1)
  return row?.key ?? null
}
