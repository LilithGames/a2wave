import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import { mergeExecutionMetadata } from './merge-execution-metadata.js'

/** Metadata key holding the session a still-running run would resume from. */
export const LIVE_CHAT_ID_KEY = 'liveChatId'

/**
 * Metadata key recording that this run's CLI actually started producing output.
 *
 * Recovery needs to tell two interrupted runs apart. One got far enough to
 * commit side effects — files written, messages sent, merge requests opened —
 * and must never have its prompt replayed. The other died during setup (a clone
 * or sync can run for minutes on a large repository) and has no side effects at
 * all, so failing it just makes a human re-trigger it: the same replay,
 * performed manually and later.
 *
 * `liveChatId` cannot answer this — a CLI that dies before announcing its
 * session leaves it empty either way — and `work_dir` cannot either, since only
 * the per-agent worktree path records one.
 */
export const EXECUTION_STARTED_KEY = 'executionStarted'

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
/**
 * Record that this run's CLI has begun producing output.
 *
 * Written from the same stdout tap that records the session id, so it covers
 * every engine and a newly added one cannot forget to opt in.
 */
export async function markExecutionStarted(runId: string): Promise<boolean> {
  return await mergeExecutionMetadata(runId, () => ({ [EXECUTION_STARTED_KEY]: true }))
}

export async function persistLiveSessionId(
  runId: string,
  sessionId: string,
  hooks: PersistLiveSessionIdHooks = {},
): Promise<boolean> {
  // Both facts land in one compare-and-set. Writing them separately would put
  // two concurrent merges on the same row for every run, and the loser retries
  // against a moving target for no benefit — a run that announced a session has
  // self-evidently started.
  return await mergeExecutionMetadata(
    runId,
    () => ({ [LIVE_CHAT_ID_KEY]: sessionId, [EXECUTION_STARTED_KEY]: true }),
    hooks,
  )
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
