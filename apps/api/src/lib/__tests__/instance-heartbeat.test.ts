import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INSTANCE_DEAD_AFTER_MS,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
  type InstanceLivenessMap,
  beatInstanceHeartbeat,
  deleteInstanceHeartbeat,
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
