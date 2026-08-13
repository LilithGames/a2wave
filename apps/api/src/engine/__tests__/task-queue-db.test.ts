import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDbSelect = vi.fn()
const mockDbFrom = vi.fn()
const mockDbSet = vi.fn()
const mockDbWhere = vi.fn()
const mockDbGet = vi.fn()
const mockDbAll = vi.fn()
const mockDbUpdate = vi.fn()
const mockDbOrderBy = vi.fn()
const mockDbLimit = vi.fn()
const mockWithAdmission = vi.hoisted(() => vi.fn())
const mockCountActiveExecutionLeases = vi.hoisted(() => vi.fn(() => 0))

vi.mock('../execution-lease-registry.js', () => ({
  countActiveExecutionLeases: mockCountActiveExecutionLeases,
}))

vi.mock('../../lib/scm-workload-lifecycle.js', () => ({
  withScmWorkloadAdmission: mockWithAdmission,
  activateScmWorkload: vi.fn(),
  releaseReservedScmWorkload: vi.fn(),
}))

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
    update: () => ({ set: mockDbSet }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  runs: {
    id: 'runs.id',
    initiatorAgentId: 'runs.initiator_agent_id',
    status: 'runs.status',
    createdAt: 'runs.created_at',
  },
  agents: { id: 'agents.id', maxConcurrency: 'agents.max_concurrency' },
  runSteps: { runId: 'run_steps.run_id', status: 'run_steps.status' },
  scmWorkloadLeases: {
    id: 'scm_workload_leases.id',
    agentId: 'scm_workload_leases.agent_id',
    workloadType: 'scm_workload_leases.workload_type',
    phase: 'scm_workload_leases.phase',
  },
}))

import { taskQueueDb } from '../task-queue-db.js'

/**
 * Model the async builder: a single-row lookup ends in `.limit(1)` and resolves
 * to an array the caller destructures, while a list query is awaited directly.
 * `get`/`all` are kept as the test-facing names so the assertions below still
 * read as "the row this finds" / "the rows this finds".
 */
function chainSelect(whereResult: { get: () => unknown; all?: () => unknown[] }) {
  const rows = () => {
    const row = whereResult.get()
    return row === null || row === undefined ? [] : [row]
  }
  const listed = () => whereResult.all?.() ?? []
  // A list query is awaited directly, so what `.where()` returns has to be
  // awaitable. Built from a real Promise (rather than a hand-written `then`
  // property) and extended with the builder methods — a genuine thenable, and it
  // does not trip lint's noThenProperty.
  mockDbFrom.mockReturnValue({
    where: () =>
      Object.assign(Promise.resolve(listed()), {
        limit: () => Promise.resolve(rows()),
        orderBy: () => ({ limit: () => Promise.resolve(rows()) }),
      }),
  })
  return whereResult
}

describe('taskQueueDb runtime status validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('countRunsByStatus 传入非法 status 时返回 0，不向 DB 传入非法值', async () => {
    const getSpy = vi.fn().mockReturnValue({ count: 10 })
    chainSelect({ get: getSpy })

    const result = await taskQueueDb.countRunsByStatus('agt_1', 'invalid_status' as string)

    expect(result).toBe(0)
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('countRunsByStatus 传入合法 status 时正常查询并返回计数', async () => {
    const getSpy = vi.fn().mockReturnValue({ count: 3 })
    chainSelect({ get: getSpy })

    const result = await taskQueueDb.countRunsByStatus('agt_1', 'running')

    expect(result).toBe(3)
    expect(getSpy).toHaveBeenCalled()
  })

  it('updateRunStatus 传入非法 status 时不执行更新', async () => {
    const runSpy = vi.fn()
    mockDbSet.mockReturnValue({
      where: (w: unknown) => {
        runSpy(w)
        return Promise.resolve(undefined)
      },
    })

    await taskQueueDb.updateRunStatus('run_1', 'invalid_status' as string)

    expect(runSpy).not.toHaveBeenCalled()
  })

  it('getRunsByStatus 传入非法 status 时返回空数组', async () => {
    const allSpy = vi.fn().mockReturnValue([{ id: 'run_1' }])
    chainSelect({ get: () => null, all: allSpy })

    const result = await taskQueueDb.getRunsByStatus('agt_1', 'invalid_status' as string)

    expect(result).toEqual([])
    expect(allSpy).not.toHaveBeenCalled()
  })

  it('failRunWithError 同时更新 step output.error 和 run result.error', async () => {
    const runSpy = vi.fn()
    mockDbSet.mockReturnValue({
      where: (w: unknown) => {
        runSpy(w)
        return Promise.resolve(undefined)
      },
    })

    await taskQueueDb.failRunWithError('run_1', 'Interrupted by a server restart')

    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({ output: { error: 'Interrupted by a server restart' } }),
    )
    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({ result: { error: 'Interrupted by a server restart' } }),
    )
    expect(runSpy).toHaveBeenCalledTimes(2)
  })
})

describe('taskQueueDb queue admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function admissionTx(updated: Array<{ id: string }>) {
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ value: 0 }]) })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(updated) })),
        })),
      })),
    }
  }

  it('rolls admission back when the Run row disappeared before the status claim', async () => {
    const tx = admissionTx([])
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_missing' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_missing', 1)).rejects.toThrow(
      'disappeared before queue admission',
    )
  })

  it('returns the durable lease decision only after the Run status claim succeeds', async () => {
    const tx = admissionTx([{ id: 'run_1' }])
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_1' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_1', 1)).resolves.toEqual({
      slot: 'acquired',
      hasScmLease: true,
    })
  })

  it('queues while an earlier execution lease is still cleaning up', async () => {
    const tx = admissionTx([{ id: 'run_2' }])
    mockCountActiveExecutionLeases.mockReturnValue(1)
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_2' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_2', 1)).resolves.toEqual({
      slot: 'queued',
      hasScmLease: true,
    })
  })

  /** Per-call select results, so the running/lease/queued counts can differ. */
  function admissionTxSequenced(counts: number[], updated: Array<{ id: string }>) {
    let call = 0
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ value: counts[call++] ?? 0 }]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(updated) })),
        })),
      })),
    }
  }

  // The in-process registry is empty on every other replica, and a run in its
  // terminal-status-to-process-exit window no longer counts as `running` in
  // the runs table. The durable active lease is the only cross-replica record
  // of that window; ignoring it over-admits past maxConcurrency into a
  // checkout another replica's process is still writing.
  it('queues while a peer replica still holds an active durable lease', async () => {
    // running-in-db: 0, durable active leases: 1, queued: 0
    const tx = admissionTxSequenced([0, 1, 0], [{ id: 'run_3' }])
    mockCountActiveExecutionLeases.mockReturnValue(0)
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_3' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_3', 1)).resolves.toEqual({
      slot: 'queued',
      hasScmLease: true,
    })
  })
})
