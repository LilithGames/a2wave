import type { GitTriggerEvent, GitTriggerRepoState } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import {
  diffRepoState,
  MAX_RETAINED_REQUESTS,
  matchesFilters,
  type ObservedRequest,
  renderGitTriggerIntent,
  repoStateKey,
} from '../git-trigger-diff.js'

const ALL_EVENTS: GitTriggerEvent[] = ['opened', 'updated', 'commented', 'closed']
const POLLED_AT = '2026-08-05T00:00:00.000Z'

function makeRequest(overrides: Partial<ObservedRequest> & { number: number }): ObservedRequest {
  return {
    sha: 'aaa111',
    comments: 0,
    title: `MR ${overrides.number}`,
    isDraft: false,
    ...overrides,
  }
}

function stateOf(requests: ObservedRequest[]): GitTriggerRepoState {
  return {
    requests: Object.fromEntries(
      requests.map((r) => [
        String(r.number),
        { number: r.number, sha: r.sha, comments: r.comments },
      ]),
    ),
    polledAt: POLLED_AT,
  }
}

describe('diffRepoState — cold start', () => {
  it('seeds a baseline without firing, so enabling the channel never stampedes', () => {
    const observed = [makeRequest({ number: 1 }), makeRequest({ number: 2 })]

    const result = diffRepoState({
      previous: null,
      observed,
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.seeded).toBe(true)
    expect(result.fired).toEqual([])
    expect(Object.keys(result.nextState.requests)).toEqual(['1', '2'])
  })

  it('fires on the poll after the baseline', () => {
    const baseline = diffRepoState({
      previous: null,
      observed: [makeRequest({ number: 1 })],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    const result = diffRepoState({
      previous: baseline.nextState,
      observed: [makeRequest({ number: 1 }), makeRequest({ number: 2 })],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toHaveLength(1)
    expect(result.fired[0]).toMatchObject({ event: 'opened', request: { number: 2 } })
  })
})

describe('diffRepoState — event detection', () => {
  it('detects a new merge request as opened', () => {
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1 })]),
      observed: [makeRequest({ number: 1 }), makeRequest({ number: 7 })],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([
      expect.objectContaining({ event: 'opened', request: expect.objectContaining({ number: 7 }) }),
    ])
  })

  it('detects a moved head SHA as updated', () => {
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1, sha: 'old' })]),
      observed: [makeRequest({ number: 1, sha: 'new' })],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([expect.objectContaining({ event: 'updated' })])
  })

  it('detects a rising comment count as commented', () => {
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1, comments: 2 })]),
      observed: [makeRequest({ number: 1, comments: 3 })],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([expect.objectContaining({ event: 'commented' })])
  })

  it('does not fire when a comment is deleted', () => {
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1, comments: 5 })]),
      observed: [makeRequest({ number: 1, comments: 4 })],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([])
    // The lowered count is still persisted, so a later re-comment fires once.
    expect(result.nextState.requests['1'].comments).toBe(4)
  })

  it('reports a disappeared request as closed', () => {
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1 }), makeRequest({ number: 2 })]),
      observed: [makeRequest({ number: 1 })],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([
      expect.objectContaining({ event: 'closed', request: expect.objectContaining({ number: 2 }) }),
    ])
    expect(result.nextState.requests['2']).toBeUndefined()
  })

  it('does not report a filtered-out but still-open request as closed', () => {
    // Regression: filters run before the diff, so a request converted back to
    // draft (with ignoreDrafts on) disappears from `observed`. Reading that
    // absence as "closed" would wake the Agent to act on a merge that never
    // happened. Absence only counts when the forge itself stopped listing it.
    const draftedAgain = makeRequest({ number: 1, isDraft: true })

    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1 })]),
      observed: [], // filtered out by ignoreDrafts
      observedUnfiltered: [draftedAgain], // still open upstream
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([])
  })

  it('fires opened when a filtered-out request becomes eligible again', () => {
    // "Draft → ready for review" is the signal this channel most exists to
    // catch, and it moves neither the head SHA nor the comment count. The
    // fingerprint is retained across the filtered period (so the request is not
    // treated as brand new) but flagged, making the return detectable.
    //
    // This test previously asserted the opposite — that nothing fires — which
    // pinned the defect in place.
    const first = diffRepoState({
      previous: stateOf([makeRequest({ number: 1 })]),
      observed: [],
      observedUnfiltered: [makeRequest({ number: 1, isDraft: true })],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(first.nextState.requests['1']).toBeDefined()
    expect(first.nextState.requests['1'].filtered).toBe(true)
    // Nothing fires while it is hidden.
    expect(first.fired).toEqual([])

    const second = diffRepoState({
      previous: first.nextState,
      observed: [makeRequest({ number: 1 })], // ready for review again
      observedUnfiltered: [makeRequest({ number: 1 })],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(second.fired).toEqual([expect.objectContaining({ event: 'opened' })])
    // The flag clears, so it does not fire again on the following tick.
    expect(second.nextState.requests['1'].filtered).toBeUndefined()
  })

  it('still reports a genuinely closed request when filters are in play', () => {
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1 }), makeRequest({ number: 2 })]),
      observed: [makeRequest({ number: 1 })],
      observedUnfiltered: [makeRequest({ number: 1 })], // #2 gone from the forge
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([
      expect.objectContaining({ event: 'closed', request: expect.objectContaining({ number: 2 }) }),
    ])
  })

  it('prefers updated over commented when both moved in one interval', () => {
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1, sha: 'old', comments: 1 })]),
      observed: [makeRequest({ number: 1, sha: 'new', comments: 9 })],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toHaveLength(1)
    expect(result.fired[0].event).toBe('updated')
    // The comment count still advances, so the merged change is not re-reported.
    expect(result.nextState.requests['1'].comments).toBe(9)
  })

  it('still reports a comment when only `commented` is subscribed and a push landed too', () => {
    // Regression: the updated/commented dedup ran BEFORE the subscription check,
    // so a config watching only `commented` fired nothing while the fingerprint
    // advanced past the new comment count — losing the comment permanently
    // rather than deferring it.
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1, sha: 'old', comments: 5 })]),
      observed: [makeRequest({ number: 1, sha: 'new', comments: 7 })],
      events: ['commented'],
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([expect.objectContaining({ event: 'commented' })])
  })

  it('does not infer closed from a possibly-truncated listing', () => {
    // Both forges cap a page at 100 and sort by activity, so the least recently
    // touched open request silently falls off page one. Reading that absence as
    // closure fires a bogus `closed`, then `opened` when it reappears — a
    // permanent flap against a completely healthy forge.
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1 }), makeRequest({ number: 2 })]),
      observed: [makeRequest({ number: 1 })],
      listingComplete: false,
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([])
    // The paged-out request keeps its fingerprint, so it does not re-fire as
    // `opened` when it returns to the first page.
    expect(result.nextState.requests['2']).toBeDefined()
  })

  it('drops a merged request from state even when `closed` is not subscribed', () => {
    // Regression: retention was gated on `canInferClosed` (= subscribed AND
    // complete) rather than on completeness alone. A config watching only
    // `opened` — one of the most common setups — therefore kept every request it
    // had ever seen, so the state blob grew without bound while being rewritten
    // every tick. Whether an event may fire and whether a fingerprint may be
    // dropped are different questions.
    const result = diffRepoState({
      previous: stateOf([1, 2, 3, 4, 5].map((number) => makeRequest({ number }))),
      observed: [makeRequest({ number: 5 })],
      listingComplete: true,
      events: ['opened'],
      polledAt: POLLED_AT,
    })

    expect(Object.keys(result.nextState.requests)).toEqual(['5'])
    // Still no event: the subscription governs firing, only the state shrinks.
    expect(result.fired).toEqual([])
  })

  it('keeps absent requests when the listing is truncated, regardless of subscription', () => {
    // The other half of the same split: incompleteness is what forbids dropping,
    // because a paged-out request has not been shown to be gone.
    const result = diffRepoState({
      previous: stateOf([1, 2, 3].map((number) => makeRequest({ number }))),
      observed: [makeRequest({ number: 3 })],
      listingComplete: false,
      events: ['opened'],
      polledAt: POLLED_AT,
    })

    expect(Object.keys(result.nextState.requests).sort()).toEqual(['1', '2', '3'])
  })

  it('bounds retention when the listing is permanently truncated', () => {
    // A repository that always exceeds one page can never prove closure, so an
    // unconditional keep would accumulate every merged request forever while
    // rewriting the whole blob to SQLite each tick. Retention is capped, oldest
    // (least recently updated) dropped first.
    const previous: GitTriggerRepoState = {
      requests: Object.fromEntries(
        Array.from({ length: MAX_RETAINED_REQUESTS + 50 }, (_, i) => [
          String(i + 1),
          {
            number: i + 1,
            sha: 'a',
            comments: 0,
            updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
          },
        ]),
      ),
      polledAt: POLLED_AT,
    }

    const result = diffRepoState({
      previous,
      observed: [makeRequest({ number: 1 })],
      listingComplete: false,
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(Object.keys(result.nextState.requests).length).toBeLessThanOrEqual(MAX_RETAINED_REQUESTS)
    // The observed request always survives, regardless of the cap.
    expect(result.nextState.requests['1']).toBeDefined()
  })

  it('still reports closed when the listing is known to be complete', () => {
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1 }), makeRequest({ number: 2 })]),
      observed: [makeRequest({ number: 1 })],
      listingComplete: true,
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([
      expect.objectContaining({ event: 'closed', request: expect.objectContaining({ number: 2 }) }),
    ])
  })

  it('fires closed ahead of other events when the cap bites', () => {
    // Regression: `closed` candidates are appended last, so on a repository that
    // reliably produces `cap` other candidates per tick they were re-deferred
    // forever and an Agent configured for merges never ran. `closed` is also the
    // only event that cannot be re-derived — the request is gone from the forge.
    const previous = stateOf([1, 2, 3, 4, 5, 6].map((number) => makeRequest({ number })))
    const result = diffRepoState({
      previous,
      // 1-5 pushed to, 6 merged (absent from the listing).
      observed: [1, 2, 3, 4, 5].map((number) => makeRequest({ number, sha: 'new' })),
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
      maxRunsPerTick: 5,
    })

    expect(result.fired[0]).toMatchObject({ event: 'closed', request: { number: 6 } })
    expect(result.fired).toHaveLength(5)
  })

  it('carries title and url into a closed event', () => {
    // The fingerprint is the only surviving record once the forge stops listing
    // the request, so without these the rendered intent lost {{title}}/{{url}}
    // and the Agent could not identify what had merged.
    const seeded = diffRepoState({
      previous: null,
      observed: [
        makeRequest({ number: 50, title: 'fix: thing', url: 'https://example.com/mr/50' }),
      ],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    const result = diffRepoState({
      previous: seeded.nextState,
      observed: [],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired[0].request).toMatchObject({
      number: 50,
      title: 'fix: thing',
      url: 'https://example.com/mr/50',
    })
  })

  it('ignores events the config did not subscribe to', () => {
    const result = diffRepoState({
      previous: stateOf([makeRequest({ number: 1, comments: 0 })]),
      observed: [makeRequest({ number: 1, comments: 4 }), makeRequest({ number: 2 })],
      events: ['opened'],
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([expect.objectContaining({ event: 'opened' })])
  })

  it('stays quiet when nothing moved', () => {
    const observed = [makeRequest({ number: 1 })]
    const result = diffRepoState({
      previous: stateOf(observed),
      observed,
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toEqual([])
  })
})

describe('diffRepoState — per-tick cap', () => {
  it('caps fired events and defers the rest', () => {
    const observed = Array.from({ length: 5 }, (_, i) => makeRequest({ number: i + 1 }))

    const result = diffRepoState({
      previous: { requests: {}, polledAt: POLLED_AT },
      observed,
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
      maxRunsPerTick: 2,
    })

    expect(result.fired).toHaveLength(2)
    expect(result.deferred).toHaveLength(3)
  })

  it('re-fires deferred events on the next tick instead of losing them', () => {
    const observed = Array.from({ length: 4 }, (_, i) => makeRequest({ number: i + 1 }))

    const first = diffRepoState({
      previous: { requests: {}, polledAt: POLLED_AT },
      observed,
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
      maxRunsPerTick: 2,
    })

    const second = diffRepoState({
      previous: first.nextState,
      observed,
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
      maxRunsPerTick: 2,
    })

    expect(second.fired).toHaveLength(2)
    const firedNumbers = [...first.fired, ...second.fired].map((f) => f.request.number).sort()
    expect(firedNumbers).toEqual([1, 2, 3, 4])
  })

  it('does not re-fire an event that already fired', () => {
    const observed = [makeRequest({ number: 1 }), makeRequest({ number: 2 })]

    const first = diffRepoState({
      previous: { requests: {}, polledAt: POLLED_AT },
      observed,
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
      maxRunsPerTick: 1,
    })
    const second = diffRepoState({
      previous: first.nextState,
      observed,
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
      maxRunsPerTick: 5,
    })

    expect(second.fired).toHaveLength(1)
    expect(second.fired[0].request.number).not.toBe(first.fired[0].request.number)
  })
})

describe('matchesFilters', () => {
  it('drops drafts when ignoreDrafts is on', () => {
    const draft = makeRequest({ number: 1, isDraft: true })
    expect(matchesFilters(draft, { targetBranches: [], ignoreDrafts: true })).toBe(false)
    expect(matchesFilters(draft, { targetBranches: [], ignoreDrafts: false })).toBe(true)
  })

  it('keeps only the configured target branches', () => {
    const request = makeRequest({ number: 1, targetBranch: 'main' })
    expect(matchesFilters(request, { targetBranches: ['main'], ignoreDrafts: true })).toBe(true)
    expect(matchesFilters(request, { targetBranches: ['dev'], ignoreDrafts: true })).toBe(false)
    expect(matchesFilters(request, { targetBranches: [], ignoreDrafts: true })).toBe(true)
  })
})

describe('renderGitTriggerIntent', () => {
  it('substitutes every supported placeholder', () => {
    const rendered = renderGitTriggerIntent(
      'review {{repo}} {{event}} !{{number}} {{title}} {{url}} by {{author}} {{source_branch}}->{{target_branch}} @{{sha}} on {{host}}',
      {
        event: 'commented',
        repo: 'acme/demo',
        host: 'gitlab.example.com',
        number: 50,
        title: 'fix: thing',
        url: 'https://example.com/mr/50',
        author: 'octocat',
        sourceBranch: 'feat',
        targetBranch: 'dev',
        sha: 'abc123',
      },
    )

    expect(rendered).toBe(
      'review acme/demo commented !50 fix: thing https://example.com/mr/50 by octocat feat->dev @abc123 on gitlab.example.com',
    )
  })

  it('renders missing optional values as empty rather than leaving the placeholder', () => {
    const rendered = renderGitTriggerIntent('{{title}}|{{url}}|{{author}}', {
      event: 'opened',
      repo: 'a/b',
      number: 1,
      title: 'T',
    })

    expect(rendered).toBe('T||')
  })

  it('leaves unknown placeholders untouched', () => {
    const rendered = renderGitTriggerIntent('{{nope}} {{repo}}', {
      event: 'opened',
      repo: 'a/b',
      number: 1,
      title: 'T',
    })

    expect(rendered).toBe('{{nope}} a/b')
  })
})

describe('repoStateKey', () => {
  it('namespaces by host so the same path on two forges stays distinct', () => {
    expect(repoStateKey({ project: 'a/b' })).toBe('a/b')
    expect(repoStateKey({ project: 'a/b', host: 'gitlab.example.com' })).toBe(
      'gitlab.example.com/a/b',
    )
    expect(repoStateKey({ project: 'a/b', host: 'h1' })).not.toBe(repoStateKey({ project: 'a/b' }))
  })

  it('keeps the project-scope key unchanged so stored state still matches', () => {
    // Every row written before scopes existed was keyed without one. If the
    // default scope changed the key, the next poll would find no state, treat a
    // live repository as a cold start, and silently swallow everything that
    // happened in between.
    expect(repoStateKey({ project: 'a/b', scope: 'project' })).toBe('a/b')
  })

  it('separates a group from a project sharing its path', () => {
    // `group:` is not decoration: a namespace and a repository can be written
    // identically, and one state row shared between them would mix two
    // completely different request sets into one fingerprint.
    expect(repoStateKey({ project: 'acme', scope: 'group' })).not.toBe(
      repoStateKey({ project: 'acme', scope: 'project' }),
    )
  })
})

describe('cross-repository identity under a wide scope', () => {
  it('does not confuse the same request number in two repositories', () => {
    // A merge request number is unique only within its repository. Keying on the
    // number alone made `repo-a!42` and `repo-b!42` one entry, so the second
    // listed overwrote the first's fingerprint: one repository's push read as
    // the other's, firing a bogus `updated` while a real change went unseen.
    const previous: GitTriggerRepoState = {
      requests: {
        'group/repo-a!42': { number: 42, sha: 'aaa', comments: 0, project: 'group/repo-a' },
        'group/repo-b!42': { number: 42, sha: 'bbb', comments: 0, project: 'group/repo-b' },
      },
    }
    const result = diffRepoState({
      previous,
      observed: [
        makeRequest({ number: 42, sha: 'aaa', project: 'group/repo-a' }),
        // Only repo-b moved.
        makeRequest({ number: 42, sha: 'ccc', project: 'group/repo-b' }),
      ],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toHaveLength(1)
    expect(result.fired[0].event).toBe('updated')
    expect(result.fired[0].request.project).toBe('group/repo-b')
    // The untouched repository keeps its own fingerprint rather than inheriting
    // the other's SHA.
    expect(result.nextState.requests['group/repo-a!42'].sha).toBe('aaa')
    expect(result.nextState.requests['group/repo-b!42'].sha).toBe('ccc')
  })

  it('does not advance a deferred request whose key is project-qualified', () => {
    // The per-tick cap defers work, and a deferred request's fingerprint must
    // NOT advance — nothing acted on the change, so the next tick has to
    // re-detect it. The deferral set was built from bare numbers while being
    // looked up with project-qualified keys, so under a wide scope no deferred
    // request ever matched: its fingerprint advanced past a change no Run
    // handled and the event was lost for good, not merely delayed. That is the
    // exact violation this module's header calls out as its one rule.
    const previous: GitTriggerRepoState = {
      requests: {
        'group/repo-a!1': { number: 1, sha: 'old1', comments: 0, project: 'group/repo-a' },
        'group/repo-b!2': { number: 2, sha: 'old2', comments: 0, project: 'group/repo-b' },
      },
    }
    const result = diffRepoState({
      previous,
      observed: [
        makeRequest({ number: 1, sha: 'new1', project: 'group/repo-a' }),
        makeRequest({ number: 2, sha: 'new2', project: 'group/repo-b' }),
      ],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
      maxRunsPerTick: 1,
    })

    expect(result.fired).toHaveLength(1)
    expect(result.deferred).toHaveLength(1)
    const deferredKey = `${result.deferred[0].request.project}!${result.deferred[0].request.number}`
    // The deferred entry keeps its OLD fingerprint so the next tick sees the
    // delta again.
    expect(result.nextState.requests[deferredKey].sha).toBe(previous.requests[deferredKey].sha)
  })

  it('reports a closed request against the repository it lived in', () => {
    // Closure is inferred from absence, so the fingerprint is the only surviving
    // record of which repository the request belonged to.
    const result = diffRepoState({
      previous: {
        requests: {
          'group/repo-a!7': {
            number: 7,
            sha: 'a',
            comments: 0,
            project: 'group/repo-a',
            title: 'ship it',
          },
        },
      },
      observed: [],
      events: ALL_EVENTS,
      polledAt: POLLED_AT,
    })

    expect(result.fired).toHaveLength(1)
    expect(result.fired[0].event).toBe('closed')
    expect(result.fired[0].request.project).toBe('group/repo-a')
  })
})
