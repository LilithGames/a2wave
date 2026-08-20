import { and, eq, type SQL, sql } from 'drizzle-orm'
import { runs } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { logger } from './logger.js'

/** Test seams: run a competing write around this call's read. */
export interface MergeExecutionMetadataHooks {
  beforeWrite?: () => Promise<void>
  /** Fires after the read, inside the compare-and-set window. */
  afterRead?: () => Promise<void>
}

/** Bounded so a pathologically hot row degrades to a dropped write, not a hang. */
const MAX_MERGE_ATTEMPTS = 5

/**
 * Match the row only while `execution_metadata` still holds `expected`.
 *
 * Compared as text on both dialects. `jsonb` would normalise key order and let
 * two different reads compare equal, which is exactly the aliasing a
 * compare-and-set must not have; casting both sides to text keeps the check
 * tied to the bytes actually read.
 */
function matchesMetadata(expected: unknown): SQL | undefined {
  return expected == null
    ? sql`${runs.executionMetadata} is null`
    : sql`cast(${runs.executionMetadata} as text) = ${JSON.stringify(expected)}`
}

/**
 * Merge fields into `runs.executionMetadata` without clobbering other writers.
 *
 * The column is shared: the preparation path owns `queuedTurn`,
 * `oauthPreviousChatId` and the attachment refs, and its consume-once handoff
 * deliberately *clears* them once they are materialized into a step. A writer
 * that merges onto a snapshot taken before that commit puts them back and
 * replays a user message the platform already consumed.
 *
 * A transaction alone does not prevent it: on SQLite every caller shares one
 * connection, so a concurrent write joins this transaction rather than being
 * serialised against it. Re-reading immediately before the write, and deriving
 * the update from that fresh value, is what holds on both dialects.
 *
 * `produce` receives the current metadata and returns only the fields to set,
 * so a counter increments from what is actually stored rather than from a
 * stale read.
 *
 * Returns whether a row was updated.
 */
export async function mergeExecutionMetadata(
  runId: string,
  produce: (current: Record<string, unknown>) => Record<string, unknown>,
  hooks: MergeExecutionMetadataHooks = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
    const outcome = await withTransaction(async (tx) => {
      await hooks.beforeWrite?.()

      const current = (
        await tx
          .select({ executionMetadata: runs.executionMetadata })
          .from(runs)
          .where(eq(runs.id, runId))
          .limit(1)
      )[0]
      // The run may already be finished and archived.
      if (!current) return 'gone' as const

      // The seam a competing writer commits through, reproducing the
      // PostgreSQL interleaving where both callers have their own client.
      await hooks.afterRead?.()

      const base = (current.executionMetadata ?? {}) as Record<string, unknown>
      const merged: Record<string, unknown> = { ...base }
      // An explicit `undefined` deletes the key rather than storing it. Both
      // dialects would otherwise disagree — SQLite serialises through
      // JSON.stringify, which drops it, while a jsonb column can keep a null —
      // and a consumed one-shot marker must be gone, not falsy.
      for (const [key, value] of Object.entries(produce(base))) {
        if (value === undefined) delete merged[key]
        else merged[key] = value
      }

      // Compare-and-set on the value we read. On PostgreSQL each caller holds
      // its own pooled client, so a transaction alone lets both read the same
      // metadata and the later write erase the earlier one; on SQLite the
      // shared connection lets a competing write join this transaction. A
      // conditional update is the only form that fails loudly under both, and
      // failing is what makes the retry correct.
      //
      // updatedAt is deliberately NOT bumped. The orphaned-run reaper fences on
      // it as a lower bound for "still being touched"; moving it here would let
      // metadata churn stand in for progress and shield a wedged run from
      // settlement.
      const written = await tx
        .update(runs)
        .set({ executionMetadata: merged as never })
        .where(and(eq(runs.id, runId), matchesMetadata(current.executionMetadata)))
        .returning({ id: runs.id })
      return written.length > 0 ? ('written' as const) : ('conflict' as const)
    })

    if (outcome === 'gone') return false
    if (outcome === 'written') return true
    // Lost the race; re-read and rebuild from whatever landed instead.
  }

  logger.warn({ runId }, 'merge-execution-metadata: gave up after repeated write conflicts')
  return false
}
