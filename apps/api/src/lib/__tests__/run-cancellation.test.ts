import { beforeEach, describe, expect, it, vi } from 'vitest'

const cancelMock = vi.hoisted(() => vi.fn())
const scheduleNextMock = vi.hoisted(() => vi.fn())
const loggerWarnMock = vi.hoisted(() => vi.fn())
const cancelExecutionLeaseMock = vi.hoisted(() => vi.fn())
const claimRunResultMock = vi.hoisted(() => vi.fn().mockReturnValue([{ id: 'run_1' }]))
const releaseReservedRunMock = vi.hoisted(() => vi.fn().mockResolvedValue(true))

vi.mock('../../db/client.js', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: claimRunResultMock })),
      })),
    })),
  },
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../engine/index.js', () => ({
  engineRegistry: { cancel: cancelMock },
}))

vi.mock('../../engine/task-queue.js', () => ({
  scheduleNext: scheduleNextMock,
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

vi.mock('../scm-workload-lifecycle.js', () => ({
  releaseReservedScmWorkloadInMutation: releaseReservedRunMock,
}))

vi.mock('../execute-chat-run.js', () => ({
  executeChatRun: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { warn: loggerWarnMock },
}))

vi.mock('../../engine/execution-lease-registry.js', () => ({
  cancelExecutionLease: cancelExecutionLeaseMock,
}))

import { cancelRunningTasksInBackground, claimRunCancellation } from '../run-cancellation.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('cancelRunningTasksInBackground', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cancelExecutionLeaseMock.mockReturnValue(null)
    claimRunResultMock.mockReturnValue([{ id: 'run_1' }])
  })

  it('claims cancellation only when the expected status still owns the run', async () => {
    expect(await claimRunCancellation('run_1', 'running')).toBe(true)

    claimRunResultMock.mockReturnValueOnce([])
    expect(await claimRunCancellation('run_1', 'running')).toBe(false)
  })

  it('releases a queued reservation but keeps a running execution lease', async () => {
    expect(await claimRunCancellation('run_queued', 'queued')).toBe(true)
    expect(releaseReservedRunMock).toHaveBeenCalledWith(expect.anything(), {
      type: 'run',
      workloadId: 'run_queued',
    })

    releaseReservedRunMock.mockClear()
    expect(await claimRunCancellation('run_active', 'running')).toBe(true)
    expect(releaseReservedRunMock).not.toHaveBeenCalled()
  })

  it('requests cancellation immediately without waiting for process exit', async () => {
    const cancellation = deferred<boolean>()
    cancelMock.mockReturnValueOnce(cancellation.promise)

    const result = cancelRunningTasksInBackground({
      runId: 'run_1',
      agentId: 'agt_1',
      taskIds: ['chat/run_1/rst_1'],
    })

    expect(result).toBeUndefined()
    expect(cancelMock).toHaveBeenCalledWith('chat/run_1/rst_1')
    expect(scheduleNextMock).not.toHaveBeenCalled()

    cancellation.resolve(true)
    await flushPromises()

    expect(scheduleNextMock).toHaveBeenCalledOnce()
  })

  it('advances the queue after cancellation settles even when one request fails', async () => {
    const cancellation = deferred<boolean>()
    cancelMock.mockReturnValueOnce(cancellation.promise)

    cancelRunningTasksInBackground({
      runId: 'run_1',
      agentId: 'agt_1',
      taskIds: ['invoke/run_1/rst_1'],
    })

    cancellation.reject(new Error('kill failed'))
    await flushPromises()

    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1', taskId: 'invoke/run_1/rst_1' }),
      'CLI cancellation request failed',
    )
    expect(scheduleNextMock).toHaveBeenCalledOnce()
  })

  it('waits for a pre-spawn execution lease before advancing an empty-task queue', async () => {
    const leaseCompletion = deferred<void>()
    cancelExecutionLeaseMock.mockReturnValueOnce(leaseCompletion.promise)

    cancelRunningTasksInBackground({
      runId: 'run_1',
      agentId: 'agt_1',
      taskIds: [],
    })

    await flushPromises()
    expect(scheduleNextMock).not.toHaveBeenCalled()

    leaseCompletion.resolve()
    await flushPromises()
    expect(scheduleNextMock).toHaveBeenCalledOnce()
  })
})
