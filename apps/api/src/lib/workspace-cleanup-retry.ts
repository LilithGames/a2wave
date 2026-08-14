import { logger } from './logger.js'
import { WorkspaceRemovalHandedOffError } from './workspace-removal-outcome.js'

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
      // A committed handoff is terminal, not a transient failure: the removal
      // protocol already gave the reservation away, so retrying would re-run
      // the whole guarded path against a row this process no longer owns.
      if (error instanceof WorkspaceRemovalHandedOffError) throw error
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
 * The workload owner's cleanup boundary: try inline, and return normally only
 * when the worktree is either gone or provably guarded by a durable mark.
 *
 * The caller releases its workload lease as soon as this resolves, so the bar
 * for resolving is exactly: *something* now keeps other actors off this
 * worktree. Two outcomes clear it — cleanup succeeded, or the removal protocol
 * committed a reservation and handed it to the reconciler
 * (`WorkspaceRemovalHandedOffError`, raised only past the committed insert).
 *
 * Every other failure propagates and keeps the lease held. This is the
 * distinction an earlier version got wrong by swallowing any exhausted retry:
 * cleanup does substantial work *before* the reservation exists — resolving
 * the run, the Agent, the source row, building the SCM handle — and a failure
 * in that stretch leaves no durable mark whatsoever. Releasing the lease then
 * frees the slot and unpins the binding while the worktree sits unguarded on
 * disk, which is precisely the race the reservation was introduced to close.
 */
export async function cleanupWorkspaceOrHandOff(
  cleanup: () => Promise<void>,
  options: CleanupHandoffOptions,
): Promise<void> {
  const retry = options.retry ?? retryWorkspaceCleanup
  try {
    await retry(cleanup, options)
  } catch (error) {
    const handoff = findHandoffSignal(error)
    if (!handoff) throw error
    logger.warn(
      { ...options.context, reservationId: handoff.reservationId },
      'Workspace cleanup handed off to the reconciler; releasing the workload lease',
    )
  }
}

/**
 * The handoff signal arrives wrapped: the retry helper reports exhaustion and
 * carries the last real failure as `cause`. Unwrap one level rather than
 * matching on the outer type, which would readmit the over-broad rule.
 */
function findHandoffSignal(error: unknown): WorkspaceRemovalHandedOffError | null {
  if (error instanceof WorkspaceRemovalHandedOffError) return error
  if (error instanceof WorkspaceCleanupExhaustedError) {
    const cause = error.cause
    if (cause instanceof WorkspaceRemovalHandedOffError) return cause
  }
  return null
}
