/**
 * Source-to-source translation of the SQLite schema into its PostgreSQL twin.
 *
 * The alternative — a hand-written `schema.pg.ts` sitting beside `schema.ts` —
 * loses to drift. `schema.ts` is edited on nearly every feature; a parallel file
 * only *usually* gets the same edit, and the miss surfaces as a production-only
 * failure on the backend fewer developers run locally. Generating instead makes
 * divergence impossible by construction, and puts the translation rules
 * themselves under test (see `__tests__/schema-transform.test.ts`).
 *
 * Everything emitted must be valid on **PostgreSQL 9.6**: `jsonb`, `timestamptz`,
 * partial indexes and `ON CONFLICT` all predate 9.6, so the mapping below stays
 * inside that floor.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Schema locations, kept here rather than in `scripts/` so the parity test can
 * import them: `scripts/` sits outside tsconfig's `rootDir`, and importing
 * across that boundary fails typecheck.
 */
export const SQLITE_SCHEMA_PATH = path.join(__dirname, 'schema.sqlite.ts')
export const PG_SCHEMA_PATH = path.join(__dirname, 'schema.pg.ts')

const BANNER = `// ============================================================
// GENERATED FILE — DO NOT EDIT.
//
// Produced from ./schema.sqlite.ts by scripts/generate-pg-schema.ts.
// Edit schema.sqlite.ts and re-run \`pnpm db:generate:pg\`; a manual edit here is
// overwritten on the next generation.
// ============================================================
`

/** pg-core builders this translation can introduce, in the order drizzle imports them. */
const PG_BUILDERS = [
  'bigint',
  'boolean',
  'index',
  'integer',
  'jsonb',
  'primaryKey',
  'text',
  'timestamp',
  'uniqueIndex',
] as const

/**
 * Timestamps become `timestamptz`, in **date mode**.
 *
 * Two separate decisions, both load-bearing:
 *
 * `withTimezone` — SQLite stores an absolute epoch, so the value carries no zone
 * ambiguity. A naive `timestamp` in PG would reinterpret that instant against
 * whatever `TimeZone` the session happens to have, shifting every stored time by
 * the server's offset — the classic silent corruption in a sqlite→pg port.
 *
 * `mode: 'date'` — drizzle's pg timestamp otherwise defaults to `mode: 'string'`,
 * which changes the type the app reads back (SQLite's timestamp mode yields
 * `Date`) and, worse, serialises a bound `Date` as an epoch string. PostgreSQL
 * then rejects every timestamp comparison with "date/time field value out of
 * range" — which is how this was found: the run-queue's `created_at < cutoff`
 * sweep failed against a real 9.6 server.
 */
function mapTimestampColumns(source: string): string {
  return source.replace(
    /integer\((\s*'[^']+')\s*,\s*\{\s*mode:\s*'timestamp(?:_ms)?'\s*\}\s*\)/g,
    (_m, name) => `timestamp(${name}, { withTimezone: true, mode: 'date' })`,
  )
}

/**
 * Plain integer columns whose values do not fit PostgreSQL's 32-bit `integer`.
 *
 * SQLite's INTEGER is 64-bit, so none of these ever overflowed there. On
 * PostgreSQL the write is rejected outright ("value ... is out of range for type
 * integer") — found by saving an A2A task, whose `created_at` is `Date.now()`.
 *
 * Matched by column name because the SQLite declaration carries no width: the
 * distinction lives in what the application stores, not in the type.
 */
const WIDE_INTEGER_COLUMNS = new Set([
  // Epoch milliseconds (~1.79e12 today) — these are raw Date.now() values, not
  // timestamp-mode columns, so they are stored and read back as numbers.
  'created_at',
  'updated_at',
  // Byte counts: a single 2GB+ artifact or KB file overflows 32 bits.
  'file_size',
  'size',
  // Cumulative token counters, which only ever grow.
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  // Durations in milliseconds pass 32 bits after ~24.8 days.
  'duration_ms',
  'wait_ms',
])

/**
 * Widen the columns above to `bigint`.
 *
 * `mode: 'number'` keeps the TypeScript type as `number` (rather than `bigint`),
 * so no call site has to change. Values here stay far below 2^53, where that
 * would start losing precision.
 */
function mapWideIntegerColumns(source: string): string {
  return source.replace(/\binteger\((\s*'([^']+)')\s*\)/g, (match, quoted, name) => {
    if (!WIDE_INTEGER_COLUMNS.has(name)) return match
    return `bigint(${quoted}, { mode: 'number' })`
  })
}

/** `integer(..., { mode: 'boolean' })` → a real `boolean` column. */
function mapBooleanColumns(source: string): string {
  return source.replace(
    /integer\((\s*'[^']+')\s*,\s*\{\s*mode:\s*'boolean'\s*\}\s*\)/g,
    (_m, name) => `boolean(${name})`,
  )
}

/**
 * `text(..., { mode: 'json' })` → `jsonb`.
 *
 * jsonb rather than json: the app already runs containment/extraction queries
 * over these columns (run results, step output), and only jsonb can be indexed
 * or read with the operators those queries need.
 */
function mapJsonColumns(source: string): string {
  return source.replace(
    /text\((\s*'[^']+')\s*,\s*\{\s*mode:\s*'json'\s*\}\s*\)/g,
    (_m, name) => `jsonb(${name})`,
  )
}

/**
 * `.default(sql`'{}'`)` is a SQLite string literal. Under jsonb the driver
 * serialises a JS value directly, so the quoted form would store the two-character
 * string `{}` instead of an empty object.
 */
function mapJsonDefaults(source: string): string {
  return source
    .replace(/\.default\(sql`'\{\}'`\)/g, '.default({})')
    .replace(/\.default\(sql`'\[\]'`\)/g, '.default([])')
}

/** Table constructor + column type references. */
function mapIdentifiers(source: string): string {
  return source
    .replace(/\bsqliteTable\b/g, 'pgTable')
    .replace(/\bSQLiteColumn\b/g, 'PgColumn')
    .replace(/\bSQLiteTable\b/g, 'PgTable')
}

/**
 * Rewrite the drizzle import specifier and widen the named-import list to cover
 * the builders introduced above. Builders are only added when the transformed
 * body actually references them, so the generated file does not carry unused
 * imports that biome would flag.
 */
function rewriteImports(source: string, transformedBody: string): string {
  return source.replace(
    /import(\s+type)?\s*\{([^}]*)\}\s*from\s*'drizzle-orm\/sqlite-core'/g,
    (_match, typeOnly: string | undefined, names: string) => {
      const existing = names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => (n === 'sqliteTable' ? 'pgTable' : n === 'SQLiteColumn' ? 'PgColumn' : n))

      const needed = typeOnly
        ? existing
        : [
            ...new Set([
              ...existing,
              ...PG_BUILDERS.filter((b) => new RegExp(`\\b${b}\\(`).test(transformedBody)),
              ...(/\bpgTable\(/.test(transformedBody) ? ['pgTable'] : []),
            ]),
          ]

      const sorted = [...new Set(needed)].sort((a, b) => a.localeCompare(b))
      return `import${typeOnly ?? ''} { ${sorted.join(', ')} } from 'drizzle-orm/pg-core'`
    },
  )
}

/**
 * Translate SQLite schema source into PostgreSQL schema source.
 *
 * Exported (rather than inlined into the generator script) so the mapping rules
 * are unit-testable without touching the filesystem.
 */
export function transformSqliteSchemaToPg(source: string): string {
  let out = source
  out = mapTimestampColumns(out)
  out = mapBooleanColumns(out)
  // After timestamp/boolean mapping: those consume the mode-carrying integer()
  // forms first, so what remains for widening is only the plain ones.
  out = mapWideIntegerColumns(out)
  out = mapJsonColumns(out)
  out = mapJsonDefaults(out)
  out = mapIdentifiers(out)
  out = rewriteImports(out, out)
  return `${BANNER}${out}`
}

/**
 * Run the translated source through biome.
 *
 * Without this the generator and the linter disagree: biome would reformat the
 * checked-in file after generation, and the parity test — which compares that
 * file against a fresh in-memory render — would fail on whitespace alone.
 * Formatting here makes "generated" and "formatted" the same state.
 */
function formatWithBiome(source: string): string {
  return execFileSync('npx', ['biome', 'format', '--stdin-file-path=schema.pg.ts'], {
    cwd: path.resolve(__dirname, '..', '..'),
    input: source,
    encoding: 'utf-8',
  })
}

/** The exact bytes `schema.pg.ts` should contain for the current `schema.ts`. */
export function renderPgSchema(): string {
  return formatWithBiome(transformSqliteSchemaToPg(readFileSync(SQLITE_SCHEMA_PATH, 'utf-8')))
}
