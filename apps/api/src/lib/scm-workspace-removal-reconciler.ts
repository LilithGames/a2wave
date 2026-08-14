import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { scmSources, scmWorkspaceRemovals } from '../db/schema.js'
import {
  type InstanceLivenessMap,
  canJudgePeerLiveness,
  isInstanceOwnerDead,
  loadInstanceLiveness,
} from './instance-heartbeat.js'
import { logger } from './logger.js'
import { processInstanceId } from './process-instance.js'
import { withScmPathMutation } from './scm-path-plan.js'
import { createScmSource } from './scm-source.js'
import { findWorkspaceRemovalBlocker, handOffWorkspaceRemoval } from './scm-workspace-removal.js'

/**
 * Periodic convergence for workspace removals nobody is finishing.
 *
 * A removal reservation is a promise that a worktree is about to disappear:
 * every counter-party (worktree creation, run admission, path PATCH, source
 * DELETE, env bootstrap) refuses to touch the source while one is pending. If
 * the process that wrote it dies — or exhausts its bounded retries and hands
 * the row off by NULLing its ownership — that promise is left unkept, and
 * before this reconciler existed the only way out was an operator running the
 * manual recovery procedure.
 *
 * The reconciler makes convergence the system's job instead. Each tick it
 * adopts reservations with no live owner (NULL ownership, or an owner whose
 * heartbeat stopped / rebooted since the attempt started), re-runs the same
 * occupancy decision every remover runs, and either finishes the removal or —
 * when the worktree legitimately became occupied again, or its source is gone
 * — releases the row as obsolete.
 *
 * Failure is not exceptional here: a failed attempt simply keeps the row, and
 * the next tick retries. That is the entire retry mechanism, which is why the
 * owner's inline loop no longer needs to be unbounded.
 *
 * Adoption is a compare-and-set on the attempt token under the SCM mutation
 * lock, so two reconcilers racing on one row produce exactly one filesystem
 * operation.
 */

export type ReconciledRemovalOutcome = 'removed' | 'obsolete' | 'retry'

export interface ReconciledRemoval {
  reservationId: string
  outcome: ReconciledRemovalOutcome
}

interface AbandonedCandidate {
  id: string
  scmSourceId: string
  workspaceName: string
  ownerInstanceId: string | null
  attemptToken: string
  attemptStartedAt: Date
}

export interface WorkspaceRemovalReconcilerDeps {
  listAbandonedCandidates: () => Promise<AbandonedCandidate[]>
  loadLiveness: () => Promise<InstanceLivenessMap>
  /** False during the post-boot grace window; gates only the dead-owner branch. */
  canJudgePeers: () => boolean
  /** Compare-and-set the attempt token; false means another replica won the row. */
  adopt: (reservationId: string, expectedToken: string, nextToken: string) => Promise<boolean>
  /** The same occupancy decision every remover runs; a reason string blocks. */
  findBlocker: (scmSourceId: string, workspaceName: string) => Promise<string | null>
  removeWorkspace: (scmSourceId: string, workspaceName: string) => Promise<void>
  release: (reservationId: string, attemptToken: string) => Promise<void>
  /** Disown a row again after a failed attempt so the next tick can adopt it. */
  handOff: (reservationId: string, attemptToken: string) => Promise<boolean>
  newToken: () => string
  now: () => Date
}

async function listAbandonedCandidates(): Promise<AbandonedCandidate[]> {
  return await db
    .select({
      id: scmWorkspaceRemovals.id,
      scmSourceId: scmWorkspaceRemovals.scmSourceId,
      workspaceName: scmWorkspaceRemovals.workspaceName,
      ownerInstanceId: scmWorkspaceRemovals.ownerInstanceId,
      attemptToken: scmWorkspaceRemovals.attemptToken,
      attemptStartedAt: scmWorkspaceRemovals.attemptStartedAt,
    })
    .from(scmWorkspaceRemovals)
}

async function adopt(
  reservationId: string,
  expectedToken: string,
  nextToken: string,
): Promise<boolean> {
  return withScmPathMutation(async (tx) => {
    // Re-verify liveness inside the claim transaction, not from the snapshot
    // the caller took. That snapshot was read before the loop began, and a
    // peer resuming its heartbeat in between must keep its reservation —
    // otherwise two processes remove the same worktree concurrently.
    const row = (
      await tx
        .select({
          ownerInstanceId: scmWorkspaceRemovals.ownerInstanceId,
          attemptStartedAt: scmWorkspaceRemovals.attemptStartedAt,
        })
        .from(scmWorkspaceRemovals)
        .where(
          and(
            eq(scmWorkspaceRemovals.id, reservationId),
            eq(scmWorkspaceRemovals.attemptToken, expectedToken),
          ),
        )
        .limit(1)
    )[0]
    if (!row) return false
    if (row.ownerInstanceId) {
      const liveness = await loadInstanceLiveness(tx)
      if (!isInstanceOwnerDead(liveness, row.ownerInstanceId, row.attemptStartedAt, new Date())) {
        return false
      }
    }
    const claimed = await tx
      .update(scmWorkspaceRemovals)
      .set({
        ownerInstanceId: processInstanceId,
        attemptToken: nextToken,
        attemptStartedAt: new Date(),
      })
      .where(
        and(
          eq(scmWorkspaceRemovals.id, reservationId),
          eq(scmWorkspaceRemovals.attemptToken, expectedToken),
        ),
      )
      .returning({ id: scmWorkspaceRemovals.id })
    return claimed.length > 0
  })
}

/**
 * Re-run the shared occupancy decision. A missing source row is reported as a
 * blocker by the same rule the removal protocol uses, which is what turns a
 * deleted source's residual reservation into an `obsolete` release rather than
 * a doomed removal attempt.
 */
async function findBlocker(scmSourceId: string, workspaceName: string): Promise<string | null> {
  return withScmPathMutation(async (tx) => {
    const source = (
      await tx.select().from(scmSources).where(eq(scmSources.id, scmSourceId)).limit(1)
    )[0]
    if (!source) return 'SCM source is no longer available'
    const scm = await createScmSource(source)
    if (!scm) return 'SCM source no longer supports workspaces'
    return findWorkspaceRemovalBlocker(
      tx,
      scmSourceId,
      { localPath: scm.localPath, wsRoot: scm.wsRoot },
      workspaceName,
    )
  })
}

async function removeWorkspace(scmSourceId: string, workspaceName: string): Promise<void> {
  const source = (
    await db.select().from(scmSources).where(eq(scmSources.id, scmSourceId)).limit(1)
  )[0]
  if (!source) return
  const scm = await createScmSource(source)
  if (!scm) return
  // The reservation is already held, so this is the plain removal — the
  // beforeRemove re-check belongs to the reserving path, and this reconciler
  // just re-ran the same decision under the mutation lock a moment ago.
  await scm.removeWorkspace(workspaceName)
}

async function release(reservationId: string, attemptToken: string): Promise<void> {
  await withScmPathMutation(async (tx) => {
    await tx
      .delete(scmWorkspaceRemovals)
      .where(
        and(
          eq(scmWorkspaceRemovals.id, reservationId),
          eq(scmWorkspaceRemovals.attemptToken, attemptToken),
        ),
      )
      .returning({ id: scmWorkspaceRemovals.id })
  })
}

const defaultDeps: WorkspaceRemovalReconcilerDeps = {
  listAbandonedCandidates,
  loadLiveness: () => loadInstanceLiveness(db),
  canJudgePeers: () => canJudgePeerLiveness(),
  adopt,
  findBlocker,
  removeWorkspace,
  release,
  handOff: (reservationId, attemptToken) =>
    handOffWorkspaceRemoval({ reservationId, attemptToken }),
  newToken: () => randomUUID(),
  now: () => new Date(),
}

export async function reconcileAbandonedWorkspaceRemovals(
  deps: WorkspaceRemovalReconcilerDeps = defaultDeps,
): Promise<ReconciledRemoval[]> {
  const candidates = await deps.listAbandonedCandidates()
  if (candidates.length === 0) return []

  const canJudgePeers = deps.canJudgePeers()
  const liveness = canJudgePeers ? await deps.loadLiveness() : new Map()
  const now = deps.now()
  const reconciled: ReconciledRemoval[] = []

  for (const candidate of candidates) {
    // A NULL owner is an explicit handoff — always adoptable, no liveness
    // question to answer. A named owner must be proved dead first: a beating
    // one is mid-removal, and adopting would run a second concurrent
    // filesystem removal against the same worktree.
    if (candidate.ownerInstanceId) {
      if (!canJudgePeers) continue
      if (
        !isInstanceOwnerDead(liveness, candidate.ownerInstanceId, candidate.attemptStartedAt, now)
      ) {
        continue
      }
    }
    let adoptedToken: string | null = null
    let reservationSettled = false
    try {
      const nextToken = deps.newToken()
      if (!(await deps.adopt(candidate.id, candidate.attemptToken, nextToken))) continue
      adoptedToken = nextToken

      const blocker = await deps.findBlocker(candidate.scmSourceId, candidate.workspaceName)
      if (blocker) {
        await deps.release(candidate.id, nextToken)
        reservationSettled = true
        logger.info(
          { reservationId: candidate.id, blocker },
          'workspace-removal-reconciler: released an obsolete reservation',
        )
        reconciled.push({ reservationId: candidate.id, outcome: 'obsolete' })
        continue
      }

      try {
        await deps.removeWorkspace(candidate.scmSourceId, candidate.workspaceName)
      } catch (error) {
        // Keep the reservation — it is what holds every counter-party off this
        // worktree — but disown it again. Adoption stamped this instance as
        // owner, and a *live* owner is exactly what the next tick skips, so
        // leaving it claimed would block the source until this process died.
        // Handing it back is what makes "the next tick is the retry" true.
        logger.warn(
          { error, reservationId: candidate.id },
          'workspace-removal-reconciler: removal failed; disowning for the next tick',
        )
        reconciled.push({ reservationId: candidate.id, outcome: 'retry' })
        continue
      }
      await deps.release(candidate.id, nextToken)
      reservationSettled = true
      reconciled.push({ reservationId: candidate.id, outcome: 'removed' })
    } catch (error) {
      logger.error(
        { error, reservationId: candidate.id },
        'workspace-removal-reconciler: reconciliation failed for one reservation',
      )
    } finally {
      // Once this tick adopts a row, every unsuccessful exit must make it
      // adoptable again. Keeping `owner=self` after a blocker query or release
      // error would make every later tick skip the row while this process is
      // healthy. The exact token prevents this cleanup from disowning a newer
      // attempt if another actor already replaced it.
      if (adoptedToken && !reservationSettled) {
        try {
          await deps.handOff(candidate.id, adoptedToken)
        } catch (handOffError) {
          logger.error(
            { error: handOffError, reservationId: candidate.id },
            'workspace-removal-reconciler: failed to disown an incomplete attempt',
          )
        }
      }
    }
  }
  return reconciled
}
