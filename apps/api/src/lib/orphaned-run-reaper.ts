import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runSteps, runs } from '../db/schema.js'
import { listActiveExecutionLeases } from '../engine/execution-lease-registry.js'
import {
  canJudgePeerLiveness,
  type InstanceLivenessMap,
  isInstanceOwnerDead,
  loadInstanceLiveness,
} from './instance-heartbeat.js'
import { logger } from './logger.js'
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

/** Non-terminal statuses; the same set startup recovery and the lease reaper settle. */
const REAPABLE_RUN_STATUSES = ['running', 'pending', 'queued'] as const

export interface OrphanedRunCandidate {
  id: string
  agentId: string
  ownerInstanceId: string | null
  /**
   * When this run was claimed. Compared against the owner's boot instant so a
   * reused instance id cannot vouch for a run its previous life started.
   */
  startedAt: Date
}

export interface ReapedOrphanedRun {
  runId: string
  agentId: string
}

export interface OrphanedRunReaperDeps {
  listCandidates: () => Promise<OrphanedRunCandidate[]>
  loadLiveness: () => Promise<InstanceLivenessMap>
  /** False during the post-boot grace window, when an empty table means nothing. */
  canJudgePeers: () => boolean
  isRunLocallyActive: (runId: string) => boolean
  /** Status CAS; false means another replica settled the run first. */
  claimRun: (runId: string) => Promise<boolean>
  afterRunSettled: (runId: string) => Promise<void>
  now: () => Date
}

async function listOrphanedRunCandidates(): Promise<OrphanedRunCandidate[]> {
  const rows = await db
    .select({
      id: runs.id,
      agentId: runSteps.agentId,
      ownerInstanceId: runs.ownerInstanceId,
      startedAt: runs.updatedAt,
    })
    .from(runs)
    .innerJoin(runSteps, eq(runSteps.runId, runs.id))
    .where(and(inArray(runs.status, [...REAPABLE_RUN_STATUSES]), isNotNull(runs.ownerInstanceId)))
  // One row per run: a run has a step per attempt, and they share an Agent.
  // A step with no Agent cannot be requeued after settlement, so skip it and
  // leave the row for an operator rather than settling it into a dead end.
  const byRun = new Map<string, OrphanedRunCandidate>()
  for (const row of rows) {
    if (!row.agentId || byRun.has(row.id)) continue
    byRun.set(row.id, { ...row, agentId: row.agentId })
  }
  return [...byRun.values()]
}

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

const defaultDeps: OrphanedRunReaperDeps = {
  listCandidates: listOrphanedRunCandidates,
  loadLiveness: () => loadInstanceLiveness(db),
  canJudgePeers: () => canJudgePeerLiveness(),
  isRunLocallyActive: (runId) => listActiveExecutionLeases().some((lease) => lease.runId === runId),
  claimRun: claimRunForReap,
  afterRunSettled: syncReapedRunExternalState,
  now: () => new Date(),
}

/**
 * Settle every non-terminal run whose owning instance is provably gone.
 *
 * Returns the runs this pass settled, so the caller can nudge each affected
 * Agent's queue — the freed slot may unblock work that is already queued.
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
      if (!(await deps.claimRun(candidate.id))) continue
      await deps.afterRunSettled(candidate.id)
      reaped.push({ runId: candidate.id, agentId: candidate.agentId })
    } catch (error) {
      // One unsettleable run must not starve the rest; the next tick retries.
      logger.error({ error, runId: candidate.id }, 'orphaned-run-reaper: failed to settle run')
    }
  }
  return reaped
}
