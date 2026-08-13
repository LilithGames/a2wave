import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import type { db } from '../db/client.js'
import { runs, scmSources, scmWorkloadLeases, scmWorkspaceRemovals } from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'
import { defaultWorkspacesPath } from './git-workspace.js'
import { logger } from './logger.js'
import { processInstanceId } from './process-instance.js'
import { withScmPathMutation } from './scm-path-plan.js'
import {
  type OwnedScmWorkload,
  type ScmWorkloadIdentity,
  scmWorkloadLeaseId,
} from './scm-workload-lifecycle.js'
import { retryWorkspaceCleanupUntilSuccess } from './workspace-cleanup-retry.js'

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

/** How the removal target sees the source; also the snapshot the re-check pins. */
export interface RemovableScmWorkspace {
  localPath: string
  wsRoot: string
  removeWorkspace(name: string, options?: { beforeRemove?: () => Promise<void> }): Promise<void>
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
  const { sourceId, name, scm, ownedWorkload } = input
  // Keep target identity stable across migrated rows. Mixed-version writers
  // are unsupported because a pre-token finalizer can still delete by id alone;
  // the independent attempt token fences current-version ABA replacement.
  const reservationId = workspaceRemovalId(sourceId, name)
  const attemptToken = randomUUID()

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
      await retryWorkspaceCleanupUntilSuccess(remove, {
        context: {
          type: ownedWorkload.type,
          workloadId: ownedWorkload.workloadId,
          sourceId,
          workspaceName: name,
        },
      })
    } else {
      await remove()
    }
  } finally {
    // Release even when the removal failed: the reservation only needs to
    // span the attempt. If this delete fails, leaving the row is safer than
    // guessing that filesystem removal stopped and reopening the race.
    await releaseWorkspaceRemovalReservation({ reservationId, attemptToken }).catch((error) => {
      pendingReservationReleases.set(reservationId, { reservationId, attemptToken })
      logger.error(
        { error, reservationId },
        'Failed to release workspace removal reservation; queued an exact-attempt retry',
      )
    })
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

/** Retry only releases this process actually attempted and fence every delete by attempt token. */
export async function retryPendingWorkspaceRemovalReleases(): Promise<string[]> {
  const released: string[] = []
  for (const [reservationId, pending] of [...pendingReservationReleases]) {
    try {
      await releaseWorkspaceRemovalReservation(pending)
      // A zero-row delete means the exact attempt no longer exists (for
      // example, an operator recovered it); either way this retry is complete.
      if (pendingReservationReleases.get(reservationId)?.attemptToken === pending.attemptToken) {
        pendingReservationReleases.delete(reservationId)
      }
      released.push(reservationId)
    } catch (error) {
      logger.error({ error, reservationId }, 'Workspace removal reservation release retry failed')
    }
  }
  return released
}

/** Keep retrying this process's fenced releases until shutdown can close the DB safely. */
export async function drainPendingWorkspaceRemovalReleases(): Promise<void> {
  while (pendingReservationReleases.size > 0) {
    await retryPendingWorkspaceRemovalReleases()
    if (pendingReservationReleases.size > 0) {
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
