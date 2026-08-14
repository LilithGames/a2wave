/**
 * Per-agent scheduler for evaluation tasks.
 *
 * Deliberately separate from the run queue in `task-queue.ts` rather than a
 * second implementation of `TaskQueueDb`: half of that interface writes
 * `run_steps` and `runs.result`, which evaluation has no equivalent of, and its
 * `RunRow` carries Feishu/A2A trigger fields that would be permanently null
 * here. Sharing it would mean a handful of methods that lie about what they do.
 *
 * The concurrency budget is also intentionally *not* `agents.maxConcurrency`:
 * one evaluation slot fires N agent invocations back to back, so it is far
 * heavier than one chat run. Sharing that number would let a background batch
 * starve interactive conversations.
 */

import { withKeyedLock } from '../lib/keyed-mutex.js'

let promotionsPaused = false

/** Stop terminal callbacks from starting new evaluations during shutdown. */
export function pauseEvaluationQueuePromotions(): void {
  promotionsPaused = true
}

export function _resumeEvaluationQueuePromotionsForTests(): void {
  promotionsPaused = false
}

export const EVALUATION_MAX_QUEUE_LENGTH = 50

/** Recorded on tasks that were mid-flight when the process went down. */
export const EVALUATION_RESTART_REASON = 'Interrupted by a server restart'

export interface EvaluationTaskRow {
  id: string
  agentId: string
}

export interface EvaluationQueueDb {
  countTasksByStatus(agentId: string, status: string): Promise<number>
  /** Per-agent evaluation concurrency, read from settings. */
  getMaxConcurrency(): number
  updateTaskStatus(taskId: string, status: string): Promise<void>
  /** Conditional transition; the queue's guard against double promotion. */
  tryTransitionTaskStatus(taskId: string, from: string, to: string): Promise<boolean>
  /** Oldest queued task for the agent, FIFO by creation time. */
  getOldestQueuedTask(agentId: string): Promise<EvaluationTaskRow | undefined>
  getTasksByStatus(status: string): Promise<EvaluationTaskRow[]>
  /** Marks the task failed and stamps the reason; also settles its result rows. */
  failTask(taskId: string, reason: string): Promise<void>
  getAgentIdsWithQueuedTasks(): Promise<string[]>
  /** Atomically claim every currently available slot across DB replicas. */
  claimQueuedTasks(agentId: string): Promise<EvaluationTaskRow[]>
}

export type EvaluationSlotResult = 'acquired' | 'queued' | 'queue_full'

/**
 * Claims a slot for a freshly created task, or parks it in the queue.
 *
 * Flips the status itself so a caller that crashes between this call and
 * starting work still leaves the row in a state recovery can reason about.
 */
export async function tryAcquireEvaluationSlot(
  db: EvaluationQueueDb,
  agentId: string,
  taskId: string,
): Promise<EvaluationSlotResult> {
  if (promotionsPaused) return 'queue_full'
  // Serialised per agent. The count and the claim are separated by an await, so
  // without this two concurrent submissions both read 0 running and both take
  // the single per-agent slot — for a P4-backed Agent that means two evaluation
  // tasks sharing one checkout, since P4 has no per-task isolation.
  //
  // A compare-and-set on the task row does NOT close this (it was tried, and the
  // review caught it): each submission inserts its OWN task id, so the two CAS
  // updates touch different rows and both succeed. The CAS answers "did anyone
  // else claim THIS task", while the invariant needed here is "how many tasks
  // does THIS AGENT have running" — a different question. The lock is the
  // narrowest thing that answers it, and matches how the rest of the repo
  // serialises cross-row invariants in-process.
  //
  // This fallback is for in-memory/test adapters. Production creation performs
  // admission in the cross-dialect SCM mutation transaction, and production
  // queue promotion uses `claimQueuedTasks` below for the same replica-safe
  // serialization.
  return await withKeyedLock(`eval-slot:${agentId}`, async () => {
    const running = await db.countTasksByStatus(agentId, 'running')
    if (running < db.getMaxConcurrency()) {
      // Still conditional: the row could have been cancelled or deleted while
      // this call waited for the lock, and a blind write would resurrect it.
      if (await db.tryTransitionTaskStatus(taskId, 'pending', 'running')) {
        return 'acquired'
      }
    }

    const queued = await db.countTasksByStatus(agentId, 'queued')
    if (queued >= EVALUATION_MAX_QUEUE_LENGTH) return 'queue_full'

    await db.updateTaskStatus(taskId, 'queued')
    return 'queued'
  })
}

/**
 * Promotes queued tasks for one agent until its slots are full. Must be called
 * on every terminal path of a task, or the queue stalls with work still in it.
 */
export async function scheduleNextEvaluation(
  db: EvaluationQueueDb,
  agentId: string,
  onExecute: (taskId: string, agentId: string) => void,
): Promise<number> {
  if (promotionsPaused) return 0
  try {
    const claimed = await db.claimQueuedTasks(agentId)
    for (const task of claimed) onExecute(task.id, task.agentId)
    return claimed.length
  } catch (error) {
    // Callers fire this without awaiting; a rejection would become an unhandled
    // rejection and terminate the process. See scheduleNext in task-queue.ts.
    console.error(`[scheduleNextEvaluation] promotion failed for agent ${agentId}:`, error)
    return 0
  }
}

export interface EvaluationRecoveryStats {
  runningAborted: number
  pendingAborted: number
  queuedPromoted: number
}

/**
 * Settles evaluation tasks stranded by a process restart.
 *
 * `running` and `pending` tasks are failed rather than resumed: their work was
 * driven by an in-process loop that no longer exists, and resuming would need
 * per-case idempotency the runner does not offer. Failing them makes the state
 * honest and leaves re-running to the user. `queued` tasks never started, so
 * they are simply put back through the scheduler.
 */
export async function recoverEvaluationsOnStartup(
  db: EvaluationQueueDb,
  onExecute: (taskId: string, agentId: string) => void,
  options: {
    recoverInFlight?: boolean
    onTaskFailed?: (task: EvaluationTaskRow) => Promise<void> | void
  } = {},
): Promise<EvaluationRecoveryStats> {
  const stats: EvaluationRecoveryStats = {
    runningAborted: 0,
    pendingAborted: 0,
    queuedPromoted: 0,
  }

  if (options.recoverInFlight !== false) {
    for (const task of await db.getTasksByStatus('running')) {
      await db.failTask(task.id, EVALUATION_RESTART_REASON)
      try {
        await options.onTaskFailed?.(task)
      } catch {
        // The task state is authoritative; retain the lease on cleanup failure.
      }
      stats.runningAborted++
    }

    // `pending` is the gap between insert and scheduling. After a restart nothing
    // is left to pick these up, so they are stranded exactly like `running` ones.
    for (const task of await db.getTasksByStatus('pending')) {
      await db.failTask(task.id, EVALUATION_RESTART_REASON)
      try {
        await options.onTaskFailed?.(task)
      } catch {
        // The task state is authoritative; retain the lease on cleanup failure.
      }
      stats.pendingAborted++
    }
  }

  for (const agentId of await db.getAgentIdsWithQueuedTasks()) {
    stats.queuedPromoted += await scheduleNextEvaluation(db, agentId, onExecute)
  }

  return stats
}
