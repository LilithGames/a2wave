import { eq } from 'drizzle-orm'
import { SqliteTaskStore } from '../a2a/sqlite-task-store.js'
import { db } from '../db/client.js'
import { evaluationTasks, runs, scmWorkloadLeases } from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'
import { evaluationQueueDb } from '../engine/evaluation-queue-db.js'
import { listActiveExecutionLeases } from '../engine/execution-lease-registry.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import {
  type InstanceLivenessMap,
  isInstanceOwnerDead,
  loadInstanceLiveness,
} from './instance-heartbeat.js'
import { logger } from './logger.js'
import { processInstanceId } from './process-instance.js'
import { FAILURE_REASONS } from './run-failure-reasons.js'
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
 * - An **active** lease is released when *this* instance owns it (the owner is
 *   the one process able to verify its workload is not still exiting or
 *   cleaning up), or when its owner is provably dead per the instance
 *   heartbeat: no row, a heartbeat stopped past the threshold, or a boot after
 *   the lease was activated (a reused instance id whose previous life owned
 *   it). A beating peer is never touched — a visible stuck lease is safer than
 *   reclaiming a checkout beneath a healthy replica.
 * - A **reserved** lease never had a process, so it is safe to release on any
 *   replica once its workload can no longer start — terminal status or a
 *   deleted row.
 * - Local activity always wins: terminal status cannot prove process exit,
 *   which is the entire reason the lease outlives the status.
 *
 * `failScmWorkloadsOfDeadInstances` is the companion pass for the gap the
 * terminal-only rule cannot close: a crashed replica leaves its workload
 * non-terminal forever, so nothing would ever release the lease. It fails
 * those workloads first (mirroring startup recovery's semantics), and the
 * sweep then releases the now-terminal leases.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

type MutationRunner = <T>(mutation: (tx: TransactionHandle) => Promise<T>) => Promise<T>

export interface ScmLeaseSweepDeps {
  withMutation: MutationRunner
  isWorkloadLocallyActive: (identity: ScmWorkloadIdentity) => boolean
  ownerInstanceId: string
  /** Read outside the mutation: staleness thresholds dwarf the read-to-decision gap. */
  loadLiveness: () => Promise<InstanceLivenessMap>
  now: () => Date
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
  loadLiveness: () => loadInstanceLiveness(db),
  now: () => new Date(),
}

type WorkloadStatusExecutor = Pick<TransactionHandle, 'select'>

async function isWorkloadTerminal(
  tx: WorkloadStatusExecutor,
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
  const liveness = await deps.loadLiveness()
  return deps.withMutation(async (tx) => {
    const leases = await tx.select().from(scmWorkloadLeases)
    const released: ReleasedScmWorkload[] = []
    const now = deps.now()
    for (const lease of leases) {
      if (
        lease.phase === 'active' &&
        lease.ownerInstanceId !== deps.ownerInstanceId &&
        !isLeaseOwnerDead(lease, liveness, now)
      ) {
        continue
      }
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

interface LeaseOwnership {
  ownerInstanceId: string | null
  updatedAt: Date | null
}

/**
 * An active lease without an owner id never finished activation and has no
 * process to protect. With one, the heartbeat decides; the lease's updatedAt
 * is its activation instant, which fences a reused instance id's previous
 * life. A missing updatedAt degrades to "now" — then only a stopped heartbeat
 * can prove death, never the boot-instant comparison.
 */
function isLeaseOwnerDead(
  lease: LeaseOwnership,
  liveness: InstanceLivenessMap,
  now: Date,
): boolean {
  if (!lease.ownerInstanceId) return true
  return isInstanceOwnerDead(liveness, lease.ownerInstanceId, lease.updatedAt ?? now, now)
}

// ============================================================
// Dead-instance workload reaper
// ============================================================

export interface DeadInstanceWorkloadReaperDeps {
  db: Pick<typeof db, 'select'>
  loadLiveness: () => Promise<InstanceLivenessMap>
  isWorkloadLocallyActive: (identity: ScmWorkloadIdentity) => boolean
  failRun: (runId: string) => Promise<void>
  failEvaluation: (taskId: string) => Promise<void>
  now: () => Date
}

const INSTANCE_STOPPED_EVALUATION_REASON = 'Interrupted: the owning server instance stopped'

async function failRunAbandonedByDeadInstance(runId: string): Promise<void> {
  const run = (
    await db
      .select({ triggerSource: runs.triggerSource, triggerSessionId: runs.triggerSessionId })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
  )[0]
  const reason = FAILURE_REASONS.INSTANCE_STOPPED_DURING_EXEC
  await taskQueueDb.failRunWithStructuredReason(runId, reason)
  await taskQueueDb.updateRunStatus(runId, 'failed')
  // Same contract as startup recovery: an A2A caller polling tasks/get must
  // see the failure, not a task that stays "working" forever.
  if (run?.triggerSource === 'a2a' && run.triggerSessionId) {
    await new SqliteTaskStore()
      .markTaskFailed(run.triggerSessionId, reason.message)
      .catch((error) => logger.warn({ error, runId }, 'markTaskFailed during reap failed'))
  }
}

const defaultReaperDeps: DeadInstanceWorkloadReaperDeps = {
  db,
  loadLiveness: () => loadInstanceLiveness(db),
  isWorkloadLocallyActive,
  failRun: failRunAbandonedByDeadInstance,
  failEvaluation: (taskId) =>
    evaluationQueueDb.failTask(taskId, INSTANCE_STOPPED_EVALUATION_REASON),
  now: () => new Date(),
}

export interface ReapedScmWorkload extends ScmWorkloadIdentity {
  agentId: string
}

/**
 * Fail non-terminal workloads whose owning instance is provably dead.
 *
 * A crashed replica leaves its Run 'running' (and its Evaluation 'running')
 * forever — PostgreSQL startup deliberately does not reset in-flight rows,
 * because another replica booting proves nothing about the owner. The
 * heartbeat does prove it, so any surviving replica can apply the same
 * semantics startup recovery applies on the single-process backend: mark the
 * workload failed with a retryable structured reason. The lease itself is NOT
 * released here — the sweep pass releases it once the status is terminal,
 * under the same mutation lock as every other lease decision.
 */
export async function failScmWorkloadsOfDeadInstances(
  deps: DeadInstanceWorkloadReaperDeps = defaultReaperDeps,
): Promise<ReapedScmWorkload[]> {
  const leases = await deps.db.select().from(scmWorkloadLeases)
  const activePeerLeases = leases.filter(
    (lease) => lease.phase === 'active' && lease.ownerInstanceId,
  )
  if (activePeerLeases.length === 0) return []

  const liveness = await deps.loadLiveness()
  const now = deps.now()
  const reaped: ReapedScmWorkload[] = []
  for (const lease of activePeerLeases) {
    const identity: ScmWorkloadIdentity = {
      type: lease.workloadType,
      workloadId: lease.workloadId,
    }
    if (deps.isWorkloadLocallyActive(identity)) continue
    if (!isLeaseOwnerDead(lease, liveness, now)) continue
    if (await isWorkloadTerminal(deps.db as WorkloadStatusExecutor, identity)) continue
    if (identity.type === 'run') {
      await deps.failRun(identity.workloadId)
    } else {
      await deps.failEvaluation(identity.workloadId)
    }
    reaped.push({ ...identity, agentId: lease.agentId })
  }
  return reaped
}
