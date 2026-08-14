/**
 * Pure change detection for the `glab` / `gh` trigger channels.
 *
 * Deliberately free of I/O: it takes the previous fingerprint and the requests
 * a poll just observed, and returns the events that fired plus the next
 * fingerprint. Keeping it pure is what makes the interesting cases — cold
 * start, overflow, a request disappearing — testable without a forge, a CLI, or
 * a clock.
 *
 * Why a per-request fingerprint rather than a hash of the whole response: a
 * single opaque hash can only answer "did anything change", so the Agent would
 * have to re-fetch and re-derive the change itself on every wake — spending the
 * tokens this channel exists to save. Diffing per request instead names the
 * exact merge request and the exact transition, which is what the Agent
 * actually needs and what makes overflow safely resumable.
 *
 * ## The one rule, and why it is enforced in one place
 *
 * Everything here serves a single invariant:
 *
 *   **A stored fingerprint advances if and only if this tick handled that
 *   request's current state.**
 *
 * Advance too eagerly and the change is lost with no retry; advance too rarely
 * and the Agent is woken twice for the same thing. Five separate defects on this
 * branch were all violations of that one rule, found one at a time because the
 * decision was spread across four sequential passes over the same map — each bug
 * fix added a pass, and the passes then disagreed with each other.
 *
 * So `retainedFingerprint` is now the sole authority: one function, asked once
 * per request. A new event type or filter extends that function; it must not add
 * another pass. `rollbackUnhandled` is the only sanctioned way to fold in an
 * outcome the diff could not know (a dispatch the queue refused), and it applies
 * the same rule rather than a second copy of it.
 *
 * `__tests__/git-trigger-invariants.test.ts` asserts the rule over randomised
 * inputs. It was verified to fail when either historical bug is reintroduced —
 * example-based tests only pin the case someone already thought of, which is
 * precisely why each earlier variant got through.
 */
import {
  GIT_TRIGGER_MAX_PAGES,
  GIT_TRIGGER_MAX_RUNS_PER_TICK,
  type GitTriggerEvent,
  type GitTriggerRepoState,
  type GitTriggerRequestState,
  type GitTriggerScope,
} from '@a2wave/shared'

/**
 * Hard ceiling on fingerprints kept for one watch entry.
 *
 * Only reached when an entry permanently exceeds its page budget, where closure
 * can never be proven and entries would otherwise be retained forever.
 *
 * Must stay above the largest listing a single entry can observe, or the ceiling
 * starts fighting the ordinary case instead of bounding the pathological one: a
 * wide scope can return `GIT_TRIGGER_MAX_PAGES × 100` = 500 requests, and at the
 * previous 300 the observed set alone exhausted the ceiling, leaving a retention
 * budget of zero. Every unprovable entry was then dropped and re-fired as
 * `opened` on the next tick — a duplicate-wake loop on exactly the large
 * namespaces this feature exists to serve.
 */
export const MAX_RETAINED_REQUESTS = GIT_TRIGGER_MAX_PAGES * 100 + 200

/** A merge/pull request as normalized from either CLI's list output. */
export interface ObservedRequest {
  number: number
  sha: string
  comments: number
  title: string
  url?: string
  author?: string
  sourceBranch?: string
  targetBranch?: string
  updatedAt?: string
  isDraft: boolean
  /**
   * The repository this request actually belongs to.
   *
   * Only set by a listing that spans repositories (the `group` and `all`
   * scopes), where the watch entry names a namespace and each request comes from
   * a different project underneath it. The caller knows the path already for a
   * single-project listing, so it stays absent there rather than being
   * duplicated into every entry.
   */
  project?: string
}

export interface GitTriggerFiredEvent {
  event: GitTriggerEvent
  request: ObservedRequest
}

export interface DiffResult {
  /** Events to turn into Runs this tick, already capped. */
  fired: GitTriggerFiredEvent[]
  /** Fingerprint to persist. */
  nextState: GitTriggerRepoState
  /**
   * Events suppressed by the per-tick cap. Their fingerprints are deliberately
   * NOT advanced in `nextState`, so the next poll re-detects them; this list
   * exists for logging, so a throttled tick is visible rather than silent.
   */
  deferred: GitTriggerFiredEvent[]
  /** True when this was a cold start and the state was only seeded. */
  seeded: boolean
}

/**
 * Identity of one request within a watch entry's state.
 *
 * A merge request number is only unique *within its repository*, and a `group`
 * or `all` scope holds many. Keying on the number alone therefore made
 * `repo-a!42` and `repo-b!42` the same entry: whichever the listing mentioned
 * second overwrote the first's fingerprint, so one repository's push looked like
 * the other's, and every tick fired a bogus `updated` for both while genuinely
 * new commits went unreported.
 *
 * Qualifying by project removes the collision. A single-project listing sets no
 * `project` — the entry is already unique there — so its keys stay bare numbers
 * and every fingerprint stored before scopes existed keeps matching.
 */
export function requestKey(request: { number: number; project?: string }): string {
  return request.project ? `${request.project}!${request.number}` : String(request.number)
}

function fingerprint(request: ObservedRequest): GitTriggerRequestState {
  return {
    number: request.number,
    sha: request.sha,
    comments: request.comments,
    ...(request.updatedAt ? { updatedAt: request.updatedAt } : {}),
    // Carried for the `closed` event, which can only be reconstructed from what
    // was stored — the forge has already stopped listing the request by then.
    ...(request.title ? { title: request.title } : {}),
    ...(request.url ? { url: request.url } : {}),
    // Same reason as title/url: a closed request is gone from the listing, so
    // the stored copy is the only thing that can still name its repository.
    ...(request.project ? { project: request.project } : {}),
  }
}

/** Every request number the tick knows about, from either side of the diff. */
function allKnownKeys(observed: ObservedRequest[], previous: GitTriggerRepoState): Set<string> {
  const keys = new Set(Object.keys(previous.requests))
  for (const request of observed) keys.add(requestKey(request))
  return keys
}

/**
 * The single authority on what one request's stored fingerprint becomes.
 *
 * Every rule about retention lives here, because splitting them across passes is
 * exactly what let those rules disagree. The question is always the same: *was
 * this request's current state handled this tick?* Advance only then.
 *
 * - `keep`      — persist this fingerprint
 * - `unprovable` — keep only if the retention budget allows (see caller)
 * - neither     — drop it; the request is gone and its event already fired
 */
function retainedFingerprint(input: {
  key: string
  observed: ObservedRequest | undefined
  prior: GitTriggerRequestState | undefined
  deferred: boolean
  stillOpen: boolean
  listingComplete: boolean
}): { keep?: GitTriggerRequestState; unprovable?: GitTriggerRequestState } {
  const { observed, prior, deferred, stillOpen, listingComplete } = input

  if (observed) {
    // Deferred by the per-tick cap: nothing acted on this change, so the old
    // fingerprint must survive for the next tick to re-detect it. A deferred
    // *new* request has no old fingerprint, and recording its current one would
    // mark it seen — turning the rate cap into silent data loss — so it is left
    // out entirely and reappears as new.
    if (deferred) return prior ? { keep: prior } : {}
    return { keep: fingerprint(observed) }
  }

  // Absent from the filtered listing but still open upstream: hidden by a
  // filter (drafted again, retargeted), not closed. The fingerprint is kept so
  // the request is not treated as new, and flagged so its RETURN is detectable —
  // otherwise "draft → ready for review" moves no tracked field and fires
  // nothing at all.
  if (stillOpen) return prior ? { keep: { ...prior, filtered: true } } : {}

  // Absent from a listing that may be truncated: absence proves nothing, so the
  // entry is a retention candidate rather than a confirmed close.
  if (!listingComplete) return prior ? { unprovable: prior } : {}

  // Absent from a complete listing: genuinely gone. Dropped whether or not
  // `closed` was subscribed — emitting an event and retiring a fingerprint are
  // different questions, and conflating them once made a config without
  // `closed` retain every request it had ever seen.
  //
  // The exception is a `closed` event the cap deferred: its fingerprint is the
  // only surviving record, so it is held until the event actually fires.
  if (deferred) return prior ? { keep: prior } : {}
  return {}
}

function buildState(requests: ObservedRequest[], polledAt: string): GitTriggerRepoState {
  const next: Record<string, GitTriggerRequestState> = {}
  for (const request of requests) {
    next[requestKey(request)] = fingerprint(request)
  }
  return { requests: next, polledAt }
}

/**
 * Whether a request passes the config's client-side filters.
 *
 * Applied here rather than in the API query because neither CLI exposes a
 * target-branch filter uniformly, and filtering the already-fetched list costs
 * nothing extra.
 */
export function matchesFilters(
  request: ObservedRequest,
  filters: { targetBranches: string[]; ignoreDrafts: boolean },
): boolean {
  if (filters.ignoreDrafts && request.isDraft) return false
  if (filters.targetBranches.length > 0) {
    if (!request.targetBranch) return false
    if (!filters.targetBranches.includes(request.targetBranch)) return false
  }
  return true
}

/**
 * Diff one repository's observed requests against its stored fingerprint.
 *
 * Cold start (`previous` null/absent) seeds the fingerprint and fires nothing:
 * enabling the channel on a repository with fifty open merge requests would
 * otherwise launch fifty Runs at once, which is both a token bill and a
 * thundering herd against the Agent's own concurrency limit. Only genuine
 * post-baseline movement is an event.
 */
export function diffRepoState(params: {
  previous: GitTriggerRepoState | null | undefined
  observed: ObservedRequest[]
  events: GitTriggerEvent[]
  polledAt: string
  maxRunsPerTick?: number
  /**
   * Every open request the forge reported, *before* the config's filters ran.
   *
   * `closed` is inferred from absence, and absence has two very different
   * causes: the request really left the open set, or it merely stopped matching
   * a filter. Without this, marking an open request back to draft (with
   * `ignoreDrafts` on) drops it from `observed` and is misread as "merged or
   * closed" — waking the Agent to act on a merge that never happened. Defaults
   * to `observed` for callers that apply no filtering.
   */
  observedUnfiltered?: ObservedRequest[]
  /**
   * Whether the listing is known to be complete.
   *
   * `closed` is inferred from absence, which is only sound when the whole open
   * set was actually seen. Both forges cap a page at 100 and sort by recent
   * activity, so in a busy repository the least recently touched open request
   * silently falls off page one — and absence-from-a-truncated-page is
   * indistinguishable from closure. That fires a bogus `closed`, then an
   * `opened` when a comment pushes it back onto the page: a permanent flap on a
   * completely healthy forge. When the listing may be truncated, closure is not
   * inferred at all; fingerprints are retained instead, so a genuine close is
   * simply reported on a later tick.
   */
  listingComplete?: boolean
}): DiffResult {
  const { previous, observed, events, polledAt } = params
  const cap = params.maxRunsPerTick ?? GIT_TRIGGER_MAX_RUNS_PER_TICK
  const wanted = new Set(events)
  const stillOpen = new Set(
    (params.observedUnfiltered ?? observed).map((request) => requestKey(request)),
  )
  const listingComplete = params.listingComplete ?? true
  const canInferClosed = wanted.has('closed') && listingComplete

  if (!previous || !previous.requests) {
    return { fired: [], deferred: [], nextState: buildState(observed, polledAt), seeded: true }
  }

  const observedByNumber = new Map(observed.map((r) => [requestKey(r), r]))
  const candidates: GitTriggerFiredEvent[] = []
  const seen = new Set<string>()

  for (const request of observed) {
    const key = requestKey(request)
    seen.add(key)
    const prior = previous.requests[key]

    if (!prior) {
      if (wanted.has('opened')) candidates.push({ event: 'opened', request })
      continue
    }

    // Back from behind a filter — most often a draft marked ready for review.
    // Reported as `opened` because that is what it means to the Agent: this
    // request is now eligible for the work the channel exists to trigger. The
    // underlying fields need not have moved, so no other rule would catch it.
    //
    // The skip belongs INSIDE the subscription check, for the same reason it
    // does below: hoisting it out swallows whatever else moved while the
    // request was hidden. A config watching only `updated` would see nothing
    // fire on the return while the fingerprint advanced past commits pushed
    // during the draft — losing them outright. This is the third occurrence of
    // that shape in this loop, which is why the property test now models
    // subscription rather than excusing every non-firing case.
    if (prior.filtered && wanted.has('opened')) {
      candidates.push({ event: 'opened', request })
      continue
    }

    // A request can legitimately gain commits *and* comments between two polls.
    // Firing both would wake the Agent twice for one logical change, so the
    // more specific transition wins: new commits change what needs reviewing,
    // whereas a comment on top of them is part of the same update.
    //
    // The skip belongs INSIDE the subscription check. Hoisting it out collapses
    // the two events before asking whether `updated` was even subscribed to, so
    // a config watching only `commented` fired nothing while the fingerprint
    // still advanced past the new comment count — the comment was lost for good,
    // not merely deferred.
    if (prior.sha !== request.sha && wanted.has('updated')) {
      candidates.push({ event: 'updated', request })
      continue
    }

    if (request.comments > prior.comments) {
      if (wanted.has('commented')) candidates.push({ event: 'commented', request })
    }
  }

  // A request that left the open set. The forge no longer lists it, so the only
  // evidence is its absence — we reconstruct a minimal request from the stored
  // fingerprint rather than dropping the event.
  //
  // `stillOpen` is checked against the *unfiltered* listing: a request that is
  // merely hidden by a filter (converted back to draft, retargeted to another
  // branch) is still open, and reporting it as closed would be a lie.
  if (canInferClosed) {
    for (const [key, prior] of Object.entries(previous.requests)) {
      if (seen.has(key) || stillOpen.has(key)) continue
      candidates.push({
        event: 'closed',
        request: {
          number: prior.number,
          sha: prior.sha,
          comments: prior.comments,
          title: prior.title ?? '',
          isDraft: false,
          ...(prior.updatedAt ? { updatedAt: prior.updatedAt } : {}),
          ...(prior.url ? { url: prior.url } : {}),
          // Restores the identity this event is keyed on. Without it the
          // reconstructed request keys as a bare number, so `rollbackUnhandled`
          // would look up the wrong entry and the intent would name the group
          // instead of the repository that actually merged.
          ...(prior.project ? { project: prior.project } : {}),
        },
      })
    }
  }

  /**
   * Terminal events go first when the cap bites.
   *
   * `closed` candidates are appended after the observed-request loop, so plain
   * insertion order put them last — and on a repository that reliably produces
   * `cap` opened/updated/commented candidates per tick they were re-deferred
   * every tick and never fired at all. An Agent configured for merges (release
   * notes, deployment kick-off) would silently never run.
   *
   * `closed` is also the only event that cannot be re-derived later: the others
   * remain visible in the listing until handled, whereas a merged request is
   * gone from the forge and survives only as the fingerprint this tick is about
   * to drop. Ordering is stable within each group, so nothing else changes.
   */
  const ordered = [
    ...candidates.filter((candidate) => candidate.event === 'closed'),
    ...candidates.filter((candidate) => candidate.event !== 'closed'),
  ]
  const fired = ordered.slice(0, cap)
  const deferred = ordered.slice(cap)

  /**
   * Build the next state in ONE pass, from ONE rule per request.
   *
   * This replaced four sequential passes that each re-decided the same map, and
   * that shape is what produced five separate defects across four review rounds
   * — a drafted-again request reported as closed, retention keyed on the wrong
   * flag, unbounded growth under truncation, and two variants of a rejected run
   * advancing past a change nothing handled. Every one of them was a
   * disagreement *between* passes rather than a mistake inside any single one.
   *
   * The rule is a single question asked per request: **was this request's
   * current state handled?** Advance only then; otherwise keep what was stored,
   * so the change is re-detected. `retainedFingerprint` is the sole authority,
   * and adding a new event or filter means extending that one function rather
   * than appending another pass here.
   */
  // Keyed exactly as `allKnownKeys` and `previous.requests` are, via the one
  // key function. A bare number here silently never matched a project-qualified
  // key, so under a wide scope every deferred request was treated as handled and
  // advanced past a change no Run ever processed.
  const deferredNumbers = new Set(deferred.map((d) => requestKey(d.request)))
  const nextRequests: Record<string, GitTriggerRequestState> = {}
  const unprovable: [string, GitTriggerRequestState][] = []

  for (const key of allKnownKeys(observed, previous)) {
    const decision = retainedFingerprint({
      key,
      observed: observedByNumber.get(key),
      prior: previous.requests[key],
      deferred: deferredNumbers.has(key),
      stillOpen: stillOpen.has(key),
      listingComplete,
    })
    if (decision.keep) nextRequests[key] = decision.keep
    else if (decision.unprovable) unprovable.push([key, decision.unprovable])
  }

  /**
   * Entries that could not be proven closed, admitted only while the state stays
   * under the cap. Reached only on a repository that permanently exceeds one
   * page, where closure is never provable and an unconditional keep would grow
   * the blob forever while rewriting it every tick. Least-recently-updated are
   * dropped first: a request that has not moved is the one most likely already
   * closed, and the worst case is one duplicate `opened` if it resurfaces.
   */
  if (unprovable.length > 0) {
    const budget = Math.max(0, MAX_RETAINED_REQUESTS - Object.keys(nextRequests).length)
    const keep = unprovable
      .sort((a, b) => (b[1].updatedAt ?? '').localeCompare(a[1].updatedAt ?? ''))
      .slice(0, budget)
    for (const [key, prior] of keep) {
      nextRequests[key] = prior
    }
  }

  return {
    fired,
    deferred,
    nextState: { requests: nextRequests, polledAt },
    seeded: false,
  }
}

/**
 * Un-advances the fingerprints of events that were never acted on.
 *
 * The caller cannot know at diff time which dispatches will be refused, so this
 * is the one sanctioned way to fold that outcome back in. It is deliberately the
 * same rule `retainedFingerprint` applies to a deferred request — nothing
 * handled the change, so the stored state must not move past it — expressed once
 * here rather than re-implemented at the call site, which is how the two copies
 * previously drifted.
 */
export function rollbackUnhandled(
  next: GitTriggerRepoState,
  previous: GitTriggerRepoState | null | undefined,
  unhandled: readonly GitTriggerFiredEvent[],
): GitTriggerRepoState {
  if (unhandled.length === 0) return next
  const requests = { ...next.requests }
  for (const item of unhandled) {
    const key = requestKey(item.request)
    const prior = previous?.requests?.[key]
    if (prior) requests[key] = prior
    else delete requests[key]
  }
  return { ...next, requests }
}

/** Substitutes `{{...}}` placeholders in the user's intent template. */
export function renderGitTriggerIntent(
  template: string,
  vars: {
    event: string
    repo: string
    host?: string
    number: number
    title: string
    url?: string
    author?: string
    sourceBranch?: string
    targetBranch?: string
    sha?: string
  },
): string {
  const map: Record<string, string> = {
    '{{event}}': vars.event,
    '{{repo}}': vars.repo,
    '{{host}}': vars.host ?? '',
    '{{number}}': String(vars.number),
    '{{title}}': vars.title,
    '{{url}}': vars.url ?? '',
    '{{author}}': vars.author ?? '',
    '{{source_branch}}': vars.sourceBranch ?? '',
    '{{target_branch}}': vars.targetBranch ?? '',
    '{{sha}}': vars.sha ?? '',
  }
  return template.replace(
    /\{\{(?:event|repo|host|number|title|url|author|source_branch|target_branch|sha)\}\}/g,
    (match) => map[match] ?? match,
  )
}

/**
 * Stable key for one watch entry within a channel's persisted state.
 *
 * The `project` scope is deliberately unprefixed. Every state row written before
 * scopes existed used the bare path, and prefixing it now would make the first
 * poll after an upgrade find nothing, treat a live repository as a cold start,
 * and silently swallow every change that happened in between. The wider scopes
 * are new, so they can afford an explicit prefix — which they need, because a
 * namespace and a repository can be spelled identically and sharing one row
 * would merge two unrelated request sets into a single fingerprint.
 */
export function repoStateKey(repo: {
  project: string
  host?: string
  scope?: GitTriggerScope
}): string {
  const scope = repo.scope ?? 'project'
  const path = scope === 'group' ? `group:${repo.project}` : repo.project
  return repo.host ? `${repo.host}/${path}` : path
}
