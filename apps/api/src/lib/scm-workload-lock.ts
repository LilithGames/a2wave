import { withKeyedLock } from './keyed-mutex.js'

/**
 * Serialize admission of work that may use an Agent's SCM checkout with
 * releasing that Agent's SCM binding. The database SCM mutation lock protects
 * persisted source/path state; this per-Agent lock closes the in-process gap
 * between the durable workload check and reserving an execution lease.
 */
export function withAgentScmWorkloadLock<T>(
  agentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(`agent-scm-workload:${agentId}`, operation)
}
