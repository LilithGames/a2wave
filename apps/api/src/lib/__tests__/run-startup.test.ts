import { describe, expect, it, vi } from 'vitest'
import { persistRunTurn, recoverRunStartup } from '../run-startup.js'

describe('persistRunTurn', () => {
  it('persists the step and user message inside one transaction', async () => {
    const values = vi.fn().mockResolvedValue(undefined)
    const tx = { insert: vi.fn(() => ({ values })) }
    const transaction = vi.fn(async (callback) => await callback(tx))

    await persistRunTurn(
      {
        step: {
          id: 'rst_test',
          runId: 'run_test',
          agentId: 'agt_test',
          order: 1,
          input: { message: 'hello' },
          status: 'running',
        },
        message: {
          id: 'msg_test',
          runId: 'run_test',
          role: 'user',
          content: 'hello',
        },
      },
      { transaction },
    )

    expect(transaction).toHaveBeenCalledOnce()
    expect(tx.insert).toHaveBeenCalledTimes(2)
    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'rst_test', order: 1 }))
    expect(values).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'msg_test' }))
  })

  it('computes the next step order inside the same transaction', async () => {
    const values = vi.fn().mockResolvedValue(undefined)
    const limit = vi.fn().mockResolvedValue([{ maxOrder: 4 }])
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })),
      })),
      insert: vi.fn(() => ({ values })),
    }
    const transaction = vi.fn(async (callback) => await callback(tx))

    await persistRunTurn(
      {
        step: {
          id: 'rst_next',
          runId: 'run_test',
          agentId: 'agt_test',
          input: { message: 'follow up' },
          status: 'running',
        },
        message: {
          id: 'msg_next',
          runId: 'run_test',
          role: 'user',
          content: 'follow up',
        },
      },
      { transaction },
    )

    expect(limit).toHaveBeenCalledWith(1)
    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'rst_next', order: 5 }))
  })

  it('propagates a write failure so the transaction can roll back both records', async () => {
    let writeCount = 0
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          writeCount++
          if (writeCount === 2) throw new Error('message write failed')
        }),
      })),
    }
    const transaction = vi.fn(async (callback) => await callback(tx))

    await expect(
      persistRunTurn(
        {
          step: {
            id: 'rst_test',
            runId: 'run_test',
            agentId: 'agt_test',
            order: 1,
            input: { message: 'hello' },
            status: 'running',
          },
          message: {
            id: 'msg_test',
            runId: 'run_test',
            role: 'user',
            content: 'hello',
          },
        },
        { transaction },
      ),
    ).rejects.toThrow('message write failed')
  })
})

describe('recoverRunStartup', () => {
  it('settles persisted state before releasing the lease and advancing the queue', async () => {
    const calls: string[] = []

    await recoverRunStartup(
      {
        runId: 'run_test',
        agentId: 'agt_test',
        cleanup: async () => calls.push('cleanup'),
        settleRun: async () => calls.push('settle-run'),
      },
      {
        failRunSteps: async () => calls.push('fail-steps'),
        releaseLease: () => calls.push('release-lease'),
        scheduleNext: async () => {
          calls.push('schedule-next')
        },
        reportError: vi.fn(),
      },
    )

    expect(calls).toEqual(['cleanup', 'fail-steps', 'settle-run', 'release-lease', 'schedule-next'])
  })

  it('continues releasing and scheduling when an earlier recovery phase fails', async () => {
    const releaseLease = vi.fn()
    const scheduleNext = vi.fn().mockResolvedValue(undefined)
    const reportError = vi.fn()

    await recoverRunStartup(
      {
        runId: 'run_test',
        agentId: 'agt_test',
        cleanup: vi.fn().mockRejectedValue(new Error('cleanup failed')),
        settleRun: vi.fn().mockRejectedValue(new Error('settle failed')),
      },
      {
        failRunSteps: vi.fn().mockRejectedValue(new Error('step update failed')),
        releaseLease,
        scheduleNext,
        reportError,
      },
    )

    expect(reportError).toHaveBeenCalledTimes(3)
    expect(releaseLease).toHaveBeenCalledWith('run_test')
    expect(scheduleNext).toHaveBeenCalledWith('agt_test')
  })
})
