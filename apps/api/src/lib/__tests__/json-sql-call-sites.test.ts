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

/**
 * Collect the first argument of every JSON-helper call, split into the
 * `table.column` references this scan can resolve and everything it cannot.
 *
 * The unresolved bucket is the point. A scan that only matched `table.column`
 * and ignored the rest would silently pass a call whose column arrives as a
 * local variable or through an aliased import — reporting green for code it
 * never actually checked. Surfacing those instead forces them to be made
 * resolvable (or explicitly acknowledged), so "no offenders" means "nothing
 * unchecked" rather than "nothing recognised".
 */
function collectColumnArguments(source: string): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = []
  const unresolved: string[] = []
  for (const helper of HELPERS) {
    // `[^,)]+` captures whatever the first argument actually is, so a call the
    // narrow `table.column` form would miss still lands in one bucket or other.
    const call = new RegExp(`\\b${helper}\\s*\\(\\s*([^,)]+?)\\s*[,)]`, 'g')
    for (const match of source.matchAll(call)) {
      const argument = match[1].replace(/\s+/g, ' ').trim()
      if (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(argument)) resolved.push(argument)
      else unresolved.push(`${helper}(${argument})`)
    }
  }
  return { resolved, unresolved }
}

describe('JSON helper call sites pass JSON-bearing columns', () => {
  const callSites = new Map<string, string[]>()
  const unresolvedSites = new Map<string, string[]>()
  const aliasedImports: string[] = []

  for (const file of walk(SRC)) {
    if (file === resolve(SRC, 'lib/json-sql.ts')) continue
    const body = code(readFileSync(file, 'utf-8'))
    const relative = file.slice(SRC.length + 1)

    // Any rebinding of a helper to another name renames the call and would slip
    // past a scan keyed on the original names, so treat it as a finding rather
    // than letting the call go unexamined. Two forms: an aliased import
    // (`jsonExtractText as extract`) and a local rebind (`const extract =
    // jsonExtractText`), including destructuring off a namespace import.
    for (const helper of HELPERS) {
      const renamedImport = new RegExp(`\\b${helper}\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'g')
      for (const match of body.matchAll(renamedImport)) {
        aliasedImports.push(`${relative}: ${helper} imported as ${match[1]}`)
      }

      // `= jsonExtractText` with no call parenthesis: the function itself is
      // being passed around rather than invoked here.
      const rebind = new RegExp(
        `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[\\w$.]*\\b${helper}\\b\\s*(?!\\()`,
        'g',
      )
      for (const match of body.matchAll(rebind)) {
        aliasedImports.push(`${relative}: ${helper} rebound as ${match[1]}`)
      }
    }

    const { resolved, unresolved } = collectColumnArguments(body)
    if (resolved.length) callSites.set(relative, resolved)
    if (unresolved.length) unresolvedSites.set(relative, unresolved)
  }

  it('finds the known call sites, so a broken scan cannot pass vacuously', () => {
    const all = [...callSites.values()].flat()
    // Pinned to the exact current count, not a floor. A floor of 10 stayed green
    // while calls silently dropped out of view — which is the failure this file
    // guards against. Adding or removing a call site is expected to update this
    // number deliberately.
    expect(all).toHaveLength(14)
    // The column this whole suite exists for must be among them.
    expect(all).toContain('a2aTasks.data')
  })

  it('leaves no helper call whose column argument it could not resolve', () => {
    // A silent skip here is the failure mode: it reads as "checked and clean"
    // for a call site the scan never inspected. If this trips, either write the
    // argument as a direct `table.column` or extend the resolver deliberately.
    expect(
      [...unresolvedSites].flatMap(([file, calls]) => calls.map((c) => `${file}: ${c}`)),
    ).toEqual([])
  })

  it('leaves no aliased helper import that would rename a call out of view', () => {
    expect(aliasedImports).toEqual([])
  })

  it('resolves every column argument to a json column or an allowed text one', () => {
    const offenders: string[] = []

    for (const [file, columns] of callSites) {
      for (const reference of columns) {
        const [tableName, columnName] = reference.split('.')
        const table = (schema as Record<string, unknown>)[tableName] as
          | Record<string, { dataType?: string }>
          | undefined
        // Not a schema table (e.g. a locally-built drizzle fragment). Recorded
        // rather than skipped, so the scan cannot quietly ignore a call site.
        if (!table) {
          offenders.push(`${file}: ${reference} does not resolve to a schema table`)
          continue
        }
        const column = table[columnName]
        if (!column?.dataType) {
          offenders.push(`${file}: ${reference} is not a column of that table`)
          continue
        }

        if (column.dataType === 'json') continue
        if (ALLOWED_PLAIN_TEXT.has(reference)) continue
        offenders.push(`${file}: ${reference} is ${column.dataType}, not json`)
      }
    }

    expect(offenders).toEqual([])
  })
})
