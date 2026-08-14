import { type ListTasksRequest, Task, TaskState } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

const {
  mockDeleteRun,
  mockDeleteWhere,
  mockInsertRun,
  mockInsertValues,
  mockSelectAll,
  mockSelectGet,
  mockSelectLimit,
  mockSelectOrderByLimit,
  mockSelectOrderBy,
  mockSelectWhere,
  mockSelectFrom,
  mockUpdateSet,
  mockUpdateWhere,
  mockUpdateRun,
} = vi.hoisted(() => {
  const mockDeleteRun = vi.fn().mockReturnValue({ changes: 0 })
  const mockDeleteWhere = vi.fn(() => asyncQuery({ run: mockDeleteRun }))
  const mockInsertRun = vi.fn()
  const mockInsertValues = vi.fn((_values: { data: string }) => asyncQuery({ run: mockInsertRun }))
  const mockUpdateRun = vi.fn()
  const mockUpdateWhere = vi.fn(() => asyncQuery({ run: mockUpdateRun }))
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere })
  const mockSelectAll = vi.fn().mockReturnValue([])
  const mockSelectGet = vi.fn()
  // Built fresh per call and wrapped in asyncQuery: the store now awaits every
  // read, and `.limit(1)` must resolve to the row list drizzle would return.
  const mockSelectLimit = vi.fn(() => asyncQuery({ get: mockSelectGet, all: mockSelectAll }))
  // The list() path ends `orderBy(...).limit(n)` and must resolve to the ROW
  // LIST, never the single-row `get` — asyncQuery consults `get` first, so this
  // terminator deliberately omits it.
  const mockSelectOrderByLimit = vi.fn(() => asyncQuery({ all: mockSelectAll }))
  const mockSelectOrderBy = vi.fn(() => asyncQuery({ limit: mockSelectOrderByLimit }))
  const mockSelectWhere = vi.fn(() =>
    asyncQuery({
      get: mockSelectGet,
      all: mockSelectAll,
      orderBy: mockSelectOrderBy,
      limit: mockSelectLimit,
    }),
  )
  const mockSelectFrom = vi.fn(() =>
    asyncQuery({ where: mockSelectWhere, all: mockSelectAll, limit: mockSelectLimit }),
  )
  return {
    mockDeleteRun,
    mockDeleteWhere,
    mockInsertRun,
    mockInsertValues,
    mockSelectAll,
    mockSelectGet,
    mockSelectLimit,
    mockSelectOrderByLimit,
    mockSelectOrderBy,
    mockSelectWhere,
    mockSelectFrom,
    mockUpdateSet,
    mockUpdateWhere,
    mockUpdateRun,
  }
})

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: mockSelectFrom }),
    insert: vi.fn().mockReturnValue({ values: mockInsertValues }),
    update: vi.fn().mockReturnValue({ set: mockUpdateSet }),
    delete: vi.fn().mockReturnValue({ where: mockDeleteWhere }),
  },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { logger } from '../../lib/logger.js'
import { SqliteTaskStore, normalizeStatusTimestampAfter } from '../sqlite-task-store.js'

function callContext(tenant = 'agt_one', owner = 'a2a:agt_one:api_key') {
  return new ServerCallContext({
    tenant,
    user: { isAuthenticated: true, userName: owner },
    requestedVersion: '1.0',
  })
}

function task(
  id: string,
  state = TaskState.TASK_STATE_WORKING,
  contextId = 'ctx_1',
  timestamp = '2026-08-06T01:00:00.000Z',
): Task {
  return {
    id,
    contextId,
    status: { state, message: undefined, timestamp },
    artifacts: [],
    history: [],
    metadata: undefined,
  }
}

function persistedTask(value: Task, tenant = 'agt_one', owner = 'a2a:agt_one:api_key') {
  return JSON.stringify({
    persistenceVersion: 1,
    scope: { tenant, owner },
    task: Task.toJSON(value),
  })
}

const listParams: ListTasksRequest = {
  tenant: '',
  contextId: '',
  status: TaskState.TASK_STATE_UNSPECIFIED,
  pageSize: 50,
  pageToken: '',
  historyLength: undefined,
  statusTimestampAfter: undefined,
  includeArtifacts: true,
}

describe('SqliteTaskStore', () => {
  let store: SqliteTaskStore

  beforeEach(() => {
    vi.clearAllMocks()
    mockSelectGet.mockReturnValue(undefined)
    mockSelectAll.mockReturnValue([])
    mockDeleteRun.mockReturnValue({ changes: 0 })
    store = new SqliteTaskStore()
  })

  it('saves the task together with tenant and caller scope', async () => {
    vi.spyOn(store, 'cleanup').mockResolvedValue(0)

    await store.save(task('task_1'), callContext())

    const persisted = JSON.parse(mockInsertValues.mock.calls[0][0].data)
    expect(persisted).toMatchObject({
      persistenceVersion: 1,
      scope: { tenant: 'agt_one', owner: 'a2a:agt_one:api_key' },
      task: { id: 'task_1' },
    })
  })

  it('strips NUL from the persisted envelope, which PostgreSQL jsonb cannot hold', async () => {
    // A2A message text is caller-supplied. `JSON.stringify` renders U+0000 as a
    // valid \\u0000 escape that SQLite stores happily, but jsonb holds unescaped
    // text and has no NUL, so `(data)::jsonb` fails with 22P05 — verified on
    // PostgreSQL 14. Because `list()` casts the WHOLE envelope to filter on
    // scope.tenant, one NUL in one task's text breaks tasks/list for every task
    // in that scope, including tasks that contain none.
    vi.spyOn(store, 'cleanup').mockResolvedValue(0)
    const nul = String.fromCharCode(0)
    // contextId round-trips through the SDK codec verbatim, so the NUL is
    // still present in the serialised envelope unless it is stripped.
    const withNul = task('task_nul', undefined, `before${nul}after`)

    await store.save(withNul, callContext())

    const persisted = mockInsertValues.mock.calls[0][0].data
    expect(persisted).not.toContain(nul)
    expect(persisted).not.toContain('\\u0000')
    // Still valid JSON, and the surrounding text survives intact.
    expect(JSON.stringify(JSON.parse(persisted))).toContain('beforeafter')
  })

  it('preserves text that literally spells out a unicode escape', async () => {
    // The strip runs on the SERIALISED form, so it must not corrupt a user who
    // typed the six characters backslash-u-0-0-0-0 into a message: stringify escapes that as
    // \\u0000, and the negative lookbehind keeps it. Getting this wrong would
    // silently rewrite caller content — worse than the bug being fixed.
    vi.spyOn(store, 'cleanup').mockResolvedValue(0)
    const literal = 'a\\u0000b'

    await store.save(task('task_literal', undefined, literal), callContext())

    const persisted = mockInsertValues.mock.calls[0][0].data
    expect(JSON.parse(persisted).task.contextId).toBe(literal)
  })

  it('strips a lone surrogate, which PostgreSQL jsonb also rejects', async () => {
    // Same failure class as NUL and the same whole-scope blast radius, but it
    // arrives by accident far more easily: truncating a UTF-16 string mid-emoji
    // leaves an unpaired half. Verified on PostgreSQL 14 —
    // `'{"t":"<lone high surrogate>"}'::jsonb` raises 22P02 "Unicode low
    // surrogate must follow a high surrogate".
    vi.spyOn(store, 'cleanup').mockResolvedValue(0)
    const loneHigh = String.fromCharCode(0xd800)

    await store.save(task('task_sur', undefined, `before${loneHigh}after`), callContext())

    const persisted = mockInsertValues.mock.calls[0][0].data
    expect(persisted).not.toMatch(/[\uD800-\uDFFF]/)
    expect(JSON.parse(persisted).task.contextId).toBe('beforeafter')
  })

  it('keeps a valid surrogate pair, which is an ordinary astral character', async () => {
    // The strip must remove only UNPAIRED halves. An emoji is a legitimate pair
    // and round-trips through jsonb, so removing it would corrupt caller text.
    vi.spyOn(store, 'cleanup').mockResolvedValue(0)
    const emoji = String.fromCodePoint(0x1f600)

    await store.save(task('task_emoji', undefined, `a${emoji}b`), callContext())

    const persisted = mockInsertValues.mock.calls[0][0].data
    expect(JSON.parse(persisted).task.contextId).toBe(`a${emoji}b`)
  })

  it('rejects an update when the task ID belongs to another scope', async () => {
    mockSelectGet.mockReturnValue({
      id: 'task_shared',
      data: persistedTask(task('task_shared'), 'agt_other', 'a2a:agt_other:none'),
    })

    await expect(store.save(task('task_shared'), callContext())).rejects.toThrow(
      'already owned by another caller scope',
    )
    expect(mockUpdateSet).not.toHaveBeenCalled()
  })

  it('loads only a task owned by the exact tenant and caller', async () => {
    mockSelectGet.mockReturnValue({ id: 'task_1', data: persistedTask(task('task_1')) })

    await expect(store.load('task_1', callContext())).resolves.toMatchObject({ id: 'task_1' })
    await expect(store.load('task_1', callContext('agt_one', 'another-caller'))).resolves.toBe(
      undefined,
    )
    await expect(store.load('task_1', callContext('agt_other'))).resolves.toBe(undefined)
  })

  it('fails closed for legacy persisted rows without a scope envelope', async () => {
    mockSelectGet.mockReturnValue({ id: 'legacy', data: JSON.stringify({ id: 'legacy' }) })

    await expect(store.load('legacy', callContext())).resolves.toBeUndefined()
  })

  it('lists, filters, and paginates only tasks in the current scope', async () => {
    mockSelectGet.mockReturnValue({ value: 2 })
    mockSelectAll.mockReturnValue([
      {
        id: 'mine_1',
        updatedAt: 30,
        data: persistedTask(task('mine_1', undefined, 'ctx_a', '2026-08-06T01:00:00.002Z')),
      },
      {
        id: 'foreign',
        updatedAt: 20,
        data: persistedTask(task('foreign'), 'agt_other', 'a2a:agt_other:api_key'),
      },
      {
        id: 'mine_2',
        updatedAt: 10,
        data: persistedTask(task('mine_2', undefined, 'ctx_b', '2026-08-06T01:00:00.001Z')),
      },
      { id: 'legacy', updatedAt: 5, data: JSON.stringify({ id: 'legacy' }) },
    ])

    const first = await store.list({ ...listParams, pageSize: 1 }, callContext())
    expect(mockSelectWhere).toHaveBeenCalled()
    expect(first.tasks.map((item) => item.id)).toEqual(['mine_1'])
    expect(first.totalSize).toBe(2)
    expect(first.nextPageToken).not.toBe('')

    const second = await store.list(
      { ...listParams, pageSize: 1, pageToken: first.nextPageToken },
      callContext(),
    )
    expect(second.tasks.map((item) => item.id)).toEqual(['mine_2'])

    const filtered = await store.list({ ...listParams, contextId: 'ctx_b' }, callContext())
    expect(filtered.tasks.map((item) => item.id)).toEqual(['mine_2'])
  })

  it('keeps pagination stable when a newer task is inserted between pages', async () => {
    const older = task(
      'task_older',
      TaskState.TASK_STATE_WORKING,
      'ctx_1',
      '2026-08-06T01:00:00.001Z',
    )
    const boundary = task(
      'task_boundary',
      TaskState.TASK_STATE_WORKING,
      'ctx_1',
      '2026-08-06T01:00:00.002Z',
    )
    mockSelectGet.mockReturnValue({ value: 2 })
    mockSelectAll.mockReturnValue([
      { id: boundary.id, updatedAt: 20, data: persistedTask(boundary) },
      { id: older.id, updatedAt: 10, data: persistedTask(older) },
    ])

    const first = await store.list({ ...listParams, pageSize: 1 }, callContext())
    expect(first.tasks.map((item) => item.id)).toEqual(['task_boundary'])

    const newer = task(
      'task_newer',
      TaskState.TASK_STATE_WORKING,
      'ctx_1',
      '2026-08-06T01:00:00.003Z',
    )
    mockSelectGet.mockReturnValue({ value: 3 })
    mockSelectAll.mockReturnValue([
      { id: newer.id, updatedAt: 30, data: persistedTask(newer) },
      { id: boundary.id, updatedAt: 20, data: persistedTask(boundary) },
      { id: older.id, updatedAt: 10, data: persistedTask(older) },
    ])

    const second = await store.list(
      { ...listParams, pageSize: 1, pageToken: first.nextPageToken },
      callContext(),
    )
    expect(second.tasks.map((item) => item.id)).toEqual(['task_older'])
    expect(second.totalSize).toBe(3)
  })

  it('rejects a malformed page token instead of silently restarting pagination', async () => {
    await expect(
      store.list({ ...listParams, pageToken: '1-trailing-junk' }, callContext()),
    ).rejects.toThrow('Invalid A2A task page token')
  })

  it('includes tasks updated exactly at the statusTimestampAfter boundary', async () => {
    mockSelectGet.mockReturnValue({ value: 2 })
    mockSelectAll.mockReturnValue([
      { id: 'equal', updatedAt: 30, data: persistedTask(task('equal')) },
      {
        id: 'after',
        updatedAt: 20,
        data: persistedTask({
          ...task('after'),
          status: {
            state: TaskState.TASK_STATE_WORKING,
            message: undefined,
            timestamp: '2026-08-06T01:00:00.001Z',
          },
        }),
      },
    ])

    const result = await store.list(
      { ...listParams, statusTimestampAfter: '2026-08-06T01:00:00.000Z' },
      callContext(),
    )

    expect(result.tasks.map((item) => item.id)).toEqual(['after', 'equal'])
  })

  it('normalizes offset timestamps before SQLite text comparison', () => {
    expect(normalizeStatusTimestampAfter('2026-08-06T09:00:00+08:00')).toBe(
      '2026-08-06T01:00:00.000Z',
    )
    expect(() => normalizeStatusTimestampAfter('not-a-date')).toThrow(
      'statusTimestampAfter must be a valid ISO 8601 date string',
    )
  })

  it('limits the persistence query to one row beyond the requested page', async () => {
    mockSelectGet.mockReturnValue({ value: 5000 })
    mockSelectAll.mockReturnValue([
      { id: 'task_2', data: persistedTask(task('task_2')) },
      { id: 'task_1', data: persistedTask(task('task_1')) },
    ])

    const result = await store.list({ ...listParams, pageSize: 1 }, callContext())

    expect(mockSelectOrderByLimit).toHaveBeenCalledWith(2)
    expect(result.tasks).toHaveLength(1)
    expect(result.totalSize).toBe(5000)
    expect(result.nextPageToken).not.toBe('')
  })

  describe('cleanup', () => {
    it('deletes expired rows and returns the affected count', async () => {
      mockDeleteRun.mockReturnValue({ changes: 3 })
      await expect(store.cleanup(14)).resolves.toBe(3)
    })

    it('returns zero when no rows are expired', async () => {
      await expect(store.cleanup()).resolves.toBe(0)
    })
  })

  describe('time-based cleanup', () => {
    it('runs on the first save but not again within the interval', async () => {
      const cleanupSpy = vi.spyOn(store, 'cleanup').mockResolvedValue(0)

      await store.save(task('task_1'), callContext())
      expect(cleanupSpy).toHaveBeenCalledOnce()

      cleanupSpy.mockClear()
      await store.save(task('task_2'), callContext())
      expect(cleanupSpy).not.toHaveBeenCalled()
    })
  })

  describe('markTaskFailed', () => {
    it('returns false when the task does not exist', async () => {
      await expect(store.markTaskFailed('nope', 'restart interrupt')).resolves.toBe(false)
    })

    it('updates a scoped v1 task without losing its scope', async () => {
      mockSelectGet.mockReturnValue({ id: 'task_1', data: persistedTask(task('task_1')) })

      await expect(store.markTaskFailed('task_1', 'server restart reason')).resolves.toBe(true)

      const persisted = JSON.parse(mockUpdateSet.mock.calls[0][0].data)
      expect(persisted.scope).toEqual({ tenant: 'agt_one', owner: 'a2a:agt_one:api_key' })
      expect(persisted.task.status.state).toBe('TASK_STATE_FAILED')
      expect(persisted.task.status.message.parts[0].text).toBe('server restart reason')
    })

    it('does not overwrite terminal v1 states', async () => {
      mockSelectGet.mockReturnValue({
        id: 'task_done',
        data: persistedTask(task('task_done', TaskState.TASK_STATE_COMPLETED)),
      })

      await expect(store.markTaskFailed('task_done', 'anything')).resolves.toBe(false)
      expect(mockUpdateSet).not.toHaveBeenCalled()
    })

    it('still marks a legacy row for internal recovery without exposing it', async () => {
      mockSelectGet.mockReturnValue({
        id: 'legacy',
        data: JSON.stringify({
          id: 'legacy',
          contextId: 'ctx_legacy',
          status: { state: 'working' },
        }),
      })

      await expect(store.markTaskFailed('legacy', 'restart')).resolves.toBe(true)
      const updated = JSON.parse(mockUpdateSet.mock.calls[0][0].data)
      expect(updated.status.state).toBe('failed')
      expect(updated.status.message.parts[0].text).toBe('restart')
    })

    it('returns false and logs when stored JSON is corrupt', async () => {
      mockSelectGet.mockReturnValue({ id: 'task_3', data: '{not json' })

      await expect(store.markTaskFailed('task_3', 'anything')).resolves.toBe(false)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task_3' }),
        'Failed to parse persisted A2A task while marking it failed',
      )
      expect(mockUpdateSet).not.toHaveBeenCalled()
    })
  })
})
