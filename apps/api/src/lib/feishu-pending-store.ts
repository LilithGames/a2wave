/**
 * DB-backed store for pending Feishu message events.
 *
 * The in-memory `pending-job-registry` holds full executeJob closures for
 * Feishu runs that are queued while waiting for a concurrency slot. That Map
 * is lost on restart — this store is the cold-start fallback that lets
 * recovery replay the original Feishu event, re-build the closure, and keep
 * streaming cards / quote replies working.
 *
 * Entries are created at the top of `handleMessage` and removed when the
 * message completes (either success, failure, or was identified as a dupe).
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { feishuPendingMessages } from '../db/schema.js'
import { isUniqueViolation } from './db-errors.js'

/**
 * The `im.message.receive_v1` message object. Feishu keeps adding fields, so the
 * index signature stays open — the named members are the ones a2wave reads.
 */
export interface FeishuMessagePayload {
  /** Always present on a real event; required by the downstream channel builder. */
  message_id: string
  chat_id: string
  /** Present on every real event; optional so partial payloads stay constructible. */
  message_type?: string
  /** JSON string; shape depends on `message_type`. */
  content?: string
  /** Absent on the synthetic payloads built for card-callback resume. */
  chat_type?: string
  msg_type?: string
  root_id?: string
  parent_id?: string
  thread_id?: string
  create_time?: string
  mentions?: Array<{ key: string; id?: { open_id?: string } }>
  [key: string]: unknown
}

/** The sender object carried by the same event. */
export interface FeishuSenderPayload {
  sender_type?: string
  tenant_key?: string
  sender_id?: { open_id?: string; user_id?: string; union_id?: string }
  [key: string]: unknown
}

export interface FeishuEventPayload {
  /** The raw Feishu `im.message.receive_v1` message object. */
  message: FeishuMessagePayload
  /** The raw sender object from the same event. */
  sender: FeishuSenderPayload
}

export interface FeishuPendingRow {
  messageId: string
  agentId: string
  payload: FeishuEventPayload
  createdAt: number
}

/**
 * Idempotently record a pending Feishu message. Safe to call multiple times
 * for the same (message_id, agent_id) — a PK conflict is silently ignored,
 * mirroring INSERT OR IGNORE semantics.
 *
 * The conflict target is the *pair*, not the message alone: Feishu delivers one
 * message_id to every bot in a chat, so two Agents sharing a group legitimately
 * insert the same message_id and neither may be swallowed as a duplicate.
 */
export async function persistPendingMessage(
  messageId: string,
  agentId: string,
  payload: FeishuEventPayload,
): Promise<void> {
  try {
    await db.insert(feishuPendingMessages).values({
      messageId,
      agentId,
      payload: JSON.stringify(payload),
      createdAt: Date.now(),
    })
  } catch (err) {
    // Already persisted (duplicate delivery of the same event) → success.
    if (isUniqueViolation(err)) return
    throw err
  }
}

/**
 * Remove the persisted event for a completed/aborted message. No-op if absent.
 *
 * Scoped to the owning Agent: deleting by message_id alone would also erase the
 * row of the *other* Agent in the same Feishu group, destroying its restart
 * recovery record the moment this Agent finished first.
 */
export async function removePendingMessage(messageId: string, agentId: string): Promise<void> {
  await db
    .delete(feishuPendingMessages)
    .where(
      and(
        eq(feishuPendingMessages.messageId, messageId),
        eq(feishuPendingMessages.agentId, agentId),
      ),
    )
}

/** List every persisted event — used by startup recovery to replay. */
export async function listPendingMessages(): Promise<FeishuPendingRow[]> {
  const rows = await db.select().from(feishuPendingMessages)
  const parsed: FeishuPendingRow[] = []
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as FeishuEventPayload
      parsed.push({
        messageId: row.messageId,
        agentId: row.agentId,
        payload,
        createdAt: row.createdAt,
      })
    } catch {
      // Corrupt row — drop it so recovery can make progress. Awaited (hence the
      // loop rather than flatMap): the delete is async, so firing it off would
      // let this function resolve — and the caller start replaying — while the
      // corrupt row is still present, and its rejection would escape unhandled.
      await removePendingMessage(row.messageId, row.agentId)
    }
  }
  return parsed
}
