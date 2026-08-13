/**
 * An evaluation's terminal write must not be absorbed by a stranger's SQLite
 * transaction.
 *
 * `executeTask` runs fire-and-forget, long after its request returned 201. Its
 * terminal region — the `completed`/`cancelled`/`failed` status, the settled
 * result rows, and the refreshed summary — is written with a bare `db.update`.
 * On SQLite the whole process shares one better-sqlite3 connection, so any
 * `BEGIN` open at that moment makes those statements join a transaction this
 * code does not own. When that stranger rolls back, the terminal write is
 * erased and the task is stuck displaying `running` forever, with no request
 * left alive to retry it.
 *
 * This is the same defect class `transaction.ts` documents for `logAudit`, and
 * it has the same fix: `runExclusive`, which serialises on the transaction key
 * and therefore *waits* for the open transaction instead of joining it.
 *
 * These tests drive `withTransaction`/`runExclusive` against a real in-memory
 * SQLite database, mirroring `db/__tests__/transaction.test.ts`, because the
 * defect only exists on the shared-connection dialect.
 */
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type TransactionDeps, runExclusive, withTransaction } from '../../db/transaction.js'

/** Stands in for `evaluation_tasks`, reduced to the terminal-write columns. */
const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  finishedAt: text('finished_at'),
})

type Orm = ReturnType<typeof drizzle>

interface Ctx {
  sqlite: Database.Database
  orm: Orm
  deps: TransactionDeps
}

let ctx: Ctx

beforeEach(() => {
  const sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, finished_at TEXT)')
  const orm = drizzle(sqlite)
  ctx = {
    sqlite,
    orm,
    deps: { db: orm as unknown as TransactionDeps['db'], isPostgres: false, sqlite },
  }
  sqlite.prepare("INSERT INTO tasks (id, status) VALUES ('evt_1', 'running')").run()
})

afterEach(() => {
  ctx.sqlite.close()
})

function readStatus(taskId: string): string | undefined {
  return ctx.orm.select().from(tasks).where(eq(tasks.id, taskId)).all()[0]?.status
}

/** The terminal write as `executeTask` performs it once fixed. */
async function writeTerminalStatus(
  executor: TransactionDeps['db'],
  taskId: string,
  status: string,
): Promise<void> {
  await (executor as unknown as Orm)
    .update(tasks)
    .set({ status, finishedAt: new Date().toISOString() })
    .where(eq(tasks.id, taskId))
}

describe('evaluation terminal write isolation', () => {
  it('survives an unrelated transaction rolling back', async () => {
    // An unrelated request opens a transaction and will fail for its own
    // reasons. Any statement issued on the shared connection during its window
    // is part of it, and dies with it.
    let insideTransaction: (() => void) | undefined
    const reachedTransaction = new Promise<void>((resolve) => {
      insideTransaction = resolve
    })

    const stranger = withTransaction(async (tx) => {
      await (tx as unknown as Orm)
        .update(tasks)
        .set({ status: 'stranger-touched' })
        .where(eq(tasks.id, 'evt_1'))
      insideTransaction?.()
      // Every await yields the loop — this is the window the terminal write
      // lands in, exactly as it does in production.
      await Promise.resolve()
      await Promise.resolve()
      throw new Error('unrelated request failed')
    }, ctx.deps)

    await reachedTransaction

    // The evaluation settling its own task. It is NOT part of the stranger's
    // transaction and must not be rolled back with it.
    const terminal = runExclusive(
      async () => writeTerminalStatus(ctx.deps.db, 'evt_1', 'completed'),
      ctx.deps,
    )

    await expect(stranger).rejects.toThrow('unrelated request failed')
    await terminal

    // The stranger's own write is correctly gone; the terminal write survives.
    expect(readStatus('evt_1')).toBe('completed')
  })

  it('keeps a cancelled terminal status durable across a concurrent rollback', async () => {
    // Same hazard on the cancellation path: `executeTask` writes `cancelled`
    // then settles its result rows, and losing either leaves the UI showing a
    // cancelled task whose cases spin forever.
    let insideTransaction: (() => void) | undefined
    const reached = new Promise<void>((resolve) => {
      insideTransaction = resolve
    })

    const stranger = withTransaction(async () => {
      insideTransaction?.()
      await Promise.resolve()
      throw new Error('rollback')
    }, ctx.deps)

    await reached
    const terminal = runExclusive(
      async () => writeTerminalStatus(ctx.deps.db, 'evt_1', 'cancelled'),
      ctx.deps,
    )

    await expect(stranger).rejects.toThrow('rollback')
    await terminal

    expect(readStatus('evt_1')).toBe('cancelled')
  })
})
