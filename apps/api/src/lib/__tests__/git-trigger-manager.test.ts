/**
 * Poll loop behaviour: seeding, the shared run budget, dispatch/persist order,
 * mid-tick cancellation and per-repository failure isolation.
 *
 * This module previously had no tests at all, which is precisely why several of
 * its defects survived to review: every one of them is invisible to the pure
 * `diffRepoState` tests, because they live in how the loop *calls* that function
 * and what it does with the result.
 *
 * The DB is faked with a tiny in-memory store rather than the Drizzle mock
 * chain: this file cares about the sequence of reads and writes (was state
 * persisted before or after dispatch? did a failure leave a row behind?), which
 * a call-order-agnostic mock cannot express.
 */
import type { GitTriggerRepoState } from '@a2wave/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

interface StateRow {
  agentId: string
  channel: string
  repoKey: string
  state: GitTriggerRepoState
  lastError: string | null
}

const stateRows = new Map<string, StateRow>()
const runRows: Record<string, unknown>[] = []
/** Ordered log of side effects, so dispatch-vs-persist ordering is assertable. */
const effects: string[] = []

let agentRow: Record<string, unknown> | null = null
const rowKey = (r: { agentId: string; channel: string; repoKey: string }) =>
  `${r.agentId}|${r.channel}|${r.repoKey}`

/**
 * `eq()` calls are recorded so a `where()` — whose arguments are otherwise
 * opaque mock objects — can be resolved back to the row it was looking for.
 */
let eqCalls: [string, unknown][] = []

vi.mock('../../db/client.js', () => {
  const db = {
    select: () => ({
      from: (table: { __name?: string }) => {
        // Each select starts a fresh predicate capture.
        eqCalls = []
        const resolve = () => {
          if (table.__name === 'agents') return agentRow
          const values = Object.fromEntries(eqCalls)
          if (table.__name === 'runs') {
            return runRows.find((candidate) => candidate.id === values.id)
          }
          const key = `${values.agentId}|${values.channel}|${values.repoKey}`
          return stateRows.get(key)
        }
        // asyncQuery: the dual-backend port made every read awaited, and
        // `readState` now ends in `.limit(1)` rather than `.get()`.
        const all = () =>
          table.__name === 'agents' ? (agentRow ? [agentRow] : []) : [...stateRows.values()]
        return asyncQuery({
          where: () =>
            asyncQuery({
              get: resolve,
              all: () => [...stateRows.values()],
              limit: () => asyncQuery({ get: resolve, all: () => [...stateRows.values()] }),
            }),
          get: resolve,
          all,
          limit: () => asyncQuery({ get: resolve, all }),
        })
      },
    }),
    insert: (table: { __name?: string }) => ({
      values: (values: Record<string, unknown>) =>
        asyncQuery({
          run: () => {
            if (table.__name === 'runs') {
              effects.push(`run:${values.id}`)
              runRows.push(values)
            }
          },
          onConflictDoUpdate: () =>
            asyncQuery({
              run: () => {
                const row = values as unknown as StateRow
                effects.push(`state:${row.repoKey}`)
                stateRows.set(rowKey(row), { ...row })
              },
            }),
        }),
    }),
    // Run rows are mutated in place so a post-insert update (the queued marker)
    // is observable; a no-op update would make that assertion vacuously read
    // back the inserted value.
    update: (table: { __name?: string }) => ({
      set: (values: Record<string, unknown>) => ({
        where: () =>
          asyncQuery({
            run: () => {
              if (table.__name !== 'runs') return
              const id = Object.fromEntries(eqCalls).id
              const row = runRows.find((candidate) => candidate.id === id)
              if (row) Object.assign(row, values)
            },
          }),
      }),
    }),
    delete: () => ({ where: () => asyncQuery({ run: () => {} }) }),
  }
  return { db }
})

vi.mock('../../db/schema.js', () => ({
  agents: { __name: 'agents', id: 'id', publishStatus: 'publishStatus' },
  gitTriggerStates: {
    __name: 'git_trigger_states',
    agentId: 'agentId',
    channel: 'channel',
    repoKey: 'repoKey',
  },
  runs: { __name: 'runs', id: 'id', executionMetadata: 'executionMetadata' },
}))

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  // The column mock is the literal string set in the schema mock below, so the
  // captured pairs reconstruct the intended lookup key.
  eq: (column: string, value: unknown) => {
    eqCalls.push([column, value])
    return { column, value }
  },
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../audit.js', () => ({ logBackgroundAudit: vi.fn() }))
vi.mock('../id.js', () => {
  let n = 0
  return { createId: () => `run_${++n}` }
})
vi.mock('../pending-job-registry.js', () => ({ registerPendingContext: vi.fn() }))
vi.mock('../execute-chat-run.js', () => ({ executeChatRun: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))

const tryAcquireSlot = vi.fn((..._args: unknown[]): string => 'acquired')
/**
 * Mirrors the production pre-check: `triggerRun` declines before writing a row
 * when the queue is full, so a test simulating `queue_full` must fail this too —
 * otherwise it would assert against a path the real code no longer takes.
 */
const hasAdmissionCapacity = vi.fn((..._args: unknown[]): Promise<boolean> => Promise.resolve(true))
vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: (...args: unknown[]) => tryAcquireSlot(...args),
  hasAdmissionCapacity: (...args: unknown[]) => hasAdmissionCapacity(...args),
}))

const listOpenRequests = vi.fn()
vi.mock('../git-trigger-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-trigger-cli.js')>()
  return {
    ...actual,
    listOpenRequests: (...args: unknown[]) => listOpenRequests(...args),
  }
})

import { gitTriggerManager } from '../git-trigger-manager.js'

function pr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    sha: `sha${number}`,
    comments: 0,
    title: `PR ${number}`,
    isDraft: false,
    ...overrides,
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'glab' as const,
    repos: [{ project: 'group/repo' }],
    events: ['opened', 'updated', 'commented', 'closed'],
    intervalSeconds: 60,
    intent: 'review {{url}}',
    targetBranches: [],
    ignoreDrafts: true,
    ...overrides,
  }
}

/**
 * Runs exactly one tick and waits for it to finish.
 *
 * `start()` fires an immediate seed tick but returns synchronously, so the tick
 * must be awaited via the manager's own in-flight bookkeeping — waiting only for
 * `listOpenRequests` to be *called* returns before any state is written.
 */
async function pollOnce(cfg: Record<string, unknown> = config()) {
  gitTriggerManager.start('agt_1', 'glab', cfg)
  await vi.waitFor(() => {
    expect(listOpenRequests).toHaveBeenCalled()
    expect(gitTriggerManager.isPolling('agt_1', 'glab')).toBe(false)
  })
  gitTriggerManager.stop('agt_1', 'glab')
}

beforeEach(() => {
  vi.clearAllMocks()
  stateRows.clear()
  runRows.length = 0
  effects.length = 0
  tryAcquireSlot.mockReturnValue('acquired')
  hasAdmissionCapacity.mockResolvedValue(true)
  agentRow = {
    id: 'agt_1',
    userId: 'usr_1',
    status: 'active',
    publishStatus: 'published',
    publishChannels: ['api', 'glab'],
    maxConcurrency: 1,
  }
})

describe('cold start', () => {
  it('seeds without firing when a repository is first observed', async () => {
    listOpenRequests.mockResolvedValue({ requests: [pr(1), pr(2)], complete: true })

    await pollOnce()

    expect(runRows).toHaveLength(0)
    expect([...stateRows.values()][0].state.requests).toHaveProperty('1')
  })

  it('does not write a state row when the very first poll fails', async () => {
    // Regression: `recordFailure` used to write `{requests:{}}` when no row
    // existed. `diffRepoState` treats that empty-but-present object as a warm
    // baseline (`!previous.requests` is false for `{}`), so the next successful
    // poll replayed every open request as `opened` — the exact stampede the
    // cold-start seeding exists to prevent.
    listOpenRequests.mockRejectedValue(new Error('glab not authenticated'))

    await pollOnce()

    expect(stateRows.size).toBe(0)
  })

  it('still seeds silently after a failed first poll', async () => {
    listOpenRequests.mockRejectedValueOnce(new Error('boom'))
    await pollOnce()

    listOpenRequests.mockResolvedValue({
      requests: [pr(1), pr(2), pr(3)],
      complete: true,
    })
    await pollOnce()

    // Seeded, not replayed: no Runs for merge requests that predate the channel.
    expect(runRows).toHaveLength(0)
  })
})

describe('per-tick run budget', () => {
  it('shares one budget across repositories rather than per repository', async () => {
    // Regression: `maxRunsPerTick` was passed as the constant inside the
    // per-repo loop, giving each repo its own 5 — so 20 repos could launch 100
    // Runs in a single tick, which `maxConcurrency` then mostly rejects as
    // queue_full, losing those events permanently.
    const repos = [{ project: 'g/a' }, { project: 'g/b' }, { project: 'g/c' }]
    for (const repo of repos) {
      stateRows.set(`agt_1|glab|${repo.project}`, {
        agentId: 'agt_1',
        channel: 'glab',
        repoKey: repo.project,
        state: { requests: {} },
        lastError: null,
      })
    }
    // Each repository has 4 brand-new PRs => 12 candidates, cap is 5.
    listOpenRequests.mockResolvedValue({
      requests: [pr(1), pr(2), pr(3), pr(4)],
      complete: true,
    })

    await pollOnce(config({ repos, events: ['opened'] }))

    expect(runRows.length).toBeLessThanOrEqual(5)
  })
})

describe('dispatch and persistence ordering', () => {
  it('launches Runs before persisting the advanced fingerprint', async () => {
    // If state is committed first, a throw in triggerRun leaves the fingerprint
    // past the change with no Run ever created, and no retry.
    stateRows.set('agt_1|glab|group/repo', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group/repo',
      state: { requests: { '1': { number: 1, sha: 'old', comments: 0 } } },
      lastError: null,
    })
    listOpenRequests.mockResolvedValue({ requests: [pr(1, { sha: 'new' })], complete: true })

    await pollOnce()

    // The run must be dispatched before the fingerprint is committed.
    expect(effects.map((e) => e.split(':')[0])).toEqual(['run', 'state'])
  })

  it('leaves the old fingerprint intact when dispatch throws', async () => {
    stateRows.set('agt_1|glab|group/repo', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group/repo',
      state: { requests: { '1': { number: 1, sha: 'old', comments: 0 } } },
      lastError: null,
    })
    listOpenRequests.mockResolvedValue({ requests: [pr(1, { sha: 'new' })], complete: true })
    tryAcquireSlot.mockImplementation(() => {
      throw new Error('SQLITE_BUSY')
    })

    await pollOnce()

    // The event must remain detectable on the next tick.
    expect([...stateRows.values()][0].state.requests['1'].sha).toBe('old')
  })
})

describe('failure isolation', () => {
  it('processes later repositories after one fails', async () => {
    const repos = [{ project: 'g/bad' }, { project: 'g/good' }]
    listOpenRequests.mockImplementation((_p: string, project: string) =>
      project === 'g/bad'
        ? Promise.reject(new Error('404'))
        : Promise.resolve({ requests: [pr(1)], complete: true }),
    )

    await pollOnce(config({ repos }))

    // The healthy repository still got seeded despite the earlier failure.
    expect(stateRows.has('agt_1|glab|g/good')).toBe(true)
  })
})

describe('mid-tick cancellation', () => {
  it('does not launch Runs for an Agent stopped while the fetch was in flight', async () => {
    // The fetch can take a full CLI timeout, during which the operator may hit
    // Stop. Without a liveness re-check the tick still inserted Runs for an
    // Agent the UI already showed as stopped.
    stateRows.set('agt_1|glab|group/repo', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group/repo',
      state: { requests: { '1': { number: 1, sha: 'old', comments: 0 } } },
      lastError: null,
    })
    listOpenRequests.mockImplementation(() => {
      agentRow = { ...(agentRow as object), publishStatus: 'stopped' }
      return Promise.resolve({ requests: [pr(1, { sha: 'new' })], complete: true })
    })

    await pollOnce()

    expect(runRows).toHaveLength(0)
  })

  it('does not launch Runs after the channel is disabled mid-tick', async () => {
    stateRows.set('agt_1|glab|group/repo', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group/repo',
      state: { requests: { '1': { number: 1, sha: 'old', comments: 0 } } },
      lastError: null,
    })
    listOpenRequests.mockImplementation(() => {
      agentRow = { ...(agentRow as object), publishChannels: ['api'] }
      return Promise.resolve({ requests: [pr(1, { sha: 'new' })], complete: true })
    })

    await pollOnce()

    expect(runRows).toHaveLength(0)
  })
})

describe('fairness and rejection handling', () => {
  it('rotates which repository is processed first across ticks', async () => {
    // Regression: with a shared budget and a fixed order, a busy repository at
    // the front consumed the whole budget every tick and the rest were never
    // processed at all — not deferred, starved. Rotation gives each repo the
    // front position within `repos.length` ticks.
    const repos = [{ project: 'g/busy' }, { project: 'g/quiet' }]
    for (const repo of repos) {
      stateRows.set(`agt_1|glab|${repo.project}`, {
        agentId: 'agt_1',
        channel: 'glab',
        repoKey: repo.project,
        state: { requests: {} },
        lastError: null,
      })
    }
    // Every repo reports 6 new PRs, so one repo alone exhausts the budget of 5.
    listOpenRequests.mockResolvedValue({
      requests: [pr(1), pr(2), pr(3), pr(4), pr(5), pr(6)],
      complete: true,
    })

    await pollOnce(config({ repos, events: ['opened'] }))
    const firstTick = [...stateRows.values()].filter(
      (r) => Object.keys(r.state.requests).length > 0,
    )
    await pollOnce(config({ repos, events: ['opened'] }))
    const secondTick = [...stateRows.values()].filter(
      (r) => Object.keys(r.state.requests).length > 0,
    )

    // Tick 1 advanced only the first repo; tick 2 must reach the other one.
    expect(firstTick).toHaveLength(1)
    expect(secondTick).toHaveLength(2)
  })

  it('rolls back the fingerprint of a run rejected for a full queue', async () => {
    // A queue_full run never processed the change, so advancing past it would
    // lose the event with no retry — the same loss deferral exists to prevent.
    stateRows.set('agt_1|glab|group/repo', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group/repo',
      state: { requests: { '1': { number: 1, sha: 'old', comments: 0 } } },
      lastError: null,
    })
    listOpenRequests.mockResolvedValue({ requests: [pr(1, { sha: 'new' })], complete: true })
    tryAcquireSlot.mockReturnValue('queue_full')
    hasAdmissionCapacity.mockResolvedValue(false)

    await pollOnce()

    expect([...stateRows.values()][0].state.requests['1'].sha).toBe('old')
  })

  it('writes nothing and spends nothing when the queue is full', async () => {
    // Regression: the budget decremented only on successful dispatch, so with a
    // permanently full queue it never moved — the exhaustion check never fired
    // and every repository ran to its own limit. `triggerRun` inserts the runs
    // row and its audit entry *before* asking for a slot, so a rejected attempt
    // still costs a real row: 20 repos x 5 became 100 rows per tick, and the
    // rollback made the same changes re-fire on every subsequent tick.
    const repos = Array.from({ length: 4 }, (_, i) => ({ project: `g/r${i}` }))
    for (const repo of repos) {
      stateRows.set(`agt_1|glab|${repo.project}`, {
        agentId: 'agt_1',
        channel: 'glab',
        repoKey: repo.project,
        state: { requests: {} },
        lastError: null,
      })
    }
    listOpenRequests.mockResolvedValue({
      requests: [pr(1), pr(2), pr(3), pr(4), pr(5), pr(6)],
      complete: true,
    })
    tryAcquireSlot.mockReturnValue('queue_full')
    hasAdmissionCapacity.mockResolvedValue(false)

    await pollOnce(config({ repos, events: ['opened'] }))

    // No rows at all: `triggerRun` now checks admission before writing, so a
    // full queue produces neither `failed` runs nor audit entries.
    expect(runRows).toHaveLength(0)
    // And no starvation: every repository was still diffed, because rejections
    // consume no budget. Each keeps its pre-tick fingerprint for the next poll.
    for (const repo of repos) {
      expect(stateRows.get(`agt_1|glab|${repo.project}`)?.state.requests).toEqual({})
    }
  })

  it('advances the fingerprint when the run is merely queued', async () => {
    // `queued` still owns the work, so it must not be rolled back.
    stateRows.set('agt_1|glab|group/repo', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group/repo',
      state: { requests: { '1': { number: 1, sha: 'old', comments: 0 } } },
      lastError: null,
    })
    listOpenRequests.mockResolvedValue({ requests: [pr(1, { sha: 'new' })], complete: true })
    tryAcquireSlot.mockReturnValue('queued')

    await pollOnce()

    expect([...stateRows.values()][0].state.requests['1'].sha).toBe('new')
  })
})

describe('poll ownership', () => {
  it('retires an in-flight poll when the config is replaced', async () => {
    // Regression: the previous design let a newer config's seed tick WAIT for
    // the running one, bounded at 10s against a tick that can run ~100s. The
    // wait expired and both ran concurrently, then the older tick's cleanup
    // released the shared guard while the newer was still going. Ownership
    // carries no timing assumption: the replaced poll simply stops.
    stateRows.set('agt_1|glab|group/repo', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group/repo',
      state: { requests: { '1': { number: 1, sha: 'old', comments: 0 } } },
      lastError: null,
    })

    listOpenRequests.mockImplementation(async () => {
      // A different config is saved while this fetch is outstanding.
      gitTriggerManager.start('agt_1', 'glab', config({ repos: [{ project: 'g/other' }] }))
      gitTriggerManager.stop('agt_1', 'glab')
      return { requests: [pr(1, { sha: 'new' })], complete: true }
    })

    await pollOnce()

    expect(runRows).toHaveLength(0)
  })

  it('does not fire after stop() even though the agent is still published', async () => {
    // `stop()` now revokes ownership. Previously it only cleared the timer, and
    // the in-flight poll passed `isStillLive()` — the agent really was still
    // published with the channel enabled — so it fired against a repo list the
    // user had just cleared.
    stateRows.set('agt_1|glab|group/repo', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group/repo',
      state: { requests: { '1': { number: 1, sha: 'old', comments: 0 } } },
      lastError: null,
    })
    listOpenRequests.mockImplementation(async () => {
      gitTriggerManager.stop('agt_1', 'glab')
      return { requests: [pr(1, { sha: 'new' })], complete: true }
    })

    await pollOnce()

    expect(runRows).toHaveLength(0)
  })

  it('fetches repositories one at a time rather than all at once', async () => {
    // Serial fetching is what removes the read-then-act window that every
    // concurrency defect on this channel lived in.
    const repos = [{ project: 'g/a' }, { project: 'g/b' }, { project: 'g/c' }]
    let concurrent = 0
    let peak = 0
    listOpenRequests.mockImplementation(async () => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 1))
      concurrent--
      return { requests: [], complete: true }
    })

    await pollOnce(config({ repos }))

    expect(peak).toBe(1)
  })
})

describe('config guards', () => {
  it('refuses to start when the config provider does not match the channel', () => {
    gitTriggerManager.start('agt_1', 'gh', config({ provider: 'glab' }))
    expect(gitTriggerManager.getActiveJobKeys()).not.toContain('agt_1:gh')
  })

  it('refuses to start on an invalid config', () => {
    gitTriggerManager.start('agt_1', 'glab', { provider: 'glab', repos: [] })
    expect(gitTriggerManager.getActiveJobKeys()).not.toContain('agt_1:glab')
  })
})

describe('run origin persistence', () => {
  /**
   * The staleness preflight runs when the Run *executes*, which for a queued
   * run is a different process lifetime from the poll that fired it. The
   * in-memory channel context does not survive that, so the request identity
   * has to be on the run row itself.
   */
  it('persists the fired request identity on the run row', async () => {
    stateRows.set('agt_1|glab|group/repo', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group/repo',
      state: { requests: {}, polledAt: 'seed' },
      lastError: null,
    })
    listOpenRequests.mockResolvedValue({ requests: [pr(42)], complete: true })

    await pollOnce(config({ repos: [{ project: 'group/repo', host: 'gitlab.example.com' }] }))

    expect(runRows).toHaveLength(1)
    expect(runRows[0].executionMetadata).toMatchObject({
      gitTriggerOrigin: {
        provider: 'glab',
        event: 'opened',
        project: 'group/repo',
        host: 'gitlab.example.com',
        number: 42,
      },
    })
  })

  it('records the request own project under a group scope, not the watch entry', async () => {
    // Under a group scope the entry names a namespace; probing that would ask
    // the forge about a merge request that does not exist there.
    stateRows.set('agt_1|glab|group:group', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group:group',
      state: { requests: {}, polledAt: 'seed' },
      lastError: null,
    })
    listOpenRequests.mockResolvedValue({
      requests: [pr(7, { project: 'group/sub/repo' })],
      complete: true,
    })

    await pollOnce(config({ repos: [{ project: 'group', scope: 'group' }] }))

    expect(runRows).toHaveLength(1)
    expect(
      (runRows[0].executionMetadata as { gitTriggerOrigin: { project: string } }).gitTriggerOrigin
        .project,
    ).toBe('group/sub/repo')
  })
})

describe('run origin queued marker', () => {
  /**
   * The staleness preflight only makes sense for a run that waited in the
   * queue. A run dispatched straight away starts milliseconds after the poll
   * saw the request open, so probing it would double the channel's forge call
   * volume to answer a question that cannot have changed.
   */
  function seedWarmState() {
    stateRows.set('agt_1|glab|group/repo', {
      agentId: 'agt_1',
      channel: 'glab',
      repoKey: 'group/repo',
      state: { requests: {}, polledAt: 'seed' },
      lastError: null,
    })
    listOpenRequests.mockResolvedValue({ requests: [pr(42)], complete: true })
  }

  it('marks a queued run so it is probed before execution', async () => {
    seedWarmState()
    tryAcquireSlot.mockReturnValue('queued')

    await pollOnce()

    expect(
      (runRows[0].executionMetadata as { gitTriggerOrigin: { queued?: boolean } }).gitTriggerOrigin
        .queued,
    ).toBe(true)
  })

  it('marks an immediately-dispatched run so it is not probed', async () => {
    seedWarmState()
    tryAcquireSlot.mockReturnValue('acquired')

    await pollOnce()

    expect(
      (runRows[0].executionMetadata as { gitTriggerOrigin: { queued?: boolean } }).gitTriggerOrigin
        .queued,
    ).toBe(false)
  })
})
