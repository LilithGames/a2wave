import { describe, expect, it, vi } from 'vitest'
import type { db } from '../../db/client.js'
import {
  type BindingMutationDeps,
  deleteAgentWithBindingGuard,
  mutateAgentBinding,
} from '../agent-scm-binding-mutation.js'

function transactionWithRows(...rows: unknown[]) {
  const pending = [...rows]
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            const row = pending.shift()
            return row === undefined ? [] : [row]
          }),
        })),
      })),
    })),
  } as unknown as typeof db
  return tx
}

function dependencies(tx: typeof db, active: { type: 'run'; id: string } | null = null) {
  let serializedCalls = 0
  const withAgentLock: BindingMutationDeps['withAgentLock'] = async <T>(
    _id: string,
    operation: () => Promise<T>,
  ) => operation()
  const withMutation: BindingMutationDeps['withMutation'] = async <T>(
    operation: (executor: typeof db) => Promise<T>,
  ) => operation(tx)
  const runSerialized: BindingMutationDeps['runSerialized'] = async <T>(
    operation: () => Promise<T>,
  ) => {
    serializedCalls++
    return operation()
  }
  return {
    withAgentLock,
    withMutation,
    runSerialized,
    findActive: vi.fn().mockResolvedValue(active),
    serializedCalls: () => serializedCalls,
  }
}

describe('Agent SCM binding mutation', () => {
  it('treats an explicit null source id as an SCM unbind', async () => {
    const tx = transactionWithRows({ workspaceType: 'scm', scmSourceId: 'scm_live' })
    const deps = dependencies(tx, { type: 'run', id: 'run_active' })
    const mutate = vi.fn()

    const result = await mutateAgentBinding(
      { agentId: 'agt_1', requestedScmSourceId: null, mutate },
      deps,
    )

    expect(result).toEqual({ allowed: false, active: { type: 'run', id: 'run_active' } })
    expect(deps.findActive).toHaveBeenCalledOnce()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('rechecks a stale PATCH binding inside the lifecycle transaction', async () => {
    const tx = transactionWithRows({ workspaceType: 'scm', scmSourceId: 'scm_live' })
    const deps = dependencies(tx, { type: 'run', id: 'run_active' })
    const mutate = vi.fn()

    const result = await mutateAgentBinding(
      {
        agentId: 'agt_1',
        requestedWorkspaceType: 'temp',
        requestedScmSourceId: null,
        mutate,
      },
      deps,
    )

    expect(result).toEqual({ allowed: false, active: { type: 'run', id: 'run_active' } })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('blocks a temp-to-SCM transition while admitted work is active', async () => {
    const tx = transactionWithRows({ workspaceType: 'temp', scmSourceId: null })
    const deps = dependencies(tx, { type: 'run', id: 'run_temp' })

    const result = await mutateAgentBinding(
      {
        agentId: 'agt_1',
        requestedWorkspaceType: 'scm',
        requestedScmSourceId: 'scm_1',
        mutate: vi.fn(),
      },
      deps,
    )

    expect(result).toEqual({ allowed: false, active: { type: 'run', id: 'run_temp' } })
  })

  it('requires a ready, non-deleting source before establishing a binding', async () => {
    const tx = transactionWithRows(
      { workspaceType: 'temp', scmSourceId: null },
      { initialSyncCompletedAt: null },
    )
    const deps = dependencies(tx)
    const mutate = vi.fn()

    const result = await mutateAgentBinding(
      {
        agentId: 'agt_1',
        requestedWorkspaceType: 'scm',
        requestedScmSourceId: 'scm_1',
        mutate,
      },
      deps,
    )

    expect(result).toEqual({ allowed: false })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('serializes a non-binding mutation with SQLite transaction ownership', async () => {
    const tx = transactionWithRows()
    const deps = dependencies(tx)
    const mutate = vi.fn().mockResolvedValue('updated')

    const result = await mutateAgentBinding({ agentId: 'agt_1', mutate }, deps)

    expect(result).toEqual({ allowed: true, value: 'updated' })
    expect(deps.serializedCalls()).toBe(1)
  })

  it('rechecks the current binding before deleting an Agent', async () => {
    const tx = transactionWithRows({ workspaceType: 'scm', scmSourceId: 'scm_live' })
    const deps = dependencies(tx, { type: 'run', id: 'run_active' })
    const remove = vi.fn()

    const result = await deleteAgentWithBindingGuard('agt_1', remove, deps)

    expect(result).toEqual({ allowed: false, active: { type: 'run', id: 'run_active' } })
    expect(remove).not.toHaveBeenCalled()
  })
})
