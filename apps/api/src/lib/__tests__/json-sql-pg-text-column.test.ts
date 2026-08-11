/**
 * PostgreSQL-branch regression: JSON helpers applied to a **plain text** column.
 *
 * The helpers were written on the assumption that every JSON-queried column is
 * declared `text(..., { mode: 'json' })`, which `db/schema-transform.ts` maps to
 * `jsonb` on PostgreSQL — so the emitted `->` / `->>` / `?` / `@>` operators
 * always had a jsonb left-hand side.
 *
 * `a2a_tasks.data` breaks that assumption. It stores a JSON envelope but is
 * declared as plain `text`, because `a2a/sqlite-task-store.ts` serialises and
 * parses it by hand (`encodeTask` returns a string; `JSON.parse(row.data)`
 * reads one back) rather than letting drizzle do it. The transform keys off
 * `mode: 'json'` alone, so the column stays `text` on PostgreSQL while
 * `SqliteTaskStore.list()` builds `data -> 'scope' ->> 'tenant'` over it.
 *
 * PostgreSQL defines `->` / `->>` only for json/jsonb, so that is not a
 * degradation but a hard `42883 operator does not exist: text -> unknown` —
 * every A2A `tasks/list` call fails on a PostgreSQL deployment.
 *
 * The fix casts a non-JSON column to jsonb inside the PostgreSQL branch. These
 * assertions are on rendered SQL because catching it at runtime needs a live
 * PostgreSQL server plus a request reaching that specific query — which is
 * exactly why it went unnoticed.
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

// Force the PostgreSQL branch: isPostgresRuntime() reads `isPostgres` off the
// db/client.js module namespace (see db/dialect-runtime.ts).
vi.mock('../../db/client.js', () => ({ isPostgres: true }))

// The REAL tables, not local look-alikes. The defect is a mismatch between how
// a column is declared and what the helper assumes, so re-declaring the column
// here would assert against the test author's belief rather than against the
// schema the bug lives in — and would keep passing after a schema change that
// made the cast wrong. Under the mock above, db/schema.js dispatches to the
// PostgreSQL tables, which is what these queries actually run against.
import { a2aTasks, runSteps, runs } from '../../db/schema.js'
import {
  jsonArrayContainsKeyValue,
  jsonExtractNumber,
  jsonExtractText,
  jsonPathIsAbsent,
  jsonSet,
} from '../json-sql.js'

const dialect = new PgDialect()

/** Render a drizzle fragment to the SQL text PostgreSQL would actually receive. */
function renderPg(fragment: Parameters<PgDialect['sqlToQuery']>[0]): string {
  return dialect.sqlToQuery(fragment).sql
}

describe('JSON helpers over a plain text column on PostgreSQL', () => {
  it('pins the schema premise the rest of this file depends on', () => {
    // Stated explicitly so that changing either declaration fails HERE, with a
    // reason, rather than silently turning every assertion below into a
    // tautology about a column that no longer has the shape being tested.
    // If a2a_tasks.data ever becomes `mode: 'json'`, the cast correctly stops
    // applying and the expectations below should be deleted, not re-pinned.
    expect(a2aTasks.data.dataType, 'a2a_tasks.data is a plain text column holding JSON').toBe(
      'string',
    )
    expect(runSteps.output.dataType, 'run_steps.output is a real JSON column').toBe('json')
  })

  it('casts the column to jsonb before extracting text', () => {
    const rendered = renderPg(jsonExtractText(a2aTasks.data, ['scope', 'tenant']))

    // Without the cast this is `"a2a_tasks"."data" -> $1 ->> $2`, which
    // PostgreSQL rejects outright with 42883.
    expect(rendered).toBe('("a2a_tasks"."data")::jsonb -> $1 ->> $2')
  })

  it('casts before a single-segment text extraction', () => {
    expect(renderPg(jsonExtractText(a2aTasks.data, ['contextId']))).toBe(
      '("a2a_tasks"."data")::jsonb ->> $1',
    )
  })

  it('casts before extracting a number', () => {
    expect(renderPg(jsonExtractNumber(a2aTasks.data, ['persistenceVersion']))).toBe(
      '(("a2a_tasks"."data")::jsonb ->> $1)::numeric',
    )
  })

  it('casts every parent segment chain from the same cast root', () => {
    // The cast applies once, at the column, and the `->` chain then walks the
    // resulting jsonb — not one cast per segment.
    const rendered = renderPg(jsonExtractText(a2aTasks.data, ['task', 'status', 'state']))
    expect(rendered).toBe('("a2a_tasks"."data")::jsonb -> $1 -> $2 ->> $3')
    expect(rendered.match(/::jsonb/g)).toHaveLength(1)
  })

  it('casts before an array containment probe', () => {
    const rendered = renderPg(
      jsonArrayContainsKeyValue(a2aTasks.data, ['chain'], 'providerId', 'prv_1'),
    )
    expect(rendered).toContain('("a2a_tasks"."data")::jsonb')
    expect(rendered).toContain('@>')
  })

  it('casts before a key-presence check', () => {
    const rendered = renderPg(jsonPathIsAbsent(a2aTasks.data, ['usage']))
    // `?` is a jsonb operator too, so the same cast is required.
    expect(rendered).toContain('("a2a_tasks"."data")::jsonb')
  })

  it('casts before jsonb_set', () => {
    const rendered = renderPg(jsonSet(a2aTasks.data, ['scope'], { tenant: 't' }))
    expect(rendered).toContain('("a2a_tasks"."data")::jsonb')
    expect(rendered).toContain('jsonb_set')
  })

  it('leaves a real jsonb column uncast, so no redundant work is added', () => {
    // The cast must be driven by the column's declared type, not applied
    // blanket-fashion: every other call site already passes a jsonb column.
    const rendered = renderPg(jsonExtractText(runSteps.output, ['usage', 'inputTokens']))

    expect(rendered).toBe('"run_steps"."output" -> $1 ->> $2')
    expect(rendered).not.toContain('::jsonb')
  })

  it('refuses a column that holds no JSON at all, instead of casting it blindly', () => {
    // `runs.status` is a plain text status string. Casting it would produce
    // valid-looking SQL that plans fine and then fails per-row with 22P02 —
    // or, on an empty table, silently matches nothing. Failing at query-build
    // time keeps that mistake loud and names the column.
    expect(() => jsonExtractText(runs.status, ['anything'])).toThrow(/runs\.status/)
    expect(() => jsonExtractText(runs.status, ['anything'])).toThrow(/mode:'json'/)
  })

  it('refuses non-JSON columns through every helper, not just the read path', () => {
    expect(() => jsonExtractNumber(runs.status, ['n'])).toThrow(/runs\.status/)
    expect(() => jsonPathIsAbsent(runs.status, ['k'])).toThrow(/runs\.status/)
    expect(() => jsonSet(runs.status, ['k'], 1)).toThrow(/runs\.status/)
    expect(() => jsonArrayContainsKeyValue(runs.status, ['a'], 'k', 'v')).toThrow(/runs\.status/)
  })

  it('leaves a jsonb column uncast for every other helper', () => {
    expect(renderPg(jsonExtractNumber(runSteps.output, ['usage', 'n']))).not.toContain('::jsonb')
    expect(renderPg(jsonPathIsAbsent(runSteps.output, ['usage']))).not.toContain(
      '"run_steps"."output")::jsonb',
    )
    expect(renderPg(jsonArrayContainsKeyValue(runSteps.output, ['chain'], 'k', 'v'))).not.toContain(
      '"run_steps"."output")::jsonb',
    )
  })
})
