type RouterSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP'

interface EventSource {
  once(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}

interface RouterShutdownHookDependencies {
  signalSource?: EventSource
  stdin?: EventSource
  exit?: (code: number) => void
}

export interface RouterInvocationRegistry {
  run<T>(
    parentSignal: AbortSignal | null | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>
  shutdown(reason: Error): Promise<void>
}

export function createRouterInvocationRegistry(): RouterInvocationRegistry {
  const shutdownController = new AbortController()
  const activeInvocations = new Set<Promise<unknown>>()
  let shutdownPromise: Promise<void> | undefined

  return {
    run<T>(
      parentSignal: AbortSignal | null | undefined,
      operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      if (shutdownController.signal.aborted) {
        return Promise.reject(shutdownController.signal.reason)
      }

      const signal = parentSignal
        ? AbortSignal.any([parentSignal, shutdownController.signal])
        : shutdownController.signal
      let invocation: Promise<T>
      try {
        invocation = Promise.resolve(operation(signal))
      } catch (error) {
        invocation = Promise.reject(error)
      }
      activeInvocations.add(invocation)
      void invocation.finally(() => activeInvocations.delete(invocation)).catch(() => undefined)
      return invocation
    },

    shutdown(reason: Error): Promise<void> {
      if (shutdownPromise) return shutdownPromise
      shutdownController.abort(reason)
      shutdownPromise = Promise.allSettled([...activeInvocations]).then(() => undefined)
      return shutdownPromise
    },
  }
}

export function installRouterShutdownHooks(
  registry: RouterInvocationRegistry,
  close: () => Promise<void>,
  dependencies: RouterShutdownHookDependencies = {},
): () => void {
  const signalSource = dependencies.signalSource ?? process
  const stdin = dependencies.stdin ?? process.stdin
  const exit = dependencies.exit ?? ((code: number) => process.exit(code))
  let shutdownStarted = false

  const beginShutdown = (reason: RouterSignal | 'stdin-closed') => {
    if (shutdownStarted) return
    shutdownStarted = true
    void registry
      .shutdown(new Error(`Agent Router parent terminated (${reason})`))
      .then(close)
      .then(
        () => exit(0),
        (error) => {
          console.error('[agent-router] Graceful shutdown failed:', error)
          exit(1)
        },
      )
  }

  const signalListeners = new Map<RouterSignal, () => void>()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    const listener = () => beginShutdown(signal)
    signalListeners.set(signal, listener)
    signalSource.once(signal, listener)
  }
  const stdinEndListener = () => beginShutdown('stdin-closed')
  const stdinCloseListener = () => beginShutdown('stdin-closed')
  stdin.once('end', stdinEndListener)
  stdin.once('close', stdinCloseListener)

  return () => {
    for (const [signal, listener] of signalListeners) {
      signalSource.removeListener(signal, listener)
    }
    stdin.removeListener('end', stdinEndListener)
    stdin.removeListener('close', stdinCloseListener)
  }
}
