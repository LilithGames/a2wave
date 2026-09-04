/**
 * The Run claim shared by the two dead-instance reapers.
 *
 * `scm-lease-sweeper.ts` settles the runs of a dead instance that hold an SCM
 * workload lease; `orphaned-run-reaper.ts` covers the temp-workspace runs that
 * never take one. They differ only in which statuses they may take over and
 * whether an unowned row counts — the transaction itself (the CAS, the reason
 * it records, the step settlement) is one behaviour, and two copies of it drift.
 *
 * Kept in its own module rather than on either sweeper so neither has to import
 * the other's dependency graph to claim a run.
 */

import type { RunStatus } from '@a2wave/shared'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { runSteps, runs } from '../db/schema.js'
import { FAILURE_REASONS } from './run-failure-reasons.js'
import { withScmPathMutation } from './scm-path-plan.js'

export interface ReapRunClaimScope {
  /** Statuses this pass may take over; anything else is already settled. */
  statuses: readonly RunStatus[]
  /**
   * Whether a row carrying no `ownerInstanceId` may still be claimed.
   *
   * True for a pass that also settles pending/queued rows: ownership is stamped
   * only while a run is running, so those rows legitimately carry none and an
   * equality-only fence would strand exactly them. False for a running-only
   * pass, where a NULL owner means no liveness verdict was ever made about the
   * row — and age alone must never settle one.
   */
  allowUnownedRows: boolean
}

/**
 * Take ownership and settle the Run's database state in one transaction.
 *
 * `.returning()` row count is the claim result — the two drivers disagree
 * about `changes`/`rowCount`, so it is the only portable answer.
 */
export async function claimReapableRun(
  runId: string,
  expectedOwnerInstanceId: string,
  scope: ReapRunClaimScope,
): Promise<boolean> {
  const reason = FAILURE_REASONS.INSTANCE_STOPPED_DURING_EXEC
  return withScmPathMutation(async (tx) => {
    const claimed = await tx
      .update(runs)
      .set({ status: 'failed', result: { error: reason }, updatedAt: new Date() })
      .where(
        and(
          eq(runs.id, runId),
          inArray(runs.status, [...scope.statuses]),
          // The owner fence. Status alone is an ABA check: a peer that requeued
          // and re-promoted this run leaves it 'running' again, under itself,
          // and settling it would kill live work. A mismatch is simply "another
          // replica settled it first".
          scope.allowUnownedRows
            ? or(isNull(runs.ownerInstanceId), eq(runs.ownerInstanceId, expectedOwnerInstanceId))
            : eq(runs.ownerInstanceId, expectedOwnerInstanceId),
        ),
      )
      .returning({ id: runs.id })
    if (claimed.length === 0) return false
    await tx
      .update(runSteps)
      .set({ status: 'failed', output: { error: reason } })
      .where(and(eq(runSteps.runId, runId), eq(runSteps.status, 'running')))
    return true
  })
}
