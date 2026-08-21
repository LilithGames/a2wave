import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveMigrationDir } from '../migration-directory.js'

/**
 * Regression test for migration 0088 (`admin_only` boolean → three-state
 * `usage_scope`). It reproduces the exact scenario codex flagged: a database that
 * has already run every migration through the latest `main` (0087) — so it still
 * has the `admin_only` column — is upgraded to this branch. The migration must
 * derive the correct three-state value for every row and drop `admin_only`, with
 * NO data loss and NO stdio server ever falling through to a bindable scope.
 */

const TARGET_TAG = '0088_aberrant_invaders'

/** Apply every migration in journal order UP TO (not including) the target. */
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

const grpStdio = JSON.stringify({
  backends: { d: [{ mode: 'inline', type: 'stdio', command: 'x' }] },
})
const grpRefOnly = JSON.stringify({ backends: { d: [{ mode: 'ref', mcpServerId: 'm_bob_sse' }] } })

// [id, type, group_config, admin_only, user_id, expectedScope]
const FIXTURES = [
  // stdio is host RCE → admin-only regardless of the old flag.
  ['m_stdio', 'stdio', null, 0, 'usr_bob', 'admin-only'],
  ['m_stdio_flag', 'stdio', null, 1, 'usr_admin', 'admin-only'],
  // A group with any inline stdio backend is stdio-capable → admin-only.
  ['m_grp_stdio', 'group', grpStdio, 0, 'usr_bob', 'admin-only'],
  // Any explicitly restricted (admin_only=1) row → admin-only.
  ['m_restricted', 'http', null, 1, 'usr_admin', 'admin-only'],
  // Non-stdio, admin_only=0, non-admin owner → private (owner-only; no leak).
  ['m_bob_sse', 'sse', null, 0, 'usr_bob', 'private'],
  ['m_grp_ref_bob', 'group', grpRefOnly, 0, 'usr_bob', 'private'],
  // Non-stdio, admin_only=0, admin owner OR builtin → all-users (deliberate share).
  ['m_admin_sse', 'sse', null, 0, 'usr_admin', 'all-users'],
  ['m_builtin_sse', 'sse', null, 0, null, 'all-users'],
  ['m_grp_ref_admin', 'group', grpRefOnly, 0, 'usr_admin', 'all-users'],
  // A group whose config is NULL/unparseable is NOT provably stdio-free; a
  // non-admin admin_only=0 one stays at the fail-closed 'private' default.
  ['m_grp_null', 'group', null, 0, 'usr_bob', 'private'],
] as const

describe('usage_scope migration 0088 (admin_only → three-state)', () => {
  let db: Database.Database | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  function seededDbAtMain0087(): Database.Database {
    const database = new Database(':memory:')
    applyMigrationsBefore(database, TARGET_TAG)
    // Sanity: the pre-state must still have admin_only and must NOT yet have usage_scope.
    const cols = database.prepare('PRAGMA table_info(mcp_servers)').all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'admin_only')).toBe(true)
    expect(cols.some((c) => c.name === 'usage_scope')).toBe(false)

    // Migration 0029 already seeds the admin `usr_admin` (username 'admin'); reuse
    // it and add only a non-admin user for the ownership-split fixtures.
    database
      .prepare('INSERT INTO users (id, username, role, created_at, updated_at) VALUES (?,?,?,1,1)')
      .run('usr_bob', 'mig_test_bob', 'user')
    // Start from a clean mcp_servers table so the row-count assertion is exact
    // (earlier migrations may seed builtin rows).
    database.prepare('DELETE FROM mcp_servers').run()
    const insert = database.prepare(
      `INSERT INTO mcp_servers (id, name, type, args, group_config, admin_only, user_id, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, ?, ?, 1, 1)`,
    )
    for (const [id, type, gc, ao, uid] of FIXTURES) insert.run(id, id, type, gc, ao, uid)
    return database
  }

  it('derives the correct three-state scope for every row and drops admin_only', async () => {
    db = seededDbAtMain0087()
    applyTargetMigration(db)

    for (const [id, , , , , expected] of FIXTURES) {
      const row = db.prepare('SELECT usage_scope FROM mcp_servers WHERE id = ?').get(id) as {
        usage_scope: string
      }
      expect(row.usage_scope, `row ${id}`).toBe(expected)
    }

    const cols = db.prepare('PRAGMA table_info(mcp_servers)').all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'admin_only')).toBe(false)
    expect(cols.some((c) => c.name === 'usage_scope')).toBe(true)
  })

  it('never leaves a stdio-capable row at a non-admin-bindable scope', async () => {
    // The core security invariant: after the migration, no stdio server (top-level
    // or inline-in-group) may be 'private' or 'all-users'.
    db = seededDbAtMain0087()
    applyTargetMigration(db)

    const stdioIds = ['m_stdio', 'm_stdio_flag', 'm_grp_stdio']
    for (const id of stdioIds) {
      const row = db.prepare('SELECT usage_scope FROM mcp_servers WHERE id = ?').get(id) as {
        usage_scope: string
      }
      expect(row.usage_scope, `stdio row ${id}`).toBe('admin-only')
    }
  })

  it('preserves row count (no data loss)', async () => {
    db = seededDbAtMain0087()
    const before = (db.prepare('SELECT COUNT(*) c FROM mcp_servers').get() as { c: number }).c
    applyTargetMigration(db)
    const after = (db.prepare('SELECT COUNT(*) c FROM mcp_servers').get() as { c: number }).c
    expect(after).toBe(before)
    expect(after).toBe(FIXTURES.length)
  })
})
