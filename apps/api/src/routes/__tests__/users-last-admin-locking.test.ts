import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

/**
 * Last-admin invariant under a *real* concurrent database, not a mocked one.
 *
 * The predecessor guard evaluated `(select count(*) ... ) > 1` inside the UPDATE's
 * WHERE clause and called that "atomic on both dialects". It is not. Reproduced on
 * PostgreSQL 16.14: two concurrent demotions targeting *different* admin rows each
 * evaluate that subquery against their own READ COMMITTED snapshot, take no
 * conflicting row lock (they touch different rows, so `EvalPlanQual` never re-checks
 * the predicate), both report `UPDATE 1`, and the table lands on zero active admins.
 *
 * SQLite was never exposed: better-sqlite3 holds one connection and a
 * database-wide write lock, so the two statements serialise and the second matches
 * no row. That is why the hole survived — SQLite is the default backend.
 *
 * The fix is to make the *rows the invariant is computed from* be locked before it is
 * computed, so a racing writer blocks and then re-reads committed state. These tests
 * therefore assert the locking SQL is emitted on PostgreSQL and NOT on SQLite, where
 * `FOR UPDATE` is a hard syntax error.
 */

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'id',
    username: 'username',
    role: 'role',
    isActive: 'is_active',
    email: 'email',
    idaasSub: 'idaas_sub',
    displayName: 'display_name',
    tokenVersion: 'token_version',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  // Provenance columns nulled by DELETE /users/:id before it removes the row.
  auditLogs: { userId: 'audit_logs.user_id' },
  runs: { userId: 'runs.user_id' },
  artifacts: { userId: 'artifacts.user_id' },
  artifactShares: { createdBy: 'artifact_shares.created_by' },
  evaluationTasks: { userId: 'evaluation_tasks.user_id' },
  // Ownership tables consulted by DELETE /users/:id before it removes the row;
  // each is counted with `eq(table.userId, id)`, so only `userId` is read.
  agents: { userId: 'agents.user_id', scheduleRunAsUserId: 'agents.schedule_run_as_user_id' },
  mcpServers: { userId: 'mcp_servers.user_id' },
  skills: { userId: 'skills.user_id' },
  skillGroups: { userId: 'skill_groups.user_id' },
  kbDocuments: { userId: 'kb_documents.user_id' },
  scmSources: { userId: 'scm_sources.user_id' },
  evaluationSets: { userId: 'evaluation_sets.user_id' },
}))

const isPostgresRuntimeMock = vi.fn(() => false)
vi.mock('../../db/dialect-runtime.js', () => ({
  isPostgresRuntime: () => isPostgresRuntimeMock(),
}))

// The guard must run inside a transaction for row locks to be held to commit.
// Capture the callback so tests can drive it with their own handle.
const withTransactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
  const { db } = await import('../../db/client.js')
  return await fn(db)
})
vi.mock('../../db/transaction.js', () => ({
  withTransaction: (fn: (tx: unknown) => Promise<unknown>) => withTransactionMock(fn),
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/audit-actions.js', () => ({
  AUDIT_ACTIONS: {
    USER_ROLE_UPDATED: 'audit.constant.user.role.updated',
    USER_STATUS_UPDATED: 'audit.constant.user.status.updated',
    USER_DELETED: 'audit.constant.user.deleted',
  },
}))
vi.mock('../../lib/auth.js', () => ({
  hashPassword: vi.fn(async () => 'hashed'),
  validatePassword: vi.fn(() => ({ valid: true })),
}))
vi.mock('../../lib/id.js', () => ({ createId: () => 'usr_test' }))

import { db } from '../../db/client.js'
import { asyncQuery } from '../../test/async-query.js'

function makeWhereGet(value: unknown) {
  return { from: () => ({ where: () => asyncQuery({ get: () => value }) }) }
}

/**
 * Renders the drizzle `sql` fragments a call was given into inspectable text.
 *
 * Recurses: an interpolated `sql` fragment is nested as its own object carrying a
 * further `queryChunks` array, so a flat pass over the top level renders the
 * composed clause as empty and silently asserts nothing.
 */
function renderedSql(arg: unknown): string {
  if (arg == null) return ''
  if (typeof arg !== 'object') return String(arg)
  const node = arg as { queryChunks?: unknown[]; value?: unknown }
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map(renderedSql).join('')
  if (Array.isArray(node.value)) return node.value.map(renderedSql).join('')
  if (node.value !== undefined) return String(node.value)
  return ''
}

describe('last-admin invariant holds under real DB concurrency', () => {
  let app: Hono
  const CURRENT_USER = 'usr_admin'

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    isPostgresRuntimeMock.mockReturnValue(false)
    const mod = await import('../users.js')
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userId' as never, CURRENT_USER as never)
      c.set('userRole' as never, 'admin' as never)
      await next()
    })
    app.route('/api/users', mod.default)
  })

  function patchRole(id: string, body: unknown) {
    return app.request(`/api/users/${id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function deleteUser(id: string) {
    return app.request(`/api/users/${id}`, { method: 'DELETE' })
  }

  describe('DELETE /users/:id — the unguarded third path', () => {
    beforeEach(() => {
      // The delete nulls the provenance columns before removing the row.
      ;(db.update as Mock).mockReturnValue({ set: () => ({ where: async () => [] }) })
    })

    it('refuses to delete the last active admin', async () => {
      // Reproduced on PostgreSQL 16: two admins concurrently deleting each other
      // both committed, leaving zero users. The route had only a self-delete check.
      ;(db.select as Mock).mockReturnValue(
        makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
      )
      // Guard predicate does not hold -> the delete matches no row.
      ;(db.delete as Mock).mockReturnValue({ where: () => ({ returning: async () => [] }) })

      const res = await deleteUser('usr_a')

      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('LAST_ADMIN_CANNOT_DELETE')
    })

    it('allows deleting an admin while another active admin remains', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
      )
      ;(db.delete as Mock).mockReturnValue({
        where: () => ({ returning: async () => [{ id: 'usr_a' }] }),
      })

      const res = await deleteUser('usr_a')

      expect(res.status).toBe(200)
    })

    it('deletes a non-admin without consulting the admin-count guard', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeWhereGet({ id: 'usr_x', username: 'bob', role: 'user', isActive: true }),
      )
      ;(db.delete as Mock).mockReturnValue({
        where: () => ({ returning: async () => [{ id: 'usr_x' }] }),
      })

      const res = await deleteUser('usr_x')

      expect(res.status).toBe(200)
    })
  })

  describe('row locking is dialect-correct', () => {
    it('locks the active admin rows FOR UPDATE on PostgreSQL', async () => {
      isPostgresRuntimeMock.mockReturnValue(true)
      vi.resetModules()
      const mod = await import('../users.js')
      const pgApp = new Hono()
      pgApp.use('*', async (c, next) => {
        c.set('userId' as never, CURRENT_USER as never)
        await next()
      })
      pgApp.route('/api/users', mod.default)
      ;(db.select as Mock).mockReturnValue(
        makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
      )
      const whereSpy = vi.fn((_predicate: unknown) => ({
        returning: async () => [{ id: 'usr_a' }],
      }))
      ;(db.update as Mock).mockReturnValue({ set: () => ({ where: whereSpy }) })

      await pgApp.request('/api/users/usr_a/role', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'user' }),
      })

      // Without `FOR UPDATE` the count is computed from an unlocked snapshot and two
      // concurrent demotions of different rows both pass. This is the whole fix.
      expect(renderedSql(whereSpy.mock.calls[0]?.[0]).toLowerCase()).toContain('for update')
    })

    it('never emits FOR UPDATE on SQLite, where it is a syntax error', async () => {
      // Verified against sqlite3: `SELECT ... FOR UPDATE` fails to even prepare.
      ;(db.select as Mock).mockReturnValue(
        makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
      )
      const whereSpy = vi.fn((_predicate: unknown) => ({
        returning: async () => [{ id: 'usr_a' }],
      }))
      ;(db.update as Mock).mockReturnValue({ set: () => ({ where: whereSpy }) })

      await patchRole('usr_a', { role: 'user' })

      expect(renderedSql(whereSpy.mock.calls[0]?.[0]).toLowerCase()).not.toContain('for update')
    })
  })

  describe('the guard runs inside a transaction', () => {
    it('wraps the demotion so row locks are held until commit', async () => {
      // A FOR UPDATE lock taken outside a transaction is released the instant the
      // statement ends, which would restore the original race.
      ;(db.select as Mock).mockReturnValue(
        makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
      )
      ;(db.update as Mock).mockReturnValue({
        set: () => ({ where: () => ({ returning: async () => [{ id: 'usr_a' }] }) }),
      })

      await patchRole('usr_a', { role: 'user' })

      expect(withTransactionMock).toHaveBeenCalled()
    })
  })
})
