import { beforeEach, describe, expect, it, vi } from 'vitest'

const insertValues = vi.fn()
const insertReturning = vi.fn()
const deleteWhere = vi.fn()
const selectLimit = vi.fn()

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: selectLimit })),
          limit: selectLimit,
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: insertValues })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../id.js', () => {
  let n = 0
  return { createId: vi.fn((p?: string) => `${p ?? ''}auto${++n}`) }
})

const tryAcquireSlot = vi.fn()
vi.mock('../../engine/task-queue.js', () => ({ tryAcquireSlot }))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))

const executeChatRun = vi.fn()
vi.mock('../execute-chat-run.js', () => ({ executeChatRun }))

const registerPendingContext = vi.fn()
vi.mock('../pending-job-registry.js', () => ({ registerPendingContext }))

const logBackgroundAudit = vi.fn()
vi.mock('../audit.js', () => ({ logBackgroundAudit }))

const loadRerunSource = vi.fn()
const filterReplayableAttachments = vi.fn((a: unknown[]) => a)
vi.mock('../rerun-builder.js', () => ({ loadRerunSource, filterReplayableAttachments }))

const resolveRerunConsumerId = vi.fn(() => 'user_1')
vi.mock('../../routes/runs.js', () => ({ resolveRerunConsumerId }))

const { maybeScheduleJobRetry } = await import('../job-retry-scheduler.js')

const agent = { id: 'agt_1', name: 'A', status: 'active', maxConcurrency: 1 }

function makeRun(over: Record<string, unknown> = {}) {
  return {
    id: 'run_orig',
    intent: 'do the thing',
    initiatorAgentId: 'agt_1',
    triggerSource: 'api',
    triggerUserName: 'Tate',
    triggerAgentName: null,
    userId: 'user_1',
    executionMetadata: {},
    ...over,
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  insertValues.mockReturnValue({ returning: insertReturning })
  insertReturning.mockResolvedValue([{ id: 'run_auto1' }])
  tryAcquireSlot.mockResolvedValue('acquired')
  selectLimit.mockResolvedValue([agent])
  loadRerunSource.mockResolvedValue({
    agentId: 'agt_1',
    originalContext: { channel: {} },
    rawAttachments: [],
  })
})

describe('maybeScheduleJobRetry', () => {
  it('does nothing when the budget is 0 (default)', async () => {
    const out = await maybeScheduleJobRetry({
      run: makeRun(),
      status: 'failed',
      error: 'boom',
      maxJobRetries: 0,
    })
    expect(out.scheduled).toBe(false)
    expect(tryAcquireSlot).not.toHaveBeenCalled()
    expect(insertValues).not.toHaveBeenCalled()
  })

  it('does nothing for a cancelled run', async () => {
    const out = await maybeScheduleJobRetry({
      run: makeRun(),
      status: 'cancelled',
      error: undefined,
      maxJobRetries: 3,
    })
    expect(out.scheduled).toBe(false)
    expect(insertValues).not.toHaveBeenCalled()
  })

  it('does nothing for a permanent error', async () => {
    const out = await maybeScheduleJobRetry({
      run: makeRun(),
      status: 'failed',
      error: 'request failed with status 401',
      maxJobRetries: 3,
    })
    expect(out.scheduled).toBe(false)
    expect(insertValues).not.toHaveBeenCalled()
  })

  it('creates a new run and dispatches it on a transient failure', async () => {
    const out = await maybeScheduleJobRetry({
      run: makeRun(),
      status: 'failed',
      error: 'connection reset',
      maxJobRetries: 2,
    })
    expect(out.scheduled).toBe(true)
    expect(insertValues).toHaveBeenCalledTimes(1)
    const values = insertValues.mock.calls[0][0] as Record<string, never>
    expect(values.intent).toBe('do the thing')
    expect(values.initiatorAgentId).toBe('agt_1')
    expect(values.triggerSource).toBe('api')
    expect(values.triggerUserName).toBe('Tate')
    expect(executeChatRun).toHaveBeenCalled()
  })

  it('stamps the retry chain so the replay does not loop forever', async () => {
    await maybeScheduleJobRetry({
      run: makeRun(),
      status: 'failed',
      error: 'connection reset',
      maxJobRetries: 2,
    })
    const values = insertValues.mock.calls[0][0] as {
      executionMetadata: { jobRetryOf: string; jobRetryAttempt: number }
    }
    expect(values.executionMetadata.jobRetryOf).toBe('run_orig')
    expect(values.executionMetadata.jobRetryAttempt).toBe(1)
  })

  it('carries the chain origin forward and increments the attempt', async () => {
    await maybeScheduleJobRetry({
      run: makeRun({
        id: 'run_second',
        executionMetadata: { jobRetryOf: 'run_orig', jobRetryAttempt: 1 },
      }),
      status: 'failed',
      error: 'connection reset',
      maxJobRetries: 3,
    })
    const values = insertValues.mock.calls[0][0] as {
      executionMetadata: { jobRetryOf: string; jobRetryAttempt: number }
    }
    expect(values.executionMetadata.jobRetryOf).toBe('run_orig')
    expect(values.executionMetadata.jobRetryAttempt).toBe(2)
  })

  it('stops once the chain has spent its budget', async () => {
    const out = await maybeScheduleJobRetry({
      run: makeRun({ executionMetadata: { jobRetryOf: 'run_orig', jobRetryAttempt: 2 } }),
      status: 'failed',
      error: 'connection reset',
      maxJobRetries: 2,
    })
    expect(out.scheduled).toBe(false)
    expect(insertValues).not.toHaveBeenCalled()
  })

  it('writes a background audit entry for the retry', async () => {
    await maybeScheduleJobRetry({
      run: makeRun(),
      status: 'failed',
      error: 'connection reset',
      maxJobRetries: 2,
    })
    expect(logBackgroundAudit).toHaveBeenCalledTimes(1)
    const entry = logBackgroundAudit.mock.calls[0][0] as {
      action: string
      resourceId: string
      details: Record<string, unknown>
    }
    expect(entry.action).toBe('run.auto_retry')
    expect(entry.details.originalRunId).toBe('run_orig')
    expect(entry.details.attempt).toBe(1)
  })

  it('rolls back the new run when the queue is full', async () => {
    tryAcquireSlot.mockResolvedValue('queue_full')
    const out = await maybeScheduleJobRetry({
      run: makeRun(),
      status: 'failed',
      error: 'connection reset',
      maxJobRetries: 2,
    })
    expect(out.scheduled).toBe(false)
    expect(deleteWhere).toHaveBeenCalledTimes(1)
    expect(executeChatRun).not.toHaveBeenCalled()
  })

  it('leaves a queued retry to the scheduler instead of dispatching it', async () => {
    tryAcquireSlot.mockResolvedValue('queued')
    const out = await maybeScheduleJobRetry({
      run: makeRun(),
      status: 'failed',
      error: 'connection reset',
      maxJobRetries: 2,
    })
    expect(out.scheduled).toBe(true)
    expect(executeChatRun).not.toHaveBeenCalled()
  })

  it('does not retry when the agent is no longer active', async () => {
    selectLimit.mockResolvedValue([{ ...agent, status: 'disabled' }])
    const out = await maybeScheduleJobRetry({
      run: makeRun(),
      status: 'failed',
      error: 'connection reset',
      maxJobRetries: 2,
    })
    expect(out.scheduled).toBe(false)
    expect(insertValues).not.toHaveBeenCalled()
  })

  it('never throws — a retry failure must not break run finalization', async () => {
    insertValues.mockImplementation(() => {
      throw new Error('db down')
    })
    await expect(
      maybeScheduleJobRetry({
        run: makeRun(),
        status: 'failed',
        error: 'connection reset',
        maxJobRetries: 2,
      }),
    ).resolves.toEqual({ scheduled: false })
  })
})
