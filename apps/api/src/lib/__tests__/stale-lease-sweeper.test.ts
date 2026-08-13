import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  listActiveExecutionLeases,
  completeExecutionLease,
  sweepStaleLeases,
  scheduleNext,
  executeChatRun,
  sweepOrphanedScmWorkloadLeases,
  retryPendingWorkspaceRemovalReleases,
} = vi.hoisted(() => ({
  listActiveExecutionLeases: vi.fn(),
  completeExecutionLease: vi.fn(),
  sweepStaleLeases: vi.fn(),
  scheduleNext: vi.fn(),
  executeChatRun: vi.fn(),
  sweepOrphanedScmWorkloadLeases: vi.fn(),
  retryPendingWorkspaceRemovalReleases: vi.fn(),
}))

vi.mock('../../engine/execution-lease-registry.js', () => ({
  listActiveExecutionLeases,
  completeExecutionLease,
}))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))
vi.mock('../../engine/task-queue.js', () => ({ sweepStaleLeases, scheduleNext }))
vi.mock('../execute-chat-run.js', () => ({ executeChatRun }))
vi.mock('../scm-lease-sweeper.js', () => ({ sweepOrphanedScmWorkloadLeases }))
vi.mock('../scm-workspace-removal.js', () => ({ retryPendingWorkspaceRemovalReleases }))
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
    retryPendingWorkspaceRemovalReleases.mockResolvedValue([])
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

  // A failed releaseScmWorkload is logged and never retried inline; this tick
  // is the retry. Without it a single failed delete permanently locks the
  // Agent's binding and the source's PATCH/DELETE.
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

  it('does not throw if a sweep fails', async () => {
    sweepStaleLeases.mockRejectedValue(new Error('db down'))
    startStaleLeaseSweeper(1000)
    // A rejected sweep must be caught inside the tick, not escape as an
    // unhandled rejection that would take the process down.
    await expect(vi.advanceTimersByTimeAsync(1000)).resolves.toBeDefined()
  })
})
