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
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it, vi } from 'vitest'

// Force the PostgreSQL branch: isPostgresRuntime() reads `isPostgres` off the
// db/client.js module namespace (see db/dialect-runtime.ts).
vi.mock('../../db/client.js', () => ({ isPostgres: true }))

import {
  jsonArrayContainsKeyValue,
  jsonExtractNumber,
  jsonExtractText,
  jsonPathIsAbsent,
  jsonSet,
} from '../json-sql.js'

/**
 * Mirrors the real declarations: `a2a_tasks.data` is plain text holding JSON,
 * while `run_steps.output` is a `mode: 'json'` column that becomes jsonb.
 */
const a2aTasksLike = sqliteTable('a2a_tasks', {
  id: text('id').primaryKey(),
  data: text('data').notNull(),
})

const runStepsLike = sqliteTable('run_steps', {
  id: text('id').primaryKey(),
  output: text('output', { mode: 'json' }).$type<Record<string, unknown>>(),
})

const dialect = new PgDialect()

/** Render a drizzle fragment to the SQL text PostgreSQL would actually receive. */
function renderPg(fragment: Parameters<PgDialect['sqlToQuery']>[0]): string {
  return dialect.sqlToQuery(fragment).sql
}

describe('JSON helpers over a plain text column on PostgreSQL', () => {
  it('casts the column to jsonb before extracting text', () => {
    const rendered = renderPg(jsonExtractText(a2aTasksLike.data, ['scope', 'tenant']))

    // Without the cast this is `"a2a_tasks"."data" -> $1 ->> $2`, which
    // PostgreSQL rejects outright with 42883.
    expect(rendered).toBe('("a2a_tasks"."data")::jsonb -> $1 ->> $2')
  })

  it('casts before a single-segment text extraction', () => {
    expect(renderPg(jsonExtractText(a2aTasksLike.data, ['contextId']))).toBe(
      '("a2a_tasks"."data")::jsonb ->> $1',
    )
  })

  it('casts before extracting a number', () => {
    expect(renderPg(jsonExtractNumber(a2aTasksLike.data, ['persistenceVersion']))).toBe(
      '(("a2a_tasks"."data")::jsonb ->> $1)::numeric',
    )
  })

  it('casts every parent segment chain from the same cast root', () => {
    // The cast applies once, at the column, and the `->` chain then walks the
    // resulting jsonb — not one cast per segment.
    const rendered = renderPg(jsonExtractText(a2aTasksLike.data, ['task', 'status', 'state']))
    expect(rendered).toBe('("a2a_tasks"."data")::jsonb -> $1 -> $2 ->> $3')
    expect(rendered.match(/::jsonb/g)).toHaveLength(1)
  })

  it('casts before an array containment probe', () => {
    const rendered = renderPg(
      jsonArrayContainsKeyValue(a2aTasksLike.data, ['chain'], 'providerId', 'prv_1'),
    )
    expect(rendered).toContain('("a2a_tasks"."data")::jsonb')
    expect(rendered).toContain('@>')
  })

  it('casts before a key-presence check', () => {
    const rendered = renderPg(jsonPathIsAbsent(a2aTasksLike.data, ['usage']))
    // `?` is a jsonb operator too, so the same cast is required.
    expect(rendered).toContain('("a2a_tasks"."data")::jsonb')
  })

  it('casts before jsonb_set', () => {
    const rendered = renderPg(jsonSet(a2aTasksLike.data, ['scope'], { tenant: 't' }))
    expect(rendered).toContain('("a2a_tasks"."data")::jsonb')
    expect(rendered).toContain('jsonb_set')
  })

  it('leaves a real jsonb column uncast, so no redundant work is added', () => {
    // The cast must be driven by the column's declared type, not applied
    // blanket-fashion: every other call site already passes a jsonb column.
    const rendered = renderPg(jsonExtractText(runStepsLike.output, ['usage', 'inputTokens']))

    expect(rendered).toBe('"run_steps"."output" -> $1 ->> $2')
    expect(rendered).not.toContain('::jsonb')
  })

  it('leaves a jsonb column uncast for every other helper', () => {
    expect(renderPg(jsonExtractNumber(runStepsLike.output, ['usage', 'n']))).not.toContain(
      '::jsonb',
    )
    expect(renderPg(jsonPathIsAbsent(runStepsLike.output, ['usage']))).not.toContain(
      '"run_steps"."output")::jsonb',
    )
    expect(
      renderPg(jsonArrayContainsKeyValue(runStepsLike.output, ['chain'], 'k', 'v')),
    ).not.toContain('"run_steps"."output")::jsonb')
  })
})
