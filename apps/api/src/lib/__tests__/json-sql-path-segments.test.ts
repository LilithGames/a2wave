/**
 * Path segments must mean the same thing on both backends.
 *
 * PostgreSQL binds each segment as a parameter, so it is always a literal key.
 * SQLite receives the whole path as one `$.a.b` string, in which `.` and `[]`
 * are path *syntax*. A single segment therefore addresses two different things
 * depending on the backend — confirmed against both engines:
 *
 *   ['a.b']   PG the key "a.b";   SQLite descends a -> b
 *   ['a[0]']  PG the key "a[0]";  SQLite indexes into the array a
 *   ['']      PG the empty key;   SQLite raises "bad JSON path"
 *
 * That is the same class of defect as the comma-in-path bug: content inside a
 * segment silently reinterpreted as structure. The helpers reject these shapes
 * rather than escaping them, since every real segment is a TypeScript object
 * key and escaping would mean tracking two engines' quoting rules forever.
 *
 * This file runs on the SQLite branch (the default backend) so the rejection is
 * proven where most developers actually run, and pairs each case with the real
 * SQLite behaviour that makes the rejection necessary.
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

/** Segments whose meaning differs between the two engines. */
const AMBIGUOUS = ['a.b', 'a[0]', '', 'a,b', 'a"b', '$', 'a b']

describe('ambiguous path segments are rejected on every helper', () => {
  for (const segment of AMBIGUOUS) {
    it(`rejects ${JSON.stringify(segment)}`, () => {
      expect(() => jsonExtractText(runSteps.output, [segment])).toThrow(/not a plain key/)
      expect(() => jsonExtractNumber(runSteps.output, [segment])).toThrow(/not a plain key/)
      expect(() => jsonPathIsAbsent(runSteps.output, [segment])).toThrow(/not a plain key/)
      expect(() => jsonSet(runSteps.output, [segment], 1)).toThrow(/not a plain key/)
      expect(() => jsonArrayContainsKeyValue(runSteps.output, [segment], 'k', 'v')).toThrow(
        /not a plain key/,
      )
    })
  }

  it('rejects an ambiguous segment anywhere in a multi-segment path', () => {
    expect(() => jsonExtractText(runSteps.output, ['task', 'a.b', 'state'])).toThrow(
      /not a plain key/,
    )
  })

  it('rejects an ambiguous elementKey, which SQLite also splices into a path', () => {
    expect(() => jsonArrayContainsKeyValue(runSteps.output, ['chain'], 'a.b', 'v')).toThrow(
      /not a plain key/,
    )
  })

  it('still accepts the ordinary keys the codebase actually uses', () => {
    for (const segment of ['usage', 'inputTokens', 'contextId', 'scope', '_private', 'a1']) {
      expect(() => jsonExtractText(runSteps.output, [segment])).not.toThrow()
    }
  })
})

describe('why those segments are rejected: real SQLite behaviour', () => {
  const query = (sql: string): unknown => {
    const db = new Database(':memory:')
    try {
      return db.prepare(sql).pluck().get()
    } finally {
      db.close()
    }
  }

  it("treats '.' inside a segment as a descent, unlike PostgreSQL's literal key", () => {
    // The document has BOTH a nested a->b and a top-level "a.b". SQLite's path
    // reaches the nested 9; PostgreSQL, binding 'a.b' as one key, reads 7.
    const document = `'{"a":{"b":9},"a.b":7}'`
    expect(query(`SELECT json_extract(${document}, '$.a.b')`)).toBe(9)
    expect(query(`SELECT json_extract(${document}, '$."a.b"')`)).toBe(7)
  })

  it("treats '[]' inside a segment as an index", () => {
    expect(query(`SELECT json_set('{}', '$.a[0]', json('1'))`)).toBe('{"a":[1]}')
  })

  it('rejects an empty segment outright, where PostgreSQL accepts the empty key', () => {
    expect(() => query(`SELECT json_set('{}', '$.', json('1'))`)).toThrow(/bad JSON path|malformed/)
  })
})
