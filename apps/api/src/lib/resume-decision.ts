import type { FailureReasonCode } from './run-failure-reasons.js'

/**
 * How many times a single run may be resumed after an interruption.
 *
 * A crash that reproduces on resume would otherwise loop forever, which is
 * strictly worse than failing fast: the run never settles, its concurrency slot
 * never frees, and every attempt costs provider tokens. Three covers a rolling
 * deploy that restarts the container more than once while a long review runs.
 */
export const MAX_RESUME_ATTEMPTS = 3

/**
 * Failures that mean "the process went away", as opposed to "the work failed".
 *
 * Only these are safe to continue. Anything else failed on its own merits and
 * must not be resurrected by recovery.
 *
 * Reachability differs between the two, and the difference is not an oversight:
 * SERVER_RESTART_DURING_EXEC is what startup recovery is about to apply to a
 * still-`running` row, and is the live path. INSTANCE_STOPPED_DURING_EXEC is
 * written by the dead-instance reaper, which settles the row to `failed` in the
 * same update — and nothing requeues a `failed` row today, so no caller
 * currently reaches this branch with that code. It is accepted here so that
 * teaching the reaper to requeue is a one-line change rather than a semantic
 * one; until then, treat reaped runs as not resumed.
 */
const INTERRUPTION_CODES: ReadonlySet<string> = new Set<FailureReasonCode>([
  'SERVER_RESTART_DURING_EXEC',
  'INSTANCE_STOPPED_DURING_EXEC',
])

export interface ResumeCandidate {
  /** Session id recorded while the run was executing; null if it never announced one. */
  liveChatId: string | null
  /**
   * True when this run may be restarted from its original intent.
   *
   * Requires two things. Its CLI produced no output before the interruption —
   * recorded by the shared stdout tap on the first line, so it covers every
   * engine — which means it cannot have committed side effects. And its trigger
   * is fire-and-forget, so nothing is synchronously awaiting a verdict: an A2A
   * or gateway caller polling `tasks/get` must be told the truth rather than
   * left waiting on a task the protocol already called terminal.
   *
   * Without this, such a run is simply failed and a human re-triggers it — the
   * same replay, performed manually and later.
   */
  restartable?: boolean
  /** Resumes already spent on this run. */
  resumeAttempts: number
  /** Why the run was settled. */
  failureCode: FailureReasonCode | string
  /** True when the owning Agent no longer exists. */
  agentMissing?: boolean
  /** True when the user explicitly asked to start a fresh session. */
  sessionResetRequested?: boolean
}

export type ResumeDecision =
  /** `chatId: null` means "start over", reachable only for a restartable run. */
  | { resume: true; chatId: string | null; attempt: number }
  | {
      resume: false
      reason:
        | 'no-session'
        | 'attempts-exhausted'
        | 'not-interrupted'
        | 'agent-missing'
        | 'session-reset'
    }

/**
 * Decide whether an interrupted run may be continued from its provider session.
 *
 * Resume rather than re-run is the whole point: replaying the original prompt
 * would repeat side effects the CLI already committed — files written, messages
 * sent, merge requests opened. Continuing from the session id picks up after
 * them instead.
 */
export function decideResume(candidate: ResumeCandidate): ResumeDecision {
  // Checked first: nothing else can rescue a run whose Agent is gone, and
  // startup recovery archives these as dangling.
  if (candidate.agentMissing) return { resume: false, reason: 'agent-missing' }

  // An explicit reset is the user saying "start clean". Resuming anyway would
  // put them back in the session they just discarded, so the opt-out wins over
  // every automatic continuation below.
  if (candidate.sessionResetRequested) return { resume: false, reason: 'session-reset' }

  if (!INTERRUPTION_CODES.has(candidate.failureCode)) {
    return { resume: false, reason: 'not-interrupted' }
  }

  // Refusing without a session is right whenever the CLI actually ran: replaying
  // the prompt would repeat side effects it already committed. A run interrupted
  // before it emitted a single line has none of those.
  if (!candidate.liveChatId && !candidate.restartable) {
    return { resume: false, reason: 'no-session' }
  }

  const spent = candidate.resumeAttempts
  // A corrupt counter must fail closed. Reading NaN as "still has budget" would
  // reintroduce exactly the unbounded loop the ceiling exists to prevent.
  if (!Number.isInteger(spent) || spent < 0 || spent >= MAX_RESUME_ATTEMPTS) {
    return { resume: false, reason: 'attempts-exhausted' }
  }

  return { resume: true, chatId: candidate.liveChatId, attempt: spent + 1 }
}
