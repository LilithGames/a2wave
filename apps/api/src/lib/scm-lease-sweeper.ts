import { and, eq, inArray } from 'drizzle-orm'
import { SqliteTaskStore } from '../a2a/sqlite-task-store.js'
import { db } from '../db/client.js'
import { evaluationTasks, runs, scmWorkloadLeases } from '../db/schema.js'
import { type TransactionHandle, runExclusive } from '../db/transaction.js'
import { evaluationQueueDb } from '../engine/evaluation-queue-db.js'
import { listActiveExecutionLeases } from '../engine/execution-lease-registry.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { logBackgroundAudit } from './audit.js'
import {
  type InstanceLivenessMap,
  canJudgePeerLiveness,
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
  /**
   * Read **inside** the mutation, on the same executor as the delete.
   *
   * An out-of-transaction snapshot is a check-then-act: the owner can resume
   * beating between the read and the delete, and the sweep would then reclaim
   * a lease whose owner is demonstrably alive. Reading under the same lock
   * that serialises every lease decision makes the verdict and the delete one
   * atomic step.
   */
  loadLiveness: (executor: WorkloadStatusExecutor) => Promise<InstanceLivenessMap>
  /** False during the post-boot grace window, when an empty table means nothing. */
  canJudgePeers: () => boolean
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
  loadLiveness: (executor) => loadInstanceLiveness(executor),
  canJudgePeers: () => canJudgePeerLiveness(),
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
  const canJudgePeers = deps.canJudgePeers()
  return deps.withMutation(async (tx) => {
    // Inside the mutation, so a peer that resumes beating cannot slip between
    // the liveness verdict and the delete that acts on it.
    const liveness = canJudgePeers ? await deps.loadLiveness(tx) : new Map()
    const leases = await tx.select().from(scmWorkloadLeases)
    const released: ReleasedScmWorkload[] = []
    const now = deps.now()
    for (const lease of leases) {
      // Own leases are always judgeable — no heartbeat needed to know this
      // process is alive. Peer leases wait out the post-boot grace window.
      if (
        lease.phase === 'active' &&
        lease.ownerInstanceId !== deps.ownerInstanceId &&
        (!canJudgePeers || !isLeaseOwnerDead(lease, liveness, now))
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
  canJudgePeers: () => boolean
  isWorkloadLocallyActive: (identity: ScmWorkloadIdentity) => boolean
  /**
   * Claim the terminal transition by compare-and-set on the current status.
   * False means someone else settled the workload first, and this reap must
   * not proceed — the status read that selected this workload happened before
   * the write, so a concurrent completion or cancellation can land in between.
   */
  claimRun: (runId: string) => Promise<boolean>
  claimEvaluation: (taskId: string) => Promise<boolean>
  failRun: (runId: string) => Promise<void>
  failEvaluation: (taskId: string) => Promise<void>
  now: () => Date
}

const INSTANCE_STOPPED_EVALUATION_REASON = 'Interrupted: the owning server instance stopped'

/** Statuses a reap may take over; anything else is already settled. */
const REAPABLE_RUN_STATUSES = ['running', 'pending', 'queued'] as const
const REAPABLE_EVALUATION_STATUSES = ['running', 'pending', 'queued'] as const

/**
 * Take ownership of the terminal transition, in one predicated write.
 *
 * `.returning()` row count is the claim result — the two drivers disagree
 * about `changes`/`rowCount`, so it is the only portable answer.
 */
async function claimRunForReap(runId: string): Promise<boolean> {
  const claimed = await runExclusive(() =>
    db
      .update(runs)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(and(eq(runs.id, runId), inArray(runs.status, [...REAPABLE_RUN_STATUSES])))
      .returning({ id: runs.id }),
  )
  return claimed.length > 0
}

async function claimEvaluationForReap(taskId: string): Promise<boolean> {
  const claimed = await runExclusive(() =>
    db
      .update(evaluationTasks)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(
        and(
          eq(evaluationTasks.id, taskId),
          inArray(evaluationTasks.status, [...REAPABLE_EVALUATION_STATUSES]),
        ),
      )
      .returning({ id: evaluationTasks.id }),
  )
  return claimed.length > 0
}

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

/**
 * Settle a reaped evaluation and record the spend.
 *
 * Every terminal path of an evaluation owes an `evaluation_task.execute` audit
 * entry — evaluations deliberately write no `runs` rows, so that entry is the
 * only record the work happened at all (Iron Rule 5, via the Evaluation
 * carve-out). A reap is a terminal path like any other, and settling one
 * silently would leave a task that consumed provider tokens with no trace.
 */
async function failEvaluationAbandonedByDeadInstance(taskId: string): Promise<void> {
  await evaluationQueueDb.failTask(taskId, INSTANCE_STOPPED_EVALUATION_REASON)
  const task = (
    await db
      .select({
        agentId: evaluationTasks.agentId,
        userId: evaluationTasks.userId,
        configSnapshot: evaluationTasks.configSnapshot,
        summary: evaluationTasks.summary,
      })
      .from(evaluationTasks)
      .where(eq(evaluationTasks.id, taskId))
      .limit(1)
  )[0]
  logBackgroundAudit({
    action: 'evaluation_task.execute',
    resource: 'evaluation_task',
    resourceId: taskId,
    userId: task?.userId ?? undefined,
    details: {
      agentId: task?.agentId ?? null,
      status: 'failed',
      reapedByInstance: processInstanceId,
      reason: INSTANCE_STOPPED_EVALUATION_REASON,
      // The in-process tally died with the owner, so volume is reported from
      // the persisted summary — what the dead instance had finished and
      // recorded — rather than guessed.
      casesRun: task?.summary?.total ?? null,
      // The frozen config these calls ran on — never credentials.
      providerId: task?.configSnapshot?.providerId ?? null,
      providerName: task?.configSnapshot?.providerName ?? null,
      model: task?.configSnapshot?.model ?? null,
    },
  })
}

const defaultReaperDeps: DeadInstanceWorkloadReaperDeps = {
  db,
  loadLiveness: () => loadInstanceLiveness(db),
  canJudgePeers: () => canJudgePeerLiveness(),
  isWorkloadLocallyActive,
  claimRun: claimRunForReap,
  claimEvaluation: claimEvaluationForReap,
  failRun: failRunAbandonedByDeadInstance,
  failEvaluation: failEvaluationAbandonedByDeadInstance,
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
  // Nothing here is judgeable during the post-boot grace window: every peer
  // that has not yet written its first heartbeat would look dead.
  if (!deps.canJudgePeers()) return []
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
    // Re-read liveness immediately before the write. The snapshot above was
    // taken before the per-workload status queries, and a peer resuming its
    // heartbeat in that window must cancel the reap — failing a live owner's
    // workload is exactly the outcome the heartbeat exists to prevent.
    if (!isLeaseOwnerDead(lease, await deps.loadLiveness(), deps.now())) continue
    // Claim before writing: the terminal check above is a read, and the owner
    // process (or a cancel request) can settle the row in the window that
    // follows. Without the claim this would overwrite a genuine completion
    // with a synthetic failure.
    if (identity.type === 'run') {
      if (!(await deps.claimRun(identity.workloadId))) continue
      await deps.failRun(identity.workloadId)
    } else {
      if (!(await deps.claimEvaluation(identity.workloadId))) continue
      await deps.failEvaluation(identity.workloadId)
    }
    reaped.push({ ...identity, agentId: lease.agentId })
  }
  return reaped
}
