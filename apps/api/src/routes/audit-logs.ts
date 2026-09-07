import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { auditLogs, users } from '../db/schema.js'

const app = new Hono()

/** GET /audit-logs — 查询审计日志（admin only，支持分页 + 筛选） */
app.get('/', async (c) => {
  const {
    userId,
    action,
    resource,
    startDate,
    endDate,
    page = '1',
    pageSize = '20',
  } = c.req.query()

  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize) || 20))
  const offset = (pageNum - 1) * limit

  const conditions: SQL<unknown>[] = []
  if (userId) conditions.push(eq(auditLogs.userId, userId))
  if (action) conditions.push(eq(auditLogs.action, action))
  if (resource) conditions.push(eq(auditLogs.resource, resource))
  // Date bounds mirror GET /runs. Reject a malformed value rather than dropping
  // it: silently ignoring it would return the full history while the UI still
  // presents the view as filtered.
  if (startDate) {
    const startDateObj = new Date(startDate)
    if (Number.isNaN(startDateObj.getTime())) return c.json({ error: 'Invalid startDate' }, 400)
    conditions.push(gte(auditLogs.createdAt, startDateObj))
  }
  if (endDate) {
    const endDateObj = new Date(endDate)
    if (Number.isNaN(endDateObj.getTime())) return c.json({ error: 'Invalid endDate' }, 400)
    conditions.push(lte(auditLogs.createdAt, endDateObj))
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const totalResult = (
    await db.select({ count: count() }).from(auditLogs).where(whereClause).limit(1)
  )[0]

  const data = await db
    .select({
      id: auditLogs.id,
      userId: auditLogs.userId,
      username: users.username,
      action: auditLogs.action,
      resource: auditLogs.resource,
      resourceId: auditLogs.resourceId,
      details: auditLogs.details,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(whereClause)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset)

  const total = totalResult?.count ?? 0

  return c.json({
    data: data.map((row) => {
      const actor = row.details?.deletedActor
      const deletedUsername =
        row.userId === null &&
        actor !== null &&
        typeof actor === 'object' &&
        'username' in actor &&
        typeof actor.username === 'string'
          ? actor.username
          : null
      return { ...row, username: row.username ?? deletedUsername }
    }),
    pagination: {
      total,
      page: pageNum,
      pageSize: limit,
      totalPages: Math.ceil(total / limit),
    },
  })
})

export default app
