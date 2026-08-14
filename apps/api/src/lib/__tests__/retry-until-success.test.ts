import { describe, expect, it, vi } from 'vitest'
import { retryUntilSuccess } from '../retry-until-success.js'

describe('retryUntilSuccess', () => {
  it('reports each failure and uses capped exponential backoff', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'))
      .mockResolvedValueOnce('done')
    const wait = vi.fn(async () => undefined)
    const onFailure = vi.fn()

    await expect(
      retryUntilSuccess(operation, {
        initialDelayMs: 10,
        maxDelayMs: 25,
        wait,
        onFailure,
      }),
    ).resolves.toBe('done')

    expect(wait.mock.calls).toEqual([[10], [20], [25]])
    expect(onFailure).toHaveBeenCalledTimes(3)
    expect(onFailure.mock.calls.map((call) => call[1])).toEqual([10, 20, 25])
  })

  it('returns immediately without waiting after a successful first attempt', async () => {
    const wait = vi.fn(async () => undefined)
    const onFailure = vi.fn()

    await expect(
      retryUntilSuccess(async () => 42, {
        initialDelayMs: 10,
        maxDelayMs: 25,
        wait,
        onFailure,
      }),
    ).resolves.toBe(42)
    expect(wait).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })
})
