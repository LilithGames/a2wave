import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  createRouterInvocationRegistry,
  installRouterShutdownHooks,
} from '../agent-router-lifecycle.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Agent Router process lifecycle', () => {
  it('waits for active invocation cleanup before exiting after SIGTERM', async () => {
    const signalSource = new EventEmitter()
    const stdin = new EventEmitter()
    const cancellation = deferred()
    const registry = createRouterInvocationRegistry()
    const close = vi.fn().mockResolvedValue(undefined)
    const exit = vi.fn()
    let invocationSignal: AbortSignal | undefined

    const invocation = registry.run(undefined, async (signal) => {
      invocationSignal = signal
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      await cancellation.promise
      return 'canceled'
    })

    installRouterShutdownHooks(registry, close, {
      signalSource,
      stdin,
      exit,
    })
    signalSource.emit('SIGTERM')

    await vi.waitFor(() => expect(invocationSignal?.aborted).toBe(true))
    expect(close).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()

    cancellation.resolve()
    await expect(invocation).resolves.toBe('canceled')
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(exit).toHaveBeenCalledWith(0)

    signalSource.emit('SIGINT')
    expect(close).toHaveBeenCalledOnce()
  })

  it('combines an MCP cancellation signal with the process lifetime signal', async () => {
    const registry = createRouterInvocationRegistry()
    const caller = new AbortController()
    let combinedSignal: AbortSignal | undefined

    const invocation = registry.run(caller.signal, async (signal) => {
      combinedSignal = signal
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return 'canceled'
    })

    caller.abort(new Error('MCP request canceled'))

    await expect(invocation).resolves.toBe('canceled')
    expect(combinedSignal?.aborted).toBe(true)
  })
})
