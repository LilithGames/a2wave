import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FAILURE_REASONS } from '../../lib/run-failure-reasons.js'
import {
  _resetExecutionLeasesForTests,
  beginExecutionLease,
  cancelExecutionLease,
  completeExecutionLease,
  countActiveExecutionLeases,
  listActiveExecutionLeases,
} from '../execution-lease-registry.js'
import {
  _resumeTaskQueuePromotionsForTests,
  DEFAULT_PENDING_ORPHAN_TIMEOUT_MS,
  MAX_QUEUE_LENGTH,
  parsePendingOrphanTimeoutMs,
  pauseTaskQueuePromotions,
  recoverOnStartup,
  scheduleNext,
  sweepStaleLeases,
  type TaskQueueDb,
  tryAcquireSlot,
} from '../task-queue.js'

function createMockDb(overrides: Partial<TaskQueueDb> = {}): TaskQueueDb {
  return {
    // Every method resolves: the TaskQueueDb contract is async now, because the
    // PostgreSQL driver has no synchronous API.
    countRunsByStatus: vi.fn().mockResolvedValue(0),
    getRunStatus: vi.fn().mockResolvedValue('running'),
    getAgentMaxConcurrency: vi.fn().mockResolvedValue(1),
    updateRunStatus: vi.fn().mockResolvedValue(undefined),
    tryTransitionRunStatus: vi.fn().mockResolvedValue(true),
    failRunSteps: vi.fn().mockResolvedValue(undefined),
    failRunWithError: vi.fn().mockResolvedValue(undefined),
    failRunWithStructuredReason: vi.fn().mockResolvedValue(undefined),
    getOldestQueuedRun: vi.fn().mockResolvedValue(undefined),
    getRunsByStatus: vi.fn().mockResolvedValue([]),
    getOrphanedPendingRuns: vi.fn().mockResolvedValue([]),
    getDanglingPendingRuns: vi.fn().mockResolvedValue([]),
    getDanglingQueuedRuns: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

beforeEach(() => {
  _resetExecutionLeasesForTests()
  _resumeTaskQueuePromotionsForTests()
})

describe('parsePendingOrphanTimeoutMs', () => {
  it('使用正数环境变量覆盖默认 pending orphan 超时', async () => {
    expect(parsePendingOrphanTimeoutMs('120000')).toBe(120_000)
  })

  it('非法值回退到默认超时', async () => {
    expect(parsePendingOrphanTimeoutMs('0')).toBe(DEFAULT_PENDING_ORPHAN_TIMEOUT_MS)
    expect(parsePendingOrphanTimeoutMs('abc')).toBe(DEFAULT_PENDING_ORPHAN_TIMEOUT_MS)
    expect(parsePendingOrphanTimeoutMs(undefined)).toBe(DEFAULT_PENDING_ORPHAN_TIMEOUT_MS)
  })
})

describe('sweepStaleLeases', () => {
  it('releases a lease whose run no longer exists', async () => {
    beginExecutionLease('run_gone', 'task_gone', 'agt_1')
    const db = createMockDb({ getRunStatus: vi.fn().mockResolvedValue(undefined) })

    const released = await sweepStaleLeases(db, listActiveExecutionLeases(), completeExecutionLease)

    expect(released).toHaveLength(1)
    expect(released[0]?.agentId).toBe('agt_1')
    expect(countActiveExecutionLeases('agt_1')).toBe(0)
  })

  it('does not infer process exit from a terminal Run status', async () => {
    beginExecutionLease('run_cleanup', 'task_cleanup', 'agt_1')
    const leases = listActiveExecutionLeases()
    const db = createMockDb({ getRunStatus: vi.fn().mockResolvedValue('completed') })

    const released = await sweepStaleLeases(db, leases, completeExecutionLease)

    expect(released).toHaveLength(0)
    expect(countActiveExecutionLeases('agt_1')).toBe(1)
  })

  it('leaves a running lease untouched', async () => {
    beginExecutionLease('run_live', 'task_live', 'agt_1')
    const leases = listActiveExecutionLeases()
    const db = createMockDb({ getRunStatus: vi.fn().mockResolvedValue('running') })

    const released = await sweepStaleLeases(db, leases, completeExecutionLease)

    expect(released).toHaveLength(0)
    expect(countActiveExecutionLeases('agt_1')).toBe(1)
  })
})

describe('tryAcquireSlot', () => {
  it('rejects new work after graceful shutdown begins', async () => {
    const db = createMockDb()
    pauseTaskQueuePromotions()

    expect(await tryAcquireSlot(db, 'agt_1', 'run_1', 1)).toBe('queue_full')
    expect(db.countRunsByStatus).not.toHaveBeenCalled()
  })

  it('atomically reserves the durable SCM workload before activating execution', async () => {
    const order: string[] = []
    const db = createMockDb({
      countRunsByStatus: vi.fn().mockResolvedValue(0),
      admitRun: vi.fn(async () => {
        order.push('admit')
        return { slot: 'acquired' as const, hasScmLease: true }
      }),
      activateRun: vi.fn(async () => {
        order.push('activate')
      }),
    })

    await expect(tryAcquireSlot(db, 'agt_1', 'run_1', 1)).resolves.toBe('acquired')

    expect(order).toEqual(['admit', 'activate'])
    expect(db.updateRunStatus).not.toHaveBeenCalled()
    completeExecutionLease('run_1')
  })

  it('does not re-activate a durable lease claimed by atomic database admission', async () => {
    const activateRun = vi.fn()
    const db = createMockDb({
      admitRun: vi.fn().mockResolvedValue({
        slot: 'acquired',
        hasScmLease: true,
        scmLeaseActivated: true,
      }),
      activateRun,
    })

    await expect(tryAcquireSlot(db, 'agt_1', 'run_atomic', 1)).resolves.toBe('acquired')

    expect(activateRun).not.toHaveBeenCalled()
    completeExecutionLease('run_atomic')
  })

  it('uses the database admission decision across replicas without a stale local recount', async () => {
    const db = createMockDb({
      countRunsByStatus: vi.fn().mockRejectedValue(new Error('must not count outside admission')),
      admitRun: vi.fn().mockResolvedValue({ slot: 'queued', hasScmLease: true }),
    })

    await expect(tryAcquireSlot(db, 'agt_1', 'run_queued', 1)).resolves.toBe('queued')
    expect(countActiveExecutionLeases('agt_1')).toBe(0)
    expect(db.activateRun).toBeUndefined()
  })

  it('counts a non-cancelled lease that is finishing lifecycle cleanup', async () => {
    const lease = beginExecutionLease('run_old', 'task_old', 'agt_1')
    const db = createMockDb({
      countRunsByStatus: vi.fn().mockResolvedValue(0),
    })

    const result = await tryAcquireSlot(db, 'agt_1', 'run_new', 1)

    expect(result).toBe('queued')
    lease.finish()
  })

  it('counts a cancelled but unfinished execution as an occupied slot', async () => {
    const lease = beginExecutionLease('run_old', 'task_old', 'agt_1')
    cancelExecutionLease('run_old')
    const db = createMockDb({
      countRunsByStatus: vi.fn(async (_, status) => (status === 'queued' ? 0 : 0)),
    })

    const result = await tryAcquireSlot(db, 'agt_1', 'run_new', 1)

    expect(result).toBe('queued')
    lease.finish()
  })
  it('当 running 数 < maxConcurrency 时，返回 acquired 并将 run 状态设为 running', async () => {
    const db = createMockDb({
      countRunsByStatus: vi.fn().mockResolvedValue(0),
    })

    const result = await tryAcquireSlot(db, 'agt_1', 'run_1', 2)

    expect(result).toBe('acquired')
    expect(db.updateRunStatus).toHaveBeenCalledWith('run_1', 'running')
    expect(cancelExecutionLease('run_1')).not.toBeNull()
    completeExecutionLease('run_1')
  })

  it('当 running 数 = maxConcurrency 且 queued 数 < MAX_QUEUE_LENGTH 时，返回 queued 并将 run 状态设为 queued', async () => {
    const db = createMockDb({
      countRunsByStatus: vi.fn(async (_, status) => {
        if (status === 'running') return 2
        if (status === 'queued') return 10
        return 0
      }),
    })

    const result = await tryAcquireSlot(db, 'agt_1', 'run_1', 2)

    expect(result).toBe('queued')
    expect(db.updateRunStatus).toHaveBeenCalledWith('run_1', 'queued')
  })

  it('当 running 数 = maxConcurrency 且 queued 数 = MAX_QUEUE_LENGTH 时，返回 queue_full 且不修改状态', async () => {
    const db = createMockDb({
      countRunsByStatus: vi.fn(async (_, status) => {
        if (status === 'running') return 2
        if (status === 'queued') return MAX_QUEUE_LENGTH
        return 0
      }),
    })

    const result = await tryAcquireSlot(db, 'agt_1', 'run_1', 2)

    expect(result).toBe('queue_full')
    expect(db.updateRunStatus).not.toHaveBeenCalled()
  })

  it('maxConcurrency = 1 且有 1 个 running，返回 queued', async () => {
    const db = createMockDb({
      countRunsByStatus: vi.fn(async (_, status) => {
        if (status === 'running') return 1
        if (status === 'queued') return 0
        return 0
      }),
    })

    const result = await tryAcquireSlot(db, 'agt_1', 'run_1', 1)

    expect(result).toBe('queued')
  })

  it('maxConcurrency = 5 且有 4 个 running，返回 acquired', async () => {
    const db = createMockDb({
      countRunsByStatus: vi.fn(async (_, status) => {
        if (status === 'running') return 4
        return 0
      }),
    })

    const result = await tryAcquireSlot(db, 'agt_1', 'run_1', 5)

    expect(result).toBe('acquired')
  })

  it('maxConcurrency = 5 且有 5 个 running，返回 queued', async () => {
    const db = createMockDb({
      countRunsByStatus: vi.fn(async (_, status) => {
        if (status === 'running') return 5
        if (status === 'queued') return 0
        return 0
      }),
    })

    const result = await tryAcquireSlot(db, 'agt_1', 'run_1', 5)

    expect(result).toBe('queued')
  })
})

describe('scheduleNext', () => {
  // Promotion must count the same occupancy union admission counts. The
  // per-view max() misses a peer replica's cleanup-window lease when a
  // different run is `running` here: 1 running + 1 terminal-but-leased is two
  // occupied slots, and promoting a third at maxConcurrency=2 lands in a
  // checkout another process still writes.
  it('does not promote past the occupancy reported by countOccupiedSlots', async () => {
    const executed: string[] = []
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn(async () => 2),
      // The per-view counts a max() would see: one running row, no local lease.
      countRunsByStatus: vi.fn(async (_agentId: string, status: string) =>
        status === 'running' ? 1 : 0,
      ),
      // The union: the running run PLUS a peer's active cleanup lease.
      countOccupiedSlots: vi.fn(async () => 2),
      getOldestQueuedRun: vi.fn(async () => ({ id: 'r_third', initiatorAgentId: 'agt_1' })),
    })

    const promoted = await scheduleNext(db, 'agt_1', (rid) => executed.push(rid))

    expect(promoted).toBe(0)
    expect(executed).toEqual([])
    expect(db.countOccupiedSlots).toHaveBeenCalledWith('agt_1')
  })

  it('does not promote queued work after graceful shutdown begins', async () => {
    const db = createMockDb()
    pauseTaskQueuePromotions()

    expect(await scheduleNext(db, 'agt_1', vi.fn())).toBe(0)
    expect(db.countRunsByStatus).not.toHaveBeenCalled()
  })

  it('never promotes the same queued run twice when two nudges race', async () => {
    // scheduleNext is fired as `void scheduleNext(...)` from ~12 places (every run
    // completion, cancellation, lease sweep, gateway path), so two nudges for one
    // agent overlapping is the base case, not an exotic one.
    //
    // The execution lease cannot arbitrate this. tryAcquireSlot is safe because
    // its two callers hold DISTINCT runIds, so the second sees the first's lease.
    // Here both callers read the SAME oldest queued run, and
    // reserveExecutionLease is idempotent by runId — the second reservation is a
    // silent no-op, the lease count stays 1, and nothing detects the duplicate.
    // Result: two CLI processes against one run and one workspace.
    const executed: string[] = []
    const statuses = new Map([['r1', 'queued']])
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn(async () => 1),
      countRunsByStatus: vi.fn(async (_agentId: string, status: string) =>
        status === 'running' ? [...statuses.values()].filter((s) => s === 'running').length : 0,
      ),
      getOldestQueuedRun: vi.fn(async () => {
        const queued = [...statuses.entries()].find(([, s]) => s === 'queued')
        return queued ? { id: queued[0], initiatorAgentId: 'agt_1' } : undefined
      }),
      updateRunStatus: vi.fn(async (runId: string, status: string) => {
        statuses.set(runId, status)
      }),
      tryTransitionRunStatus: vi.fn(async (runId: string, from: string, to: string) => {
        if (statuses.get(runId) !== from) return false
        statuses.set(runId, to)
        return true
      }),
    })

    await Promise.all([
      await scheduleNext(db, 'agt_1', (rid) => executed.push(rid)),
      await scheduleNext(db, 'agt_1', (rid) => executed.push(rid)),
    ])

    expect(executed).toEqual(['r1'])
  })

  it('resolves instead of rejecting when the DB fails mid-promotion', async () => {
    // Every production call site is `void scheduleNext(...)` — the promotion is
    // deliberately fire-and-forget. On PostgreSQL a transient DB error would
    // therefore surface as an UNHANDLED REJECTION and, with no
    // process.on('unhandledRejection') handler, terminate the API. A queue nudge
    // failing must degrade to "nothing promoted", never take the process down.
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockRejectedValue(new Error('connection terminated')),
    })

    await expect(scheduleNext(db, 'agt_1', vi.fn())).resolves.toBe(0)
  })

  it('stops promoting when a mid-loop query fails, without rejecting', async () => {
    const db = createMockDb({
      getOldestQueuedRun: vi.fn().mockRejectedValue(new Error('deadlock detected')),
    })

    await expect(scheduleNext(db, 'agt_1', vi.fn())).resolves.toBe(0)
  })

  it('releases the local slot when durable lease activation fails during promotion', async () => {
    const db = createMockDb({
      getOldestQueuedRun: vi
        .fn()
        .mockResolvedValueOnce({ id: 'run_q1', initiatorAgentId: 'agt_1' })
        .mockResolvedValueOnce(undefined),
      activateRun: vi.fn().mockRejectedValue(new Error('database unavailable')),
    })
    const onExecute = vi.fn()

    await expect(scheduleNext(db, 'agt_1', onExecute)).resolves.toBe(0)

    expect(onExecute).not.toHaveBeenCalled()
    expect(countActiveExecutionLeases('agt_1')).toBe(0)
  })

  it('uses one durable promotion claim instead of a separate status CAS and activation', async () => {
    const promoteQueuedRun = vi.fn().mockResolvedValue(true)
    const tryTransitionRunStatus = vi.fn().mockResolvedValue(true)
    const activateRun = vi.fn().mockResolvedValue(undefined)
    const db = createMockDb({
      getOldestQueuedRun: vi
        .fn()
        .mockResolvedValueOnce({ id: 'run_q1', initiatorAgentId: 'agt_1' })
        .mockResolvedValueOnce(undefined),
      promoteQueuedRun,
      tryTransitionRunStatus,
      activateRun,
    })
    const onExecute = vi.fn()

    await expect(scheduleNext(db, 'agt_1', onExecute)).resolves.toBe(1)

    expect(promoteQueuedRun).toHaveBeenCalledWith('agt_1', 'run_q1', 1)
    expect(tryTransitionRunStatus).not.toHaveBeenCalled()
    expect(activateRun).not.toHaveBeenCalled()
    expect(onExecute).toHaveBeenCalledWith('run_q1', 'agt_1')
  })

  it('does not promote a queued run while a cancelled execution still owns the slot', async () => {
    const lease = beginExecutionLease('run_old', 'task_old', 'agt_1')
    cancelExecutionLease('run_old')
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(1),
      countRunsByStatus: vi.fn().mockResolvedValue(0),
      getOldestQueuedRun: vi.fn().mockResolvedValue({ id: 'run_q1', initiatorAgentId: 'agt_1' }),
    })
    const onExecute = vi.fn()

    expect(await scheduleNext(db, 'agt_1', onExecute)).toBe(0)
    expect(onExecute).not.toHaveBeenCalled()
    lease.finish()
  })
  it('当有 queued run 且 running < maxConcurrency 时，将最老的 queued run 改为 running 并调用 onExecute', async () => {
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(2),
      countRunsByStatus: vi.fn().mockResolvedValue(0),
      getOldestQueuedRun: vi
        .fn()
        .mockReturnValueOnce({ id: 'run_q1', initiatorAgentId: 'agt_1' })
        .mockReturnValueOnce(undefined),
    })
    const onExecute = vi.fn()

    const promoted = await scheduleNext(db, 'agt_1', onExecute)

    // The promotion is a conditional claim now, not a blind write: only the
    // caller whose UPDATE actually transitions queued->running may execute it.
    expect(db.tryTransitionRunStatus).toHaveBeenCalledWith('run_q1', 'queued', 'running')
    expect(onExecute).toHaveBeenCalledWith('run_q1', 'agt_1')
    expect(promoted).toBe(1)
    expect(cancelExecutionLease('run_q1')).not.toBeNull()
    completeExecutionLease('run_q1')
  })

  it('当无 queued run 时，不做任何操作', async () => {
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(2),
      countRunsByStatus: vi.fn().mockResolvedValue(0),
      getOldestQueuedRun: vi.fn().mockResolvedValue(undefined),
    })
    const onExecute = vi.fn()

    const promoted = await scheduleNext(db, 'agt_1', onExecute)

    expect(db.updateRunStatus).not.toHaveBeenCalled()
    expect(onExecute).not.toHaveBeenCalled()
    expect(promoted).toBe(0)
  })

  it('当 running >= maxConcurrency 时，不调度即使有 queued run', async () => {
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(1),
      countRunsByStatus: vi.fn().mockResolvedValue(1),
      getOldestQueuedRun: vi.fn().mockResolvedValue({ id: 'run_q1', initiatorAgentId: 'agt_1' }),
    })
    const onExecute = vi.fn()

    await scheduleNext(db, 'agt_1', onExecute)

    expect(db.updateRunStatus).not.toHaveBeenCalled()
    expect(onExecute).not.toHaveBeenCalled()
  })

  it('agent 不存在时（getAgentMaxConcurrency 返回 undefined），不做任何操作', async () => {
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(undefined),
    })
    const onExecute = vi.fn()

    const promoted = await scheduleNext(db, 'agt_nonexistent', onExecute)

    expect(db.updateRunStatus).not.toHaveBeenCalled()
    expect(onExecute).not.toHaveBeenCalled()
    expect(promoted).toBe(0)
  })

  it('调度后如果还有空闲 slot 和 queued run，继续调度（循环调度）', async () => {
    let runningCount = 0
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(3),
      countRunsByStatus: vi.fn(async () => runningCount),
      getOldestQueuedRun: vi
        .fn()
        .mockReturnValueOnce({ id: 'run_q1', initiatorAgentId: 'agt_1' })
        .mockReturnValueOnce({ id: 'run_q2', initiatorAgentId: 'agt_1' })
        .mockReturnValueOnce(undefined),
    })
    const onExecute = vi.fn(async () => {
      runningCount++
    })

    const promoted = await scheduleNext(db, 'agt_1', onExecute)

    expect(onExecute).toHaveBeenCalledTimes(2)
    expect(promoted).toBe(2)
    // The promotion is a conditional claim now, not a blind write: only the
    // caller whose UPDATE actually transitions queued->running may execute it.
    expect(db.tryTransitionRunStatus).toHaveBeenCalledWith('run_q1', 'queued', 'running')
    expect(db.tryTransitionRunStatus).toHaveBeenCalledWith('run_q2', 'queued', 'running')
  })

  it('异常数据导致无限循环风险时，最大迭代保护应退出循环', async () => {
    // 模拟 getOldestQueuedRun 总是返回数据（异常情况），但 updateRunStatus 未生效
    let callCount = 0
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(3),
      countRunsByStatus: vi.fn(async () => 0), // 总是返回 0 running
      getOldestQueuedRun: vi.fn(async () => {
        callCount++
        // 模拟异常情况：总是返回同一个 run，导致理论上无限循环
        return callCount < 200 ? { id: 'run_q1', initiatorAgentId: 'agt_1' } : undefined
      }),
    })
    const onExecute = vi.fn()

    await scheduleNext(db, 'agt_1', onExecute)

    // 由于最大迭代保护，onExecute 调用次数应该被限制
    expect(onExecute.mock.calls.length).toBeLessThan(200)
  })
})

describe('recoverOnStartup', () => {
  it('marks every stranded running Run failed with a structured reason', async () => {
    const db = createMockDb({
      countRunsByStatus: vi.fn(async (_, status) => {
        if (status === 'running') return 2
        return 0
      }),
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(1),
      getOldestQueuedRun: vi.fn().mockResolvedValue(undefined),
      getRunsByStatus: vi.fn(async (_, status) =>
        status === 'running'
          ? [
              { id: 'run_a', triggerSource: 'a2a', triggerSessionId: 'task_1' },
              { id: 'run_b', triggerSource: 'api', triggerSessionId: null },
            ]
          : [],
      ),
    })
    const onExecute = vi.fn()
    const getAgentIds = () => ['agt_1']

    const stats = await recoverOnStartup(db, onExecute, getAgentIds)

    expect(db.failRunWithStructuredReason).toHaveBeenCalledWith(
      'run_a',
      FAILURE_REASONS.SERVER_RESTART_DURING_EXEC,
    )
    expect(db.failRunWithStructuredReason).toHaveBeenCalledWith(
      'run_b',
      FAILURE_REASONS.SERVER_RESTART_DURING_EXEC,
    )
    expect(db.updateRunStatus).toHaveBeenCalledWith('run_a', 'failed')
    expect(db.updateRunStatus).toHaveBeenCalledWith('run_b', 'failed')
    expect(stats.runningAborted).toBe(2)
  })

  it('marks orphaned pending Runs failed with PENDING_ORPHAN_ON_STARTUP', async () => {
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(1),
      getOrphanedPendingRuns: vi.fn(async () => [
        { id: 'run_orphan', triggerSource: 'a2a', triggerSessionId: 'task_orphan' },
      ]),
    })
    const onExecute = vi.fn()

    const stats = await recoverOnStartup(db, onExecute, () => ['agt_1'])

    expect(db.failRunWithStructuredReason).toHaveBeenCalledWith(
      'run_orphan',
      FAILURE_REASONS.PENDING_ORPHAN_ON_STARTUP,
    )
    expect(db.updateRunStatus).toHaveBeenCalledWith('run_orphan', 'failed')
    expect(stats.pendingOrphaned).toBe(1)
  })

  it('passes the failed Run metadata and reason to onRunFailed', async () => {
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(1),
      getRunsByStatus: vi.fn(async (_, status) =>
        status === 'running'
          ? [{ id: 'run_x', triggerSource: 'a2a', triggerSessionId: 'tid' }]
          : [],
      ),
    })
    const onRunFailed = vi.fn()

    await recoverOnStartup(db, vi.fn(), () => ['agt_1'], { onRunFailed })

    expect(onRunFailed).toHaveBeenCalledWith(
      { id: 'run_x', triggerSource: 'a2a', triggerSessionId: 'tid' },
      FAILURE_REASONS.SERVER_RESTART_DURING_EXEC,
    )
  })

  it('does not fail in-flight work owned by another PostgreSQL replica', async () => {
    const db = createMockDb({
      getRunsByStatus: vi
        .fn()
        .mockResolvedValue([{ id: 'run_peer', triggerSource: 'api', triggerSessionId: null }]),
      getOrphanedPendingRuns: vi
        .fn()
        .mockResolvedValue([{ id: 'run_pending', triggerSource: 'api', triggerSessionId: null }]),
    })

    const onRunFailed = vi.fn()
    const stats = await recoverOnStartup(db, vi.fn(), () => ['agt_1'], {
      recoverInFlight: false,
      onRunFailed,
    })

    expect(stats.runningAborted).toBe(0)
    expect(stats.pendingOrphaned).toBe(0)
    expect(db.failRunWithStructuredReason).not.toHaveBeenCalled()
    expect(onRunFailed).not.toHaveBeenCalled()
  })

  it('onRunFailed hook 抛错时不应阻断后续恢复', async () => {
    const db = createMockDb({
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(1),
      getRunsByStatus: vi.fn(async (_, status) =>
        status === 'running'
          ? [
              { id: 'run_1', triggerSource: 'a2a', triggerSessionId: 't1' },
              { id: 'run_2', triggerSource: 'a2a', triggerSessionId: 't2' },
            ]
          : [],
      ),
    })
    const onRunFailed = vi
      .fn()
      .mockRejectedValueOnce(new Error('hook boom'))
      .mockResolvedValue(undefined)

    const stats = await recoverOnStartup(db, vi.fn(), () => ['agt_1'], { onRunFailed })

    expect(stats.runningAborted).toBe(2)
    expect(onRunFailed).toHaveBeenCalledTimes(2)
  })

  it('标记 failed 后，为每个 agent 调度 queued run（不超过 maxConcurrency）', async () => {
    const db = createMockDb({
      countRunsByStatus: vi.fn(async (_, status) => {
        if (status === 'running') return 0
        if (status === 'queued') return 1
        return 0
      }),
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(2),
      getOldestQueuedRun: vi
        .fn()
        .mockReturnValueOnce({ id: 'run_q1', initiatorAgentId: 'agt_1' })
        .mockReturnValueOnce(undefined),
    })
    const onExecute = vi.fn()
    const getAgentIds = () => ['agt_1']

    await recoverOnStartup(db, onExecute, getAgentIds)

    expect(onExecute).toHaveBeenCalledWith('run_q1', 'agt_1')
  })

  it('在 scheduleNext 之前，把 triggerSource=feishu 的 queued run 标记为失败（等待 replay 重建）', async () => {
    const oldestQueued = vi.fn().mockResolvedValue(undefined)
    const db = createMockDb({
      countRunsByStatus: vi.fn().mockResolvedValue(0),
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(1),
      getOldestQueuedRun: oldestQueued,
      getRunsByStatus: vi.fn(async (_, status) =>
        status === 'queued'
          ? [
              { id: 'run_feishu_q', triggerSource: 'feishu', triggerSessionId: 'msg_1' },
              { id: 'run_api_q', triggerSource: 'api', triggerSessionId: null },
            ]
          : [],
      ),
    })
    const onExecute = vi.fn()

    const stats = await recoverOnStartup(db, onExecute, () => ['agt_1'])

    expect(db.failRunWithStructuredReason).toHaveBeenCalledWith(
      'run_feishu_q',
      FAILURE_REASONS.FEISHU_QUEUED_RESET_FOR_REPLAY,
    )
    // API queued run is NOT force-failed; scheduleNext is free to promote it
    expect(db.failRunWithStructuredReason).not.toHaveBeenCalledWith('run_api_q', expect.anything())
    expect(stats.feishuQueuedReset).toBe(1)
  })

  it('无 running 也无 queued 时，返回全零统计', async () => {
    const db = createMockDb({
      countRunsByStatus: vi.fn().mockResolvedValue(0),
      getAgentMaxConcurrency: vi.fn().mockResolvedValue(1),
      getOldestQueuedRun: vi.fn().mockResolvedValue(undefined),
    })
    const onExecute = vi.fn()
    const getAgentIds = () => ['agt_1']

    const stats = await recoverOnStartup(db, onExecute, getAgentIds)

    expect(stats).toEqual({
      pendingOrphaned: 0,
      runningAborted: 0,
      queuedPromoted: 0,
      feishuQueuedReset: 0,
    })
    expect(onExecute).not.toHaveBeenCalled()
  })

  it('归档 agent 已被删除的 stuck pending，失败原因 = DANGLING_RUN_ON_STARTUP（agent_id 为 NULL 的 pending 不算 dangling）', async () => {
    const db = createMockDb({
      getDanglingPendingRuns: vi.fn().mockResolvedValue([
        { id: 'run_deleted_agent1', triggerSource: null, triggerSessionId: null },
        { id: 'run_deleted_agent2', triggerSource: 'api', triggerSessionId: null },
      ]),
    })

    const stats = await recoverOnStartup(db, vi.fn(), () => [])

    expect(db.failRunWithStructuredReason).toHaveBeenCalledWith(
      'run_deleted_agent1',
      FAILURE_REASONS.DANGLING_RUN_ON_STARTUP,
    )
    expect(db.failRunWithStructuredReason).toHaveBeenCalledWith(
      'run_deleted_agent2',
      FAILURE_REASONS.DANGLING_RUN_ON_STARTUP,
    )
    expect(stats.pendingOrphaned).toBe(2)
  })

  it('归档已删除 agent 的 queued run（feishu 也归档：无活跃 agent 时 replay 无法重建）', async () => {
    const db = createMockDb({
      getDanglingQueuedRuns: vi.fn().mockResolvedValue([
        { id: 'run_dead_q1', triggerSource: 'api', triggerSessionId: null },
        { id: 'run_dead_q_feishu', triggerSource: 'feishu', triggerSessionId: 'msg_x' },
      ]),
    })

    const stats = await recoverOnStartup(db, vi.fn(), () => ['agt_1'])

    expect(db.failRunWithStructuredReason).toHaveBeenCalledWith(
      'run_dead_q1',
      FAILURE_REASONS.DANGLING_RUN_ON_STARTUP,
    )
    expect(db.failRunWithStructuredReason).toHaveBeenCalledWith(
      'run_dead_q_feishu',
      FAILURE_REASONS.DANGLING_RUN_ON_STARTUP,
    )
    expect(stats.pendingOrphaned).toBe(2)
  })

  it('dangling 扫描查询不依赖 activeAgentIds 快照（DB 内 NOT EXISTS 决定 dangling），getAgentIds 仅调用一次', async () => {
    const getAgentIds = vi.fn(() => ['agt_1'])
    const db = createMockDb()

    await recoverOnStartup(db, vi.fn(), getAgentIds)

    // Per-agent loop still uses one snapshot; dangling sweep no longer takes the array.
    expect(getAgentIds).toHaveBeenCalledTimes(1)
    expect(db.getDanglingPendingRuns).toHaveBeenCalledWith(expect.any(Number))
    expect(db.getDanglingQueuedRuns).toHaveBeenCalledWith()
  })
})
