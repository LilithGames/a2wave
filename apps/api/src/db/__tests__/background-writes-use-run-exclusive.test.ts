/**
 * Fire-and-forget background writes must go through `runExclusive`.
 *
 * ## Why this is correctness
 *
 * On SQLite the whole process shares one better-sqlite3 connection, so a `BEGIN`
 * opened anywhere makes *every* subsequent statement on `db` join that
 * transaction — and a later ROLLBACK erases it. `transaction.ts` documents this
 * for `logAudit` and provides `runExclusive`, which serialises on the same key
 * and therefore waits for an open transaction instead of joining it.
 *
 * A *request* write that loses this race is bad but bounded: the caller sees an
 * error and can retry. A **background** write has no caller left. When an
 * evaluation's terminal `completed`/`cancelled`/`failed` status is swallowed by
 * a stranger's rollback, the task is stuck displaying `running` forever and
 * nothing will ever write it again — the same permanent-wedge shape as a dropped
 * audit entry under Iron Rule 5.
 *
 * ## Scope
 *
 * A deliberately conservative syntactic scan, in the spirit of
 * `no-io-in-transaction-callbacks.test.ts`. It reads the body of each function
 * named below — all of which run detached from any request — and rejects a bare
 * `db.update(`/`db.insert(`/`db.delete(`. Writes reached via `tx`, via
 * `runExclusive`, or via `withTransaction` are fine; only the unguarded shared
 * handle is the defect.
 *
 * It cannot see through a helper call, so it is a backstop against the easy
 * mistake rather than a proof. Helpers those functions call are listed
 * explicitly for the same reason.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../..')

/**
 * Functions that run with no request context to retry them.
 *
 * `executeTask` is the evaluation replay loop itself (fire-and-forget by
 * construction — the route returns 201 and the UI polls). The rest are the
 * helpers it calls on its terminal paths, listed because the scan cannot follow
 * a call.
 */
const BACKGROUND_FUNCTIONS: ReadonlyArray<{ file: string; fn: string }> = [
  { file: 'routes/evaluation.ts', fn: 'executeTask' },
  { file: 'routes/evaluation.ts', fn: 'settleUnfinishedResults' },
  { file: 'routes/evaluation.ts', fn: 'refreshTaskSummary' },
]

/**
 * A write issued on the shared handle, outside any transaction or guard.
 * Global and whitespace-tolerant: the codebase formats these as
 * `await db\n  .update(...)`, so the scan must cross line breaks.
 */
const BARE_DB_WRITE = /\bdb\s*\.\s*(update|insert|delete)\s*\(/g

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""')
}

/**
 * Blank out every `runExclusive(...)` call by paren matching, so writes inside
 * the guard don't trip the scan. Replacement preserves offsets for reporting.
 */
function stripGuardedRegions(source: string): string {
  const chars = [...source]
  const call = /\brunExclusive\s*\(/g
  for (const match of source.matchAll(call)) {
    const open = match.index + match[0].length - 1
    let depth = 0
    for (let i = open; i < chars.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        depth--
        if (depth === 0) {
          for (let j = open; j <= i; j++) chars[j] = ' '
          break
        }
      }
    }
  }
  return chars.join('')
}

/**
 * The body of `fn`, by brace matching from its declaration.
 *
 * Returns null when the function is not found, which the test asserts on
 * explicitly — a renamed function must fail loudly rather than silently stop
 * being checked.
 */
function functionBody(source: string, fn: string): string | null {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*[(<]`)
  const start = source.search(declaration)
  if (start === -1) return null

  const open = source.indexOf('{', start)
  if (open === -1) return null

  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

describe('background writes use runExclusive', () => {
  for (const { file, fn } of BACKGROUND_FUNCTIONS) {
    it(`${file} → ${fn}() issues no unguarded db write`, () => {
      const source = stripCommentsAndStrings(readFileSync(resolve(SRC, file), 'utf8'))
      const body = functionBody(source, fn)

      // A rename must break this test rather than quietly drop the check.
      expect(body, `${fn} not found in ${file}`).not.toBeNull()

      const offending = [...stripGuardedRegions(body as string).matchAll(BARE_DB_WRITE)].map(
        (match) => `db.${match[1]}( at body offset ${match.index}`,
      )

      expect(
        offending,
        `${fn}() in ${file} writes on the shared db handle. A background write has no caller left to retry it, so a stranger's ROLLBACK erases it permanently. Wrap it in runExclusive() (see db/transaction.ts).`,
      ).toEqual([])
    })
  }
})
