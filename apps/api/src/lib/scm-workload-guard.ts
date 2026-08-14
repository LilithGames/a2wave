import { and, eq, inArray } from 'drizzle-orm'
import type { db } from '../db/client.js'
import { evaluationTasks, runSteps, runs } from '../db/schema.js'
import { listActiveExecutionLeases } from '../engine/execution-lease-registry.js'
import { findDurableAgentScmWorkload } from './scm-workload-lifecycle.js'

type QueryExecutor = Pick<typeof db, 'select'>

const activeEvaluations = new Map<string, { taskId: string; agentId: string }>()

/** Keep cancelled evaluations protected until their workspace cleanup finishes. */
export function registerScmEvaluationWorkload(taskId: string, agentId: string): () => void {
  activeEvaluations.set(taskId, { taskId, agentId })
  return () => activeEvaluations.delete(taskId)
}

export function _resetScmWorkloadLeasesForTests(): void {
  activeEvaluations.clear()
}

/** Whether this process still runs or cleans up the given evaluation. */
export function isScmEvaluationWorkloadRegistered(taskId: string): boolean {
  return activeEvaluations.has(taskId)
}

export type ActiveAgentScmWorkload =
  | { type: 'run'; id: string }
  | { type: 'evaluation'; id: string }

/**
 * Find durable work that may still be using an Agent's current SCM checkout.
 *
 * An Agent binding is the source deletion protocol's durable reference. Letting
 * PATCH or DELETE remove that reference while work is active makes the source
 * deletable even though its subprocess still has the checkout as cwd. Both
 * queues persist their active states, so this guard also works across replicas
 * and process restarts instead of relying on an in-memory execution registry.
 */
export async function findActiveAgentScmWorkload(
  executor: QueryExecutor,
  agentId: string,
): Promise<ActiveAgentScmWorkload | null> {
  const leasedRun = listActiveExecutionLeases().find((lease) => lease.agentId === agentId)
  if (leasedRun) return { type: 'run', id: leasedRun.runId }

  const leasedEvaluation = [...activeEvaluations.values()].find(
    (workload) => workload.agentId === agentId,
  )
  if (leasedEvaluation) return { type: 'evaluation', id: leasedEvaluation.taskId }

  const durable = await findDurableAgentScmWorkload(executor, agentId)
  if (durable) return durable

  // A run may execute with an Agent other than runs.initiatorAgentId. The step
  // is the authoritative execution record, so protect that Agent as well.
  const executingStep = (
    await executor
      .select({ id: runSteps.runId })
      .from(runSteps)
      .where(and(eq(runSteps.agentId, agentId), eq(runSteps.status, 'running')))
      .limit(1)
  )[0]
  if (executingStep) return { type: 'run', id: executingStep.id }

  const activeRun = (
    await executor
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.initiatorAgentId, agentId),
          inArray(runs.status, ['pending', 'queued', 'running']),
        ),
      )
      .limit(1)
  )[0]
  if (activeRun) return { type: 'run', id: activeRun.id }

  const activeEvaluation = (
    await executor
      .select({ id: evaluationTasks.id })
      .from(evaluationTasks)
      .where(
        and(
          eq(evaluationTasks.agentId, agentId),
          inArray(evaluationTasks.status, ['pending', 'queued', 'running']),
        ),
      )
      .limit(1)
  )[0]
  return activeEvaluation ? { type: 'evaluation', id: activeEvaluation.id } : null
}
