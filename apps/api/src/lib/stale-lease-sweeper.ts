import {
  completeExecutionLease,
  listActiveExecutionLeases,
} from '../engine/execution-lease-registry.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { scheduleNext, sweepStaleLeases } from '../engine/task-queue.js'
import { executeChatRun } from './execute-chat-run.js'
import { logger } from './logger.js'
import { sweepOrphanedScmWorkloadLeases } from './scm-lease-sweeper.js'
import { retryPendingWorkspaceRemovalReleases } from './scm-workspace-removal.js'

const DEFAULT_SWEEP_INTERVAL_MS = 60_000

/**
 * Periodically reconcile in-memory execution leases against DB run existence.
 * Terminal status cannot prove process exit, so this safety net only releases
 * leases whose Run row was deleted and therefore has no possible owner cleanup.
 */
export function startStaleLeaseSweeper(intervalMs = DEFAULT_SWEEP_INTERVAL_MS): () => void {
  // async callback: sweepStaleLeases reads run status from the DB, which is a
  // Promise on PostgreSQL. Without awaiting it, `released` would be a Promise —
  // truthy, but with no `.length` — so the guard below would never fire and
  // leaked leases would pin the agent's concurrency until a restart.
  const timer = setInterval(async () => {
    try {
      const released = await sweepStaleLeases(
        taskQueueDb,
        listActiveExecutionLeases(),
        completeExecutionLease,
      )
      if (released.length > 0) {
        logger.warn(
          { swept: released.length },
          'stale-lease-sweeper: released leaked execution leases',
        )
        // Freeing a slot may unblock a queued run; nudge each affected agent's
        // queue so an already-queued run advances rather than waiting for the
        // next unrelated trigger.
        const agentIds = new Set(released.map((r) => r.agentId).filter((id): id is string => !!id))
        for (const agentId of agentIds) {
          void scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
        }
      }
    } catch (error) {
      logger.error({ error }, 'stale-lease-sweeper: sweep failed')
    }
    // Durable SCM workload leases are released after process exit and
    // workspace cleanup; if that release throws it is logged and never
    // retried inline, so this sweep is the retry. Without it a single failed
    // delete permanently locks the Agent's binding and the source's
    // PATCH/DELETE. Separate try: a failure in either sweep must not starve
    // the other.
    try {
      const releasedDurable = await sweepOrphanedScmWorkloadLeases()
      if (releasedDurable.length > 0) {
        logger.warn(
          { swept: releasedDurable },
          'stale-lease-sweeper: released orphaned durable SCM workload leases',
        )
      }
    } catch (error) {
      logger.error({ error }, 'stale-lease-sweeper: durable SCM lease sweep failed')
    }
    try {
      const releasedReservations = await retryPendingWorkspaceRemovalReleases()
      if (releasedReservations.length > 0) {
        logger.info(
          { released: releasedReservations },
          'stale-lease-sweeper: released workspace removal reservations after retry',
        )
      }
    } catch (error) {
      logger.error({ error }, 'stale-lease-sweeper: workspace removal release retry failed')
    }
  }, intervalMs)
  // Don't keep the event loop alive just for the sweeper.
  timer.unref?.()
  return () => clearInterval(timer)
}
