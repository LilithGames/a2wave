import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import { logger } from './logger.js'
import { mergeExecutionMetadata } from './merge-execution-metadata.js'
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
export async function resolveResumeChatId(
  runId: string,
  /**
   * The interruption this run is *about* to be settled with.
   *
   * Startup recovery asks before it writes, so the row it holds is still
   * `running` with no failure code at all. Reading the code off the row there
   * always yielded '' and refused every candidate — the feature was dead code.
   */
  assumeFailureCode?: string,
): Promise<string | null> {
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
  return resumeChatIdFromRow(row, assumeFailureCode)
}

/**
 * Same decision against a row the caller already holds.
 *
 * Preferred wherever the run row has just been read: it keeps the hot execution
 * path to the queries it already makes rather than adding a round-trip per run.
 */
export function resumeChatIdFromRow(
  row: {
    id?: string
    executionMetadata: unknown
    result: unknown
    initiatorAgentId: string | null
  },
  assumeFailureCode?: string,
): string | null {
  const metadata = row.executionMetadata as
    | { liveChatId?: unknown; resumeAttempts?: unknown; oauthResetSession?: unknown }
    | null
    | undefined

  const spent = metadata?.resumeAttempts
  const decision = decideResume({
    liveChatId: typeof metadata?.liveChatId === 'string' ? metadata.liveChatId : null,
    resumeAttempts: typeof spent === 'number' ? spent : 0,
    // The caller's assumption wins when it has one: recovery knows the code it
    // is about to write, which the row does not carry yet.
    failureCode: assumeFailureCode ?? readFailureCode(row.result),
    agentMissing: !row.initiatorAgentId,
    sessionResetRequested: metadata?.oauthResetSession === true,
  })

  // A corrupt counter disables resume for this run permanently, which is the
  // safe direction but invisible without a line saying so.
  if (!decision.resume && decision.reason === 'attempts-exhausted' && typeof spent === 'number') {
    if (!Number.isInteger(spent) || spent < 0) {
      logger.warn({ runId: row.id, resumeAttempts: spent }, 'corrupt resume counter; not resuming')
    }
  }

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
  // Shares the metadata merge with persistLiveSessionId: this column has
  // concurrent writers, and the increment must come from what is actually
  // stored or two racing resumes both read the same value and the budget
  // never converges.
  await mergeExecutionMetadata(runId, (current) => {
    const spent = current[RESUME_ATTEMPTS_KEY]
    return { [RESUME_ATTEMPTS_KEY]: (typeof spent === 'number' ? spent : 0) + 1 }
  })
}
