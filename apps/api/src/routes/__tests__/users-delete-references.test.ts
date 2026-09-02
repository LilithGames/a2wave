/**
 * `DELETE /users/:id` against a **real, fully migrated SQLite database**.
 *
 * The pre-existing `users-crud` suite mocks the Drizzle chain, so it could never
 * see the bug this file pins: thirteen tables reference `users.id` and the route
 * issued a bare `DELETE FROM users`. SQLite runs with `PRAGMA foreign_keys = ON`
 * (and PostgreSQL always enforces), so deleting anyone who had ever logged in —
 * i.e. anyone with an `audit_logs` row — raised `FOREIGN KEY constraint failed`
 * and the route answered 500.
 *
 * The two halves of the fix are asserted here, because only a real database can
 * show either:
 *
 *  - **Provenance references are severed, not blocked.** The deleting
 *    transaction nulls `audit_logs.user_id`, `runs.user_id`,
 *    `artifacts.user_id`, `artifact_shares.created_by`,
 *    `evaluation_tasks.user_id` and `agents.schedule_run_as_user_id` first. The
 *    audit row survives with its `details.username` intact, so "who did this"
 *    stays answerable (Iron Rule 5) without pinning the account forever.
 *  - **Ownership references refuse the delete.** Agents, MCP servers, Skills,
 *    Skill groups, KB documents, SCM sources and Evaluation sets are *owned*;
 *    silently cascading them away, or silently orphaning them, both lose data an
 *    administrator did not ask to lose. The route answers 409 with per-resource
 *    counts so the owner's assets can be transferred or deleted first.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const Database = (await import('better-sqlite3')).default
  const { resolveMigrationDir } = await import('../../db/migration-directory.js')

  const sqlite = new Database(':memory:')
  // The whole point of the fixture: without this pragma SQLite ignores every
  // foreign key and the bug under test cannot reproduce.
  sqlite.pragma('foreign_keys = ON')

  const dir = resolveMigrationDir('drizzle')
  const journal = JSON.parse(readFileSync(resolve(dir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  for (const entry of journal.entries) {
    const migration = readFileSync(resolve(dir, `${entry.tag}.sql`), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement)
    }
  }

  return { db: drizzle(sqlite), isPostgres: false, sqliteDatabase: sqlite }
})

// The dispatching `db/schema.js` would hand back PostgreSQL tables under a
// postgres:// DATABASE_URL; this fixture is a SQLite file either way.
vi.mock('../../db/schema.js', async () => await import('../../db/schema.sqlite.js'))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))

import { db } from '../../db/client.js'
import {
  agents,
  auditLogs,
  evaluationSets,
  mcpServers,
  runs,
  skills,
  users,
} from '../../db/schema.sqlite.js'

const CURRENT_USER = 'usr_admin'

async function seedUser(id: string, role: 'admin' | 'user' = 'user') {
  await db.insert(users).values({
    id,
    username: id,
    role,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

describe('DELETE /users/:id with rows referencing the user', () => {
  let app: Hono

  beforeEach(async () => {
    for (const table of [auditLogs, runs, evaluationSets, agents, skills, mcpServers, users]) {
      await db.delete(table)
    }
    await seedUser(CURRENT_USER, 'admin')

    const mod = await import('../users.js')
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userId' as never, CURRENT_USER as never)
      c.set('userRole' as never, 'admin' as never)
      await next()
    })
    app.route('/api/users', mod.default)
  })

  function deleteUser(id: string) {
    return app.request(`/api/users/${id}`, { method: 'DELETE' })
  }

  it('deletes a user who has audit and run history, nulling the provenance columns', async () => {
    await seedUser('usr_alice')
    await db.insert(auditLogs).values({
      id: 'aud_1',
      userId: 'usr_alice',
      action: 'auth.login',
      resource: 'user',
      details: { username: 'usr_alice' },
      createdAt: new Date(),
    })
    await db.insert(agents).values({
      id: 'agt_1',
      name: 'Owned by the admin, not the deleted user',
      userId: CURRENT_USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.insert(runs).values({
      id: 'run_1',
      initiatorAgentId: 'agt_1',
      intent: 'ship it',
      userId: 'usr_alice',
      status: 'completed',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const res = await deleteUser('usr_alice')

    expect(res.status).toBe(200)
    expect((await db.select().from(users).where(eq(users.id, 'usr_alice'))).length).toBe(0)

    const audit = (await db.select().from(auditLogs).where(eq(auditLogs.id, 'aud_1')))[0]
    expect(audit).toBeDefined()
    expect(audit?.userId).toBeNull()
    // Auditability survives the account: the actor's name was captured in
    // `details` at write time, so the entry still says who acted.
    expect(audit?.details).toEqual({ username: 'usr_alice' })

    const run = (await db.select().from(runs).where(eq(runs.id, 'run_1')))[0]
    expect(run).toBeDefined()
    expect(run?.userId).toBeNull()
  })

  it('refuses with 409 and per-resource counts while the user still owns resources', async () => {
    await seedUser('usr_bob')
    await db.insert(agents).values({
      id: 'agt_bob',
      name: "Bob's Agent",
      userId: 'usr_bob',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.insert(skills).values({
      id: 'skl_bob',
      name: "Bob's Skill",
      userId: 'usr_bob',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const res = await deleteUser('usr_bob')

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; ownedResources: Record<string, number> }
    expect(body.error).toBe('USER_HAS_OWNED_RESOURCES')
    expect(body.ownedResources).toEqual({ agents: 1, skills: 1 })

    // Nothing was removed — the administrator must transfer or delete first.
    expect((await db.select().from(users).where(eq(users.id, 'usr_bob'))).length).toBe(1)
    expect((await db.select().from(agents).where(eq(agents.id, 'agt_bob'))).length).toBe(1)
  })

  it('still refuses to delete the last active admin', async () => {
    await seedUser('usr_solo', 'admin')
    // Demote the acting admin so the target is the only active one left.
    await db.update(users).set({ role: 'user' }).where(eq(users.id, CURRENT_USER))

    const res = await deleteUser('usr_solo')

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('LAST_ADMIN_CANNOT_DELETE')
  })
})
