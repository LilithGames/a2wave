/**
 * `lookupPreviousChatId` against a real in-memory SQLite, because the defect it guards is
 * an ordering decision and a mocked query builder has no ordering to get wrong.
 *
 * Regression: `runs.created_at` is second-granular, so two runs started in the same second
 * tie under `ORDER BY created_at DESC` and either database may return them in any order.
 * Not hypothetical — two Feishu messages arriving in the same second produced exactly
 * this, and the session that got resumed was the older one. The lookup now reads the tie
 * set and picks the run that finished last.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { P2P_SESSION_TIMEOUT_MS } from '../feishu-message-context.js'

vi.mock('../../db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const { getTableConfig } = await import('drizzle-orm/sqlite-core')
  const Database = (await import('better-sqlite3')).default
  // Import the SQLite table directly, not the dialect-dispatching `schema.js`: this
  // factory emits SQLite DDL, so under a PostgreSQL DATABASE_URL the dispatched schema
  // would hand a pg table to `getTableConfig` from sqlite-core and throw.
  const { runs: runsTable } = await import('../../db/schema.sqlite.js')
  const columnsOf = (table: Parameters<typeof getTableConfig>[0]) =>
    getTableConfig(table)
      .columns.map(
        (col) => `\`${col.name}\` ${col.getSQLType()}${col.primary ? ' PRIMARY KEY NOT NULL' : ''}`,
      )
      .join(', ')

  const sqlite = new Database(':memory:')
  sqlite.exec(`CREATE TABLE runs (${columnsOf(runsTable)});`)
  // The production index is part of the fixture on purpose: the lookup deliberately sorts
  // on created_at alone so this index can serve the whole ORDER BY, and the tie-break runs
  // in application code. Recreating it here keeps the test on the same query plan
  // production uses, so the tie-break assertion below cannot pass by accident of a
  // table-scan row order.
  sqlite.exec(`
    CREATE INDEX runs_agent_trigger_session_status_created_at_idx
      ON runs (initiator_agent_id, trigger_session_id, status, created_at);
  `)
  // db/transaction.ts reads isPostgres + sqliteDatabase at module load, so the mock keeps
  // them on the client's shape for anything in the graph that pulls it in.
  return {
    db: drizzle(sqlite),
    isPostgres: false,
    sqliteDatabase: sqlite,
  }
})

const { sqliteDatabase } = (await import('../../db/client.js')) as unknown as {
  sqliteDatabase: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
}
const { lookupPreviousChatId } = await import('../feishu-session-lookup.js')

const AGENT = 'agt_001'
const SESSION = 'oc_92a7d70d'
/** `mode: 'timestamp'` columns hold whole seconds. */
const seconds = (d: Date) => Math.floor(d.getTime() / 1000)
const ago = (ms: number) => new Date(Date.now() - ms)

function insertRun(run: {
  id: string
  chatId?: string
  createdAt: Date
  updatedAt: Date
  status?: string
  sessionId?: string
}) {
  sqliteDatabase
    .prepare(
      `INSERT INTO runs (id, intent, status, result, trigger_session_id, initiator_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.id,
      'feishu',
      run.status ?? 'completed',
      JSON.stringify(run.chatId ? { chatId: run.chatId } : {}),
      run.sessionId ?? SESSION,
      AGENT,
      seconds(run.createdAt),
      seconds(run.updatedAt),
    )
}

beforeEach(() => {
  sqliteDatabase.prepare('DELETE FROM runs').run()
})

describe('lookupPreviousChatId', () => {
  // Both insertion orders are asserted on purpose. Nothing in the query pins which member
  // of a created_at tie comes back first — with the composite index it tracks rowid order,
  // which simply flips between these two arrangements. Testing one arrangement would leave
  // a guard that passes even with the tie-break removed; testing both cannot.
  it.each([
    ['slow run inserted first', ['run_slow', 'run_fast']],
    ['fast run inserted first', ['run_fast', 'run_slow']],
  ])(
    'breaks a same-second created_at tie towards the run that finished last (%s)',
    async (_label, order) => {
      const startedAt = ago(10 * 60 * 1000)
      const rows: Record<string, { chatId: string; finishedAfterMs: number }> = {
        run_slow: { chatId: 'chat_stale', finishedAfterMs: 11 * 1000 },
        run_fast: { chatId: 'chat_latest', finishedAfterMs: 78 * 1000 },
      }
      for (const id of order) {
        insertRun({
          id,
          chatId: rows[id].chatId,
          createdAt: startedAt,
          updatedAt: new Date(startedAt.getTime() + rows[id].finishedAfterMs),
        })
      }

      expect(await lookupPreviousChatId(AGENT, SESSION, P2P_SESSION_TIMEOUT_MS)).toBe('chat_latest')
    },
  )

  it('returns the chatId of the most recent completed run', async () => {
    insertRun({
      id: 'run_old',
      chatId: 'chat_old',
      createdAt: ago(60 * 60 * 1000),
      updatedAt: ago(59 * 60 * 1000),
    })
    insertRun({
      id: 'run_new',
      chatId: 'chat_new',
      createdAt: ago(10 * 60 * 1000),
      updatedAt: ago(9 * 60 * 1000),
    })

    expect(await lookupPreviousChatId(AGENT, SESSION, P2P_SESSION_TIMEOUT_MS)).toBe('chat_new')
  })

  it('returns null once the last run finished longer ago than the timeout', async () => {
    const finishedAt = ago(P2P_SESSION_TIMEOUT_MS * 1.5)
    insertRun({
      id: 'run_stale',
      chatId: 'chat_stale',
      createdAt: finishedAt,
      updatedAt: finishedAt,
    })

    expect(await lookupPreviousChatId(AGENT, SESSION, P2P_SESSION_TIMEOUT_MS)).toBeNull()
    expect(await lookupPreviousChatId(AGENT, SESSION, Number.POSITIVE_INFINITY)).toBe('chat_stale')
  })

  it('returns null when the newest run recorded no chatId', async () => {
    insertRun({ id: 'run_no_chat_id', createdAt: ago(60 * 1000), updatedAt: ago(30 * 1000) })

    expect(await lookupPreviousChatId(AGENT, SESSION, P2P_SESSION_TIMEOUT_MS)).toBeNull()
  })

  it('ignores runs of another session and runs that never completed', async () => {
    insertRun({
      id: 'run_other_session',
      chatId: 'chat_other',
      createdAt: new Date(),
      updatedAt: new Date(),
      sessionId: 'oc_somewhere_else',
    })
    insertRun({
      id: 'run_running',
      chatId: 'chat_running',
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'running',
    })

    expect(await lookupPreviousChatId(AGENT, SESSION, P2P_SESSION_TIMEOUT_MS)).toBeNull()
  })

  it('returns null when the session has no runs at all', async () => {
    expect(await lookupPreviousChatId(AGENT, SESSION, P2P_SESSION_TIMEOUT_MS)).toBeNull()
  })
})
