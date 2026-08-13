import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, scmSources } from '../db/schema.js'
import { type TransactionHandle, runExclusive } from '../db/transaction.js'
import { withScmPathMutation } from './scm-path-plan.js'
import { type ActiveAgentScmWorkload, findActiveAgentScmWorkload } from './scm-workload-guard.js'
import { withAgentScmWorkloadLock } from './scm-workload-lock.js'

export interface BindingMutationDeps {
  withAgentLock: typeof withAgentScmWorkloadLock
  withMutation: typeof withScmPathMutation
  runSerialized: typeof runExclusive
  findActive: typeof findActiveAgentScmWorkload
}

const defaultDeps: BindingMutationDeps = {
  withAgentLock: withAgentScmWorkloadLock,
  withMutation: withScmPathMutation,
  runSerialized: runExclusive,
  findActive: findActiveAgentScmWorkload,
}

export type AgentBindingMutationResult<T> =
  | { allowed: true; value: T; active?: undefined }
  | { allowed: false; value?: undefined; active?: ActiveAgentScmWorkload }

export interface AgentBindingMutationInput<T> {
  agentId: string
  requestedWorkspaceType?: 'temp' | 'scm'
  requestedScmSourceId?: string | null
  mutate: (executor: typeof db) => Promise<T>
}

/** Reload and mutate an Agent's binding inside the SCM lifecycle boundary. */
export async function mutateAgentBinding<T>(
  input: AgentBindingMutationInput<T>,
  deps: BindingMutationDeps = defaultDeps,
): Promise<AgentBindingMutationResult<T>> {
  if (input.requestedWorkspaceType === undefined && input.requestedScmSourceId === undefined) {
    return { allowed: true, value: await deps.runSerialized(() => input.mutate(db)) }
  }

  return deps.withAgentLock(input.agentId, () =>
    deps.withMutation(async (tx) => {
      const current = await loadBinding(tx, input.agentId)
      if (!current) return { allowed: false }
      const workspaceType = input.requestedWorkspaceType ?? current.workspaceType
      const scmSourceId =
        input.requestedScmSourceId !== undefined ? input.requestedScmSourceId : current.scmSourceId
      const releases =
        current.workspaceType === 'scm' &&
        current.scmSourceId !== null &&
        (workspaceType !== 'scm' || scmSourceId !== current.scmSourceId)
      const establishes =
        workspaceType === 'scm' &&
        scmSourceId !== null &&
        (current.workspaceType !== 'scm' || scmSourceId !== current.scmSourceId)

      if (releases || establishes) {
        const active = await deps.findActive(tx, input.agentId)
        if (active) return { allowed: false, active }
      }
      if (establishes && !(await isReadySource(tx, scmSourceId))) return { allowed: false }
      return { allowed: true, value: await input.mutate(tx as typeof db) }
    }),
  )
}

export async function deleteAgentWithBindingGuard<T>(
  agentId: string,
  remove: (executor: typeof db) => Promise<T>,
  deps: BindingMutationDeps = defaultDeps,
): Promise<AgentBindingMutationResult<T>> {
  return deps.withAgentLock(agentId, () =>
    deps.withMutation(async (tx) => {
      const current = await loadBinding(tx, agentId)
      if (!current) return { allowed: false }
      if (current.workspaceType === 'scm' && current.scmSourceId) {
        const active = await deps.findActive(tx, agentId)
        if (active) return { allowed: false, active }
      }
      return { allowed: true, value: await remove(tx as typeof db) }
    }),
  )
}

async function loadBinding(tx: TransactionHandle, agentId: string) {
  return (
    await tx
      .select({ workspaceType: agents.workspaceType, scmSourceId: agents.scmSourceId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
  )[0]
}

async function isReadySource(tx: TransactionHandle, sourceId: string): Promise<boolean> {
  const source = (
    await tx
      .select({ initialSyncCompletedAt: scmSources.initialSyncCompletedAt })
      .from(scmSources)
      .where(and(eq(scmSources.id, sourceId), isNull(scmSources.deletionRequestedAt)))
      .limit(1)
  )[0]
  return source?.initialSyncCompletedAt != null
}
