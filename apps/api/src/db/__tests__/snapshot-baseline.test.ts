import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { is } from 'drizzle-orm'
import { PgTable, getTableConfig as getPgTableConfig } from 'drizzle-orm/pg-core'
import { SQLiteTable, getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import * as pgSchema from '../schema.pg.js'
import * as sqliteSchema from '../schema.sqlite.js'

/**
 * `drizzle-kit generate` diffs the schema module against the LATEST snapshot in
 * `meta/`, not against the journal. A hand-written DDL migration that bumps the
 * journal without a matching snapshot leaves the baseline stale, and the next
 * generate re-emits that DDL verbatim — which then fails on every database that
 * already ran the original migration ("table ... already exists") and aborts
 * boot via migrate-runtime. Regression: 0102_git_trigger_channels landed
 * without a snapshot, so a no-op generate reproduced its CREATE TABLE.
 *
 * These tests pin the invariant: the latest snapshot of each lineage must
 * describe exactly the tables and columns the schema module defines.
 */

interface SnapshotTable {
  name: string
  columns: Record<string, unknown>
}

interface Snapshot {
  tables: Record<string, SnapshotTable>
}

function latestSnapshot(metaDir: string): Snapshot {
  const names = readdirSync(metaDir)
    .filter((name) => name.endsWith('_snapshot.json'))
    .sort()
  const latest = names.at(-1)
  if (!latest) throw new Error(`No snapshot found in ${metaDir}`)
  return JSON.parse(readFileSync(resolve(metaDir, latest), 'utf8')) as Snapshot
}

function snapshotShape(snapshot: Snapshot): Map<string, string[]> {
  const shape = new Map<string, string[]>()
  for (const table of Object.values(snapshot.tables)) {
    shape.set(table.name, Object.keys(table.columns).sort())
  }
  return shape
}

function schemaShape(
  schema: Record<string, unknown>,
  describeTable: (table: never) => { name: string; columns: Array<{ name: string }> },
  isTable: (value: unknown) => boolean,
): Map<string, string[]> {
  const shape = new Map<string, string[]>()
  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue
    const config = describeTable(value as never)
    shape.set(config.name, config.columns.map((column) => column.name).sort())
  }
  return shape
}

function expectAligned(schema: Map<string, string[]>, snapshot: Map<string, string[]>): void {
  expect([...snapshot.keys()].sort()).toEqual([...schema.keys()].sort())
  for (const [tableName, columns] of schema) {
    expect(snapshot.get(tableName), `columns of ${tableName}`).toEqual(columns)
  }
}

describe('drizzle snapshot baseline', () => {
  it('sqlite: latest snapshot matches schema.sqlite.ts tables and columns', () => {
    const snapshot = latestSnapshot(resolve(process.cwd(), 'drizzle/meta'))
    expectAligned(
      schemaShape(sqliteSchema, getSqliteTableConfig, (value) => is(value, SQLiteTable)),
      snapshotShape(snapshot),
    )
  })

  it('postgres: latest snapshot matches schema.pg.ts tables and columns', () => {
    const snapshot = latestSnapshot(resolve(process.cwd(), 'drizzle-pg/meta'))
    expectAligned(
      schemaShape(pgSchema, getPgTableConfig, (value) => is(value, PgTable)),
      snapshotShape(snapshot),
    )
  })
})
