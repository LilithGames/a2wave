import { eq } from 'drizzle-orm'
import { evaluationTasks, runs, scmWorkloadLeases } from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'
import { listActiveExecutionLeases } from '../engine/execution-lease-registry.js'
import { processInstanceId } from './process-instance.js'
import { withScmPathMutation } from './scm-path-plan.js'
import { isScmEvaluationWorkloadRegistered } from './scm-workload-guard.js'
import type { ScmWorkloadIdentity } from './scm-workload-lifecycle.js'

/**
 * Reclaim durable SCM workload leases whose workload is provably finished.
 *
 * The owning lifecycle retries `releaseScmWorkload` after process exit and
 * workspace cleanup. This sweep is the independent recovery path if that owner
 * disappears while a terminal lease remains.
 *
 * Release rules, deliberately narrower than "the status is terminal":
 *
 * - An **active** lease is released only when *this* instance owns it: the
 *   owner is the one process able to verify its workload is not still exiting
 *   or cleaning up. A lease owned by another instance is never touched — on
 *   PostgreSQL a peer replica may be healthy and mid-cleanup, and the
 *   invariants state a visible stuck lease is safer than reclaiming a checkout
 *   beneath a healthy peer (its startup handles its own recovery).
 * - A **reserved** lease never had a process, so it is safe to release on any
 *   replica once its workload can no longer start — terminal status or a
 *   deleted row.
 * - Local activity always wins: terminal status cannot prove process exit,
 *   which is the entire reason the lease outlives the status.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

type MutationRunner = <T>(mutation: (tx: TransactionHandle) => Promise<T>) => Promise<T>

export interface ScmLeaseSweepDeps {
  withMutation: MutationRunner
  isWorkloadLocallyActive: (identity: ScmWorkloadIdentity) => boolean
  ownerInstanceId: string
}

export interface ReleasedScmWorkload extends ScmWorkloadIdentity {
  agentId: string
}

function isWorkloadLocallyActive(identity: ScmWorkloadIdentity): boolean {
  if (identity.type === 'run') {
    return listActiveExecutionLeases().some((lease) => lease.runId === identity.workloadId)
  }
  return isScmEvaluationWorkloadRegistered(identity.workloadId)
}

const defaultDeps: ScmLeaseSweepDeps = {
  withMutation: withScmPathMutation,
  isWorkloadLocallyActive,
  ownerInstanceId: processInstanceId,
}

async function isWorkloadTerminal(
  tx: TransactionHandle,
  identity: ScmWorkloadIdentity,
): Promise<boolean> {
  const row =
    identity.type === 'run'
      ? (
          await tx
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, identity.workloadId))
            .limit(1)
        )[0]
      : (
          await tx
            .select({ status: evaluationTasks.status })
            .from(evaluationTasks)
            .where(eq(evaluationTasks.id, identity.workloadId))
            .limit(1)
        )[0]
  // A deleted workload row can never start or clean up again.
  if (!row) return true
  return TERMINAL_STATUSES.has(row.status)
}

/** @returns released identities with the executing Agent whose capacity changed. */
export async function sweepOrphanedScmWorkloadLeases(
  deps: ScmLeaseSweepDeps = defaultDeps,
): Promise<ReleasedScmWorkload[]> {
  return deps.withMutation(async (tx) => {
    const leases = await tx.select().from(scmWorkloadLeases)
    const released: ReleasedScmWorkload[] = []
    for (const lease of leases) {
      if (lease.phase === 'active' && lease.ownerInstanceId !== deps.ownerInstanceId) continue
      const identity: ScmWorkloadIdentity = {
        type: lease.workloadType,
        workloadId: lease.workloadId,
      }
      if (deps.isWorkloadLocallyActive(identity)) continue
      if (!(await isWorkloadTerminal(tx, identity))) continue
      await tx
        .delete(scmWorkloadLeases)
        .where(eq(scmWorkloadLeases.id, lease.id))
        .returning({ id: scmWorkloadLeases.id })
      released.push({ ...identity, agentId: lease.agentId })
    }
    return released
  })
}
