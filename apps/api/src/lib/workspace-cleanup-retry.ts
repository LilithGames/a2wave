import { logger } from './logger.js'

const DEFAULT_RETRY_DELAY_MS = 1_000

interface WorkspaceCleanupRetryOptions {
  retryDelayMs?: number
  context: Record<string, unknown>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Keep the workload owner alive until its workspace is actually clean. */
export async function retryWorkspaceCleanupUntilSuccess(
  cleanup: () => Promise<void>,
  options: WorkspaceCleanupRetryOptions,
): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  for (;;) {
    try {
      await cleanup()
      return
    } catch (error) {
      logger.warn(
        { error, ...options.context, retryDelayMs },
        'Workspace cleanup failed; retaining the workload lease and retrying',
      )
      await delay(retryDelayMs)
    }
  }
}
