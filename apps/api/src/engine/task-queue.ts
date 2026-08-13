import type { FailureReason } from '../lib/run-failure-reasons.js'
import { FAILURE_REASONS } from '../lib/run-failure-reasons.js'
import { withAgentScmWorkloadLock } from '../lib/scm-workload-lock.js'
import {
  completeExecutionLease,
  countActiveExecutionLeases,
  reserveExecutionLease,
} from './execution-lease-registry.js'

let promotionsPaused = false

/** Stop terminal callbacks from starting new work during graceful shutdown. */
export function pauseTaskQueuePromotions(): void {
  promotionsPaused = true
}

export function _resumeTaskQueuePromotionsForTests(): void {
  promotionsPaused = false
}

export const MAX_QUEUE_LENGTH = 50
export const DEFAULT_PENDING_ORPHAN_TIMEOUT_MS = 30_000

/** Pending runs older than this are treated as orphaned by startup recovery. */
export const PENDING_ORPHAN_TIMEOUT_MS = parsePendingOrphanTimeoutMs(
  process.env.PENDING_ORPHAN_TIMEOUT_MS,
)

export function parsePendingOrphanTimeoutMs(value: string | undefined): number {
  if (!value) return DEFAULT_PENDING_ORPHAN_TIMEOUT_MS
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PENDING_ORPHAN_TIMEOUT_MS
  return parsed
}

export interface RunRow {
  id: string
  triggerSource: string | null
  triggerSessionId: string | null
}

/**
 * Every method is async because the PostgreSQL driver has no synchronous API.
 * On SQLite the underlying calls still complete in the same tick; the Promise is
 * only a wrapper, so no ordering that mattered before is lost.
 */
export interface TaskQueueDb {
  countRunsByStatus(agentId: string, status: string): Promise<number>
  /**
   * Occupied concurrency slots, unioned by run id across every occupancy view
   * (`running` rows, in-process execution leases, durable active SCM leases).
   * Promotion must use this rather than max()-ing the per-view counts: the
   * views overlap but none subsumes another, so max() undercounts and
   * over-promotes past maxConcurrency.
   */
  countOccupiedSlots?(agentId: string): Promise<number>
  /** Current status of a single run, or undefined if it no longer exists. */
  getRunStatus(runId: string): Promise<string | undefined>
  getAgentMaxConcurrency(agentId: string): Promise<number | undefined>
  updateRunStatus(runId: string, status: string): Promise<void>
  /** Decide capacity, persist status and reserve the SCM binding atomically. */
  admitRun?(
    agentId: string,
    runId: string,
    maxConcurrency: number,
  ): Promise<{ slot: SlotResult; hasScmLease: boolean; scmLeaseActivated?: boolean }>
  /** Mark a reserved SCM workload as owned by this process before execution. */
  activateRun?(runId: string): Promise<void>
  /** Atomically re-check capacity, claim queued status, and activate its durable SCM lease. */
  promoteQueuedRun?(agentId: string, runId: string, maxConcurrency: number): Promise<boolean>
  /** Release a queued reservation that never started. */
  releaseReservedRun?(runId: string): Promise<boolean>
  /**
   * Conditional status transition: flip `runId` to `to` only if it is currently
   * `from`, reporting whether THIS call made the change.
   *
   * The queue's only defence against two concurrent promotions picking the same
   * queued run. The execution lease cannot arbitrate it — the lease is keyed by
   * runId and both callers hold the same one, so the second reservation is a
   * silent no-op. A single conditional UPDATE has exactly one winner.
   */
  tryTransitionRunStatus(runId: string, from: string, to: string): Promise<boolean>
  failRunSteps(runId: string): Promise<void>
  failRunWithError(runId: string, reason: string): Promise<void>
  /** Write structured failure object to runs.result.error + run_steps.output.error. */
  failRunWithStructuredReason(runId: string, reason: FailureReason): Promise<void>
  getOldestQueuedRun(agentId: string): Promise<{ id: string; initiatorAgentId: string } | undefined>
  getRunsByStatus(agentId: string, status: string): Promise<RunRow[]>
  /** Pending runs whose createdAt is older than cutoffMs (epoch ms). */
  getOrphanedPendingRuns(agentId: string, cutoffMs: number): Promise<RunRow[]>
  /**
   * Pending runs older than cutoffMs whose non-null initiator_agent_id points to
   * an agent that no longer exists. NULL-agent pending runs are legitimate
   * "created now, execute later" records and are not dangling.
   */
  getDanglingPendingRuns(cutoffMs: number): Promise<RunRow[]>
  /**
   * Queued runs whose non-null initiator_agent_id points to an agent that no
   * longer exists. Such runs can never be promoted by scheduleNext, so we archive
   * them on startup. Same live `NOT EXISTS` semantics as getDanglingPendingRuns.
   */
  getDanglingQueuedRuns(): Promise<RunRow[]>
}

export type SlotResult = 'acquired' | 'queued' | 'queue_full'

/**
 * Whether a new run for this agent could be admitted right now.
 *
 * `tryAcquireSlot` needs an existing `runs` row, so a caller that creates rows
 * speculatively writes one even when the queue is full. That is fine for a
 * user-initiated run — the failed row is the user's receipt — but a poller
 * generating rows on a timer turns a full queue into a steady stream of `failed`
 * rows and audit entries. Such callers check here first and skip row creation
 * entirely. Advisory only: the real admission decision stays in
 * `tryAcquireSlot`, which is still authoritative under concurrency.
 *
 * Async because the dual-backend port made every `TaskQueueDb` read return a
 * Promise; on SQLite the underlying calls still settle in the same tick.
 */
export async function hasAdmissionCapacity(
  db: TaskQueueDb,
  agentId: string,
  maxConcurrency: number,
): Promise<boolean> {
  const running = Math.max(
    await db.countRunsByStatus(agentId, 'running'),
    countActiveExecutionLeases(agentId),
  )
  if (running < maxConcurrency) return true
  return (await db.countRunsByStatus(agentId, 'queued')) < MAX_QUEUE_LENGTH
}

/**
 * Claim a concurrency slot for `runId`.
 *
 * The admission decision is `max(DB running count, in-memory lease count)`, and
 * it is the **lease** that makes this safe: `reserveExecutionLease` is a
 * synchronous in-process operation, so between the count and the reservation no
 * other request in this process can interleave and claim the same slot. The DB
 * count only contributes rows this process has not leased (e.g. left behind by a
 * previous run of the process) — it can never be the sole basis for admitting.
 *
 * That distinction is what makes the await below acceptable: awaiting the count
 * yields the event loop, but a concurrent caller resuming in that window still
 * sees this call's lease once it is taken, and the lease is taken without an
 * await in between.
 */
export async function tryAcquireSlot(
  db: TaskQueueDb,
  agentId: string,
  runId: string,
  maxConcurrency: number,
): Promise<SlotResult> {
  if (promotionsPaused) return 'queue_full'
  return withAgentScmWorkloadLock(agentId, async () => {
    if (db.admitRun) {
      const admission = await db.admitRun(agentId, runId, maxConcurrency)
      if (admission.slot === 'acquired') {
        reserveExecutionLease(runId, agentId)
        try {
          if (admission.hasScmLease && !admission.scmLeaseActivated) {
            await db.activateRun?.(runId)
          }
        } catch (error) {
          completeExecutionLease(runId)
          throw error
        }
      }
      return admission.slot
    }

    const runningInDb = await db.countRunsByStatus(agentId, 'running')
    const running = Math.max(runningInDb, countActiveExecutionLeases(agentId))
    if (running < maxConcurrency) {
      reserveExecutionLease(runId, agentId)
      await db.updateRunStatus(runId, 'running')
      return 'acquired'
    }
    const queued = await db.countRunsByStatus(agentId, 'queued')
    if (queued >= MAX_QUEUE_LENGTH) return 'queue_full'
    await db.updateRunStatus(runId, 'queued')
    return 'queued'
  })
}

/**
 * Reconcile in-memory execution leases against DB run existence.
 *
 * Release rules (deliberately conservative to avoid dropping a LIVE lease during
 * legitimate post-run cleanup):
 *   - run no longer exists (deleted) → release immediately; nothing can finish it.
 *   - any existing run → leave it. A terminal status is written before process
 *     exit and cleanup, so age can never prove the checkout is unused.
 *
 * Status age is intentionally irrelevant: cancellation and terminal status are
 * persisted before the process exits, so only row disappearance is proof that
 * no execution owner can finish the lease. Returns the released leases.
 */
export async function sweepStaleLeases(
  db: Pick<TaskQueueDb, 'getRunStatus'>,
  leases: Array<{ runId: string; agentId?: string }>,
  finish: (runId: string) => void,
): Promise<Array<{ runId: string; agentId?: string }>> {
  const released: Array<{ runId: string; agentId?: string }> = []
  for (const { runId, agentId } of leases) {
    const status = await db.getRunStatus(runId)
    if (status === undefined) {
      // Run deleted — nothing can ever finish this lease.
      finish(runId)
      released.push({ runId, agentId })
    }
  }
  return released
}

/**
 * Promote queued runs into free concurrency slots.
 *
 * **Never rejects.** Every production call site is `void scheduleNext(...)` — a
 * queue nudge is deliberately fire-and-forget, fired after a run finishes or a
 * lease is swept. Once the DB became async, a transient error (connection reset,
 * deadlock, server restart) would surface as an unhandled rejection, and with no
 * `process.on('unhandledRejection')` handler Node terminates the API. A failed
 * nudge must degrade to "promoted nothing" and let the next completion retry;
 * losing the whole process over it is far worse than a briefly stalled queue.
 *
 * Errors are swallowed rather than rethrown for the same reason, but they are
 * logged so a persistently stuck queue is still diagnosable.
 */
export async function scheduleNext(
  db: TaskQueueDb,
  agentId: string,
  onExecute: (runId: string, agentId: string) => void,
): Promise<number> {
  if (promotionsPaused) return 0
  try {
    return await promoteQueuedRuns(db, agentId, onExecute)
  } catch (error) {
    console.error(`[scheduleNext] promotion failed for agent ${agentId}:`, error)
    return 0
  }
}

async function promoteQueuedRuns(
  db: TaskQueueDb,
  agentId: string,
  onExecute: (runId: string, agentId: string) => void,
): Promise<number> {
  return withAgentScmWorkloadLock(agentId, () => promoteQueuedRunsLocked(db, agentId, onExecute))
}

async function promoteQueuedRunsLocked(
  db: TaskQueueDb,
  agentId: string,
  onExecute: (runId: string, agentId: string) => void,
): Promise<number> {
  const maxConcurrency = await db.getAgentMaxConcurrency(agentId)
  if (maxConcurrency === undefined) return 0
  let promoted = 0

  // Safety guard: prevent infinite loop in case of data inconsistency
  const maxIterations = MAX_QUEUE_LENGTH + maxConcurrency
  let iterations = 0

  for (;;) {
    iterations++
    if (iterations > maxIterations) {
      // This should never happen in normal operation; indicates data inconsistency
      console.warn(
        `[scheduleNext] Exceeded max iterations (${maxIterations}) for agent ${agentId}, possible data inconsistency`,
      )
      break
    }

    // Prefer the full occupancy union: max() of the per-view counts misses a
    // peer replica's cleanup-window lease when a different run is `running`
    // here, and promotes a run past maxConcurrency. The max() fallback exists
    // only for TaskQueueDb fakes that predate countOccupiedSlots.
    const running =
      db.countOccupiedSlots !== undefined
        ? await db.countOccupiedSlots(agentId)
        : Math.max(
            await db.countRunsByStatus(agentId, 'running'),
            countActiveExecutionLeases(agentId),
          )
    if (running >= maxConcurrency) break
    const next = await db.getOldestQueuedRun(agentId)
    if (!next) break
    // Claim via a conditional UPDATE, and execute ONLY if this call won it.
    //
    // The lease cannot arbitrate here, unlike in tryAcquireSlot: that function's
    // callers hold distinct runIds, so the second sees the first's lease. Two
    // concurrent promotions instead read the SAME oldest queued run, and
    // reserveExecutionLease is idempotent by runId — the second reservation is a
    // silent no-op, the lease count stays at 1, and both callers would proceed to
    // spawn a CLI against one run and one workspace.
    const claimed = db.promoteQueuedRun
      ? await db.promoteQueuedRun(agentId, next.id, maxConcurrency)
      : await db.tryTransitionRunStatus(next.id, 'queued', 'running')
    if (!claimed) continue
    reserveExecutionLease(next.id, agentId)
    if (!db.promoteQueuedRun) {
      try {
        await db.activateRun?.(next.id)
      } catch (error) {
        completeExecutionLease(next.id)
        throw error
      }
    }
    onExecute(next.id, agentId)
    promoted++
  }

  return promoted
}

export interface RecoveryHooks {
  /** Invoked for every run that recovery marks as failed. Use to sync external stores (e.g. a2aTasks). */
  onRunFailed?: (run: RunRow, reason: FailureReason) => Promise<void> | void
  /** False on PostgreSQL, where in-flight rows may belong to a healthy peer. */
  recoverInFlight?: boolean
}

export interface RecoveryStats {
  pendingOrphaned: number
  runningAborted: number
  queuedPromoted: number
  feishuQueuedReset: number
}

export async function recoverOnStartup(
  db: TaskQueueDb,
  onExecute: (runId: string, agentId: string) => void,
  // May be async: on PostgreSQL the agent list comes from an awaited query.
  getAgentIds: () => string[] | Promise<string[]>,
  hooks: RecoveryHooks = {},
): Promise<RecoveryStats> {
  const stats: RecoveryStats = {
    pendingOrphaned: 0,
    runningAborted: 0,
    queuedPromoted: 0,
    feishuQueuedReset: 0,
  }
  const pendingCutoff = Date.now() - PENDING_ORPHAN_TIMEOUT_MS
  const activeAgentIds = await getAgentIds()

  const applyFailure = async (run: RunRow, reason: FailureReason): Promise<void> => {
    await db.failRunWithStructuredReason(run.id, reason)
    await db.updateRunStatus(run.id, 'failed')
    if (hooks.onRunFailed) {
      try {
        await hooks.onRunFailed(run, reason)
      } catch {
        // Hook errors must not break recovery; the DB state is already authoritative.
      }
    }
  }

  for (const agentId of activeAgentIds) {
    if (hooks.recoverInFlight !== false) {
      const runningRuns = await db.getRunsByStatus(agentId, 'running')
      for (const run of runningRuns) {
        await applyFailure(run, FAILURE_REASONS.SERVER_RESTART_DURING_EXEC)
        stats.runningAborted++
      }

      const pendingOrphans = await db.getOrphanedPendingRuns(agentId, pendingCutoff)
      for (const run of pendingOrphans) {
        await applyFailure(run, FAILURE_REASONS.PENDING_ORPHAN_ON_STARTUP)
        stats.pendingOrphaned++
      }

      // Feishu queued runs lose their in-memory closure (reply target,
      // streaming card registration, quote context) on restart. The DB-backed
      // feishu_pending_messages row is replayed separately after Feishu
      // connections come back. Fail the stale queued rows here so scheduleNext
      // does NOT promote them via the generic executeChatRun path (which would
      // run without Feishu context and then block replay).
      const queuedRuns = await db.getRunsByStatus(agentId, 'queued')
      for (const run of queuedRuns) {
        if (run.triggerSource === 'feishu') {
          await applyFailure(run, FAILURE_REASONS.FEISHU_QUEUED_RESET_FOR_REPLAY)
          stats.feishuQueuedReset++
        }
      }
    }

    stats.queuedPromoted += await scheduleNext(db, agentId, onExecute)
  }

  // Sweep dangling runs whose non-null initiatorAgentId points to a deleted agent.
  // The per-agent loop above can never see these. The DB methods use a live
  // NOT EXISTS subquery rather than the activeAgentIds snapshot, so a race where
  // an agent is created during this loop won't fail its newly-queued runs.
  const danglingPending = await db.getDanglingPendingRuns(pendingCutoff)
  for (const run of danglingPending) {
    await applyFailure(run, FAILURE_REASONS.DANGLING_RUN_ON_STARTUP)
    stats.pendingOrphaned++
  }
  const danglingQueued = await db.getDanglingQueuedRuns()
  for (const run of danglingQueued) {
    // Even for triggerSource === 'feishu': the per-agent FEISHU_QUEUED_RESET_FOR_REPLAY
    // path only runs for active agents, and the message-replay path needs a live agent
    // to rebuild the run. With no agent owning this row, both paths are dead — archive.
    await applyFailure(run, FAILURE_REASONS.DANGLING_RUN_ON_STARTUP)
    stats.pendingOrphaned++
  }

  return stats
}
