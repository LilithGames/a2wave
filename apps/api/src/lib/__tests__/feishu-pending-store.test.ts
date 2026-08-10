import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockInsertRun,
  mockInsertValues,
  mockDeleteRun,
  mockDeleteWhere,
  mockSelectAll,
  mockSelectFrom,
} = vi.hoisted(() => {
  const mockInsertRun = vi.fn()
  // Build a fresh node per call: asyncQuery memoizes its resolved rows, so a
  // single shared node would consume one `run`/`all` for the whole file and
  // every later `mockReturnValueOnce` would go unread.
  const mockInsertValues = vi.fn(
    (_row: { messageId: string; agentId: string; payload: string; createdAt: number }) =>
      asyncQuery({ run: mockInsertRun }),
  )
  const mockDeleteRun = vi.fn()
  // The condition is declared (rather than `() => ...`) so tests can read back
  // which columns the `where` filtered on.
  const mockDeleteWhere = vi.fn((_condition?: unknown) => asyncQuery({ run: mockDeleteRun }))
  const mockSelectAll = vi.fn().mockReturnValue([])
  const mockSelectFrom = vi.fn(() => asyncQuery({ all: mockSelectAll }))
  return {
    mockInsertRun,
    mockInsertValues,
    mockDeleteRun,
    mockDeleteWhere,
    mockSelectAll,
    mockSelectFrom,
  }
})

vi.mock('../../db/client.js', () => ({
  db: {
    insert: vi.fn(() => asyncQuery({ values: mockInsertValues })),
    delete: vi.fn(() => asyncQuery({ where: mockDeleteWhere })),
    select: vi.fn(() => asyncQuery({ from: mockSelectFrom })),
  },
}))

vi.mock('../../db/schema.js', () => ({
  // Columns are distinct symbols rather than one opaque table symbol, so a test
  // can read back which column a `where` clause was actually built against.
  feishuPendingMessages: {
    messageId: Symbol('feishuPendingMessages.messageId'),
    agentId: Symbol('feishuPendingMessages.agentId'),
    runId: Symbol('feishuPendingMessages.runId'),
    payload: Symbol('feishuPendingMessages.payload'),
    createdAt: Symbol('feishuPendingMessages.createdAt'),
  },
}))

import {
  listPendingMessages,
  persistPendingMessage,
  removePendingMessage,
} from '../feishu-pending-store.js'

/**
 * Local copy of src/test/async-query.ts, deliberately NOT imported.
 *
 * This file calls asyncQuery from inside a `vi.mock` factory, which vitest
 * hoists above every import. Referencing the shared module there fails at
 * runtime with "Cannot access '__vi_import_N__' before initialization" and
 * silently collects 0 tests, so the duplication is load-bearing.
 */
/**
 * Wrap a legacy sync mock terminator so it works with awaited queries.
 *
 * Production code awaits every query now, so a mock exposing only
 * `get`/`all`/`run` breaks at `.limit(1)` or at `await`. The returned value is
 * a real thenable (resolving to the row list) that also answers the builder
 * methods, while keeping the original mock fns reachable for assertions.
 */
// biome-ignore lint/suspicious/noExplicitAny: stands in for drizzle's builder
// across ~340 mock sites with differing terminator shapes.
function asyncQuery(term: Record<string, unknown>): any {
  const rows = (): unknown[] => {
    // `get` is consulted BEFORE `all`. Many mocks define both — a configured
    // `get` alongside a placeholder `all: () => []` — and preferring `all` made
    // every single-row lookup resolve empty, so callers saw `undefined`.
    const get = term.get as (() => unknown) | undefined
    if (get) {
      const row = get()
      if (row != null) return [row]
    }
    const all = term.all as (() => unknown[]) | undefined
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    if (get) return []
    const run = term.run as (() => unknown) | undefined
    if (run) {
      // A write mock returns better-sqlite3's `{ changes: n }`. Production now
      // counts `.returning()` rows instead, so surface n placeholder rows —
      // otherwise a successful claim looks like "0 rows affected" and every
      // compare-and-set guard reports that it lost the race.
      const res = run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 1
      return Array.from({ length: changes }, () => ({}))
    }
    return []
  }
  const make = (): any => {
    // Compose rather than choose: the test's own chain methods run first (so a
    // nested `where`/`orderBy` it defined still drives the data), and whatever
    // they return is itself wrapped — so `.limit(1)` and `await` work at every
    // depth. Picking one side or the other broke the opposite set of files.
    const wrap = (v: unknown): unknown =>
      v && typeof v === 'object' && !(v as { then?: unknown }).then
        ? asyncQuery(v as Record<string, unknown>)
        : v
    const chained: Record<string, unknown> = {}
    for (const key of [
      'limit',
      'orderBy',
      'offset',
      'groupBy',
      'having',
      'where',
      'returning',
      'onConflictDoNothing',
      'onConflictDoUpdate',
      'for',
    ]) {
      const own = term[key] as ((...a: unknown[]) => unknown) | undefined
      chained[key] = own ? (...a: unknown[]) => wrap(own(...a)) : () => make()
    }
    // Lazy: the row-resolving function must run only when the node is actually
    // awaited. `Promise.resolve().then(rows)` fires eagerly at construction, so
    // building a chain consumed a queued `get` per intermediate node and every
    // sequence-driven mock desynchronised.
    let settled: Promise<unknown[]> | undefined
    const node = Object.assign(
      {
        // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable — it stands in for drizzle's awaitable query builder.
        then: (
          onFulfilled?: (v: unknown[]) => unknown,
          onRejected?: (e: unknown) => unknown,
        ): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.then(onFulfilled, onRejected)
        },
        catch: (onRejected?: (e: unknown) => unknown): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.catch(onRejected)
        },
        finally: (onFinally?: () => void): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.finally(onFinally)
        },
      },
      term,
      chained,
    )
    return node
  }
  return make()
}

const payload = {
  message: { message_id: 'msg_1', chat_id: 'chat_1', content: '{"text":"hi"}' },
  sender: { sender_id: { open_id: 'usr_1' } },
}

/**
 * Walk a drizzle SQL condition and collect every bound value.
 *
 * `drizzle-orm` is NOT mocked in this file, so `eq()` / `and()` build real SQL
 * objects. Because the schema here is a bare Symbol rather than a real table,
 * drizzle inlines each bound value as a boxed `String` chunk while the SQL
 * operators (`' = '`, `' and '`) stay wrapped in `StringChunk.value` arrays.
 * Collecting the boxed strings is how a test asserts *which columns* a `where`
 * actually filters on, without depending on the exact chunk layout.
 */
function collectBoundValues(node: unknown): string[] {
  if (node == null) return []
  // Checked via the string tag rather than `instanceof String` or a `typeof`
  // guard: drizzle inlines the value as a *boxed* String under plain node and
  // as a *primitive* under vitest's transform, and this matches both.
  if (Object.prototype.toString.call(node) === '[object String]') return [String(node)]
  if (typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(collectBoundValues)
  return collectBoundValues((node as { queryChunks?: unknown }).queryChunks)
}

describe('feishu-pending-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSelectAll.mockReturnValue([])
  })

  it('persistPendingMessage 写入完整 JSON 载荷与元信息', async () => {
    await persistPendingMessage('msg_1', 'agt_1', payload)

    expect(mockInsertValues).toHaveBeenCalledTimes(1)
    const inserted = mockInsertValues.mock.calls[0][0] as {
      messageId: string
      agentId: string
      payload: string
      createdAt: number
    }
    expect(inserted.messageId).toBe('msg_1')
    expect(inserted.agentId).toBe('agt_1')
    expect(JSON.parse(inserted.payload)).toEqual(payload)
    expect(typeof inserted.createdAt).toBe('number')
  })

  it('persistPendingMessage 遇到主键冲突时静默成功（幂等）', async () => {
    // Production awaits `db.insert(...).values(...)`; `.run()` is never called,
    // so the write failure has to surface from `values()` itself.
    mockInsertValues.mockImplementationOnce(() => {
      const err = new Error(
        'UNIQUE constraint failed: feishu_pending_messages.message_id',
      ) as Error & { code?: string }
      err.code = 'SQLITE_CONSTRAINT_PRIMARYKEY'
      throw err
    })

    await expect(persistPendingMessage('msg_1', 'agt_1', payload)).resolves.toBeUndefined()
  })

  it('persistPendingMessage 为同一 messageId 的不同 Agent 各写一行', async () => {
    // Two Agents in one Feishu chat receive the SAME message_id. Each needs its
    // own row, so neither insert may be swallowed as a duplicate delivery.
    await persistPendingMessage('msg_1', 'agt_a', payload)
    await persistPendingMessage('msg_1', 'agt_b', payload)

    expect(mockInsertValues).toHaveBeenCalledTimes(2)
    const agentIds = mockInsertValues.mock.calls.map(
      (call) => (call[0] as { agentId: string }).agentId,
    )
    expect(agentIds).toEqual(['agt_a', 'agt_b'])
  })

  it('persistPendingMessage 其它错误应抛出', async () => {
    mockInsertValues.mockImplementationOnce(() => {
      throw new Error('disk is on fire')
    })

    await expect(persistPendingMessage('msg_1', 'agt_1', payload)).rejects.toThrow(
      'disk is on fire',
    )
  })

  it('removePendingMessage 调用 db.delete', async () => {
    await removePendingMessage('msg_1', 'agt_1')
    expect(mockDeleteWhere).toHaveBeenCalled()
    expect(mockDeleteRun).toHaveBeenCalled()
  })

  it('removePendingMessage 按 (messageId, agentId) 定位，不误删同群另一 Agent 的行', async () => {
    await removePendingMessage('msg_1', 'agt_1')

    // Feishu delivers the same message_id to every bot in the chat, so each
    // Agent owns its own row. Deleting by message_id alone destroys the other
    // Agent's restart-recovery record.
    const condition = mockDeleteWhere.mock.calls[0][0]
    expect(collectBoundValues(condition)).toEqual(expect.arrayContaining(['msg_1', 'agt_1']))
  })

  it('listPendingMessages 解析 JSON 并返回结构化行', async () => {
    mockSelectAll.mockReturnValueOnce([
      {
        messageId: 'msg_1',
        agentId: 'agt_1',
        runId: 'run_1',
        payload: JSON.stringify(payload),
        createdAt: 123,
      },
    ])

    const rows = await listPendingMessages()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ messageId: 'msg_1', agentId: 'agt_1', createdAt: 123 })
    expect(rows[0].payload).toEqual(payload)
  })

  it('listPendingMessages 对 JSON 损坏的行会静默清理并跳过', async () => {
    mockSelectAll.mockReturnValueOnce([
      { messageId: 'corrupt_1', agentId: 'agt_1', runId: null, payload: '{not json', createdAt: 1 },
      {
        messageId: 'ok_1',
        agentId: 'agt_1',
        runId: null,
        payload: JSON.stringify(payload),
        createdAt: 2,
      },
    ])

    const rows = await listPendingMessages()
    expect(rows).toHaveLength(1)
    expect(rows[0].messageId).toBe('ok_1')
    // Corrupt row triggered a cleanup call
    expect(mockDeleteWhere).toHaveBeenCalled()
  })
})
