import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  a2aSkillSchema,
  attachmentsInputSchema,
  chatAppConfigSchema,
  createAgentInput,
  discordConfigSchema,
  type GroupConfig,
  ghTriggerConfigSchema,
  glabTriggerConfigSchema,
  oauthAccessModeEnum,
  oauthAllowedEmailsSchema,
  publishAuthTypeEnum,
  publishChannelEnum,
  qqOfficialConfigSchema,
  scheduleConfigSchema,
  slackConfigSchema,
  updateAgentInput,
  worktreeCallParamsSchema,
} from '@a2wave/shared'
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { db } from '../db/client.js'
import {
  agentMembers,
  agents,
  chatMessages,
  kbDocuments,
  mcpServers,
  runSteps,
  runs,
  scmSources,
  skillGroups,
  skills,
  users,
} from '../db/schema.js'
import { engineRegistry } from '../engine/index.js'
import { buildTaskId } from '../engine/task-id.js'
import { tryAcquireSlot } from '../engine/task-queue.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import {
  getAgentPermission,
  getAgentReadFilter,
  requireAgentOwner,
  requireAgentRead,
  requireAgentWrite,
} from '../lib/agent-access.js'
import { collectAgentExecutionChecks } from '../lib/agent-execution-diagnose.js'
import { buildExportZip } from '../lib/agent-export.js'
import {
  buildAgentConfig,
  removePerAgentWorkspace,
  resolveCleanupWorkDirs,
  resolveEngineType,
  resolveWorkDir,
  validateAgentProviderConfiguration,
  WorktreeOccupiedError,
} from '../lib/agent-helpers.js'
import { importAgentFromUrl, importAgentFromZip } from '../lib/agent-import.js'
import { revokeAgentTokensForAgent } from '../lib/agent-memory-token.js'
import {
  effectiveProviderAuthMode,
  maskProviderChainConfig,
  preserveProviderChainSecrets,
} from '../lib/agent-provider-config.js'
import {
  deleteAgentWithBindingGuard,
  mutateAgentBinding,
} from '../lib/agent-scm-binding-mutation.js'
import { createShareToken } from '../lib/agent-share.js'
import { askerCountExpr } from '../lib/asker-identity.js'
import { extractStepAttachments, pairAttachmentsToMessages } from '../lib/attachment-history.js'
import {
  cleanupMaterializedRoot,
  materializeForRun,
  refsToSources,
} from '../lib/attachment-materializer.js'
import { logAudit } from '../lib/audit.js'
import { discordConnectionManager } from '../lib/discord-service.js'
import { type DiagnoseSeverity, runAgentFeishuDiagnose } from '../lib/feishu-diagnose.js'
import { feishuConnectionManager, normalizeFeishuConfig } from '../lib/feishu-service.js'
import { normalizeOauthAccessMode } from '../lib/gateway-auth-errors.js'
import { gitTriggerManager } from '../lib/git-trigger-manager.js'
import { WorktreeBranchLockedError, WorktreeDirtyError } from '../lib/git-workspace.js'
import { createId } from '../lib/id.js'
import { jsonExtractNumber, jsonExtractText } from '../lib/json-sql.js'
import { logger } from '../lib/logger.js'
import { canNonAdminUseMcp } from '../lib/mcp-stdio.js'
import { clearAgentIndex } from '../lib/memory-index.js'
import { removeAgentMemory, removeMemoryOverride } from '../lib/memory-storage.js'
import {
  isOauthAllowlistMissing,
  OAUTH_ALLOWED_EMAILS_REQUIRED,
  resolveOauthAllowedEmailsUpdate,
} from '../lib/oauth-publish.js'
import { getCurrentUserId, getOwnerFilter } from '../lib/owner-filter.js'
import { registerPendingContext } from '../lib/pending-job-registry.js'
import { qqOfficialConnectionManager } from '../lib/qq-official-service.js'
import {
  buildChatAppChannel,
  buildDebugChannel,
  stripReservedContextKeys,
} from '../lib/run-channel.js'
import { runWithLifecycle } from '../lib/run-launcher.js'
import { persistRunTurn, recoverRunStartup, releaseEphemeralWorktree } from '../lib/run-startup.js'
import type { ScheduleConfigInput } from '../lib/schedule-trigger.js'
import { scheduleTriggerManager } from '../lib/schedule-trigger.js'
import { withScmPathMutation } from '../lib/scm-path-plan.js'
import { canAgentOwnerUseSkill, canNonAdminUseSkill } from '../lib/skill-access.js'
import { slackConnectionManager } from '../lib/slack-service.js'
import {
  boundaryBucketSql,
  bucketCount,
  bucketSequence,
  bucketStartSql,
  localDaySequence,
  MAX_BUCKETS,
  MAX_TZ_OFFSET_SECONDS,
  zoneOffsetSecondsAt,
} from '../lib/time-buckets.js'
import { runTokenSelect, stepTokenSelect, toTokenTotals } from '../lib/token-stats.js'
import { isAdmin } from '../middleware/auth-middleware.js'
import type { WorkerTaskPayload } from '../worker/index.js'
import {
  filterBindableMcpIdsForClone,
  projectBindableSkillReferencesForClone,
} from './agent-clone-scope.js'
import {
  collectNativeChatConnectionChecks,
  gitTriggerPayloadMismatchError,
  gitTriggerPublishError,
  handleGitTriggerStatus,
  resyncGitTriggerAfterUpdate,
  syncGitTriggerChannels,
} from './agent-git-trigger.js'
import {
  handleQQOfficialRegistration,
  prepareQQOfficialPublishConfig,
  resumeQQOfficialConnection,
  syncQQOfficialConnectionAfterPublish,
} from './agent-qq-official.js'
import {
  preserveA2ARouteTargetSecrets,
  preserveSensitiveEnvSecrets,
} from './agent-route-secrets.js'
import { maskAgentSecrets } from './agent-secret-masking.js'
import { feishuConfigBodySchema } from './publish-feishu-config.js'

const app = new Hono()
const MEMORY_SKILL_NAME = 'a2wave-memory'
// Keepalive cadence for the chat SSE stream. Must stay well below the client's
// idle watchdog (STREAM_IDLE_TIMEOUT_MS = 120s) so a quiet-but-alive run never
// trips a false "connection lost".
const SSE_HEARTBEAT_INTERVAL_MS = 30_000
const MASKED_SECRET = '********'

/**
 * Resolve a masked channel secret against the stored one.
 *
 * The placeholder means "unchanged", so it restores the stored value — but when there is
 * none (a config row that exists with an empty secret), writing it through would make
 * '********' the credential itself: the channel fails to authenticate on every callback
 * while the edit page renders dots and reads as configured. Blanking keeps that state
 * honest, and the publish preflight already refuses to take a channel live on an empty
 * secret, so the failure surfaces where the user can act on it.
 */
const resolveMaskedChannelSecret = <T extends string | null | undefined>(
  submitted: T,
  stored: string | null | undefined,
): T | string => (submitted === MASKED_SECRET ? (stored ?? '') : submitted)

/**
 * Shared 400 body for a masked env value with no stored counterpart to restore.
 *
 * `code` is for direct API consumers only: `api.ts` builds its thrown Error from `error`
 * alone, so the web UI shows the prose and never reads the code. That matches the sibling
 * A2A masked-secret rejection below, which carries the same code for the same reason.
 */
const maskedEnvWithoutStoredValue = (key: string) =>
  ({
    error: `Environment variable '${key}' was sent masked but no stored value exists to restore. Re-enter its value.`,
    code: 'MASKED_SECRET_WITHOUT_STORED_VALUE',
  }) as const

/** Session user id, as set by the auth middleware. */
function getSessionUserId(c: Context): string {
  return c.get('userId' as never) as string
}

/**
 * Visibility scope for the chat history reads.
 *
 * Only the session-authenticated surfaces record the actual caller in
 * `runs.user_id`: chat_app and debug. Every other channel either leaves it NULL
 * (Feishu, gateway API key, OAuth) or stamps the agent owner (A2A, schedule,
 * Slack, Discord) — see the analysis on `getRunReadFilter` in agent-access.ts.
 *
 * So the scope is per-channel, not a bare `user_id = me`: the latter is never
 * true for a NULL, which would hide an Agent's entire production traffic from
 * its own owner — the very defect that filter was written to undo.
 *
 * What it does keep private is the part that needs it: a chat page turn is one
 * user's question, verbatim in `runs.intent`, and read permission on an Agent is
 * permission to *use* it, not to read what colleagues asked it.
 */
function chatHistoryScope(c: Context): SQL<unknown> {
  const me = getSessionUserId(c)
  return or(
    notInArray(runs.triggerSource, SESSION_SCOPED_TRIGGER_SOURCES),
    eq(runs.userId, me),
  ) as SQL<unknown>
}

/** Channels whose runs carry the calling user, and are therefore private to them. */
const SESSION_SCOPED_TRIGGER_SOURCES: Array<(typeof runs.triggerSource)['_']['data']> = [
  'chat_app',
  'debug',
]

async function findMemorySkill(): Promise<typeof skills.$inferSelect | undefined> {
  return (
    await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.name, MEMORY_SKILL_NAME),
          isNull(skills.userId),
          eq(skills.visibility, 'all-users'),
        ),
      )
      .limit(1)
  )[0]
}

export { maskAgentSecrets }

// --- Routes ---

app.get('/', async (c) => {
  const { page = '1', pageSize = '50' } = c.req.query()
  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize) || 50))
  const offset = (pageNum - 1) * limit

  const ownerFilter = getAgentReadFilter(c)
  const totalResult = (
    await db.select({ count: count() }).from(agents).where(ownerFilter).limit(1)
  )[0]
  const data = await db
    .select()
    .from(agents)
    .where(ownerFilter)
    // Pinned Agents come first; unpinned Agents use reverse creation order.
    .orderBy(sql`${agents.pinnedAt} IS NULL`, asc(agents.pinnedAt), desc(agents.createdAt))
    .limit(limit)
    .offset(offset)
  const total = totalResult?.count ?? 0

  // canManage mirrors the write permission used by pin routes so viewers never
  // receive a control that can only fail. Legacy null-owner Agents remain admin-only.
  const editorAgentIds = new Set<string>()
  const needsEditorLookup = data.filter(
    (a) => a.userId !== null && getAgentPermission(c, a) === null,
  )
  if (needsEditorLookup.length > 0) {
    const me = getCurrentUserId(c)
    const rows = await db
      .select({ agentId: agentMembers.agentId })
      .from(agentMembers)
      .where(
        and(
          eq(agentMembers.userId, me),
          eq(agentMembers.role, 'editor'),
          inArray(
            agentMembers.agentId,
            needsEditorLookup.map((a) => a.id),
          ),
        ),
      )
    for (const r of rows) editorAgentIds.add(r.agentId)
  }
  const canManage = (a: (typeof data)[number]): boolean =>
    getAgentPermission(c, a) === 'owner' || (a.userId !== null && editorAgentIds.has(a.id))

  return c.json({
    data: data.map((a) => ({ ...maskAgentSecrets(a), canManage: canManage(a) })),
    pagination: { total, page: pageNum, pageSize: limit, totalPages: Math.ceil(total / limit) },
  })
})

/** POST /agents/import — 上传 ZIP 导入 Agent */
app.post('/import', async (c) => {
  const body = await c.req.parseBody()
  const file = body.file
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'Upload a ZIP file (field name: file)' }, 400)
  }

  const arrayBuffer = await file.arrayBuffer()
  const zipBuffer = Buffer.from(arrayBuffer)
  const userId = getCurrentUserId(c)

  try {
    const result = await importAgentFromZip(zipBuffer, userId, isAdmin(c))
    logAudit(c, { action: 'agent.import', resource: 'agent', resourceId: result.agent.id })
    return c.json({ data: result }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed'
    return c.json({ error: message }, 400)
  }
})

/** POST /agents/import-url — 从远程 URL 导入 Agent */
app.post('/import-url', async (c) => {
  const body = await c.req.json()
  const schema = z.object({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  })
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const userId = getCurrentUserId(c)

  try {
    const result = await importAgentFromUrl(
      parsed.data.url,
      userId,
      parsed.data.headers,
      isAdmin(c),
    )
    logAudit(c, { action: 'agent.import-url', resource: 'agent', resourceId: result.agent.id })
    return c.json({ data: result }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed'
    return c.json({ error: message }, 400)
  }
})

/** GET /agents/feishu-connections — 本 API 进程内飞书长连接状态（socketOpen 为底层 WS 是否 OPEN） */
app.get('/feishu-connections', (c) => {
  const data = feishuConnectionManager.getFeishuConnectionStatuses()
  return c.json({
    data,
    meta: { scope: 'current_api_process' },
  })
})

/** GET /agents/chat-connections — native chat connection status in this API process. */
app.get('/chat-connections', (c) => {
  return c.json({
    data: {
      slack: slackConnectionManager.getConnectionStatuses(),
      discord: discordConnectionManager.getConnectionStatuses(),
      qqOfficial: qqOfficialConnectionManager.getConnectionStatuses(),
    },
    meta: { scope: 'current_api_process' },
  })
})

app.get('/:id/git-trigger/status', (c) => handleGitTriggerStatus(c, requireAgentWrite))

app.post('/:id/qq-official/registration', (c) => handleQQOfficialRegistration(c, requireAgentWrite))

/** GET /agents/:id/diagnose — Agent 综合诊断（执行引擎/Provider + 飞书与长连接等；WS 状态仅当前实例） */
app.get('/:id/diagnose', async (c) => {
  const { id } = c.req.param()
  const { agent } = await requireAgentRead(c, id)

  // peer 范围：以 *目标 agent 的 owner* 为锚点，不依赖 caller 身份。
  // 理由：member（editor/viewer）触发诊断时也应看到 owner 视角下的 peer 集合，
  // 否则诊断报告会显示为「caller 自己名下的 published agents」而不是 agent
  // 所属者的生态，产生误导。NULL-owner（legacy/system）agent 只允许 admin
  // 触发到此分支，回退为全局 published。
  const publishedWhere = agent.userId
    ? and(eq(agents.userId, agent.userId), eq(agents.publishStatus, 'published'))
    : eq(agents.publishStatus, 'published')
  const publishedAgents = await db.select().from(agents).where(publishedWhere)
  const publishedFeishuPeers = publishedAgents.filter((row) =>
    (row.publishChannels ?? []).includes('feishu'),
  )

  const wsRegistered = feishuConnectionManager.isRegistered(id)
  const wsSocketOpen = feishuConnectionManager.isSocketOpen(id)

  const executionChecks = await collectAgentExecutionChecks(agent)
  const feishuResult = await runAgentFeishuDiagnose({
    agent,
    publishedFeishuAgentsSameOwner: publishedFeishuPeers,
    wsRegistered,
    wsSocketOpen,
  })

  const nativeChatChecks = collectNativeChatConnectionChecks(agent)
  const mergedChecks = [...executionChecks, ...feishuResult.checks, ...nativeChatChecks]
  const hasError = mergedChecks.some((c) => c.severity === 'error')
  const severityOrder: Record<DiagnoseSeverity, number> = { error: 0, warn: 1, info: 2 }
  mergedChecks.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

  const data = {
    ok: !hasError,
    meta: feishuResult.meta,
    checks: mergedChecks,
  }

  logAudit(c, { action: 'agent.diagnose', resource: 'agent', resourceId: id })
  return c.json({ data })
})

/** GET /agents/:id - 获取单个 Agent */
app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const { agent, permission } = await requireAgentRead(c, id)
  const ownerSkillAudience = getAgentOwnerSkillAudience(agent.userId)
  // Plaintext secret reveal (feishu appSecret / provider OAuth token) is limited to
  // owner & editor. Viewers can read the agent but only see masked secrets — keeps the
  // plaintext exposure surface to members who can already edit the credentials anyway.
  const canRevealSecrets = permission !== 'viewer'
  return c.json({
    data: maskAgentSecrets(agent, {
      revealFeishuSecret: canRevealSecrets,
      revealNativeChatSecrets: canRevealSecrets,
      revealOauthToken: canRevealSecrets,
    }),
    meta: {
      permission,
      skillBindingScope: (await ownerSkillAudience).isActiveAdmin
        ? 'all-visible'
        : 'owner-or-shared',
    },
  })
})

type ChatAppGateAgent = {
  publishChannels: string[] | null
  publishStatus: string
  status: string
}

/**
 * Whether the chat page may RENDER for this Agent.
 *
 * A `stopped` Agent still resolves here on purpose: the page has a dedicated
 * "this Agent has been stopped" state, and showing that beats a generic
 * "page unavailable" for a link a colleague was legitimately given. Taking a
 * turn is blocked separately by `canTakeChatAppTurn`.
 *
 * `draft` does NOT resolve: `agent-import` preserves `chat_app` in
 * `publishChannels` while forcing `publishStatus: 'draft'`, so a channel-only
 * check would expose an imported Agent nobody has reviewed yet.
 */
function isChatAppViewable(agent: ChatAppGateAgent) {
  return (
    (agent.publishChannels ?? []).includes('chat_app') &&
    (agent.publishStatus === 'published' || agent.publishStatus === 'stopped')
  )
}

/**
 * Whether a chat page turn may execute. Requires the channel plus a genuinely
 * published Agent, mirroring the native chat channels (see `native-chat-runner`),
 * so stopping an Agent immediately halts new turns.
 */
function canTakeChatAppTurn(agent: ChatAppGateAgent) {
  return (
    (agent.publishChannels ?? []).includes('chat_app') &&
    agent.publishStatus === 'published' &&
    // The page already disables its composer for an inactive Agent, but that is a
    // UI courtesy — the endpoint is reachable directly, so the same condition has
    // to hold server-side or an inactive Agent can still be made to execute.
    agent.status === 'active'
  )
}

/**
 * GET /:id/chat-app - Profile shown beside the chat app page's conversation pane.
 *
 * Deliberately NOT anonymous: the caller must be a signed-in a2wave user with read
 * access, so every visitor is attributable (Iron Rule 5). This returns only the
 * presentation fields the page renders — never credentials or channel configs —
 * so it stays safe to call from a link that gets forwarded around.
 *
 * 404 (not 403) when the channel is disabled: a link whose channel was turned off
 * should read as "no such page", not as "exists but you can't have it".
 */
app.get('/:id/chat-app', async (c) => {
  const { id } = c.req.param()
  const { agent } = await requireAgentRead(c, id)

  // Both conditions, matching every other channel (see native-chat-runner): an
  // Agent imported as a draft can carry chat_app in publishChannels, and without
  // the publishStatus check it would serve a live page before anyone reviewed it.
  if (!isChatAppViewable(agent)) {
    return c.json({ error: 'Chat app is not enabled for this Agent' }, 404)
  }

  const config = agent.chatAppConfig ?? {}
  // `showCreator: false` is a privacy choice, so it is honoured here rather than
  // by hiding a name the response still carried: the page is shared broadly and
  // anyone could read the payload straight off the wire. Skipping the lookup
  // also spares a query nobody will use.
  const showCreator = config.showCreator ?? true
  const creator =
    showCreator && agent.userId
      ? (
          await db
            .select({ username: users.username, displayName: users.displayName })
            .from(users)
            .where(eq(users.id, agent.userId))
            .limit(1)
        )[0]
      : undefined

  return c.json({
    data: {
      id: agent.id,
      name: config.displayName?.trim() || agent.name,
      description: agent.publishDescription || agent.description || null,
      icon: agent.icon,
      status: agent.status,
      publishStatus: agent.publishStatus,
      createdAt: agent.createdAt,
      creator: creator ? { name: creator.displayName || creator.username } : null,
      welcomeMessage: config.welcomeMessage ?? null,
      suggestedQuestions: config.suggestedQuestions ?? [],
      showCreator,
      allowAttachments: config.allowAttachments ?? true,
      showThinking: config.showThinking ?? true,
    },
  })
})

/** GET /:id/stats - Per-agent KPIs, askers, channels, and token totals. */
app.get('/:id/stats', async (c) => {
  const { id } = c.req.param()

  // Same visibility contract as GET /:id: owner/editor/viewer can read.
  await requireAgentRead(c, id)

  // Once the caller can read the agent, stats should cover that agent's runs
  // regardless of who originally created each run.
  const baseWhere = eq(runs.initiatorAgentId, id)

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Status counts
  const statusRows = await db
    .select({ status: runs.status, cnt: count() })
    .from(runs)
    .where(baseWhere)
    .groupBy(runs.status)
  const byStatus = { completed: 0, failed: 0, running: 0, pending: 0, queued: 0, cancelled: 0 }
  let total = 0
  for (const row of statusRows) {
    const s = row.status as keyof typeof byStatus
    if (s in byStatus) byStatus[s] = row.cnt
    total += row.cnt
  }

  // Today's runs
  const todayResult = (
    await db
      .select({ cnt: count() })
      .from(runs)
      .where(and(baseWhere, gte(runs.createdAt, today)))
      .limit(1)
  )[0]
  const todayRuns = todayResult?.cnt ?? 0

  // Average duration (completed only)
  const durationResult = (
    await db
      .select({ avg: sql<number | null>`AVG(${jsonExtractNumber(runs.result, ['durationMs'])})` })
      .from(runs)
      .where(and(baseWhere, eq(runs.status, 'completed')))
      .limit(1)
  )[0]
  const avgDuration = durationResult?.avg != null ? Math.round(durationResult.avg) : 0
  const successRate = total > 0 ? Math.round((byStatus.completed / total) * 100) : 0

  // Distinct asker count — same rule as the trend chart on this page, so the
  // two can never disagree. See lib/asker-identity.ts.
  const askerResult = (
    await db.select({ cnt: askerCountExpr() }).from(runs).where(baseWhere).limit(1)
  )[0]
  const askerCount = askerResult?.cnt ?? 0

  // Top askers. Only rows carrying a display name can be *listed* — a bare
  // user_id has no name to show — but they are still counted above, so the
  // list may legitimately be shorter than the headline number.
  const topAskerRows = await db
    .select({ name: runs.triggerUserName, cnt: count() })
    .from(runs)
    .where(and(baseWhere, isNotNull(runs.triggerUserName)))
    .groupBy(runs.triggerUserName)
    .orderBy(desc(count()))
    .limit(5)
  const topAskers = topAskerRows.map((r) => ({ name: r.name as string, count: r.cnt }))

  // Channel breakdown — group by trigger_source INCLUDING NULL so the sum
  // matches `total`. Legacy runs predating the channel-context rollout have
  // NULL triggerSource and are surfaced as a single "unknown" bucket; without
  // it the overview's percentage bars wouldn't add up to 100% of total runs.
  const channelRows = await db
    .select({ source: runs.triggerSource, cnt: count() })
    .from(runs)
    .where(baseWhere)
    .groupBy(runs.triggerSource)
  const channelBreakdown = channelRows.map((r) => ({
    source: (r.source as string | null) ?? 'unknown',
    count: r.cnt,
  }))

  // Aggregate tokens across this agent's runs using the shared metric definition.
  const tokens = toTokenTotals(
    (await db.select(runTokenSelect()).from(runs).where(baseWhere).limit(1))[0],
  )

  return c.json({
    total,
    successRate,
    avgDuration,
    todayRuns,
    byStatus,
    askerCount,
    topAskers,
    channelBreakdown,
    tokens,
  })
})

/**
 * A calendar date that actually exists.
 *
 * The shape regex alone accepts `2026-13-45` and `2026-02-31`; `Date.parse` then
 * yields NaN (or silently rolls over), the bucket loop never iterates, and the
 * handler returns an empty 200 that the UI renders as "no data in this range" —
 * a malformed request misreported as a quiet agent. Round-tripping through
 * `toISOString()` rejects both cases at the boundary instead.
 */
const calendarDate = (field: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} must be YYYY-MM-DD`)
    .refine(
      (s) => {
        // Guard the parse itself: `new Date('2026-13-45T00:00:00Z')` is an
        // Invalid Date, and calling toISOString() on it throws a RangeError,
        // which would surface as a 500 instead of the intended 400.
        const ms = Date.parse(`${s}T00:00:00Z`)
        return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(s)
      },
      { message: `${field} is not a real calendar date` },
    )

/** Query contract for the per-agent time series. */
const timeseriesQuerySchema = z
  .object({
    from: calendarDate('from'),
    to: calendarDate('to'),
    bucket: z.enum(['day', 'hour']).default('day'),
    // Viewer's UTC offset in seconds (`-getTimezoneOffset() * 60`). It reaches
    // SQL as a bound number, but bound it anyway so bad input fails loudly
    // instead of silently shifting every bucket.
    tzOffset: z.coerce
      .number()
      .int()
      .min(-MAX_TZ_OFFSET_SECONDS)
      .max(MAX_TZ_OFFSET_SECONDS)
      .default(0),
    // IANA zone (e.g. 'America/Los_Angeles'). Preferred over tzOffset for day
    // buckets: a single offset cannot express a range crossing a DST switch,
    // where every later boundary shifts an hour and the transition day is 23 or
    // 25 hours long. tzOffset remains the fallback for clients that omit it and
    // stays exact for hour buckets, which DST does not distort.
    tz: z.string().min(1).max(64).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to' })

const EMPTY_STATUS_COUNTS = {
  completed: 0,
  failed: 0,
  running: 0,
  pending: 0,
  queued: 0,
  cancelled: 0,
} as const

/**
 * GET /:id/stats/timeseries - Bucketed run/asker/token/latency series.
 *
 * Deliberately separate from /:id/stats rather than an extension of it: the
 * range selector refetches on every preset click, and the scalar KPIs above the
 * chart are range-independent, so re-running them would be pure waste.
 */
app.get('/:id/stats/timeseries', async (c) => {
  const { id } = c.req.param()
  await requireAgentRead(c, id)

  const parsed = timeseriesQuerySchema.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const { from, to, bucket, tzOffset, tz } = parsed.data

  // Interpret the calendar dates against the viewer's offset so the query window
  // and the bucket boundaries share one definition of "a day". The window edges
  // use the offset in force on each edge's own date, so a range that crosses a
  // DST switch still starts and ends at real local midnight.
  const fromEdge = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000)
  const toEdge = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000)
  const fromOffset = tz ? (zoneOffsetSecondsAt(tz, fromEdge - tzOffset) ?? tzOffset) : tzOffset
  const toOffset = tz ? (zoneOffsetSecondsAt(tz, toEdge - tzOffset) ?? tzOffset) : tzOffset
  const fromSeconds = fromEdge - fromOffset
  const toSeconds = toEdge - toOffset

  // Count first, allocate second. bucketSequence() would happily materialize
  // ~79M numbers for `bucket=hour&from=1000-01-01&to=9999-12-31` before the
  // guard below could reject it, turning a would-be 400 into an OOM that takes
  // down every in-flight run. bucketCount() answers the same question in O(1).
  const bucketTotal = bucketCount(fromSeconds, toSeconds, bucket, tzOffset)
  if (bucketTotal > MAX_BUCKETS) {
    return c.json({ error: `Range spans ${bucketTotal} buckets, max is ${MAX_BUCKETS}` }, 400)
  }

  // Day buckets follow real local midnights when a zone is supplied, so a
  // transition day is 23 or 25 hours rather than a fixed 86400. Hour buckets
  // are unaffected by DST, and a missing/unusable zone falls back to the
  // single-offset arithmetic.
  const localDays = bucket === 'day' && tz ? localDaySequence(fromSeconds, toSeconds, tz) : null
  const buckets = localDays ?? bucketSequence(fromSeconds, toSeconds, bucket, tzOffset)

  const fromDate = new Date(fromSeconds * 1000)
  const toDate = new Date(toSeconds * 1000)
  const runBucket = localDays
    ? boundaryBucketSql(runs.createdAt, localDays)
    : bucketStartSql(runs.createdAt, bucket, tzOffset)
  const stepBucket = localDays
    ? boundaryBucketSql(runSteps.createdAt, localDays)
    : bucketStartSql(runSteps.createdAt, bucket, tzOffset)
  const runWindow = and(
    eq(runs.initiatorAgentId, id),
    gte(runs.createdAt, fromDate),
    lte(runs.createdAt, toDate),
  )
  // Steps are filtered by their OWN timestamp but scoped through runs:
  // runSteps.agentId is the *executing* agent and is nullable, so filtering on
  // it would drop legacy rows and misattribute delegated sub-agent steps.
  const stepWindow = and(
    eq(runs.initiatorAgentId, id),
    gte(runSteps.createdAt, fromDate),
    lte(runSteps.createdAt, toDate),
  )

  const runRows = await db
    .select({ bucket: runBucket, status: runs.status, cnt: count() })
    .from(runs)
    .where(runWindow)
    .groupBy(runBucket, runs.status)

  // Shared with the headline count and Top Askers on the same page — see
  // lib/asker-identity.ts for why the rule is what it is.
  const askerRows = await db
    .select({ bucket: runBucket, cnt: askerCountExpr() })
    .from(runs)
    .where(runWindow)
    .groupBy(runBucket)

  // Tokens come from run_steps so a multi-turn conversation attributes each turn
  // to the day it happened, matching the todayTokens precedent in runs.ts.
  const tokenRows = await db
    .select({ bucket: stepBucket, ...stepTokenSelect() })
    .from(runSteps)
    .innerJoin(runs, eq(runSteps.runId, runs.id))
    .where(stepWindow)
    .groupBy(stepBucket)

  // Latency is per TURN (run_steps.duration_ms), not per run — a real column, so
  // no JSON extraction. Completed turns only, so partial failures don't drag the
  // mean. This is a different measure from the per-run avgDuration KPI.
  const durationRows = await db
    .select({
      bucket: stepBucket,
      avgMs: sql<number | null>`AVG(${runSteps.durationMs})`,
      samples: sql<number>`COUNT(${runSteps.durationMs})`,
    })
    .from(runSteps)
    .innerJoin(runs, eq(runSteps.runId, runs.id))
    .where(and(stepWindow, eq(runSteps.status, 'completed')))
    .groupBy(stepBucket)

  const statusByBucket = new Map<number, Record<string, number>>()
  for (const row of runRows) {
    const entry = statusByBucket.get(row.bucket) ?? { ...EMPTY_STATUS_COUNTS }
    if (row.status in entry) entry[row.status] = row.cnt
    statusByBucket.set(row.bucket, entry)
  }
  const askersByBucket = new Map(askerRows.map((r) => [r.bucket, r.cnt]))
  const tokensByBucket = new Map(tokenRows.map((r) => [r.bucket, toTokenTotals(r)]))
  const durationByBucket = new Map(durationRows.map((r) => [r.bucket, r]))

  // Gap-fill on the server: doing it client-side would mean duplicating the
  // offset arithmetic, which is the bug class this design exists to avoid.
  const points = buckets.map((ts) => {
    const statuses = statusByBucket.get(ts) ?? { ...EMPTY_STATUS_COUNTS }
    const duration = durationByBucket.get(ts)
    return {
      ts: new Date(ts * 1000).toISOString(),
      runs: statuses,
      total: Object.values(statuses).reduce((sum, n) => sum + n, 0),
      askers: askersByBucket.get(ts) ?? 0,
      tokens: tokensByBucket.get(ts) ?? toTokenTotals(undefined),
      // null, never 0 — "no requests" and "0ms responses" are different claims.
      avgDurationMs: duration?.avgMs != null ? Math.round(duration.avgMs) : null,
      durationSamples: duration?.samples ?? 0,
    }
  })

  return c.json({ bucket, from, to, points })
})

const SCM_INITIAL_SYNC_REQUIRED_MSG = 'SCM_INITIAL_SYNC_REQUIRED'

/** Validate newly-added admin-only MCP bindings for non-admin callers. */
async function checkAdminOnlyMcpAccess(
  c: import('hono').Context,
  mcpServerIds: string[] | null | undefined,
  existingIds: string[] | null = null,
): Promise<string | null> {
  const role = c.get('userRole' as never) as string
  if (role === 'admin' || !mcpServerIds?.length) return null
  const idsToCheck = existingIds
    ? mcpServerIds.filter((id) => !existingIds.includes(id))
    : mcpServerIds
  if (idsToCheck.length === 0) return null
  const me = getCurrentUserId(c)
  const candidates = await db
    .select({
      id: mcpServers.id,
      type: mcpServers.type,
      groupConfig: mcpServers.groupConfig,
      usageScope: mcpServers.usageScope,
      userId: mcpServers.userId,
    })
    .from(mcpServers)
    .where(inArray(mcpServers.id, idsToCheck))
  // A non-admin may bind only their OWN server, or a genuinely shared one
  // (all-users AND owned by an admin, or a userId===null builtin). usage_scope
  // encodes "stdio ⇒ admin-only", so no stdio re-derivation is needed. Binding
  // another non-admin's server (even sse/http) is an IDOR — the runtime would
  // resolve its URL/headers/env (private credentials) under this agent.
  const blocked = candidates.filter(
    (s) =>
      !canNonAdminUseMcp(
        {
          type: s.type,
          groupConfig: s.groupConfig as GroupConfig | null,
          usageScope: s.usageScope,
          userId: s.userId,
        },
        me,
      ),
  )
  // Any requested id that didn't resolve to a row is also unbindable (not found
  // / not visible) — surface it rather than silently dropping it.
  const foundIds = new Set(candidates.map((s) => s.id))
  const missing = idsToCheck.filter((id) => !foundIds.has(id))
  if (blocked.length > 0 || missing.length > 0) {
    const bad = [...new Set([...blocked.map((s) => s.id), ...missing])]
    return `MCP servers not assignable (admin-only, stdio, or not owned by you): ${bad.join(', ')}`
  }
  return null
}

/**
 * Drop MCP server ids the given caller may NOT bind from a cloned agent's list:
 * admin-only, stdio-capable, OR owned by someone else. Clone hands the new agent
 * to the caller, so it must not carry servers `checkAdminOnlyMcpAccess` would
 * reject for them — otherwise a non-admin editor clones a shared agent and keeps
 * its stdio (host-RCE) MCP, or another owner's private SSE/HTTP MCP (with its
 * credentials), even after their membership is revoked. Admins keep everything.
 * Returns the filtered id list (order preserved) — a stray id simply drops.
 */
/**
 * Validate newly attached direct Skill ids. Existing ids use the same diff-only
 * semantics as MCP/KB resources so an editor can still save unrelated fields.
 */
type AgentOwnerSkillAudience = {
  userId: string | null
  isActiveAdmin: boolean
}

async function getAgentOwnerSkillAudience(userId: string | null): Promise<AgentOwnerSkillAudience> {
  const owner = userId
    ? (
        await db
          .select({ role: users.role, isActive: users.isActive })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
      )[0]
    : undefined
  return {
    userId,
    isActiveAdmin: owner?.role === 'admin' && owner.isActive === true,
  }
}

async function checkSkillAccess(
  c: import('hono').Context,
  skillIds: string[] | null | undefined,
  existingIds: string[] | null = null,
  agentOwnerAudience?: AgentOwnerSkillAudience,
): Promise<string | null> {
  if (!skillIds?.length) return null
  const idsToCheck = existingIds ? skillIds.filter((id) => !existingIds.includes(id)) : skillIds
  if (idsToCheck.length === 0) return null

  const callerId = getCurrentUserId(c)
  const rows = await db
    .select({ id: skills.id, userId: skills.userId, visibility: skills.visibility })
    .from(skills)
    .where(inArray(skills.id, idsToCheck))
  const allowed = new Set(
    rows
      .filter(
        (row) =>
          (isAdmin(c) || canNonAdminUseSkill(row, callerId)) &&
          (!agentOwnerAudience ||
            canAgentOwnerUseSkill(
              row,
              agentOwnerAudience.userId,
              agentOwnerAudience.isActiveAdmin,
            )),
      )
      .map((row) => row.id),
  )
  const blocked = idsToCheck.filter((id) => !allowed.has(id))
  return blocked.length > 0 ? `Skills not assignable or not visible: ${blocked.join(', ')}` : null
}

/**
 * A new group on an Agent without an active-admin owner must belong to that owner, and
 * every current member must pass the same runtime owner rule. Ownership keeps
 * the binding safe after later membership edits; the snapshot check handles
 * legacy/admin-authored groups that are already inconsistent today.
 */
async function checkSkillGroupAccessForAgentOwner(
  groupIds: string[] | null | undefined,
  existingIds: string[] | null,
  agentOwnerAudience: AgentOwnerSkillAudience | undefined,
): Promise<string | null> {
  if (!agentOwnerAudience || !groupIds?.length) return null
  const idsToCheck = existingIds ? groupIds.filter((id) => !existingIds.includes(id)) : groupIds
  if (idsToCheck.length === 0) return null
  if (agentOwnerAudience.isActiveAdmin) return null

  const rows = await db
    .select({ id: skillGroups.id, userId: skillGroups.userId })
    .from(skillGroups)
    .where(inArray(skillGroups.id, idsToCheck))
  const ownerGroupIds = new Set(
    rows.filter((row) => row.userId === agentOwnerAudience.userId).map((row) => row.id),
  )
  const blocked = idsToCheck.filter((groupId) => !ownerGroupIds.has(groupId))
  if (blocked.length > 0) {
    return `Skill groups not owned by the Agent owner: ${blocked.join(', ')}`
  }

  const groupSkills = await db
    .select({ userId: skills.userId, visibility: skills.visibility })
    .from(skills)
    .where(inArray(skills.groupId, idsToCheck))
  const hasBlockedSkill = groupSkills.some(
    (row) =>
      !canAgentOwnerUseSkill(row, agentOwnerAudience.userId, agentOwnerAudience.isActiveAdmin),
  )
  return hasBlockedSkill
    ? 'Selected Skill groups contain Skills unavailable to the Agent owner'
    : null
}

/**
 * Project Skill references onto the clone's new owner.
 *
 * A non-admin may retain only groups they own. When cloning an Agent shared by
 * someone else, however, dropping a foreign group must not also discard its
 * all-users or caller-owned Skills: those Skills remain bindable and are
 * flattened into the clone's direct Skill ids. Foreign private Skills stay
 * excluded, and Skills from retained groups are not duplicated as direct refs.
 */
/** Validate newly-added KB document ids against caller visibility. */
async function validateKbDocumentIds(
  c: import('hono').Context,
  ids: string[] | undefined,
  existingIds: string[] | null = null,
): Promise<string | null> {
  if (!ids || ids.length === 0) return null
  const idsToCheck = existingIds ? ids.filter((id) => !existingIds.includes(id)) : ids
  if (idsToCheck.length === 0) return null
  const ownerFilter = getOwnerFilter(c, kbDocuments.userId)
  const condition = ownerFilter
    ? and(inArray(kbDocuments.id, idsToCheck), ownerFilter)
    : inArray(kbDocuments.id, idsToCheck)
  const docs = await db.select({ id: kbDocuments.id }).from(kbDocuments).where(condition)
  const foundIds = new Set(docs.map((d) => d.id))
  const missing = idsToCheck.filter((id) => !foundIds.has(id))
  if (missing.length > 0) {
    return `KB documents not found: ${missing.join(', ')}`
  }
  return null
}

/** Validate newly-added Skill group ids against caller visibility. */
async function validateSkillGroupIds(
  c: import('hono').Context,
  ids: string[] | undefined,
  existingIds: string[] | null = null,
): Promise<string | null> {
  if (!ids || ids.length === 0) return null
  const idsToCheck = existingIds ? ids.filter((id) => !existingIds.includes(id)) : ids
  if (idsToCheck.length === 0) return null
  const ownerFilter = getOwnerFilter(c, skillGroups.userId)
  const condition = ownerFilter
    ? and(inArray(skillGroups.id, idsToCheck), ownerFilter)
    : inArray(skillGroups.id, idsToCheck)
  const rows = await db.select({ id: skillGroups.id }).from(skillGroups).where(condition)
  const foundIds = new Set(rows.map((r) => r.id))
  const missing = idsToCheck.filter((id) => !foundIds.has(id))
  if (missing.length > 0) {
    return `Skill groups not found: ${missing.join(', ')}`
  }
  return null
}

/** POST /agents - 创建 Agent */
app.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = createAgentInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const mcpError = await checkAdminOnlyMcpAccess(c, parsed.data.mcpServerIds)
  if (mcpError) return c.json({ error: mcpError }, 403)

  const skillError = await checkSkillAccess(c, parsed.data.skills)
  if (skillError) return c.json({ error: skillError }, 403)

  const workspaceType = parsed.data.workspaceType ?? 'temp'
  const scmSourceId = parsed.data.scmSourceId ?? null
  if (workspaceType === 'scm' && scmSourceId) {
    const source = (
      await db.select().from(scmSources).where(eq(scmSources.id, scmSourceId)).limit(1)
    )[0]
    if (!source) {
      return c.json({ error: 'SCM source not found' }, 400)
    }
    if (source.initialSyncCompletedAt == null) {
      return c.json({ error: SCM_INITIAL_SYNC_REQUIRED_MSG }, 400)
    }
  }

  const userId = getCurrentUserId(c)

  const kbError = await validateKbDocumentIds(c, parsed.data.kbDocumentIds)
  if (kbError) return c.json({ error: kbError }, 400)

  const groupError = await validateSkillGroupIds(c, parsed.data.skillGroupIds)
  if (groupError) return c.json({ error: groupError }, 400)

  // Creation and update share the same complete group check: accepting the
  // group id alone is insufficient when an administrator has placed a private
  // foreign Skill inside a user-owned group.
  const groupAccessError = await checkSkillGroupAccessForAgentOwner(
    parsed.data.skillGroupIds,
    null,
    {
      userId,
      isActiveAdmin: isAdmin(c),
    },
  )
  if (groupAccessError) return c.json({ error: groupAccessError }, 403)

  // Nothing is stored yet, so a masked sensitive value is an echoed placeholder (a
  // cloned draft, say) with no counterpart — and no secret it could strand. It is
  // blanked rather than rejected, which is why this never fails on create; the point
  // is only that the literal placeholder must not reach the database.
  const envRestore = preserveSensitiveEnvSecrets(parsed.data.env, null)
  if (!envRestore.ok) {
    return c.json(maskedEnvWithoutStoredValue(envRestore.key), 400)
  }

  const id = createId('agt')
  const authMode = await effectiveProviderAuthMode(parsed.data.providerId, parsed.data.authMode)
  const insertAgent = async (executor: typeof db) =>
    (
      await executor
        .insert(agents)
        .values({
          id,
          // `createAgentInput` omits this, and drizzle would otherwise bind the column's retired
          // default into the INSERT — re-seeding rows on the value 0100 exists to remove.
          oauthAccessMode: 'all_idaas_users',
          ...parsed.data,
          env: envRestore.value,
          authMode,
          userId,
        })
        .returning()
    )[0]

  // Binding and SCM deletion reservation share one lifecycle lock. The earlier
  // lookup gives a useful validation error, while this authoritative lookup in
  // the write transaction closes the read-to-insert race across API replicas.
  const bindingResult =
    workspaceType === 'scm' && scmSourceId
      ? await withScmPathMutation(async (tx) => {
          const source = (
            await tx
              .select()
              .from(scmSources)
              .where(and(eq(scmSources.id, scmSourceId), isNull(scmSources.deletionRequestedAt)))
              .limit(1)
          )[0]
          if (!source || source.initialSyncCompletedAt == null) {
            return { allowed: false as const, agent: undefined }
          }
          return { allowed: true as const, agent: await insertAgent(tx as typeof db) }
        })
      : { allowed: true as const, agent: await insertAgent(db) }
  if (!bindingResult.allowed) {
    return c.json({ error: 'SCM source is unavailable or has not completed initial sync' }, 409)
  }
  const newAgent = bindingResult.agent

  logAudit(c, { action: 'agent.create', resource: 'agent', resourceId: id })

  return c.json({ data: maskAgentSecrets(newAgent) }, 201)
})

/** PATCH /agents/:id - 更新 Agent */
app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  const parsed = updateAgentInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { agent: existing } = await requireAgentWrite(c, id)

  const badGitConfig = gitTriggerPayloadMismatchError(parsed.data)
  if (badGitConfig) return c.json(badGitConfig, 400)

  let agentOwnerAudience: AgentOwnerSkillAudience | undefined
  const hasNewDirectSkills = parsed.data.skills?.some(
    (skillId) => !existing.skills?.includes(skillId),
  )
  const hasNewSkillGroups = parsed.data.skillGroupIds?.some(
    (groupId) => !existing.skillGroupIds?.includes(groupId),
  )
  if (hasNewDirectSkills || hasNewSkillGroups) {
    agentOwnerAudience = await getAgentOwnerSkillAudience(existing.userId)
  }

  // Diff-only validators: only newly-added IDs are checked. Existing IDs already on the
  // record are passed through unchanged so editor members (who may not own every attached
  // resource) can still PATCH unrelated fields without re-validating prior attachments.
  const mcpError = await checkAdminOnlyMcpAccess(c, parsed.data.mcpServerIds, existing.mcpServerIds)
  if (mcpError) return c.json({ error: mcpError }, 403)

  const skillError = await checkSkillAccess(
    c,
    parsed.data.skills,
    existing.skills,
    agentOwnerAudience,
  )
  if (skillError) return c.json({ error: skillError }, 403)

  const scmSourceId = parsed.data.scmSourceId
  if (scmSourceId !== undefined && scmSourceId !== null && scmSourceId !== existing.scmSourceId) {
    const source = (
      await db.select().from(scmSources).where(eq(scmSources.id, scmSourceId)).limit(1)
    )[0]
    if (!source) {
      return c.json({ error: 'SCM source not found' }, 400)
    }
    if (source.initialSyncCompletedAt == null) {
      return c.json({ error: SCM_INITIAL_SYNC_REQUIRED_MSG }, 400)
    }
  }

  const kbError = await validateKbDocumentIds(c, parsed.data.kbDocumentIds, existing.kbDocumentIds)
  if (kbError) return c.json({ error: kbError }, 400)

  const groupError = await validateSkillGroupIds(
    c,
    parsed.data.skillGroupIds,
    existing.skillGroupIds,
  )
  if (groupError) return c.json({ error: groupError }, 400)

  const groupAccessError = await checkSkillGroupAccessForAgentOwner(
    parsed.data.skillGroupIds,
    existing.skillGroupIds,
    agentOwnerAudience,
  )
  if (groupAccessError) return c.json({ error: groupAccessError }, 403)

  // Preserve existing sensitive env values when frontend sends '********' (masked placeholder).
  // A masked value with no stored counterpart — a renamed key, most often — is rejected rather
  // than written through, which would replace the real secret with the literal placeholder.
  const envRestore = preserveSensitiveEnvSecrets(parsed.data.env, existing.env)
  if (!envRestore.ok) {
    return c.json(maskedEnvWithoutStoredValue(envRestore.key), 400)
  }
  const envToSave = envRestore.value

  // Provider credential placeholders: client may echo '********' from masked chain rows.
  // Treat them as "keep existing" for top-level legacy columns too.
  let providerApiKeyToSave = parsed.data.providerApiKey
  if (providerApiKeyToSave === '********') {
    providerApiKeyToSave = existing.providerApiKey
  }

  let providerBaseUrlToSave = parsed.data.providerBaseUrl
  if (providerBaseUrlToSave === '********') {
    providerBaseUrlToSave = existing.providerBaseUrl
  }

  let providerOauthTokenToSave = parsed.data.providerOauthToken
  if (providerOauthTokenToSave === '********') {
    providerOauthTokenToSave = existing.providerOauthToken
  }
  let memoryProviderApiKeyToSave = parsed.data.memoryProviderApiKey
  if (memoryProviderApiKeyToSave === '********') {
    memoryProviderApiKeyToSave = existing.memoryProviderApiKey
  }
  let embeddingApiKeyToSave = parsed.data.embeddingApiKey
  if (embeddingApiKeyToSave === '********') {
    embeddingApiKeyToSave = existing.embeddingApiKey
  }
  const providerCredentialFields: {
    providerApiKey?: typeof providerApiKeyToSave
    providerBaseUrl?: typeof providerBaseUrlToSave
    providerOauthToken?: typeof providerOauthTokenToSave
  } = {}
  if (parsed.data.providerApiKey !== undefined) {
    providerCredentialFields.providerApiKey = providerApiKeyToSave
  }
  if (parsed.data.providerBaseUrl !== undefined) {
    providerCredentialFields.providerBaseUrl = providerBaseUrlToSave
  }
  if (parsed.data.providerOauthToken !== undefined) {
    providerCredentialFields.providerOauthToken = providerOauthTokenToSave
  }

  // Normalize (legacy → new format) then preserve existing secret when '********'
  let feishuConfigToSave = parsed.data.feishuConfig
    ? normalizeFeishuConfig(parsed.data.feishuConfig as Record<string, unknown>)
    : parsed.data.feishuConfig
  if (feishuConfigToSave?.appSecret === MASKED_SECRET) {
    const storedFeishuSecret = (existing.feishuConfig as { appSecret?: string } | null)?.appSecret
    feishuConfigToSave = { ...feishuConfigToSave, appSecret: storedFeishuSecret ?? '' }
  }
  let slackConfigToSave = parsed.data.slackConfig
  if (slackConfigToSave) {
    slackConfigToSave = {
      ...slackConfigToSave,
      appToken: resolveMaskedChannelSecret(
        slackConfigToSave.appToken,
        existing.slackConfig?.appToken,
      ),
      botToken: resolveMaskedChannelSecret(
        slackConfigToSave.botToken,
        existing.slackConfig?.botToken,
      ),
    }
  }
  let discordConfigToSave = parsed.data.discordConfig
  if (discordConfigToSave) {
    discordConfigToSave = {
      ...discordConfigToSave,
      botToken: resolveMaskedChannelSecret(
        discordConfigToSave.botToken,
        existing.discordConfig?.botToken,
      ),
    }
  }
  let qqOfficialConfigToSave = parsed.data.qqOfficialConfig
  if (qqOfficialConfigToSave) {
    qqOfficialConfigToSave = {
      ...qqOfficialConfigToSave,
      appSecret: resolveMaskedChannelSecret(
        qqOfficialConfigToSave.appSecret,
        existing.qqOfficialConfig?.appSecret,
      ),
    }
  }

  const a2aRouteTargetsToSave = preserveA2ARouteTargetSecrets(
    parsed.data.a2aRouteTargets,
    existing.a2aRouteTargets,
  )
  if (!a2aRouteTargetsToSave.ok) {
    return c.json(
      {
        error: `Remote A2A target '${a2aRouteTargetsToSave.targetName}' sent a masked API key without a matching stored value.`,
        code: 'MASKED_SECRET_WITHOUT_STORED_VALUE',
      },
      400,
    )
  }

  const configAfterChain = await preserveProviderChainSecrets(
    parsed.data.config as Record<string, unknown> | null | undefined,
    existing,
  )
  // Strip keys that now live in dedicated columns — prevents legacy clients
  // from creating stale duplicates inside the config JSON blob.
  const configToSave = configAfterChain
    ? (() => {
        const { memoryProviderApiKey: _, embeddingApiKey: __, ...rest } = configAfterChain
        return rest as typeof configAfterChain
      })()
    : configAfterChain

  // PATCH omission preserves the current mode. Switching the legacy/top-level
  // Provider without an explicit mode starts from the new Provider manifest's
  // default instead of inheriting an unrelated Provider's choice.
  const authModeToSave =
    parsed.data.authMode ??
    (parsed.data.providerId !== undefined && parsed.data.providerId !== existing.providerId
      ? await effectiveProviderAuthMode(parsed.data.providerId, undefined)
      : undefined)

  // Auto-mount/unmount a2wave-memory skill when memoryEnabled changes.
  const existingConfig = (existing.config || {}) as Record<string, unknown>
  const newConfig = configToSave as Record<string, unknown> | undefined
  let shouldRemoveMemoryOverrides = false
  if (newConfig && 'memoryEnabled' in newConfig) {
    const wasEnabled = !!existingConfig.memoryEnabled
    const nowEnabled = !!newConfig.memoryEnabled
    if (nowEnabled && !wasEnabled) {
      const memorySkill = await findMemorySkill()
      if (memorySkill) {
        const currentSkills =
          (parsed.data.skills as string[] | null) || (existing.skills as string[] | null) || []
        if (!currentSkills.includes(memorySkill.id)) {
          parsed.data.skills = [...currentSkills, memorySkill.id]
        }
      }
    } else if (!nowEnabled && wasEnabled) {
      const memorySkill = await findMemorySkill()
      if (memorySkill) {
        const currentSkills =
          (parsed.data.skills as string[] | null) || (existing.skills as string[] | null) || []
        parsed.data.skills = currentSkills.filter((sid: string) => sid !== memorySkill.id)
      }
      shouldRemoveMemoryOverrides = true
    }
  }

  const updatePayload = {
    ...parsed.data,
    ...(authModeToSave !== undefined ? { authMode: authModeToSave } : {}),
    config: configToSave,
    env: envToSave,
    feishuConfig: feishuConfigToSave,
    slackConfig: slackConfigToSave,
    discordConfig: discordConfigToSave,
    qqOfficialConfig: qqOfficialConfigToSave,
    a2aRouteTargets: a2aRouteTargetsToSave.value,
    ...providerCredentialFields,
    memoryProviderApiKey: memoryProviderApiKeyToSave,
    embeddingApiKey: embeddingApiKeyToSave,
    updatedAt: new Date(),
  }

  if (existing.publishStatus === 'published') {
    const candidate = { ...existing }
    const candidateRecord = candidate as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(updatePayload)) {
      if (value !== undefined) candidateRecord[key] = value
    }
    await validateAgentProviderConfiguration(candidate)
  }

  // Resolve before persistence so workspace lookup failures still reject the
  // update, but defer file mutations until the database update succeeds. This
  // keeps both provider-preflight and database-failure paths side-effect free.
  let disableWorkDirs: string[] | undefined
  if (shouldRemoveMemoryOverrides) {
    // Side-effect-free resolution: a config PATCH must never create a worktree
    // or move a HEAD under a possibly-running run's feet.
    disableWorkDirs = await resolveCleanupWorkDirs(existing)
  }

  const updateAgent = async (executor: typeof db) =>
    (await executor.update(agents).set(updatePayload).where(eq(agents.id, id)).returning())[0]
  const bindingResult = await mutateAgentBinding({
    agentId: id,
    requestedWorkspaceType: parsed.data.workspaceType,
    requestedScmSourceId: scmSourceId,
    mutate: updateAgent,
  })
  if (!bindingResult.allowed) {
    if (bindingResult.active) {
      const label = bindingResult.active.type === 'run' ? 'Run' : 'Evaluation'
      return c.json(
        {
          error: `Cannot change the SCM binding while ${label} ${bindingResult.active.id} is active`,
        },
        409,
      )
    }
    return c.json({ error: 'SCM source is unavailable or has not completed initial sync' }, 409)
  }
  const updated = bindingResult.value

  resyncGitTriggerAfterUpdate(id, parsed.data, updated)

  if (disableWorkDirs !== undefined) {
    for (const dir of disableWorkDirs) {
      for (const file of ['CLAUDE.md', 'AGENTS.md', '.cursorrules']) {
        try {
          removeMemoryOverride(join(dir, file))
        } catch (err) {
          // The committed DB row is authoritative. Do not roll it back after earlier
          // files may already be clean; execution engines retry the relevant legacy
          // override cleanup before spawning their CLI, so a later Run can self-heal.
          logger.warn(
            { agentId: existing.id, file, err },
            `Failed to remove memory override from ${file}`,
          )
        }
      }
    }
  }

  logAudit(c, { action: 'agent.update', resource: 'agent', resourceId: id })

  return c.json({ data: maskAgentSecrets(updated) })
})

/** POST /agents/:id/pin - 置顶 Agent（服务端戳 pinnedAt；已置顶则保持原时间不变） */
app.post('/:id/pin', async (c) => {
  const { id } = c.req.param()
  const { agent: existing } = await requireAgentWrite(c, id)

  // 已置顶保持原 pinnedAt——重复置顶不应把它推到「最后一个置顶」之后，避免误改排序。
  // 不动 updatedAt：置顶是排序/展示偏好，非内容修改，不应污染「最后修改时间」语义。
  const pinnedAt = existing.pinnedAt ?? new Date()
  const updated = (
    await db.update(agents).set({ pinnedAt }).where(eq(agents.id, id)).returning()
  )[0]

  logAudit(c, { action: 'agent.pin', resource: 'agent', resourceId: id })

  return c.json({ data: maskAgentSecrets(updated) })
})

/** POST /agents/:id/unpin - 取消置顶 Agent */
app.post('/:id/unpin', async (c) => {
  const { id } = c.req.param()
  await requireAgentWrite(c, id)

  // 不动 updatedAt：取消置顶同样是展示偏好，非内容修改。
  const updated = (
    await db.update(agents).set({ pinnedAt: null }).where(eq(agents.id, id)).returning()
  )[0]

  logAudit(c, { action: 'agent.unpin', resource: 'agent', resourceId: id })

  return c.json({ data: maskAgentSecrets(updated) })
})

const publishBodySchema = z.object({
  authType: publishAuthTypeEnum.default('api_key'),
  ipWhitelist: z.array(z.string()).default([]),
  description: z.string().default(''),
  regenerateApiKey: z.boolean().optional(),
  channels: z.array(publishChannelEnum).default(['api']),
  oauthAccessMode: oauthAccessModeEnum.optional(),
  // Nullable, not just optional: reads return `oauthAllowedEmails: null` for an
  // `all_idaas_users` Agent, and a client that round-trips that object back into publish must
  // not get a 400 for echoing what we sent it. Aligns with `agentSchema`.
  oauthAllowedEmails: oauthAllowedEmailsSchema.nullable().optional(),
  a2aSkills: z.array(a2aSkillSchema).nullable().optional(),
  feishuConfig: feishuConfigBodySchema.nullable().optional(),
  slackConfig: slackConfigSchema.nullable().optional(),
  discordConfig: discordConfigSchema.nullable().optional(),
  qqOfficialConfig: qqOfficialConfigSchema.nullable().optional(),
  chatAppConfig: chatAppConfigSchema.nullable().optional(),
  scheduleConfig: scheduleConfigSchema.nullable().optional(),
  glabConfig: glabTriggerConfigSchema.nullable().optional(),
  ghConfig: ghTriggerConfigSchema.nullable().optional(),
  /** A2A 入站独立鉴权方式（与 REST API 渠道解耦） */
  a2aAuthType: publishAuthTypeEnum.optional(),
  /** 信任上游 A2A 转发的用户身份（仅 a2aAuthType=api_key 生效） */
  trustForwardedIdentity: z.boolean().optional(),
  /**
   * 定时任务以「开启此开关的人」身份过网关。仅 boolean 开关；开启时服务端把运行身份钉为
   * 当前登录用户（getCurrentUserId → scheduleRunAsUserId），client 无法指定他人。仅
   * schedule 渠道下有意义。
   */
  scheduleRunAsOwner: z.boolean().optional(),
})

/** POST /agents/:id/publish - 发布 Agent */
app.post('/:id/publish', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json().catch(() => ({}))
  const parsed = publishBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { agent } = await requireAgentWrite(c, id)

  const {
    authType,
    ipWhitelist,
    description,
    regenerateApiKey,
    channels,
    oauthAccessMode,
    oauthAllowedEmails,
    a2aSkills,
    feishuConfig,
    slackConfig,
    discordConfig,
    qqOfficialConfig,
    chatAppConfig,
    scheduleConfig,
    glabConfig,
    ghConfig,
    a2aAuthType,
    trustForwardedIdentity,
    scheduleRunAsOwner,
  } = parsed.data
  const effectiveOauthAccessMode =
    oauthAccessMode ?? normalizeOauthAccessMode(agent.oauthAccessMode)
  const now = new Date()
  const isStopped = agent.publishStatus === 'stopped'

  // Publishing activates every configured channel. Resolve the execution config
  // synchronously before changing persisted state so deterministic Provider/MCP
  // conflicts are returned to the caller instead of surfacing later in an
  // asynchronously started channel. A stopped Agent stays stopped here, so its
  // channel settings remain editable while the owner repairs its execution config.
  // publishBodySchema intentionally contains no Provider/MCP execution fields, so
  // the persisted Agent is the effective config; build a candidate here if that
  // schema ever gains such a field.
  if (!isStopped) {
    await validateAgentProviderConfiguration(agent)
  }

  const updatePayload: Record<string, unknown> = {
    publishStatus: isStopped ? 'stopped' : 'published',
    publishAuthType: authType,
    publishIpWhitelist: ipWhitelist,
    publishDescription: description,
    publishChannels: channels,
    oauthAccessMode: effectiveOauthAccessMode,
    a2aSkills: a2aSkills ?? null,
    publishedAt: isStopped ? agent.publishedAt : now,
    updatedAt: now,
  }

  // A2A 入站独立鉴权（与 REST 渠道解耦）。
  const effectiveA2aAuthType = a2aAuthType ?? agent.a2aAuthType ?? 'api_key'
  if (a2aAuthType !== undefined) updatePayload.a2aAuthType = a2aAuthType
  // 一致性约束：trustForwardedIdentity 仅在 a2aAuthType=api_key 下有意义。auth 非
  // api_key 时强制置 false，避免存出 (none + trust=true) 的矛盾脏数据（运行时闸门也
  // 会忽略，但不入库更干净）。
  if (effectiveA2aAuthType !== 'api_key') {
    updatePayload.trustForwardedIdentity = false
  } else if (trustForwardedIdentity !== undefined) {
    updatePayload.trustForwardedIdentity = trustForwardedIdentity
  }
  // 首次在 a2a=api_key 下发布且尚无专属 key 时，自动生成一把（前缀 a2ak_，区别于 REST 的 ak_）。
  // 后续轮换由独立的 POST /:id/regenerate-a2a-api-key 处理。
  if (channels.includes('a2a') && effectiveA2aAuthType === 'api_key' && !agent.a2aEndpointApiKey) {
    updatePayload.a2aEndpointApiKey = `a2ak_${randomBytes(24).toString('base64url')}`
  }

  if (scheduleConfig !== undefined) {
    updatePayload.scheduleConfig = scheduleConfig
  }
  if (glabConfig !== undefined) {
    updatePayload.glabConfig = glabConfig
  }
  if (ghConfig !== undefined) {
    updatePayload.ghConfig = ghConfig
  }
  // scheduleRunAsOwner 仅在 schedule 渠道下有意义。开启时把「运行身份」钉为**当前登录用户**
  // （getCurrentUserId，服务端控制，client 无法指定他人）；关闭 / 非 schedule 渠道则清空。
  // 触发期按 scheduleRunAsUserId 实时解析其 SSO 身份签发。
  if (!channels.includes('schedule')) {
    updatePayload.scheduleRunAsOwner = false
    updatePayload.scheduleRunAsUserId = null
  } else if (scheduleRunAsOwner !== undefined) {
    if (scheduleRunAsOwner) {
      // Fail loud at publish: the enabling user must have a resolvable, bound SSO
      // identity, else the schedule would only fail at trigger time (silent until cron).
      const me = (
        await db
          .select()
          .from(users)
          .where(eq(users.id, getCurrentUserId(c)))
          .limit(1)
      )[0]
      if (!me?.isActive || !me.email || !me.idaasSub) {
        return c.json(
          {
            error: 'SCHEDULE_RUN_AS_OWNER_REQUIRES_BOUND_IDENTITY',
            code: 'SCHEDULE_RUN_AS_OWNER_REQUIRES_BOUND_IDENTITY',
          },
          400,
        )
      }
      updatePayload.scheduleRunAsOwner = true
      updatePayload.scheduleRunAsUserId = me.id
    } else {
      updatePayload.scheduleRunAsOwner = false
      updatePayload.scheduleRunAsUserId = null
    }
  }

  // Normalize (legacy → new format) then preserve existing secret if '********' sent
  if (feishuConfig !== undefined) {
    let resolvedFeishuConfig = feishuConfig
      ? normalizeFeishuConfig(feishuConfig as Record<string, unknown>)
      : feishuConfig
    if (
      resolvedFeishuConfig &&
      resolvedFeishuConfig.appSecret === '********' &&
      agent.feishuConfig
    ) {
      resolvedFeishuConfig = { ...resolvedFeishuConfig, appSecret: agent.feishuConfig.appSecret }
    }
    updatePayload.feishuConfig = resolvedFeishuConfig
  }

  if (slackConfig !== undefined) {
    let resolvedSlackConfig = slackConfig
    if (resolvedSlackConfig && agent.slackConfig) {
      resolvedSlackConfig = {
        ...resolvedSlackConfig,
        appToken:
          resolvedSlackConfig.appToken === '********'
            ? agent.slackConfig.appToken
            : resolvedSlackConfig.appToken,
        botToken:
          resolvedSlackConfig.botToken === '********'
            ? agent.slackConfig.botToken
            : resolvedSlackConfig.botToken,
      }
    }
    updatePayload.slackConfig = resolvedSlackConfig
  }
  if (discordConfig !== undefined) {
    let resolvedDiscordConfig = discordConfig
    if (resolvedDiscordConfig?.botToken === '********' && agent.discordConfig?.botToken) {
      resolvedDiscordConfig = {
        ...resolvedDiscordConfig,
        botToken: agent.discordConfig.botToken,
      }
    }
    updatePayload.discordConfig = resolvedDiscordConfig
  }
  const preparedQQOfficialConfig = prepareQQOfficialPublishConfig(
    channels,
    qqOfficialConfig,
    agent.qqOfficialConfig,
    qqOfficialConfig !== undefined,
  )
  if (qqOfficialConfig !== undefined)
    updatePayload.qqOfficialConfig = preparedQQOfficialConfig.update

  // Chat app config is presentation copy only — no credentials, so no '********'
  // preservation dance and nothing to mask on the read path.
  if (chatAppConfig !== undefined) {
    updatePayload.chatAppConfig = chatAppConfig
  }

  const effectiveSlackConfig = (
    updatePayload.slackConfig === undefined ? agent.slackConfig : updatePayload.slackConfig
  ) as { appId?: string; appToken?: string; botToken?: string } | null | undefined
  if (
    channels.includes('slack') &&
    (!effectiveSlackConfig?.appId ||
      !effectiveSlackConfig.appToken ||
      !effectiveSlackConfig.botToken)
  ) {
    return c.json(
      {
        error: 'Slack channel requires appId, appToken, and botToken.',
        code: 'SLACK_CONFIG_REQUIRED',
      },
      400,
    )
  }
  const effectiveDiscordConfig = (
    updatePayload.discordConfig === undefined ? agent.discordConfig : updatePayload.discordConfig
  ) as { applicationId?: string; botToken?: string } | null | undefined
  if (
    channels.includes('discord') &&
    (!effectiveDiscordConfig?.applicationId || !effectiveDiscordConfig.botToken)
  ) {
    return c.json(
      {
        error: 'Discord channel requires applicationId and botToken.',
        code: 'DISCORD_CONFIG_REQUIRED',
      },
      400,
    )
  }
  if (preparedQQOfficialConfig.missingRequired) {
    return c.json(
      {
        error: 'QQ Official channel requires appId and appSecret.',
        code: 'QQ_OFFICIAL_CONFIG_REQUIRED',
      },
      400,
    )
  }

  const gitTriggerError = gitTriggerPublishError(channels, updatePayload, agent)
  if (gitTriggerError) return c.json(gitTriggerError, 400)

  const allowedEmailsUpdate = resolveOauthAllowedEmailsUpdate(
    effectiveOauthAccessMode,
    oauthAllowedEmails,
  )
  if (allowedEmailsUpdate !== undefined) {
    updatePayload.oauthAllowedEmails = allowedEmailsUpdate
  }
  if (
    isOauthAllowlistMissing({
      channels,
      mode: effectiveOauthAccessMode,
      update: allowedEmailsUpdate,
      stored: agent.oauthAllowedEmails as string[] | null,
    })
  ) {
    return c.json(OAUTH_ALLOWED_EMAILS_REQUIRED, 400)
  }

  const keepExistingKey =
    authType === 'api_key' && regenerateApiKey === false && agent.endpointApiKey
  if (authType === 'api_key' && !keepExistingKey) {
    updatePayload.endpointApiKey = `ak_${randomBytes(24).toString('base64url')}`
  }

  const updated = (
    await db.update(agents).set(updatePayload).where(eq(agents.id, id)).returning()
  )[0]

  // Start/stop feishu connection based on channels (only start if agent is active)
  if (!isStopped && channels.includes('feishu')) {
    const savedFeishuConfig = (updatePayload.feishuConfig ??
      agent.feishuConfig) as typeof feishuConfig
    if (savedFeishuConfig) {
      feishuConnectionManager
        .start(id, savedFeishuConfig)
        .catch((err) =>
          logger.error({ err, agentId: id }, 'Failed to start Feishu connection on publish'),
        )
    }
  } else if (!channels.includes('feishu')) {
    feishuConnectionManager.stop(id)
  }

  if (!isStopped && channels.includes('slack') && effectiveSlackConfig) {
    slackConnectionManager
      .start(id, effectiveSlackConfig)
      .catch((err) =>
        logger.error({ err, agentId: id }, 'Failed to start Slack connection on publish'),
      )
  } else if (!channels.includes('slack')) {
    void slackConnectionManager.stop(id)
  }

  if (!isStopped && channels.includes('discord') && effectiveDiscordConfig) {
    discordConnectionManager
      .start(id, effectiveDiscordConfig)
      .catch((err) =>
        logger.error({ err, agentId: id }, 'Failed to start Discord connection on publish'),
      )
  } else if (!channels.includes('discord')) {
    void discordConnectionManager.stop(id)
  }
  syncQQOfficialConnectionAfterPublish(id, isStopped, channels, preparedQQOfficialConfig.effective)

  // Start/stop schedule trigger based on channels
  if (!isStopped && channels.includes('schedule')) {
    const savedScheduleConfig = (updatePayload.scheduleConfig ??
      agent.scheduleConfig) as ScheduleConfigInput | null
    if (savedScheduleConfig) {
      scheduleTriggerManager.start(id, savedScheduleConfig)
    }
  } else if (!channels.includes('schedule')) {
    scheduleTriggerManager.stop(id)
  }

  syncGitTriggerChannels({ agentId: id, channels, isStopped, updatePayload, agent })

  logAudit(c, { action: 'agent.publish', resource: 'agent', resourceId: id })

  return c.json({ data: maskAgentSecrets(updated) })
})

/**
 * 每个渠道各自的 config body。刻意不复用 publishBodySchema——它对 authType /
 * channels / ipWhitelist / description 都带 .default()，一旦复用，只想存飞书凭据
 * 的请求会把 publishChannels 静默重置成 ['api']（等于关掉其它所有渠道），并顺手
 * 轮换掉 endpointApiKey。
 */
const channelConfigSchemas = {
  feishu: feishuConfigBodySchema,
  slack: slackConfigSchema,
  discord: discordConfigSchema,
  qq_official: qqOfficialConfigSchema,
  chat_app: chatAppConfigSchema,
  schedule: scheduleConfigSchema,
  // Provider-bound, so a mismatched config is a 400 from schema validation
  // itself rather than something this route has to remember to check.
  glab: glabTriggerConfigSchema,
  gh: ghTriggerConfigSchema,
} as const

type ConfigurableChannel = keyof typeof channelConfigSchemas

/** config 值写到 agents 表的哪一列。 */
const CHANNEL_CONFIG_COLUMN: Record<ConfigurableChannel, string> = {
  feishu: 'feishuConfig',
  slack: 'slackConfig',
  discord: 'discordConfig',
  qq_official: 'qqOfficialConfig',
  chat_app: 'chatAppConfig',
  schedule: 'scheduleConfig',
  glab: 'glabConfig',
  gh: 'ghConfig',
}

function isConfigurableChannel(value: string): value is ConfigurableChannel {
  return Object.hasOwn(channelConfigSchemas, value)
}

/**
 * PATCH /agents/:id/channels/:channel - 只保存单个渠道的配置。
 *
 * 与 POST /:id/publish 的关键区别：**配置 ≠ 发布**。publish 会把 Agent 置为
 * published、戳 publishedAt、轮换 API Key，并按 channels 数组重启所有渠道的长连接；
 * 而在卡片上点「配置」保存凭据不应触发其中任何一项——draft 仍是 draft，直到用户显式
 * 点「发布」。启用与否由 publishChannels 决定，不归这个接口管，所以「配置了但不启用」
 * 是完全合法的状态。
 *
 * 副作用也收窄到单个渠道：只有当 Agent 已发布**且**该渠道已在 publishChannels 中时，
 * 才重启它自己的连接。改飞书配置不会顺带把 Slack / Discord 的在线 socket 打断——
 * 这正是整份 publish payload 做不到的。
 */
app.patch('/:id/channels/:channel', async (c) => {
  const { id, channel } = c.req.param()

  if (!isConfigurableChannel(channel)) {
    return c.json(
      { error: `Channel '${channel}' has no saveable config.`, code: 'UNKNOWN_CHANNEL' },
      400,
    )
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = z.object({ config: channelConfigSchemas[channel] }).safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { agent } = await requireAgentWrite(c, id)
  const column = CHANNEL_CONFIG_COLUMN[channel]

  /**
   * 脱敏哨兵回填：前端从不拿到明文凭据，未修改的字段会原样回传 '********'。
   *
   * 关键在于「无可回填的原值」必须报错，而不是把哨兵当成密钥写进去——那会让该字段
   * 读回来就已经是脱敏值，看着像已配置，实则每次调用都鉴权失败，且之后每次保存都会
   * 把哨兵再「还原」一遍，用户无法自行修复。草稿 Agent 正是这种「库里还没有原值」的
   * 状态，而配置弹窗恰恰是它录入凭据的主要入口。
   */
  const restoreSecret = (submitted: string | undefined, stored: string | undefined | null) => {
    if (submitted !== MASKED_SECRET) return { ok: true as const, value: submitted }
    if (!stored) return { ok: false as const, value: undefined }
    return { ok: true as const, value: stored }
  }

  const maskedWithoutStored = (field: string) =>
    c.json(
      {
        error: `${field} was sent masked but no stored value exists to restore.`,
        code: 'MASKED_SECRET_WITHOUT_STORED_VALUE',
      },
      400,
    )

  let config: unknown = parsed.data.config
  if (channel === 'feishu') {
    const next = normalizeFeishuConfig(config as Record<string, unknown>)
    const secret = restoreSecret(next.appSecret, agent.feishuConfig?.appSecret)
    if (!secret.ok) return maskedWithoutStored('appSecret')
    config = { ...next, appSecret: secret.value }
  } else if (channel === 'slack') {
    const next = config as { appToken?: string; botToken?: string }
    const appToken = restoreSecret(next.appToken, agent.slackConfig?.appToken)
    if (!appToken.ok) return maskedWithoutStored('appToken')
    const botToken = restoreSecret(next.botToken, agent.slackConfig?.botToken)
    if (!botToken.ok) return maskedWithoutStored('botToken')
    config = { ...next, appToken: appToken.value, botToken: botToken.value }
  } else if (channel === 'discord') {
    const next = config as { botToken?: string }
    const botToken = restoreSecret(next.botToken, agent.discordConfig?.botToken)
    if (!botToken.ok) return maskedWithoutStored('botToken')
    config = { ...next, botToken: botToken.value }
  } else if (channel === 'qq_official') {
    const next = config as { appSecret?: string }
    const appSecret = restoreSecret(next.appSecret, agent.qqOfficialConfig?.appSecret)
    if (!appSecret.ok) return maskedWithoutStored('appSecret')
    config = { ...next, appSecret: appSecret.value }
  }

  // 只有「已发布 + 该渠道已启用」才让改动即时生效；draft 或未启用时仅落库。
  const isLive =
    agent.publishStatus === 'published' && (agent.publishChannels ?? []).includes(channel)

  /**
   * 线上渠道不允许把凭据存成空值。
   *
   * 连接管理器的 start() 是「先 stop 再校验」：凭据为空时它已经把旧连接拆了才 return，
   * 而本路由仍会返回 200、前端显示「保存成功」。于是管理员只要在已上线渠道的配置弹窗里
   * 清空 App ID 保存，就会把正常在线的机器人静默下线，同时把无效配置写进库。
   *
   * 草稿 / 未启用的渠道不受此限制——编辑途中清空字段是正常操作，且没有连接可破坏。
   */
  if (isLive) {
    const required: Record<string, string | undefined> =
      channel === 'feishu'
        ? {
            appId: (config as { appId?: string }).appId,
            appSecret: (config as { appSecret?: string }).appSecret,
          }
        : channel === 'slack'
          ? {
              appId: (config as { appId?: string }).appId,
              appToken: (config as { appToken?: string }).appToken,
              botToken: (config as { botToken?: string }).botToken,
            }
          : channel === 'discord'
            ? {
                applicationId: (config as { applicationId?: string }).applicationId,
                botToken: (config as { botToken?: string }).botToken,
              }
            : channel === 'qq_official'
              ? {
                  appId: (config as { appId?: string }).appId,
                  appSecret: (config as { appSecret?: string }).appSecret,
                }
              : {}
    const blank = Object.entries(required).find(([, value]) => !value?.trim())
    if (blank) {
      return c.json(
        {
          error: `${blank[0]} cannot be empty while the ${channel} channel is live. Disable the channel first.`,
          code: 'LIVE_CHANNEL_REQUIRES_CREDENTIALS',
        },
        400,
      )
    }
  }

  const updated = (
    await db
      .update(agents)
      .set({ [column]: config, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning()
  )[0]
  if (isLive) {
    if (channel === 'feishu') {
      feishuConnectionManager
        .start(id, config as Parameters<typeof feishuConnectionManager.start>[1])
        .catch((err) =>
          logger.error({ err, agentId: id }, 'Failed to restart Feishu connection on config save'),
        )
    } else if (channel === 'slack') {
      slackConnectionManager
        .start(id, config as Parameters<typeof slackConnectionManager.start>[1])
        .catch((err) =>
          logger.error({ err, agentId: id }, 'Failed to restart Slack connection on config save'),
        )
    } else if (channel === 'discord') {
      discordConnectionManager
        .start(id, config as Parameters<typeof discordConnectionManager.start>[1])
        .catch((err) =>
          logger.error({ err, agentId: id }, 'Failed to restart Discord connection on config save'),
        )
    } else if (channel === 'qq_official') {
      qqOfficialConnectionManager
        .start(id, config as Parameters<typeof qqOfficialConnectionManager.start>[1])
        .catch((err) =>
          logger.error(
            { err, agentId: id },
            'Failed to restart QQ Official connection on config save',
          ),
        )
    } else if (channel === 'schedule') {
      scheduleTriggerManager.start(id, config as ScheduleConfigInput)
    } else if (channel === 'glab' || channel === 'gh') {
      gitTriggerManager.start(id, channel, config)
    }
  }

  logAudit(c, {
    action: 'agent.publish_channel',
    resource: 'agent',
    resourceId: id,
    // 只记渠道名——config 里有凭据，details 会原样展示给每个管理员。
    details: { channel },
  })

  return c.json({ data: maskAgentSecrets(updated) })
})

/** POST /agents/:id/stop - 停止已发布的 Agent */
app.post('/:id/stop', async (c) => {
  const { id } = c.req.param()
  await requireAgentWrite(c, id)

  const updated = (
    await db
      .update(agents)
      .set({ publishStatus: 'stopped', updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning()
  )[0]

  feishuConnectionManager.stop(id)
  void slackConnectionManager.stop(id)
  void discordConnectionManager.stop(id)
  void qqOfficialConnectionManager.stop(id)
  scheduleTriggerManager.stop(id)
  gitTriggerManager.stopAgent(id)
  logAudit(c, { action: 'agent.stop', resource: 'agent', resourceId: id })

  return c.json({ data: maskAgentSecrets(updated) })
})

/** POST /agents/:id/resume - 恢复已停止的 Agent */
app.post('/:id/resume', async (c) => {
  const { id } = c.req.param()
  const { agent } = await requireAgentWrite(c, id)

  if (agent.publishStatus !== 'stopped') {
    return c.json({ error: 'Agent is not in stopped state' }, 400)
  }

  // Resume is an activation boundary just like initial publish. Validate before
  // flipping the status so a deterministic execution-config conflict cannot
  // leave the Agent marked as published with unusable channels.
  await validateAgentProviderConfiguration(agent)

  const updated = (
    await db
      .update(agents)
      .set({ publishStatus: 'published', updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning()
  )[0]

  // Restart feishu connection on resume（await 以便客户端拉取 feishu-connections 时已注册）
  const resumedChannels = updated?.publishChannels ?? []
  if (resumedChannels.includes('feishu') && updated?.feishuConfig) {
    try {
      await feishuConnectionManager.start(
        id,
        normalizeFeishuConfig(updated.feishuConfig as Record<string, unknown>),
      )
    } catch (err) {
      logger.error({ err, agentId: id }, 'Failed to start Feishu connection on resume')
    }
  }
  if (resumedChannels.includes('slack') && updated?.slackConfig) {
    try {
      await slackConnectionManager.start(id, updated.slackConfig)
    } catch (err) {
      logger.error({ err, agentId: id }, 'Failed to start Slack connection on resume')
    }
  }
  if (resumedChannels.includes('discord') && updated?.discordConfig) {
    try {
      await discordConnectionManager.start(id, updated.discordConfig)
    } catch (err) {
      logger.error({ err, agentId: id }, 'Failed to start Discord connection on resume')
    }
  }
  await resumeQQOfficialConnection(id, resumedChannels, updated?.qqOfficialConfig)

  // Restart schedule trigger on resume
  if (resumedChannels.includes('schedule') && updated?.scheduleConfig) {
    scheduleTriggerManager.start(id, updated.scheduleConfig)
  }

  // Restart the git repository polls on resume
  syncGitTriggerChannels({ agentId: id, channels: resumedChannels, agent: updated ?? {} })

  logAudit(c, { action: 'agent.resume', resource: 'agent', resourceId: id })

  return c.json({ data: maskAgentSecrets(updated) })
})

/** POST /agents/:id/clone - 克隆 Agent */
app.post('/:id/clone', async (c) => {
  const { id } = c.req.param()
  const { agent } = await requireAgentWrite(c, id)

  // Strip secrets from the clone — clone hands the new agent's ownership to
  // the caller (`userId = getCurrentUserId(c)`), so an `editor` could otherwise
  // walk away with the source agent's provider key / OAuth token / sensitive
  // env values and re-share them to anyone they invite. Once the original
  // owner revokes editor membership those copies remain — irreversible.
  // Mirrors `sanitizeAgent` in agent-export.ts: env.sensitive value cleared,
  // provider* secrets dropped. authMode is kept so the caller knows which
  // credential to refill.
  const clonedEnv = agent.env
    ? Object.fromEntries(
        Object.entries(agent.env).map(([k, v]) => [k, v.sensitive ? { ...v, value: '' } : v]),
      )
    : null

  const cloneId = createId('agt')
  const now = new Date()
  const userId = getCurrentUserId(c)
  const clonedSkillReferences = await projectBindableSkillReferencesForClone(
    c,
    agent.skills,
    agent.skillGroupIds,
  )
  // Drop admin-only / stdio MCP the caller couldn't bind themselves — the clone is
  // theirs, and this copy would otherwise survive a membership revoke.
  const clonedMcpServerIds = await filterBindableMcpIdsForClone(
    c,
    agent.mcpServerIds as string[] | null | undefined,
  )
  const insertClone = async (executor: typeof db) =>
    (
      await executor
        .insert(agents)
        .values({
          id: cloneId,
          name: `${agent.name} (Copy)`,
          description: agent.description,
          type: agent.type,
          config: maskProviderChainConfig(agent.config, null),
          status: agent.status,
          icon: agent.icon,
          systemPrompt: agent.systemPrompt,
          skills: clonedSkillReferences.skillIds,
          skillGroupIds: clonedSkillReferences.skillGroupIds,
          // Drop admin-only / stdio MCP the caller couldn't bind themselves — the
          // clone is theirs, and this copy would otherwise survive membership revoke.
          mcpServerIds: clonedMcpServerIds,
          kbDocumentIds: agent.kbDocumentIds,
          publishStatus: 'draft',
          endpointApiKey: null,
          a2aEndpointApiKey: null,
          providerApiKey: null,
          providerBaseUrl: null,
          providerOauthToken: null,
          memoryProviderApiKey: null,
          embeddingApiKey: null,
          authMode: agent.authMode,
          publishAuthType: 'api_key',
          publishIpWhitelist: [],
          publishDescription: null,
          publishChannels: ['api'],
          // Explicit on purpose (see db/schema.ts): omitting these writes the retired
          // `feishu_scope`, which reads normalize to the **open** mode, so a clone of a
          // `specified_users` Agent would come back open. Only an explicit `all_idaas_users` clones
          // as open; anything else is a tier this code cannot establish, so it takes the restricted
          // one. Not `normalizeOauthAccessMode()` — that resolves *unclear* to open, which is right
          // for a read but is the write side giving away a decision it owns. The roster is
          // deliberately not copied (personnel data), which is why the tier must survive.
          oauthAccessMode:
            agent.oauthAccessMode === 'all_idaas_users' ? 'all_idaas_users' : 'specified_users',
          oauthAllowedEmails: null,
          a2aSkills: null,
          feishuConfig: null,
          slackConfig: null,
          discordConfig: null,
          qqOfficialConfig: null,
          scheduleConfig: null,
          glabConfig: null,
          ghConfig: null,
          publishedAt: null,
          providerId: agent.providerId,
          env: clonedEnv,
          workspaceType: agent.workspaceType,
          scmSourceId: agent.scmSourceId,
          maxConcurrency: agent.maxConcurrency,
          userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
    )[0]
  const bindingResult =
    agent.workspaceType === 'scm' && agent.scmSourceId
      ? await withScmPathMutation(async (tx) => {
          const source = (
            await tx
              .select({ id: scmSources.id })
              .from(scmSources)
              .where(
                and(
                  eq(scmSources.id, agent.scmSourceId as string),
                  isNull(scmSources.deletionRequestedAt),
                ),
              )
              .limit(1)
          )[0]
          if (!source) return { allowed: false as const, agent: undefined }
          return { allowed: true as const, agent: await insertClone(tx as typeof db) }
        })
      : { allowed: true as const, agent: await insertClone(db) }
  if (!bindingResult.allowed) {
    return c.json({ error: 'The Agent SCM source is no longer available' }, 409)
  }
  const cloned = bindingResult.agent
  logAudit(c, { action: 'agent.clone', resource: 'agent', resourceId: cloneId })

  return c.json({ data: maskAgentSecrets(cloned) }, 201)
})

/** GET /agents/:id/export — 导出 Agent 配置为 ZIP */
app.get('/:id/export', async (c) => {
  const { id } = c.req.param()
  const { agent } = await requireAgentRead(c, id)

  try {
    const zipBuffer = buildExportZip(id, {
      kind: 'authenticated',
      requesterUserId: getCurrentUserId(c),
      requesterIsAdmin: isAdmin(c),
    })
    const filename = `${agent.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')}-export.zip`

    logAudit(c, { action: 'agent.export', resource: 'agent', resourceId: id })

    // 零拷贝 view：避免大 zip 拷贝；as ArrayBuffer 修正 BodyInit 的类型窄化
    const body = new Uint8Array(
      (await zipBuffer).buffer as ArrayBuffer,
      (await zipBuffer).byteOffset,
      (await zipBuffer).byteLength,
    )
    return new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': String((await zipBuffer).length),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed'
    return c.json({ error: message }, 500)
  }
})

/** POST /agents/:id/share — 生成临时分享链接（24h 有效） */
app.post('/:id/share', async (c) => {
  const { id } = c.req.param()
  await requireAgentWrite(c, id)

  const token = createShareToken(id)
  const host = c.req.header('host') ?? 'localhost'
  const protocol = c.req.header('x-forwarded-proto') ?? 'http'
  const shareUrl = `${protocol}://${host}/api/agents/shared/${token}`

  logAudit(c, { action: 'agent.share', resource: 'agent', resourceId: id })

  return c.json({ data: { shareUrl, expiresIn: '24h' } })
})

/** POST /agents/:id/regenerate-api-key - 重新生成 API Key */
app.post('/:id/regenerate-api-key', async (c) => {
  const { id } = c.req.param()
  // 与发布解耦：无论 agent 是否已发布、是否为 api_key 鉴权，都允许生成/重置密钥。
  // 鉴权由 requireAgentWrite 保证；为未用到 key 的 agent 轮换密钥也无副作用。
  await requireAgentWrite(c, id)

  const newApiKey = `ak_${randomBytes(24).toString('base64url')}`
  await db
    .update(agents)
    .set({ endpointApiKey: newApiKey, updatedAt: new Date() })
    .where(eq(agents.id, id))

  // Rotating a live credential breaks every integration holding the old key;
  // the trail is exactly what answers "who rotated this, and when".
  logAudit(c, { action: 'agent.regenerate_api_key', resource: 'agent', resourceId: id })

  return c.json({ data: { endpointApiKey: newApiKey } })
})

/** POST /agents/:id/regenerate-a2a-api-key - 重新生成 A2A 入站专属 API Key */
app.post('/:id/regenerate-a2a-api-key', async (c) => {
  const { id } = c.req.param()
  // 与 REST 渠道的 regenerate-api-key 对齐：与发布解耦，鉴权由 requireAgentWrite 保证。
  // A2A key 使用独立前缀 a2ak_，与 REST 的 ak_ 区分，可单独轮换/吊销。
  await requireAgentWrite(c, id)

  const newApiKey = `a2ak_${randomBytes(24).toString('base64url')}`
  await db
    .update(agents)
    .set({ a2aEndpointApiKey: newApiKey, updatedAt: new Date() })
    .where(eq(agents.id, id))

  logAudit(c, { action: 'agent.regenerate_a2a_api_key', resource: 'agent', resourceId: id })

  return c.json({ data: { a2aEndpointApiKey: newApiKey } })
})

/** POST /agents/:id/chat - 与 Agent 聊天 */
app.post('/:id/chat', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  const chatSchema = z.object({
    message: z.string().min(1).max(100_000),
    context: z.record(z.string(), z.unknown()).optional(),
    stream: z.boolean().default(false),
    chatId: z.string().optional(),
    worktree: worktreeCallParamsSchema.optional(),
    attachments: attachmentsInputSchema,
    /**
     * Which in-product surface sent this turn. Both are session-authenticated and
     * identical in behaviour; the marker only separates chat-app traffic from
     * test-drawer traffic in run history and stats.
     */
    channel: z.enum(['debug', 'chat_app']).default('debug'),
  })
  const parsed = chatSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { agent } = await requireAgentRead(c, id)

  // Enforce the chat_app gate on every turn, not just on page load. The
  // GET /:id/chat-app 404 only gates a fresh navigation; without this check a page
  // left open would keep taking turns after an owner revoked the channel or
  // stopped the Agent.
  if (parsed.data.channel === 'chat_app' && !canTakeChatAppTurn(agent)) {
    return c.json({ error: 'Chat app is not enabled for this Agent' }, 404)
  }

  // Enforce the chat page's attachment toggle server-side. Hiding the upload
  // control is a UI courtesy — the endpoint is reachable directly, so a visitor
  // could still POST `channel: 'chat_app'` with attachments and make the Agent
  // consume files the owner deliberately turned off. 403 (not 404): the channel
  // itself is enabled and the caller may legitimately chat, just not with files.
  //
  // Scope, stated plainly: this keys on the caller's self-declared `channel`, so
  // it governs what the chat page may do, not what the *user* may do. The same
  // person can still send attachments as `channel: 'debug'` — that surface has
  // its own (unrestricted) contract and demands the same login plus read
  // permission, so nothing is escalated. Turning the toggle off withdraws the
  // chat page's use of files; it is not an Agent-wide attachment ban.
  if (
    parsed.data.channel === 'chat_app' &&
    agent.chatAppConfig?.allowAttachments === false &&
    (parsed.data.attachments?.length ?? 0) > 0
  ) {
    return c.json(
      {
        error: 'Attachments are disabled for the chat page of this Agent',
        code: 'CHAT_APP_ATTACHMENTS_DISABLED',
      },
      403,
    )
  }

  logger.info(
    {
      agentId: id,
      stream: parsed.data.stream,
      hasChatId: !!parsed.data.chatId,
      messageLen: parsed.data.message.length,
    },
    'Chat request received',
  )

  const runtimeAdminRequesterUserId = getCurrentUserId(c)
  const agentConfig = buildAgentConfig(agent, { runtimeAdminRequesterUserId })

  const engineType = (await agentConfig).engineType || 'cursor'
  if (!engineRegistry.get(engineType)) {
    return c.json(
      {
        error: `No engine registered for type "${engineType}". Available: [${engineRegistry.types.join(', ')}]`,
      },
      400,
    )
  }

  // Validate SCM sync status before creating any run records
  if (agent.workspaceType === 'scm' && agent.scmSourceId) {
    const source = (
      await db.select().from(scmSources).where(eq(scmSources.id, agent.scmSourceId)).limit(1)
    )[0]
    if (source && source.initialSyncCompletedAt == null) {
      return c.json({ error: SCM_INITIAL_SYNC_REQUIRED_MSG }, 400)
    }
  }

  // Reserved namespace, rejected only for NEW requests: an explicit worktree
  // addressing a per-agent workspace would downgrade its persistent state and
  // hand its long-lived branch to run-end removal. Sticky configs persisted
  // before this rule keep replaying (grandfathered in resolveWorkDir).
  if (parsed.data.worktree?.name.startsWith('agent-')) {
    return c.json(
      { error: "Worktree names with the 'agent-' prefix are reserved for per-agent workspaces" },
      400,
    )
  }

  // Persist worktree parameters with the Run so queued execution can recover them.
  const worktreeCfg = parsed.data.worktree
    ? {
        name: parsed.data.worktree.name,
        cleanup: parsed.data.worktree.cleanup,
        ...(parsed.data.worktree.branch ? { branch: parsed.data.worktree.branch } : {}),
      }
    : null

  // --- Resolve or create Run ---
  let runId: string
  let createdRunThisRequest = false
  // Snapshot reused Run state so an aborted turn can restore it exactly.
  let reusedRunPriorStatus: string | undefined
  let reusedRunPriorIntent: string | undefined
  let reusedRunPriorExecMeta: (typeof runs.$inferSelect)['executionMetadata'] | undefined
  let reusedRunPriorWorktreeConfig: (typeof runs.$inferSelect)['worktreeConfig'] | undefined
  const requestedChatId = parsed.data.chatId
  /**
   * The engine session id actually forwarded to the worker.
   *
   * Cleared when the ownership lookup below misses. Scoping only the DB row was
   * half a fix: the client-supplied chatId still reached the agent CLI, so a user
   * who reopened someone else's visible conversation resumed THEIR engine session
   * — reading context they never sent and mutating a session its owner may resume
   * later. A non-owned chatId must start a genuinely fresh session, not just a
   * fresh row.
   */
  let existingChatId = requestedChatId
  const maxConcurrency = agent.maxConcurrency ?? 1
  const userId = runtimeAdminRequesterUserId

  // Build unified channel context BEFORE the runs insert so triggerUserName can
  // be denormalized in the same statement. user_info derived from the
  // authenticated session (set by auth-middleware on c); pure function, safe to
  // hoist above the row insert.
  const chatChannel = parsed.data.channel
  const buildChannel = chatChannel === 'chat_app' ? buildChatAppChannel : buildDebugChannel
  const channelResult = buildChannel({
    triggeredByUserId: userId,
    userEmail: ((c.get as (k: string) => unknown)('userEmail') as string | undefined) || undefined,
    userName: ((c.get as (k: string) => unknown)('userName') as string | undefined) || undefined,
  })

  if (existingChatId) {
    const existingRun = (
      await db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.initiatorAgentId, id),
            eq(jsonExtractText(runs.result, ['chatId']), existingChatId),
            // Scope to the caller's own runs. `GET /:id/chats` is not owner-filtered,
            // so a second user can see and reopen someone else's conversation and send
            // its chatId back; without this predicate their turn would append to the
            // other user's run row — mixing two people's messages into one transcript
            // and resolving the wrong attachment consumer on rerun. A non-match simply
            // starts a fresh run below, which is the correct outcome.
            eq(runs.userId, userId),
          ),
        )
        .limit(1)
    )[0]

    if (existingRun) {
      // One conversation row cannot safely host two concurrent turns.
      if (
        existingRun.status === 'pending' ||
        existingRun.status === 'queued' ||
        existingRun.status === 'running'
      ) {
        return c.json(
          {
            error:
              'The previous turn of this conversation is still running; wait for it to finish before asking again',
            runId: existingRun.id,
          },
          409,
        )
      }
      runId = existingRun.id
      reusedRunPriorStatus = existingRun.status ?? undefined
      reusedRunPriorIntent = existingRun.intent
      reusedRunPriorExecMeta = existingRun.executionMetadata
      reusedRunPriorWorktreeConfig = existingRun.worktreeConfig
      await db
        .update(runs)
        .set({
          intent: parsed.data.message,
          updatedAt: new Date(),
          // 复用已完成的 run 追加新一轮：清掉上一轮残留的附件 metadata，避免无附件的新一轮
          // 重放旧附件（consume-once 的补充——即时路径本轮不带附件时也不应带出旧的）。
          executionMetadata: { runtimeAdminRequesterUserId },
          // Attribution is deliberately NOT re-stamped here.
          //
          // A run row is per-CONVERSATION, not per-turn: reusing it accumulates
          // every turn's messages. So rewriting triggerSource/triggerUserName does
          // not record "who sent this turn" — it retroactively rewrites the
          // attribution of every earlier turn in the conversation. And rewriting
          // them without userId (the ownership key that getOwnerFilter and
          // resolveRerunConsumerId both read) leaves owner and caller disagreeing,
          // which resolves the wrong attachment consumer on rerun.
          //
          // Cross-surface continuation therefore keeps the attribution of whoever
          // started the conversation. Per-turn provenance, if it is ever needed,
          // belongs on run_steps — not on the shared run row.
          ...(worktreeCfg ? { worktreeConfig: worktreeCfg } : {}),
        })
        .where(eq(runs.id, runId))
    } else {
      // No run of this caller's owns that chatId. Either it is genuinely new, or it
      // belongs to someone else's conversation — indistinguishable here, and in both
      // cases the safe move is a fresh engine session. Forwarding the requested id
      // would resume a session this user has no claim to.
      existingChatId = undefined
      runId = createId('run')
      createdRunThisRequest = true
      await db.insert(runs).values({
        id: runId,
        intent: parsed.data.message,
        initiatorAgentId: id,
        status: 'pending',
        userId,
        triggerSource: chatChannel,
        triggerUserName: channelResult.displayName,
        worktreeConfig: worktreeCfg ?? undefined,
        executionMetadata: { runtimeAdminRequesterUserId },
      })
    }
  } else {
    runId = createId('run')
    createdRunThisRequest = true
    await db.insert(runs).values({
      id: runId,
      intent: parsed.data.message,
      initiatorAgentId: id,
      status: 'pending',
      userId,
      triggerSource: chatChannel,
      triggerUserName: channelResult.displayName,
      worktreeConfig: worktreeCfg ?? undefined,
      executionMetadata: { runtimeAdminRequesterUserId },
    })
  }

  // 本请求没跑起来时的清理：新建的 run 直接删；复用的 run 还原 intent/executionMetadata/status
  // 回覆盖前的原值，绝不留下一条从未执行的新消息污染历史（review [P2/P3]）。
  const abandonRun = async (restoreStatus?: string) => {
    if (createdRunThisRequest) {
      await db.delete(runs).where(eq(runs.id, runId))
      return
    }
    await db
      .update(runs)
      .set({
        intent: reusedRunPriorIntent ?? '',
        executionMetadata: reusedRunPriorExecMeta ?? null,
        // worktreeConfig 一并还原（新一轮可能已覆盖，见 reuse update），不残留本轮配置。
        worktreeConfig: reusedRunPriorWorktreeConfig ?? null,
        status: (restoreStatus ??
          reusedRunPriorStatus ??
          'failed') as (typeof runs.status.enumValues)[number],
        workDir: null,
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId))
  }

  const slotResult = tryAcquireSlot(taskQueueDb, id, runId, maxConcurrency)

  if ((await slotResult) === 'queue_full') {
    // Awaited: the response must not beat the orphan-run delete, or a refresh
    // shows a ghost run. A rejected write would also become an unhandled one.
    await abandonRun()
    return c.json({ error: 'Queue is full' }, 429)
  }

  if ((await slotResult) === 'queued') {
    // 排队路径：持久化 queuedTurn marker（无论本轮是否带附件）。多轮会话复用同一 run 时，
    // 最新 step 可能属于上一轮；此 marker 让 rerun 能识别「当前 intent 对应的轮还没 materialize」，
    // 从而以本轮 executionMetadata.attachments（可为空=本轮无附件）为准，绝不回读上一轮 step 的
    // 旧附件（review [P2]：排队取消后 rerun 重放上一轮附件）。
    // 附件 refs 既放内存 pending-context（快路径），也持久化到 run 行 executionMetadata
    // （出队兜底，防内存 TTL/重启丢失，review [P1]）。consumerId=当前 web 用户。
    const hasAttachments = Boolean(parsed.data.attachments && parsed.data.attachments.length > 0)
    if (hasAttachments) {
      registerPendingContext(runId, { __attachments: parsed.data.attachments })
    }
    await db
      .update(runs)
      .set({
        executionMetadata: {
          queuedTurn: true,
          runtimeAdminRequesterUserId,
          ...(hasAttachments
            ? { attachments: parsed.data.attachments, attachmentConsumerId: userId }
            : {}),
        },
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId))
    if (parsed.data.stream) {
      return streamSSE(c, async (sseStream) => {
        await sseStream.writeSSE({
          event: 'queued',
          data: JSON.stringify({ type: 'queued', runId }),
        })
      })
    }
    return c.json({ status: 'queued', runId }, 202)
  }

  // Resolve workDir BEFORE inserting runSteps/chatMessages —
  // 避免 409 场景留下孤儿 step/message 记录。runId 传入让 resolveWorkDir
  // 在同步事务内完成占用检查 + workDir 原子写回，防止并发竞态。
  let resolvedWorkDir: string
  try {
    resolvedWorkDir = await resolveWorkDir(
      agent,
      parsed.data.worktree,
      runId,
      (await agentConfig).agentEnv,
    )
  } catch (err) {
    // 释放已占用的 slot。新建的 run 直接删除；复用的 run 还原 intent/executionMetadata/status
    // 到覆盖前的原值（不留 pending）——留 pending 会被 409 guard 永久挡死且 scheduleNext 不恢复
    // pending（review [P1]）；不还原 intent 则历史被污染成一条从未执行的新消息（review [P2]）。
    // Awaited: the restore must land before scheduleNext runs, which is the
    // ordering the comment above depends on.
    //
    // Unconditional: any failure leaves a run the queue counts as running, so
    // an untyped error (a workspace bookkeeping failure, a broken SCM config)
    // would otherwise pin the Agent at maxConcurrency until someone edits the
    // database.
    await recoverRunStartup({ runId, agentId: id, settleRun: abandonRun })
    if (
      err instanceof WorktreeOccupiedError ||
      err instanceof WorktreeBranchLockedError ||
      err instanceof WorktreeDirtyError
    ) {
      return c.json({ error: err.message }, 409)
    }
    throw err
  }

  // 附件落盘 + prompt 注入（与飞书逐字节一致的路径提示）。无附件时 mergedPrompt ===
  // message、rootDir === null。原始 refs 存 runSteps.input.attachments（免迁移审计）。
  const {
    mergedPrompt,
    rootDir: attachmentRootDir,
    materialized,
  } = await materializeForRun({
    agentId: id,
    runId,
    message: parsed.data.message,
    sources: refsToSources(parsed.data.attachments),
    consumerId: userId, // 上传者=当前 web 用户
  })

  const stepId = createId('rst')
  // channelResult was built up-front for the runs.triggerUserName denormalization;
  // we reuse `.ctx` for the runSteps audit trail. Strip server-reserved keys
  // (caller / receive_id*) from the user-supplied context first — same injection
  // contract as the gateway/oauth-gateway ingress (channel is set explicitly below).
  const stepContext: Record<string, unknown> = {
    ...stripReservedContextKeys(parsed.data.context),
    channel: channelResult.ctx,
  }
  const stepInput: Record<string, unknown> = { message: mergedPrompt, context: stepContext }
  // 只记**实际落盘**的附件（materialized），不用请求原始 refs——被拒/过期时不写不存在的 chip。
  if (materialized.length > 0) {
    stepInput.attachments = materialized
  }
  try {
    await persistRunTurn({
      step: {
        id: stepId,
        runId,
        agentId: id,
        input: stepInput,
        status: 'running',
      },
      // Write user message：存**用户原始输入**，不存注入了附件绝对路径的 mergedPrompt——否则
      // 历史里用户原话会变成含 [图片]/[文件]/服务器路径的执行文本（review）。附件回显靠
      // runSteps.input.attachments。mergedPrompt 仅用于引擎执行 + step 审计。
      message: {
        id: createId('msg'),
        runId,
        role: 'user',
        content: parsed.data.message,
      },
    })
  } catch (err) {
    await recoverRunStartup({
      runId,
      agentId: id,
      // Release the acquired ephemeral worktree BEFORE abandonRun clears
      // runs.workDir / deletes the row — cleanupWorktreeIfEphemeral reads those
      // to decide, so afterwards it is a silent no-op and the worktree leaks.
      cleanup: async () => {
        if (attachmentRootDir) await cleanupMaterializedRoot(attachmentRootDir)
        await releaseEphemeralWorktree(runId, id)
      },
      settleRun: abandonRun,
    })
    throw err
  }

  const taskId = buildTaskId('chat/', runId, stepId)

  const payload: WorkerTaskPayload = {
    taskId,
    prompt: mergedPrompt,
    context: stepContext,
    model: (await agentConfig).model || undefined,
    workDir: resolvedWorkDir,
    chatId: existingChatId,
    agentConfig: await agentConfig,
  }

  const lifecycleParams = {
    taskId,
    runId,
    stepId,
    agentId: id,
    startTime: Date.now(),
    workDir: resolvedWorkDir,
    userId,
  }

  if (parsed.data.stream) {
    return streamSSE(c, async (sseStream) => {
      // Announce the run id before execution starts. Until this lands the client
      // has no handle on the run, so a user who stops the turn early could neither
      // cancel it server-side nor ever reach its result. Clients that don't know
      // the event ignore it, so this is backward compatible.
      await sseStream.writeSSE({
        event: 'run_started',
        data: JSON.stringify({ type: 'run_started', runId }),
      })

      // Server heartbeat: an agent CLI can legitimately go silent for minutes
      // (long tool call, model thinking). Without a keepalive the client's idle
      // watchdog aborts and reports "connection lost" while the run is still fine.
      // A periodic no-op `heartbeat` event keeps the stream warm; the client
      // resets its idle timer on ANY chunk and ignores unknown event types.
      const heartbeat = setInterval(() => {
        sseStream
          .writeSSE({ event: 'heartbeat', data: '' })
          .catch((err) => logger.warn({ err }, 'SSE heartbeat write failed'))
      }, SSE_HEARTBEAT_INTERVAL_MS)
      try {
        const r = await runWithLifecycle(taskId, payload, lifecycleParams, {
          onUpdate: (content) => {
            sseStream
              .writeSSE({ event: 'update', data: JSON.stringify({ type: 'update', content }) })
              .catch((err) => logger.warn({ err }, 'SSE write failed'))
          },
          onLogEntry: (entry) => {
            sseStream
              .writeSSE({ event: 'log', data: JSON.stringify(entry) })
              .catch((err) => logger.warn({ err }, 'SSE write failed'))
          },
        })

        if (r.success) {
          await sseStream.writeSSE({
            event: 'done',
            data: JSON.stringify({ type: 'done', reply: r.output, chatId: r.chatId, runId }),
          })
        } else {
          await sseStream.writeSSE({
            event: 'error',
            data: JSON.stringify({ type: 'error', error: r.error }),
          })
        }
      } finally {
        clearInterval(heartbeat)
        if (attachmentRootDir) await cleanupMaterializedRoot(attachmentRootDir)
      }
    })
  }

  // Sync mode
  try {
    const r = await runWithLifecycle(taskId, payload, lifecycleParams)
    if (!r.success) {
      return c.json({ error: r.error }, 500)
    }
    return c.json({
      data: { reply: r.output, chatId: r.chatId, durationMs: r.durationMs, runId },
    })
  } finally {
    if (attachmentRootDir) await cleanupMaterializedRoot(attachmentRootDir)
  }
})

/** GET /agents/:id/chats - 获取 Agent 的会话列表 */
app.get('/:id/chats', async (c) => {
  const { id } = c.req.param()
  await requireAgentRead(c, id)

  const agentRuns = await db
    .select({
      id: runs.id,
      intent: runs.intent,
      status: runs.status,
      result: runs.result,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
      messageCount: sql<number>`(SELECT COUNT(*) FROM chat_messages WHERE chat_messages.run_id = ${runs.id})`,
    })
    .from(runs)
    // Scoped to the caller's own conversations — for every role, admins and the
    // Agent's owner included. Read permission on an Agent is permission to use
    // it, not to read what colleagues asked it: `intent` is the question text
    // verbatim. The chat_app channel makes this load-bearing, since it routes
    // many users' private conversations into this one Agent's run stream.
    // Owners who need usage figures have GET /:id/stats; auditors have the run
    // list and the audit log.
    .where(and(eq(runs.initiatorAgentId, id), chatHistoryScope(c)))
    .orderBy(desc(runs.createdAt))

  return c.json({ data: agentRuns })
})

/** GET /agents/:id/chats/:runId/messages - 获取指定会话的消息 */
app.get('/:id/chats/:runId/messages', async (c) => {
  const { id, runId } = c.req.param()
  await requireAgentRead(c, id)

  // Same ownership scope as the list above: without it, a run id lifted from
  // another user's conversation reads out their full transcript. 404 rather than
  // 403 — the caller should not learn that someone else's run exists.
  const run = (
    await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.initiatorAgentId, id), chatHistoryScope(c)))
      .limit(1)
  )[0]
  if (!run) {
    return c.json({ error: 'Run not found' }, 404)
  }

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.runId, runId))
    .orderBy(chatMessages.createdAt)

  // 附件回显：refs 存在 runSteps.input.attachments（token/name/mimeType），按顺序配到
  // user 消息上，供前端历史里按 token 拉图预览。配对逻辑抽到 attachment-history（可测）。
  const steps = await db
    .select({ input: runSteps.input, order: runSteps.order })
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .orderBy(runSteps.order)
  const paired = pairAttachmentsToMessages(messages, extractStepAttachments(steps))
  const messagesWithAttachments = messages.map((m, i) =>
    paired[i] ? { ...m, attachments: paired[i] } : m,
  )

  // 剥离 executionMetadata（含附件 token / attachmentConsumerId / oauth 内部字段）——与
  // GET /runs/:id 的 public projection 一致，不把内部执行元数据暴露给前端/viewer（review [P2]）。
  const { executionMetadata: _executionMetadata, ...publicRun } = run

  return c.json({
    data: {
      run: publicRun,
      messages: messagesWithAttachments,
    },
  })
})

/** DELETE /agents/:id - 删除 Agent */
app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const { agent } = await requireAgentOwner(c, id)

  if (agent.publishStatus === 'published') {
    return c.json({ error: 'Agent must be stopped before deletion' }, 409)
  }

  const deleteRows = async (executor: typeof db) => {
    await executor.update(runSteps).set({ agentId: null }).where(eq(runSteps.agentId, id))
    await executor
      .update(runs)
      .set({ initiatorAgentId: null, updatedAt: new Date() })
      .where(eq(runs.initiatorAgentId, id))
    return (await executor.delete(agents).where(eq(agents.id, id)).returning())[0]
  }
  const deletion = await deleteAgentWithBindingGuard(id, deleteRows)
  if (!deletion.allowed) {
    if (deletion.active) {
      const label = deletion.active.type === 'run' ? 'Run' : 'Evaluation'
      return c.json(
        { error: `Cannot delete the Agent while ${label} ${deletion.active.id} is active` },
        409,
      )
    }
    return c.json({ error: 'Agent not found' }, 404)
  }

  feishuConnectionManager.stop(id)
  void slackConnectionManager.stop(id)
  void discordConnectionManager.stop(id)
  void qqOfficialConnectionManager.stop(id)
  scheduleTriggerManager.stop(id)
  gitTriggerManager.stopAgent(id)
  revokeAgentTokensForAgent(id)

  removeAgentMemory(id)
  clearAgentIndex(id)

  // Reclaim the per-agent worktree in the background: serial `git worktree
  // remove --force` on a large or multi-repo checkout is seconds of latency,
  // and nothing downstream reads its outcome (failures only log).
  //
  // The row is already gone — `deleteAgentWithBindingGuard` deleted it under
  // the binding guard, which is also what proves no Run or Evaluation still
  // holds this Agent's checkout.
  void removePerAgentWorkspace(agent).catch((err) =>
    logger.warn({ err, agentId: id }, 'Per-agent worktree reclaim failed'),
  )

  logAudit(c, { action: 'agent.delete', resource: 'agent', resourceId: id })

  return c.json({ data: maskAgentSecrets(deletion.value) })
})

export default app
