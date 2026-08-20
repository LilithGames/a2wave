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
const mockWithScmPathMutation = vi.hoisted(() => vi.fn())
const mockActivateScmWorkloadInMutation = vi.hoisted(() => vi.fn())
const mockListActiveExecutionLeases = vi.hoisted(() =>
  vi.fn((): Array<{ runId: string; agentId?: string }> => []),
)

vi.mock('../execution-lease-registry.js', () => ({
  listActiveExecutionLeases: mockListActiveExecutionLeases,
}))

vi.mock('../../lib/scm-workload-lifecycle.js', () => ({
  withScmWorkloadAdmission: mockWithAdmission,
  activateScmWorkload: vi.fn(),
  activateScmWorkloadInMutation: mockActivateScmWorkloadInMutation,
  releaseReservedScmWorkload: vi.fn(),
}))
vi.mock('../../lib/scm-path-plan.js', () => ({ withScmPathMutation: mockWithScmPathMutation }))

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
    worktreeConfig: 'runs.worktree_config',
  },
  agents: {
    id: 'agents.id',
    maxConcurrency: 'agents.max_concurrency',
    workspaceType: 'agents.workspace_type',
  },
  runSteps: { runId: 'run_steps.run_id', status: 'run_steps.status' },
  scmWorkloadLeases: {
    id: 'scm_workload_leases.id',
    agentId: 'scm_workload_leases.agent_id',
    workloadType: 'scm_workload_leases.workload_type',
    phase: 'scm_workload_leases.phase',
  },
  scmWorkspaceRemovals: {
    id: 'scm_workspace_removals.id',
    scmSourceId: 'scm_workspace_removals.scm_source_id',
    workspaceName: 'scm_workspace_removals.workspace_name',
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
    mockListActiveExecutionLeases.mockReturnValue([])
    mockActivateScmWorkloadInMutation.mockResolvedValue(true)
    statusWrites = []
  })

  /**
   * Per-call select results. admitRun issues, in order: the running run ids
   * (awaited list), the active durable lease workload ids (awaited list), and
   * — only at capacity — the queued count (`.limit(1)` -> [{ value }]).
   */
  function admissionTx(selectRows: unknown[][], updated: Array<{ id: string }>) {
    let call = 0
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = selectRows[call++] ?? []
            return Object.assign(Promise.resolve(rows), {
              limit: vi.fn().mockResolvedValue(rows),
            })
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          statusWrites.push(values)
          return {
            where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(updated) })),
          }
        }),
      })),
    }
  }

  /** Payloads passed to `.set()` during admission, for ownership assertions. */
  let statusWrites: Array<Record<string, unknown>> = []

  it('rolls admission back when the Run row disappeared before the status claim', async () => {
    const tx = admissionTx([[], []], [])
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_missing' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_missing', 1)).rejects.toThrow(
      'disappeared before queue admission',
    )
  })

  it('returns the durable lease decision only after the Run status claim succeeds', async () => {
    const tx = admissionTx([[], []], [{ id: 'run_1' }])
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_1' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_1', 1)).resolves.toEqual({
      slot: 'acquired',
      hasScmLease: true,
      scmLeaseActivated: true,
    })
  })

  it('stamps the owning instance when admission acquires a slot', async () => {
    // admitRun is the primary admission path — every trigger reaches it. An
    // unstamped 'running' row is invisible to the orphaned-run reaper, so a
    // crash would strand it exactly as it did before the reaper existed.
    const tx = admissionTx([[], []], [{ id: 'run_1' }])
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: null }) => unknown) =>
        callback(tx, { leaseId: null }),
    )

    await taskQueueDb.admitRun?.('agt_1', 'run_1', 1)

    expect(statusWrites.at(-1)).toMatchObject({ status: 'running' })
    expect(statusWrites.at(-1)?.ownerInstanceId).toBeTruthy()
  })

  it('clears any stale owner when admission queues the run', async () => {
    // A conversation run row is reused across turns. If an earlier turn's
    // owner survived into a queued turn, the reaper would read the row as
    // abandoned and fail work a live instance is legitimately holding.
    const tx = admissionTx([[], [], [{ value: 0 }]], [{ id: 'run_2' }])
    mockListActiveExecutionLeases.mockReturnValue([{ runId: 'run_prev', agentId: 'agt_1' }])
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: null }) => unknown) =>
        callback(tx, { leaseId: null }),
    )

    await taskQueueDb.admitRun?.('agt_1', 'run_2', 1)

    expect(statusWrites.at(-1)).toMatchObject({ status: 'queued', ownerInstanceId: null })
  })

  it('rolls immediate SCM admission back when its durable lease cannot be activated', async () => {
    const tx = admissionTx([[], []], [{ id: 'run_1' }])
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_1' }),
    )
    mockActivateScmWorkloadInMutation.mockResolvedValue(false)

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_1', 1)).rejects.toThrow(
      /reserved durable lease/,
    )
  })

  it('queues while an earlier execution lease is still cleaning up', async () => {
    const tx = admissionTx([[], [], [{ value: 0 }]], [{ id: 'run_2' }])
    mockListActiveExecutionLeases.mockReturnValue([{ runId: 'run_prev', agentId: 'agt_1' }])
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_2' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_2', 1)).resolves.toEqual({
      slot: 'queued',
      hasScmLease: true,
      scmLeaseActivated: false,
    })
  })

  // The in-process registry is empty on every other replica, and a run in its
  // terminal-status-to-process-exit window is no longer `running` in the runs
  // table. The durable active lease is the only cross-replica record of that
  // window; ignoring it over-admits past maxConcurrency into a checkout
  // another replica's process is still writing.
  it('queues while a peer replica still holds an active durable lease', async () => {
    // running-in-db: none, durable active leases: one, queued: none
    const tx = admissionTx([[], [{ id: 'run_peer' }], [{ value: 0 }]], [{ id: 'run_3' }])
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_3' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_3', 1)).resolves.toEqual({
      slot: 'queued',
      hasScmLease: true,
      scmLeaseActivated: false,
    })
  })

  // The three occupancy views overlap but none subsumes another, so they must
  // be UNIONED by run id: a terminal run still holding its active cleanup
  // lease plus a second run already `running` (lease still reserved) is two
  // occupied slots. max(1, 0, 1) reported one and over-admitted a third run
  // at maxConcurrency=2.
  it('unions distinct occupants instead of taking the maximum of the counts', async () => {
    const tx = admissionTx(
      [
        [{ id: 'run_running' }], // status = running (lease merely reserved)
        [{ id: 'run_cleanup' }], // terminal, active cleanup lease
        [{ value: 0 }], // queued count
      ],
      [{ id: 'run_third' }],
    )
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_third' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_third', 2)).resolves.toEqual({
      slot: 'queued',
      hasScmLease: true,
      scmLeaseActivated: false,
    })
  })

  // A remover commits its durable reservation before touching the filesystem
  // — possibly on another replica. A run that names that exact worktree must
  // not be admitted into a directory that is mid-deletion.
  it('rejects admission of a run whose named worktree is being removed', async () => {
    const tx = admissionTx(
      [
        [{ worktreeConfig: { name: 'fix-bug' } }], // the run's explicit worktree
        [{ id: 'scm_1:fix-bug', workspaceName: 'fix-bug' }], // pending removal
      ],
      [],
    )
    mockWithAdmission.mockImplementation(
      (
        _input,
        callback: (
          executor: typeof tx,
          admission: { leaseId: string; scmSourceId: string },
        ) => unknown,
      ) => callback(tx, { leaseId: 'run:run_named', scmSourceId: 'scm_1' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_named', 1)).rejects.toThrow(/being removed/)
  })

  it('counts one occupant once when every view reports the same run', async () => {
    const tx = admissionTx([[{ id: 'run_same' }], [{ id: 'run_same' }]], [{ id: 'run_next' }])
    mockListActiveExecutionLeases.mockReturnValue([{ runId: 'run_same', agentId: 'agt_1' }])
    mockWithAdmission.mockImplementation(
      (_input, callback: (executor: typeof tx, admission: { leaseId: string }) => unknown) =>
        callback(tx, { leaseId: 'run:run_next' }),
    )

    await expect(taskQueueDb.admitRun?.('agt_1', 'run_next', 2)).resolves.toEqual({
      slot: 'acquired',
      hasScmLease: true,
      scmLeaseActivated: true,
    })
  })
})

describe('taskQueueDb queued promotion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('changes status and activates the durable lease in one SCM mutation', async () => {
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: 'run_q1' }]),
          })),
        })),
      })),
    }
    mockWithScmPathMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) =>
      fn(tx as never),
    )
    mockActivateScmWorkloadInMutation.mockResolvedValue(true)

    await expect(taskQueueDb.promoteQueuedRun?.('agt_1', 'run_q1', 99)).resolves.toBe(true)

    expect(mockWithScmPathMutation).toHaveBeenCalledTimes(1)
    expect(mockActivateScmWorkloadInMutation).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ type: 'run', workloadId: 'run_q1' }),
    )
  })

  it('rolls promotion back when an SCM run has lost its reserved durable lease', async () => {
    let selectCall = 0
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const rows = selectCall++ === 2 ? [{ workspaceType: 'scm' }] : []
            return Object.assign(Promise.resolve(rows), {
              limit: vi.fn().mockResolvedValue(rows),
            })
          }),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: 'run_q1' }]),
          })),
        })),
      })),
    }
    mockWithScmPathMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) =>
      fn(tx as never),
    )
    mockActivateScmWorkloadInMutation.mockResolvedValue(false)

    await expect(taskQueueDb.promoteQueuedRun?.('agt_1', 'run_q1', 99)).rejects.toThrow(
      /reserved durable lease/,
    )
  })

  it('does not activate a lease when another promoter won the status CAS', async () => {
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
        })),
      })),
    }
    mockWithScmPathMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) =>
      fn(tx as never),
    )

    await expect(taskQueueDb.promoteQueuedRun?.('agt_1', 'run_q1', 1)).resolves.toBe(false)
    expect(mockActivateScmWorkloadInMutation).not.toHaveBeenCalled()
  })

  it('does not claim the queued run when the transactional capacity re-check is full', async () => {
    let selectCall = 0
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve(selectCall++ === 0 ? [{ id: 'run_live' }] : [])),
        })),
      })),
      update: vi.fn(),
    }
    mockWithScmPathMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) =>
      fn(tx as never),
    )

    await expect(taskQueueDb.promoteQueuedRun?.('agt_1', 'run_q1', 1)).resolves.toBe(false)
    expect(tx.update).not.toHaveBeenCalled()
    expect(mockActivateScmWorkloadInMutation).not.toHaveBeenCalled()
  })
})
