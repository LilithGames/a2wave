import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

/**
 * Regression guard for the last-admin TOCTOU.
 *
 * The original shape was `SELECT COUNT(*) ...` followed by an unconditional
 * `UPDATE ... WHERE id = ?`. Both statements are separate round trips with an
 * `await` between them, so two concurrent demote/disable requests could each read
 * "2 active admins", each pass the guard, and each commit — leaving zero admins
 * able to sign in. `runExclusive` does not help: it is a no-op on PostgreSQL and
 * an in-process lock everywhere else, so it cannot serialise multiple instances.
 *
 * The fix makes the UPDATE itself carry the invariant, so the database — not a
 * previously-read count — decides whether the write is allowed. These tests
 * therefore assert on the *shape* of the write (guarded predicate + `.returning()`
 * row count deciding the outcome), which is what survives concurrency.
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

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/audit-actions.js', () => ({
  AUDIT_ACTIONS: {
    USER_ROLE_UPDATED: 'audit.constant.user.role.updated',
    USER_STATUS_UPDATED: 'audit.constant.user.status.updated',
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
 * An UPDATE whose `.returning()` resolves to `rows`. An empty array is how the
 * database reports "the guard predicate did not hold" — i.e. this write would
 * have removed the last usable admin, so it changed nothing.
 */
function makeGuardedUpdate(rows: unknown[]) {
  return { set: () => ({ where: () => ({ returning: async () => rows }) }) }
}

describe('last-admin guard is atomic (TOCTOU regression)', () => {
  let app: Hono
  const CURRENT_USER = 'usr_admin'

  beforeEach(async () => {
    vi.clearAllMocks()
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

  function patchStatus(id: string, body: unknown) {
    return app.request(`/api/users/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('rejects the demotion when the guarded UPDATE matches no row', async () => {
    // Simulates the racing case: the pre-read count looked fine, but by the time
    // the UPDATE ran another request had already demoted the co-admin, so the
    // predicate no longer holds and zero rows come back.
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
    )
    ;(db.update as Mock).mockReturnValue(makeGuardedUpdate([]))

    const res = await patchRole('usr_a', { role: 'user' })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('LAST_ADMIN_CANNOT_DEMOTE')
  })

  it('succeeds when the guarded UPDATE matches a row', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
    )
    ;(db.update as Mock).mockReturnValue(makeGuardedUpdate([{ id: 'usr_a' }]))

    const res = await patchRole('usr_a', { role: 'user' })

    expect(res.status).toBe(200)
  })

  it('rejects the disable when the guarded UPDATE matches no row', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
    )
    ;(db.update as Mock).mockReturnValue(makeGuardedUpdate([]))

    const res = await patchStatus('usr_a', { isActive: false })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('LAST_ADMIN_CANNOT_DISABLE')
  })

  it('succeeds when disabling a non-last admin', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
    )
    ;(db.update as Mock).mockReturnValue(makeGuardedUpdate([{ id: 'usr_a' }]))

    const res = await patchStatus('usr_a', { isActive: false })

    expect(res.status).toBe(200)
  })

  it('does not pre-count admins before the guarded write (no read-then-write gap)', async () => {
    // The whole point of the fix: the decision must come from the write, so the
    // route should no longer issue a separate COUNT query at all.
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_a', username: 'alice', role: 'admin', isActive: true }),
    )
    ;(db.update as Mock).mockReturnValue(makeGuardedUpdate([{ id: 'usr_a' }]))

    await patchRole('usr_a', { role: 'user' })

    // Exactly one select: the target-user lookup. No countActiveAdmins() round trip.
    expect((db.select as Mock).mock.calls).toHaveLength(1)
  })

  it('promoting a user to admin needs no guard and still succeeds', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_x', username: 'bob', role: 'user', isActive: true }),
    )
    ;(db.update as Mock).mockReturnValue(makeGuardedUpdate([{ id: 'usr_x' }]))

    const res = await patchRole('usr_x', { role: 'admin' })

    expect(res.status).toBe(200)
  })

  it('enabling a user needs no guard and still succeeds', async () => {
    ;(db.select as Mock).mockReturnValueOnce(
      makeWhereGet({ id: 'usr_x', username: 'bob', role: 'admin', isActive: false }),
    )
    ;(db.update as Mock).mockReturnValue(makeGuardedUpdate([{ id: 'usr_x' }]))

    const res = await patchStatus('usr_x', { isActive: true })

    expect(res.status).toBe(200)
  })
})
