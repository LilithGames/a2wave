import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'

/** Metadata key holding the session a still-running run would resume from. */
export const LIVE_CHAT_ID_KEY = 'liveChatId'

/** Test seam: run a competing write between this call's read and its write. */
export interface PersistLiveSessionIdHooks {
  beforeWrite?: () => Promise<void>
}

/**
 * Record the provider session id of a run that is still executing.
 *
 * Read-modify-write rather than a blind set: `executionMetadata` is shared with
 * the preparation path (`queuedTurn`, `oauthPreviousChatId`, attachments), and
 * dropping one of those fields would lose a user message.
 *
 * The merge runs inside a transaction because the same column has concurrent
 * writers. `execute-chat-run`'s consume-once handoff deliberately *clears*
 * `queuedTurn` and the attachment fields once they are materialized into a
 * step; a read taken before that commit and written after would put them back
 * and replay an already-consumed message. On PostgreSQL each caller holds its
 * own pooled client, so only a transaction — not `runExclusive` — serialises
 * this pair.
 *
 * Returns whether a row was updated, so a caller streaming hundreds of lines
 * can stop retrying a run that no longer exists.
 */
export async function persistLiveSessionId(
  runId: string,
  sessionId: string,
  hooks: PersistLiveSessionIdHooks = {},
): Promise<boolean> {
  return await withTransaction(async (tx) => {
    const existing = (
      await tx
        .select({ executionMetadata: runs.executionMetadata })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1)
    )[0]
    // The run may already be finished and archived; there is nothing to resume.
    if (!existing) return false

    await hooks.beforeWrite?.()

    // Re-read and compare-and-set. A transaction alone does not close this
    // window: on SQLite every caller shares one connection, so a concurrent
    // write joins this transaction rather than being serialised against it.
    // Re-reading immediately before the write and refusing to act on a changed
    // snapshot is the check that holds on both dialects.
    const current = (
      await tx
        .select({ executionMetadata: runs.executionMetadata })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1)
    )[0]
    if (!current) return false
    if (JSON.stringify(current.executionMetadata) !== JSON.stringify(existing.executionMetadata)) {
      // Someone else rewrote the column — most likely the consume-once handoff
      // clearing queuedTurn. Merging onto our stale snapshot would resurrect
      // what it just cleared, so rebuild from the fresh value instead.
      const merged = { ...(current.executionMetadata ?? {}), [LIVE_CHAT_ID_KEY]: sessionId }
      await tx.update(runs).set({ executionMetadata: merged }).where(eq(runs.id, runId))
      return true
    }

    const metadata = { ...(existing.executionMetadata ?? {}), [LIVE_CHAT_ID_KEY]: sessionId }
    // updatedAt is deliberately NOT bumped. The orphaned-run reaper fences on
    // it as a lower bound for "still being touched"; moving it here would let
    // CLI chatter stand in for progress and shield a wedged run from
    // settlement.
    await tx.update(runs).set({ executionMetadata: metadata }).where(eq(runs.id, runId))
    return true
  })
}

/** Read back the resume target recorded for a run, if it announced one. */
export async function readLiveSessionId(runId: string): Promise<string | null> {
  const row = (
    await db
      .select({ executionMetadata: runs.executionMetadata })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
  )[0]
  const value = (row?.executionMetadata as Record<string, unknown> | null | undefined)?.[
    LIVE_CHAT_ID_KEY
  ]
  return typeof value === 'string' && value.length > 0 ? value : null
}
