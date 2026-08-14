import { and, count, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { isPostgresRuntime } from '../db/dialect-runtime.js'
import { users } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { logAudit } from '../lib/audit.js'
import { AUDIT_ACTIONS } from '../lib/audit-actions.js'
import { hashPassword, validatePassword } from '../lib/auth.js'

const app = new Hono()

/** GET /users — 列出所有用户（支持分页） */
app.get('/', async (c) => {
  const { page = '1', pageSize = '20' } = c.req.query()

  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize) || 20))
  const offset = (pageNum - 1) * limit

  const totalResult = (await db.select({ count: count() }).from(users).limit(1))[0]

  const data = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      idaasSub: users.idaasSub,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset)

  const total = totalResult?.count ?? 0

  return c.json({
    data,
    pagination: {
      total,
      page: pageNum,
      pageSize: limit,
      totalPages: Math.ceil(total / limit),
    },
  })
})

/**
 * Accounts are no longer created here.
 *
 * An administrator issuing a password on someone else's behalf means that password travels
 * over a chat message and is known to two people, and it makes the account's own email —
 * the field SSO alignment and notifications depend on — a field nobody ever fills in.
 * `POST /users/invitations` replaces it: the invitee follows a expiring link and sets their
 * own username, email and password. See routes/user-invitations.ts.
 */

/** DELETE /users/:id — 删除用户 */
app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const currentUserId = c.get('userId' as never) as string

  if (id === currentUserId) {
    return c.json({ error: 'CANNOT_DELETE_SELF' }, 400)
  }

  const user = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!user) {
    return c.json({ error: 'USER_NOT_FOUND' }, 404)
  }

  // Deletion needs the same last-admin guard as demotion and disabling. The self-delete
  // check above does not cover it: two administrators deleting *each other* concurrently
  // each pass it, and on PostgreSQL both commit — reproduced on 16.14, leaving zero
  // users. Removing an admin is at least as destructive as demoting one, and unlike a
  // demotion it cannot be undone by an operator who is still signed in.
  const isLastAdminDeletion = user.role === 'admin' && user.isActive

  const deleted = await withTransaction((tx) =>
    tx
      .delete(users)
      .where(
        isLastAdminDeletion ? and(eq(users.id, id), anotherActiveAdminRemains()) : eq(users.id, id),
      )
      .returning({ id: users.id }),
  )

  if (deleted.length === 0) {
    return c.json({ error: 'LAST_ADMIN_CANNOT_DELETE' }, 400)
  }

  logAudit(c, {
    action: 'user.delete',
    resource: 'user',
    resourceId: id,
    details: { username: user.username },
  })

  return c.json({ data: { id } })
})

/**
 * "Another administrator who can still sign in would remain after this write."
 *
 * Demotion, disabling and deletion all guard on this so the system never loses its last
 * usable admin — a disabled admin cannot log in, so it must not be counted toward "an
 * administrator still exists".
 *
 * ## Why the subquery is locked
 *
 * Embedding the count in the WHERE clause is necessary but *not* sufficient. Under
 * PostgreSQL's READ COMMITTED default, each statement evaluates the subquery against its
 * own snapshot; two concurrent writes targeting *different* admin rows take no
 * conflicting row lock, so `EvalPlanQual` never re-checks the predicate. Reproduced on
 * PostgreSQL 16.14: two demotions each returned `UPDATE 1` and the table landed on zero
 * active admins.
 *
 * `FOR UPDATE` closes it by locking the very rows the invariant is computed from: the
 * second writer blocks until the first commits, then re-reads committed state and sees
 * the count has dropped, so its predicate fails and it matches no row.
 *
 * SQLite needs none of this and cannot express it — `FOR UPDATE` is a parse error there —
 * but it is also never exposed: better-sqlite3 holds a single connection under a
 * database-wide write lock, so the two statements serialise on their own. That asymmetry
 * is why this hole survived: SQLite is the default backend.
 *
 * The caller must run this inside `withTransaction`; a lock taken outside one is dropped
 * the moment the statement ends, which restores the original race.
 */
function anotherActiveAdminRemains() {
  return sql`(select count(*) from (select 1 from ${users} where ${users.role} = 'admin' and ${users.isActive} = ${sqlTrue()}${lockActiveAdminRows()}) as active_admins) > 1`
}

/**
 * Row-level lock clause for the admin-count subquery, empty on SQLite.
 *
 * Gated on the dialect rather than emitted unconditionally because SQLite rejects
 * `FOR UPDATE` at prepare time — an unconditional clause would break every last-admin
 * write on the default backend.
 */
function lockActiveAdminRows() {
  return isPostgresRuntime() ? sql` for update` : sql``
}

/**
 * `true` as each dialect stores it. SQLite has no boolean type — drizzle maps it
 * onto integer 1/0 — while PostgreSQL wants a real boolean, so a literal `1` here
 * would raise a type error on PostgreSQL and silently match nothing on a mistyped
 * SQLite column.
 */
function sqlTrue() {
  return isPostgresRuntime() ? sql`true` : sql`1`
}

const updateRoleSchema = z.object({
  role: z.enum(['admin', 'user']),
})

/**
 * PATCH /users/:id/role — 改用户角色（admin ↔ user）。
 * 安全闸:
 *   1. 不能改自己的角色（防误操作把自己降级）
 *   2. 把唯一一个 admin 降级会被拒绝（防系统失去管理员）
 */
app.patch('/:id/role', async (c) => {
  const { id } = c.req.param()
  const currentUserId = c.get('userId' as never) as string

  if (id === currentUserId) {
    return c.json({ error: 'CANNOT_CHANGE_OWN_ROLE' }, 400)
  }

  const body = await c.req.json()
  const parsed = updateRoleSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const user = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!user) {
    return c.json({ error: 'USER_NOT_FOUND' }, 404)
  }

  const newRole = parsed.data.role
  if (user.role === newRole) {
    return c.json({ data: { id, role: newRole } }) // no-op
  }

  // Prevent demoting the only administrator. Counts active admins only: padding the
  // count with disabled ones would let the system lose its last usable admin. The guard
  // is scoped to targets that are themselves active — demoting an already-disabled admin
  // removes nobody from the usable pool, so blocking it would only obstruct cleanup.
  //
  // The invariant rides *inside* the UPDATE rather than a preceding SELECT COUNT:
  // two concurrent demotions could each read "2 admins", each pass a pre-check, and
  // each commit, leaving zero. Unlike `runExclusive` (a no-op on PostgreSQL, in-process
  // everywhere) the database settles the race, so it also holds across instances — but
  // only because `anotherActiveAdminRemains()` locks the rows it counts and this runs in
  // a transaction that holds those locks to commit. See that helper for the reproduction.
  const isLastAdminDemotion = user.role === 'admin' && newRole === 'user' && user.isActive

  // 同步自增 tokenVersion：旧 token payload 里冻结了旧 role，必须吊销才能让降级生效
  const demoted = await withTransaction((tx) =>
    tx
      .update(users)
      .set({
        role: newRole,
        tokenVersion: sql`${users.tokenVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        isLastAdminDemotion ? and(eq(users.id, id), anotherActiveAdminRemains()) : eq(users.id, id),
      )
      .returning({ id: users.id }),
  )

  // Zero rows means the guard predicate failed — another request removed the
  // co-admin between the read above and this write. Count rows, never the
  // driver-specific `changes`/`rowCount` (see apps/api/AGENTS.md).
  if (demoted.length === 0) {
    return c.json({ error: 'LAST_ADMIN_CANNOT_DEMOTE' }, 400)
  }

  logAudit(c, {
    action: AUDIT_ACTIONS.USER_ROLE_UPDATED,
    resource: 'user',
    resourceId: id,
    details: { username: user.username, from: user.role, to: newRole },
  })

  return c.json({ data: { id, role: newRole } })
})

const updateStatusSchema = z.object({
  isActive: z.boolean(),
})

/**
 * PATCH /users/:id/status — enable / disable a user.
 *
 * Disabling is the right answer for a departing employee; deletion is only for cleaning up
 * accounts created by mistake. Disabling is reversible and leaves no dangling userId in the
 * audit log. Every isActive enforcement point (authMiddleware / password login / SSO /
 * agent members / schedule triggers) already exists — this fills in the missing write path.
 *
 * Safety gates:
 *   1. You cannot disable yourself (it would lock you out immediately)
 *   2. You cannot disable the last admin who is still active
 */
app.patch('/:id/status', async (c) => {
  const { id } = c.req.param()
  const currentUserId = c.get('userId' as never) as string

  if (id === currentUserId) {
    return c.json({ error: 'CANNOT_DISABLE_SELF' }, 400)
  }

  const body = await c.req.json()
  const parsed = updateStatusSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const user = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!user) {
    return c.json({ error: 'USER_NOT_FOUND' }, 404)
  }

  const { isActive } = parsed.data
  if (user.isActive === isActive) {
    return c.json({ data: { id, isActive } }) // no-op
  }

  // Same locked guard as the demotion path above: the "another admin still exists"
  // condition is evaluated by the database as part of the write, over rows it holds a
  // lock on, so two concurrent disables cannot both pass a stale snapshot and between
  // them retire the last one.
  const isLastAdminDisable = !isActive && user.role === 'admin' && user.isActive

  // Bump tokenVersion on disable to revoke outstanding tokens. authMiddleware re-reads
  // isActive on every request, so this is belt-and-braces: it makes "disable = signed out
  // now" explicit here rather than dependent on a detail of the middleware.
  const changed = await withTransaction((tx) =>
    tx
      .update(users)
      .set({
        isActive,
        ...(isActive ? {} : { tokenVersion: sql`${users.tokenVersion} + 1` }),
        updatedAt: new Date(),
      })
      .where(
        isLastAdminDisable ? and(eq(users.id, id), anotherActiveAdminRemains()) : eq(users.id, id),
      )
      .returning({ id: users.id }),
  )

  if (changed.length === 0) {
    return c.json({ error: 'LAST_ADMIN_CANNOT_DISABLE' }, 400)
  }

  logAudit(c, {
    action: AUDIT_ACTIONS.USER_STATUS_UPDATED,
    resource: 'user',
    resourceId: id,
    details: { username: user.username, isActive },
  })

  return c.json({ data: { id, isActive } })
})

const resetPasswordSchema = z.object({
  newPassword: z.string(),
})

/** POST /users/:id/reset-password — 重置用户密码 */
app.post('/:id/reset-password', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  const parsed = resetPasswordSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { newPassword } = parsed.data

  const validation = validatePassword(newPassword)
  if (!validation.valid) {
    return c.json({ error: validation.message }, 400)
  }

  const user = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  if (!user) {
    return c.json({ error: 'USER_NOT_FOUND' }, 404)
  }

  const passwordHash = await hashPassword(newPassword)
  // admin 重置他人密码同时吊销该用户所有现存 token，强制对方重新登录
  await db
    .update(users)
    .set({
      passwordHash,
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))

  logAudit(c, { action: 'user.reset-password', resource: 'user', resourceId: id })

  return c.json({ data: { message: 'ok' } })
})

export default app
