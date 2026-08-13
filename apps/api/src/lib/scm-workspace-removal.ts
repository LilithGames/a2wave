import { join } from 'node:path'
import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import type { db } from '../db/client.js'
import { runs, scmSources, scmWorkloadLeases, scmWorkspaceRemovals } from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'
import { defaultWorkspacesPath } from './git-workspace.js'
import { logger } from './logger.js'
import { processInstanceId } from './process-instance.js'
import { withScmPathMutation } from './scm-path-plan.js'

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
 * Every remover goes through `removeSourceWorkspaceGuarded` (the manual route
 * and TTL/LRU cleanup both); every counter-party — worktree creation, run
 * admission of an explicitly named worktree, path PATCH, source DELETE, env
 * bootstrap — consults `findPendingWorkspaceRemoval`.
 *
 * Reservations are transient, bounded by the removal's own git timeouts. A
 * crash can leak one; recovery is by age (`sweepStaleWorkspaceRemovals`) and,
 * on the single-process SQLite backend, a wholesale clear at startup.
 */

type QueryExecutor = Pick<typeof db, 'select'>

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
  const occupied = (
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.workDir, wsPath), inArray(runs.status, ['running', 'pending', 'queued'])))
      .limit(1)
  )[0]
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
  const leasedEvaluation = leases.find(
    (lease) => lease.workloadType === 'evaluation' && name === `eval-${lease.workloadId}`,
  )
  if (leasedEvaluation) return 'Workspace is occupied by a running evaluation'
  const leasedRunIds = leases
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
 *   3. The reservation is released in `finally`; a leaked row (crash) is
 *      swept by age.
 *
 * Throws `WorkspaceRemovalBlockedError` when the worktree is (or became)
 * occupied, or when a removal of the same worktree is already in progress.
 */
export async function removeSourceWorkspaceGuarded(input: {
  sourceId: string
  name: string
  scm: RemovableScmWorkspace
}): Promise<void> {
  const { sourceId, name, scm } = input
  const reservationId = workspaceRemovalId(sourceId, name)

  await withScmPathMutation(async (tx) => {
    const blocked = await findWorkspaceRemovalBlocker(tx, sourceId, scm, name)
    if (blocked) throw new WorkspaceRemovalBlockedError(blocked)
    const reserved = await tx
      .insert(scmWorkspaceRemovals)
      .values({
        id: reservationId,
        scmSourceId: sourceId,
        workspaceName: name,
        ownerInstanceId: processInstanceId,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: scmWorkspaceRemovals.id })
    if (reserved.length === 0) {
      throw new WorkspaceRemovalBlockedError('A removal of this workspace is already in progress')
    }
  })

  try {
    await scm.removeWorkspace(name, {
      beforeRemove: async () => {
        const blocked = await withScmPathMutation((tx) =>
          findWorkspaceRemovalBlocker(tx, sourceId, scm, name),
        )
        if (blocked) throw new WorkspaceRemovalBlockedError(blocked)
      },
    })
  } finally {
    // Release even when the removal failed: the reservation only needs to
    // span the attempt, and a wedged row would block the source's mutations
    // until the age sweep. A failed delete here degrades to that sweep.
    await withScmPathMutation(async (tx) => {
      await tx
        .delete(scmWorkspaceRemovals)
        .where(eq(scmWorkspaceRemovals.id, reservationId))
        .returning({ id: scmWorkspaceRemovals.id })
    }).catch((error) => {
      logger.error(
        { error, reservationId },
        'Failed to release workspace removal reservation; the age sweep will reclaim it',
      )
    })
  }
}

/** A removal never legitimately outlives its git timeouts; 30 min is far past. */
export const WORKSPACE_REMOVAL_MAX_AGE_MS = 30 * 60 * 1000

/**
 * Purge reservations old enough that no live removal can still own them.
 * Age-based on purpose: unlike a workload lease, a reservation's lifetime is
 * bounded by the removal's own timeouts, so age alone is a safe proof of
 * abandonment — including for rows leaked by a replica that no longer exists.
 */
export async function sweepStaleWorkspaceRemovals(
  maxAgeMs: number = WORKSPACE_REMOVAL_MAX_AGE_MS,
  now: Date = new Date(),
): Promise<string[]> {
  return withScmPathMutation(async (tx) => {
    const cutoff = new Date(now.getTime() - maxAgeMs)
    const purged = await tx
      .delete(scmWorkspaceRemovals)
      .where(lt(scmWorkspaceRemovals.createdAt, cutoff))
      .returning({ id: scmWorkspaceRemovals.id })
    return purged.map((row) => row.id)
  })
}

/**
 * Single-process (SQLite) startup: no previous removal can still be running,
 * so every reservation is a leak from the dead process. PostgreSQL replicas
 * must NOT do this — a peer may be mid-removal — and rely on the age sweep.
 */
export async function clearWorkspaceRemovalsOnStartup(): Promise<number> {
  return withScmPathMutation(async (tx) => {
    const cleared = await tx.delete(scmWorkspaceRemovals).returning({ id: scmWorkspaceRemovals.id })
    return cleared.length
  })
}
