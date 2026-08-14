import { logger } from './logger.js'

const DEFAULT_RETRY_DELAY_MS = 1_000
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000
/**
 * Roughly a minute of inline effort under the default backoff. Enough to ride
 * out the transient cases (a CLI still releasing a file handle, a slow unlink);
 * past that the failure is structural and the reconciler is better placed to
 * keep retrying than a process holding a concurrency slot open.
 */
const DEFAULT_MAX_ATTEMPTS = 6

interface WorkspaceCleanupRetryOptions {
  retryDelayMs?: number
  maxRetryDelayMs?: number
  maxAttempts?: number
  wait?: (delayMs: number) => Promise<void>
  context: Record<string, unknown>
}

interface CleanupHandoffOptions extends WorkspaceCleanupRetryOptions {
  /** Injection seam for the retry step; production uses `retryWorkspaceCleanup`. */
  retry?: (cleanup: () => Promise<void>, options: WorkspaceCleanupRetryOptions) => Promise<void>
}

/** Signals that inline cleanup gave up; the caller must hand the removal off. */
export class WorkspaceCleanupExhaustedError extends Error {
  constructor(context: Record<string, unknown>, options: { cause: unknown }) {
    super(`Workspace cleanup did not succeed within its attempt budget: ${JSON.stringify(context)}`)
    this.name = 'WorkspaceCleanupExhaustedError'
    this.cause = options.cause
  }
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

/**
 * Retry a workload owner's own workspace cleanup a bounded number of times.
 *
 * Bounded, not unbounded: the owner is the fastest path to a clean worktree
 * while the failure is transient, but it holds a concurrency slot and its
 * Agent's SCM binding open for as long as it keeps trying. A worktree that
 * genuinely cannot be removed right now (a stuck handle, a file the exited CLI
 * has not released) would pin both for the life of the process. On exhaustion
 * the caller hands the removal reservation to the periodic reconciler, which
 * retries without holding anything.
 */
export async function retryWorkspaceCleanup(
  cleanup: () => Promise<void>,
  options: WorkspaceCleanupRetryOptions,
): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maxRetryDelayMs = Math.max(
    retryDelayMs,
    options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
  )
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const wait = options.wait ?? defaultWait

  let delayMs = retryDelayMs
  for (let attempt = 1; ; attempt++) {
    try {
      await cleanup()
      return
    } catch (error) {
      if (attempt >= maxAttempts) {
        logger.warn(
          { error, ...options.context, attempts: attempt },
          'Workspace cleanup exhausted its inline attempts; handing the removal to the reconciler',
        )
        throw new WorkspaceCleanupExhaustedError(options.context, { cause: error })
      }
      logger.warn(
        { error, ...options.context, retryDelayMs: delayMs },
        'Workspace cleanup failed; retaining the workload lease and retrying',
      )
      await wait(delayMs)
      delayMs = Math.min(delayMs * 2, maxRetryDelayMs)
    }
  }
}

/**
 * The workload owner's cleanup boundary: try inline, and treat exhaustion as a
 * completed handoff rather than an error.
 *
 * By the time this returns, either the worktree is gone or its removal
 * reservation has been handed to the reconciler — which keeps every
 * counter-party off that worktree and its source. The caller may therefore
 * release its lease and free the concurrency slot, which is the whole point:
 * one undeletable directory must not cost an Agent a permanent slot.
 *
 * A non-exhaustion error still propagates; it means cleanup failed in a way
 * that never reached the removal protocol, so nothing was handed off.
 */
export async function cleanupWorkspaceOrHandOff(
  cleanup: () => Promise<void>,
  options: CleanupHandoffOptions,
): Promise<void> {
  const retry = options.retry ?? retryWorkspaceCleanup
  try {
    await retry(cleanup, options)
  } catch (error) {
    if (!(error instanceof WorkspaceCleanupExhaustedError)) throw error
    logger.warn(
      { ...options.context },
      'Workspace cleanup handed off to the reconciler; releasing the workload lease',
    )
  }
}
