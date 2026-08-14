/**
 * Property tests for the one rule the whole channel rests on.
 *
 * Five separate defects across four review rounds were all the same mistake:
 * the stored fingerprint advanced past a change that nothing had acted on, or
 * failed to advance past one that had. Each was found and fixed individually,
 * by example, which is why the next variant kept getting through — an
 * example-based test only pins the case someone already thought of.
 *
 * These assert the invariant itself over randomised inputs, so a future change
 * that breaks it fails here whatever shape the breakage takes:
 *
 *   1. NO LOSS      — a change the config SUBSCRIBED to that fired no event
 *                     keeps its old fingerprint, so the next tick re-detects it.
 *                     Subscription must be modelled: an earlier version excused
 *                     every non-firing case as "unsubscribed, may advance" and
 *                     asserted only on explicit deferral, which let the whole
 *                     bug class through — the round-1 defect could be pasted
 *                     back in and all five properties stayed green.
 *   2. NO REPLAY    — a change that did fire advances, so it never fires twice.
 *   3. NO GROWTH    — state never exceeds the retention bound.
 *   4. NO INVENTION — every persisted key was either observed or already known.
 */
import type { GitTriggerEvent, GitTriggerRepoState } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import {
  diffRepoState,
  MAX_RETAINED_REQUESTS,
  type ObservedRequest,
  rollbackUnhandled,
} from '../git-trigger-diff.js'

const ALL_EVENTS: GitTriggerEvent[] = ['opened', 'updated', 'commented', 'closed']
const POLLED_AT = '2026-08-06T00:00:00.000Z'

/** Deterministic PRNG so a failure is reproducible from its seed. */
function rng(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function makeRequest(number: number, sha: string, comments: number): ObservedRequest {
  return { number, sha, comments, title: `MR ${number}`, isDraft: false }
}

/** One randomised tick: a previous state, a listing, and a subscription. */
function scenario(seed: number) {
  const random = rng(seed)
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]

  const population = 1 + Math.floor(random() * 8)
  const previous: GitTriggerRepoState = { requests: {}, polledAt: POLLED_AT }
  for (let n = 1; n <= population; n++) {
    if (random() < 0.7) {
      previous.requests[String(n)] = {
        number: n,
        sha: `s${n}`,
        comments: n % 3,
        // A request hidden behind a filter last tick. Absent from the original
        // generator, so the branch handling its return was never exercised.
        ...(random() < 0.3 ? { filtered: true } : {}),
      }
    }
  }

  const observed: ObservedRequest[] = []
  for (let n = 1; n <= population; n++) {
    if (random() < 0.25) continue // absent: merged, or filtered, or paged out
    const prior = previous.requests[String(n)]
    const moved = random() < 0.4
    observed.push(
      makeRequest(
        n,
        moved ? `s${n}-new` : (prior?.sha ?? `s${n}`),
        (prior?.comments ?? 0) + (random() < 0.3 ? 1 : 0),
      ),
    )
  }

  /**
   * Requests the forge still lists but the config filtered out.
   *
   * Without this the generator never passes `observedUnfiltered`, so `stillOpen`
   * collapses onto `observed` and the branch that *writes* the `filtered` flag is
   * unreachable — only the read side (a `filtered` fingerprint planted directly
   * into `previous`) was ever exercised. Removing that write survived the whole
   * property suite. The flag's semantics are a round trip, so both halves must
   * be generated.
   */
  const observedNumbers = new Set(observed.map((r) => r.number))
  const observedUnfiltered = [...observed]
  for (let n = 1; n <= population; n++) {
    if (observedNumbers.has(n)) continue
    if (random() < 0.5) {
      observedUnfiltered.push(makeRequest(n, previous.requests[String(n)]?.sha ?? `s${n}`, 0))
    }
  }

  const events = ALL_EVENTS.filter(() => random() < 0.6)
  return {
    previous,
    observed,
    observedUnfiltered,
    events: events.length > 0 ? events : [pick(ALL_EVENTS)],
    listingComplete: random() < 0.7,
    cap: 1 + Math.floor(random() * 5),
  }
}

/**
 * Events a tracked request's movement entitles it to, mirroring the rules in
 * `diffRepoState`. Covers the transitions visible from an observed request;
 * `closed` is deliberately absent because it is defined by ABSENCE from the
 * listing and so cannot be derived here — the dedicated property below covers
 * it instead.
 */
function entitledEvents(
  prior: { sha: string; comments: number; filtered?: boolean },
  request: ObservedRequest,
): GitTriggerEvent[] {
  const events: GitTriggerEvent[] = []
  if (prior.filtered) events.push('opened')
  if (prior.sha !== request.sha) events.push('updated')
  if (request.comments > prior.comments) events.push('commented')
  return events
}

/**
 * Fails if a new event type is added without extending the coverage above.
 *
 * `entitledEvents` handles three of the four; `closed` is covered separately
 * because it is inferred from absence. A fifth event would slip through both
 * and silently narrow every property in this file.
 */
function assertEventsCovered(): void {
  const derivable: GitTriggerEvent[] = ['opened', 'updated', 'commented']
  const absenceBased: GitTriggerEvent[] = ['closed']
  expect([...derivable, ...absenceBased].sort()).toEqual([...ALL_EVENTS].sort())
}

describe('fingerprint invariants (randomised)', () => {
  it('covers every event type the schema defines', () => {
    // A new event added to the enum without extending this file would leave the
    // invariants quietly asserting on a subset — the failure mode that let the
    // whole class through once already.
    assertEventsCovered()
  })

  it('preserves the fingerprint of a deferred closed event', () => {
    // `closed` is the one event property 1 cannot see: it iterates `observed`,
    // and a closed request is by definition absent from it. Deferring one must
    // keep its fingerprint, since that is the only surviving record of the
    // request — dropping it loses the event with nothing able to re-detect it.
    const previous: GitTriggerRepoState = {
      requests: Object.fromEntries(
        [1, 2, 3, 4, 5, 6].map((n) => [String(n), { number: n, sha: `s${n}`, comments: 0 }]),
      ),
      polledAt: POLLED_AT,
    }
    // Every tracked request vanished; the cap admits fewer than all of them.
    const result = diffRepoState({
      previous,
      observed: [],
      observedUnfiltered: [],
      events: ALL_EVENTS,
      listingComplete: true,
      polledAt: POLLED_AT,
      maxRunsPerTick: 2,
    })

    expect(result.deferred.length).toBeGreaterThan(0)
    for (const item of result.deferred) {
      const key = String(item.request.number)
      expect(result.nextState.requests[key], `deferred closed ${key} lost its fingerprint`).toEqual(
        previous.requests[key],
      )
    }
  })

  it('never advances past a SUBSCRIBED change that fired no event', () => {
    // The invariant this file exists to protect, stated as the module header
    // states it: a fingerprint advances only if the tick handled that request's
    // current state.
    //
    // An earlier version of this test excused every non-firing case as
    // "unsubscribed, so it may advance" and only asserted when the event was
    // explicitly deferred. That escape hatch covered the entire bug class it was
    // meant to catch: with it in place, reintroducing the round-1 `continue`
    // defect left all five properties green. Subscription is therefore modelled
    // here — a change the config *asked for* must either fire or be preserved,
    // and only genuinely unsubscribed changes may advance.
    for (let seed = 1; seed <= 400; seed++) {
      const { previous, observed, observedUnfiltered, events, listingComplete, cap } =
        scenario(seed)
      const wanted = new Set(events)
      const result = diffRepoState({
        previous,
        observed,
        observedUnfiltered,
        events,
        listingComplete,
        polledAt: POLLED_AT,
        maxRunsPerTick: cap,
      })

      const firedNumbers = new Set(result.fired.map((f) => String(f.request.number)))
      for (const request of observed) {
        const key = String(request.number)
        const prior = previous.requests[key]
        if (!prior) continue
        if (firedNumbers.has(key)) continue

        // Which events does this request's movement entitle it to, given the
        // config? If any of them was subscribed, the tick owed it an event.
        //
        // NOTE: this is a second copy of a production rule, which is the shape
        // that caused the provider-guard defects — every write path had to
        // remember it. Here the risk is inverted and quieter: forgetting to
        // extend this list does not break anything, it silently stops asserting
        // on the event. `assertEventsCovered` below guards against exactly that.
        // Adding an event type means extending both.
        const entitled = entitledEvents(prior, request)
        const owed = entitled.some((event) => wanted.has(event))
        if (!owed) continue

        // Nothing fired for a change the config subscribed to, so the
        // fingerprint must not move — otherwise the change is lost outright,
        // with no later tick able to re-detect it.
        expect(
          result.nextState.requests[key],
          `seed ${seed}, request ${key}: subscribed change advanced without firing`,
        ).toEqual(prior)
      }
    }
  })

  it('always advances a request whose event fired, so it cannot fire twice', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { previous, observed, observedUnfiltered, events, listingComplete, cap } =
        scenario(seed)
      const result = diffRepoState({
        previous,
        observed,
        observedUnfiltered,
        events,
        listingComplete,
        polledAt: POLLED_AT,
        maxRunsPerTick: cap,
      })

      for (const fired of result.fired) {
        const key = String(fired.request.number)
        const stored = result.nextState.requests[key]
        const prior = previous.requests[key]
        if (fired.event === 'closed') {
          // A fired close retires the entry entirely.
          expect(stored, `seed ${seed}, closed ${key}`).toBeUndefined()
          continue
        }
        expect(stored, `seed ${seed}, fired ${key}`).toBeDefined()
        if (prior) {
          expect(stored).not.toEqual(prior)
        }
      }
    }
  })

  it('marks a still-open request that the filters hid, so its return is detectable', () => {
    // The write half of the `filtered` round trip. Property 1 covers the read
    // half (a planted `filtered` fingerprint must fire on return), but removing
    // the line that *writes* the flag survived the whole suite: the generator
    // never produced a request that was open-but-filtered, so the branch was
    // unreachable. Both halves are needed, because the flag's whole purpose is
    // that "draft → ready for review" moves no other tracked field.
    for (let seed = 1; seed <= 400; seed++) {
      const { previous, observed, observedUnfiltered, events, listingComplete, cap } =
        scenario(seed)
      const result = diffRepoState({
        previous,
        observed,
        observedUnfiltered,
        events,
        listingComplete,
        polledAt: POLLED_AT,
        maxRunsPerTick: cap,
      })

      const visible = new Set(observed.map((r) => String(r.number)))
      for (const request of observedUnfiltered) {
        const key = String(request.number)
        if (visible.has(key)) continue // not hidden by a filter
        if (!previous.requests[key]) continue // never tracked, nothing to mark
        const stored = result.nextState.requests[key]
        if (!stored) continue // dropped for a reason property 4 covers

        expect(
          stored.filtered,
          `seed ${seed}, request ${key}: hidden by a filter but not marked, so its return fires nothing`,
        ).toBe(true)
      }
    }
  })

  it('never exceeds the retention bound', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { previous, observed, observedUnfiltered, events, listingComplete, cap } =
        scenario(seed)
      const result = diffRepoState({
        previous,
        observed,
        observedUnfiltered,
        events,
        listingComplete,
        polledAt: POLLED_AT,
        maxRunsPerTick: cap,
      })
      expect(Object.keys(result.nextState.requests).length).toBeLessThanOrEqual(
        MAX_RETAINED_REQUESTS,
      )
    }
  })

  it('never invents a request it did not observe or already know', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { previous, observed, observedUnfiltered, events, listingComplete, cap } =
        scenario(seed)
      const result = diffRepoState({
        previous,
        observed,
        observedUnfiltered,
        events,
        listingComplete,
        polledAt: POLLED_AT,
        maxRunsPerTick: cap,
      })

      const known = new Set([
        ...Object.keys(previous.requests),
        ...observed.map((r) => String(r.number)),
      ])
      for (const key of Object.keys(result.nextState.requests)) {
        expect(known.has(key), `seed ${seed} invented ${key}`).toBe(true)
      }
    }
  })

  it('re-detects any change whose dispatch was refused', () => {
    // The manager cannot know at diff time which runs the queue will refuse, so
    // `rollbackUnhandled` folds that in afterwards. Refusing every dispatch must
    // leave the state exactly as it was, or the change is lost with no retry.
    for (let seed = 1; seed <= 200; seed++) {
      const { previous, observed, observedUnfiltered, events, listingComplete, cap } =
        scenario(seed)
      const result = diffRepoState({
        previous,
        observed,
        observedUnfiltered,
        events,
        listingComplete,
        polledAt: POLLED_AT,
        maxRunsPerTick: cap,
      })

      const rolledBack = rollbackUnhandled(result.nextState, previous, result.fired)
      for (const fired of result.fired) {
        const key = String(fired.request.number)
        const prior = previous.requests[key]
        if (prior) {
          expect(rolledBack.requests[key], `seed ${seed}, refused ${key}`).toEqual(prior)
        } else {
          expect(rolledBack.requests[key], `seed ${seed}, refused new ${key}`).toBeUndefined()
        }
      }
    }
  })
})
