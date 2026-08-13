import { describe, expect, it, vi } from 'vitest'
import { runGracefulShutdownSequence } from '../graceful-shutdown.js'

describe('runGracefulShutdownSequence', () => {
  function makeDeps() {
    const calls: string[] = []
    return {
      calls,
      deps: {
        // Async: terminates every active agent CLI child (SIGTERM → SIGKILL).
        shutdownEngines: vi.fn(async () => {
          calls.push('shutdownEngines:start')
          await Promise.resolve()
          calls.push('shutdownEngines:end')
        }),
        stopFeishu: vi.fn(() => calls.push('stopFeishu')),
        stopSlack: vi.fn(() => calls.push('stopSlack')),
        stopDiscord: vi.fn(() => calls.push('stopDiscord')),
        stopSchedules: vi.fn(() => calls.push('stopSchedules')),
        drainExecutionLeases: vi.fn(async () => {
          calls.push('drainExecutionLeases')
        }),
        drainAuditWrites: vi.fn(async () => {
          calls.push('drainAuditWrites')
        }),
        // Typed void (not the number `push` returns) so the async variants the
        // PostgreSQL path needs can be substituted in individual tests.
        closeDatabase: vi.fn((): void | Promise<void> => {
          calls.push('closeDatabase')
        }),
      },
    }
  }

  it('terminates child processes and AWAITS them before closing the database', async () => {
    const { calls, deps } = makeDeps()

    await runGracefulShutdownSequence(deps)

    // The core invariant this whole fix exists for: children are fully reaped
    // before the DB is closed, so their terminal-state writes don't hit a
    // closed connection and no orphan survives the process exit.
    expect(calls.indexOf('shutdownEngines:end')).toBeLessThan(calls.indexOf('closeDatabase'))
  })

  it('runs the full sequence in order: producers → engines → drains → database', async () => {
    const { calls, deps } = makeDeps()

    await runGracefulShutdownSequence(deps)

    expect(calls).toEqual([
      'stopFeishu',
      'stopSlack',
      'stopDiscord',
      'stopSchedules',
      'shutdownEngines:start',
      'shutdownEngines:end',
      'drainExecutionLeases',
      'drainAuditWrites',
      'closeDatabase',
    ])
  })

  it('drains in-flight audit writes BEFORE closing the database', async () => {
    // logAudit is fire-and-forget by design, so an entry can still be queued when
    // the signal arrives. Closing the DB first (then process.exit) turns "logged
    // late" into "never logged" for a request that already returned 200 — the
    // exact state Iron Rule 5 forbids.
    const { calls, deps } = makeDeps()

    await runGracefulShutdownSequence(deps)

    expect(calls.indexOf('drainAuditWrites')).toBeLessThan(calls.indexOf('closeDatabase'))
  })

  it('still closes the database when the audit drain fails', async () => {
    const { calls, deps } = makeDeps()
    deps.drainAuditWrites = vi.fn(async () => {
      throw new Error('drain exploded')
    })

    await runGracefulShutdownSequence(deps)

    expect(calls).toContain('closeDatabase')
  })

  it('awaits an async closeDatabase before resolving', async () => {
    // On PostgreSQL, closing means draining a connection pool — an async
    // operation. If the sequence merely calls it without awaiting, the process
    // exits mid-drain and in-flight terminal-state writes are lost.
    const { calls, deps } = makeDeps()
    // A real drain waits on socket I/O, so model it with a macrotask rather than
    // a resolved promise — a bare `await Promise.resolve()` would complete on the
    // microtask queue and pass even against a non-awaiting implementation.
    deps.closeDatabase = vi.fn(
      () =>
        new Promise<void>((done) =>
          setTimeout(() => {
            calls.push('closeDatabase:drained')
            done()
          }, 10),
        ),
    )

    await runGracefulShutdownSequence(deps)

    expect(calls).toContain('closeDatabase:drained')
  })

  it('continues when an async closeDatabase rejects', async () => {
    const { deps } = makeDeps()
    deps.closeDatabase = vi.fn(async () => {
      throw new Error('pool drain failed')
    })

    // A rejected drain must be logged, not turned into an unhandled rejection
    // that masks the exit code.
    await expect(runGracefulShutdownSequence(deps)).resolves.toBeUndefined()
  })

  it('still closes the database if child termination throws', async () => {
    const { calls, deps } = makeDeps()
    deps.shutdownEngines = vi.fn(async () => {
      throw new Error('kill failed')
    })

    await runGracefulShutdownSequence(deps)

    // A failure reaping children must not strand the DB open / skip cleanup.
    expect(calls).toContain('closeDatabase')
  })
})
