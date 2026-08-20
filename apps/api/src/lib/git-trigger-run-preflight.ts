/**
 * Pre-execution staleness check for `glab` / `gh` triggered runs.
 *
 * A trigger legitimately fires while a merge/pull request is open, but the Run
 * may only leave the queue minutes later — and fast-moving repositories merge
 * within a minute of opening. Executing then spends the Agent's tokens on a
 * request that is already merged, which to the operator reads as "a closed MR
 * triggered my agent even though I never subscribed to closed".
 *
 * The rule: a run fired for `opened` / `updated` / `commented` describes an
 * OPEN request; if the request has left the open set by execution time, the
 * run is skipped. A `closed`-event run is never checked — its subject is
 * supposed to be gone. Every ambiguous verdict (CLI failure, transient state)
 * fails open into "run it": a duplicate wake is visible and cheap next to a
 * silently cancelled legitimate run.
 */
import type { GitTriggerProvider } from '@a2wave/shared'
import { fetchRequestState } from './git-trigger-cli.js'
import { logger } from './logger.js'

/**
 * Identity of the request one git-trigger run was fired for, as persisted on
 * the run row.
 *
 * `event` is a plain string rather than `GitTriggerEvent`: this is read back
 * out of a JSON column written by an older build, so it must describe what the
 * column can actually hold. Only the `closed` value is behaviourally special
 * and it is compared by value, so an unrecognised event degrades into the
 * ordinary "probe it" path rather than a type error at the read site.
 */
export interface GitTriggerRunOrigin {
  provider: GitTriggerProvider
  event: string
  project: string
  number: number
  host?: string
}

/**
 * Why this run should be skipped, or null to execute it.
 *
 * Costs one CLI call (no tokens) and never throws.
 */
export async function gitTriggerRunSkipReason(origin: GitTriggerRunOrigin): Promise<string | null> {
  if (origin.event === 'closed') return null

  try {
    const state = await fetchRequestState(
      origin.provider,
      origin.project,
      origin.number,
      origin.host,
    )
    if (state !== 'merged' && state !== 'closed') return null

    const noun = origin.provider === 'glab' ? 'Merge request' : 'Pull request'
    const ref = origin.provider === 'glab' ? '!' : '#'
    return `${noun} ${origin.project}${ref}${origin.number} was ${state} before this run started; skipped the "${origin.event}" run to avoid spending tokens on a finished request.`
  } catch (err) {
    logger.warn({ err, ...origin }, 'git-trigger: preflight probe threw; failing open')
    return null
  }
}
