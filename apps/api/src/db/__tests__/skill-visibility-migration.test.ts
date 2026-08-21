import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveMigrationDir } from '../migration-directory.js'

const TARGET_TAG = '0098_outstanding_pete_wisdom'

function applyMigrationsBefore(db: Database.Database, targetTag: string): void {
  const drizzleDir = resolveMigrationDir('drizzle')
  const journal = JSON.parse(readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  let reached = false
  for (const entry of journal.entries) {
    if (entry.tag === targetTag) {
      reached = true
      break
    }
    const sql = readFileSync(resolve(drizzleDir, `${entry.tag}.sql`), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement)
    }
  }
  if (!reached) throw new Error(`Migration journal does not contain ${targetTag}`)
}

function applyTargetMigration(db: Database.Database): void {
  const sql = readFileSync(resolve(resolveMigrationDir('drizzle'), `${TARGET_TAG}.sql`), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}

describe('Skill visibility migration 0098', () => {
  let db: Database.Database | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  it('backfills only trusted system built-ins and defaults future rows to private', () => {
    db = new Database(':memory:')
    applyMigrationsBefore(db, TARGET_TAG)

    const columnsBefore = db.prepare('PRAGMA table_info(skills)').all() as Array<{ name: string }>
    expect(columnsBefore.some((column) => column.name === 'visibility')).toBe(false)

    const insertLegacy = db.prepare(
      `INSERT INTO skills (id, name, user_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1)`,
    )
    db.prepare(
      `INSERT INTO users (id, username, role, created_at, updated_at)
       VALUES (?, ?, 'user', 1, 1)`,
    ).run('usr_attacker', 'attacker')
    insertLegacy.run('skl_legacy', 'Legacy Skill', 'usr_admin')
    insertLegacy.run('skl_memory', 'a2wave-memory', null)
    // `frontend-design` was a seeded built-in when 0098 ran. The Skill has since
    // been removed (0101), but this test pins 0098's behaviour at that point in
    // history, so the fixture keeps the name it actually saw.
    insertLegacy.run('skl_frontend', 'frontend-design', null)
    insertLegacy.run('skl_spoofed_memory', 'a2wave-memory', 'usr_attacker')
    insertLegacy.run('skl_unknown_system', 'unknown-system-skill', null)

    applyTargetMigration(db)

    expect(db.prepare('SELECT id, visibility FROM skills ORDER BY id').all()).toEqual([
      { id: 'skl_frontend', visibility: 'all-users' },
      { id: 'skl_legacy', visibility: 'private' },
      { id: 'skl_memory', visibility: 'all-users' },
      { id: 'skl_spoofed_memory', visibility: 'private' },
      { id: 'skl_unknown_system', visibility: 'private' },
    ])

    const visibilityColumn = (
      db.prepare('PRAGMA table_info(skills)').all() as Array<{
        name: string
        notnull: number
        dflt_value: string | null
      }>
    ).find((column) => column.name === 'visibility')
    expect(visibilityColumn).toMatchObject({ notnull: 1, dflt_value: "'private'" })

    db.prepare(
      `INSERT INTO skills (id, name, user_id, created_at, updated_at)
       VALUES (?, ?, ?, 2, 2)`,
    ).run('skl_new', 'New Skill', 'usr_admin')
    expect(db.prepare('SELECT visibility FROM skills WHERE id = ?').get('skl_new')).toEqual({
      visibility: 'private',
    })
  })
})
