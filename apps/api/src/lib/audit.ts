import type { Context } from 'hono'
import { db } from '../db/client.js'
import { auditLogs } from '../db/schema.js'
import { runExclusive } from '../db/transaction.js'
import { resolveClientIp } from './client-ip.js'
import { createId } from './id.js'
import { logger } from './logger.js'

interface AuditEntry {
  action: string
  resource?: string
  resourceId?: string
  details?: Record<string, unknown>
  userId?: string
}

/**
 * Audit inserts that have been issued but not yet settled.
 *
 * Callers deliberately do not await these (an audit write must never fail the
 * request that triggered it), so without a registry nothing knows they exist —
 * and shutdown would close the database, then `process.exit(0)`, on top of a
 * still-queued entry. The business write has already committed and returned
 * success at that point, so the entry is not "logged late", it is lost, which
 * Iron Rule 5 forbids.
 *
 * Entries remove themselves once settled, so this stays bounded by in-flight
 * writes rather than growing with total audit volume.
 */
const inFlightAuditWrites = new Set<Promise<void>>()

function trackAuditWrite(write: Promise<void>): Promise<void> {
  const tracked: Promise<void> = write.finally(() => {
    inFlightAuditWrites.delete(tracked)
  })
  inFlightAuditWrites.add(tracked)
  return tracked
}

/**
 * Wait for every issued audit write to settle.
 *
 * Called from the graceful-shutdown sequence *before* the database closes. Each
 * tracked promise already has its own `.catch`, so a failing write resolves here
 * rather than rejecting — a broken audit trail must not wedge shutdown, and the
 * failure is reported through the logger by the writer itself.
 */
export async function drainAuditWrites(): Promise<void> {
  while (inFlightAuditWrites.size > 0) {
    // Re-read after each pass: settling one write can admit another that was
    // queued behind it on the SQLite mutex.
    await Promise.allSettled([...inFlightAuditWrites])
  }
}

/**
 * Records an audit entry from outside a request.
 *
 * Background work — evaluation execution above all — has no Hono context to
 * take the user or IP from, but still needs a trail: an evaluation task makes
 * real billable Agent calls, and without this the only record of them would be
 * the CRUD entry for creating the task. The identity therefore comes from the
 * row that scheduled the work rather than from a live session.
 */
export function logBackgroundAudit(
  entry: AuditEntry,
  executor: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  // Returns the (already error-handled) promise so a caller that *must* see the
  // row land before it goes away can await it — short-lived operator scripts
  // above all, which otherwise call process.exit() while the insert is still in
  // flight. Callers that keep firing and forgetting are unaffected: the .catch
  // below is still attached, so an ignored return value cannot become an
  // unhandled rejection.
  return trackAuditWrite(
    // runExclusive: on SQLite the whole process shares one connection, so an
    // audit insert issued while an unrelated transaction is open would join it
    // and be erased if that transaction rolls back — a dropped audit entry, and
    // an Iron Rule 5 breach. Waiting for the transaction to settle is the
    // difference between "logged late" and "silently lost". A caller that passes
    // a transaction handle as `executor` is opted out: that write is meant to be
    // part of that transaction.
    writeBackgroundAudit(entry, executor)
      .catch((err: unknown) => {
        // Deliberately not rethrown: an audit write must never fail the work that
        // triggered it, and most callers invoke this without awaiting. Swallowing
        // silently would hide a broken audit trail, so it goes through the
        // structured logger — console.error bypasses pino and its sinks, leaving
        // the one failure that most needs alerting invisible to the log pipeline.
        logger.error({ err, action: entry.action }, 'audit: failed to persist entry')
      })
      // The drivers disagree on what an insert resolves to (better-sqlite3 hands
      // back a RunResult, node-postgres does not). Callers only ever await this to
      // know the row landed, so discard the value and keep the dialect out of the
      // signature.
      .then(() => undefined),
  )
}

/** Persist a background audit entry and surface any write failure to the caller. */
export async function writeBackgroundAudit(
  entry: AuditEntry,
  executor: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  await runExclusive(async () => {
    await executor.insert(auditLogs).values({
      id: createId('aud'),
      userId: entry.userId ?? null,
      action: entry.action,
      resource: entry.resource ?? null,
      resourceId: entry.resourceId ?? null,
      details: entry.details ?? null,
      ipAddress: null,
    })
  })
}

/** Persist a request audit entry and surface any write failure to the caller. */
export async function writeAudit(
  c: Context,
  entry: AuditEntry,
  executor: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  const userId = entry.userId ?? (c.get('userId' as never) as string | undefined)
  const ipAddress = resolveClientIp(c) ?? null

  await runExclusive(async () => {
    await executor.insert(auditLogs).values({
      id: createId('aud'),
      userId: userId ?? null,
      action: entry.action,
      resource: entry.resource ?? null,
      resourceId: entry.resourceId ?? null,
      details: entry.details ?? null,
      ipAddress,
    })
  })
}

/** Queue an audit entry for ordinary request mutations. */
export function logAudit(
  c: Context,
  entry: AuditEntry,
  executor: Pick<typeof db, 'insert'> = db,
): void {
  // Most mutations have already committed when they audit, so keep their
  // historical fire-and-forget contract. Mutations that require the audit to be
  // part of their transaction call and await writeAudit directly.
  trackAuditWrite(
    writeAudit(c, entry, executor)
      .catch((err: unknown) => {
        logger.error({ err, action: entry.action }, 'audit: failed to persist entry')
      })
      .then(() => undefined),
  )
}
