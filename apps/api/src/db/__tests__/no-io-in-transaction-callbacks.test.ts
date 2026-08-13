/**
 * A `withTransaction` callback must not await real I/O.
 *
 * Why this is correctness, not style (review [P2] #13): on SQLite the whole
 * process shares one better-sqlite3 connection, so `BEGIN` opens a transaction
 * that *every* subsequent statement on that connection joins.
 *
 * This file used to justify itself with a stronger claim — that a callback
 * awaiting nothing but its own database statements could not be interleaved, so
 * banning non-DB I/O was sufficient to keep unrelated writes out of the
 * transaction. That is **false**: every `await` yields the event loop, including
 * `await db.insert(...)`, because drizzle's `QueryPromise` settles through the
 * microtask queue. This scan never provided the guarantee it advertised.
 *
 * The actual defence against a lost write now lives in `transaction.ts`:
 * non-transactional writes go through `runExclusive`, which serialises on the
 * same key and waits for an open transaction instead of joining it. That is what
 * upholds Iron Rule 5's "never drop an audit entry".
 *
 * What remains valuable here is narrower but still worth enforcing: holding the
 * database-wide write lock across a network call, a spawn, or a timer stalls
 * every other writer for the duration, since `runExclusive` now makes them wait
 * rather than slip in. So this stays a latency/liveness guard, not a proof of
 * atomicity.
 *
 * The review noted the helper's docblock called this "scope, not correctness"
 * and that this was too generous — it is correctness, merely without a live
 * trigger today. So the rule stops being a comment reviewers must remember and
 * becomes an assertion.
 *
 * Scope: a deliberately conservative, syntactic scan. It reads the callback body
 * of every `withTransaction(` site and rejects awaits on a small, unambiguous
 * list of I/O primitives. It cannot see through a helper call, so it is a
 * backstop against the easy mistake, not a proof.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '../..')

/** Awaiting any of these inside a transaction hands the connection to someone else. */
const FORBIDDEN = [
  /await\s+fetch\s*\(/,
  /await\s+axios[.(]/,
  /await\s+setTimeout\s*\(/,
  /await\s+new\s+Promise\s*\(/,
  /await\s+execAsync\s*\(/,
  /await\s+execFileAsync\s*\(/,
  /await\s+spawnAsync\s*\(/,
  /await\s+fs\.promises\./,
  /await\s+readFile\s*\(/,
  /await\s+writeFile\s*\(/,
  // Worktree and reclaim operations spawn git and walk the filesystem; the
  // helper names hide the I/O from the primitive patterns above.
  /await\s+[\w.]+\.removeWorkspace\s*\(/,
  /await\s+[\w.]+\.createWorkspace\s*\(/,
  /await\s+removeGitWorkspace\s*\(/,
  /await\s+createGitWorkspace\s*\(/,
  /await\s+isolateManagedScmStorage\s*\(/,
]

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
 * Body of each transaction-opening call, matched by brace balance.
 *
 * `withScmPathMutation` is scanned alongside `withTransaction` because it IS
 * a transaction — a wrapper adding the SCM advisory lock — and a review found
 * git I/O parked inside one precisely because this scan did not look through
 * the wrapper. Any new wrapper that opens a transaction belongs in this
 * pattern.
 */
function transactionCallbackBodies(source: string): string[] {
  const bodies: string[] = []
  const marker = /with(?:Transaction|ScmPathMutation)\s*\(/g
  let m: RegExpExecArray | null = marker.exec(source)
  while (m !== null) {
    let depth = 0
    let i = m.index + m[0].length - 1
    const start = i
    for (; i < source.length; i++) {
      const ch = source[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) break
      }
    }
    bodies.push(source.slice(start, i))
    m = marker.exec(source)
  }
  return bodies
}

describe('withTransaction callbacks perform no real I/O', () => {
  it('awaits only database work inside the transaction boundary', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (file === resolve(SRC, 'db/transaction.ts')) continue
      const body = code(readFileSync(file, 'utf-8'))
      if (!body.includes('withTransaction')) continue
      for (const callback of transactionCallbackBodies(body)) {
        for (const pattern of FORBIDDEN) {
          if (pattern.test(callback)) {
            offenders.push(`${file.slice(SRC.length + 1)} — ${pattern.source}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('actually finds the call sites, so a broken matcher cannot pass vacuously', () => {
    let sites = 0
    for (const file of walk(SRC)) {
      if (file === resolve(SRC, 'db/transaction.ts')) continue
      sites += transactionCallbackBodies(code(readFileSync(file, 'utf-8'))).length
    }
    // 16 call sites at the time of writing; the floor guards the scan itself.
    expect(sites).toBeGreaterThanOrEqual(10)
  })
})
