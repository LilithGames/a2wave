import { existsSync } from 'node:fs'
import { createRunInput } from '@a2wave/shared'
import {
  type SQL,
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  ne,
  sql,
} from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { db } from '../db/client.js'
import { agents, chatMessages, runSteps, runs } from '../db/schema.js'
import { reserveExecutionLease } from '../engine/execution-lease-registry.js'
import { allTaskIdVariants, buildTaskId } from '../engine/task-id.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { scheduleNext, tryAcquireSlot } from '../engine/task-queue.js'
import { getRunReadFilter, hasAgentScopedAccess, requireAgentWrite } from '../lib/agent-access.js'
import { buildAgentConfig, resolveWorkDir } from '../lib/agent-helpers.js'
import { extractStepAttachments, pairAttachmentsToMessages } from '../lib/attachment-history.js'
import { logAudit } from '../lib/audit.js'
import { executeChatRun } from '../lib/execute-chat-run.js'
import { createId } from '../lib/id.js'
import { jsonExtractNumber } from '../lib/json-sql.js'
import { logger } from '../lib/logger.js'
import { getCurrentUserId } from '../lib/owner-filter.js'
import { registerPendingContext } from '../lib/pending-job-registry.js'
import { cancelRunningTasksInBackground, claimRunCancellation } from '../lib/run-cancellation.js'
import { runWithLifecycle } from '../lib/run-launcher.js'
import { finishRunError } from '../lib/run-lifecycle.js'
import {
  type RunLogFilter,
  getRunLogFilePath,
  readRunLogPage,
  runLogFileExists,
} from '../lib/run-log-file.js'
import { stopLogCollector } from '../lib/run-log-registry.js'
import { streamFileDownload } from '../lib/stream-file-download.js'
import { runTokenSelect, stepTokenSelect, toTokenTotals } from '../lib/token-stats.js'
import type { WorkerTaskPayload } from '../worker/index.js'

/**
 * Enrich rerun context for Feishu-triggered runs.
 *
 * The original step context carries the Feishu chat_id but not the
 * receive_id_type/receive_id pair required by
 * finishRunSuccess → sendFeishuMessageByContext. Synthesize the pair from
 * whichever shape is available:
 *   - New (post-unified-channel): `context.channel.channel_info.chat_id`
 *   - Legacy (pre-MR !84 rows): flat `context.chat_id`
 *
 * The legacy fallback is kept because MR !84 explicitly does not migrate
 * historical rows; reruns of those must still succeed.
 *
 * KNOWN LIMITATION: if the original Feishu message was in a topic thread
 * (`thread_id` present), the rerun reply will land at the chat root rather
 * than the original thread — `sendFeishuMessageByContext` currently does not
 * support thread-scoped replies. Tracked; product decision pending on whether
 * rerun should pin to the original thread.
 */
function enrichRerunContext(
  triggerSource: string | null,
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined
  if (triggerSource !== 'feishu') return context
  if (context.receive_id_type) return context

  const nestedChatId = (context.channel as { channel_info?: { chat_id?: string } } | undefined)
    ?.channel_info?.chat_id
  const flatChatId = typeof context.chat_id === 'string' ? context.chat_id : undefined
  const chatId = nestedChatId ?? flatChatId
  if (!chatId) return context
  return { ...context, receive_id_type: 'chat_id', receive_id: chatId }
}

const app = new Hono()

/**
 * May the caller act destructively on this run (cancel it, or execute it and
 * thereby transition its status)?
 *
 * Stricter than read visibility (getRunReadFilter): a viewer member can list an
 * agent's runs but must not kill or hijack runs other people started, while
 * still being able to act on the debug run they started themselves. An
 * agent-less run (`POST /runs` with no initiatorAgentId) is actionable only by
 * its trigger or an admin. See hasAgentScopedAccess.
 */
async function canMutateRun(c: Context, run: typeof runs.$inferSelect): Promise<boolean> {
  return await hasAgentScopedAccess(
    c,
    { userId: run.userId, agentId: run.initiatorAgentId },
    'write',
  )
}

/** rerun 时从 step.input.attachments / executionMetadata.attachments 读到的 ref（形状不一，宽松）。 */
type RerunAttachmentRef = {
  token?: string
  /** 外部 uri 附件的审计 ref 无 token 但带 uri（materializer 可重新抓取）。 */
  uri?: string
  name?: string
  mimeType?: string
  size?: number
} & Record<string, unknown>

/**
 * 从已执行 step 的 context.channel 里抽出 OAuth issuer/sub，复原上传时的 consumerId
 * （`oauth:<issuer>:<sub>`）。consume-once 清掉了 run 行上的 attachmentConsumerId 后，
 * rerun 只能从这里回填——否则退回 agent:<id> 会与真实 uploaderId 不符，token 消费鉴权
 * 失败、附件被静默丢弃（review [P1]）。
 *
 * 两种命中：oauth 渠道本身；或 **OAuth 鉴权的 A2A**（channel_type='a2a' 且
 * channel_info.auth='oauth'，附件同样经 OAuth 上传端点、uploaderId=oauth:<iss>:<sub>）。
 * 注意多跳转发（isTrustedHop）：channel_info.oauth 记录的是 upstream 的 oauth 审计元数据，
 * 但当前 hop auth='api_key'、附件 uploaderId=agent:<id>——必须以 auth 字段为准，不能只看
 * oauth 元数据存在。
 */
export function oauthConsumerIdFromContext(
  context: Record<string, unknown> | undefined,
): string | undefined {
  const channel = context?.channel as
    | {
        channel_type?: string
        channel_info?: { auth?: string; oauth?: { issuer?: unknown; sub?: unknown } }
      }
    | undefined
  const oauth = channel?.channel_info?.oauth
  const isOAuthHop =
    channel?.channel_type === 'oauth' ||
    (channel?.channel_type === 'a2a' && channel?.channel_info?.auth === 'oauth')
  if (isOAuthHop && typeof oauth?.issuer === 'string' && typeof oauth.sub === 'string') {
    return `oauth:${oauth.issuer}:${oauth.sub}`
  }
  return undefined
}

/**
 * 解析 rerun 附件的 consumerId（须 == 原上传者 uploaderId，否则消费鉴权拒绝）：
 *   ① 优先用 run 行持久化的 attachmentConsumerId（未被 consume-once 清掉时）；
 *   ② OAuth 渠道：从原 step 的 channel context 复原 oauth:<issuer>:<sub>；
 *   ③ debug 渠道：原 run 的 userId；
 *   ④ a2a 渠道：OAuth 鉴权的 hop 同 ②（附件经 OAuth 上传端点），否则 agent:<id>；
 *   ⑤ gateway（api_key）渠道：agent:<id>。
 * 返回 undefined 表示无法确定（调用方据此决定丢弃附件而非用错身份静默失败）。
 */
export function resolveRerunConsumerId(
  originalRun: typeof runs.$inferSelect,
  agentId: string,
  originalContext: Record<string, unknown> | undefined,
): string | undefined {
  const persisted = originalRun.executionMetadata?.attachmentConsumerId
  if (persisted) return persisted
  // debug and chat_app are both session-authenticated in-product surfaces: the
  // attachment was staged by the signed-in user, so a rerun must consume it as
  // that same user rather than falling through to the agent: identity.
  if (originalRun.triggerSource === 'debug' || originalRun.triggerSource === 'chat_app') {
    return originalRun.userId ?? undefined
  }
  if (originalRun.triggerSource === 'oauth') {
    return oauthConsumerIdFromContext(originalContext)
  }
  if (originalRun.triggerSource === 'a2a') {
    // OAuth 鉴权的 A2A：consumerId 须复原为 oauth:<issuer>:<sub>（与 run-recording 的
    // materialize 一致，review [P1] 连带）；api_key/none（含多跳转发）走 agent:<id>。
    return oauthConsumerIdFromContext(originalContext) ?? `agent:${agentId}`
  }
  // gateway（api_key）：上传端点用 agent:<id>。
  return `agent:${agentId}`
}

// --- Validation ---
// Run-create validation is the single shared contract (createRunInput); do not
// re-declare it here — the CLI/web consumers and this route must stay in lockstep.
const executeRunSchema = z.object({
  /** 指定执行 Agent（覆盖 run 的 initiatorAgentId） */
  agentId: z.string().optional(),
  /** 附加上下文 */
  context: z.string().optional(),
  /** 是否流式返回 */
  stream: z.boolean().default(false),
})

// --- Routes ---

/** GET /runs/stats - 运行统计概览 */
app.get('/stats', async (c) => {
  const visibilityFilter = getRunReadFilter(c)

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Status counts via GROUP BY
  const statusRows = await db
    .select({ status: runs.status, cnt: count() })
    .from(runs)
    .where(visibilityFilter)
    .groupBy(runs.status)

  const byStatus = { completed: 0, failed: 0, running: 0, pending: 0, queued: 0, cancelled: 0 }
  let total = 0
  for (const row of statusRows) {
    const s = row.status as keyof typeof byStatus
    if (s in byStatus) byStatus[s] = row.cnt
    total += row.cnt
  }

  // Today's run count
  const todayCondition = visibilityFilter
    ? and(visibilityFilter, gte(runs.createdAt, today))
    : gte(runs.createdAt, today)
  const todayResult = (
    await db.select({ cnt: count() }).from(runs).where(todayCondition).limit(1)
  )[0]
  const todayRuns = todayResult?.cnt ?? 0

  // Today's status breakdown — same shape as byStatus but scoped to createdAt >= today.
  // Used by the dashboard "今日运行" card so it doesn't lump in historical pending/queued.
  const todayStatusRows = await db
    .select({ status: runs.status, cnt: count() })
    .from(runs)
    .where(todayCondition)
    .groupBy(runs.status)
  const todayByStatus = { completed: 0, failed: 0, running: 0, pending: 0, queued: 0, cancelled: 0 }
  for (const row of todayStatusRows) {
    const s = row.status as keyof typeof todayByStatus
    if (s in todayByStatus) todayByStatus[s] = row.cnt
  }

  // Average duration from JSON result field (completed runs only)
  const durationCondition = visibilityFilter
    ? and(visibilityFilter, eq(runs.status, 'completed'))
    : eq(runs.status, 'completed')
  const durationResult = (
    await db
      .select({ avg: sql<number | null>`AVG(${jsonExtractNumber(runs.result, ['durationMs'])})` })
      .from(runs)
      .where(durationCondition)
      .limit(1)
  )[0]
  const avgDuration = durationResult?.avg != null ? Math.round(durationResult.avg) : 0

  const successRate = total > 0 ? Math.round((byStatus.completed / total) * 100) : 0

  // Distinct asker count — `trigger_user_name` NULL rows are excluded by COUNT(DISTINCT).
  const askerResult = (
    await db
      .select({ cnt: countDistinct(runs.triggerUserName) })
      .from(runs)
      .where(visibilityFilter)
      .limit(1)
  )[0]
  const askerCount = askerResult?.cnt ?? 0

  const todayAskerResult = (
    await db
      .select({ cnt: countDistinct(runs.triggerUserName) })
      .from(runs)
      .where(todayCondition)
      .limit(1)
  )[0]
  const todayAskerCount = todayAskerResult?.cnt ?? 0

  const tokens = toTokenTotals(
    (await db.select(runTokenSelect()).from(runs).where(visibilityFilter).limit(1))[0],
  )
  // Attribute today's tokens by turn timestamp. Filtering cumulative run columns
  // by run creation time would assign follow-up turns to the wrong day.
  const todayStepsCondition = visibilityFilter
    ? and(visibilityFilter, gte(runSteps.createdAt, today))
    : gte(runSteps.createdAt, today)
  const todayTokens = toTokenTotals(
    (
      await db
        .select(stepTokenSelect())
        .from(runSteps)
        .innerJoin(runs, eq(runSteps.runId, runs.id))
        .where(todayStepsCondition)
        .limit(1)
    )[0],
  )

  return c.json({
    total,
    successRate,
    avgDuration,
    todayRuns,
    byStatus,
    todayByStatus,
    askerCount,
    todayAskerCount,
    tokens,
    todayTokens,
  })
})

/**
 * GET /runs/leaderboard - Agent 排行榜（Top 10）
 * Return independently sorted Top 10 leaderboards for runs, distinct users,
 * and total reported tokens across all disjoint usage buckets.
 * owner-filter 一致：admin 看全部，普通用户看自己发起的。
 * innerJoin 丢弃无归属 Agent 的运行；COUNT(DISTINCT) 自动忽略 NULL 触发者
 * （schedule / 纯 api_key 无 trigger_user_name，不计入使用人数）。
 */
app.get('/leaderboard', async (c) => {
  const visibilityFilter = getRunReadFilter(c)

  const byRuns = await (
    await db
      .select({
        agentId: runs.initiatorAgentId,
        name: agents.name,
        icon: agents.icon,
        count: count(),
      })
      .from(runs)
      .innerJoin(agents, eq(runs.initiatorAgentId, agents.id))
      .where(visibilityFilter)
      // name/icon are grouped alongside the id, not just selected: PostgreSQL
      // rejects a projected column that is neither grouped nor aggregated, while
      // SQLite silently picks an arbitrary row. Grouping by them is a no-op on the
      // result — both are functionally dependent on the agent id already grouped.
      .groupBy(runs.initiatorAgentId, agents.name, agents.icon)
      // 同分消抖：先按 name，再按 agentId 作唯一最终 tie-breaker，保证 30s 刷新顺序稳定。
      .orderBy(desc(count()), asc(agents.name), asc(runs.initiatorAgentId))
      .limit(10)
  ).map((r) => ({ agentId: r.agentId as string, name: r.name, icon: r.icon, count: r.count }))

  const byUsers = await (
    await db
      .select({
        agentId: runs.initiatorAgentId,
        name: agents.name,
        icon: agents.icon,
        count: countDistinct(runs.triggerUserName),
      })
      .from(runs)
      .innerJoin(agents, eq(runs.initiatorAgentId, agents.id))
      .where(visibilityFilter)
      // Grouped by name/icon as well — see the byRuns query above.
      .groupBy(runs.initiatorAgentId, agents.name, agents.icon)
      // 只保留至少有 1 名具名触发者的 Agent，剔除全 NULL 触发（schedule/api_key）导致的 0 人条目。
      .having(gt(countDistinct(runs.triggerUserName), 0))
      .orderBy(
        desc(countDistinct(runs.triggerUserName)),
        asc(agents.name),
        asc(runs.initiatorAgentId),
      )
      .limit(10)
  ).map((r) => ({ agentId: r.agentId as string, name: r.name, icon: r.icon, count: r.count }))

  // Exclude agents without tracked tokens and stabilize ties by name and agent ID.
  const tokenSum = sql<number>`COALESCE(SUM(${runs.inputTokens}), 0) + COALESCE(SUM(${runs.outputTokens}), 0) + COALESCE(SUM(${runs.reasoningTokens}), 0) + COALESCE(SUM(${runs.cacheReadTokens}), 0) + COALESCE(SUM(${runs.cacheWriteTokens}), 0)`
  const byTokens = await (
    await db
      .select({
        agentId: runs.initiatorAgentId,
        name: agents.name,
        icon: agents.icon,
        count: tokenSum,
      })
      .from(runs)
      .innerJoin(agents, eq(runs.initiatorAgentId, agents.id))
      .where(visibilityFilter)
      // Grouped by name/icon as well — see the byRuns query above.
      .groupBy(runs.initiatorAgentId, agents.name, agents.icon)
      .having(gt(tokenSum, 0))
      .orderBy(desc(tokenSum), asc(agents.name), asc(runs.initiatorAgentId))
      .limit(10)
  ).map((r) => ({ agentId: r.agentId as string, name: r.name, icon: r.icon, count: r.count }))

  return c.json({ byRuns, byUsers, byTokens })
})

/** GET /runs - 列出所有 Run（支持筛选和分页） */
app.get('/', async (c) => {
  const { agentId, startDate, endDate, page = '1', pageSize = '20' } = c.req.query()

  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize) || 20))
  const offset = (pageNum - 1) * limit

  // 构建查询条件
  const conditions: SQL<unknown>[] = []
  const visibilityFilter = getRunReadFilter(c)
  if (visibilityFilter) conditions.push(visibilityFilter)
  if (agentId) conditions.push(eq(runs.initiatorAgentId, agentId))
  if (startDate) {
    const startDateObj = new Date(startDate)
    if (Number.isNaN(startDateObj.getTime())) return c.json({ error: 'Invalid startDate' }, 400)
    conditions.push(gte(runs.createdAt, startDateObj))
  }
  if (endDate) {
    const endDateObj = new Date(endDate)
    if (Number.isNaN(endDateObj.getTime())) return c.json({ error: 'Invalid endDate' }, 400)
    conditions.push(lte(runs.createdAt, endDateObj))
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  // 查询总数
  const totalResult = (
    await db.select({ count: count() }).from(runs).where(whereClause).limit(1)
  )[0]

  // 查询数据（LEFT JOIN agents 获取 agent 信息）
  const data = await db
    .select({
      id: runs.id,
      intent: runs.intent,
      status: runs.status,
      result: runs.result,
      triggerSource: runs.triggerSource,
      triggerUserName: runs.triggerUserName,
      triggerAgentName: runs.triggerAgentName,
      initiatorAgentId: runs.initiatorAgentId,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
      agentName: agents.name,
      agentIcon: agents.icon,
    })
    .from(runs)
    .leftJoin(agents, eq(runs.initiatorAgentId, agents.id))
    .where(whereClause)
    .orderBy(desc(runs.createdAt))
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

/** GET /runs/:id - 获取 Run 详情（含步骤） */
app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const visibilityFilter = getRunReadFilter(c)
  const conditions = visibilityFilter ? and(eq(runs.id, id), visibilityFilter) : eq(runs.id, id)
  const run = (await db.select().from(runs).where(conditions).limit(1))[0]
  if (!run) {
    return c.json({ error: 'Run not found' }, 404)
  }

  // orderBy(order) 必须有：前端 run-detail 抽屉按位置把 steps[].input.attachments 配到 user
  // 消息，乱序会错配附件。
  const steps = await db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, id))
    .orderBy(asc(runSteps.order))

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.runId, id))
    .orderBy(chatMessages.createdAt)

  // 附件回显：在服务端把 steps[].input.attachments 按序配到 user 消息（与 /chats/:runId/messages
  // 同一 pairAttachmentsToMessages 逻辑），前端直接读 message.attachments，不再各自重复配对。
  const paired = pairAttachmentsToMessages(messages, extractStepAttachments(steps))
  const messagesWithAttachments = messages.map((m, i) =>
    paired[i] ? { ...m, attachments: paired[i] } : m,
  )

  // hasFullLog: 是否存在 NDJSON 全量日志旁路文件（不受 MAX_STREAM_LOGS 截断），
  // 前端据此展示"完整日志"查看/下载入口。
  const { executionMetadata: _executionMetadata, ...publicRun } = run
  return c.json({
    data: {
      ...publicRun,
      steps,
      messages: messagesWithAttachments,
      hasFullLog: runLogFileExists(id),
    },
  })
})

/**
 * GET /runs/:id/logs - 分页读取完整执行日志（JSON）
 *
 * 用于站内查看器。下载端点仍返回原始 NDJSON 全量文件；本端点逐行扫描并只返回
 * 当前页，避免浏览器一次性 `res.text()` 读取 256 MiB 级日志。
 */
app.get('/:id/logs', async (c) => {
  const { id } = c.req.param()
  const visibilityFilter = getRunReadFilter(c)
  const conditions = visibilityFilter ? and(eq(runs.id, id), visibilityFilter) : eq(runs.id, id)
  const run = (await db.select({ id: runs.id }).from(runs).where(conditions).limit(1))[0]
  if (!run) {
    return c.json({ error: 'Run not found' }, 404)
  }

  const rawLimit = Number.parseInt(c.req.query('limit') ?? '500', 10)
  const pageSize = Math.min(1000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 500))
  const rawPage = c.req.query('page') ?? 'last'
  const page = rawPage === 'last' ? 'last' : Number.parseInt(rawPage, 10)
  if (page !== 'last' && (!Number.isFinite(page) || page < 1)) {
    return c.json({ error: 'Invalid page' }, 400)
  }
  const rawFilter = c.req.query('filter') ?? 'all'
  const filter: RunLogFilter = ['all', 'tools', 'messages', 'problems'].includes(rawFilter)
    ? (rawFilter as RunLogFilter)
    : 'all'

  const logPage = await readRunLogPage(id, { page, pageSize, filter })
  if (!logPage) {
    return c.json({ error: 'Run log file not found' }, 404)
  }

  return c.json({
    data: logPage.entries,
    meta: {
      page: logPage.page,
      pageSize: logPage.pageSize,
      totalEntries: logPage.totalEntries,
      totalPages: logPage.totalPages,
      stats: logPage.stats,
    },
  })
})

/**
 * GET /runs/:id/logs/download - 下载完整执行日志（NDJSON）
 *
 * runSteps.output.logs 受 MAX_STREAM_LOGS 截断（保头丢尾）；本端点返回
 * data/run-logs/<runId>.ndjson 全量旁路文件。权限与 GET /:id 一致（owner 过滤）。
 */
app.get('/:id/logs/download', async (c) => {
  const { id } = c.req.param()
  const visibilityFilter = getRunReadFilter(c)
  const conditions = visibilityFilter ? and(eq(runs.id, id), visibilityFilter) : eq(runs.id, id)
  const run = (await db.select({ id: runs.id }).from(runs).where(conditions).limit(1))[0]
  if (!run) {
    return c.json({ error: 'Run not found' }, 404)
  }

  const filePath = getRunLogFilePath(id)
  if (!filePath || !existsSync(filePath)) {
    return c.json({ error: 'Run log file not found' }, 404)
  }

  return streamFileDownload(c, filePath, {
    filename: `${id}.ndjson`,
    mimeType: 'application/x-ndjson; charset=utf-8',
  })
})

/** POST /runs - 创建 Run（触发一次任务） */
app.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = createRunInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  // `initiatorAgentId` comes straight from the body, and runs are now read through
  // the agent (getRunReadFilter) rather than through runs.user_id. Without this
  // guard a caller could point a run at any agent and have the row — plus its
  // free-text intent — surface in that agent owner's run list, stats and the
  // leaderboard. Write is the right bar and costs no legitimate caller: the CLI
  // creates a run only to execute it, and execute already requires write on the
  // same agent, so anyone rejected here would have failed one step later.
  // Throws 404 when the agent is invisible, 403 for a viewer, via the global onError.
  await requireAgentWrite(c, parsed.data.initiatorAgentId)

  const id = createId('run')
  const userId = getCurrentUserId(c)
  const newRun = (
    await db
      .insert(runs)
      .values({ id, ...parsed.data, userId })
      .returning()
  )[0]

  logAudit(c, {
    action: 'run.create',
    resource: 'run',
    resourceId: id,
    details: { intent: parsed.data.intent },
  })

  return c.json({ data: newRun }, 201)
})

/**
 * POST /runs/:id/execute - 执行 Run
 *
 * 核心执行链路: Run -> 查找 Agent -> 获取 Engine -> 执行
 * 支持同步和 SSE 流式两种模式。
 */
app.post('/:id/execute', async (c) => {
  const { id } = c.req.param()

  // 1. 查找 Run
  const visibilityFilter = getRunReadFilter(c)
  const conditions = visibilityFilter ? and(eq(runs.id, id), visibilityFilter) : eq(runs.id, id)
  const run = (await db.select().from(runs).where(conditions).limit(1))[0]
  if (!run) {
    return c.json({ error: 'Run not found' }, 404)
  }

  // Executing MUTATES this run — it CASes the status to `running` and appends a
  // step attributed to the target agent — while getRunReadFilter deliberately
  // lets a viewer merely *see* runs of an agent shared with them. Since the
  // target agent is overridable by the request body below, authorizing only that
  // agent would let a viewer of agent A hijack A's queued run by pointing
  // execute at an agent B they own. Authorize the source run in its own right.
  if (!(await canMutateRun(c, run))) {
    return c.json({ error: 'Write access required' }, 403)
  }

  if (['running', 'completed', 'failed', 'cancelled'].includes(run.status)) {
    return c.json({ error: `Run cannot be re-executed (current status: ${run.status})` }, 409)
  }

  // 2. 解析请求体
  const rawBody = await c.req.text()
  let body: unknown = {}
  if (rawBody.trim().length > 0) {
    try {
      body = JSON.parse(rawBody)
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
  }
  const parsed = executeRunSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  // 3. 查找要使用的 Agent
  //
  // KNOWN ASYMMETRY when `agentId` overrides the run's own agent: the run row
  // keeps pointing at initiator_agent_id (A) while the step and every artifact
  // this execution produces are stamped with the executing agent (B). Run
  // visibility then resolves through A and artifact visibility through B, so a
  // viewer of A sees the run but an empty artifact list — the very symptom the
  // agent-derived filters were introduced to remove. Left as-is because no
  // first-party client sends the override (the CLI sets a matching
  // initiatorAgentId; the web app never calls this endpoint) and converging the
  // two would silently re-attribute runs in stats and the leaderboard.
  const agentId = parsed.data.agentId || run.initiatorAgentId
  if (!agentId) {
    return c.json({ error: 'No agentId provided and run has no initiatorAgentId' }, 400)
  }

  // Executing a run spends the target agent's credentials / skills / workspace,
  // so it requires write permission on THAT agent — not just ownership of the
  // run (which the caller created). requireAgentWrite throws 404 when the agent
  // is invisible to the caller and 403 for a viewer; the global onError maps
  // both to the right HTTP status.
  const { agent } = await requireAgentWrite(c, agentId)

  if (agent.status !== 'active') {
    return c.json({ error: `Agent "${agent.name}" is ${agent.status}` }, 400)
  }

  // 4. 解析 Agent 配置（合并 agent.config + provider + systemPrompt + skills + env）
  const agentConfig = await buildAgentConfig(agent, {
    runtimeAdminRequesterUserId: getCurrentUserId(c),
  })
  if (!agentConfig.engineType) {
    agentConfig.engineType = agent.type
  }

  logger.info({ runId: id, agentId, stream: parsed.data.stream }, 'Run execution request received')

  // 5. 更新 Run 状态为 running（防重入：仅 pending/queued 可被更新，且 WHERE 限定当前状态）
  const canExecuteStatuses: Array<'pending' | 'queued'> = ['pending', 'queued']
  const executeConditions = visibilityFilter
    ? and(eq(runs.id, id), visibilityFilter, inArray(runs.status, canExecuteStatuses))
    : and(eq(runs.id, id), inArray(runs.status, canExecuteStatuses))

  const updateRunResult = await db
    .update(runs)
    .set({ status: 'running', updatedAt: new Date() })
    .where(executeConditions)
    .returning({ id: runs.id })

  // 防重入：若并发请求已先把状态改为 running，本请求的 update 影响 0 行，返回 409。
  if (updateRunResult && updateRunResult.length === 0) {
    const latest = (
      await db.select({ status: runs.status }).from(runs).where(eq(runs.id, id)).limit(1)
    )[0]
    return c.json(
      { error: `Run cannot be re-executed (current status: ${latest?.status ?? 'unknown'})` },
      409,
    )
  }

  // Audit after the status CAS won the race, so a request that lost it (409
  // above) leaves no entry claiming an execution that never happened. `agentId`
  // is recorded because it may be overridden per request and therefore differs
  // from runs.initiator_agent_id — without it the trail cannot answer which
  // agent's credentials were actually spent.
  logAudit(c, {
    action: 'run.execute',
    resource: 'run',
    resourceId: id,
    details: { agentId },
  })

  // 6. 创建 RunStep 记录
  const stepId = createId('rst')
  await db.insert(runSteps).values({
    id: stepId,
    runId: id,
    agentId,
    order: 1,
    input: { intent: run.intent, context: parsed.data.context },
    status: 'running',
  })
  reserveExecutionLease(id, agentId)

  // 7. 构建 prompt 和 WorkerTaskPayload
  // Backward compat: if systemPrompt does NOT use {{context}} template var,
  // append context to prompt directly (legacy behavior)
  const systemPrompt = (agentConfig.systemPrompt as string) || ''
  const hasContextVar = /\{\{\s*context\s*\}\}/.test(systemPrompt)

  const prompt =
    !hasContextVar && parsed.data.context
      ? `${run.intent}\n\nAdditional context:\n${parsed.data.context}`
      : run.intent

  const taskId = buildTaskId('', id, stepId)
  const startTime = Date.now()
  let resolvedWorkDir: string
  try {
    resolvedWorkDir = await resolveWorkDir(agent)
  } catch (error) {
    const publicError = await finishRunError(
      { taskId, runId: id, stepId, agentId, startTime, userId: run.userId ?? undefined },
      error,
    )
    return c.json({ error: publicError, runId: id, stepId }, 500)
  }

  const payload: WorkerTaskPayload = {
    taskId,
    prompt,
    // context is validated as a free-form string by the zod schema above and
    // passed through for {{context}} template substitution. WorkerTaskPayload
    // types it as Record for future structured contexts — cast to keep the
    // current string-based behavior without widening the API contract.
    context: parsed.data.context as unknown as Record<string, unknown> | undefined,
    model: agentConfig.model || undefined,
    workDir: resolvedWorkDir,
    agentConfig: agentConfig,
  }

  const lifecycleParams = {
    taskId,
    runId: id,
    stepId,
    agentId,
    startTime,
    workDir: resolvedWorkDir,
    userId: run.userId ?? undefined,
  }

  if (parsed.data.stream) {
    return streamSSE(c, async (sseStream) => {
      const result = await runWithLifecycle(taskId, payload, lifecycleParams, {
        onUpdate: (content) => {
          sseStream
            .writeSSE({ event: 'update', data: JSON.stringify({ content }) })
            .catch((err) => logger.warn({ err }, 'SSE write failed'))
        },
        onLogEntry: (entry) => {
          sseStream
            .writeSSE({ event: 'log', data: JSON.stringify(entry) })
            .catch((err) => logger.warn({ err }, 'SSE write failed'))
        },
      })

      await sseStream.writeSSE({
        event: result.success ? 'done' : 'error',
        data: JSON.stringify(
          result.success
            ? {
                success: true,
                output: result.output,
                chatId: result.chatId,
                durationMs: result.durationMs,
              }
            : { error: result.error ?? 'Execution failed', durationMs: result.durationMs },
        ),
      })
    })
  }

  const result = await runWithLifecycle(taskId, payload, lifecycleParams)
  if (!result.success) {
    return c.json(
      {
        error: result.error ?? 'Execution failed',
        runId: id,
        stepId,
        durationMs: result.durationMs,
      },
      500,
    )
  }
  return c.json({
    data: {
      runId: id,
      stepId,
      success: true,
      output: result.output,
      chatId: result.chatId,
      durationMs: result.durationMs,
    },
  })
})

/** POST /runs/:id/rerun - 用相同的 intent 和 agentId 重新创建并执行一次 Run */
app.post('/:id/rerun', async (c) => {
  const { id } = c.req.param()

  const visibilityFilter = getRunReadFilter(c)
  const conditions = visibilityFilter ? and(eq(runs.id, id), visibilityFilter) : eq(runs.id, id)
  const originalRun = (await db.select().from(runs).where(conditions).limit(1))[0]
  if (!originalRun) {
    return c.json({ error: 'Run not found' }, 404)
  }

  // Replaying a run re-sends its channel context — a Feishu rerun answers into
  // the original chat — so the caller must hold write on the run being replayed,
  // not merely read visibility of it. The requireAgentWrite below covers the
  // *target* agent, which is resolved from the latest step and can differ from
  // runs.initiator_agent_id when a prior execute overrode `agentId`; without
  // this guard a viewer of that run's agent could replay it through an agent
  // they own and post into the original agent's chat.
  if (!(await canMutateRun(c, originalRun))) {
    return c.json({ error: 'Write access required' }, 403)
  }

  // 读**最新** step（order 最大）——runs.intent 会被多轮会话更新为最后一轮，附件/context 也应
  // 取与当前 intent 对应的那一轮，否则会错带第一轮附件或丢最后一轮新增（review [P1]）。
  const latestStep = (
    await db
      .select({ agentId: runSteps.agentId, input: runSteps.input })
      .from(runSteps)
      .where(eq(runSteps.runId, id))
      .orderBy(desc(runSteps.order))
      .limit(1)
  )[0]

  const agentId = latestStep?.agentId ?? originalRun.initiatorAgentId
  if (!agentId) {
    return c.json({ error: 'Cannot determine agent for rerun' }, 400)
  }

  // Same guard as execute: rerun replays against the target agent using its
  // credentials, so the caller must hold write permission on it (404 when
  // invisible, 403 for a viewer via the global onError).
  const { agent } = await requireAgentWrite(c, agentId)
  if (agent.status !== 'active') {
    return c.json({ error: `Agent "${agent.name}" is not active (status: ${agent.status})` }, 400)
  }

  // A rerun carries the original `triggerSource` forward, so a chat_app run
  // re-executes as chat_app — and would bypass the gates the chat endpoint
  // applies per turn. Re-check them here against the *current* config: an owner
  // who revoked the channel or switched attachments off has withdrawn consent
  // for exactly this, and without the check a replay still consumes the files
  // and files fresh chat_app-attributed rows into the channel stats.
  const isChatAppRerun = originalRun.triggerSource === 'chat_app'
  if (isChatAppRerun) {
    if (
      !(agent.publishChannels ?? []).includes('chat_app') ||
      agent.publishStatus !== 'published'
    ) {
      return c.json({ error: 'Chat app channel is no longer enabled for this Agent' }, 400)
    }
  }
  const chatAppAttachmentsDisabled =
    isChatAppRerun &&
    ((agent.chatAppConfig ?? {}) as { allowAttachments?: boolean }).allowAttachments === false

  const originalContext = (latestStep?.input as Record<string, unknown> | undefined)?.context as
    | Record<string, unknown>
    | undefined
  const rerunContext = enrichRerunContext(originalRun.triggerSource, originalContext)

  // 附件：rerun 要带上原 run 的附件（否则带附件的 run 重跑变纯文本，与原 run 输入不一致）。
  // 来源两处（缺一不可）：
  //   ① 最新 step 的 input.attachments（已执行过的 run）；
  //   ② originalRun.executionMetadata.attachments（**queued 后被取消**的 run 没有 runSteps，
  //      附件只在 run 行里，review [P1]）。
  // 可重放的 ref 两种：带 token（暂存字节重放，走消费鉴权）或带 uri（外部 http(s) 重新抓取，
  // A2A uri 附件的审计 ref 落盘时保留了 uri）。皆无（A2A inline bytes）无法重放——丢弃并 warn。
  const stepAttachmentsRaw = (latestStep?.input as { attachments?: unknown } | undefined)
    ?.attachments as RerunAttachmentRef[] | undefined
  const metaAttachmentsRaw = originalRun.executionMetadata?.attachments as
    | RerunAttachmentRef[]
    | undefined
  // queuedTurn marker：当前 intent 对应的轮排队后被取消、从未落成 step，最新 step 属于**上一轮**。
  // 此时只能以本轮 executionMetadata.attachments 为准（缺省=本轮无附件），绝不回读上一轮 step 的
  // 附件——否则会出现「第二轮文本 + 第一轮附件」的错配（review [P2]）。
  // 无此 marker（正常已执行轮）时保持原优先级：step 附件优先，metadata 作 queued-无-step 的兜底。
  const rawAttachments = originalRun.executionMetadata?.queuedTurn
    ? (metaAttachmentsRaw ?? [])
    : (stepAttachmentsRaw ?? metaAttachmentsRaw ?? [])
  let rerunAttachments = rawAttachments.filter(
    (a): a is { token?: string; uri?: string; name: string; mimeType: string; size?: number } =>
      Boolean(
        a &&
          (typeof (a as { token?: unknown }).token === 'string' ||
            typeof (a as { uri?: unknown }).uri === 'string'),
      ),
  )
  const droppedUnreplayable = rawAttachments.length - rerunAttachments.length
  if (droppedUnreplayable > 0) {
    logger.warn(
      { originalRunId: id, dropped: droppedUnreplayable },
      'Rerun dropped attachments without token or uri (A2A inline bytes cannot be replayed)',
    )
  }
  // The owner switched attachments off after this run was recorded; replaying it
  // would feed the Agent the very files they withdrew. Drop them and let the
  // rerun proceed as text, matching what the chat endpoint would accept today.
  if (chatAppAttachmentsDisabled && rerunAttachments.length > 0) {
    logger.warn(
      { originalRunId: id, dropped: rerunAttachments.length },
      'Rerun dropped chat_app attachments because the Agent no longer allows them',
    )
    rerunAttachments = []
  }

  const rerunConsumerId = resolveRerunConsumerId(originalRun, agentId, originalContext)
  // 有带 token 的附件但无法确定 consumerId（如 OAuth run 的 channel context 缺 issuer/sub）：
  // 与其带错身份让 materialize 消费鉴权静默失败，不如显式丢弃并 warn（review [P1]）。
  // uri ref 是外部抓取、不走 token 消费鉴权，不受 consumerId 缺失影响，保留。
  if (rerunAttachments.some((a) => a.token) && !rerunConsumerId) {
    logger.warn(
      { originalRunId: id, triggerSource: originalRun.triggerSource },
      'Rerun cannot resolve attachment consumerId; dropping token attachments to avoid silent auth failure',
    )
    rerunAttachments = rerunAttachments.filter((a) => !a.token)
  }

  logger.debug(
    {
      originalRunId: id,
      triggerSource: originalRun.triggerSource,
      hasOriginalContext: !!originalContext,
      originalContextKeys: originalContext ? Object.keys(originalContext) : [],
      hasRerunContext: !!rerunContext,
      rerunContextReceiveId: (rerunContext as Record<string, unknown> | undefined)?.receive_id,
      rerunContextReceiveIdType: (rerunContext as Record<string, unknown> | undefined)
        ?.receive_id_type,
    },
    'Rerun context resolution',
  )

  const newRunId = createId('run')
  const userId = getCurrentUserId(c)
  const newRun = (
    await db
      .insert(runs)
      .values({
        id: newRunId,
        intent: originalRun.intent,
        initiatorAgentId: agentId,
        triggerSource: originalRun.triggerSource,
        // Carry the original asker forward so rerun rows still contribute to
        // askerCount / topAskers. Other channels (chat/gateway/oauth-gateway/a2a)
        // denormalize at insert time; rerun has to read from the prior row.
        triggerUserName: originalRun.triggerUserName,
        triggerAgentName: originalRun.triggerAgentName,
        userId,
        // 带上原 run 的附件（若有），供 executeChatRun 出队时重新 materialize。
        ...(rerunAttachments && rerunAttachments.length > 0
          ? {
              executionMetadata: {
                runtimeAdminRequesterUserId: userId,
                attachments: rerunAttachments,
                ...(rerunConsumerId ? { attachmentConsumerId: rerunConsumerId } : {}),
              },
            }
          : { executionMetadata: { runtimeAdminRequesterUserId: userId } }),
      })
      .returning()
  )[0]

  logAudit(c, {
    action: 'run.rerun',
    resource: 'run',
    resourceId: newRunId,
    details: { originalRunId: id },
  })

  const slotResult = await tryAcquireSlot(taskQueueDb, agentId, newRunId, agent.maxConcurrency ?? 1)
  if (slotResult === 'queue_full') {
    await db.delete(runs).where(eq(runs.id, newRunId))
    return c.json({ error: 'Queue is full' }, 429)
  }
  if (slotResult === 'queued') {
    if (rerunContext) registerPendingContext(newRunId, rerunContext)
    return c.json({ data: { ...newRun, status: 'queued' } }, 202)
  }

  void executeChatRun(agentId, newRunId, rerunContext)

  return c.json({ data: { ...newRun, status: 'running' } }, 201)
})

/** POST /runs/:id/cancel - 取消运行中或排队中的 Run */
app.post('/:id/cancel', async (c) => {
  const { id } = c.req.param()

  const visibilityFilter = getRunReadFilter(c)
  const conditions = visibilityFilter ? and(eq(runs.id, id), visibilityFilter) : eq(runs.id, id)
  const run = (await db.select().from(runs).where(conditions).limit(1))[0]
  if (!run) {
    return c.json({ error: 'Run not found' }, 404)
  }

  // Visibility alone does not grant cancellation — see canMutateRun.
  if (!(await canMutateRun(c, run))) {
    return c.json({ error: 'Write access required' }, 403)
  }

  if (run.status !== 'running' && run.status !== 'queued') {
    return c.json({ error: `Run is not cancellable (current status: ${run.status})` }, 400)
  }

  if (run.status === 'running') {
    // Drain any pending debounced log flush BEFORE overwriting runs.status
    // to 'cancelled'. Otherwise a late flush could race and the UI would
    // briefly see the step output reset to a stale snapshot.
    await stopLogCollector(id)
  }

  // Re-read status AFTER the await: the pre-await snapshot may be stale (the run
  // could have been promoted queued→running, or completed, during the drain).
  // The CAS must reflect the current status, not the snapshot, so it neither
  // over-cancels a finished run nor mis-reports a run that just started.
  const currentStatus =
    (await db.select({ status: runs.status }).from(runs).where(eq(runs.id, id)).limit(1))[0]
      ?.status ?? run.status

  if (currentStatus !== 'running' && currentStatus !== 'queued') {
    return c.json({ error: `Run is not cancellable (current status: ${currentStatus})` }, 400)
  }

  if (!(await claimRunCancellation(id, currentStatus))) {
    const latestStatus = (
      await db.select({ status: runs.status }).from(runs).where(eq(runs.id, id)).limit(1)
    )[0]?.status
    return c.json(
      { error: `Run is not cancellable (current status: ${latestStatus ?? 'unknown'})` },
      400,
    )
  }

  if (currentStatus === 'running') {
    const latestStep = (
      await db
        .select()
        .from(runSteps)
        .where(eq(runSteps.runId, id))
        .orderBy(desc(runSteps.order))
        .limit(1)
    )[0]

    const taskIdVariants = latestStep ? allTaskIdVariants(id, latestStep.id) : []
    if (latestStep) {
      await db
        .update(runSteps)
        .set({ status: 'cancelled' })
        .where(and(eq(runSteps.id, latestStep.id), eq(runSteps.status, 'running')))
    }
    cancelRunningTasksInBackground({
      runId: id,
      agentId: run.initiatorAgentId,
      taskIds: taskIdVariants,
    })
  }

  // A queued run owns no process, so its slot can be advanced immediately.
  if (run.initiatorAgentId && currentStatus === 'queued') {
    void scheduleNext(
      taskQueueDb,
      run.initiatorAgentId,
      (rid, aid) => void executeChatRun(aid, rid),
    )
  }

  logAudit(c, { action: 'run.cancel', resource: 'run', resourceId: id })

  logger.info({ runId: id, prevStatus: currentStatus }, 'Run cancelled')

  return c.json({ data: { runId: id, status: 'cancelled' } })
})

export default app
