import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { SqliteTaskStore } from '../a2a/sqlite-task-store.js'
import { db } from '../db/client.js'
import {
  evaluationResults,
  evaluationTasks,
  runSteps,
  runs,
  scmWorkloadLeases,
  scmWorkspaceRemovals,
} from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'
import { listActiveExecutionLeases } from '../engine/execution-lease-registry.js'
import { writeBackgroundAudit } from './audit.js'
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
import { workspaceRemovalId } from './scm-workspace-removal.js'

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
  /**
   * Hand an orphaned ephemeral worktree to the reconciler before its lease
   * disappears. Returns false when there is nothing to reclaim.
   */
  reserveEphemeralWorktreeRemoval: (input: OrphanedWorktree) => Promise<boolean>
  now: () => Date
}

export interface OrphanedWorktree {
  scmSourceId: string
  workspaceName: string
  tx: TransactionHandle
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

/**
 * Write an unowned removal reservation for an orphaned worktree.
 *
 * `ownerInstanceId: null` is the "nobody is working on this" signal the
 * reconciler adopts on its next tick — the same handoff an owner performs when
 * its inline retries run out. Writing it on the sweep's transaction keeps the
 * mark and the lease deletion atomic: the worktree is never unprotected, since
 * the reservation lands before the lease that was protecting it disappears.
 *
 * A conflict means a removal of this worktree is already reserved, which is
 * just as good — something is already tracking it.
 */
async function reserveEphemeralWorktreeRemoval(input: OrphanedWorktree): Promise<boolean> {
  const reserved = await input.tx
    .insert(scmWorkspaceRemovals)
    .values({
      id: workspaceRemovalId(input.scmSourceId, input.workspaceName),
      scmSourceId: input.scmSourceId,
      workspaceName: input.workspaceName,
      ownerInstanceId: null,
      attemptToken: randomUUID(),
      createdAt: new Date(),
      attemptStartedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: scmWorkspaceRemovals.id })
  return reserved.length > 0
}

const defaultDeps: ScmLeaseSweepDeps = {
  withMutation: withScmPathMutation,
  isWorkloadLocallyActive,
  ownerInstanceId: processInstanceId,
  loadLiveness: (executor) => loadInstanceLiveness(executor),
  canJudgePeers: () => canJudgePeerLiveness(),
  reserveEphemeralWorktreeRemoval,
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
      // Before the lease disappears, leave a durable mark for the worktree it
      // was protecting. Only for a workload this instance did NOT own: our own
      // cleanup path already handles its worktree, and reserving here would
      // race it. A dead owner's worktree has nobody else — its finally never
      // ran, so no reservation exists for the reconciler to adopt, and neither
      // TTL cleanup (which only looks at `cleanup: 'ttl'`) nor startup
      // recovery (which only drops the row) would ever reclaim it.
      if (lease.ownerInstanceId !== deps.ownerInstanceId) {
        const workspaceName = await ephemeralWorktreeName(tx, identity)
        if (workspaceName) {
          await deps.reserveEphemeralWorktreeRemoval({
            scmSourceId: lease.scmSourceId,
            workspaceName,
            tx,
          })
        }
      }
      await tx
        .delete(scmWorkloadLeases)
        .where(eq(scmWorkloadLeases.id, lease.id))
        .returning({ id: scmWorkloadLeases.id })
      released.push({ ...identity, agentId: lease.agentId })
    }
    return released
  })
}

/**
 * The worktree an abandoned workload was using, when it is ephemeral.
 *
 * Evaluations derive it from the task id — `eval-<taskId>` is fixed by
 * `routes/evaluation.ts` and unique per task, which is exactly why leaking one
 * is unrecoverable rather than merely wasteful. Runs record their own name and
 * cleanup policy on the row; a `persistent` or `ttl` worktree is deliberately
 * left alone, since those are meant to outlive the workload.
 *
 * @returns the worktree name, or null when there is nothing to reclaim.
 */
async function ephemeralWorktreeName(
  tx: WorkloadStatusExecutor,
  identity: ScmWorkloadIdentity,
): Promise<string | null> {
  if (identity.type === 'evaluation') return `eval-${identity.workloadId}`
  const run = (
    await tx
      .select({ worktreeConfig: runs.worktreeConfig })
      .from(runs)
      .where(eq(runs.id, identity.workloadId))
      .limit(1)
  )[0]
  const config = run?.worktreeConfig
  if (!config || config.cleanup !== 'ephemeral') return null
  return config.name
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
   * Atomically claim and persist the complete database terminal state.
   * False means someone else settled the workload first. A rejection rolls the
   * status, results/steps, and Evaluation audit back together so the next tick
   * can retry instead of observing a terminal-but-incomplete workload.
   */
  claimRun: (runId: string) => Promise<boolean>
  claimEvaluation: (taskId: string) => Promise<boolean>
  /** Synchronize non-transactional external state after the Run settlement commits. */
  afterRunSettled: (runId: string) => Promise<void>
  now: () => Date
}

const INSTANCE_STOPPED_EVALUATION_REASON = 'Interrupted: the owning server instance stopped'

/** Statuses a reap may take over; anything else is already settled. */
const REAPABLE_RUN_STATUSES = ['running', 'pending', 'queued'] as const
const REAPABLE_EVALUATION_STATUSES = ['running', 'pending', 'queued'] as const

/**
 * Take ownership and settle the Run's database state in one transaction.
 *
 * `.returning()` row count is the claim result — the two drivers disagree
 * about `changes`/`rowCount`, so it is the only portable answer.
 */
async function claimRunForReap(runId: string): Promise<boolean> {
  const reason = FAILURE_REASONS.INSTANCE_STOPPED_DURING_EXEC
  return withScmPathMutation(async (tx) => {
    const claimed = await tx
      .update(runs)
      .set({ status: 'failed', result: { error: reason }, updatedAt: new Date() })
      .where(and(eq(runs.id, runId), inArray(runs.status, [...REAPABLE_RUN_STATUSES])))
      .returning({ id: runs.id })
    if (claimed.length === 0) return false
    await tx
      .update(runSteps)
      .set({ status: 'failed', output: { error: reason } })
      .where(and(eq(runSteps.runId, runId), eq(runSteps.status, 'running')))
    return true
  })
}

async function claimEvaluationForReap(taskId: string): Promise<boolean> {
  return withScmPathMutation(async (tx) => {
    const task = (
      await tx
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
    const now = new Date()
    const claimed = await tx
      .update(evaluationTasks)
      .set({
        status: 'failed',
        error: INSTANCE_STOPPED_EVALUATION_REASON,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(evaluationTasks.id, taskId),
          inArray(evaluationTasks.status, [...REAPABLE_EVALUATION_STATUSES]),
        ),
      )
      .returning({ id: evaluationTasks.id })
    if (claimed.length === 0) return false
    await tx
      .update(evaluationResults)
      .set({ status: 'failed', error: INSTANCE_STOPPED_EVALUATION_REASON, updatedAt: now })
      .where(
        and(
          eq(evaluationResults.taskId, taskId),
          inArray(evaluationResults.status, ['pending', 'running']),
        ),
      )
    await writeBackgroundAudit(
      {
        action: 'evaluation_task.execute',
        resource: 'evaluation_task',
        resourceId: taskId,
        userId: task?.userId ?? undefined,
        details: {
          agentId: task?.agentId ?? null,
          status: 'failed',
          reapedByInstance: processInstanceId,
          reason: INSTANCE_STOPPED_EVALUATION_REASON,
          casesRun: task?.summary?.total ?? null,
          providerId: task?.configSnapshot?.providerId ?? null,
          providerName: task?.configSnapshot?.providerName ?? null,
          model: task?.configSnapshot?.model ?? null,
        },
      },
      tx,
    )
    return true
  })
}

async function syncReapedRunExternalState(runId: string): Promise<void> {
  const run = (
    await db
      .select({ triggerSource: runs.triggerSource, triggerSessionId: runs.triggerSessionId })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
  )[0]
  const reason = FAILURE_REASONS.INSTANCE_STOPPED_DURING_EXEC
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
  canJudgePeers: () => canJudgePeerLiveness(),
  isWorkloadLocallyActive,
  claimRun: claimRunForReap,
  claimEvaluation: claimEvaluationForReap,
  afterRunSettled: syncReapedRunExternalState,
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
    // Re-read immediately before settlement. Current-version owners fail-stop
    // one minute before this peer-death threshold and cannot revive that old
    // ownership, but the second read still avoids acting on an unnecessarily
    // old snapshot and protects reused instance ids.
    if (!isLeaseOwnerDead(lease, await deps.loadLiveness(), deps.now())) continue
    // The settlement itself uses a status CAS, because completion or
    // cancellation may still win between the read above and the transaction.
    if (identity.type === 'run') {
      if (!(await deps.claimRun(identity.workloadId))) continue
      await deps.afterRunSettled(identity.workloadId)
    } else {
      if (!(await deps.claimEvaluation(identity.workloadId))) continue
    }
    reaped.push({ ...identity, agentId: lease.agentId })
  }
  return reaped
}
