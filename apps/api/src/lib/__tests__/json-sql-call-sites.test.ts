/**
 * Every column passed to a JSON helper must actually hold JSON — checked on
 * both dialects, from the real call sites.
 *
 * ## This is the second line of defence, not the only one
 *
 * The column-type invariant is enforced at runtime by `assertJsonBearingColumn`
 * inside json-sql.ts, on **both** dialects. That guard sees every call however
 * it was spelled, so no aliasing or destructuring evades it — which is why the
 * check belongs there and why this file no longer carries the whole burden.
 *
 * It still earns its place for the reason a runtime guard cannot cover: a guard
 * only fires on a path that actually executes, and api coverage is ~82%, not
 * 100%. A mistyped column on an untested branch would reach production with the
 * runtime check never having run. This analyzer reads the code instead of
 * running it, so it covers the branches tests do not — and it reports at
 * `pnpm test` rather than at query-build time in production.
 *
 * The two layers answer different questions, so keep both: the guard catches
 * what reaches it, this catches what the types say.
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
 *
 * ## Ask what a thing *is*, never how it was written
 *
 * Moving to the checker was not by itself enough, because the first version
 * still asked the *forward* question — "which syntactic route produced this
 * binding?" — and answered it with one branch per route: named destructure,
 * then quoted, then shorthand, then computed. That direction is unbounded, so
 * each review round legitimately found a shape the last had not enumerated.
 *
 * Two inversions ended it. `helperNameOf` asks `getTypeAtLocation` what a
 * binding *is*, so every destructuring form collapses into one check; and
 * `staticStringValue` reads a string-literal *type*, so `as const`, `satisfies`
 * and constant-folded concatenation need no cases of their own.
 *
 * The rule this file is now built on: **resolve by identity, and fail closed
 * when identity cannot be established.** An unresolvable specifier that could
 * name json-sql is reported rather than ignored — silence used to mean "the
 * analyzer failed", which read identically to "the code is safe". If a future
 * round finds another evasion, the fix is another inversion, not another branch.
 */
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as schema from '../../db/schema.sqlite.js'
import { jsonExtractText } from '../json-sql.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const API_ROOT = resolve(__dirname, '../../..')
const SRC = resolve(API_ROOT, 'src')
const JSON_SQL = resolve(SRC, 'lib/json-sql.ts')

/**
 * Plain-text columns that legitimately hold hand-serialised JSON, as
 * `tsTableName.tsColumnName`.
 *
 * This mirrors `PLAIN_TEXT_JSON_COLUMNS` in json-sql.ts, which is keyed by
 * PHYSICAL name (`a2a_tasks.data`) because that is what a drizzle column
 * reports at runtime, while the analyzer only ever sees the TypeScript
 * identifiers. The two lists therefore cannot be one constant.
 *
 * They are pinned to each other instead: the assertion below resolves every
 * entry here through the real schema and fails if the physical name it maps to
 * is missing from the runtime list, so adding a column to one and not the other
 * is caught rather than silently diverging.
 */
const ALLOWED_PLAIN_TEXT = new Set(['a2aTasks.data'])

/**
 * Files with a reviewed dynamic import whose specifier cannot be proven static.
 *
 * An explicit list of *locations*, deliberately not a rule about code shape.
 * Two attempts to exempt a shape were both wrong in the same way — a `.js` tail
 * and a `file://` head each constrained one fragment of the specifier while the
 * interpolated part stayed free to name json-sql. A fragment cannot prove the
 * whole, so shape-based exemption is abandoned entirely.
 *
 * Each entry is `<file>::<specifier source text>`, so it pins the ONE import
 * that was reviewed rather than the file it lives in. Keying by file alone
 * would exempt any dynamic import added to that file later — the allowlist
 * would widen with no diff to the allowlist itself, which is precisely the
 * silent-broadening this list exists to prevent.
 *
 * Adding an entry means confirming by hand that the import cannot reach
 * json-sql, and it shows up in review when it changes.
 *
 * `lib/cli-installer.ts` loads `install.mjs` by absolute resolved path — a
 * script that ships beside the CLI lock, not a module in this source tree.
 */
const DYNAMIC_IMPORT_ALLOWLIST = new Set(['lib/cli-installer.ts::`file://${path}`'])

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
      ? [...Object.keys(extraFiles), JSON_SQL]
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

/**
 * Is this identifier inside a type annotation, rather than a runtime value?
 *
 * `type Extractor = typeof jsonExtractText` and `const f: typeof jsonExtractText`
 * both mention a helper in a position that is erased at compile time, so neither
 * is a value escaping the analyzer's view.
 */
function isInTypePosition(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isTypeAliasDeclaration(current)) return true
    // A `typeof x` type query is a type node, but its argument is an
    // EntityName rather than a TypeNode, so check the query itself.
    if (ts.isTypeQueryNode(current)) return true
    if (ts.isSourceFile(current) || ts.isBlock(current)) return false
  }
  return false
}

/**
 * The `key` half of `const { key: local } = ns` — the property being read, not
 * the binding being created. The binding is reported on its own, so counting
 * this too would double-report one escape.
 */
function isPropertyNameOfBinding(node: ts.Node): boolean {
  return ts.isBindingElement(node.parent) && node.parent.propertyName === node
}

/**
 * Is this identifier one of the json-sql helpers, however it was named locally?
 *
 * Resolution is by **symbol first, then type identity** — deliberately not by
 * walking the syntax that produced the binding.
 *
 * Every earlier revision asked the forward question: "which syntactic route led
 * from the export to this name?" — and answered it with one branch per route
 * (named destructure, then quoted destructure, then shorthand, then computed…).
 * That direction is unbounded, because TypeScript keeps offering new spellings
 * for "take a value out of a module", so each review round legitimately found a
 * shape the previous round had not enumerated. `getTypeAtLocation` asks the
 * inverse, shape-free question instead: *what is this thing?* A binding produced
 * by any destructuring form still has the helper's own function type, so all of
 * those routes collapse into one check that no new syntax can sidestep.
 *
 * Type identity is sound here because each helper's type is its unique
 * declaration — `jsonExtractText` and `jsonExtractNumber` differ in return type,
 * and nothing else in the program declares a function assignable to either by
 * identity. It is compared by the type object's own identity, not structurally,
 * so an unrelated `(c, p) => SQL` does not collide.
 *
 * Type identity alone is not quite enough, because a use site can be given a
 * *different* type object than the declaration:
 *
 *   const { jsonExtractText: extract }: { jsonExtractText: Extractor } = jsonSql
 *
 * The annotation supplies a fresh `Extractor` type, so the binding is neither
 * the export symbol nor the declaration's type object. Provenance closes it: ask
 * what object the binding was destructured *from*, and look the property up
 * there. That is still not syntax-enumeration — it is one more identity
 * question, asked of the source rather than the binding.
 */
function helperNameOf(
  checker: ts.TypeChecker,
  node: ts.Node,
  helperSymbols: Map<ts.Symbol, string>,
  helperTypes: Map<ts.Type, string>,
): string | undefined {
  const symbol = resolveSymbol(checker, node)
  if (symbol) {
    const direct = helperSymbols.get(symbol)
    if (direct) return direct
  }

  // Provenance BEFORE type identity. A binding whose value demonstrably came
  // out of the json-sql module is the helper; a binding that merely shares its
  // type is not.
  const byProvenance = helperNameByProvenance(checker, symbol, helperSymbols, helperTypes)
  if (byProvenance) return byProvenance

  // Type identity is the last resort, and it is skipped only where the
  // declaration itself already ASSIGNS a value — that assignment is the real
  // provenance, and it did not come from json-sql.
  //
  // `const fake: typeof jsonExtractText = (c, p) => ...` shares the helper's
  // exact type object while holding an unrelated local function, so deciding by
  // type alone reported it as the helper escaping. Type identity proves what a
  // value LOOKS like, never where it CAME FROM.
  //
  // The exclusion is deliberately narrow. An earlier revision skipped every
  // declaration that was not a BindingElement, which also silenced parameters,
  // loop variables and object-literal shorthand — a `f: typeof jsonExtractText`
  // parameter became completely invisible, and passing a non-JSON column
  // through it produced no finding at all. Those bind a value supplied
  // elsewhere rather than asserting one here, so the checker's type is the best
  // evidence available and is worth acting on.
  const declaration = symbol?.valueDeclaration
  const declaresItsOwnValue =
    declaration &&
    (ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration)) &&
    Boolean(declaration.initializer)
  if (declaresItsOwnValue) return undefined

  return helperTypes.get(checker.getTypeAtLocation(node))
}

/**
 * Look through `as T`, `satisfies T`, `<T>x`, parentheses and `!`.
 *
 * These change what the checker *says* a value is without changing what it is,
 * so any question about provenance has to be asked of the operand underneath.
 */
function unwrapAssertions(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/**
 * Resolve a destructured binding through the object it came from.
 *
 * `const { jsonExtractText: extract }: {...} = jsonSql` creates a local symbol
 * whose declaration is a BindingElement. Reading the property off the
 * *initializer's* type — the namespace, whose properties are the real export
 * aliases — recovers the helper even when an annotation has replaced the
 * binding's own type.
 *
 * The initializer is unwrapped through assertions first. `jsonSql as { ... }`
 * substitutes a structural type whose properties are plain members of that type
 * literal, not the export aliases, so reading the property off the *asserted*
 * type recovers nothing. Looking through to the operand asks the question of the
 * namespace itself, which is what actually determines where the value came from.
 */
function helperNameByProvenance(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  helperSymbols: Map<ts.Symbol, string>,
  helperTypes: Map<ts.Type, string>,
): string | undefined {
  const declaration = symbol?.valueDeclaration
  if (!declaration || !ts.isBindingElement(declaration)) return undefined

  // The property read: `{ key: local }` uses propertyName, `{ key }` uses name.
  const key = declaration.propertyName ?? declaration.name
  if (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return undefined

  const pattern = declaration.parent
  if (!ts.isObjectBindingPattern(pattern)) return undefined
  const variable = pattern.parent
  if (!ts.isVariableDeclaration(variable) || !variable.initializer) return undefined

  const property = checker.getPropertyOfType(
    checker.getTypeAtLocation(unwrapAssertions(variable.initializer)),
    key.text,
  )
  if (!property) return undefined

  const target =
    property.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(property) : property
  const bySymbol = helperSymbols.get(target)
  if (bySymbol) return bySymbol

  const valueDeclaration = target.valueDeclaration
  return valueDeclaration
    ? helperTypes.get(checker.getTypeOfSymbolAtLocation(target, valueDeclaration))
    : undefined
}

/**
 * The compile-time value of a string expression, or `undefined` when it cannot
 * be proven.
 *
 * This asks the checker for the type and reads a string-literal type off it,
 * rather than pattern-matching the expression. `as const`, `satisfies`,
 * parentheses, a `const` alias chain and constant-folded concatenation all
 * produce a string-literal *type*, so one question covers every form — the same
 * inversion `helperNameOf` makes, for the same reason: enumerating expression
 * shapes is unbounded, asking what the value is is not.
 *
 * The literal-type route also fixes a false positive the syntactic version
 * caused: `const key = 'jsonExtractText' as const` used in `jsonSql[key](...)`
 * was unresolvable, so a legitimate call was reported as a dynamic key.
 */
function staticStringValue(checker: ts.TypeChecker, node: ts.Expression): string | undefined {
  const type = checker.getTypeAtLocation(node)
  const literal = type.isStringLiteral()
    ? type
    : // A `satisfies`/widened position can yield a union of one literal.
      type.isUnion() && type.types.length === 1 && type.types[0]?.isStringLiteral()
      ? (type.types[0] as ts.StringLiteralType)
      : undefined
  return literal?.value
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
  // Keyed by the checker's own type object, so lookup is identity-based: a
  // structurally similar but unrelated function is a different type object and
  // does not match.
  const helperTypes = new Map<ts.Type, string>()
  if (moduleSymbol) {
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const name = symbol.getName()
      if (helpers.includes(name)) {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
        helperSymbols.set(target, name)
        const declaration = target.valueDeclaration
        if (declaration) {
          helperTypes.set(checker.getTypeOfSymbolAtLocation(target, declaration), name)
        }
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
        const elementAccess = ts.isElementAccessExpression(node.expression)
          ? node.expression
          : undefined
        const elementKey = elementAccess
          ? staticStringValue(checker, elementAccess.argumentExpression)
          : undefined
        const elementNamespaceType = elementAccess
          ? checker.getTypeAtLocation(elementAccess.expression)
          : undefined
        // "Does this object carry a helper?" is asked by SYMBOL, then by TYPE.
        // Symbol alone missed a structural copy of the namespace — `const bag:
        // { [K in keyof typeof jsonSql]: (typeof jsonSql)[K] } = jsonSql` has
        // the same callable members, but a mapped type's properties are fresh
        // symbols rather than export aliases, so `bag[k](...)` looked like an
        // ordinary object and the dynamic-key finding never fired.
        const namespacePropertyHelper = (property: ts.Symbol): string | undefined => {
          const target =
            property.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(property) : property
          const bySymbol = helperSymbols.get(target)
          if (bySymbol) return bySymbol
          // `getTypeOfSymbol`, not `getTypeOfSymbolAtLocation`: a mapped type's
          // property is synthesised and has NO valueDeclaration, so asking for a
          // type "at" a declaration finds nothing and the copy stays invisible.
          return helperTypes.get(checker.getTypeOfSymbol(target))
        }
        const isJsonSqlNamespace = Boolean(
          elementNamespaceType
            ?.getProperties()
            .some((property) => namespacePropertyHelper(property)),
        )
        const helper = ts.isIdentifier(callee)
          ? helperNameOf(checker, callee, helperSymbols, helperTypes)
          : elementAccess && elementKey && elementNamespaceType
            ? (() => {
                const property = checker.getPropertyOfType(elementNamespaceType, elementKey)
                return property ? namespacePropertyHelper(property) : undefined
              })()
            : undefined

        if (elementAccess && isJsonSqlNamespace && !elementKey) {
          findings.push({
            file,
            message:
              'json-sql namespace called with a dynamically computed property; use a statically resolvable helper name',
          })
        }

        if (helper) {
          const argument = node.arguments[0]
          if (!argument) {
            findings.push({ file, message: `${helper}() called with no column argument` })
          } else if (ts.isPropertyAccessExpression(argument)) {
            // Resolve the TABLE expression to its declaration. A local
            // `const runs = {...}` resolves to that variable, not to the schema
            // table, which is exactly the shadowing case text matching missed.
            //
            // The table half is an arbitrary expression, not necessarily an
            // Identifier: `schema.runSteps.output` reaches a real json column
            // through a namespace, and requiring an Identifier here rejected it
            // for its *spelling* while the symbol proved it correct. Resolve the
            // expression and let the declaration decide, which is the same
            // inversion the rest of this file is built on.
            const tableSymbol = resolveSymbol(checker, argument.expression)
            const declaration = tableSymbol?.declarations?.[0]
            const declaredIn = declaration?.getSourceFile().fileName ?? ''
            const isSchemaTable = /db[\\/]schema(\.sqlite|\.pg)?\.ts$/.test(declaredIn)

            if (!isSchemaTable) {
              findings.push({
                file,
                message: `${helper}(${argument.getText()}) — ${argument.expression.getText()} is not a schema table (declared in ${relative(SRC, declaredIn) || 'an unknown location'})`,
              })
            } else {
              // Record the CANONICAL export name, not the local spelling. The
              // schema assertion below looks the table up in the real schema
              // module, so `import { runSteps as steps }` must be stored as
              // `runSteps` — storing `steps` would report the legitimate alias
              // as "not a schema table" and fail the gate on correct code.
              resolved.push({
                file,
                table: tableSymbol?.getName() ?? argument.expression.getText(),
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
        node.arguments[0]
      ) {
        const specifier = staticStringValue(checker, node.arguments[0])
        const importSite = `${file}::${node.arguments[0].getText()}`
        if (specifier === undefined && !DYNAMIC_IMPORT_ALLOWLIST.has(importSite)) {
          // Fail closed, with NO exemptions. Treating "unresolvable" as "not
          // json-sql" is what let `'../lib/' + 'json-sql.js'` through: the check
          // passed because the *analyzer* failed, not because the code was safe.
          //
          // Two attempts to carve out an exemption were both wrong in the same
          // way — `../lib/${part}.js` (a `.js` tail) and `file://${target}` (a
          // `file://` head) each constrained one fragment while the substitution
          // stayed free to name json-sql. A fragment of a specifier cannot prove
          // the whole, so no shape is exempt.
          findings.push({
            file,
            message:
              'dynamic import whose specifier is not statically resolvable; use a literal specifier so the target can be checked',
          })
        } else if (specifier !== undefined && /json-sql(\.js)?$/.test(specifier)) {
          findings.push({
            file,
            message:
              'json-sql imported dynamically; import it statically so call sites stay resolvable',
          })
        }
      }

      // A helper referenced anywhere other than as the callee of a call is a
      // value escaping into code this analyzer stops tracking. With type-based
      // resolution this is also what catches every destructuring form: the new
      // binding is an identifier carrying the helper's type, so it is reported
      // here at the point it is created, whatever syntax created it.
      //
      // Type positions are excluded. `type Extractor = typeof jsonExtractText`
      // names the helper's type without ever holding the function at runtime, so
      // it cannot smuggle a column past anything and is not an escape.
      if (
        ts.isIdentifier(node) &&
        !ts.isImportSpecifier(node.parent) &&
        !isInTypePosition(node) &&
        !isPropertyNameOfBinding(node)
      ) {
        const helper = helperNameOf(checker, node, helperSymbols, helperTypes)
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
    // A floor, not an exact count. The point is that the walk actually reached
    // the codebase; pinning the precise number made every unrelated commit that
    // added a legitimate JSON query fail here with "expected 15 to be 14",
    // which names neither the new call site nor what to do about it.
    expect(analysis.resolved.length).toBeGreaterThanOrEqual(14)
    // The column this whole suite exists for must be among them.
    expect(analysis.resolved.map((r) => `${r.table}.${r.column}`)).toContain('a2aTasks.data')
  })

  it('keeps the plain-text allowlist in step with the one json-sql.ts enforces', () => {
    // This list is keyed by TS name and json-sql.ts's by physical name, so they
    // cannot be one constant. Pin them: every entry here must resolve to a real
    // column that the RUNTIME guard also accepts, which is what stops the two
    // from drifting apart unnoticed.
    for (const entry of ALLOWED_PLAIN_TEXT) {
      const [table, column] = entry.split('.')
      const tableObject = (schema as Record<string, unknown>)[table as string] as
        | Record<string, { name?: string; dataType?: string }>
        | undefined
      const columnObject = tableObject?.[column as string]
      expect(columnObject, `${entry} should resolve in the schema module`).toBeDefined()

      // A mode:'json' column would not need the allowlist at all.
      expect(columnObject?.dataType).not.toBe('json')

      // The runtime guard must accept it, or the analyzer permits a column the
      // helpers themselves would throw on.
      expect(() =>
        jsonExtractText(columnObject as unknown as SQLiteColumn, ['probe']),
      ).not.toThrow()
    }
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
      'namespace bracket access',
      `import * as jsonSql from '../lib/json-sql.js'
       jsonSql['jsonExtractText'](users.email, ['x'])`,
    ],
    [
      'namespace bracket access through a static key',
      `import * as jsonSql from '../lib/json-sql.js'
       const key = 'jsonExtractText'
       jsonSql[key](users.email, ['x'])`,
    ],
    [
      'namespace bracket access through a runtime key',
      `import * as jsonSql from '../lib/json-sql.js'
       declare const key: keyof typeof jsonSql
       jsonSql[key](users.email, ['x'])`,
    ],
    [
      'namespace destructure',
      `import * as jsonSql from '../lib/json-sql.js'
       const { jsonExtractText: extract3 } = jsonSql
       extract3(runs.status, ['x'])`,
    ],
    [
      'quoted namespace destructure',
      `import * as jsonSql from '../lib/json-sql.js'
       const { 'jsonExtractText': extract4 } = jsonSql
       extract4(users.email, ['x'])`,
    ],
    [
      'shorthand namespace destructure',
      `import * as jsonSql from '../lib/json-sql.js'
       const { jsonExtractText } = jsonSql
       jsonExtractText(users.email, ['x'])`,
    ],
    [
      'computed namespace destructure',
      `import * as jsonSql from '../lib/json-sql.js'
       const key = 'jsonExtractText'
       const { [key]: extract8 } = jsonSql
       extract8(users.email, ['x'])`,
    ],
    [
      'dynamic import through an as-const specifier',
      `const specifier = '../lib/json-sql.js' as const
       const { jsonExtractText: extract9 } = await import(specifier)
       extract9(users.email, ['x'])`,
    ],
    [
      'dynamic import through a satisfies specifier',
      `const specifier = '../lib/json-sql.js' satisfies string
       const { jsonExtractText: extract10 } = await import(specifier)
       extract10(users.email, ['x'])`,
    ],
    [
      'dynamic import through a widened interpolation with a static tail',
      `const part: string = 'json-sql'
       const { jsonExtractText: extract12 } = await import(\`../lib/\${part}.js\`)
       extract12(users.email, ['x'])`,
    ],
    [
      'contextually typed namespace destructure',
      `import type { SQL } from 'drizzle-orm'
       import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
       import * as jsonSql from '../lib/json-sql.js'
       type Extractor = (c: SQLiteColumn, p: readonly [string, ...string[]]) => SQL<string | null>
       const { jsonExtractText: extract13 }: { jsonExtractText: Extractor } = jsonSql
       extract13(users.email, ['x'])`,
    ],
    [
      'dynamic import through a file:// interpolation',
      `declare const target: string
       const { jsonExtractText: extract14 } = await import(\`file://\${target}\`)
       extract14(users.email, ['x'])`,
    ],
    [
      'structural type assertion erasing provenance',
      `import type { SQL } from 'drizzle-orm'
       import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
       import * as jsonSql from '../lib/json-sql.js'
       type Extractor = (c: SQLiteColumn, p: readonly [string, ...string[]]) => SQL<string | null>
       const { jsonExtractText: extract15 } = jsonSql as { jsonExtractText: Extractor }
       extract15(users.email, ['x'])`,
    ],
    [
      'helper reached through a typed parameter',
      `import type { jsonExtractText } from '../lib/json-sql.js'
       export function go(f: typeof jsonExtractText) {
         return f(users.email, ['x'])
       }`,
    ],
    [
      'helper reached through a typed class-method parameter',
      `import type { jsonExtractText } from '../lib/json-sql.js'
       export class Q {
         run(f: typeof jsonExtractText) {
           return f(users.email, ['x'])
         }
       }`,
    ],
    [
      'helper reached through a loop variable',
      `import type { jsonExtractText } from '../lib/json-sql.js'
       declare const list: Array<typeof jsonExtractText>
       for (const f of list) {
         f(users.email, ['x'])
       }`,
    ],
    [
      'mapped-type copy of the namespace, indexed by a key',
      `import * as jsonSql from '../lib/json-sql.js'
       declare const k: 'jsonExtractText'
       const bag: { [K in keyof typeof jsonSql]: (typeof jsonSql)[K] } = jsonSql
       bag[k](users.email, ['x'])`,
    ],
    [
      'assignment-pattern destructure',
      `import * as jsonSql from '../lib/json-sql.js'
       let e: typeof jsonSql.jsonExtractText
       ;({ jsonExtractText: e } = jsonSql)
       e(users.email, ['x'])`,
    ],
    [
      'dynamic import through a concatenated specifier',
      `const specifier = '../lib/' + 'json-sql.js'
       const { jsonExtractText: extract11 } = await import(specifier)
       extract11(users.email, ['x'])`,
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
      'dynamic-import destructure through a static specifier',
      `const specifier = '../lib/json-sql.js'
       const { jsonExtractText: extract7 } = await import(specifier)
       extract7(users.email, ['x'])`,
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

  it('flags an interpolated file:// specifier, which cannot be proven safe', () => {
    // This is the shape `loadInstaller()` uses. It is reported anyway: a
    // `file://` head constrains only the head, and the substitution is free to
    // be the absolute path of json-sql.js. Exempting it read as "proven safe"
    // while proving nothing — the same mistake as the earlier `.js`-tail rule.
    // `path` is computed at runtime (resolve(...)), so nothing is foldable —
    // exactly the real shape. A `const path = '/tmp/x.mjs'` would instead be
    // constant-folded by the checker into one literal type and is legitimately
    // resolvable, so it is NOT reported; that is `staticStringValue` working.
    const result = analyzeFixture(
      `declare const path: string
       const mod = await import(\`file://\${path}\`)
       void mod`,
    )
    expect(result.findings.map((f) => f.message)).toEqual([
      'dynamic import whose specifier is not statically resolvable; use a literal specifier so the target can be checked',
    ])
  })

  it('still flags an interpolated specifier that could name json-sql', () => {
    const result = analyzeFixture(
      `declare const dir: string
       const mod = await import(\`../\${dir}/json-sql.js\`)
       void mod`,
    )
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it('does not misreport a namespace-qualified schema reference', () => {
    // `schema.runSteps.output` is a legitimate way to reach a real json column.
    const result = analyzeFixture(
      `import { jsonExtractText } from '../lib/json-sql.js'
       import * as schemaNs from '../db/schema.js'
       jsonExtractText(schemaNs.runSteps.output, ['usage'])`,
    )
    expect(result.findings).toEqual([])
  })

  it('does not mistake an unrelated local function for a helper', () => {
    // `typeof jsonExtractText` gives `fake` the helper's own type object. If
    // type identity alone decided provenance, this local would be reported as
    // the helper escaping — a false positive on code that never touches it.
    // `typeof jsonExtractText` is a TYPE position, so importing the name here
    // is not itself an escape; only `fake` is a runtime value, and it holds an
    // unrelated local function.
    const result = analyzeFixture(
      `import type { jsonExtractText } from '../lib/json-sql.js'
       const fake: typeof jsonExtractText = (c, p) => { throw new Error(String([c, p])) }
       void fake`,
    )
    expect(result.findings).toEqual([])
  })

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
    // The CANONICAL name, not the local alias `steps`. The schema assertion
    // resolves this against the real schema module, so recording the alias
    // would fail the repo-wide gate on legitimate code.
    expect(result.resolved.map((r) => `${r.table}.${r.column}`)).toEqual(['runSteps.output'])
  })

  it('resolves an aliased table against the real schema, not just by name', () => {
    // The assertion above pins the string; this one proves the string is
    // usable — the alias must reach a real json column in the schema module,
    // which is what the repo-wide gate does with every resolved entry.
    const result = analyzeFixture(
      `import { jsonExtractText } from '../lib/json-sql.js'
       import { runSteps as steps } from '../db/schema.js'
       jsonExtractText(steps.output, ['usage'])`,
    )
    for (const { table, column } of result.resolved) {
      const tableObject = (schema as Record<string, unknown>)[table] as
        | Record<string, { dataType?: string }>
        | undefined
      expect(tableObject, `${table} should resolve in the schema module`).toBeDefined()
      expect(tableObject?.[column]?.dataType).toBe('json')
    }
  })
})
