import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSetting = vi.fn()
const withScmPathMutation = vi.fn()

vi.mock('../../lib/settings.js', () => ({ getSetting }))
vi.mock('../../lib/scm-path-plan.js', () => ({ withScmPathMutation }))
vi.mock('../../db/client.js', () => ({ db: {} }))

const { evaluationQueueDb } = await import('../evaluation-queue-db.js')

/**
 * Evaluation is deliberately serial: a task holds one workspace for the whole
 * replay, and a second concurrent task would either fight over that directory
 * (SCM) or double the load a background batch puts on the box. The knob that
 * used to widen this is gone, so the only contract left to pin down is that
 * nothing can widen it again.
 */
describe('evaluationQueueDb.getMaxConcurrency', () => {
  beforeEach(() => {
    getSetting.mockReset()
  })

  it('is always one', async () => {
    getSetting.mockReturnValue(undefined)
    expect(evaluationQueueDb.getMaxConcurrency()).toBe(1)
  })

  it('ignores a leftover settings value from before evaluation went serial', async () => {
    // The `evaluation.maxConcurrency` key is kept in existing databases rather
    // than migrated away, so it has to be inert, not merely defaulted.
    getSetting.mockReturnValue('8')
    expect(evaluationQueueDb.getMaxConcurrency()).toBe(1)
  })

  it('does not consult settings at all', async () => {
    evaluationQueueDb.getMaxConcurrency()
    expect(getSetting).not.toHaveBeenCalled()
  })
})

describe('evaluationQueueDb.claimQueuedTasks', () => {
  beforeEach(() => {
    withScmPathMutation.mockReset()
  })

  it('counts and claims the oldest queued task inside one SCM mutation transaction', async () => {
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: () => ({ where: () => ({ limit: async () => [{ value: 0 }] }) }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [{ id: 'evt_1', agentId: 'agt_1' }],
              }),
            }),
          }),
        }),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: 'evt_1' }] }),
        }),
      })),
    }
    withScmPathMutation.mockImplementation(async (mutation) => mutation(tx))

    await expect(evaluationQueueDb.claimQueuedTasks?.('agt_1')).resolves.toEqual([
      { id: 'evt_1', agentId: 'agt_1' },
    ])

    expect(withScmPathMutation).toHaveBeenCalledOnce()
    expect(tx.select).toHaveBeenCalledTimes(2)
    expect(tx.update).toHaveBeenCalledOnce()
  })
})
