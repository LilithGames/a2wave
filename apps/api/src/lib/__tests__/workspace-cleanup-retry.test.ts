import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupWorkspaceOrHandOff,
  retryWorkspaceCleanup,
  WorkspaceCleanupExhaustedError,
} from '../workspace-cleanup-retry.js'
import { WorkspaceRemovalHandedOffError } from '../workspace-removal-outcome.js'

describe('retryWorkspaceCleanup', () => {
  afterEach(() => vi.useRealTimers())

  it('does not resolve until a failed cleanup succeeds on retry', async () => {
    vi.useFakeTimers()
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('worktree busy'))
      .mockResolvedValueOnce(undefined)

    let settled = false
    const result = retryWorkspaceCleanup(cleanup, {
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

    const result = retryWorkspaceCleanup(cleanup, {
      context: { type: 'evaluation', id: 'evt_1' },
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(cleanup).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('backs off repeated failures and caps the retry delay', async () => {
    vi.useFakeTimers()
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('failure 1'))
      .mockRejectedValueOnce(new Error('failure 2'))
      .mockRejectedValueOnce(new Error('failure 3'))
      .mockResolvedValueOnce(undefined)

    const result = retryWorkspaceCleanup(cleanup, {
      retryDelayMs: 100,
      maxRetryDelayMs: 250,
      context: { type: 'run', id: 'run_backoff' },
    })

    await vi.advanceTimersByTimeAsync(99)
    expect(cleanup).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(cleanup).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(cleanup).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(cleanup).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(249)
    expect(cleanup).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(cleanup).toHaveBeenCalledTimes(4)
  })

  // The change this test guards: the loop used to be unbounded, so a worktree
  // that could not be removed (a stuck NFS handle, a file the CLI still holds)
  // pinned the run's concurrency slot and its Agent's SCM binding for the life
  // of the process. Attempts are now bounded and the reconciler takes over.
  it('gives up after the attempt budget and reports exhaustion', async () => {
    vi.useFakeTimers()
    const cleanup = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('EBUSY'))

    const result = retryWorkspaceCleanup(cleanup, {
      retryDelayMs: 100,
      maxAttempts: 3,
      context: { type: 'run', id: 'run_stuck' },
    }).catch((error) => error)

    await vi.advanceTimersByTimeAsync(10_000)
    const error = await result

    expect(cleanup).toHaveBeenCalledTimes(3)
    expect(error).toBeInstanceOf(WorkspaceCleanupExhaustedError)
    // The last real failure must survive: "cleanup gave up" without the reason
    // is undiagnosable.
    expect((error as WorkspaceCleanupExhaustedError).cause).toBeInstanceOf(Error)
    expect(((error as WorkspaceCleanupExhaustedError).cause as Error).message).toBe('EBUSY')
  })

  it('does not wait after the final failed attempt', async () => {
    // A trailing sleep would delay the handoff by a full backoff interval for
    // no benefit — nothing is going to retry inline any more.
    vi.useFakeTimers()
    const cleanup = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('EBUSY'))
    const wait = vi.fn(async () => {})

    await retryWorkspaceCleanup(cleanup, {
      retryDelayMs: 100,
      maxAttempts: 2,
      wait,
      context: { type: 'run', id: 'run_stuck' },
    }).catch(() => {})

    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)
  })
})

describe('cleanupWorkspaceOrHandOff', () => {
  afterEach(() => vi.useRealTimers())

  it('resolves when cleanup eventually succeeds', async () => {
    const cleanup = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    await expect(
      cleanupWorkspaceOrHandOff(cleanup, { context: { type: 'run', id: 'run_1' } }),
    ).resolves.toBeUndefined()
  })

  // The point of bounding the retries: an undeletable worktree must not cost
  // the Agent a permanent concurrency slot. A committed handoff means the
  // reservation now blocks that worktree, so the caller is free to release
  // its lease.
  it('swallows a committed handoff so the caller can release its lease', async () => {
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(
        new WorkspaceRemovalHandedOffError('scm_1:wt-a', { cause: new Error('EBUSY') }),
      )

    await expect(
      cleanupWorkspaceOrHandOff(cleanup, { context: { type: 'run', id: 'run_stuck' } }),
    ).resolves.toBeUndefined()
    // Terminal, not transient: retrying would re-run the guarded path against
    // a reservation this process no longer owns.
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('swallows a handoff wrapped in an exhaustion report', async () => {
    // The retry helper reports exhaustion and carries the real failure as
    // `cause`; the signal must survive that wrapping.
    const handoff = new WorkspaceRemovalHandedOffError('scm_1:wt-a', { cause: new Error('EBUSY') })
    const failingRetry = vi.fn(() =>
      Promise.reject(new WorkspaceCleanupExhaustedError({}, { cause: handoff })),
    )

    await expect(
      cleanupWorkspaceOrHandOff(() => Promise.resolve(), {
        context: { type: 'run', id: 'run_stuck' },
        retry: failingRetry,
      }),
    ).resolves.toBeUndefined()
  })

  // The bug this pins: cleanup does real work BEFORE the reservation exists —
  // reading the run, the Agent, the source row, building the SCM handle. A
  // failure in that stretch leaves no durable mark, so swallowing it would
  // release the lease and free the slot while the worktree sits unguarded.
  it('propagates exhaustion that never established a reservation', async () => {
    vi.useFakeTimers()
    const cleanup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('source row vanished mid-cleanup'))

    const settled = cleanupWorkspaceOrHandOff(cleanup, {
      retryDelayMs: 10,
      maxAttempts: 2,
      context: { type: 'run', id: 'run_stuck' },
    }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(await settled).toBeInstanceOf(WorkspaceCleanupExhaustedError)
  })

  it('propagates a non-exhaustion error unchanged', async () => {
    // Only exhaustion means "the reservation was handed off". Anything else —
    // a bug in the retry wrapper itself, an abort — has no such guarantee, so
    // swallowing it would silently skip cleanup with nothing tracking it.
    const boom = new TypeError('retry wrapper misuse')
    const failingRetry = vi.fn(() => Promise.reject(boom))

    await expect(
      cleanupWorkspaceOrHandOff(() => Promise.resolve(), {
        context: { type: 'run', id: 'run_broken' },
        retry: failingRetry,
      }),
    ).rejects.toBe(boom)
  })
})
