import { afterEach, describe, expect, it, vi } from 'vitest'
import { retryWorkspaceCleanupUntilSuccess } from '../workspace-cleanup-retry.js'

describe('retryWorkspaceCleanupUntilSuccess', () => {
  afterEach(() => vi.useRealTimers())

  it('does not resolve until a failed cleanup succeeds on retry', async () => {
    vi.useFakeTimers()
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('worktree busy'))
      .mockResolvedValueOnce(undefined)

    let settled = false
    const result = retryWorkspaceCleanupUntilSuccess(cleanup, {
      retryDelayMs: 1_000,
      context: { type: 'run', id: 'run_1' },
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(settled).toBe(true)
  })

  it('uses the production retry delay when no override is supplied', async () => {
    vi.useFakeTimers()
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('worktree busy'))
      .mockResolvedValueOnce(undefined)

    const result = retryWorkspaceCleanupUntilSuccess(cleanup, {
      context: { type: 'evaluation', id: 'evt_1' },
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(cleanup).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})
