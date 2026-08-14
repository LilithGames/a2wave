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
}))

vi.mock('../../engine/execution-lease-registry.js', () => ({
  listActiveExecutionLeases,
  completeExecutionLease,
}))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))
vi.mock('../../engine/task-queue.js', () => ({ sweepStaleLeases, scheduleNext }))
vi.mock('../../engine/evaluation-queue-db.js', () => ({ evaluationQueueDb: {} }))
vi.mock('../../engine/evaluation-queue.js', () => ({ scheduleNextEvaluation }))
vi.mock('../execute-chat-run.js', () => ({ executeChatRun }))
vi.mock('../scm-lease-sweeper.js', () => ({
  sweepOrphanedScmWorkloadLeases,
  failScmWorkloadsOfDeadInstances,
}))
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
    vi.useFakeTimers()
    listActiveExecutionLeases.mockResolvedValue([])
    sweepStaleLeases.mockResolvedValue([])
    sweepOrphanedScmWorkloadLeases.mockResolvedValue([])
    failScmWorkloadsOfDeadInstances.mockResolvedValue([])
    retryPendingWorkspaceRemovalReleases.mockResolvedValue([])
    pruneDeadInstanceHeartbeats.mockResolvedValue(undefined)
    reconcileAbandonedWorkspaceRemovals.mockResolvedValue([])
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
