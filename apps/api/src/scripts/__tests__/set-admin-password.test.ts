/**
 * Light-touch coverage for set-admin-password.ts — we run the script in a
 * non-TTY environment so the password prompt fails fast, exercising the
 * imports, the script-relative chdir, the readMaskedPassword TTY guard, and
 * the catch → process.exit(1) path. A TTY-driven test exercises the happy
 * path — the tokenVersion bump and audit log this script exists to write.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

/**
 * Wait until the script under test has attached its stdin 'data' listener.
 *
 * The listener is attached by a dynamic `import()`, so the wait races module
 * evaluation rather than anything this test controls. `vi.waitFor` defaults to
 * a **1000ms** timeout that does NOT follow `testTimeout`, so under a loaded
 * machine (the api suite runs files in parallel) evaluation can lose that race
 * and the test fails with a bare "not attached yet" — a flake with no relation
 * to the behaviour being asserted. The explicit timeout is generous because it
 * only bounds a failure path: when the listener attaches, the poll returns on
 * the next interval regardless.
 */
async function waitForStdinListener(stdin: EventEmitter): Promise<void> {
  await vi.waitFor(
    () => {
      if (stdin.listenerCount('data') === 0) throw new Error('not attached yet')
    },
    { timeout: 15000, interval: 10 },
  )
}

class ExitCalled extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

const dbGet = vi.fn()
const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  run: vi.fn(),
}

// The script wraps its writes in db.transaction so the credential change and
// its audit entry cannot land apart; the fake runs the callback with a `tx`
// that records which executor the audit was handed.
const txExecutor = { insert: vi.fn(), update: () => updateChain }
vi.mock('../../db/client.js', () => ({
  isPostgres: true,
  sqliteDatabase: null,
  db: {
    select: () => ({ from: () => ({ where: () => asyncQuery({ get: dbGet }) }) }),
    update: () => updateChain,
    transaction: (fn: (tx: unknown) => unknown) => fn(txExecutor),
  },
}))

vi.mock('../../db/schema.js', () => ({
  users: { id: 'users.id', username: 'users.username', tokenVersion: 'users.token_version' },
}))

vi.mock('../../lib/auth.js', () => ({
  hashPassword: vi.fn(async () => 'hashed'),
  validatePassword: vi.fn(() => ({ valid: true })),
}))

const logBackgroundAudit = vi.fn()
vi.mock('../../lib/audit.js', () => ({ logBackgroundAudit }))

let exitSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>
let chdirSpy: ReturnType<typeof vi.spyOn>
let stdinIsTTYBackup: boolean | undefined

beforeEach(() => {
  dbGet.mockReset()
  updateChain.set.mockClear()
  updateChain.where.mockClear()
  updateChain.run.mockClear()
  logBackgroundAudit.mockClear()
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitCalled(typeof code === 'number' ? code : 0)
  })
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {})
  stdinIsTTYBackup = process.stdin.isTTY
  // Force non-TTY so readMaskedPassword rejects immediately with a clear error.
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  vi.resetModules()
})

afterEach(() => {
  exitSpy.mockRestore()
  errorSpy.mockRestore()
  logSpy.mockRestore()
  chdirSpy.mockRestore()
  if (stdinIsTTYBackup !== undefined) {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: stdinIsTTYBackup,
      configurable: true,
    })
  }
})

describe('scripts/set-admin-password', () => {
  it('exits 1 and reports when admin is missing', async () => {
    dbGet.mockReturnValue(undefined)
    await expect(import('../set-admin-password.js?case=missing')).rejects.toBeInstanceOf(ExitCalled)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Admin user not found'))
    expect(updateChain.run).not.toHaveBeenCalled()
  })

  it('fails gracefully when stdin is not a TTY', async () => {
    dbGet.mockReturnValue({ id: 'usr_admin', username: 'admin' })
    await expect(import('../set-admin-password.js?case=no-tty')).rejects.toBeInstanceOf(ExitCalled)
    expect(errorSpy).toHaveBeenCalled()
    expect(updateChain.run).not.toHaveBeenCalled()
  })

  it('bumps tokenVersion and writes an audit entry on success', async () => {
    dbGet.mockReturnValue({ id: 'usr_admin', username: 'admin' })
    // Regression: the audit write was fired without await, so this short-lived
    // script could reach process.exit() with the insert still in flight — a
    // credential reset landing with no trail (Iron Rule 5).
    let auditSettled = false
    logBackgroundAudit.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      auditSettled = true
    })

    class FakeStdin extends EventEmitter {
      isTTY = true
      isRaw = false
      setRawMode = vi.fn((raw: boolean) => {
        this.isRaw = raw
        return this as unknown as NodeJS.ReadStream
      })
      resume = vi.fn(() => this as unknown as NodeJS.ReadStream)
      pause = vi.fn(() => this as unknown as NodeJS.ReadStream)
      setEncoding = vi.fn(() => this as unknown as NodeJS.ReadStream)
    }
    const fakeStdin = new FakeStdin()
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const importPromise = import('../set-admin-password.js?case=success')
    await waitForStdinListener(fakeStdin)
    for (const ch of 'Str0ngPass') fakeStdin.emit('data', ch)
    fakeStdin.emit('data', '\r')
    await waitForStdinListener(fakeStdin)
    for (const ch of 'Str0ngPass') fakeStdin.emit('data', ch)
    fakeStdin.emit('data', '\r')

    await expect(importPromise).rejects.toBeInstanceOf(ExitCalled)

    const setArg = updateChain.set.mock.calls[0][0]
    expect(setArg.passwordHash).toBe('hashed')
    expect(setArg.tokenVersion).toBeDefined() // sql`` template, opaque but present
    // Handed the transaction executor, not the ambient db — otherwise the audit
    // insert would commit independently of the credential change.
    expect(logBackgroundAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.password_reset',
        resource: 'user',
        resourceId: 'usr_admin',
      }),
      txExecutor,
    )
    // The exit path must not have been reached with the insert still pending.
    expect(auditSettled).toBe(true)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('revoked'))
  })

  it('swallows ANSI escape sequences instead of writing them into the password', async () => {
    dbGet.mockReturnValue({ id: 'usr_admin', username: 'admin' })
    const { hashPassword } = (await import('../../lib/auth.js')) as unknown as {
      hashPassword: ReturnType<typeof vi.fn>
    }

    class FakeStdin extends EventEmitter {
      isTTY = true
      isRaw = false
      setRawMode = vi.fn(() => this as unknown as NodeJS.ReadStream)
      resume = vi.fn(() => this as unknown as NodeJS.ReadStream)
      pause = vi.fn(() => this as unknown as NodeJS.ReadStream)
      setEncoding = vi.fn(() => this as unknown as NodeJS.ReadStream)
    }
    const fakeStdin = new FakeStdin()
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const importPromise = import('../set-admin-password.js?case=ansi')
    // Arrow keys around the real characters, plus one sequence split across two
    // 'data' events — dropping only the ESC byte would leave '[A' in the value.
    for (const send of ['Str0ng', '\x1b[A', 'Pass', '\x1b[', 'B', '\r']) {
      await waitForStdinListener(fakeStdin)
      fakeStdin.emit('data', send)
    }
    await waitForStdinListener(fakeStdin)
    fakeStdin.emit('data', 'Str0ngPass\r')

    await expect(importPromise).rejects.toBeInstanceOf(ExitCalled)
    expect(hashPassword).toHaveBeenCalledWith('Str0ngPass')
  })
})
