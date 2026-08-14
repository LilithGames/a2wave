import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { evaluationResults, evaluationTasks } from '../db/schema.js'
import { withScmPathMutation } from '../lib/scm-path-plan.js'
import type { EvaluationQueueDb, EvaluationTaskRow } from './evaluation-queue.js'

const VALID_TASK_STATUSES = [
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
type TaskStatus = (typeof VALID_TASK_STATUSES)[number]

function parseTaskStatus(s: string): TaskStatus | null {
  return VALID_TASK_STATUSES.includes(s as TaskStatus) ? (s as TaskStatus) : null
}

/**
 * Evaluation runs strictly one task at a time per Agent.
 *
 * A task holds a single workspace for its whole replay, so two concurrent
 * tasks would have to share it — syncing conflicting .mcp.json, skills and KB
 * docs into one directory and starting two agent CLIs in it. Git SCM Agents
 * get a per-task worktree, but local and P4 Agents have no such isolation, and
 * a knob that is only safe for one of three workspace kinds is not a knob.
 *
 * The `evaluation.maxConcurrency` setting is left in existing databases but is
 * no longer read; widening this again needs the workspace story solved first.
 */
const EVALUATION_MAX_CONCURRENCY = 1

export const evaluationQueueDb: EvaluationQueueDb = {
  async countTasksByStatus(agentId: string, status: string): Promise<number> {
    const taskStatus = parseTaskStatus(status)
    if (taskStatus === null) return 0
    const row = (
      await db
        .select({ count: count() })
        .from(evaluationTasks)
        .where(and(eq(evaluationTasks.agentId, agentId), eq(evaluationTasks.status, taskStatus)))
        .limit(1)
    )[0]
    return row?.count ?? 0
  },

  getMaxConcurrency(): number {
    return EVALUATION_MAX_CONCURRENCY
  },

  async claimQueuedTasks(agentId: string): Promise<EvaluationTaskRow[]> {
    return withScmPathMutation(async (tx) => {
      const running =
        (
          await tx
            .select({ value: count() })
            .from(evaluationTasks)
            .where(and(eq(evaluationTasks.agentId, agentId), eq(evaluationTasks.status, 'running')))
            .limit(1)
        )[0]?.value ?? 0
      const available = EVALUATION_MAX_CONCURRENCY - running
      if (available <= 0) return []

      const queued = await tx
        .select({ id: evaluationTasks.id, agentId: evaluationTasks.agentId })
        .from(evaluationTasks)
        .where(and(eq(evaluationTasks.agentId, agentId), eq(evaluationTasks.status, 'queued')))
        .orderBy(asc(evaluationTasks.createdAt))
        .limit(available)
      const claimed: EvaluationTaskRow[] = []
      for (const task of queued) {
        const updated = await tx
          .update(evaluationTasks)
          .set({ status: 'running', updatedAt: new Date() })
          .where(and(eq(evaluationTasks.id, task.id), eq(evaluationTasks.status, 'queued')))
          .returning({ id: evaluationTasks.id })
        if (updated.length > 0) claimed.push(task)
      }
      return claimed
    })
  },

  async updateTaskStatus(taskId: string, status: string): Promise<void> {
    const taskStatus = parseTaskStatus(status)
    if (taskStatus === null) return
    await db
      .update(evaluationTasks)
      .set({ status: taskStatus, updatedAt: new Date() })
      .where(eq(evaluationTasks.id, taskId))
  },

  async tryTransitionTaskStatus(taskId: string, from: string, to: string): Promise<boolean> {
    const fromStatus = parseTaskStatus(from)
    const toStatus = parseTaskStatus(to)
    if (fromStatus === null || toStatus === null) return false
    const changed = await db
      .update(evaluationTasks)
      .set({ status: toStatus, updatedAt: new Date() })
      .where(and(eq(evaluationTasks.id, taskId), eq(evaluationTasks.status, fromStatus)))
      .returning({ id: evaluationTasks.id })
    return changed.length > 0
  },

  async getOldestQueuedTask(agentId: string): Promise<EvaluationTaskRow | undefined> {
    return (
      await db
        .select({ id: evaluationTasks.id, agentId: evaluationTasks.agentId })
        .from(evaluationTasks)
        .where(and(eq(evaluationTasks.agentId, agentId), eq(evaluationTasks.status, 'queued')))
        .orderBy(asc(evaluationTasks.createdAt))
        .limit(1)
    )[0]
  },

  async getTasksByStatus(status: string): Promise<EvaluationTaskRow[]> {
    const taskStatus = parseTaskStatus(status)
    if (taskStatus === null) return []
    return await db
      .select({ id: evaluationTasks.id, agentId: evaluationTasks.agentId })
      .from(evaluationTasks)
      .where(eq(evaluationTasks.status, taskStatus))
  },

  async failTask(taskId: string, reason: string): Promise<void> {
    const now = new Date()
    await db
      .update(evaluationTasks)
      .set({ status: 'failed', error: reason, finishedAt: now, updatedAt: now })
      .where(eq(evaluationTasks.id, taskId))

    // Result rows must be settled too, or the detail page shows cases spinning
    // forever under a task that has already failed.
    await db
      .update(evaluationResults)
      .set({ status: 'failed', error: reason, updatedAt: now })
      .where(
        and(
          eq(evaluationResults.taskId, taskId),
          inArray(evaluationResults.status, ['pending', 'running']),
        ),
      )
  },

  async getAgentIdsWithQueuedTasks(): Promise<string[]> {
    return await (
      await db
        .selectDistinct({ agentId: evaluationTasks.agentId })
        .from(evaluationTasks)
        .where(eq(evaluationTasks.status, 'queued'))
    ).map((r) => r.agentId)
  },
}
