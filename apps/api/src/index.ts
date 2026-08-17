import { existsSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { swaggerUI } from '@hono/swagger-ui'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { SqliteTaskStore } from './a2a/sqlite-task-store.js'
import { closeDatabaseConnection, db, isPostgres } from './db/client.js'
import { runMigrations } from './db/migrate-runtime.js'
import { agents, mcpServers } from './db/schema.js'
import {
  pauseEvaluationQueuePromotions,
  recoverEvaluationsOnStartup,
} from './engine/evaluation-queue.js'
import { evaluationQueueDb } from './engine/evaluation-queue-db.js'
import {
  drainActiveExecutionLeases,
  drainDurableExecutionLeaseReleases,
  setDurableExecutionLeaseReleaseHandler,
} from './engine/execution-lease-registry.js'
import { engineRegistry } from './engine/index.js'
import { pauseTaskQueuePromotions, recoverOnStartup, scheduleNext } from './engine/task-queue.js'
import { taskQueueDb } from './engine/task-queue-db.js'
import { env } from './env.js'
import { startArtifactCleanupScheduler } from './lib/artifact-cleanup.js'
import { startAttachmentStagingCleanupScheduler } from './lib/attachment-cleanup.js'
import { drainAuditWrites } from './lib/audit.js'
import { backfillWorkspacesPaths } from './lib/backfill-workspaces-path.js'
import { bootstrapFromEnv } from './lib/bootstrap.js'
import { ensureInstallRootOnPath, recoverInterruptedInstalls } from './lib/cli-installer.js'
import { startDataRetentionSweeper } from './lib/data-retention.js'
import { discordConnectionManager } from './lib/discord-service.js'
import { AppError } from './lib/errors.js'
import { executeChatRun } from './lib/execute-chat-run.js'
import { listPendingMessages } from './lib/feishu-pending-store.js'
import { feishuConnectionManager } from './lib/feishu-service.js'
import { gitTriggerManager } from './lib/git-trigger-manager.js'
import { runGracefulShutdownSequence, SHUTDOWN_HARD_TIMEOUT_MS } from './lib/graceful-shutdown.js'
import {
  beatInstanceHeartbeat,
  deleteInstanceHeartbeat,
  startInstanceHeartbeat,
} from './lib/instance-heartbeat.js'
import { startKbSyncScheduler } from './lib/kb-sync-scheduler.js'
import { logger } from './lib/logger.js'
import { initAutoSyncSchedulers, stopAllAutoSync } from './lib/p4-sync.js'
import { processInstanceId } from './lib/process-instance.js'
import { markReady } from './lib/readiness.js'
import { sanitizeRequestLogPath } from './lib/request-log-path.js'
import { cleanupLegacyRuntimeGroupConfigs } from './lib/runtime-group-config.js'
import { scheduleTriggerManager } from './lib/schedule-trigger.js'
import {
  releaseRecoveredScmWorkload,
  retryScmWorkloadReleaseUntilSuccess,
} from './lib/scm-workload-lifecycle.js'
import {
  clearWorkspaceRemovalsOnStartup,
  drainPendingWorkspaceRemovalReleases,
} from './lib/scm-workspace-removal.js'
import { seedBuiltinMcpServers } from './lib/seed-builtin-mcp.js'
import { seedBuiltinSkills } from './lib/seed-builtin-skills.js'
import { detectServerUrl } from './lib/server-url.js'
import { getSetting, refreshSettingsCache } from './lib/settings.js'
import { ensureAdminExists } from './lib/setup.js'
import { slackConnectionManager } from './lib/slack-service.js'
import { startStaleLeaseSweeper } from './lib/stale-lease-sweeper.js'
import { apiBodyLimit } from './middleware/api-body-limit.js'
import { authMiddleware, memoryAuthMiddleware, requireAdmin } from './middleware/auth-middleware.js'
import { csrfOriginMiddleware } from './middleware/csrf-origin.js'
import { rateLimit } from './middleware/rate-limit.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import { openApiSpec } from './openapi.js'
import a2aRoutes from './routes/a2a.js'
import agentMembersRoutes from './routes/agent-members.js'
import agentSharedRoutes from './routes/agent-shared.js'
import agentsRoutes from './routes/agents.js'
import artifactsRoutes from './routes/artifacts.js'
import attachmentsRoutes from './routes/attachments.js'
import auditLogsRoutes from './routes/audit-logs.js'
import authRoutes from './routes/auth.js'
import authOidcRoutes from './routes/auth-oidc.js'
import authSamlRoutes from './routes/auth-saml.js'
import changelogRoutes from './routes/changelog.js'
import docsRoutes from './routes/docs.js'
import e2eRoutes from './routes/e2e.js'
import evaluationRoutes, {
  drainActiveEvaluationTasks,
  runEvaluationTask,
} from './routes/evaluation.js'
import gatewayRoutes from './routes/gateway.js'
import healthRoutes from './routes/health.js'
import internalRoutes from './routes/internal.js'
import kbDocumentsRoutes from './routes/kb-documents.js'
import mcpServersRoutes from './routes/mcp-servers.js'
import memoriesRoutes from './routes/memories.js'
import oauthGatewayRoutes from './routes/oauth-gateway.js'
import providerClisRoutes from './routes/provider-clis.js'
import providersRoutes, { seedPresetProviders } from './routes/providers.js'
import publicMetadataRoutes from './routes/public-metadata.js'
import runsRoutes from './routes/runs.js'
import scmSourcesRoutes from './routes/scm-sources.js'
import settingsRoutes from './routes/settings.js'
import shareViewRoutes from './routes/share-view.js'
import skillGroupsRoutes from './routes/skill-groups.js'
import skillsRoutes from './routes/skills.js'
import uploadsRoutes from './routes/uploads.js'
import { adminInvitationRoutes, publicInvitationRoutes } from './routes/user-invitations.js'
import userLookupRoutes from './routes/user-lookup.js'
import usersRoutes from './routes/users.js'
import versionRoutes from './routes/version.js'

// Provider CLIs are installed at runtime under A2WAVE_CLI_INSTALL_ROOT; make sure
// that root is on PATH before anything spawns a CLI. The image bakes in the
// default, but an overridden root or a local checkout would otherwise never
// resolve what it just installed.
ensureInstallRootOnPath()

// --- Run database migrations before starting ---
// Awaited: on PostgreSQL the migrator is async, and continuing past it would let
// the boot sequence below query a schema that is still being created.
await runMigrations()

// Versions before execution-scoped Group carriers wrote credentials to a
// deterministic temp path. On upgrade, remove only paths derived from Group ids
// present in this database; the cleanup validates every id and never globs or
// recursively removes temp content. Failures are best-effort and do not block
// startup.
cleanupLegacyRuntimeGroupConfigs(
  await (
    await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.type, 'group'))
  ).map(({ id }) => id),
)

const app = new Hono()

// --- Middleware ---
app.use('*', requestIdMiddleware)
app.use('*', (c, next) => {
  detectServerUrl(c.req.raw.headers)
  return next()
})
app.use('*', secureHeaders())
// credentials: true 必须配合具体 origin（CORS_ORIGIN）才被浏览器接受。
app.use('*', cors({ origin: env.CORS_ORIGIN, credentials: true }))
// CORS 之后：preflight 先由上面的 cors() 应答（OPTIONS 属安全方法，直接放行）。
// 注意 CORS 本身不是 CSRF 防线——它管「谁能读响应」，副作用在浏览器扣下响应体之前
// 就已经落库；SameSite=Lax 也拦不住同注册域下的兄弟子域。详见 csrf-origin.ts。
app.use('*', csrfOriginMiddleware)
// Skip logging for high-frequency polling endpoints to reduce log noise
const POLLING_PATTERNS = [
  /^\/api\/runs\/run_[^/]+$/,
  /\/chats\/[^/]+\/messages$/,
  /^\/api\/agents\/feishu-connections$/,
  /^\/api\/agents\/chat-connections$/,
]
/**
 * hono's default printer is `console.log`, which bypasses pino (so no redaction,
 * and it lands in a different sink than every other app log). Its `path` also
 * keeps the query string. Route it through pino and sanitise the line first —
 * `/api/agents/shared/:token` is an unauthenticated 24h download credential, and
 * the OIDC `code` arrives as a query param. See lib/request-log-path.ts.
 */
const requestLogPrinter = (message: string) => {
  // Shape: "<-- GET /path" | "--> GET /path 200 5ms". Only the path segment can
  // carry a secret, so rebuild the line with that field sanitised.
  const parts = message.split(' ')
  if (parts.length >= 3) {
    parts[2] = sanitizeRequestLogPath(parts[2])
  }
  logger.info(parts.join(' '))
}
app.use('*', (c, next) => {
  if (c.req.method === 'GET' && POLLING_PATTERNS.some((p) => p.test(c.req.path))) {
    return next()
  }
  return honoLogger(requestLogPrinter)(c, next)
})
// 全局 10MB body 上限（main 侧 apiBodyLimit：OAuth 路径回契约化 413）；但**这三个**附件
// 上传端点例外——它们按 settings.attachments.maxFileSizeBytes（管理员可调，含 multipart
// 开销）在各自路由内 attachmentBodyLimit 限制，否则 10MB 文件会先被这里 413。正则精确
// 匹配三条路径，不用 `/attachments$` 泛匹配（会豁免任何以 /attachments 结尾的新端点，
// 绕过全局上限）。
const ATTACHMENT_UPLOAD_PATTERNS = [
  /^\/api\/attachments$/,
  /^\/api\/gateway\/[^/]+\/attachments$/,
  /^\/api\/oauth\/[^/]+\/attachments$/,
]
app.use('*', (c, next) => {
  if (c.req.method === 'POST' && ATTACHMENT_UPLOAD_PATTERNS.some((p) => p.test(c.req.path))) {
    return next()
  }
  return apiBodyLimit()(c, next)
})

// --- API Docs ---
app.get('/api/docs', swaggerUI({ url: '/api/openapi.json' }))
app.get('/api/openapi.json', (c) => c.json(openApiSpec))

// --- Public routes (no auth) ---
app.route('/api/health', healthRoutes)
// Public on purpose: the login footer renders the version before any session exists.
app.route('/api/version', versionRoutes)
app.route('/api/changelog', changelogRoutes)
app.route('/api/gateway', gatewayRoutes)
app.route('/api/oauth', oauthGatewayRoutes)
app.route('/api/a2a', a2aRoutes)
app.route('/api/internal', internalRoutes)
app.route('/api/docs', docsRoutes)
app.route('/api/uploads', uploadsRoutes)
app.route('/api/attachments', attachmentsRoutes)
app.route('/api/agents/shared', agentSharedRoutes)
app.route('/api/public', publicMetadataRoutes)

// --- Auth routes (status/setup/login are public; me/change-password need auth) ---
const authRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  trustProxy: env.TRUSTED_PROXY,
  trustedProxyAddresses: env.TRUSTED_PROXY_ADDRESSES.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
})
app.use('/api/auth/login', authRateLimit)
app.use('/api/auth/setup', authRateLimit)
// OAuth exchange 公开未鉴权，且每次都要走 IdP JWK 验签（CPU + 网络放大），必须限流
app.use('/api/auth/oauth/exchange', authRateLimit)
app.use('/api/auth/me', authMiddleware)
app.use('/api/auth/locale', authMiddleware)
app.use('/api/auth/onboarding', authMiddleware)
app.use('/api/auth/change-password', authMiddleware)
app.use('/api/auth/logout', authMiddleware)
// 标准 SSO 登录（OIDC / SAML）：公开未鉴权的浏览器跳转流，回调触发验签 + 建号，限流
app.use('/api/auth/oidc/*', authRateLimit)
app.use('/api/auth/saml/*', authRateLimit)
// 邀请注册：公开未鉴权（受邀人此时还没有账号），且 accept 会建号 + Argon2 哈希（CPU 放大），
// code 又是 URL 里的 bearer 凭据，必须限流，否则可被枚举探测。
app.use('/api/auth/invitations/*', authRateLimit)
app.route('/api/auth/invitations', publicInvitationRoutes)
app.route('/api/auth/oidc', authOidcRoutes)
app.route('/api/auth/saml', authSamlRoutes)
app.route('/api/auth', authRoutes)

if (env.NODE_ENV === 'development' && env.E2E_STRICT_AUTH) {
  app.use('/api/e2e/*', authMiddleware, requireAdmin)
  app.use('/api/e2e', authMiddleware, requireAdmin)
  app.route('/api/e2e', e2eRoutes)
}

// --- Protected routes (require auth) ---
app.use('/api/agents/*', (c, next) => {
  // Skip auth for public share download endpoint
  if (c.req.path.startsWith('/api/agents/shared/')) return next()
  return authMiddleware(c, next)
})
app.use('/api/agents', authMiddleware)
app.use('/api/providers/*', authMiddleware)
app.use('/api/providers', authMiddleware)
app.use('/api/mcp-servers/*', authMiddleware)
app.use('/api/mcp-servers', authMiddleware)
app.use('/api/skills/*', authMiddleware)
app.use('/api/skills', authMiddleware)
app.use('/api/skill-groups/*', authMiddleware)
app.use('/api/skill-groups', authMiddleware)
app.use('/api/kb-documents/*', authMiddleware)
app.use('/api/kb-documents', authMiddleware)
app.use('/api/runs/*', authMiddleware)
app.use('/api/runs', authMiddleware)
app.use('/api/scm-sources/*', authMiddleware)
app.use('/api/scm-sources', authMiddleware)
app.route('/api/agents', agentsRoutes)
app.route('/api/agents', agentMembersRoutes)
app.route('/api/agents', evaluationRoutes)
app.route('/api/providers', providersRoutes)
app.route('/api/mcp-servers', mcpServersRoutes)
app.route('/api/skills', skillsRoutes)
app.route('/api/skill-groups', skillGroupsRoutes)
app.route('/api/kb-documents', kbDocumentsRoutes)
app.route('/api/runs', runsRoutes)
app.route('/api/scm-sources', scmSourcesRoutes)
app.use('/api/memories/*', memoryAuthMiddleware)
app.use('/api/memories', memoryAuthMiddleware)
app.route('/api/memories', memoriesRoutes)
app.use('/api/settings/*', authMiddleware)
app.use('/api/settings', authMiddleware)
app.route('/api/settings', settingsRoutes)
app.use('/api/artifacts/*', async (c, next) => {
  if (
    c.req.path.endsWith('/download') &&
    getSetting('artifacts', 'requireAuthForDownload') !== 'true'
  ) {
    return next()
  }
  return authMiddleware(c, next)
})
app.use('/api/artifacts', async (c, next) => {
  if (
    c.req.path.endsWith('/download') &&
    getSetting('artifacts', 'requireAuthForDownload') !== 'true'
  ) {
    return next()
  }
  return authMiddleware(c, next)
})
app.route('/api/artifacts', artifactsRoutes)

// --- Authenticated (non-admin) user lookup for picking collaborators ---
// MUST be registered BEFORE the /api/users admin guard so route resolution
// doesn't conflict (different path prefix, but kept together for clarity).
app.use('/api/user-lookup/*', authMiddleware)
app.use('/api/user-lookup', authMiddleware)
app.route('/api/user-lookup', userLookupRoutes)

// --- Admin-only routes ---
app.use('/api/users/*', authMiddleware, requireAdmin)
app.use('/api/users', authMiddleware, requireAdmin)
app.use('/api/audit-logs/*', authMiddleware, requireAdmin)
app.use('/api/audit-logs', authMiddleware, requireAdmin)
// Installing a CLI runs an installer as the service user, so it is admin-only.
app.use('/api/provider-clis/*', authMiddleware, requireAdmin)
app.use('/api/provider-clis', authMiddleware, requireAdmin)
// Invitation management inherits the admin guard from the /api/users prefix above. It is
// mounted before the users routes so `/users/invitations` resolves here rather than being
// swallowed by a parameterised users path.
app.route('/api/users/invitations', adminInvitationRoutes)
app.route('/api/users', usersRoutes)
app.route('/api/audit-logs', auditLogsRoutes)
app.route('/api/provider-clis', providerClisRoutes)

// --- Public share render route: MUST be before serveStatic SPA fallback ---
app.route('/s', shareViewRoutes)

// --- Static file serving (production: serve frontend from apps/web/dist) ---
const webDistRoot = './apps/web/dist'
if (env.NODE_ENV === 'production' && existsSync(webDistRoot)) {
  app.use('*', serveStatic({ root: webDistRoot }))
  // SPA fallback: serve index.html for non-API routes
  app.use('*', serveStatic({ root: webDistRoot, path: 'index.html' }))
}

// --- 404 ---
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Not Found' }, 404)
  }
  // For non-API routes in production, return 404 JSON (SPA fallback already handled above)
  return c.json({ error: 'Not Found' }, 404)
})

// --- Error handler ---
app.onError((err, c) => {
  const requestId = c.get('requestId' as never) as string | undefined
  if (err instanceof AppError) {
    logger.warn({ err, statusCode: err.statusCode, requestId }, err.message)
    return c.json({ error: err.message, code: err.code, requestId }, err.statusCode as never)
  }
  logger.error({ err, requestId }, 'Unhandled error')
  return c.json({ error: 'Internal Server Error', requestId }, 500)
})

// --- Start server ---
// AUTH_SECRET is now a mandatory startup precondition (env.ts superRefine
// refuses to start without it; the default only exists under NODE_ENV=test),
// so the old "still using the default secret" warning became unreachable and
// was removed.
const port = env.PORT

// Assigned once the HTTP server is bound (see startListening below). Graceful
// shutdown references it, so it is a mutable holder rather than a const — the
// listen is deliberately deferred until the admin account is bootstrapped so the
// first-boot /auth/setup race cannot be won by an unauthenticated caller.
let server: ReturnType<typeof serve> | undefined

// Set once the pre-listen bootstrap starts the beat; shutdown stops it before
// deleting the row so an interval tick cannot resurrect a released heartbeat.
let stopInstanceHeartbeat: (() => void) | undefined

setDurableExecutionLeaseReleaseHandler(async (runId, agentId) => {
  await retryScmWorkloadReleaseUntilSuccess({
    type: 'run',
    workloadId: runId,
    ownerInstanceId: processInstanceId,
  })
  if (agentId) {
    await scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
  }
})

function startListening(): ReturnType<typeof serve> {
  const srv = serve(
    {
      fetch: app.fetch,
      port,
      hostname: env.HOST,
    },
    // Log the banner only once we are actually listening — previously it printed
    // before bind, so an EADDRINUSE crash appeared right after a success line.
    async () => {
      logger.info(`🌊 a2wave API listening on http://localhost:${port}`)
      if (env.HOST === '0.0.0.0') {
        const nets = Object.values(
          await import('node:os').then((m) => m.networkInterfaces()),
        ).flat()
        const lanIp = nets.find((n) => n && n.family === 'IPv4' && !n.internal)?.address
        if (lanIp) logger.info(`🌐 Network: http://${lanIp}:${port}`)
      }
    },
  )

  // @hono/node-server attaches no 'error' listener, so a bind failure crashes
  // with a raw uncaught stack; translate the by-far-most-common one and keep a
  // uniform logged-then-exit failure path for the rest (re-throwing inside an
  // 'error' listener would only surface as an unlogged uncaughtException).
  srv.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `✗ Port ${port} is already in use — another dev server or an orphaned process holds it. Run \`pnpm stop\` to free it, or set PORT in .env to use a different port.`,
      )
    } else {
      logger.error(err, '✗ HTTP server failed to start')
    }
    process.exit(1)
  })

  return srv
}

// --- Graceful shutdown ---
let shuttingDown = false

function gracefulShutdown(signal: string) {
  // Reentrancy matters more than it looks: fail-stop calls this on its own,
  // and Kubernetes will usually follow with a SIGTERM once probes fail. A
  // second pass would close an already-closing server and re-run every drain.
  if (shuttingDown) {
    logger.info(`Shutdown already in progress; ignoring ${signal}`)
    return
  }
  shuttingDown = true
  logger.info(`Received ${signal}, shutting down gracefully...`)
  pauseTaskQueuePromotions()
  pauseEvaluationQueuePromotions()
  // Not unref'd, deliberately. On the signal path an unref'd timer is
  // harmless because the process is exiting anyway; on the fail-stop path the
  // process decided to stop *itself*, and the very condition that triggered it
  // — an unreachable database — is also what can wedge a drain. This deadline
  // is the only thing guaranteeing the owner is gone before the peer-death
  // threshold lets another replica reclaim its checkout, so it must keep the
  // event loop alive until it fires.
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit')
    process.exit(1)
  }, SHUTDOWN_HARD_TIMEOUT_MS)
  // The server may not be listening yet if a signal arrives during the pre-listen
  // admin bootstrap; run the teardown sequence directly in that case.
  if (!server) {
    void runGracefulShutdownSequence({
      shutdownEngines: () => engineRegistry.shutdown(),
      stopFeishu: () => feishuConnectionManager.stopAll(),
      stopSlack: () => slackConnectionManager.stopAll(),
      stopDiscord: () => discordConnectionManager.stopAll(),
      stopSchedules: () => {
        scheduleTriggerManager.stopAll()
        gitTriggerManager.stopAll()
        // Also aborts in-flight sync/index child processes, which run their own
        // execFile and are therefore invisible to engineRegistry.shutdown().
        stopAllAutoSync()
      },
      drainExecutionLeases: async () => {
        await Promise.all([drainActiveExecutionLeases(), drainActiveEvaluationTasks()])
        await drainDurableExecutionLeaseReleases()
      },
      drainWorkspaceRemovalReleases: drainPendingWorkspaceRemovalReleases,
      drainAuditWrites: () => drainAuditWrites(),
      releaseInstanceHeartbeat: async () => {
        stopInstanceHeartbeat?.()
        await deleteInstanceHeartbeat()
      },
      closeDatabase: () => closeDatabaseConnection(),
    }).finally(() => {
      clearTimeout(forceExit)
      process.exit(0)
    })
    return
  }
  server.close(async () => {
    logger.info('HTTP server closed')
    // Reap agent CLI children (and their process groups) and AWAIT their exit
    // BEFORE closing the DB — otherwise process.exit fires while subprocesses
    // are still alive/writing, leaving orphans reparented to PID 1 that keep
    // mutating the workspace after the pod "shuts down".
    await runGracefulShutdownSequence({
      shutdownEngines: () => engineRegistry.shutdown(),
      stopFeishu: () => feishuConnectionManager.stopAll(),
      stopSlack: () => slackConnectionManager.stopAll(),
      stopDiscord: () => discordConnectionManager.stopAll(),
      stopSchedules: () => {
        scheduleTriggerManager.stopAll()
        gitTriggerManager.stopAll()
        // Also aborts in-flight sync/index child processes, which run their own
        // execFile and are therefore invisible to engineRegistry.shutdown().
        stopAllAutoSync()
      },
      drainExecutionLeases: async () => {
        await Promise.all([drainActiveExecutionLeases(), drainActiveEvaluationTasks()])
        await drainDurableExecutionLeaseReleases()
      },
      drainWorkspaceRemovalReleases: drainPendingWorkspaceRemovalReleases,
      drainAuditWrites: () => drainAuditWrites(),
      releaseInstanceHeartbeat: async () => {
        stopInstanceHeartbeat?.()
        await deleteInstanceHeartbeat()
      },
      closeDatabase: () => closeDatabaseConnection(),
    })
    logger.info('Database connection closed')
    clearTimeout(forceExit)
    process.exit(0)
  })
  // `server.close()` stops accepting new connections but waits for existing
  // ones to end, and an idle keep-alive connection never does. Without this
  // the callback above may not run at all — on the fail-stop path that would
  // leave the deadline as the only exit, discarding every drain.
  //
  // Present on http/https servers since Node 18.2; the HTTP/2 arm of the union
  // does not declare it, hence the guard rather than a cast.
  const closeAllConnections = (
    server as { closeAllConnections?: () => void }
  ).closeAllConnections?.bind(server)
  closeAllConnections?.()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

/**
 * Walk the feishu_pending_messages table and replay each stored event by
 * delegating to the restored Feishu connection. Stale rows whose agent no
 * longer has an active WS connection are left in place for a later retry so
 * that a transient start-up ordering issue does not drop user messages.
 */
async function replayPendingFeishuMessages(): Promise<void> {
  const rows = await listPendingMessages()
  let replayed = 0
  let skipped = 0
  for (const row of rows) {
    try {
      const result = await feishuConnectionManager.replayPendingEvent(row.agentId, row.payload)
      if (result === 'ok') replayed++
      else skipped++
    } catch (err) {
      logger.warn(
        { err, messageId: row.messageId, agentId: row.agentId },
        'Feishu pending replay failed',
      )
      skipped++
    }
  }
  // Always log the completion sentinel, even when there is nothing to replay —
  // integration tests wait on this line to know the async boot pipeline is
  // done and it is safe to assert against the DB.
  logger.info({ replayed, skipped, total: rows.length }, 'Feishu pending message replay completed')
}

// Ensure admin user exists on startup (and set password from ADMIN_PASSWORD if
// provided) BEFORE the server starts listening. Otherwise there is a first-boot
// window where isSetupRequired() is still true and any caller who reaches the
// port can POST /auth/setup to claim the admin account ahead of the configured
// ADMIN_PASSWORD. Gating the listen on this closes that race.
void ensureAdminExists()
  .then(async () => {
    // Liveness must be visible before this instance acquires any durable SCM
    // mark: recovery treats an owner with no heartbeat row as dead, so beating
    // first is what makes this instance's marks untouchable while it lives.
    //
    // AWAITED, and fatal on failure. A fire-and-forget first beat would let
    // this process open its port, admit a Run, and activate a lease while no
    // peer can see it is alive — and a peer past its grace window would then
    // reap that live workload and reclaim its checkout. Refusing to start is
    // the safe end of that trade: an instance that cannot record liveness
    // cannot safely own a shared workspace.
    await beatInstanceHeartbeat()
    stopInstanceHeartbeat = startInstanceHeartbeat(undefined, {
      onOwnershipLost: () => gracefulShutdown('SCM heartbeat lease lost'),
    })
    // Single-process backend: no previous workspace removal can still be
    // running, so every reservation row is a leak from the dead process. Clear
    // before env bootstrap (which otherwise defers SCM changes on such a row)
    // and before the port opens. PostgreSQL must retain peer-owned rows.
    if (!isPostgres) {
      const cleared = await clearWorkspaceRemovalsOnStartup()
      if (cleared > 0) {
        logger.info({ cleared }, 'Cleared leaked workspace removal reservations')
      }
    }
    // Settings must be in the database BEFORE the port opens. bootstrapFromEnv()
    // upserts SETTINGS_* / A2WAVE_OAUTH_* into the settings table; running it
    // after listen left a window where GET /auth/oauth/config answered 200 with an
    // empty config, so the login page rendered without its enterprise SSO entry
    // until the user refreshed. Same reasoning as ensureAdminExists() above:
    // anything that changes what a request is answered goes before listen. It must
    // be awaited — the writes are async, so firing and forgetting would let the
    // cache prime below read rows that have not landed yet.
    await bootstrapFromEnv()
    // Prime the settings cache from the rows bootstrapFromEnv just wrote, for the
    // same "before listen" reason: settings reads are synchronous everywhere (see
    // lib/settings-cache.ts), so on PostgreSQL an unprimed cache would answer the
    // first requests from built-in defaults instead of the configured values.
    await refreshSettingsCache()
    // Settle CLI installs stranded by a crash BEFORE the port opens. This used to
    // run in a setImmediate after markReady(), which left a window where an admin
    // could start an install and have the recovery pass immediately mark their
    // just-claimed row as `error` — the UI then stopped polling and would accept a
    // duplicate install of the same CLI. It is a single bounded UPDATE over one
    // small table, so it does not meaningfully delay listen.
    await recoverInterruptedInstalls()
    server = startListening()
    // All three seeds are awaited, and all three complete BEFORE markReady().
    // They are async on PostgreSQL, so a bare call would resolve after the
    // readiness flag flipped: /api/health/ready would answer 200 while the
    // preset providers / builtin MCP servers / builtin skills rows were still
    // being written, and a rolling update would route traffic straight into
    // that window — exactly what the readiness contract exists to prevent.
    // Awaiting also routes a rejection into the outer .catch below instead of
    // letting it escape as an unhandled rejection.
    await seedPresetProviders()
    await seedBuiltinMcpServers()
    await seedBuiltinSkills()
    // Also before markReady: until a migrated row's worktree root is pinned it
    // resolves from whatever exists on disk, so a request served in that window
    // could compute a different root than the one the row settles on.
    await backfillWorkspacesPaths()
    // Seeding done — this instance may now take traffic. Run recovery below is
    // deliberately NOT gated on: it settles stale rows from a previous process
    // and can take a while, but it does not change how a fresh request is served.
    markReady()
    // Recover task queue on startup:
    //  - running → failed (with structured SERVER_RESTART_DURING_EXEC reason)
    //  - pending orphans (older than PENDING_ORPHAN_TIMEOUT_MS) → failed
    //  - queued → scheduleNext
    // For A2A runs, also sync a2a_tasks state so `tasks/get` reports the failure.
    const recoveryA2aStore = new SqliteTaskStore()
    recoverOnStartup(
      taskQueueDb,
      (runId, agentId) => void executeChatRun(agentId, runId),
      async () => await (await db.select({ id: agents.id }).from(agents)).map((r) => r.id),
      {
        recoverInFlight: !isPostgres,
        onRunFailed: async (run, reason) => {
          if (run.triggerSource === 'a2a' && run.triggerSessionId) {
            await recoveryA2aStore
              .markTaskFailed(run.triggerSessionId, reason.message)
              .catch((err) =>
                logger.warn({ err, runId: run.id }, 'markTaskFailed during recovery failed'),
              )
          }
          if (!isPostgres) {
            await releaseRecoveredScmWorkload({ type: 'run', workloadId: run.id })
          }
        },
      },
    )
      .then((stats) => logger.info({ recovery: stats }, 'Startup task recovery completed'))
      .catch((err) => logger.error(err, 'recoverOnStartup failed'))

    // Evaluation tasks have their own per-agent queue and need the same treatment:
    // running/pending tasks were driven by an in-process loop that no longer
    // exists, so they are failed rather than left spinning forever; queued ones
    // never started and are simply rescheduled.
    // Deferred off the boot path like the run recovery above: a crash can strand
    // hundreds of tasks, and settling them all synchronously would hold the event
    // loop long enough for a startup probe to kill the pod mid-recovery.
    setImmediate(async () => {
      try {
        const evalStats = await recoverEvaluationsOnStartup(evaluationQueueDb, runEvaluationTask, {
          recoverInFlight: !isPostgres,
          onTaskFailed: async (task) => {
            if (!isPostgres) {
              await releaseRecoveredScmWorkload({
                type: 'evaluation',
                workloadId: task.id,
              })
            }
          },
        })
        logger.info({ recovery: evalStats }, 'Startup evaluation recovery completed')
      } catch (err) {
        logger.error(err, 'recoverEvaluationsOnStartup failed')
      }
    })

    // Initialize auto-sync schedulers for SCM sources. Deliberately left AFTER
    // markReady() and not awaited: like the run recovery above it only settles
    // stale rows from a previous process and arms timers — it does not change
    // how a fresh request is answered, so the readiness contract does not cover
    // it, and blocking readiness on a scan of every SCM source would delay a
    // rolling update for no correctness gain. It is async, though, so its
    // rejection is attached here rather than left to escape unhandled.
    initAutoSyncSchedulers().catch((err) => logger.error(err, 'initAutoSyncSchedulers failed'))
    // Start artifact cleanup scheduler
    startArtifactCleanupScheduler()
    // Start attachment staging cleanup scheduler (TTL-based)
    startAttachmentStagingCleanupScheduler()
    // Start KB document sync scheduler
    startKbSyncScheduler()
    // Reclaim leaked execution leases (a leak permanently consumes a queue slot)
    startStaleLeaseSweeper()
    // Daily history retention: prune terminal runs (+cascaded steps/messages) and
    // audit logs older than settings.dataRetention.retentionDays (default 60).
    startDataRetentionSweeper()
    // Restore Feishu WS connections for published agents, then replay any
    // pending message events that were persisted before the last shutdown.
    // We wait for connections so replayPendingEvent can find an active client.
    feishuConnectionManager
      .restoreConnections()
      .then(() => replayPendingFeishuMessages())
      .catch((err) => logger.error(err, 'feishuConnectionManager.restoreConnections failed'))
    slackConnectionManager
      .restoreConnections()
      .catch((err) => logger.error(err, 'slackConnectionManager.restoreConnections failed'))
    discordConnectionManager
      .restoreConnections()
      .catch((err) => logger.error(err, 'discordConnectionManager.restoreConnections failed'))
    scheduleTriggerManager
      .restoreAll()
      .catch((err) => logger.error(err, 'scheduleTriggerManager.restoreAll failed'))
    gitTriggerManager
      .restoreAll()
      .catch((err) => logger.error(err, 'gitTriggerManager.restoreAll failed'))
  })
  .catch((err) => {
    // Without this catch, a throw anywhere in the seed/bootstrap chain above
    // (readonly DB, unwritable data dir, malformed builtin SKILL.md, …) became
    // an unhandled rejection that killed the process seconds AFTER the listening
    // banner — the crash looked disconnected from startup.
    logger.error(err, '✗ Startup bootstrap/seeding failed — the server cannot run without it')
    process.exit(1)
  })

export default app
export type AppType = typeof app
