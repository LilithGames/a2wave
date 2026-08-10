import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateDrizzleJson,
  generateMigration,
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
} from 'drizzle-kit/api'
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
 * Two invariants pin that failure mode for both lineages:
 * 1. The journal head must have a matching snapshot — a journal entry landing
 *    ahead of the newest snapshot is exactly how the baseline got stranded.
 *    (`drizzle-kit generate --custom` satisfies this; hand-editing does not.)
 * 2. Diffing the latest snapshot against the schema module through
 *    drizzle-kit's own migration engine must produce zero statements — the
 *    in-process equivalent of "a no-op `db:generate` generates nothing",
 *    covering column types, defaults, indexes, and foreign keys, not just
 *    table/column names.
 */

type SqliteSnapshot = Parameters<typeof generateSQLiteMigration>[0]
type PgSnapshot = Parameters<typeof generateMigration>[0]

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function metaDir(lineage: 'drizzle' | 'drizzle-pg'): string {
  return resolve(apiRoot, lineage, 'meta')
}

function readLatestSnapshot(dir: string): unknown {
  const latest = readdirSync(dir)
    .filter((name) => name.endsWith('_snapshot.json'))
    .sort()
    .at(-1)
  if (!latest) throw new Error(`No snapshot found in ${dir}`)
  return JSON.parse(readFileSync(resolve(dir, latest), 'utf8'))
}

function expectJournalHeadSnapshot(dir: string): void {
  const journal = JSON.parse(readFileSync(resolve(dir, '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number }>
  }
  const head = journal.entries.at(-1)
  if (!head) throw new Error(`Empty journal in ${dir}`)
  const snapshotName = `${String(head.idx).padStart(4, '0')}_snapshot.json`
  expect(existsSync(resolve(dir, snapshotName)), `${snapshotName} for journal head`).toBe(true)
}

describe('drizzle snapshot baseline', () => {
  it('sqlite: journal head has a matching snapshot', () => {
    expectJournalHeadSnapshot(metaDir('drizzle'))
  })

  it('postgres: journal head has a matching snapshot', () => {
    expectJournalHeadSnapshot(metaDir('drizzle-pg'))
  })

  it('sqlite: latest snapshot yields a no-op diff against schema.sqlite.ts', async () => {
    const previous = readLatestSnapshot(metaDir('drizzle')) as SqliteSnapshot
    const current = await generateSQLiteDrizzleJson(sqliteSchema, previous.id)
    expect(await generateSQLiteMigration(previous, current)).toEqual([])
  })

  it('postgres: latest snapshot yields a no-op diff against schema.pg.ts', async () => {
    const previous = readLatestSnapshot(metaDir('drizzle-pg')) as PgSnapshot
    const current = await generateDrizzleJson(pgSchema, previous.id)
    expect(await generateMigration(previous, current)).toEqual([])
  })
})
