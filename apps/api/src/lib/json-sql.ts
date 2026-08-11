import { type SQL, getTableName, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { isPostgresRuntime } from '../db/dialect-runtime.js'

/**
 * Dialect-neutral JSON access.
 *
 * SQLite and PostgreSQL share no JSON syntax at all: `json_extract(col, '$.a.b')`
 * does not exist on PostgreSQL, and `col->'a'->>'b'` does not exist on SQLite.
 * Every JSON-reading query therefore has to be built through these helpers
 * rather than written inline, or it silently works on one backend only.
 *
 * A note on storage: a column declared `text(..., { mode: 'json' })` is `text`
 * under SQLite and `jsonb` under PostgreSQL (see db/schema-transform.ts). The
 * PostgreSQL operators below are the jsonb ones, which is exactly why that
 * mapping was chosen.
 *
 * That mapping keys off `mode: 'json'` and nothing else, so it is **not** true
 * that every JSON-holding column is jsonb on PostgreSQL. A column whose JSON is
 * serialised by hand is declared plain `text` and stays `text` on both dialects
 * — `a2a_tasks.data` is exactly that (a2a/sqlite-task-store.ts does its own
 * JSON.stringify/JSON.parse). Assuming otherwise is what made `tasks/list` fail
 * with `42883 operator does not exist: text -> unknown` on every PostgreSQL
 * deployment. The helpers below handle it via `pgJsonSource`; an inline
 * `->`/`->>` written at a call site would not, and no gate catches that
 * (no-raw-sqlite-json-sql.test.ts scans for the SQLite-only functions only).
 * So: route JSON access through these helpers, and do not assume the column
 * arrived as jsonb.
 *
 * All operators used here predate PostgreSQL 9.6 (`->`/`->>` arrived in 9.3),
 * so nothing here breaks the supported floor.
 */

/** A JSON object path, e.g. `['usage', 'inputTokens']`. */
type JsonPath = readonly [string, ...string[]]

/**
 * Plain-text columns that legitimately hold JSON, as `table.column`.
 *
 * Deliberately an allowlist rather than "cast anything that is not json". A
 * blanket cast also swallows the case these helpers should never see — a
 * genuinely non-JSON column passed by mistake, say `runs.status`. Pre-cast that
 * failed at PostgreSQL's parse stage with `42883 operator does not exist`,
 * naming the operator before a single row was read. Cast blindly it instead
 * plans fine and fails per-row with `22P02 invalid input syntax for type json`,
 * pointing at the value rather than the mistake — and on an empty table it does
 * not fail at all, silently returning no rows so a mis-wired predicate reads as
 * "nothing matched" instead of a bug.
 *
 * Naming the columns keeps the loud, early failure for a real mistake while
 * still fixing the columns that need it.
 */
const PLAIN_TEXT_JSON_COLUMNS: ReadonlySet<string> = new Set([
  // a2a/sqlite-task-store.ts serialises and parses this envelope by hand
  // (`encodeTask` returns a string, `JSON.parse(row.data)` reads one back)
  // instead of letting drizzle do it, so it carries no `mode: 'json'` and stays
  // `text` on both dialects while `list()` filters on paths inside it.
  'a2a_tasks.data',
])

/**
 * The PostgreSQL operators used below (`->`, `->>`, `?`, `@>`, `jsonb_set`) are
 * defined for json/jsonb only. A `mode: 'json'` column is already `jsonb` via
 * db/schema-transform.ts and needs nothing; a plain-text JSON column must be
 * cast, or the statement dies with `42883 operator does not exist: text ->
 * unknown` — which is exactly how every A2A `tasks/list` call failed on
 * PostgreSQL.
 *
 * Throws for a column that is neither, since that is a call-site error no cast
 * can rescue: it fails at query-build time, in-process and with the column
 * named, rather than reaching the server as a confusing per-row data error.
 */
function pgJsonSource(column: SQLiteColumn): SQL {
  if (column.dataType === 'json') return sql`${column}`

  const qualifiedName = `${getTableName(column.table)}.${column.name}`
  if (PLAIN_TEXT_JSON_COLUMNS.has(qualifiedName)) return sql`(${column})::jsonb`

  throw new Error(
    `json-sql: ${qualifiedName} is neither a mode:'json' column nor a known plain-text JSON column. Declare it as text(..., { mode: 'json' }), or add it to PLAIN_TEXT_JSON_COLUMNS if it holds hand-serialised JSON.`,
  )
}

/**
 * Build the PostgreSQL accessor chain: every segment but the last uses `->`
 * (which yields jsonb, so it can be chained), and the final one uses `->>`
 * (which yields text, so it can be cast or compared).
 */
function pgAccessor(column: SQLiteColumn, path: JsonPath): SQL {
  const parents = path.slice(0, -1)
  const leaf = path[path.length - 1]
  let expr = pgJsonSource(column)
  for (const segment of parents) {
    expr = sql`${expr} -> ${segment}`
  }
  return sql`${expr} ->> ${leaf}`
}

/** SQLite's single-call path form, e.g. `$.usage.inputTokens`. */
function sqlitePath(path: JsonPath): string {
  return `$.${path.join('.')}`
}

/**
 * Extract a JSON value as a **number**.
 *
 * The PostgreSQL branch casts explicitly: `->>` always returns text, so without
 * the cast `SUM()` over it would fail rather than add. Missing paths yield NULL
 * on both backends, which is what the token-usage aggregates rely on to treat an
 * absent figure as "not recorded" instead of zero.
 */
export function jsonExtractNumber(column: SQLiteColumn, path: JsonPath): SQL<number | null> {
  if (isPostgresRuntime()) {
    return sql<number | null>`(${pgAccessor(column, path)})::numeric`
  }
  return sql<number | null>`json_extract(${column}, ${sqlitePath(path)})`
}

/** Extract a JSON value as **text**, for equality comparisons against an id. */
export function jsonExtractText(column: SQLiteColumn, path: JsonPath): SQL<string | null> {
  if (isPostgresRuntime()) {
    return sql<string | null>`${pgAccessor(column, path)}`
  }
  return sql<string | null>`json_extract(${column}, ${sqlitePath(path)})`
}

/**
 * True when a JSON **array** at `arrayPath` contains an element whose
 * `elementKey` equals `value` — "is this provider referenced anywhere in the
 * agent's provider chain?".
 *
 * The two dialects diverge entirely here. SQLite iterates with the table-valued
 * `json_each`; PostgreSQL has no such function, and instead answers with a
 * containment check (`@>`) against a synthesised array — which is both simpler
 * and index-friendly. `@>` on jsonb predates 9.6.
 */
export function jsonArrayContainsKeyValue(
  column: SQLiteColumn,
  arrayPath: JsonPath,
  elementKey: string,
  value: string,
): SQL {
  if (isPostgresRuntime()) {
    let target = pgJsonSource(column)
    for (const segment of arrayPath) {
      target = sql`${target} -> ${segment}`
    }
    const probe = JSON.stringify([{ [elementKey]: value }])
    return sql`(${target}) @> ${probe}::jsonb`
  }
  return sql`EXISTS (
    SELECT 1
    FROM json_each(${column}, ${sqlitePath(arrayPath)}) AS chain_element
    WHERE json_extract(chain_element.value, ${`$.${elementKey}`}) = ${value}
  )`
}

/**
 * Set a JSON path to `value`, treating a NULL column as an empty object.
 *
 * `jsonb_set` predates the 9.6 floor (it arrived in 9.5). Both branches take the
 * value as a bound parameter rather than interpolating it, so a string inside
 * the payload cannot terminate the literal.
 */
export function jsonSet(column: SQLiteColumn, path: JsonPath, value: unknown): SQL {
  const serialized = JSON.stringify(value)
  if (isPostgresRuntime()) {
    return sql`jsonb_set(COALESCE(${pgJsonSource(column)}, '{}'::jsonb), ${`{${path.join(',')}}`}, ${serialized}::jsonb, true)`
  }
  return sql`json_set(COALESCE(${column}, '{}'), ${sqlitePath(path)}, json(${serialized}))`
}

/**
 * True when the JSON path is absent — the idempotency guard for token
 * accounting, which must claim a step's usage slot exactly once.
 *
 * SQLite answers with `json_type(...) IS NULL`; PostgreSQL with a containment
 * check on the key. Both distinguish "key missing" from "key present but null".
 */
export function jsonPathIsAbsent(column: SQLiteColumn, path: JsonPath): SQL {
  if (isPostgresRuntime()) {
    const leaf = path[path.length - 1]
    let parent = pgJsonSource(column)
    for (const segment of path.slice(0, -1)) {
      parent = sql`${parent} -> ${segment}`
    }
    // The whole disjunction MUST be parenthesised. drizzle's `and()` wraps only
    // the outermost expression, not each operand, so a bare `A OR B` here binds
    // as `(other AND A) OR B` — SQL gives AND higher precedence. That silently
    // dropped the `stepId` predicate from the usage-recording UPDATE, so
    // `jsonb_set` rewrote every run_steps row that lacked a `usage` key.
    return sql`((${parent}) IS NULL OR NOT ((${parent}) ? ${leaf}))`
  }
  return sql`json_type(${column}, ${sqlitePath(path)}) IS NULL`
}
