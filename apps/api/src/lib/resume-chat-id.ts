import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { decideResume } from './resume-decision.js'

/** Metadata key counting how many times this run has already been resumed. */
export const RESUME_ATTEMPTS_KEY = 'resumeAttempts'

function readFailureCode(result: unknown): string {
  // Startup recovery and the reaper write a structured { code } object; normal
  // execution failures write a free-form string, which is never resumable.
  const error = (result as { error?: unknown } | null | undefined)?.error
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : ''
}

/**
 * The session an interrupted run should continue from, or null to start fresh.
 *
 * Resuming rather than replaying is the entire point: re-running the original
 * prompt would repeat side effects the CLI already committed — files written,
 * messages sent, merge requests opened.
 */
export async function resolveResumeChatId(runId: string): Promise<string | null> {
  const row = (
    await db
      .select({
        executionMetadata: runs.executionMetadata,
        result: runs.result,
        initiatorAgentId: runs.initiatorAgentId,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
  )[0]
  if (!row) return null
  return resumeChatIdFromRow(row)
}

/**
 * Same decision against a row the caller already holds.
 *
 * Preferred wherever the run row has just been read: it keeps the hot execution
 * path to the queries it already makes rather than adding a round-trip per run.
 */
export function resumeChatIdFromRow(row: {
  executionMetadata: unknown
  result: unknown
  initiatorAgentId: string | null
}): string | null {
  const metadata = row.executionMetadata as
    | { liveChatId?: unknown; resumeAttempts?: unknown }
    | null
    | undefined

  const decision = decideResume({
    liveChatId: typeof metadata?.liveChatId === 'string' ? metadata.liveChatId : null,
    resumeAttempts: typeof metadata?.resumeAttempts === 'number' ? metadata.resumeAttempts : 0,
    failureCode: readFailureCode(row.result),
    agentMissing: !row.initiatorAgentId,
  })

  return decision.resume ? decision.chatId : null
}

/**
 * Count a resume against this run's budget.
 *
 * Recorded before the attempt runs, not after: a resume that crashes the
 * process again must still have consumed its attempt, or the ceiling never
 * converges and a reproducible crash loops forever.
 */
export async function recordResumeAttempt(runId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const row = (
      await tx
        .select({ executionMetadata: runs.executionMetadata })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1)
    )[0]
    if (!row) return

    const metadata = (row.executionMetadata ?? {}) as Record<string, unknown>
    const spent =
      typeof metadata[RESUME_ATTEMPTS_KEY] === 'number' ? metadata[RESUME_ATTEMPTS_KEY] : 0
    await tx
      .update(runs)
      .set({ executionMetadata: { ...metadata, [RESUME_ATTEMPTS_KEY]: spent + 1 } })
      .where(eq(runs.id, runId))
  })
}
