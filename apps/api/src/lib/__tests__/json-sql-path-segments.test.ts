/**
 * Path segments must mean the same thing on both backends.
 *
 * PostgreSQL binds each segment as a parameter, so it is always a literal key.
 * SQLite receives the whole path as one `$.a.b` string, where an unquoted
 * label runs until the next `.` or `[`, a *leading* `"` opens a quoted label,
 * and an empty label is invalid. Exactly those four shapes diverge; the
 * helpers reject them at the boundary, before the dialect branch.
 *
 * Just as load-bearing: nothing else is rejected. Commas, spaces, unicode,
 * leading digits, hyphens, colons, `$`, `#`, `]`, backslashes, interior and
 * trailing quotes are all literal keys on BOTH engines — proven below with
 * real SQLite round-trips, not asserted from documentation. An earlier
 * revision used an identifier allowlist, which mislabelled every one of those
 * dialect-consistent keys as divergent and made the helpers throw on paths
 * the two backends agree on.
 *
 * This file runs on the SQLite branch (the default backend) so the rejection
 * is proven where most developers actually run.
 */
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'

// Pin the SQLite branch: a developer whose .env selects PostgreSQL would
// otherwise flip these helpers to the `->>` form (see json-sql.test.ts).
vi.mock('../../db/client.js', () => ({ isPostgres: false }))

import { runSteps } from '../../db/schema.js'
import {
  jsonArrayContainsKeyValue,
  jsonExtractNumber,
  jsonExtractText,
  jsonPathIsAbsent,
  jsonSet,
} from '../json-sql.js'

/**
 * The five shapes SQLite reads as something other than the literal key.
 *
 * The NUL entries cover all three positions. SQLite's path is a C string, so an
 * interior or trailing NUL silently truncates the key — `a\0b` reads `a`, which
 * is a wrong-row read rather than an error — while a leading one throws.
 */
const DIVERGENT = ['a.b', 'task.status', 'a[0]', 'items[3]', '"ab', '', 'a\0b', 'ab\0', '\0ab']

/**
 * Keys that LOOK special but are literal on both engines. Kept in sync with
 * the real-engine round-trip suite at the bottom of this file — every entry
 * here must also prove itself there.
 */
const LITERAL_SPECIAL = [
  'a,b',
  'a"b',
  'ab"',
  '$',
  '#',
  'a b',
  '9key',
  'hy-phen',
  '中文',
  'a:b',
  'a]b',
  'a\\b',
]

describe('dialect-divergent path segments are rejected on every helper', () => {
  for (const segment of DIVERGENT) {
    it(`rejects ${JSON.stringify(segment)}`, () => {
      expect(() => jsonExtractText(runSteps.output, [segment])).toThrow(/path syntax/)
      expect(() => jsonExtractNumber(runSteps.output, [segment])).toThrow(/path syntax/)
      expect(() => jsonPathIsAbsent(runSteps.output, [segment])).toThrow(/path syntax/)
      expect(() => jsonSet(runSteps.output, [segment], 1)).toThrow(/path syntax/)
      expect(() => jsonArrayContainsKeyValue(runSteps.output, [segment], 'k', 'v')).toThrow(
        /path syntax/,
      )
    })
  }

  it('rejects a divergent segment anywhere in a multi-segment path', () => {
    expect(() => jsonExtractText(runSteps.output, ['task', 'a.b', 'state'])).toThrow(/path syntax/)
  })

  it('rejects a divergent elementKey, which SQLite also splices into a path', () => {
    expect(() => jsonArrayContainsKeyValue(runSteps.output, ['chain'], 'a.b', 'v')).toThrow(
      /path syntax/,
    )
  })
})

describe('dialect-consistent keys are NOT rejected', () => {
  it('accepts the ordinary keys the codebase actually uses', () => {
    for (const segment of ['usage', 'inputTokens', 'contextId', 'scope', '_private', 'a1']) {
      expect(() => jsonExtractText(runSteps.output, [segment])).not.toThrow()
    }
  })

  for (const segment of LITERAL_SPECIAL) {
    it(`accepts ${JSON.stringify(segment)}, a literal key on both engines`, () => {
      expect(() => jsonExtractText(runSteps.output, [segment])).not.toThrow()
      expect(() => jsonSet(runSteps.output, [segment], 1)).not.toThrow()
      expect(() =>
        jsonArrayContainsKeyValue(runSteps.output, ['chain'], segment, 'v'),
      ).not.toThrow()
    })
  }
})

describe('the classification itself, against the real SQLite engine', () => {
  const db = new Database(':memory:')

  /** True when `$.${segment}` writes and reads back exactly the literal key. */
  const isLiteralOnSqlite = (segment: string): boolean => {
    const path = `$.${segment}`
    try {
      const set = db.prepare("SELECT json_set('{}', ?, json('1'))").pluck().get(path)
      if (set !== JSON.stringify({ [segment]: 1 })) return false
      const doc = JSON.stringify({ [segment]: 7 })
      return db.prepare('SELECT json_extract(?, ?)').pluck().get(doc, path) === 7
    } catch {
      return false
    }
  }

  for (const segment of LITERAL_SPECIAL) {
    it(`${JSON.stringify(segment)} round-trips literally, so allowing it is sound`, () => {
      expect(isLiteralOnSqlite(segment)).toBe(true)
    })
  }

  for (const segment of DIVERGENT) {
    it(`${JSON.stringify(segment)} does NOT round-trip literally, so rejecting it is sound`, () => {
      expect(isLiteralOnSqlite(segment)).toBe(false)
    })
  }

  it('shows the NUL divergence: SQLite truncates the key and reads a different value', () => {
    // The quietest of the five shapes — the only one that returns a wrong row
    // instead of raising. SQLite's path is a C string, so `$.a\0b` stops at the
    // NUL and reads key "a" (1); PostgreSQL binds the whole segment and reads
    // key "a\0b" (3). Neither errors, so nothing would have surfaced this.
    const document = JSON.stringify({ a: 1, 'a\0b': 3 })
    expect(db.prepare('SELECT json_extract(?, ?)').pluck().get(document, '$.a\0b')).toBe(1)
    // A trailing NUL degrades the same way, reading the untruncated key.
    const trailing = JSON.stringify({ ab: 2, 'ab\0': 4 })
    expect(db.prepare('SELECT json_extract(?, ?)').pluck().get(trailing, '$.ab\0')).toBe(2)
  })

  it("shows the flagship divergence: '.' descends on SQLite, is literal on PostgreSQL", () => {
    // The document has BOTH a nested a->b and a top-level "a.b". SQLite's path
    // reaches the nested 9; PostgreSQL, binding 'a.b' as one key, would read 7.
    const document = `{"a":{"b":9},"a.b":7}`
    expect(db.prepare('SELECT json_extract(?, ?)').pluck().get(document, '$.a.b')).toBe(9)
    expect(db.prepare('SELECT json_extract(?, ?)').pluck().get(document, '$."a.b"')).toBe(7)
  })
})
