import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import type { db } from '../db/client.js'
import { runs, scmSources, scmWorkloadLeases, scmWorkspaceRemovals } from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'
import { defaultWorkspacesPath } from './git-workspace.js'
import { hasLostHeartbeatOwnership } from './instance-heartbeat.js'
import { logger } from './logger.js'
import { processInstanceId } from './process-instance.js'
import { withScmPathMutation } from './scm-path-plan.js'
import {
  type OwnedScmWorkload,
  type ScmWorkloadIdentity,
  scmWorkloadLeaseId,
} from './scm-workload-lifecycle.js'
import { retryWorkspaceCleanup, WorkspaceCleanupExhaustedError } from './workspace-cleanup-retry.js'
import { WorkspaceRemovalHandedOffError } from './workspace-removal-outcome.js'

/**
 * The single protocol for removing a source's worktree.
 *
 * Worktree lifecycle needs a durable, cross-replica arbitration primitive: an
 * in-process mutex cannot stop another PostgreSQL replica from admitting a
 * workload and creating or reusing the very worktree this replica is deleting.
 * The durable workload lease covers one direction (a workload marks itself
 * before creating); the reservation row written here covers the other (a
 * remover marks itself before deleting). Both marks are committed under the
 * SCM mutation lock BEFORE their action, so the lock's total order guarantees
 * any interleaving observes at least one of them:
 *
 * - Workload admitted before the remover's re-check commits → its lease is
 *   visible → the removal aborts (a NULL `workDir` blocks every worktree of
 *   the source, because that run has not chosen its directory yet).
 * - Workload admitted after → its creation path runs later still, reads the
 *   already-committed reservation, and refuses to create.
 *
 * Every remover goes through this module (manual route, TTL/LRU cleanup, and
 * ephemeral Run/Evaluation cleanup); every counter-party — worktree creation,
 * run admission of an explicitly named worktree, path PATCH, source DELETE,
 * env bootstrap — consults `findPendingWorkspaceRemoval`.
 *
 * A crash can leak a reservation. SQLite can prove the previous owner is gone
 * and clears rows before listening on restart. PostgreSQL cannot infer that a
 * peer's filesystem operation stopped from age alone, so it retains uncertain
 * rows rather than reopening the destructive race.
 */

type QueryExecutor = Pick<typeof db, 'select'>

interface PendingReservationRelease {
  reservationId: string
  attemptToken: string
}

const pendingReservationReleases = new Map<string, PendingReservationRelease>()
const pendingReservationHandoffs = new Map<string, PendingReservationRelease>()
const RESERVATION_RELEASE_RETRY_DELAY_MS = 100

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class WorkspaceRemovalBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceRemovalBlockedError'
  }
}

export { WorkspaceRemovalHandedOffError } from './workspace-removal-outcome.js'

/** How the removal target sees the source; also the snapshot the re-check pins. */
export interface RemovableScmWorkspace {
  localPath: string
  wsRoot: string
  removeWorkspace(
    name: string,
    options?: { beforeRemove?: () => Promise<void>; keepBranches?: boolean },
  ): Promise<void>
}

export function workspaceRemovalId(sourceId: string, name: string): string {
  return `${sourceId}:${name}`
}

/** A pending reservation on the source (optionally for one specific name). */
export async function findPendingWorkspaceRemoval(
  executor: QueryExecutor,
  sourceId: string,
  name?: string,
): Promise<{ id: string; workspaceName: string } | null> {
  const row = (
    await executor
      .select({ id: scmWorkspaceRemovals.id, workspaceName: scmWorkspaceRemovals.workspaceName })
      .from(scmWorkspaceRemovals)
      .where(
        name === undefined
          ? eq(scmWorkspaceRemovals.scmSourceId, sourceId)
          : eq(scmWorkspaceRemovals.id, workspaceRemovalId(sourceId, name)),
      )
      .limit(1)
  )[0]
  return row ?? null
}

/**
 * The one authoritative "may this worktree be removed right now" decision.
 * Returns the blocking reason, or null when removal may proceed.
 */
export async function findWorkspaceRemovalBlocker(
  tx: TransactionHandle,
  sourceId: string,
  scm: Pick<RemovableScmWorkspace, 'localPath' | 'wsRoot'>,
  name: string,
  excludingWorkload?: ScmWorkloadIdentity,
): Promise<string | null> {
  const wsPath = join(scm.wsRoot, name)

  // The row must still exist with the paths the removal target was built
  // from. A deletion reservation or a concurrent path PATCH means this wsPath
  // may no longer belong to the source — a freed root could even have been
  // claimed by another source, whose worktree this removal must not touch.
  // (The registered-worktree assertion in removeGitWorkspace is the
  // filesystem-level backstop for the same rule.)
  const current = (
    await tx
      .select({ localPath: scmSources.localPath, workspacesPath: scmSources.workspacesPath })
      .from(scmSources)
      .where(and(eq(scmSources.id, sourceId), isNull(scmSources.deletionRequestedAt)))
      .limit(1)
  )[0]
  if (!current) return 'SCM source is no longer available'
  const currentWsRoot = current.workspacesPath ?? defaultWorkspacesPath(sourceId)
  if (current.localPath !== scm.localPath || currentWsRoot !== scm.wsRoot) {
    return 'SCM source paths changed while removing the workspace; retry'
  }

  // Occupied by a run the status machine still tracks.
  const occupancyFilter =
    excludingWorkload?.type === 'run'
      ? and(
          eq(runs.workDir, wsPath),
          inArray(runs.status, ['running', 'pending', 'queued']),
          ne(runs.id, excludingWorkload.workloadId),
        )
      : and(eq(runs.workDir, wsPath), inArray(runs.status, ['running', 'pending', 'queued']))
  const occupied = (await tx.select({ id: runs.id }).from(runs).where(occupancyFilter).limit(1))[0]
  if (occupied) return 'Workspace is occupied by a running or pending run'

  // The run-status check above cannot see two occupants the durable lease
  // can: an Evaluation (which writes no `runs` row at all — its
  // `eval-<taskId>` worktree is a legal deletable name here) and a Run whose
  // status is already terminal but whose process/cleanup still holds the
  // directory. The lease is authoritative until released after cleanup.
  const leases = await tx
    .select({
      workloadType: scmWorkloadLeases.workloadType,
      workloadId: scmWorkloadLeases.workloadId,
    })
    .from(scmWorkloadLeases)
    .where(eq(scmWorkloadLeases.scmSourceId, sourceId))
  const relevantLeases = leases.filter(
    (lease) =>
      lease.workloadType !== excludingWorkload?.type ||
      lease.workloadId !== excludingWorkload.workloadId,
  )
  const leasedEvaluation = relevantLeases.find(
    (lease) => lease.workloadType === 'evaluation' && name === `eval-${lease.workloadId}`,
  )
  if (leasedEvaluation) return 'Workspace is occupied by a running evaluation'
  const leasedRunIds = relevantLeases
    .filter((lease) => lease.workloadType === 'run')
    .map((lease) => lease.workloadId)
  if (leasedRunIds.length > 0) {
    const leasedRuns = await tx
      .select({ id: runs.id, workDir: runs.workDir })
      .from(runs)
      .where(inArray(runs.id, leasedRunIds))
    // A NULL workDir is the admission-to-resolveWorkDir window: the run is
    // leased but has not chosen its worktree yet, so it may legally resolve
    // to this very name. Refusing is the only safe answer until it commits
    // to a directory. (A lease whose run row is gone entirely matches the
    // stale-lease sweeper's release condition and does not block.)
    const blockingRun = leasedRuns.find((run) => run.workDir === wsPath || run.workDir == null)
    if (blockingRun) {
      return blockingRun.workDir == null
        ? 'Workspace may be claimed by an admitted run that has not started yet'
        : 'Workspace is occupied by a run that has not finished cleanup'
    }
  }
  return null
}

/**
 * Remove one worktree under the full protocol:
 *
 *   1. One SCM mutation transaction runs the occupancy decision and — only
 *      when it passes — commits the durable removal reservation. No I/O.
 *   2. The removal itself runs outside any DB transaction, inside the
 *      per-worktree mutex, with a `beforeRemove` re-check immediately ahead
 *      of the filesystem work.
 *   3. The reservation is released in `finally`; SQLite clears a crash leak
 *      before listening on restart, while PostgreSQL fails closed.
 *
 * Throws `WorkspaceRemovalBlockedError` when the worktree is (or became)
 * occupied, or when a removal of the same worktree is already in progress.
 */
interface GuardedRemovalInput {
  sourceId: string
  name: string
  scm: RemovableScmWorkspace
  ownedWorkload?: OwnedScmWorkload
  /**
   * Preserve the worktree's branch. Required for a per-Agent worktree: it is
   * long-lived and runs on its own branch, so that branch can be the only copy
   * of commits an earlier run never pushed. Reclaiming the directory is fine;
   * deleting the ref is data loss.
   */
  keepBranches?: boolean
}

async function validateOwnedCleanup(
  tx: TransactionHandle,
  sourceId: string,
  workload: OwnedScmWorkload,
): Promise<ScmWorkloadIdentity> {
  if (workload.ownerInstanceId !== processInstanceId) {
    throw new WorkspaceRemovalBlockedError('Workspace cleanup is owned by another process instance')
  }
  const lease = (
    await tx
      .select({ id: scmWorkloadLeases.id })
      .from(scmWorkloadLeases)
      .where(
        and(
          eq(scmWorkloadLeases.id, scmWorkloadLeaseId(workload)),
          eq(scmWorkloadLeases.scmSourceId, sourceId),
          eq(scmWorkloadLeases.phase, 'active'),
          eq(scmWorkloadLeases.ownerInstanceId, workload.ownerInstanceId),
        ),
      )
      .limit(1)
  )[0]
  if (!lease) {
    throw new WorkspaceRemovalBlockedError('Workspace cleanup no longer owns an active workload')
  }
  return { type: workload.type, workloadId: workload.workloadId }
}

async function removeSourceWorkspaceGuardedCore(input: GuardedRemovalInput): Promise<void> {
  const { sourceId, name, scm, ownedWorkload, keepBranches } = input
  // Keep target identity stable across migrated rows. Mixed-version writers
  // are unsupported because a pre-token finalizer can still delete by id alone;
  // the independent attempt token fences current-version ABA replacement.
  // A fenced instance must not delete a worktree: peers are already entitled
  // to reclaim its workspaces, and `--force` removing one they may have taken
  // over is the most destructive thing this module can do. Checked before the
  // reservation so a fenced process leaves no mark behind either.
  if (hasLostHeartbeatOwnership()) {
    throw new WorkspaceRemovalBlockedError(
      'This instance lost its liveness lease and is no longer removing workspaces',
    )
  }
  const reservationId = workspaceRemovalId(sourceId, name)
  const attemptToken = randomUUID()
  // Set when inline cleanup gave up and the reservation was left for the
  // reconciler; the `finally` release must then not run.
  let handedOff = false

  await withScmPathMutation(async (tx) => {
    const excludingWorkload = ownedWorkload
      ? await validateOwnedCleanup(tx, sourceId, ownedWorkload)
      : undefined
    const blocked = await findWorkspaceRemovalBlocker(tx, sourceId, scm, name, excludingWorkload)
    if (blocked) throw new WorkspaceRemovalBlockedError(blocked)
    const reserved = await tx
      .insert(scmWorkspaceRemovals)
      .values({
        id: reservationId,
        scmSourceId: sourceId,
        workspaceName: name,
        ownerInstanceId: processInstanceId,
        attemptToken,
        createdAt: new Date(),
        attemptStartedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: scmWorkspaceRemovals.id })
    if (reserved.length === 0) {
      throw new WorkspaceRemovalBlockedError('A removal of this workspace is already in progress')
    }
  })

  try {
    const remove = () =>
      scm.removeWorkspace(name, {
        keepBranches,
        beforeRemove: async () => {
          const blocked = await withScmPathMutation(async (tx) => {
            const excludingWorkload = ownedWorkload
              ? await validateOwnedCleanup(tx, sourceId, ownedWorkload)
              : undefined
            return findWorkspaceRemovalBlocker(tx, sourceId, scm, name, excludingWorkload)
          })
          if (blocked) throw new WorkspaceRemovalBlockedError(blocked)
        },
      })
    if (ownedWorkload) {
      // Keep the reservation continuously visible between retries. Releasing
      // it after a failed attempt would let a maxConcurrency>1 peer reuse this
      // terminal workload's path before cleanup tries again.
      try {
        await retryWorkspaceCleanup(remove, {
          context: {
            type: ownedWorkload.type,
            workloadId: ownedWorkload.workloadId,
            sourceId,
            workspaceName: name,
          },
        })
      } catch (error) {
        if (!(error instanceof WorkspaceCleanupExhaustedError)) throw error
        // Hand the reservation off instead of holding a slot open forever: the
        // row keeps blocking this worktree and its source, and the reconciler
        // adopts it on a later tick.
        //
        // Either way the `finally` release is skipped. The worktree is still
        // on disk, so releasing would reopen the very race the reservation
        // prevents — and if the handoff write itself failed, the row simply
        // keeps naming this instance and the reconciler adopts it once this
        // instance stops beating.
        // Set before attempting the write: the worktree is on disk either way,
        // so the `finally` must not release regardless of how the handoff goes.
        handedOff = true
        await disownOrQueueRetry({ reservationId, attemptToken })
        // Raised only here, past the committed reservation, so callers can
        // distinguish "a durable mark now guards this worktree" from any
        // earlier failure that left no mark at all.
        throw new WorkspaceRemovalHandedOffError(reservationId, { cause: error })
      }
    } else {
      // Manual DELETE and TTL/LRU cleanup: one attempt, no inline retry — the
      // caller is a request or a sweep tick, neither of which should block on
      // a busy worktree. A failure still leaves the worktree on disk, so the
      // reservation is handed to the reconciler rather than released; the
      // error propagates so the route still answers honestly.
      try {
        await remove()
      } catch (error) {
        if (error instanceof WorkspaceRemovalBlockedError) throw error
        handedOff = true
        await disownOrQueueRetry({ reservationId, attemptToken })
        throw error
      }
    }
  } finally {
    // Release even when the removal failed: the reservation only needs to
    // span the attempt. If this delete fails, leaving the row is safer than
    // guessing that filesystem removal stopped and reopening the race.
    // A handed-off reservation is deliberately NOT released — it now belongs
    // to the reconciler.
    if (!handedOff) {
      await releaseWorkspaceRemovalReservation({ reservationId, attemptToken }).catch((error) => {
        pendingReservationReleases.set(reservationId, { reservationId, attemptToken })
        logger.error(
          { error, reservationId },
          'Failed to release workspace removal reservation; queued an exact-attempt retry',
        )
      })
    }
  }
}

/**
 * Give up ownership of a reservation without releasing it.
 *
 * NULLing the owner is the explicit "nobody is working on this" signal the
 * reconciler adopts on its next tick. The token predicate fences the same ABA
 * case release does: a delayed handoff must not disown a newer attempt on the
 * same target.
 *
 * @returns whether the row was actually disowned; false means it was gone or
 * already superseded, which needs no action either way.
 */
export async function handOffWorkspaceRemoval(
  pending: PendingReservationRelease,
): Promise<boolean> {
  return withScmPathMutation(async (tx) => {
    const updated = await tx
      .update(scmWorkspaceRemovals)
      .set({ ownerInstanceId: null })
      .where(
        and(
          eq(scmWorkspaceRemovals.id, pending.reservationId),
          eq(scmWorkspaceRemovals.attemptToken, pending.attemptToken),
        ),
      )
      .returning({ id: scmWorkspaceRemovals.id })
    return updated.length > 0
  })
}

/**
 * Queue a failed handoff for the sweeper to retry.
 *
 * Deliberately the caller's decision rather than something
 * `handOffWorkspaceRemoval` does for itself. A caller that falls back to
 * releasing the reservation has already resolved the row, and queueing a
 * retry there would leave the protocol saying two contradictory things about
 * one failed attempt: "disown this later" and "already deleted".
 */
function queueWorkspaceRemovalHandoff(pending: PendingReservationRelease): void {
  pendingReservationHandoffs.set(pending.reservationId, pending)
}

/**
 * Disown a reservation, queueing a retry if the write fails.
 *
 * Never throws: the caller has already decided to hand this worktree over and
 * is about to report the original removal failure. A failed disown only means
 * the row still names this instance — the reconciler adopts it anyway once
 * this instance stops beating, and the sweeper retries the disown before then.
 */
async function disownOrQueueRetry(pending: PendingReservationRelease): Promise<void> {
  try {
    await handOffWorkspaceRemoval(pending)
  } catch (error) {
    queueWorkspaceRemovalHandoff(pending)
    logger.error(
      { error, reservationId: pending.reservationId },
      'Failed to hand off a workspace removal reservation; queued an exact-attempt retry',
    )
  }
}

async function releaseWorkspaceRemovalReservation(
  pending: PendingReservationRelease,
): Promise<void> {
  await withScmPathMutation(async (tx) => {
    await tx
      .delete(scmWorkspaceRemovals)
      .where(
        and(
          eq(scmWorkspaceRemovals.id, pending.reservationId),
          eq(scmWorkspaceRemovals.attemptToken, pending.attemptToken),
        ),
      )
      .returning({ id: scmWorkspaceRemovals.id })
  })
}

/** Retry this process's failed reservation writes, always fenced by exact attempt token. */
export async function retryPendingWorkspaceRemovalReleases(): Promise<string[]> {
  const settled = new Set<string>()
  for (const [reservationId, pending] of [...pendingReservationReleases]) {
    try {
      await releaseWorkspaceRemovalReservation(pending)
      // A zero-row delete means the exact attempt no longer exists (for
      // example, an operator recovered it); either way this retry is complete.
      if (pendingReservationReleases.get(reservationId)?.attemptToken === pending.attemptToken) {
        pendingReservationReleases.delete(reservationId)
      }
      settled.add(reservationId)
    } catch (error) {
      logger.error({ error, reservationId }, 'Workspace removal reservation release retry failed')
    }
  }
  for (const [reservationId, pending] of [...pendingReservationHandoffs]) {
    try {
      await handOffWorkspaceRemoval(pending)
      if (pendingReservationHandoffs.get(reservationId)?.attemptToken === pending.attemptToken) {
        pendingReservationHandoffs.delete(reservationId)
      }
      settled.add(reservationId)
    } catch (error) {
      logger.error({ error, reservationId }, 'Workspace removal reservation handoff retry failed')
    }
  }
  return [...settled]
}

/** Keep retrying this process's fenced reservation writes before DB shutdown. */
export async function drainPendingWorkspaceRemovalReleases(): Promise<void> {
  while (pendingReservationReleases.size > 0 || pendingReservationHandoffs.size > 0) {
    await retryPendingWorkspaceRemovalReleases()
    if (pendingReservationReleases.size > 0 || pendingReservationHandoffs.size > 0) {
      await delay(RESERVATION_RELEASE_RETRY_DELAY_MS)
    }
  }
}

export function removeSourceWorkspaceGuarded(
  input: Omit<GuardedRemovalInput, 'ownedWorkload'>,
): Promise<void> {
  return removeSourceWorkspaceGuardedCore(input)
}

/** Remove the ephemeral workspace owned by this process's active workload. */
export function removeOwnedSourceWorkspaceGuarded(
  input: Omit<GuardedRemovalInput, 'ownedWorkload'> & { workload: OwnedScmWorkload },
): Promise<void> {
  const { workload, ...removal } = input
  return removeSourceWorkspaceGuardedCore({ ...removal, ownedWorkload: workload })
}

/**
 * Single-process (SQLite) startup: no previous removal can still be running,
 * so every reservation is a leak from the dead process. PostgreSQL replicas
 * must NOT do this — a peer may be mid-removal — and retain uncertain rows.
 */
export async function clearWorkspaceRemovalsOnStartup(): Promise<number> {
  return withScmPathMutation(async (tx) => {
    const cleared = await tx.delete(scmWorkspaceRemovals).returning({ id: scmWorkspaceRemovals.id })
    return cleared.length
  })
}
