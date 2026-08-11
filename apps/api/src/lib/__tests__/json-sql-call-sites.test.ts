/**
 * Every column passed to a JSON helper must actually hold JSON — checked on
 * both dialects, from the real call sites.
 *
 * `pgJsonSource`'s guard throws for a column that is neither `mode: 'json'` nor
 * a known plain-text JSON column, but it sits behind `isPostgresRuntime()`.
 * SQLite is the supported default, so a developer who never runs PostgreSQL
 * locally would pass a mistyped column, see `json_extract` quietly return NULL,
 * and ship it — the failure surfacing only on the backend fewer people run.
 * That is the same shape as the bug this suite exists for.
 *
 * So rather than trust the runtime guard alone, this walks the actual call
 * sites, resolves each column argument against the schema, and asserts it is
 * JSON-bearing. Static because it must hold regardless of which dialect the
 * developer's DATABASE_URL happens to select.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as schema from '../../db/schema.sqlite.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../..')

const HELPERS = [
  'jsonExtractNumber',
  'jsonExtractText',
  'jsonArrayContainsKeyValue',
  'jsonSet',
  'jsonPathIsAbsent',
]

/** Plain-text columns that legitimately hold hand-serialised JSON. */
const ALLOWED_PLAIN_TEXT = new Set(['a2aTasks.data'])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      yield* walk(full)
      continue
    }
    if (entry.endsWith('.ts')) yield full
  }
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** Collect `table.column` first arguments passed to any JSON helper. */
function collectColumnArguments(source: string): string[] {
  const found: string[] = []
  for (const helper of HELPERS) {
    const call = new RegExp(`\\b${helper}\\s*\\(\\s*([A-Za-z_$][\\w$]*\\.[A-Za-z_$][\\w$]*)`, 'g')
    for (const match of source.matchAll(call)) found.push(match[1])
  }
  return found
}

describe('JSON helper call sites pass JSON-bearing columns', () => {
  const callSites = new Map<string, string[]>()
  for (const file of walk(SRC)) {
    if (file === resolve(SRC, 'lib/json-sql.ts')) continue
    const columns = collectColumnArguments(code(readFileSync(file, 'utf-8')))
    if (columns.length) callSites.set(file.slice(SRC.length + 1), columns)
  }

  it('finds the known call sites, so a broken scan cannot pass vacuously', () => {
    const all = [...callSites.values()].flat()
    expect(all.length).toBeGreaterThanOrEqual(10)
    // The column this whole suite exists for must be among them.
    expect(all).toContain('a2aTasks.data')
  })

  it('resolves every column argument to a json column or an allowed text one', () => {
    const offenders: string[] = []

    for (const [file, columns] of callSites) {
      for (const reference of columns) {
        const [tableName, columnName] = reference.split('.')
        const table = (schema as Record<string, unknown>)[tableName] as
          | Record<string, { dataType?: string }>
          | undefined
        // An unresolvable name means a local alias, not a schema table; the
        // real schema tables are what this guard is about.
        if (!table) continue
        const column = table[columnName]
        if (!column?.dataType) continue

        if (column.dataType === 'json') continue
        if (ALLOWED_PLAIN_TEXT.has(reference)) continue
        offenders.push(`${file}: ${reference} is ${column.dataType}, not json`)
      }
    }

    expect(offenders).toEqual([])
  })
})
