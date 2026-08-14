import { logger } from './logger.js'
import { retryUntilSuccess } from './retry-until-success.js'

const DEFAULT_RETRY_DELAY_MS = 1_000
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

interface WorkspaceCleanupRetryOptions {
  retryDelayMs?: number
  maxRetryDelayMs?: number
  context: Record<string, unknown>
}

/** Keep the workload owner alive until its workspace is actually clean. */
export async function retryWorkspaceCleanupUntilSuccess(
  cleanup: () => Promise<void>,
  options: WorkspaceCleanupRetryOptions,
): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maxRetryDelayMs = Math.max(
    retryDelayMs,
    options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
  )
  await retryUntilSuccess(cleanup, {
    initialDelayMs: retryDelayMs,
    maxDelayMs: maxRetryDelayMs,
    onFailure: (error, nextRetryDelayMs) => {
      logger.warn(
        { error, ...options.context, retryDelayMs: nextRetryDelayMs },
        'Workspace cleanup failed; retaining the workload lease and retrying',
      )
    },
  })
}
