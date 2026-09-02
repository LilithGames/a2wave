import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runSteps, runs } from '../db/schema.js'
import { listActiveExecutionLeases } from '../engine/execution-lease-registry.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import {
  canJudgePeerLiveness,
  type InstanceLivenessMap,
  isInstanceOwnerDead,
  loadInstanceLiveness,
} from './instance-heartbeat.js'
import { logger } from './logger.js'
import { canRequeueInterruptedRun } from './resume-chat-id.js'
import { FAILURE_REASONS } from './run-failure-reasons.js'
import { syncReapedRunExternalState } from './scm-lease-sweeper.js'
import { withScmPathMutation } from './scm-path-plan.js'

/**
 * Fail runs abandoned by a crashed instance, for workloads that hold no lease.
 *
 * `failScmWorkloadsOfDeadInstances` already reaps runs whose owner died, but it
 * scans `scm_workload_leases` — and a temp-workspace Agent never takes one. On
 * PostgreSQL, startup recovery deliberately skips in-flight rows (another
 * replica booting proves nothing about the owner), so before this pass a
 * temp-workspace run whose process died stayed 'running' forever: no sweeper
 * covered it and no restart settled it. Those rows pin the Agent's concurrency
 * and read as live work to every operator looking at the run list.
 *
 * The verdict is ownership, never age. A review of a large repository can run
 * far past any per-command timeout, so "old" cannot prove "abandoned" — a
 * stopped heartbeat can, which is the same rule every other durable mark uses.
 */

/**
 * Only `running` — deliberately narrower than startup recovery's set.
 *
 * Ownership is stamped when a run is claimed for execution and cleared when it
 * is queued, so `running` is the only status the column describes. A queued or
 * pending row with an owner would be a leftover from an earlier turn of a
 * reused conversation row, and reaping it would drop a message that a live
 * instance is legitimately holding. Age alone never justifies settling those.
 */
const REAPABLE_RUN_STATUSES = ['running'] as const

export interface OrphanedRunCandidate {
  id: string
  agentId: string
  ownerInstanceId: string | null
  /**
   * Last write to the run row, used as a lower bound on "still being touched".
   *
   * Compared against the owner's boot instant so a reused instance id cannot
   * vouch for a run its previous life started. This is `updatedAt`, which
   * later writers also bump, so it is not the claim instant: the boot-instant
   * fence can therefore fire less often than a true claim time would, never
   * more. That direction is the safe one — a missed reap self-corrects once
   * the heartbeat threshold passes, whereas a false reap kills live work.
   */
  startedAt: Date
}

export interface ReapedOrphanedRun {
  runId: string
  agentId: string
  /**
   * True when the run was requeued to continue its session rather than failed.
   *
   * The caller nudges the Agent's queue for both outcomes — a resumed run needs
   * that nudge to be picked up at all — but only a failed one has actually
   * ended, so the distinction has to survive back to the log line.
   */
  resumed: boolean
}

export interface OrphanedRunReaperDeps {
  listCandidates: () => Promise<OrphanedRunCandidate[]>
  loadLiveness: () => Promise<InstanceLivenessMap>
  /** False during the post-boot grace window, when an empty table means nothing. */
  canJudgePeers: () => boolean
  isRunLocallyActive: (runId: string) => boolean
  /**
   * Status + owner CAS; false means another replica settled the run first.
   *
   * The owner is part of the condition, not decoration: liveness was judged
   * against the `ownerInstanceId` this scan snapshotted, and a peer can requeue
   * and re-promote the run in between, stamping itself as the new owner. A
   * status-only CAS would then fail that peer's live run.
   */
  claimRun: (runId: string, expectedOwnerInstanceId: string) => Promise<boolean>
  afterRunSettled: (runId: string) => Promise<void>
  /**
   * Whether this run may continue from the session it already opened.
   *
   * Optional so a caller that has not opted in keeps the pass's original
   * fail-everything behaviour. Asked with the interruption code this pass is
   * about to write, because the row is still `running` and carries no verdict
   * of its own yet — reading the code off the row would always yield ''.
   */
  canResume?: (runId: string, assumeFailureCode: string) => Promise<boolean>
  /**
   * Status + owner CAS back to `queued`, clearing result and ownership.
   *
   * Fenced on the same expected owner as `claimRun`, for the same reason.
   * Returns false when the transition did not happen — another replica settled
   * the row first. Reporting that as a resume would both lie about the outcome
   * and skip the fail path, leaving the row exactly as this pass found it.
   */
  requeueRun?: (
    runId: string,
    interruptionCode: string,
    expectedOwnerInstanceId: string,
  ) => Promise<boolean>
  now: () => Date
}

export async function listOrphanedRunCandidates(): Promise<OrphanedRunCandidate[]> {
  // Keyed on the run row itself, NOT a join to run_steps. The step row is
  // written well after the run reaches 'running' (workdir resolution and
  // attachment materialization come first), so a process killed in that
  // window leaves a stamped 'running' run with zero steps — the narrowest and
  // likeliest crash window, which an inner join would silently hide forever.
  // initiatorAgentId is already on the row and is the same key
  // countOccupiedRunSlots and scheduleNext use.
  const rows = await db
    .select({
      id: runs.id,
      agentId: runs.initiatorAgentId,
      ownerInstanceId: runs.ownerInstanceId,
      startedAt: runs.updatedAt,
    })
    .from(runs)
    .where(and(inArray(runs.status, [...REAPABLE_RUN_STATUSES]), isNotNull(runs.ownerInstanceId)))
  // A run with no Agent cannot be requeued after settlement; startup recovery
  // archives those as dangling, so leave them to it rather than half-settling.
  return rows.flatMap((row) => (row.agentId ? [{ ...row, agentId: row.agentId }] : []))
}

export async function claimRunForReap(
  runId: string,
  expectedOwnerInstanceId: string,
): Promise<boolean> {
  const reason = FAILURE_REASONS.INSTANCE_STOPPED_DURING_EXEC
  return withScmPathMutation(async (tx) => {
    const claimed = await tx
      .update(runs)
      .set({ status: 'failed', result: { error: reason }, updatedAt: new Date() })
      .where(
        and(
          eq(runs.id, runId),
          inArray(runs.status, [...REAPABLE_RUN_STATUSES]),
          // The owner fence. Status alone is an ABA check: a peer that
          // requeued and re-promoted this run leaves it 'running' again, under
          // itself, and settling it would kill live work. A mismatch is simply
          // "another replica settled it first".
          eq(runs.ownerInstanceId, expectedOwnerInstanceId),
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

/**
 * The real wiring, exported so a test can override one seam without silently
 * dropping the rest. `deps` is an all-or-nothing default: a caller passing a
 * partial object gets no resume hooks at all, which reads as "resume is
 * broken" rather than "the test forgot to wire it".
 */
export const defaultReaperDepsForTest: OrphanedRunReaperDeps = {
  listCandidates: listOrphanedRunCandidates,
  loadLiveness: () => loadInstanceLiveness(db),
  canJudgePeers: () => canJudgePeerLiveness(),
  isRunLocallyActive: (runId) => listActiveExecutionLeases().some((lease) => lease.runId === runId),
  claimRun: claimRunForReap,
  afterRunSettled: syncReapedRunExternalState,
  // Same three pieces startup recovery wires together, pointed at this pass:
  // it is the only recovery that runs on PostgreSQL, where in-flight rows are
  // deliberately skipped at boot because a booting replica proves nothing
  // about a peer. Without this the resume feature is unreachable there.
  // Not `resolveResumeChatId(...) !== null`: that conflates "cannot resume"
  // with "resume by starting over", and the second is the case a run killed
  // before its CLI emitted anything falls into.
  canResume: canRequeueInterruptedRun,
  requeueRun: (runId, interruptionCode, expectedOwnerInstanceId) =>
    taskQueueDb.requeueForResume(runId, interruptionCode, expectedOwnerInstanceId),
  now: () => new Date(),
}

const defaultDeps = defaultReaperDepsForTest

/**
 * Continue an abandoned run from its session, or report that it cannot be.
 *
 * Kept separate from the scan loop so every way this can go wrong lands on the
 * same answer: false, meaning "fail it normally". Nothing here may throw — a
 * resume that fails must degrade to the pre-existing behaviour, never leave the
 * row 'running' for the next pass to find in the same state.
 */
async function tryResume(
  deps: OrphanedRunReaperDeps,
  runId: string,
  expectedOwnerInstanceId: string,
): Promise<boolean> {
  if (!deps.canResume || !deps.requeueRun) return false
  const code = FAILURE_REASONS.INSTANCE_STOPPED_DURING_EXEC.code
  try {
    if (!(await deps.canResume(runId, code))) {
      // Logged, not silent: "resumed or re-ran?" is the only question worth
      // asking of this pass in production, and without this line the two
      // outcomes are indistinguishable after the fact — the re-run overwrites
      // the very metadata that would have explained the decision.
      logger.info({ runId }, 'orphaned-run-reaper: run is not resumable; failing it')
      return false
    }
    // Mark first, requeue second: the requeue clears `result`, and the resumed
    // execution runs in another process, so the code known here has to be
    // written down before it is erased.
    // The mark travels with the requeue rather than preceding it as its own
    // write. A separate mark left a window in which the dying CLI's
    // fire-and-forget session tap merged a stale snapshot over it, and the run
    // then re-executed from scratch because nothing said it was interrupted.
    const requeued = await deps.requeueRun(runId, code, expectedOwnerInstanceId)
    logger.info({ runId, requeued }, 'orphaned-run-reaper: resume requeue attempted')
    return requeued
  } catch (error) {
    logger.warn({ error, runId }, 'orphaned-run-reaper: resume failed; failing the run instead')
    return false
  }
}

/**
 * Settle every non-terminal run whose owning instance is provably gone.
 *
 * Returns the runs this pass touched, so the caller can nudge each affected
 * Agent's queue — a failed run frees a slot that may unblock queued work, and a
 * resumed one is itself queued work waiting to be picked up.
 */
export async function reapOrphanedRuns(
  deps: OrphanedRunReaperDeps = defaultDeps,
): Promise<ReapedOrphanedRun[]> {
  // Nothing is judgeable during the grace window: every peer that has not yet
  // written its first heartbeat would read as dead and lose its live runs.
  if (!deps.canJudgePeers()) return []

  const candidates = await deps.listCandidates()
  if (candidates.length === 0) return []

  const liveness = await deps.loadLiveness()
  const reaped: ReapedOrphanedRun[] = []
  for (const candidate of candidates) {
    // No owner recorded (a row predating this column) carries no ownership
    // claim, so liveness says nothing about it and age alone must never reap.
    if (!candidate.ownerInstanceId) continue
    if (deps.isRunLocallyActive(candidate.id)) continue
    if (
      !isInstanceOwnerDead(liveness, candidate.ownerInstanceId, candidate.startedAt, deps.now())
    ) {
      continue
    }
    try {
      // Re-read immediately before settling: the owner may have resumed
      // beating since the scan, and failing a demonstrably live run is the one
      // outcome worse than leaving a stale row.
      const fresh = await deps.loadLiveness()
      if (!isInstanceOwnerDead(fresh, candidate.ownerInstanceId, candidate.startedAt, deps.now())) {
        continue
      }
      // Resume before fail: a run that recorded the session it was already in
      // continues from there instead of replaying a prompt whose side effects
      // may already have landed. Every failure here — the check, the mark, the
      // requeue — falls through to the fail path rather than stranding the row
      // as 'running', which is the one outcome this pass exists to prevent.
      if (await tryResume(deps, candidate.id, candidate.ownerInstanceId)) {
        reaped.push({ runId: candidate.id, agentId: candidate.agentId, resumed: true })
        continue
      }
      if (!(await deps.claimRun(candidate.id, candidate.ownerInstanceId))) continue
      await deps.afterRunSettled(candidate.id)
      reaped.push({ runId: candidate.id, agentId: candidate.agentId, resumed: false })
    } catch (error) {
      // One unsettleable run must not starve the rest; the next tick retries.
      logger.error({ error, runId: candidate.id }, 'orphaned-run-reaper: failed to settle run')
    }
  }
  return reaped
}
