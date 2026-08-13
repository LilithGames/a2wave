import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Audit entries are written fire-and-forget: `logAudit` returns void and no route
 * awaits it, so the HTTP 200 is emitted while the insert is still in flight. That
 * is deliberate (an audit write must never fail the request that triggered it),
 * but it means a shutdown arriving in that window can close the database — and
 * then `process.exit(0)` — with entries still queued behind `runExclusive`.
 *
 * The result is the one state Iron Rule 5 forbids: the business write committed
 * and returned success, but no audit row exists. These tests pin the drain that
 * closes that window.
 */

const insertSpy = vi.fn()

vi.mock('../../db/client.js', () => ({
  db: { insert: (...args: unknown[]) => insertSpy(...args) },
}))

vi.mock('../../db/schema.js', () => ({ auditLogs: 'audit_logs' }))

// runExclusive is the real serialisation point in production; here it just runs
// the thunk so the test observes the drain rather than the SQLite mutex.
vi.mock('../../db/transaction.js', () => ({
  runExclusive: (fn: () => Promise<unknown>) => fn(),
}))

vi.mock('../client-ip.js', () => ({ resolveClientIp: () => '10.0.0.1' }))
vi.mock('../id.js', () => ({ createId: () => 'aud_test' }))
vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { logAudit, logBackgroundAudit, drainAuditWrites, writeAudit, writeBackgroundAudit } =
  await import('../audit.js')
const { logger } = await import('../logger.js')

/** A Hono-ish context stub: logAudit only reads `userId` off it. */
const ctx = { get: () => 'usr_admin', req: { header: () => undefined } } as never

/** An insert whose completion we control, to model a write still in flight. */
function deferredInsert() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  insertSpy.mockReturnValue({ values: () => gate })
  return release
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('drainAuditWrites', () => {
  it('waits for an in-flight audit insert to settle', async () => {
    const release = deferredInsert()
    let settled = false

    logAudit(ctx, { action: 'user.reset-password', resource: 'user' })

    const drained = drainAuditWrites().then(() => {
      settled = true
    })

    // Still pending: the insert has not completed, so the drain must not resolve.
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await drained
    expect(settled).toBe(true)
  })

  it('resolves immediately when nothing is in flight', async () => {
    await expect(drainAuditWrites()).resolves.toBeUndefined()
  })

  it('tracks logBackgroundAudit writes too', async () => {
    const release = deferredInsert()
    let settled = false

    void logBackgroundAudit({ action: 'evaluation_task.execute' })
    const drained = drainAuditWrites().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await drained
    expect(settled).toBe(true)
  })

  it('still resolves when the audit insert fails', async () => {
    // A failing write must not wedge shutdown — the drain has to settle either way.
    insertSpy.mockReturnValue({
      values: () => Promise.reject(new Error('database is locked')),
    })

    logAudit(ctx, { action: 'user.delete', resource: 'user' })

    await expect(drainAuditWrites()).resolves.toBeUndefined()
  })

  it('reports a failed audit write through the structured logger, not console', async () => {
    // A silently swallowed failure means a broken audit trail nobody can alert on.
    // console.error bypasses pino, so it misses the log pipeline entirely.
    insertSpy.mockReturnValue({
      values: () => Promise.reject(new Error('database is locked')),
    })

    logAudit(ctx, { action: 'user.delete', resource: 'user' })
    await drainAuditWrites()

    expect(logger.error).toHaveBeenCalled()
  })

  it('clears settled writes so the tracker does not grow unbounded', async () => {
    insertSpy.mockReturnValue({ values: () => Promise.resolve() })

    for (let i = 0; i < 5; i++) {
      logAudit(ctx, { action: 'agent.update', resource: 'agent' })
    }
    await drainAuditWrites()

    // A second drain with no new writes resolves without waiting on the old ones.
    await expect(drainAuditWrites()).resolves.toBeUndefined()
  })
})

describe('writeAudit', () => {
  it('propagates persistence failures to a transaction that must roll back', async () => {
    insertSpy.mockReturnValue({
      values: () => Promise.reject(new Error('audit disk full')),
    })

    await expect(
      writeAudit(ctx, { action: 'scm_source.delete', resource: 'scm_source' }),
    ).rejects.toThrow('audit disk full')
  })

  it('propagates background persistence failures to a recovery transaction', async () => {
    insertSpy.mockReturnValue({
      values: () => Promise.reject(new Error('audit disk full')),
    })

    await expect(
      writeBackgroundAudit({ action: 'scm_source.delete', resource: 'scm_source' }),
    ).rejects.toThrow('audit disk full')
  })
})
