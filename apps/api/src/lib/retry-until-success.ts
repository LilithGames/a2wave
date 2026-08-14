export interface RetryUntilSuccessOptions {
  initialDelayMs: number
  maxDelayMs: number
  wait?: (delayMs: number) => Promise<void>
  onFailure: (error: unknown, retryDelayMs: number) => void
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

/** Retry an ownership-critical operation with capped exponential backoff. */
export async function retryUntilSuccess<T>(
  operation: () => Promise<T>,
  options: RetryUntilSuccessOptions,
): Promise<T> {
  let retryDelayMs = options.initialDelayMs
  const maxDelayMs = Math.max(retryDelayMs, options.maxDelayMs)
  const wait = options.wait ?? defaultWait

  for (;;) {
    try {
      return await operation()
    } catch (error) {
      options.onFailure(error, retryDelayMs)
      await wait(retryDelayMs)
      retryDelayMs = Math.min(retryDelayMs * 2, maxDelayMs)
    }
  }
}
