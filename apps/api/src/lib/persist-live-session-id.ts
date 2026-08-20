import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import { mergeExecutionMetadata } from './merge-execution-metadata.js'

/** Metadata key holding the session a still-running run would resume from. */
export const LIVE_CHAT_ID_KEY = 'liveChatId'

/** Test seam: run a competing write between this call's read and its write. */
export interface PersistLiveSessionIdHooks {
  beforeWrite?: () => Promise<void>
}

/**
 * Record the provider session id of a run that is still executing.
 *
 * Returns whether a row was updated, so a caller streaming hundreds of lines
 * can stop retrying a run that no longer exists.
 */
export async function persistLiveSessionId(
  runId: string,
  sessionId: string,
  hooks: PersistLiveSessionIdHooks = {},
): Promise<boolean> {
  return await mergeExecutionMetadata(runId, () => ({ [LIVE_CHAT_ID_KEY]: sessionId }), hooks)
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
