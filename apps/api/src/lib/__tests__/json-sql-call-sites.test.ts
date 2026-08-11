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
 * ## Why this uses the TypeScript compiler rather than a regex
 *
 * Earlier revisions scanned the source text. Five review rounds each found a
 * new way past it — aliased import, local rebind, namespace destructure,
 * type-annotated rebind, quoted ES2022 specifier — and every fix was another
 * pattern chasing another syntax form. Two defects then landed that no amount
 * of pattern-tightening could reach:
 *
 *   const runs = { result: users.email }   // local shadowing: the text says
 *   jsonExtractText(runs.result, ['x'])    // `runs.result`, the symbol is
 *                                          // users.email (a non-JSON column)
 *
 *   jsonExtractBoolean(runs.status, [...]) // a helper absent from a hand-kept
 *                                          // list is simply invisible
 *
 * The first is a scoping question and the second an export-inventory question;
 * text matching answers neither. So the analysis is now symbol-based: the
 * helper set is derived from what `json-sql.ts` actually exports, and each
 * column argument is resolved to the declaration it really refers to. Shadowing
 * and renaming stop being special cases — a renamed binding resolves to the
 * same symbol, and a shadowed one resolves to the local declaration, which is
 * not a schema column and is reported.
 */
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as schema from '../../db/schema.sqlite.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const API_ROOT = resolve(__dirname, '../../..')
const SRC = resolve(API_ROOT, 'src')
const JSON_SQL = resolve(SRC, 'lib/json-sql.ts')

/** Plain-text columns that legitimately hold hand-serialised JSON. */
const ALLOWED_PLAIN_TEXT = new Set(['a2aTasks.data'])

/**
 * Helpers whose first parameter is a column and whose second is a JSON path.
 * Everything `json-sql.ts` exports is expected to have that shape; a future
 * export that does not must be added here deliberately, and the inventory
 * assertion below fails until it is.
 */
const NON_COLUMN_EXPORTS = new Set<string>()

interface Finding {
  file: string
  message: string
}

interface Analysis {
  /** Helper names derived from the module's real exports. */
  helpers: string[]
  /** Usages the analyzer refuses to vouch for. */
  findings: Finding[]
  /** `table.column` references resolved back to their true declarations. */
  resolved: Array<{ file: string; table: string; column: string }>
}

let cachedOptions: ts.CompilerOptions | undefined
let cachedFileNames: string[] | undefined

function tsconfig(): { options: ts.CompilerOptions; fileNames: string[] } {
  if (!cachedOptions || !cachedFileNames) {
    const configPath = resolve(API_ROOT, 'tsconfig.json')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, API_ROOT)
    cachedOptions = parsed.options
    cachedFileNames = parsed.fileNames
  }
  return { options: cachedOptions, fileNames: cachedFileNames }
}

/**
 * Build a program. The repo-wide pass needs every file; a fixture only needs
 * itself plus the modules it imports, which the compiler pulls in transitively
 * — passing all ~350 roots per fixture made this suite take 38s instead of 6s.
 */
function createProgram(
  extraFiles: Record<string, string> = {},
  scope: 'project' | 'fixture' = 'project',
): {
  program: ts.Program
  checker: ts.TypeChecker
} {
  const parsed = tsconfig()

  const rootNames =
    scope === 'fixture'
      ? Object.keys(extraFiles)
      : [...parsed.fileNames, ...Object.keys(extraFiles)]
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true }
  const host = ts.createCompilerHost(options, true)

  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const injected = extraFiles[fileName]
    if (injected !== undefined) {
      return ts.createSourceFile(fileName, injected, languageVersion, true)
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreate)
  }
  const originalFileExists = host.fileExists.bind(host)
  host.fileExists = (fileName) => fileName in extraFiles || originalFileExists(fileName)
  const originalReadFile = host.readFile.bind(host)
  host.readFile = (fileName) => extraFiles[fileName] ?? originalReadFile(fileName)

  const program = ts.createProgram(rootNames, options, host)
  return { program, checker: program.getTypeChecker() }
}

/** The column-taking helpers `json-sql.ts` actually exports. */
function deriveHelpers(program: ts.Program, checker: ts.TypeChecker): string[] {
  const source = program.getSourceFile(JSON_SQL)
  if (!source) throw new Error(`json-sql.ts not in program: ${JSON_SQL}`)
  const moduleSymbol = checker.getSymbolAtLocation(source)
  if (!moduleSymbol) throw new Error('json-sql.ts exports no module symbol')

  return checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol) => symbol.getName())
    .filter((name) => !NON_COLUMN_EXPORTS.has(name))
    .sort()
}

/** The symbol a name ultimately refers to, following imports and aliases. */
function resolveSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node)
  if (!symbol) return undefined
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
}

/** Is this symbol one of the json-sql helpers, however it was named locally? */
function helperNameOf(
  checker: ts.TypeChecker,
  node: ts.Node,
  helperSymbols: Map<ts.Symbol, string>,
): string | undefined {
  const symbol = resolveSymbol(checker, node)
  return symbol ? helperSymbols.get(symbol) : undefined
}

/**
 * Walk every source file, resolving helper calls and their column arguments
 * through the checker rather than through their spelling.
 */
function analyze(program: ts.Program, checker: ts.TypeChecker, files: ts.SourceFile[]): Analysis {
  const helpers = deriveHelpers(program, checker)

  const jsonSqlSource = program.getSourceFile(JSON_SQL)
  const moduleSymbol = jsonSqlSource ? checker.getSymbolAtLocation(jsonSqlSource) : undefined
  const helperSymbols = new Map<ts.Symbol, string>()
  if (moduleSymbol) {
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const name = symbol.getName()
      if (helpers.includes(name)) {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
        helperSymbols.set(target, name)
      }
    }
  }

  const findings: Finding[] = []
  const resolved: Analysis['resolved'] = []

  for (const source of files) {
    const file = relative(SRC, source.fileName)

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name
          : node.expression
        const helper = ts.isIdentifier(callee)
          ? helperNameOf(checker, callee, helperSymbols)
          : undefined

        if (helper) {
          const argument = node.arguments[0]
          if (!argument) {
            findings.push({ file, message: `${helper}() called with no column argument` })
          } else if (
            ts.isPropertyAccessExpression(argument) &&
            ts.isIdentifier(argument.expression)
          ) {
            // Resolve the TABLE identifier to its declaration. A local
            // `const runs = {...}` resolves to that variable, not to the schema
            // table, which is exactly the shadowing case text matching missed.
            const tableSymbol = resolveSymbol(checker, argument.expression)
            const declaration = tableSymbol?.declarations?.[0]
            const declaredIn = declaration?.getSourceFile().fileName ?? ''
            const isSchemaTable = /db[\\/]schema(\.sqlite|\.pg)?\.ts$/.test(declaredIn)

            if (!isSchemaTable) {
              findings.push({
                file,
                message: `${helper}(${argument.expression.text}.${argument.name.text}) — ${argument.expression.text} is not a schema table (declared in ${relative(SRC, declaredIn) || 'an unknown location'})`,
              })
            } else {
              resolved.push({
                file,
                table: argument.expression.text,
                column: argument.name.text,
              })
            }
          } else {
            findings.push({
              file,
              message: `${helper}(${argument.getText()}) — first argument is not a direct table.column reference`,
            })
          }
        }
      }

      // `await import('.../json-sql.js')` hands back the module as a runtime
      // value. Whatever is destructured off it is a fresh local binding, not an
      // alias of the export, so symbol resolution has nothing to follow and the
      // helper becomes invisible — the one hole the checker cannot close by
      // resolution alone. Reject the dynamic import itself: this module is only
      // ever imported statically, so there is nothing legitimate to lose.
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        /json-sql(\.js)?$/.test(node.arguments[0].text)
      ) {
        findings.push({
          file,
          message:
            'json-sql imported dynamically; import it statically so call sites stay resolvable',
        })
      }

      // A helper referenced anywhere other than as the callee of a call is a
      // value escaping into code this analyzer stops tracking.
      if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
        const helper = helperNameOf(checker, node, helperSymbols)
        const isCallee = ts.isCallExpression(node.parent) && node.parent.expression === node
        const isPropertyCallee =
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node &&
          ts.isCallExpression(node.parent.parent) &&
          node.parent.parent.expression === node.parent
        if (helper && !isCallee && !isPropertyCallee) {
          findings.push({ file, message: `${helper} referenced without being called` })
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(source)
  }

  return { helpers, findings, resolved }
}

const { program, checker } = createProgram()
const projectFiles = program
  .getSourceFiles()
  .filter(
    (source) =>
      !source.isDeclarationFile &&
      source.fileName.startsWith(`${SRC}/`) &&
      source.fileName !== JSON_SQL &&
      !source.fileName.includes('/__tests__/'),
  )
const analysis = analyze(program, checker, projectFiles)

describe('the helper inventory is derived, not hand-maintained', () => {
  it('matches what json-sql.ts actually exports', () => {
    // A new export is picked up automatically. This assertion exists so that
    // adding one is a deliberate act: it fails until the list is updated, which
    // is the moment to confirm the new helper really takes (column, path).
    expect(analysis.helpers).toEqual([
      'jsonArrayContainsKeyValue',
      'jsonExtractNumber',
      'jsonExtractText',
      'jsonPathIsAbsent',
      'jsonSet',
    ])
  })

  it('scans a meaningful number of files, so a broken walk cannot pass vacuously', () => {
    expect(projectFiles.length).toBeGreaterThan(100)
  })
})

describe('JSON helper call sites pass JSON-bearing columns', () => {
  it('finds the known call sites, so a broken scan cannot pass vacuously', () => {
    expect(analysis.resolved).toHaveLength(14)
    // The column this whole suite exists for must be among them.
    expect(analysis.resolved.map((r) => `${r.table}.${r.column}`)).toContain('a2aTasks.data')
  })

  it('leaves no helper usage the analyzer cannot vouch for', () => {
    expect(analysis.findings.map((f) => `${f.file}: ${f.message}`)).toEqual([])
  })

  it('resolves every column argument to a json column or an allowed text one', () => {
    const offenders: string[] = []

    for (const { file, table, column } of analysis.resolved) {
      const tableObject = (schema as Record<string, unknown>)[table] as
        | Record<string, { dataType?: string }>
        | undefined
      if (!tableObject) {
        offenders.push(`${file}: ${table}.${column} does not resolve to a schema table`)
        continue
      }
      const columnObject = tableObject[column]
      if (!columnObject?.dataType) {
        offenders.push(`${file}: ${table}.${column} is not a column of that table`)
        continue
      }

      if (columnObject.dataType === 'json') continue
      if (ALLOWED_PLAIN_TEXT.has(`${table}.${column}`)) continue
      offenders.push(`${file}: ${table}.${column} is ${columnObject.dataType}, not json`)
    }

    expect(offenders).toEqual([])
  })
})

/**
 * Every evasion shape a review round has found, pinned as a fixture. Each one
 * previously passed the then-current scan while smuggling an unchecked column
 * through, so the analyzer must keep flagging all of them.
 *
 * These are type-checked as real program files, which is what lets the last
 * two — local shadowing and an undeclared helper — be caught at all.
 */
describe('the analyzer itself, against every known evasion shape', () => {
  const analyzeFixture = (body: string) => {
    const fileName = resolve(SRC, 'routes/__fixture__.ts')
    const preamble = `import { runs, users, runSteps } from '../db/schema.js'\nvoid runs; void users; void runSteps;\n`
    const { program: fixtureProgram, checker: fixtureChecker } = createProgram(
      { [fileName]: preamble + body },
      'fixture',
    )
    const source = fixtureProgram.getSourceFile(fileName)
    if (!source) throw new Error('fixture not in program')
    return analyze(fixtureProgram, fixtureChecker, [source])
  }

  const EVASIONS: Array<[string, string]> = [
    [
      'aliased import',
      `import { jsonExtractText as extract } from '../lib/json-sql.js'
       extract(runs.status, ['x'])`,
    ],
    [
      'quoted-specifier import alias (ES2022)',
      `import { 'jsonExtractText' as extract2 } from '../lib/json-sql.js'
       extract2(runs.status, ['x'])`,
    ],
    [
      'namespace import',
      `import * as jsonSql from '../lib/json-sql.js'
       jsonSql.jsonExtractText(runs.status, ['x'])`,
    ],
    [
      'namespace destructure',
      `import * as jsonSql from '../lib/json-sql.js'
       const { jsonExtractText: extract3 } = jsonSql
       extract3(runs.status, ['x'])`,
    ],
    [
      'local rebind',
      `import { jsonExtractText } from '../lib/json-sql.js'
       const extract4 = jsonExtractText
       extract4(runs.status, ['x'])`,
    ],
    [
      'type-annotated rebind',
      `import { jsonExtractText } from '../lib/json-sql.js'
       const extract5: typeof jsonExtractText = jsonExtractText
       extract5(runs.status, ['x'])`,
    ],
    [
      'passed as a value',
      `import { jsonExtractText } from '../lib/json-sql.js'
       const fns = [jsonExtractText]
       void fns`,
    ],
    [
      'dynamic-import destructure',
      `const { jsonExtractText: extract6 } = await import('../lib/json-sql.js')
       extract6(users.email, ['x'])`,
    ],
    [
      'dynamic import inside a function, awaited',
      `async function unsafe() {
         const { jsonExtractText } = await import('../lib/json-sql.js')
         return jsonExtractText(users.email, ['x'])
       }
       void unsafe`,
    ],
    [
      'local shadowing of a schema table',
      `import { jsonExtractText } from '../lib/json-sql.js'
       const shadowed = { result: users.email }
       jsonExtractText(shadowed.result, ['x'])`,
    ],
    [
      'column argument that is not a direct table.column',
      `import { jsonExtractText } from '../lib/json-sql.js'
       const col = runs.result
       jsonExtractText(col, ['x'])`,
    ],
  ]

  for (const [name, source] of EVASIONS) {
    it(`flags: ${name}`, () => {
      const result = analyzeFixture(source)
      // Either the analyzer refuses to vouch for the usage, or it resolved the
      // call through the rename and surfaced the real (non-JSON) column for the
      // schema assertion to reject. Both are detections; silence is not.
      const surfacedBadColumn = result.resolved.some((r) =>
        ['runs.status', 'users.email'].includes(`${r.table}.${r.column}`),
      )
      expect(result.findings.length > 0 || surfacedBadColumn).toBe(true)
    })
  }

  it('passes the vanilla shape and resolves its column to the real table', () => {
    const result = analyzeFixture(
      `import { jsonExtractText } from '../lib/json-sql.js'
       jsonExtractText(runs.result, ['durationMs'])`,
    )
    expect(result.findings).toEqual([])
    expect(result.resolved.map((r) => `${r.table}.${r.column}`)).toEqual(['runs.result'])
  })

  it('sees through a rename to the same underlying column', () => {
    // A renamed *table* import is legitimate: the symbol still resolves to the
    // schema declaration, so the analyzer follows it rather than flagging it.
    const result = analyzeFixture(
      `import { jsonExtractText } from '../lib/json-sql.js'
       import { runSteps as steps } from '../db/schema.js'
       jsonExtractText(steps.output, ['usage'])`,
    )
    expect(result.findings).toEqual([])
    expect(result.resolved.map((r) => `${r.table}.${r.column}`)).toEqual(['steps.output'])
  })
})
