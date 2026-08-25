/**
 * Seam between run finalization and the job-retry scheduler.
 *
 * Kept separate from job-retry-scheduler.ts so run-launcher stays free of the
 * scheduler's transitive imports (execute-chat-run → the whole execution stack),
 * which would create an import cycle back through run-launcher itself. The
 * scheduler is therefore loaded lazily, only when a run actually failed.
 *
 * Never throws, and never awaits the replay: finalization must not be delayed or
 * broken by a retry decision.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, runs } from '../db/schema.js'
import { clampJobRetries } from './job-retry-policy.js'
import { logger } from './logger.js'

/**
 * Consider replaying a failed run as a fresh job.
 *
 * Reads the Agent's `maxJobRetries` from its persisted config rather than from
 * the in-flight payload: an owner who turned retries off mid-run has withdrawn
 * consent for the replay.
 */
export async function runJobRetryHook(runId: string, error: string | undefined): Promise<void> {
  try {
    const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0]
    if (!run) return

    // A run cancelled while it was failing must not be replayed; the policy
    // re-checks this, but reading the persisted status keeps the decision based
    // on what actually landed rather than on the caller's view of the outcome.
    if (run.status !== 'failed') return

    const agentId = run.initiatorAgentId
    if (!agentId) return

    const agent = (
      await db.select({ config: agents.config }).from(agents).where(eq(agents.id, agentId)).limit(1)
    )[0]
    if (!agent) return

    const raw = (agent.config as { maxJobRetries?: unknown } | null)?.maxJobRetries
    const maxJobRetries = clampJobRetries(
      raw != null && Number.isFinite(Number(raw)) ? Number(raw) : 0,
    )
    // Default-off: skip the scheduler import entirely for the common case.
    if (maxJobRetries <= 0) return

    const { maybeScheduleJobRetry } = await import('./job-retry-scheduler.js')
    await maybeScheduleJobRetry({ run, status: run.status, error, maxJobRetries })
  } catch (err) {
    logger.error(
      { runId, err: err instanceof Error ? err.message : String(err) },
      'Job auto-retry hook failed',
    )
  }
}
