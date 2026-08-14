import { logger } from './logger.js'

/**
 * Hard deadline for the whole shutdown sequence.
 *
 * Part of the fail-stop timing budget: a fenced owner must be gone before the
 * peer-death threshold lets another replica reclaim its checkout. See the
 * assertion in `__tests__/fail-stop-timing.test.ts`, which fails if raising
 * this silently eats the margin.
 */
export const SHUTDOWN_HARD_TIMEOUT_MS = 10_000

/**
 * Side effects the graceful-shutdown sequence orchestrates, injected so the
 * ordering can be unit-tested without the real server/DB/process.
 */
export interface GracefulShutdownDeps {
  /** Terminate every active agent CLI child (SIGTERM → SIGKILL) and AWAIT exit. */
  shutdownEngines: () => Promise<void>
  stopFeishu: () => void
  stopSlack: () => void
  stopDiscord: () => void
  stopSchedules: () => void
  /** Persist durable SCM lease releases emitted while children exit. */
  drainExecutionLeases: () => Promise<void>
  /** Persist fenced workspace-removal reservation releases before DB close. */
  drainWorkspaceRemovalReleases: () => Promise<void>
  /**
   * Wait for fire-and-forget audit inserts to settle. `logAudit` returns void and
   * no route awaits it, so an entry can still be queued when the signal arrives —
   * and the request that triggered it has already returned 200. Closing the
   * database first would drop it, which Iron Rule 5 forbids.
   */
  drainAuditWrites: () => Promise<void>
  /**
   * Delete this instance's heartbeat row. Runs after every drain — the row is
   * what tells surviving replicas "do not touch my marks", so it must outlive
   * this process's own release attempts — and before the database closes. Any
   * mark a failed drain leaked becomes instantly recoverable by a peer; the
   * engines have already exited, so nothing here still uses a checkout.
   */
  releaseInstanceHeartbeat: () => Promise<void>
  /**
   * Close the database. Returns a promise on PostgreSQL, where closing drains a
   * connection pool over the network; SQLite closes synchronously. Awaited
   * either way, so an unawaited drain cannot let the process exit while
   * terminal-state writes are still in flight.
   */
  closeDatabase: () => void | Promise<void>
}

/**
 * Ordered shutdown: stop every producer, then reap child processes and wait for
 * their lifecycle cleanup. This prevents a channel callback from spawning new
 * work after the process runner took its shutdown snapshot. The database closes
 * only after workload and audit drains. Every step is guarded so one failure
 * cannot strand a later one.
 *
 * NOTE: engineRegistry also registers its own SIGTERM/SIGINT handler that calls
 * the same shutdown; both awaiting the idempotent cliProcessRunner.shutdown()
 * is harmless (second call finds no active processes).
 */
export async function runGracefulShutdownSequence(deps: GracefulShutdownDeps): Promise<void> {
  safely(deps.stopFeishu, 'stopFeishu')
  safely(deps.stopSlack, 'stopSlack')
  safely(deps.stopDiscord, 'stopDiscord')
  safely(deps.stopSchedules, 'stopSchedules')
  try {
    await deps.shutdownEngines()
  } catch (error) {
    logger.error({ error }, 'graceful-shutdown: failed to terminate agent CLI processes')
  }
  // After the engines (their terminal-state writes may themselves audit) and
  // strictly before the database closes.
  await safelyAsync(deps.drainExecutionLeases, 'drainExecutionLeases')
  await safelyAsync(deps.drainWorkspaceRemovalReleases, 'drainWorkspaceRemovalReleases')
  await safelyAsync(deps.drainAuditWrites, 'drainAuditWrites')
  await safelyAsync(deps.releaseInstanceHeartbeat, 'releaseInstanceHeartbeat')
  await safelyAsync(deps.closeDatabase, 'closeDatabase')
}

function safely(fn: () => void, label: string): void {
  try {
    fn()
  } catch (error) {
    logger.error({ error }, `graceful-shutdown: ${label} failed`)
  }
}

/**
 * `safely` for a step that may be asynchronous. Awaits the result so a rejected
 * promise is logged here rather than escaping as an unhandled rejection during
 * shutdown, where it would mask the real exit reason.
 */
async function safelyAsync(fn: () => void | Promise<void>, label: string): Promise<void> {
  try {
    await fn()
  } catch (error) {
    logger.error({ error }, `graceful-shutdown: ${label} failed`)
  }
}
