import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'

/** Metadata key holding the session a still-running run would resume from. */
export const LIVE_CHAT_ID_KEY = 'liveChatId'

/**
 * Record the provider session id of a run that is still executing.
 *
 * Read-modify-write rather than a blind set: `executionMetadata` is shared
 * with the preparation path (`queuedTurn`, `oauthPreviousChatId`,
 * attachments), and dropping one of those fields would lose a user message.
 */
export async function persistLiveSessionId(runId: string, sessionId: string): Promise<void> {
  const existing = (
    await db
      .select({ executionMetadata: runs.executionMetadata })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
  )[0]
  // The run may already be finished and archived; there is nothing to resume.
  if (!existing) return

  const metadata = { ...(existing.executionMetadata ?? {}), [LIVE_CHAT_ID_KEY]: sessionId }
  // updatedAt is deliberately NOT bumped. The orphaned-run reaper fences on it
  // as a lower bound for "still being touched"; moving it here would let CLI
  // chatter stand in for progress and shield a wedged run from settlement.
  await db.update(runs).set({ executionMetadata: metadata }).where(eq(runs.id, runId))
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
