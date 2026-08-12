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
 * A segment is rejected only when SQLite would read it as something other than
 * a literal key — the set is defined by SQLite's path grammar, not by a
 * conservative allowlist.
 *
 * PostgreSQL binds every segment as a parameter, so it is always literal. On
 * SQLite the path arrives as one `$.a.b` string, where an unquoted label runs
 * until the next `.` or `[`, a *leading* `"` opens a quoted label, and an empty
 * label is invalid. Exactly four shapes therefore diverge — each verified
 * against the bundled better-sqlite3:
 *
 *   contains '.'   `$.a.b`  descends a -> b     (PG: the literal key "a.b")
 *   contains '['   `$.a[0]` indexes an array    (PG: the literal key "a[0]")
 *   leading '"'    `$."ab`  "bad JSON path"     (PG: the literal key '"ab')
 *   empty          `$.`     "bad JSON path"     (PG: the empty key)
 *   contains NUL   `$.a\0b` reads the key "a"   (PG: cannot represent the key)
 *
 * The NUL case is the quietest of the five and the only one that returns a
 * *wrong row* rather than an error. SQLite's path is a C string, so it truncates
 * at the first NUL: verified against the bundled better-sqlite3, `$.a\0b` on
 * `{"a":1,"a\0b":3}` returns `1` — the value of a different key. A trailing NUL
 * degrades the same way (`ab\0` reads `ab`), and a leading one throws.
 *
 * PostgreSQL does not read that key either: jsonb stores unescaped text, and
 * a NUL has no text representation, so a key containing one fails to cast with
 * `22P05 unsupported Unicode escape sequence` (verified on PostgreSQL 14).
 * Rejecting the segment is therefore right on both backends — an earlier
 * revision of this comment claimed PostgreSQL bound it as a literal key, which
 * is wrong.
 *
 * Everything else — commas, spaces, unicode, leading digits, hyphens, colons,
 * `$`, `#`, `]`, backslashes, interior or trailing quotes — round-trips as the
 * same literal key on both engines, so it is allowed. An earlier revision
 * rejected all of those too; that mislabelled dialect-consistent keys as
 * divergent and made the helpers refuse paths both backends agree on.
 */
function isDialectDivergentSegment(segment: string): boolean {
  return (
    segment.length === 0 ||
    segment.includes('.') ||
    segment.includes('[') ||
    segment.includes('\0') ||
    segment.startsWith('"')
  )
}

function assertSafePath(path: readonly string[], helper: string): void {
  for (const segment of path) {
    if (isDialectDivergentSegment(segment)) {
      throw new Error(
        `json-sql: ${helper} received the path segment ${JSON.stringify(segment)}, which SQLite reads as path syntax ('.'/'[' descend, a leading '"' opens a quoted label, a NUL truncates the key, an empty label is invalid) while PostgreSQL binds it as a literal key — the two backends would address different data.`,
      )
    }
  }
}

/**
 * `jsonSet` accepts a **single** segment only — the two dialects disagree on
 * anything deeper. Verified on PostgreSQL 14 against SQLite:
 *
 *   PG      jsonb_set('{}', '{a,b}', '1', true)  ->  {}
 *   SQLite  json_set('{}', '$.a.b', json('1'))   ->  {"a":{"b":1}}
 *
 * `jsonb_set` refuses to create a missing intermediate parent and returns the
 * document untouched, so a nested write would silently no-op on PostgreSQL
 * while succeeding on SQLite — the same "works on the backend you run locally"
 * trap this module exists to close. Narrowing the type makes the divergence
 * unreachable rather than merely documented.
 */
type JsonSetPath = readonly [string]

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
 * The physical table a column belongs to, seeing through `alias()`.
 *
 * `getTableName` reports the *alias* — `alias(a2aTasks, 'task_alias')` yields
 * `task_alias` — which would miss the allowlist above and reject the very
 * column it exists to permit. `alias()` is already used in this codebase
 * (lib/agent-access.ts), so a self-join or subquery over a2a_tasks is a live
 * shape rather than a hypothetical one. drizzle keeps the underlying name on
 * the table under a globally-registered symbol; fall back to the alias if a
 * future version stops populating it, since a wrong-but-present name only
 * costs a clearer error while a crash here would break query building.
 */
function physicalTableName(column: SQLiteColumn): string {
  const original = (column.table as unknown as Record<symbol, unknown>)[
    Symbol.for('drizzle:OriginalName')
  ]
  return typeof original === 'string' ? original : getTableName(column.table)
}

/**
 * Reject a column that does not hold JSON — on **both** dialects.
 *
 * This check is dialect-independent on purpose. It used to live only inside
 * `pgJsonSource`, i.e. behind `isPostgresRuntime()`, which made the invariant
 * true on PostgreSQL and merely *hoped for* on SQLite: `json_extract` on a
 * non-JSON column returns NULL instead of raising, so a developer running the
 * default backend saw a silently empty result and shipped it.
 *
 * Closing that gap in the compiler was what the call-site analyzer existed for,
 * and why it needed six rounds of review — a static checker has to recognise
 * every syntactic route to a call, while the function itself sees every call by
 * construction. Enforcing it here makes the analyzer a second line of defence
 * (it reports the mistake at `pnpm test` rather than at query-build time)
 * instead of the only one.
 *
 * A value that is not a drizzle column carries no `dataType` to judge, so there
 * is nothing to validate and it passes. That is what unit tests substituting a
 * table of plain strings for the schema (routes/__tests__/internal-admin.test.ts)
 * pass in; rejecting those would fail the suite over the *mock's* shape rather
 * than over a real defect. Those call sites are not left unchecked — the
 * call-site analyzer resolves them against the true schema, which is precisely
 * the split of duties: the runtime guard catches what reaches it, the analyzer
 * catches what the types say.
 */
function assertJsonBearingColumn(column: SQLiteColumn, helper: string): void {
  if (typeof column?.dataType !== 'string') return
  if (column.dataType === 'json') return
  if (PLAIN_TEXT_JSON_COLUMNS.has(`${physicalTableName(column)}.${column.name}`)) return

  throw new Error(
    `json-sql: ${helper} received ${physicalTableName(column)}.${column.name}, which is neither a mode:'json' column nor a known plain-text JSON column. Declare it as text(..., { mode: 'json' }), or add it to PLAIN_TEXT_JSON_COLUMNS if it holds hand-serialised JSON.`,
  )
}

/**
 * The jsonb left-hand side for the PostgreSQL branch.
 *
 * The operators used below (`->`, `->>`, `?`, `@>`, `jsonb_set`) are defined for
 * json/jsonb only. A `mode: 'json'` column is already `jsonb` via
 * db/schema-transform.ts and needs nothing; a plain-text JSON column must be
 * cast, or the statement dies with `42883 operator does not exist: text ->
 * unknown` — which is exactly how every A2A `tasks/list` call failed on
 * PostgreSQL.
 *
 * The cast here is unconditional because `assertJsonBearingColumn` has already
 * run: anything reaching this point is either jsonb or an allowlisted plain-text
 * JSON column, so there is no third case left to reject.
 */
function pgJsonSource(column: SQLiteColumn): SQL {
  if (column.dataType === 'json') return sql`${column}`
  return sql`(${column})::jsonb`
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
  assertJsonBearingColumn(column, 'jsonExtractNumber')
  assertSafePath(path, 'jsonExtractNumber')
  if (isPostgresRuntime()) {
    return sql<number | null>`(${pgAccessor(column, path)})::numeric`
  }
  return sql<number | null>`json_extract(${column}, ${sqlitePath(path)})`
}

/** Extract a JSON value as **text**, for equality comparisons against an id. */
export function jsonExtractText(column: SQLiteColumn, path: JsonPath): SQL<string | null> {
  assertJsonBearingColumn(column, 'jsonExtractText')
  assertSafePath(path, 'jsonExtractText')
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
  assertJsonBearingColumn(column, 'jsonArrayContainsKeyValue')
  assertSafePath(arrayPath, 'jsonArrayContainsKeyValue')
  // `elementKey` is interpolated into SQLite's `$.${elementKey}` path exactly
  // like a segment, so it carries the same ambiguity and gets the same check.
  assertSafePath([elementKey], 'jsonArrayContainsKeyValue')
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
 * Set a top-level JSON key to `value`, treating a NULL column as an empty
 * object. Single-segment only — see `JsonSetPath` for why anything deeper is a
 * dialect divergence rather than a feature.
 *
 * `jsonb_set` predates the 9.6 floor (it arrived in 9.5). Both branches take the
 * value as a bound parameter rather than interpolating it, so a string inside
 * the payload cannot terminate the literal.
 */
export function jsonSet(column: SQLiteColumn, path: JsonSetPath, value: unknown): SQL {
  // The type already forbids this; the runtime check covers a path built
  // dynamically (`string[]` widened at a call site), where the compiler cannot.
  if (path.length !== 1) {
    throw new Error(
      `json-sql: jsonSet takes a single-segment path, got [${path.join(', ')}]. PostgreSQL's jsonb_set will not create a missing intermediate parent, so a nested write silently no-ops there while succeeding on SQLite.`,
    )
  }
  assertJsonBearingColumn(column, 'jsonSet')
  assertSafePath(path, 'jsonSet')
  const serialized = JSON.stringify(value)
  if (isPostgresRuntime()) {
    // `ARRAY[$n]`, not a `'{seg}'` literal. Building the path as text makes the
    // segment's *content* structural: a key containing a comma — `['a,b']` —
    // parses as the nested path a->b, which jsonb_set then no-ops on because
    // `a` is absent (verified on PostgreSQL 14), while SQLite writes the single
    // key "a,b". Binding a one-element array keeps the segment a value.
    return sql`jsonb_set(COALESCE(${pgJsonSource(column)}, '{}'::jsonb), ARRAY[${path[0]}], ${serialized}::jsonb, true)`
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
  assertJsonBearingColumn(column, 'jsonPathIsAbsent')
  assertSafePath(path, 'jsonPathIsAbsent')
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
