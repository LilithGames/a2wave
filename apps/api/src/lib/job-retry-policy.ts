/**
 * Job-level retry policy.
 *
 * Distinct from `maxRetries` in execute-with-retry.ts, which retries *within* a
 * single job execution: same `runs` row, same concurrency slot, same workspace,
 * and — on a same-provider retry — the same chat session. That inner loop is the
 * right tool for a flaky subprocess, but it inherits whatever dirty state the
 * failed attempt left behind.
 *
 * A job retry is instead the automated equivalent of a user clicking "rerun" on a
 * failed run in the run list: a brand-new `runs` row replaying the original
 * intent, which re-enters the queue, takes a fresh workspace and a fresh chat
 * session. The original row stays `failed`, so every attempt remains its own
 * auditable record.
 *
 * Disabled by default (0). A job that already posted to a chat, opened an MR or
 * wrote to a live system through MCP has no idempotency key, so replaying it
 * repeats those effects — that call belongs to the Agent author, not to us.
 */
import { isHardQuotaError, isPermanentError } from './execute-with-retry.js'

export const JOB_RETRIES_MIN = 0
export const JOB_RETRIES_MAX = 3
export const JOB_RETRIES_DEFAULT = 0

export function clampJobRetries(v: number): number {
  return Math.max(JOB_RETRIES_MIN, Math.min(JOB_RETRIES_MAX, Math.floor(v)))
}

/** Why a job was not retried. Recorded in the audit entry so a silent no-retry is diagnosable. */
export type JobRetrySkipReason = 'disabled' | 'not_failed' | 'budget_spent' | 'permanent_error'

export interface JobRetryDecision {
  retry: boolean
  reason?: JobRetrySkipReason
}

export interface JobRetryInput {
  /** Terminal status of the run that just finished. */
  status: string
  /** Engine error message, when one was recorded. */
  error: string | undefined
  /** The Agent's configured budget (already clamped). */
  maxJobRetries: number
  /** How many job retries this chain has already spent. 0 for an original run. */
  attempt: number
}

/**
 * Should this finished run be replayed as a fresh job?
 *
 * Deliberately narrower than the manual rerun button, which is unconditional:
 * a human clicking it has judged the situation, while this fires unattended.
 * Two classes are therefore excluded even though the button would replay them:
 *
 *   - `cancelled` — someone asked for this to stop; restarting it overrides them.
 *   - permanent + hard-quota errors (401/403, content policy, worktree/SCM,
 *     session/daily/quota limits) — a fresh job hits the identical wall, so the
 *     replay only burns quota and files noise into the run list.
 *
 * Soft rate limits (429) are NOT excluded: by the time a job retry starts, the
 * rate window has usually moved on.
 */
export function shouldRetryJob(input: JobRetryInput): JobRetryDecision {
  const { status, error, maxJobRetries, attempt } = input

  if (maxJobRetries <= 0) return { retry: false, reason: 'disabled' }
  if (status !== 'failed') return { retry: false, reason: 'not_failed' }
  if (attempt >= maxJobRetries) return { retry: false, reason: 'budget_spent' }
  if (isPermanentError(error) || isHardQuotaError(error)) {
    return { retry: false, reason: 'permanent_error' }
  }

  return { retry: true }
}

/**
 * Attempt number for the run about to be created.
 *
 * The counter lives on the new run's `executionMetadata` and is carried forward
 * across the chain; without it each replay would read its own attempt as 0 and
 * retry forever.
 */
export function nextJobRetryAttempt(currentAttempt: number | undefined): number {
  return (currentAttempt ?? 0) + 1
}
