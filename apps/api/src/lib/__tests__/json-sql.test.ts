import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it, vi } from 'vitest'
import { jsonExtractNumber, jsonExtractText } from '../json-sql.js'

// The dialect is normally derived from DATABASE_URL, so a developer whose local
// `.env` selects PostgreSQL would make these helpers emit `->>` against the real
// SQLite database below and fail on `unrecognized token: ":"`. This file asserts
// the SQLite branch specifically, so pin it rather than inherit the ambient env.
vi.mock('../../db/client.js', () => ({ isPostgres: false }))

/**
 * These helpers exist because SQLite and PostgreSQL share no JSON syntax:
 * `json_extract(col, '$.a.b')` has no PostgreSQL equivalent, and `->>` has no
 * SQLite one. Each helper emits the right form for the active dialect.
 *
 * The SQLite behaviour is pinned here against a real in-memory database — the
 * PostgreSQL side is covered by the pg integration suite, since asserting the
 * emitted string alone would not catch a query that parses but returns nothing.
 */
const rows = sqliteTable('rows', {
  id: text('id').primaryKey(),
  output: text('output', { mode: 'json' }).$type<Record<string, unknown>>(),
  n: integer('n'),
})

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE rows (id TEXT PRIMARY KEY, output TEXT, n INTEGER)')
  return { db: drizzle(sqlite, { schema: { rows } }), sqlite }
}

/**
 * The column-type invariant holds on SQLite too — the point of enforcing it in
 * the helper rather than only in the static call-site analyzer.
 *
 * It used to live inside `pgJsonSource`, behind `isPostgresRuntime()`. On the
 * default backend `json_extract` on a non-JSON column returns NULL instead of
 * raising, so the mistake was invisible exactly where most development happens,
 * and only a static analyzer stood between it and production. Static analysis of
 * a JS call site is leaky by nature (aliasing, destructuring, dynamic import),
 * which is why that analyzer needed six review rounds; the function itself sees
 * every call however it was spelled.
 */
describe('a non-JSON column is rejected on SQLite, not just on PostgreSQL', () => {
  it('throws for a column that holds no JSON, naming the column', () => {
    expect(() => jsonExtractText(rows.n, ['anything'])).toThrow(/rows\.n/)
    expect(() => jsonExtractNumber(rows.n, ['anything'])).toThrow(
      /neither a mode:'json' column nor a known plain-text JSON column/,
    )
  })

  it('still accepts a mode:json column', () => {
    expect(() => jsonExtractText(rows.output, ['usage'])).not.toThrow()
  })

  it('ignores a value that is not a drizzle column, so schema mocks still work', () => {
    // routes/__tests__/internal-admin.test.ts substitutes a table of plain
    // strings for the schema. Such a stub carries no dataType to judge, so there
    // is no defect to report — failing here would break that suite over the
    // mock's shape. The static call-site analyzer covers those sites instead.
    const notAColumn = 'runs.result' as unknown as typeof rows.output
    expect(() => jsonExtractNumber(notAColumn, ['durationMs'])).not.toThrow()
  })
})

describe('jsonExtractNumber on SQLite', () => {
  it('reads a nested numeric path', async () => {
    const { db, sqlite } = makeDb()
    sqlite
      .prepare('INSERT INTO rows (id, output) VALUES (?, ?)')
      .run('r1', JSON.stringify({ usage: { inputTokens: 42 } }))

    const [row] = db
      .select({ v: jsonExtractNumber(rows.output, ['usage', 'inputTokens']) })
      .from(rows)
      .all()

    expect(row.v).toBe(42)
  })

  it('sums across rows, which is how token stats aggregate', async () => {
    const { db, sqlite } = makeDb()
    const ins = sqlite.prepare('INSERT INTO rows (id, output) VALUES (?, ?)')
    ins.run('r1', JSON.stringify({ usage: { inputTokens: 10 } }))
    ins.run('r2', JSON.stringify({ usage: { inputTokens: 5 } }))

    const expr = jsonExtractNumber(rows.output, ['usage', 'inputTokens'])
    const [row] = db
      .select({ total: sql<number>`SUM(${expr})` })
      .from(rows)
      .all()

    expect(row.total).toBe(15)
  })

  it('yields null for a missing path rather than throwing', async () => {
    const { db, sqlite } = makeDb()
    sqlite.prepare('INSERT INTO rows (id, output) VALUES (?, ?)').run('r1', JSON.stringify({}))

    const [row] = db
      .select({ v: jsonExtractNumber(rows.output, ['usage', 'inputTokens']) })
      .from(rows)
      .all()

    expect(row.v).toBeNull()
  })

  it('yields null when the column itself is null', async () => {
    const { db, sqlite } = makeDb()
    sqlite.prepare('INSERT INTO rows (id, output) VALUES (?, NULL)').run('r1')

    const [row] = db
      .select({ v: jsonExtractNumber(rows.output, ['usage', 'inputTokens']) })
      .from(rows)
      .all()

    expect(row.v).toBeNull()
  })
})

describe('jsonExtractText on SQLite', () => {
  it('reads a top-level string path', async () => {
    const { db, sqlite } = makeDb()
    sqlite
      .prepare('INSERT INTO rows (id, output) VALUES (?, ?)')
      .run('r1', JSON.stringify({ chatId: 'oc_abc' }))

    const [row] = db
      .select({ v: jsonExtractText(rows.output, ['chatId']) })
      .from(rows)
      .all()

    expect(row.v).toBe('oc_abc')
  })

  it('compares equal to a bound parameter, as the chat-resume lookup does', async () => {
    const { db, sqlite } = makeDb()
    const ins = sqlite.prepare('INSERT INTO rows (id, output) VALUES (?, ?)')
    ins.run('r1', JSON.stringify({ chatId: 'oc_abc' }))
    ins.run('r2', JSON.stringify({ chatId: 'oc_xyz' }))

    const found = db
      .select({ id: rows.id })
      .from(rows)
      .where(sql`${jsonExtractText(rows.output, ['chatId'])} = ${'oc_xyz'}`)
      .all()

    expect(found.map((r) => r.id)).toEqual(['r2'])
  })
})
