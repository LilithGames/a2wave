import { and, eq, inArray } from 'drizzle-orm'
import type { db } from '../db/client.js'
import { evaluationTasks, runs } from '../db/schema.js'

type QueryExecutor = Pick<typeof db, 'select'>

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
