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
 *
 * A second rule covers busy requests: `opened` plus one `updated` per push can
 * all be queued behind a concurrency of 1, and every one of them would review
 * the request's CURRENT head once it runs. So an `opened` / `updated` run is
 * also skipped when a newer `opened` / `updated` run for the same request is
 * still live or already completed — that newer run does (or did) the review.
 * `commented` runs are never part of this: each comment is its own question.
 */
import type { GitTriggerProvider } from '@a2wave/shared'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import { fetchRequestState } from './git-trigger-cli.js'
import { logger } from './logger.js'

/** Events whose run reviews the request's code as of its head at execution time. */
const CODE_REVIEW_EVENTS: ReadonlySet<string> = new Set(['opened', 'updated'])

/**
 * Statuses of a newer run that make an older one redundant: it will review, is
 * reviewing, or has reviewed a later head. A failed or cancelled one did not.
 */
const SUPERSEDING_STATUSES: (typeof runs.$inferSelect.status)[] = [
  'pending',
  'queued',
  'running',
  'completed',
]
const SUPERSEDING_STATUS_SET: ReadonlySet<string> = new Set(SUPERSEDING_STATUSES)

/**
 * Upper bound on the newer runs inspected. The scan only covers runs created
 * while this one waited in the queue; past this many, fail open and run it.
 */
const SUPERSEDE_SCAN_LIMIT = 200

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

/** The run being checked, needed to find newer runs for the same request. */
export interface GitTriggerRunIdentity {
  runId: string
  agentId: string
  createdAt: Date
}

function requestRef(origin: GitTriggerRunOrigin): string {
  const ref = origin.provider === 'glab' ? '!' : '#'
  return `${origin.project}${ref}${origin.number}`
}

function isSameRequest(a: GitTriggerRunOrigin, b: GitTriggerRunOrigin): boolean {
  return (
    a.provider === b.provider &&
    a.project === b.project &&
    a.number === b.number &&
    (a.host ?? '') === (b.host ?? '')
  )
}

/** Id of a newer code-review run for the same request, or null. Throws on DB errors. */
async function findSupersedingRunId(
  origin: GitTriggerRunOrigin,
  self: GitTriggerRunIdentity,
): Promise<string | null> {
  const newer = await db
    .select({ id: runs.id, status: runs.status, executionMetadata: runs.executionMetadata })
    .from(runs)
    .where(
      and(
        eq(runs.initiatorAgentId, self.agentId),
        eq(runs.triggerSource, origin.provider),
        gt(runs.createdAt, self.createdAt),
        inArray(runs.status, SUPERSEDING_STATUSES),
      ),
    )
    .orderBy(asc(runs.createdAt))
    .limit(SUPERSEDE_SCAN_LIMIT)

  for (const row of newer) {
    if (row.id === self.runId || !SUPERSEDING_STATUS_SET.has(row.status)) continue
    const candidate = row.executionMetadata?.gitTriggerOrigin
    if (!candidate || !CODE_REVIEW_EVENTS.has(candidate.event)) continue
    if (isSameRequest(origin, candidate)) return row.id
  }
  return null
}

/**
 * Why this run should be skipped, or null to execute it.
 *
 * Costs at most one DB query and one CLI call (no tokens) and never throws.
 * `self` enables the superseded-by-a-newer-run check; without it only the
 * forge state is probed.
 */
export async function gitTriggerRunSkipReason(
  origin: GitTriggerRunOrigin,
  self?: GitTriggerRunIdentity,
): Promise<string | null> {
  if (origin.event === 'closed') return null

  if (self && CODE_REVIEW_EVENTS.has(origin.event)) {
    try {
      const supersedingRunId = await findSupersedingRunId(origin, self)
      if (supersedingRunId) {
        return `A newer run (${supersedingRunId}) for ${requestRef(origin)} reviews its latest head; skipped this "${origin.event}" run as a duplicate.`
      }
    } catch (err) {
      logger.warn({ err, ...origin }, 'git-trigger: superseded-run lookup threw; failing open')
    }
  }

  try {
    const state = await fetchRequestState(
      origin.provider,
      origin.project,
      origin.number,
      origin.host,
    )
    if (state !== 'merged' && state !== 'closed') return null

    const noun = origin.provider === 'glab' ? 'Merge request' : 'Pull request'
    return `${noun} ${requestRef(origin)} was ${state} before this run started; skipped the "${origin.event}" run to avoid spending tokens on a finished request.`
  } catch (err) {
    logger.warn({ err, ...origin }, 'git-trigger: preflight probe threw; failing open')
    return null
  }
}
