import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  listActiveExecutionLeases,
  completeExecutionLease,
  sweepStaleLeases,
  scheduleNext,
  scheduleNextEvaluation,
  executeChatRun,
  sweepOrphanedScmWorkloadLeases,
  failScmWorkloadsOfDeadInstances,
  retryPendingWorkspaceRemovalReleases,
  pruneDeadInstanceHeartbeats,
  reconcileAbandonedWorkspaceRemovals,
  reapOrphanedRuns,
  getQueuedRunAgentIds,
  taskQueueDb,
} = vi.hoisted(() => ({
  listActiveExecutionLeases: vi.fn(),
  completeExecutionLease: vi.fn(),
  sweepStaleLeases: vi.fn(),
  scheduleNext: vi.fn(),
  scheduleNextEvaluation: vi.fn(),
  executeChatRun: vi.fn(),
  sweepOrphanedScmWorkloadLeases: vi.fn(),
  failScmWorkloadsOfDeadInstances: vi.fn(),
  retryPendingWorkspaceRemovalReleases: vi.fn(),
  pruneDeadInstanceHeartbeats: vi.fn(),
  reconcileAbandonedWorkspaceRemovals: vi.fn(),
  reapOrphanedRuns: vi.fn(),
  getQueuedRunAgentIds: vi.fn(),
  taskQueueDb: {},
}))

vi.mock('../../engine/execution-lease-registry.js', () => ({
  listActiveExecutionLeases,
  completeExecutionLease,
  reserveExecutionLease: vi.fn(),
}))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb, getQueuedRunAgentIds }))
vi.mock('../../engine/task-queue.js', () => ({ sweepStaleLeases, scheduleNext }))
vi.mock('../../engine/evaluation-queue-db.js', () => ({ evaluationQueueDb: {} }))
vi.mock('../../engine/evaluation-queue.js', () => ({ scheduleNextEvaluation }))
vi.mock('../execute-chat-run.js', () => ({ executeChatRun }))
vi.mock('../scm-lease-sweeper.js', () => ({
  sweepOrphanedScmWorkloadLeases,
  failScmWorkloadsOfDeadInstances,
}))
vi.mock('../orphaned-run-reaper.js', () => ({ reapOrphanedRuns }))
vi.mock('../scm-workspace-removal.js', () => ({ retryPendingWorkspaceRemovalReleases }))
vi.mock('../scm-workspace-removal-reconciler.js', () => ({ reconcileAbandonedWorkspaceRemovals }))
vi.mock('../instance-heartbeat.js', () => ({ pruneDeadInstanceHeartbeats }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { startStaleLeaseSweeper } from '../stale-lease-sweeper.js'

describe('startStaleLeaseSweeper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scheduleNext.mockReset()
    getQueuedRunAgentIds.mockReset().mockResolvedValue([])
    vi.useFakeTimers()
    listActiveExecutionLeases.mockResolvedValue([])
    sweepStaleLeases.mockResolvedValue([])
    sweepOrphanedScmWorkloadLeases.mockResolvedValue([])
    failScmWorkloadsOfDeadInstances.mockResolvedValue([])
    retryPendingWorkspaceRemovalReleases.mockResolvedValue([])
    pruneDeadInstanceHeartbeats.mockResolvedValue(undefined)
    reconcileAbandonedWorkspaceRemovals.mockResolvedValue([])
    reapOrphanedRuns.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sweeps on every interval tick', async () => {
    const stop = startStaleLeaseSweeper(1000)
    expect(sweepStaleLeases).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(sweepStaleLeases).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1000)
    expect(sweepStaleLeases).toHaveBeenCalledTimes(2)

    stop()
    vi.advanceTimersByTime(5000)
    expect(sweepStaleLeases).toHaveBeenCalledTimes(2) // stopped, no more ticks
  })

  // The owner retries inline while alive; this sweep remains the recovery path
  // if the owner disappears after its first failed delete.
  it('sweeps orphaned durable SCM workload leases on every tick', async () => {
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)
    expect(sweepOrphanedScmWorkloadLeases).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(sweepOrphanedScmWorkloadLeases).toHaveBeenCalledTimes(2)

    stop()
  })

  it('retries this process workspace-reservation releases on every tick', async () => {
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)
    expect(retryPendingWorkspaceRemovalReleases).toHaveBeenCalledTimes(1)

    stop()
  })

  it('still sweeps durable leases when the execution-lease sweep throws', async () => {
    sweepStaleLeases.mockRejectedValue(new Error('db unavailable'))
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)
    expect(sweepOrphanedScmWorkloadLeases).toHaveBeenCalledTimes(1)

    stop()
  })

  it('nudges scheduleNext once per affected agent after releasing leases', async () => {
    sweepStaleLeases.mockResolvedValue([
      { runId: 'run_1', agentId: 'agt_a' },
      { runId: 'run_2', agentId: 'agt_a' }, // same agent → deduped
      { runId: 'run_3', agentId: 'agt_b' },
    ])
    startStaleLeaseSweeper(1000)
    // The tick handler awaits the sweep, so the nudges land on a later
    // microtask than the timer advance itself.
    await vi.advanceTimersByTimeAsync(1000)

    expect(scheduleNext).toHaveBeenCalledTimes(2) // agt_a + agt_b, not 3
    const agents = scheduleNext.mock.calls.map((c) => c[1])
    expect(new Set(agents)).toEqual(new Set(['agt_a', 'agt_b']))
  })

  it('nudges the Run queue after a durable lease retry frees its capacity', async () => {
    sweepOrphanedScmWorkloadLeases.mockResolvedValue([
      { type: 'run', workloadId: 'run_1', agentId: 'agt_a' },
      { type: 'run', workloadId: 'run_2', agentId: 'agt_a' },
      { type: 'evaluation', workloadId: 'evt_1', agentId: 'agt_b' },
    ])
    startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(scheduleNext).toHaveBeenCalledTimes(1)
    expect(scheduleNext.mock.calls[0]?.[1]).toBe('agt_a')
  })

  it('reaps workloads of dead instances BEFORE sweeping their leases', async () => {
    // Ordering is the point: the reaper makes a crashed instance's workload
    // terminal, and only then can the sweep release its lease. Reversed, the
    // release would wait a whole tick for no reason.
    const order: string[] = []
    failScmWorkloadsOfDeadInstances.mockImplementation(async () => {
      order.push('reap')
      return []
    })
    sweepOrphanedScmWorkloadLeases.mockImplementation(async () => {
      order.push('sweep')
      return []
    })
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(order).toEqual(['reap', 'sweep'])
    stop()
  })

  it('still sweeps leases when the dead-instance reaper throws', async () => {
    failScmWorkloadsOfDeadInstances.mockRejectedValue(new Error('db unavailable'))
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(sweepOrphanedScmWorkloadLeases).toHaveBeenCalledTimes(1)
    stop()
  })

  it('nudges the evaluation queue when a released lease frees evaluation capacity', async () => {
    // Evaluations are serial per Agent, so a leaked lease stalls that Agent's
    // entire evaluation queue until an unrelated trigger arrives.
    sweepOrphanedScmWorkloadLeases.mockResolvedValue([
      { type: 'evaluation', workloadId: 'evt_1', agentId: 'agt_b' },
    ])
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(scheduleNextEvaluation).toHaveBeenCalledTimes(1)
    expect(scheduleNextEvaluation.mock.calls[0]?.[1]).toBe('agt_b')
    stop()
  })

  it('nudges the run queue after reaping a run abandoned by a dead instance', async () => {
    // Settling the row is only half the fix: the freed concurrency slot must
    // also restart promotion. `scheduleNext` runs at boot and on completion,
    // so a slot freed at any other moment leaves the queue parked until an
    // unrelated trigger arrives — which is how a queue stays stuck for hours.
    reapOrphanedRuns.mockResolvedValue([{ runId: 'run_1', agentId: 'agt_a' }])
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(scheduleNext).toHaveBeenCalledTimes(1)
    expect(scheduleNext.mock.calls[0]?.[1]).toBe('agt_a')
    stop()
  })

  it('nudges each Agent once when several of its runs are reaped', async () => {
    reapOrphanedRuns.mockResolvedValue([
      { runId: 'run_1', agentId: 'agt_a' },
      { runId: 'run_2', agentId: 'agt_a' },
      { runId: 'run_3', agentId: 'agt_b' },
    ])
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(scheduleNext).toHaveBeenCalledTimes(2)
    expect(scheduleNext.mock.calls.map((call) => call[1]).sort()).toEqual(['agt_a', 'agt_b'])
    stop()
  })

  it('still runs later passes when the orphaned-run reaper throws', async () => {
    reapOrphanedRuns.mockRejectedValue(new Error('reap failed'))
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(pruneDeadInstanceHeartbeats).toHaveBeenCalledTimes(1)
    stop()
  })

  it('reconciles abandoned workspace removals on every tick', async () => {
    // This tick IS the retry loop for a failed removal, which is why the
    // owner's inline retries can be bounded.
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)
    expect(reconcileAbandonedWorkspaceRemovals).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(reconcileAbandonedWorkspaceRemovals).toHaveBeenCalledTimes(2)

    stop()
  })

  it('keeps reconciling removals when an earlier sweep throws', async () => {
    sweepOrphanedScmWorkloadLeases.mockRejectedValue(new Error('db unavailable'))
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(reconcileAbandonedWorkspaceRemovals).toHaveBeenCalledTimes(1)
    stop()
  })

  it('promotes queued work after a peer releases its sync claim without any lease release', async () => {
    const { scheduleNext: realScheduleNext } = await vi.importActual<
      typeof import('../../engine/task-queue.js')
    >('../../engine/task-queue.js')
    let syncing = true
    let queued = true
    Object.assign(taskQueueDb, {
      getAgentMaxConcurrency: async () => 1,
      countOccupiedSlots: async () => (queued ? 0 : 1),
      getOldestQueuedRun: async () => (queued ? { id: 'run_waiting' } : undefined),
      promoteQueuedRun: async () => {
        if (syncing) throw new Error('SCM source is syncing')
        queued = false
        return true
      },
    })
    scheduleNext.mockImplementation(realScheduleNext)
    getQueuedRunAgentIds.mockImplementation(async () => (queued ? ['agt_waiting'] : []))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = startStaleLeaseSweeper(1000)
    try {
      // The completion nudge loses to a sync; the accepted run stays queued.
      await realScheduleNext(taskQueueDb as never, 'agt_waiting', executeChatRun)
      await vi.advanceTimersByTimeAsync(1000)
      expect(queued).toBe(true)
      expect(executeChatRun).not.toHaveBeenCalled()

      // The peer releases its sync claim, including after indexing. Nothing
      // finishes locally, so only durable queue reconciliation can retry.
      syncing = false
      await vi.advanceTimersByTimeAsync(1000)
      expect(executeChatRun).toHaveBeenCalledExactlyOnceWith('agt_waiting', 'run_waiting')
      await vi.advanceTimersByTimeAsync(2000)
      expect(executeChatRun).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      errorLog.mockRestore()
    }
  })

  it('continues past a syncing agent and respects shutdown promotion pause', async () => {
    const queue = await vi.importActual<typeof import('../../engine/task-queue.js')>(
      '../../engine/task-queue.js',
    )
    let queued = true
    Object.assign(taskQueueDb, {
      getAgentMaxConcurrency: async () => 1,
      countOccupiedSlots: async () => 0,
      getOldestQueuedRun: async (agentId: string) =>
        agentId === 'agt_syncing' || queued ? { id: `run_${agentId}` } : undefined,
      promoteQueuedRun: async (agentId: string) => {
        if (agentId === 'agt_syncing') throw new Error('SCM source is syncing')
        queued = false
        return true
      },
    })
    scheduleNext.mockImplementation(queue.scheduleNext)
    getQueuedRunAgentIds.mockResolvedValue(['agt_syncing', 'agt_ready'])
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = startStaleLeaseSweeper(1000)
    queue.pauseTaskQueuePromotions()
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(executeChatRun).not.toHaveBeenCalled()
      queue._resumeTaskQueuePromotionsForTests()
      await vi.advanceTimersByTimeAsync(1000)
      expect(executeChatRun).toHaveBeenCalledExactlyOnceWith('agt_ready', 'run_agt_ready')
    } finally {
      stop()
      errorLog.mockRestore()
      queue._resumeTaskQueuePromotionsForTests()
    }
  })

  it('does not overlap durable queue scans when a scan outlasts the interval', async () => {
    let resolveScan!: (agents: string[]) => void
    getQueuedRunAgentIds.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveScan = resolve
        }),
    )
    const stop = startStaleLeaseSweeper(1000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(getQueuedRunAgentIds).toHaveBeenCalledTimes(1)
    resolveScan([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(getQueuedRunAgentIds).toHaveBeenCalledTimes(2)
    stop()
  })

  it('retries a failed durable queue scan on the next interval', async () => {
    getQueuedRunAgentIds.mockRejectedValueOnce(new Error('peer database unavailable'))
    getQueuedRunAgentIds.mockResolvedValue(['agt_waiting'])
    const stop = startStaleLeaseSweeper(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(scheduleNext).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(scheduleNext).toHaveBeenCalledWith(taskQueueDb, 'agt_waiting', expect.any(Function))
    stop()
  })

  it('prunes long-dead instance heartbeat tombstones', async () => {
    const stop = startStaleLeaseSweeper(1000)

    await vi.advanceTimersByTimeAsync(1000)

    expect(pruneDeadInstanceHeartbeats).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not throw if a sweep fails', async () => {
    sweepStaleLeases.mockRejectedValue(new Error('db down'))
    startStaleLeaseSweeper(1000)
    // A rejected sweep must be caught inside the tick, not escape as an
    // unhandled rejection that would take the process down.
    await expect(vi.advanceTimersByTimeAsync(1000)).resolves.toBeDefined()
  })
})
