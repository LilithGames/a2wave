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
 *
 * The scan does not try to understand TypeScript. It enforces a convention
 * narrow enough that a regex CAN follow it, and flags every departure:
 *
 *   1. json-sql may only be imported as a plain named list —
 *      `import { jsonSet, jsonExtractText } from '.../json-sql.js'`.
 *      Anything else (an `as` rename, a quoted ES2022 specifier
 *      `{ 'jsonSet' as x }`, `* as ns`, a default clause) is a finding.
 *   2. Outside that import, a helper identifier may only appear immediately
 *      invoked. Any bare appearance — rebind, destructure, type annotation,
 *      re-export, passed as a value — is a finding.
 *
 * Each rule was arrived at by inversion after individual detectors kept being
 * evaded (aliased import, local rebind, namespace destructure, type-annotated
 * rebind, quoted import alias — one per review round). The fixture suite at
 * the bottom pins every one of those shapes so the analyzer cannot regress.
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

/** Strip comments so prose naming the helpers cannot trip the scan. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * Static `import ... from '.../json-sql.js'` statements. The clause is
 * tempered to never cross a `from`, so an earlier unrelated import cannot be
 * swallowed into the match in this semicolon-free codebase.
 */
function jsonSqlImportPattern(): RegExp {
  return /import\s+((?:(?!\bfrom\b)[\s\S])*?)\s+from\s*['"][^'"]*json-sql(?:\.js)?['"]/g
}

/**
 * The one import shape the scan can follow: `{ a, b }` or `type { a }` or
 * `{ type a, b }`, every specifier a plain identifier. A quoted specifier, an
 * `as` rename, `* as ns`, or a default clause all carry a helper away under a
 * name the body scan cannot connect back to the module.
 */
function isVanillaNamedImport(clause: string): boolean {
  const named = /^(?:type\s+)?\{([\s\S]*)\}$/.exec(clause.trim())
  if (!named) return false
  const entries = named[1].split(',').map((entry) => entry.trim())
  if (entries.at(-1) === '') entries.pop() // multi-line lists carry a trailing comma
  return (
    entries.length > 0 && entries.every((entry) => /^(?:type\s+)?[A-Za-z_$][\w$]*$/.test(entry))
  )
}

interface SourceAnalysis {
  /** Usages the scan cannot follow — each one is a gate failure. */
  findings: string[]
  /** First arguments of helper calls, as resolvable `table.column` strings. */
  resolved: string[]
  /** First arguments the scan could not resolve — also gate failures. */
  unresolved: string[]
}

/** Analyze one file's source. Exercised against fixtures below, then the repo. */
function analyzeSource(rawSource: string): SourceAnalysis {
  const body = code(rawSource)
  const findings: string[] = []

  for (const match of body.matchAll(jsonSqlImportPattern())) {
    const clause = match[1].replace(/\s+/g, ' ').trim()
    if (!isVanillaNamedImport(clause)) {
      findings.push(`non-vanilla json-sql import: ${clause}`)
    }
  }

  // With the (legitimate) imports stripped, a helper identifier may only
  // appear immediately invoked. Whatever syntax carries the function value
  // away from its name, the identifier itself must first appear bare.
  const withoutImports = body.replace(jsonSqlImportPattern(), '')
  for (const helper of HELPERS) {
    const bareReference = new RegExp(`\\b${helper}\\b(?!\\s*\\()`, 'g')
    for (const _match of withoutImports.matchAll(bareReference)) {
      findings.push(`${helper} referenced without being called`)
    }
  }

  const resolved: string[] = []
  const unresolved: string[] = []
  for (const helper of HELPERS) {
    // `[^,)]+` captures whatever the first argument actually is, so a call the
    // narrow `table.column` form would miss still lands in one bucket or other.
    const call = new RegExp(`\\b${helper}\\s*\\(\\s*([^,)]+?)\\s*[,)]`, 'g')
    for (const match of withoutImports.matchAll(call)) {
      const argument = match[1].replace(/\s+/g, ' ').trim()
      if (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(argument)) resolved.push(argument)
      else unresolved.push(`${helper}(${argument})`)
    }
  }

  return { findings, resolved, unresolved }
}

describe('JSON helper call sites pass JSON-bearing columns', () => {
  const callSites = new Map<string, string[]>()
  const unresolvedSites = new Map<string, string[]>()
  const escapedUsages: string[] = []

  for (const file of walk(SRC)) {
    if (file === resolve(SRC, 'lib/json-sql.ts')) continue
    const relative = file.slice(SRC.length + 1)
    const analysis = analyzeSource(readFileSync(file, 'utf-8'))
    escapedUsages.push(...analysis.findings.map((finding) => `${relative}: ${finding}`))
    if (analysis.resolved.length) callSites.set(relative, analysis.resolved)
    if (analysis.unresolved.length) unresolvedSites.set(relative, analysis.unresolved)
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

  it('leaves no helper usage the scan cannot follow', () => {
    expect(escapedUsages).toEqual([])
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

/**
 * Every evasion shape a review round has found, pinned as a fixture. Each one
 * previously passed the then-current scan while smuggling an unchecked column
 * through; the analyzer must flag all of them, forever.
 */
describe('the analyzer itself, against every known evasion shape', () => {
  const EVASIONS: Array<[string, string]> = [
    [
      'aliased import',
      `import { jsonExtractText as extract } from '../lib/json-sql.js'
       extract(runs.status, ['x'])`,
    ],
    [
      'quoted-specifier import alias (ES2022)',
      `import { 'jsonExtractText' as extract } from '../lib/json-sql.js'
       extract(runs.status, ['x'])`,
    ],
    [
      'namespace import',
      `import * as jsonSql from '../lib/json-sql.js'
       jsonSql.jsonExtractText(runs.status, ['x'])`,
    ],
    [
      'namespace destructure',
      `import * as jsonSql from '../lib/json-sql.js'
       const { jsonExtractText: extract } = jsonSql
       extract(runs.status, ['x'])`,
    ],
    [
      'local rebind',
      `import { jsonExtractText } from '../lib/json-sql.js'
       const extract = jsonExtractText
       extract(runs.status, ['x'])`,
    ],
    [
      'type-annotated rebind',
      `import { jsonExtractText } from '../lib/json-sql.js'
       const extract: typeof jsonExtractText = jsonExtractText
       extract(runs.status, ['x'])`,
    ],
    ['renamed re-export', `export { jsonExtractText as extract } from '../lib/json-sql.js'`],
    [
      'dynamic-import destructure',
      `const { jsonExtractText: extract } = await import('../lib/json-sql.js')
       extract(runs.status, ['x'])`,
    ],
    [
      'passed as a value',
      `import { jsonExtractText } from '../lib/json-sql.js'
       columns.map(jsonExtractText)`,
    ],
  ]

  for (const [name, source] of EVASIONS) {
    it(`flags: ${name}`, () => {
      expect(analyzeSource(source).findings).not.toEqual([])
    })
  }

  it('passes the vanilla shape and resolves its column', () => {
    const analysis = analyzeSource(
      `import { jsonExtractText } from '../lib/json-sql.js'
       jsonExtractText(runs.result, ['durationMs'])`,
    )
    expect(analysis.findings).toEqual([])
    expect(analysis.unresolved).toEqual([])
    expect(analysis.resolved).toEqual(['runs.result'])
  })

  it('passes a multi-line vanilla import with type specifiers and a trailing comma', () => {
    const analysis = analyzeSource(
      `import {
         type jsonSet,
         jsonExtractText,
       } from '../lib/json-sql.js'
       jsonExtractText(runs.result, ['durationMs'])`,
    )
    expect(analysis.findings).toEqual([])
  })

  it('does not swallow an unrelated preceding import into the clause', () => {
    // The clause pattern must stop at `from`; in this semicolon-free codebase a
    // greedy match would otherwise span from an earlier import statement and
    // misreport its text as a malformed json-sql clause.
    const analysis = analyzeSource(
      `import { eq } from 'drizzle-orm'
       import { jsonExtractText } from '../lib/json-sql.js'
       jsonExtractText(runs.result, ['durationMs'])`,
    )
    expect(analysis.findings).toEqual([])
  })
})
