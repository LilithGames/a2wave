import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beatInstanceHeartbeat,
  canJudgePeerLiveness,
  deleteInstanceHeartbeat,
  hasLostHeartbeatOwnership,
  INSTANCE_DEAD_AFTER_MS,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
  INSTANCE_SELF_FENCE_AFTER_MS,
  type InstanceLivenessMap,
  isInstanceOwnerDead,
  loadInstanceLiveness,
  pruneDeadInstanceHeartbeats,
  startInstanceHeartbeat,
} from '../instance-heartbeat.js'

const NOW = new Date('2026-08-14T10:00:00Z')

function liveness(entries: Record<string, { startedAt: string; heartbeatAt: string }>) {
  const map: InstanceLivenessMap = new Map()
  for (const [id, row] of Object.entries(entries)) {
    map.set(id, { startedAt: new Date(row.startedAt), heartbeatAt: new Date(row.heartbeatAt) })
  }
  return map
}

describe('isInstanceOwnerDead', () => {
  // A live owner writes its row before acquiring anything, so a missing row can
  // only mean the owner never lived or died long enough ago to be pruned.
  it('treats a missing heartbeat row as dead', () => {
    expect(isInstanceOwnerDead(liveness({}), 'inst-a', NOW, NOW)).toBe(true)
  })

  it('treats a fresh heartbeat with a current-life mark as alive', () => {
    const map = liveness({
      'inst-a': { startedAt: '2026-08-14T09:00:00Z', heartbeatAt: '2026-08-14T09:59:50Z' },
    })
    expect(isInstanceOwnerDead(map, 'inst-a', new Date('2026-08-14T09:30:00Z'), NOW)).toBe(false)
  })

  it('treats a stopped heartbeat as dead', () => {
    const staleBeat = new Date(NOW.getTime() - INSTANCE_DEAD_AFTER_MS - 1)
    const map = liveness({
      'inst-a': { startedAt: '2026-08-14T08:00:00Z', heartbeatAt: staleBeat.toISOString() },
    })
    expect(isInstanceOwnerDead(map, 'inst-a', new Date('2026-08-14T08:30:00Z'), NOW)).toBe(true)
  })

  it('stays alive exactly at the staleness threshold', () => {
    const boundaryBeat = new Date(NOW.getTime() - INSTANCE_DEAD_AFTER_MS)
    const map = liveness({
      'inst-a': { startedAt: '2026-08-14T08:00:00Z', heartbeatAt: boundaryBeat.toISOString() },
    })
    expect(isInstanceOwnerDead(map, 'inst-a', new Date('2026-08-14T09:00:00Z'), NOW)).toBe(false)
  })

  // Container platforms reuse instance ids (HOSTNAME, an operator-pinned
  // A2WAVE_INSTANCE_ID). A mark written before the owner's current boot was
  // written by a previous process with the same name — provably dead even
  // though the heartbeat looks fresh.
  it('treats a mark older than the owner boot as written by a dead previous life', () => {
    const map = liveness({
      'inst-a': { startedAt: '2026-08-14T09:00:00Z', heartbeatAt: '2026-08-14T09:59:50Z' },
    })
    expect(isInstanceOwnerDead(map, 'inst-a', new Date('2026-08-14T08:59:00Z'), NOW)).toBe(true)
  })
})

interface UpsertCall {
  values: Record<string, unknown>
  set: Record<string, unknown>
}

function mockHeartbeatDb() {
  const upserts: UpsertCall[] = []
  const deletes: unknown[] = []
  const rows: Record<string, unknown>[] = []
  const dbMock = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn((config: { set: Record<string, unknown> }) => ({
          returning: vi.fn(() => {
            upserts.push({ values, set: config.set })
            return Promise.resolve([{ id: values.id }])
          }),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((condition: unknown) => ({
        returning: vi.fn(() => {
          deletes.push(condition)
          return Promise.resolve([{ id: 'gone' }])
        }),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => Promise.resolve(rows)),
    })),
  }
  return { dbMock, upserts, deletes, rows }
}

function deps(dbMock: unknown, overrides: Record<string, unknown> = {}) {
  return {
    db: dbMock,
    write: <T>(fn: () => Promise<T>) => fn(),
    instanceId: 'inst-self',
    bootTime: new Date('2026-08-14T09:00:00Z'),
    now: () => NOW,
    monotonicMs: () => 0,
    ...overrides,
  } as never
}

describe('beatInstanceHeartbeat', () => {
  it('upserts the own row, overwriting a previous life boot instant on conflict', async () => {
    const { dbMock, upserts } = mockHeartbeatDb()
    await beatInstanceHeartbeat(deps(dbMock))
    expect(upserts).toHaveLength(1)
    expect(upserts[0].values).toMatchObject({
      id: 'inst-self',
      startedAt: new Date('2026-08-14T09:00:00Z'),
      heartbeatAt: NOW,
    })
    // The conflict update must refresh startedAt too: a reused instance id
    // must not inherit the dead previous life's boot instant.
    expect(upserts[0].set).toMatchObject({
      startedAt: new Date('2026-08-14T09:00:00Z'),
      heartbeatAt: NOW,
    })
  })
})

describe('startInstanceHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('beats immediately, then on the interval, and stops cleanly', async () => {
    const { dbMock, upserts } = mockHeartbeatDb()
    const stop = startInstanceHeartbeat(deps(dbMock))
    await vi.advanceTimersByTimeAsync(0)
    expect(upserts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(INSTANCE_HEARTBEAT_INTERVAL_MS)
    expect(upserts).toHaveLength(2)
    stop()
    await vi.advanceTimersByTimeAsync(INSTANCE_HEARTBEAT_INTERVAL_MS * 3)
    expect(upserts).toHaveLength(2)
  })

  it('keeps beating after a transient write failure', async () => {
    const { dbMock, upserts } = mockHeartbeatDb()
    let failures = 0
    const failingWrite = <T>(fn: () => Promise<T>): Promise<T> => {
      if (failures++ === 0) return Promise.reject(new Error('db busy'))
      return fn()
    }
    const stop = startInstanceHeartbeat(deps(dbMock, { write: failingWrite }))
    await vi.advanceTimersByTimeAsync(0)
    expect(upserts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(INSTANCE_HEARTBEAT_INTERVAL_MS)
    expect(upserts).toHaveLength(1)
    stop()
  })
})

describe('startInstanceHeartbeat — single-flight and self-fencing', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not overlap beats when a write outlives its interval', async () => {
    // Two concurrent upserts of the same row race to write heartbeatAt, and a
    // slow one landing after a fast one would move liveness backwards.
    //
    // Count `write` entries, NOT the upserts the mock records: a write that is
    // still in flight has not reached the DB layer yet, so asserting on upserts
    // would read zero whether or not the single-flight guard exists — the shape
    // of an earlier version of this test, which passed with the guard deleted.
    const { dbMock, upserts } = mockHeartbeatDb()
    let started = 0
    let release: (() => void) | undefined
    const slowWrite = <T>(fn: () => Promise<T>): Promise<T> => {
      started++
      return new Promise<T>((resolve) => {
        release = () => resolve(fn())
      })
    }

    const stop = startInstanceHeartbeat(deps(dbMock, { write: slowWrite }))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(INSTANCE_HEARTBEAT_INTERVAL_MS * 3)

    // Three intervals elapsed while the first write was still in flight; none
    // of them may have started a second one.
    expect(started).toBe(1)
    expect(upserts).toHaveLength(0)
    release?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(upserts).toHaveLength(1)
    stop()
  })

  it('reports lost ownership once renewals fail past the dead-after threshold', async () => {
    // The owner must reach the same verdict its peers will: if it cannot renew,
    // peers will treat it as dead and reclaim its checkouts, so it has to stop
    // acting as an owner rather than keep writing to a shared worktree.
    const { dbMock } = mockHeartbeatDb()
    const failingWrite = <T>(_fn: () => Promise<T>): Promise<T> =>
      Promise.reject(new Error('db unreachable'))
    let clock = NOW.getTime()
    // A just-booted process: boot and now coincide, as they do in production.
    const state = deps(dbMock, {
      write: failingWrite,
      bootTime: NOW,
      now: () => new Date(clock),
      monotonicMs: () => clock - NOW.getTime(),
    })

    const stop = startInstanceHeartbeat(state)
    await vi.advanceTimersByTimeAsync(0)
    expect(hasLostHeartbeatOwnership(state)).toBe(false)

    clock = NOW.getTime() + INSTANCE_DEAD_AFTER_MS + 1
    await vi.advanceTimersByTimeAsync(INSTANCE_HEARTBEAT_INTERVAL_MS)

    expect(hasLostHeartbeatOwnership(state)).toBe(true)
    stop()
  })

  it('fails stop before peers may reclaim and never revives the expired ownership', async () => {
    const { dbMock } = mockHeartbeatDb()
    let fail = true
    const onOwnershipLost = vi.fn()
    const flakyWrite = <T>(fn: () => Promise<T>): Promise<T> =>
      fail ? Promise.reject(new Error('db unreachable')) : fn()
    let clock = NOW.getTime()
    const state = deps(dbMock, {
      write: flakyWrite,
      bootTime: NOW,
      now: () => new Date(clock),
      monotonicMs: () => clock - NOW.getTime(),
    })

    const stop = startInstanceHeartbeat(state, { onOwnershipLost })
    await vi.advanceTimersByTimeAsync(0)
    clock = NOW.getTime() + INSTANCE_SELF_FENCE_AFTER_MS + 1
    await vi.advanceTimersByTimeAsync(INSTANCE_HEARTBEAT_INTERVAL_MS)
    expect(hasLostHeartbeatOwnership(state)).toBe(true)
    expect(onOwnershipLost).toHaveBeenCalledTimes(1)
    expect(INSTANCE_SELF_FENCE_AFTER_MS).toBeLessThan(INSTANCE_DEAD_AFTER_MS)

    fail = false
    await vi.advanceTimersByTimeAsync(INSTANCE_HEARTBEAT_INTERVAL_MS)

    expect(hasLostHeartbeatOwnership(state)).toBe(true)
    expect(onOwnershipLost).toHaveBeenCalledTimes(1)
    stop()
  })

  it('credits a slow write from when it was issued, not when it returned', async () => {
    // A write that took 30s only proves liveness as of when it was sent, so
    // crediting its return time would extend the lease by its own latency —
    // exactly the wrong direction when the DB is degraded.
    const { dbMock } = mockHeartbeatDb()
    let elapsed = 0
    const slowWrite = async <T>(fn: () => Promise<T>): Promise<T> => {
      elapsed += INSTANCE_SELF_FENCE_AFTER_MS + 1
      return fn()
    }
    const state = deps(dbMock, { write: slowWrite, monotonicMs: () => elapsed })

    const stop = startInstanceHeartbeat(state)
    await vi.advanceTimersByTimeAsync(0)

    // The write succeeded, but by the time it returned the deadline had passed.
    expect(hasLostHeartbeatOwnership(state)).toBe(true)
    stop()
  })

  // The dangerous direction: a backwards step must not make a stale owner look
  // healthy, because peers judge it by their own clocks regardless.
  it('is unaffected by a wall-clock step backwards', async () => {
    const { dbMock } = mockHeartbeatDb()
    let elapsed = 0
    const state = deps(dbMock, {
      write: async <T>(_fn: () => Promise<T>): Promise<T> => {
        throw new Error('db unreachable')
      },
      // Wall clock jumps a day into the past; monotonic keeps counting.
      now: () => new Date(NOW.getTime() - 86_400_000),
      monotonicMs: () => elapsed,
    })

    const stop = startInstanceHeartbeat(state)
    await vi.advanceTimersByTimeAsync(0)
    elapsed = INSTANCE_SELF_FENCE_AFTER_MS + 1
    await vi.advanceTimersByTimeAsync(INSTANCE_HEARTBEAT_INTERVAL_MS)

    expect(hasLostHeartbeatOwnership(state)).toBe(true)
    stop()
  })
})

describe('loadInstanceLiveness', () => {
  it('maps rows by instance id', async () => {
    const { dbMock, rows } = mockHeartbeatDb()
    rows.push(
      { id: 'inst-a', startedAt: new Date('2026-08-14T09:00:00Z'), heartbeatAt: NOW },
      { id: 'inst-b', startedAt: new Date('2026-08-14T08:00:00Z'), heartbeatAt: NOW },
    )
    const map = await loadInstanceLiveness(dbMock as never)
    expect(map.size).toBe(2)
    expect(map.get('inst-a')?.startedAt).toEqual(new Date('2026-08-14T09:00:00Z'))
  })
})

describe('pruneDeadInstanceHeartbeats / deleteInstanceHeartbeat', () => {
  it('prunes long-dead rows and deletes the own row on shutdown', async () => {
    const { dbMock, deletes } = mockHeartbeatDb()
    await pruneDeadInstanceHeartbeats(deps(dbMock))
    await deleteInstanceHeartbeat(deps(dbMock))
    expect(deletes).toHaveLength(2)
  })
})

describe('canJudgePeerLiveness', () => {
  // The upgrade hazard this guards: right after a rollout the heartbeat table
  // is empty, so every pre-existing mark reads as owner-less and recovery
  // would reclaim checkouts from peers that simply have not beaten yet.
  it('refuses to judge peers until a full staleness window has passed since boot', () => {
    const { dbMock } = mockHeartbeatDb()
    const justBooted = deps(dbMock, {
      bootTime: new Date(NOW.getTime() - INSTANCE_DEAD_AFTER_MS + 1),
    })
    expect(canJudgePeerLiveness(justBooted)).toBe(false)
  })

  it('refuses to judge peers while self-fenced', async () => {
    // A self-fenced instance is one peers already consider dead. If it kept
    // reaping, two processes would reclaim the same lease from opposite sides.
    vi.useFakeTimers()
    const { dbMock } = mockHeartbeatDb()
    let clock = NOW.getTime()
    const state = deps(dbMock, {
      write: <T>(_fn: () => Promise<T>): Promise<T> => Promise.reject(new Error('db unreachable')),
      bootTime: new Date(NOW.getTime() - INSTANCE_DEAD_AFTER_MS * 2),
      now: () => new Date(clock),
      monotonicMs: () => clock - NOW.getTime(),
    })
    const stop = startInstanceHeartbeat(state)
    await vi.advanceTimersByTimeAsync(0)
    // Booted long ago, so the grace window alone would allow judging.
    expect(canJudgePeerLiveness(state)).toBe(true)

    clock = NOW.getTime() + INSTANCE_DEAD_AFTER_MS + 1
    await vi.advanceTimersByTimeAsync(INSTANCE_HEARTBEAT_INTERVAL_MS)

    expect(canJudgePeerLiveness(state)).toBe(false)
    stop()
    vi.useRealTimers()
  })

  it('judges peers once the grace window has elapsed', () => {
    const { dbMock } = mockHeartbeatDb()
    const settled = deps(dbMock, {
      bootTime: new Date(NOW.getTime() - INSTANCE_DEAD_AFTER_MS),
    })
    expect(canJudgePeerLiveness(settled)).toBe(true)
  })
})
