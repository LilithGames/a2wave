import { evaluationQueueDb } from '../engine/evaluation-queue-db.js'
import { scheduleNextEvaluation } from '../engine/evaluation-queue.js'
import {
  completeExecutionLease,
  listActiveExecutionLeases,
} from '../engine/execution-lease-registry.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { scheduleNext, sweepStaleLeases } from '../engine/task-queue.js'
import { runEvaluationTask } from '../routes/evaluation.js'
import { executeChatRun } from './execute-chat-run.js'
import { pruneDeadInstanceHeartbeats } from './instance-heartbeat.js'
import { logger } from './logger.js'
import {
  failScmWorkloadsOfDeadInstances,
  sweepOrphanedScmWorkloadLeases,
} from './scm-lease-sweeper.js'
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
    // Before the lease sweep, not after: a crashed instance leaves its
    // workload non-terminal forever, and the sweep only releases leases of
    // terminal workloads. Reaping first lets the same tick release what it
    // just settled instead of waiting a full interval.
    try {
      const reaped = await failScmWorkloadsOfDeadInstances()
      if (reaped.length > 0) {
        logger.warn(
          { reaped },
          'stale-lease-sweeper: failed workloads abandoned by a stopped instance',
        )
      }
    } catch (error) {
      logger.error({ error }, 'stale-lease-sweeper: dead-instance workload reap failed')
    }
    // Durable SCM workload leases are released after process exit and
    // workspace cleanup. Their owning lifecycle retries transient failures;
    // this independent sweep is the recovery path if that owner disappears.
    // Separate try: a failure in either sweep must not starve the other.
    try {
      const releasedDurable = await sweepOrphanedScmWorkloadLeases()
      if (releasedDurable.length > 0) {
        logger.warn(
          { swept: releasedDurable },
          'stale-lease-sweeper: released orphaned durable SCM workload leases',
        )
        const runAgentIds = new Set(
          releasedDurable
            .filter((workload) => workload.type === 'run')
            .map((workload) => workload.agentId),
        )
        for (const agentId of runAgentIds) {
          void scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
        }
        // Evaluations run one per Agent at a time, so a released evaluation
        // lease frees the only slot that Agent's queue has. Without this nudge
        // the next queued task waits for an unrelated trigger.
        const evaluationAgentIds = new Set(
          releasedDurable
            .filter((workload) => workload.type === 'evaluation')
            .map((workload) => workload.agentId),
        )
        for (const agentId of evaluationAgentIds) {
          void scheduleNextEvaluation(evaluationQueueDb, agentId, runEvaluationTask)
        }
      }
    } catch (error) {
      logger.error({ error }, 'stale-lease-sweeper: durable SCM lease sweep failed')
    }
    try {
      await pruneDeadInstanceHeartbeats()
    } catch (error) {
      logger.error({ error }, 'stale-lease-sweeper: instance heartbeat prune failed')
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
