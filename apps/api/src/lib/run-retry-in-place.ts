import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'

/**
 * Retrying a failed Run on its own row.
 *
 * `POST /runs/:id/rerun` normally files a brand-new row, which is right for
 * replaying a run that *worked*: the original result must survive. For a
 * failure it is wrong in practice — the failed row stays failed forever, so a
 * Provider outage leaves a Runs list of duplicated intents where nothing
 * distinguishes "still broken" from "already recovered".
 *
 * A retry therefore reuses the row: status goes failed -> pending -> running,
 * and the new attempt lands as another `run_steps` row (execute-chat-run
 * already numbers steps by MAX(order)+1, which is how multi-turn chat reuses a
 * row today). The failed attempt is not erased — its step, its output and its
 * logs stay exactly where they were.
 */

type RunRow = typeof runs.$inferSelect
export type RunExecutionMetadata = NonNullable<RunRow['executionMetadata']>

export interface RetryMetadataOptions {
  /** Whoever pressed retry — the privilege decision is re-made for them. */
  userId?: string
  attachments?: RunExecutionMetadata['attachments']
  attachmentConsumerId?: string
  nativeChatContext?: Record<string, unknown>
  /** The queued path: the turn has not materialised into a step yet. */
  queuedTurn?: boolean
}

/**
 * The `executionMetadata` the next attempt starts from.
 *
 * Built as an ALLOWLIST rather than by deleting known-transient keys: the
 * fields here are the ones an attempt legitimately inherits, and anything
 * added to the metadata later is dropped by default. A denylist would silently
 * carry the next transient field forward the day someone adds one.
 *
 * The most consequential omission is `liveChatId` (with `resumePending` /
 * `executionStarted`): left in place, `resolveQueuedChatId` reads the failed
 * attempt's provider session, decides this is a resume, and sends a "continue
 * where you left off" prompt instead of the intent — while skipping the chat
 * message insert. The retry would look like it ran and would have asked the
 * Agent something nobody typed.
 */
export function buildRetryMetadata(
  previous: Record<string, unknown> | null | undefined,
  options: RetryMetadataOptions,
): RunExecutionMetadata & { retryAttempt: number } {
  const prior = (previous ?? {}) as RunExecutionMetadata & {
    retryAttempt?: number
    oauthCallerId?: string
  }
  const gitTriggerOrigin = prior.gitTriggerOrigin
  return {
    // A manual retry is its own chain: the automatic job-retry budget
    // (jobRetryOf / jobRetryAttempt) is deliberately not inherited.
    retryAttempt: (prior.retryAttempt ?? 0) + 1,
    ...(options.userId ? { runtimeAdminRequesterUserId: options.userId } : {}),
    // Ownership of an OAuth-triggered run: `GET`/`cancel` compare the caller
    // against this, and an ABSENT value is treated as legacy-and-readable — so
    // dropping it would widen access rather than narrow it.
    ...(prior.oauthCallerId ? { oauthCallerId: prior.oauthCallerId } : {}),
    // Which engine the original request selected; the retry replays the same
    // request, so it must select the same one.
    ...(prior.oauthEngineType ? { oauthEngineType: prior.oauthEngineType } : {}),
    // Consume-once flags that are still here BECAUSE the failed attempt never
    // spent them. The request asked for a fresh provider session; dropping the
    // ask would let the retry resume an older completed conversation instead.
    ...(prior.oauthResetSession ? { oauthResetSession: true } : {}),
    ...(prior.nativeChatResetSession ? { nativeChatResetSession: true } : {}),
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    ...(options.attachmentConsumerId ? { attachmentConsumerId: options.attachmentConsumerId } : {}),
    ...(options.nativeChatContext ? { nativeChatContext: options.nativeChatContext } : {}),
    ...(options.queuedTurn ? { queuedTurn: true } : {}),
    // Kept for provenance, but marked as dispatched: the staleness probe exists
    // to drop a queued git-trigger run whose merge request moved on, and a
    // human asking for this retry has already made that judgement. Left as
    // `queued: true` it would cancel the retry outright — turning the failure
    // record into a cancellation.
    ...(gitTriggerOrigin ? { gitTriggerOrigin: { ...gitTriggerOrigin, queued: false } } : {}),
  }
}

/**
 * Claims a failed run for re-execution; false means someone got there first.
 *
 * The CAS on `status = 'failed'` is the whole concurrency story: a double click,
 * two operators on the same page, or a bulk retry overlapping a single one all
 * resolve to exactly one claim. `pending` is the intermediate on purpose — it
 * is the one state startup recovery can settle if the process dies between
 * this claim and queue admission, whereas a row parked in `queued` with no
 * queue entry would sit there forever.
 */
export async function claimRunForRetry(
  runId: string,
  metadata: RunExecutionMetadata,
): Promise<boolean> {
  // `.returning()` rather than a driver row count: better-sqlite3 reports
  // `changes` and node-postgres `rowCount`, so only the returned rows mean the
  // same thing on both backends.
  const claimed = await db
    .update(runs)
    .set({
      status: 'pending',
      // The previous attempt's error, and with it `result.chatId` — which is
      // what would otherwise resume the failed provider session.
      result: null,
      // Re-resolved by the next attempt; a stale value collides with the
      // workspace-occupancy check.
      workDir: null,
      // Re-stamped at admission. A stale owner matches the reaper's
      // dead-instance predicate.
      ownerInstanceId: null,
      // This attempt's wait starts at its own admission.
      queuedAt: null,
      executionMetadata: metadata,
      updatedAt: new Date(),
    })
    .where(and(eq(runs.id, runId), eq(runs.status, 'failed')))
    .returning({ id: runs.id })

  return claimed.length === 1
}

/**
 * Puts a claimed run back the way it was.
 *
 * Used when admission is refused after the claim (a full queue): without this
 * the row is stranded in `pending` with no queue entry and no error, i.e. the
 * operator's failure record silently disappears.
 */
export async function restoreFailedRun(previous: RunRow): Promise<void> {
  await db
    .update(runs)
    .set({
      status: 'failed',
      result: previous.result,
      workDir: previous.workDir,
      ownerInstanceId: previous.ownerInstanceId,
      queuedAt: previous.queuedAt,
      executionMetadata: previous.executionMetadata,
      updatedAt: new Date(),
    })
    .where(eq(runs.id, previous.id))
}
