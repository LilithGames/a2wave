import { eq } from 'drizzle-orm'
import { runs } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'

/** Test seam: run a competing write between the read and the write. */
export interface MergeExecutionMetadataHooks {
  beforeWrite?: () => Promise<void>
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
  return await withTransaction(async (tx) => {
    const existing = (
      await tx
        .select({ executionMetadata: runs.executionMetadata })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1)
    )[0]
    // The run may already be finished and archived.
    if (!existing) return false

    await hooks.beforeWrite?.()

    const current = (
      await tx
        .select({ executionMetadata: runs.executionMetadata })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1)
    )[0]
    if (!current) return false

    const base = (current.executionMetadata ?? {}) as Record<string, unknown>
    // updatedAt is deliberately NOT bumped. The orphaned-run reaper fences on
    // it as a lower bound for "still being touched"; moving it here would let
    // metadata churn stand in for progress and shield a wedged run from
    // settlement.
    await tx
      .update(runs)
      .set({ executionMetadata: { ...base, ...produce(base) } as never })
      .where(eq(runs.id, runId))
    return true
  })
}
