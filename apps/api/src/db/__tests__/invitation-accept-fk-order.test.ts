import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Write-ordering inside invitation accept, against a **real** database with foreign keys
 * enforced.
 *
 * ## The bug this pins
 *
 * `user_invitations.accepted_user_id` is a FOREIGN KEY to `users.id`, and it is **NOT
 * DEFERRABLE** — so the database checks it the instant the statement runs, not at COMMIT.
 * The accept handler originally claimed the invitation first (writing the new user's id)
 * and inserted the user second, which means it wrote a reference to a row that did not
 * exist yet. On PostgreSQL every single accept aborted with a 500.
 *
 * Two independent reasons the existing suite missed it, both worth stating because they
 * describe a whole class of blind spot rather than one mistake:
 *
 *  1. The route unit tests mock `db/client.js`, so there are no constraints at all — any
 *     write order passes.
 *  2. SQLite would not have caught it either at the default settings: foreign keys are
 *     **off** unless `PRAGMA foreign_keys = ON` is issued. `db/client.ts` does issue it, so
 *     this test mirrors that pragma rather than trusting the driver default.
 *
 * The assertions therefore run against migrated schema + enforced FKs, and deliberately
 * exercise the raw SQL ordering rather than the route: the constraint is a property of the
 * schema, and a test that could only fail through the route would not explain why.
 */

const MIGRATIONS = existsSync('drizzle')
  ? 'drizzle'
  : existsSync('apps/api/drizzle')
    ? 'apps/api/drizzle'
    : (() => {
        throw new Error('drizzle folder not found')
      })()

let root: string
let sqlite: Database.Database

const NOW = 1_800_000_000_000

/** Insert a pending invitation and return its id. */
function seedInvitation(id: string, code: string) {
  sqlite
    .prepare(
      `insert into user_invitations (id, code, role, expires_at, created_at, updated_at)
       values (?, ?, 'user', ?, ?, ?)`,
    )
    .run(id, code, NOW + 3_600_000, NOW, NOW)
  return id
}

function insertUser(id: string, username: string) {
  sqlite
    .prepare(
      `insert into users (id, username, role, is_active, locale, onboarding, token_version, created_at, updated_at)
       values (?, ?, 'user', 1, 'zh', '{}', 0, ?, ?)`,
    )
    .run(id, username, NOW, NOW)
}

function claimInvitation(invitationId: string, userId: string) {
  return sqlite
    .prepare(
      `update user_invitations set accepted_at = ?, accepted_user_id = ?, updated_at = ?
       where id = ? and accepted_at is null`,
    )
    .run(NOW, userId, NOW, invitationId)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'invite-fk-'))
  sqlite = new Database(join(root, 'test.db'))
  // Mirrors db/client.ts. Without it SQLite silently ignores every foreign key and this
  // whole file would pass against the broken ordering — which is the point being made.
  sqlite.pragma('foreign_keys = ON')
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS })
})

afterAll(() => {
  sqlite?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('invitation accept — foreign key write ordering', () => {
  it('rejects claiming an invitation for a user row that does not exist yet', () => {
    const invitationId = seedInvitation('inv_order_bad', 'code_order_bad')

    // This is exactly what the original implementation did: claim first, insert second.
    expect(() => claimInvitation(invitationId, 'usr_not_yet_inserted')).toThrow(/FOREIGN KEY/i)

    const row = sqlite
      .prepare('select accepted_at, accepted_user_id from user_invitations where id = ?')
      .get(invitationId) as { accepted_at: number | null; accepted_user_id: string | null }
    expect(row.accepted_at).toBeNull()
    expect(row.accepted_user_id).toBeNull()
  })

  it('accepts the shipped ordering: insert the user, then claim the invitation', () => {
    const invitationId = seedInvitation('inv_order_good', 'code_order_good')

    insertUser('usr_order_good', 'orderly')
    const result = claimInvitation(invitationId, 'usr_order_good')

    expect(result.changes).toBe(1)
    const row = sqlite
      .prepare('select accepted_at, accepted_user_id from user_invitations where id = ?')
      .get(invitationId) as { accepted_at: number | null; accepted_user_id: string | null }
    expect(row.accepted_at).toBe(NOW)
    expect(row.accepted_user_id).toBe('usr_order_good')
  })

  // The compare-and-set is what keeps an invitation single-use, and flipping the write
  // order must not have weakened it: a second claim has to match zero rows so the caller
  // knows to roll back the user it just inserted.
  it('matches no row when the invitation was already consumed', () => {
    const invitationId = seedInvitation('inv_order_race', 'code_order_race')
    insertUser('usr_race_first', 'racefirst')
    insertUser('usr_race_second', 'racesecond')

    expect(claimInvitation(invitationId, 'usr_race_first').changes).toBe(1)
    expect(claimInvitation(invitationId, 'usr_race_second').changes).toBe(0)

    const row = sqlite
      .prepare('select accepted_user_id from user_invitations where id = ?')
      .get(invitationId) as { accepted_user_id: string | null }
    // The loser must not overwrite the winner's attribution.
    expect(row.accepted_user_id).toBe('usr_race_first')
  })

  // Deleting an account must not delete the audit trail of how it was created: the FK is
  // ON DELETE SET NULL on both sides, so the invitation row survives with a null pointer.
  it('keeps the invitation row when the account it created is deleted', () => {
    const invitationId = seedInvitation('inv_order_del', 'code_order_del')
    insertUser('usr_order_del', 'deleteme')
    claimInvitation(invitationId, 'usr_order_del')

    sqlite.prepare('delete from users where id = ?').run('usr_order_del')

    const row = sqlite
      .prepare('select accepted_at, accepted_user_id from user_invitations where id = ?')
      .get(invitationId) as { accepted_at: number | null; accepted_user_id: string | null }
    expect(row).toBeDefined()
    expect(row.accepted_user_id).toBeNull()
    // Still recorded as consumed — the link must not become reusable because the account
    // was removed.
    expect(row.accepted_at).toBe(NOW)
  })
})
