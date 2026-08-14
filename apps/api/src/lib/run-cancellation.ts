import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import { cancelExecutionLease } from '../engine/execution-lease-registry.js'
import { engineRegistry } from '../engine/index.js'
import { scheduleNext } from '../engine/task-queue.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { executeChatRun } from './execute-chat-run.js'
import { logger } from './logger.js'
import { withScmPathMutation } from './scm-path-plan.js'
import { releaseReservedScmWorkloadInMutation } from './scm-workload-lifecycle.js'

interface BackgroundCancellationRequest {
  runId: string
  agentId?: string | null
  taskIds: string[]
}

type CancellableRunStatus = 'running' | 'queued'

/** First-terminal-wins CAS shared by every cancellation endpoint. */
export async function claimRunCancellation(
  runId: string,
  expectedStatus: CancellableRunStatus,
): Promise<boolean> {
  // `.returning()` rather than a driver row count: better-sqlite3 reports
  // `changes` and node-postgres `rowCount`, so the returned rows are the one form
  // that means the same on both. This is the claim on a cancellation — reading
  // `.changes` on PostgreSQL yielded undefined, so no cancel ever succeeded.
  return withScmPathMutation(async (tx) => {
    const cancelled = await tx
      .update(runs)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(runs.id, runId), eq(runs.status, expectedStatus)))
      .returning({ id: runs.id })
    if (cancelled.length === 1 && expectedStatus === 'queued') {
      await releaseReservedScmWorkloadInMutation(tx, { type: 'run', workloadId: runId })
    }
    return cancelled.length === 1
  })
}

/**
 * Sends termination signals synchronously, then waits for process cleanup off
 * the HTTP request path. The queue advances only after every matching process
 * has exited so the next run cannot overlap the cancelled process.
 */
export function cancelRunningTasksInBackground({
  runId,
  agentId,
  taskIds,
}: BackgroundCancellationRequest): void {
  const executionCompletion = cancelExecutionLease(runId)
  const cancellations = taskIds.map((taskId) => {
    try {
      return engineRegistry.cancel(taskId)
    } catch (error) {
      return Promise.reject(error)
    }
  })

  const pending = [...cancellations, executionCompletion]

  void Promise.allSettled(pending).then((results) => {
    for (const [index, result] of results.slice(0, taskIds.length).entries()) {
      if (result.status === 'rejected') {
        logger.warn(
          { err: result.reason, runId, taskId: taskIds[index] },
          'CLI cancellation request failed',
        )
      }
    }

    if (agentId) {
      void scheduleNext(
        taskQueueDb,
        agentId,
        (nextRunId, nextAgentId) => void executeChatRun(nextAgentId, nextRunId),
      )
    }
  })
}
