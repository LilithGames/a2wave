import { GatewayErrorCode, attachmentsInputSchema } from '@a2wave/shared'
import { and, desc, eq } from 'drizzle-orm'
// TODO: oauth-gateway and gateway share ~300 lines of invoke/runs/cancel logic.
// Extract a shared handleInvoke(agent, caller, channelBuilder, triggerSource) helper
// when either route needs to diverge (metrics tags, rate-limit granularity, etc.).
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { db } from '../db/client.js'
import { agents, chatMessages, runSteps, runs } from '../db/schema.js'
import { completeExecutionLease } from '../engine/execution-lease-registry.js'
import { engineRegistry } from '../engine/index.js'
import { allTaskIdVariants, buildTaskId } from '../engine/task-id.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { scheduleNext, tryAcquireSlot } from '../engine/task-queue.js'
import { WorktreeOccupiedError, buildAgentConfig, resolveWorkDir } from '../lib/agent-helpers.js'
import {
  cleanupMaterializedRoot,
  materializeForRun,
  refsToSources,
} from '../lib/attachment-materializer.js'
import { attachmentBodyLimit, handleAttachmentUpload } from '../lib/attachment-upload.js'
import { resolveClientIp } from '../lib/client-ip.js'
import { ProviderConfigurationError } from '../lib/errors.js'
import { executeChatRun } from '../lib/execute-chat-run.js'
import { normalizeOauthAccessMode } from '../lib/gateway-auth-errors.js'
import { WorktreeBranchLockedError, WorktreeDirtyError } from '../lib/git-workspace.js'
import { createId } from '../lib/id.js'
import { logger } from '../lib/logger.js'
import {
  classifyOAuthAuthError,
  classifyOAuthExecutionError,
  classifyOAuthWorkspaceError,
  createOAuthGatewayError,
} from '../lib/oauth-gateway-errors.js'
import {
  buildOAuthTriggerSessionId,
  findActiveOAuthSessionRun,
  isOAuthActiveSessionConflict,
  lookupPreviousOAuthSessionChatId,
} from '../lib/oauth-session.js'
import { registerPendingContext, takePendingContext } from '../lib/pending-job-registry.js'
import { cancelRunningTasksInBackground, claimRunCancellation } from '../lib/run-cancellation.js'
import { buildOAuthChannel, stripReservedContextKeys } from '../lib/run-channel.js'
import { runWithLifecycle } from '../lib/run-launcher.js'
import {
  type GatewayCaller,
  oauthUploaderId,
  validateGatewayAuth,
} from '../middleware/gateway-auth.js'
import { rateLimit } from '../middleware/rate-limit.js'
import type { WorkerTaskPayload } from '../worker/index.js'

function sanitizeOAuthRunResult(
  result: Record<string, unknown> | null | undefined,
  context: { runId: string; engineType?: string },
): Record<string, unknown> | null | undefined {
  if (!result) return result
  const { chatId: _chatId, error, ...sanitized } = result
  if (error !== undefined) {
    return { ...sanitized, error: classifyOAuthExecutionError(error, context).error }
  }
  return sanitized
}

async function resolveOAuthEngineType(
  agent: typeof agents.$inferSelect,
  // Takes the resolved config so callers that already built (and error-handled)
  // one do not rebuild it; the default covers callers that have not.
  agentConfig?: Awaited<ReturnType<typeof buildAgentConfig>>,
): Promise<string> {
  const resolved = agentConfig ?? (await buildAgentConfig(agent))
  return resolved.engineType || agent.type || 'cursor'
}

/**
 * Whether `caller` is authorized to read/cancel `run` on the OAuth channel.
 *
 * A published agent in `all_idaas_users` mode is reachable by many distinct IdP
 * users — separate principals outside the trust boundary — so scoping a run to its
 * agent alone lets any such caller read another user's run.result or cancel their
 * run by learning the runId. Authorization here therefore requires BOTH:
 *
 *  1. The run was created THROUGH the OAuth channel (`triggerSource === 'oauth'`).
 *     A run from any other channel (Feishu / api-key gateway / A2A / scheduled /
 *     chat debug) also lacks `oauthCallerId`, so a bare "no owner → allow" would
 *     expose those runs to any IdP caller of the same agent. Non-OAuth runs are
 *     simply not reachable via this endpoint.
 *  2. The pinned caller identity matches. A pre-deploy legacy OAuth run has no
 *     `oauthCallerId` to compare, and there is no safe way to attribute it, so it
 *     is DENIED rather than allowed — failing closed, not open.
 */
function isOAuthRunCaller(run: typeof runs.$inferSelect, caller: GatewayCaller): boolean {
  if (run.triggerSource !== 'oauth') return false // not an OAuth-channel run
  const owner = run.executionMetadata?.oauthCallerId
  if (!owner) return false // legacy OAuth run, unattributable → fail closed
  return owner === oauthUploaderId(caller)
}

function internalOAuthError(
  details?: Record<string, unknown>,
): ReturnType<typeof createOAuthGatewayError> {
  return createOAuthGatewayError(
    GatewayErrorCode.INTERNAL_ERROR,
    'a2wave could not process the OAuth invocation because of an internal error. Contact the platform administrator and include the runId when available.',
    {
      source: 'platform',
      action: 'contact_platform_administrator',
      retryable: false,
      ...(details ? { details } : {}),
    },
  )
}

function sessionBusyError(
  details: Record<string, unknown>,
): ReturnType<typeof createOAuthGatewayError> {
  return createOAuthGatewayError(
    GatewayErrorCode.SESSION_BUSY,
    'This session already has an active run. Wait for that run to finish before sending the next message.',
    {
      source: 'caller',
      action: 'wait_for_current_run',
      retryable: true,
      details,
    },
  )
}

type OAuthGatewayVariables = {
  gatewayAgent: typeof agents.$inferSelect
  oauthCaller: GatewayCaller
}

function requireOAuthPublishedAgent() {
  return async (c: Context<{ Variables: OAuthGatewayVariables }>, next: Next) => {
    const agentId = c.req.param('agentId')
    const agent = agentId
      ? (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
      : undefined
    if (!agent) {
      return c.json(
        createOAuthGatewayError(
          GatewayErrorCode.AGENT_NOT_FOUND,
          'No agent exists for the requested agentId. Verify the agentId and request URL before retrying.',
          { source: 'caller', action: 'fix_request', retryable: false },
        ),
        404,
      )
    }
    if (agent.publishStatus !== 'published') {
      return c.json(
        createOAuthGatewayError(
          GatewayErrorCode.AGENT_NOT_PUBLISHED,
          'This agent is not published. Ask the agent owner to publish it before retrying.',
          { source: 'agent', action: 'contact_agent_owner', retryable: false },
        ),
        403,
      )
    }

    const publishChannels = (agent.publishChannels as string[]) ?? []
    if (!publishChannels.includes('oauth')) {
      return c.json(
        createOAuthGatewayError(
          GatewayErrorCode.OAUTH_CHANNEL_DISABLED,
          'This agent is published, but OAuth invocation is disabled. Ask the agent owner to enable the OAuth channel.',
          { source: 'agent', action: 'contact_agent_owner', retryable: false },
        ),
        403,
      )
    }

    const clientIp = resolveClientIp(c) ?? 'unknown'

    const authResult = await validateGatewayAuth(
      {
        publishIpWhitelist: (agent.publishIpWhitelist as string[]) || null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: normalizeOauthAccessMode(agent.oauthAccessMode),
        oauthAllowedEmails: (agent.oauthAllowedEmails as string[]) ?? null,
      },
      { clientIp, authorizationHeader: c.req.header('Authorization') },
    )
    if (authResult.error) {
      const classified = classifyOAuthAuthError(authResult.error.error, authResult.error.status)
      return c.json({ error: classified.error }, classified.httpStatus)
    }
    if (!authResult.caller) {
      return c.json(
        createOAuthGatewayError(
          GatewayErrorCode.AUTH_REQUIRED,
          'An access token from your identity provider is required. Sign in to obtain a token, then send it in the Authorization: Bearer <token> header.',
          {
            source: 'caller',
            action: 'obtain_new_access_token',
            retryable: false,
          },
        ),
        401,
      )
    }
    c.set('oauthCaller', authResult.caller)
    c.set('gatewayAgent', agent)
    await next()
  }
}

const app = new Hono<{ Variables: OAuthGatewayVariables }>()

app.onError((err, c) => {
  logger.error({ err }, 'Unhandled OAuth gateway error')
  return c.json(internalOAuthError(), 500)
})

app.use('*', rateLimit({ windowMs: 60_000, max: 60 }))
app.use('/:agentId/*', requireOAuthPublishedAgent())

// oauthUploaderId 已提升到 middleware/gateway-auth.ts 单点定义（OAuth-A2A 消费端同用，
// 防格式漂移）：用户级身份隔离——否则都用 agent:<id>，用户 B 拿到 A 的 token 就能消费
// A 的附件（review [P1]）。

// 附件上传（OAuth/企业 IdP JWT 鉴权，两步上传第一步）。uploaderId = oauth:<issuer>:<sub>，GET 取回
// 时上传者本人可读，其它成员经 attachment_refs 成员鉴权放行。鉴权已由中间件完成。
app.post('/:agentId/attachments', attachmentBodyLimit, (c) => {
  const caller = c.get('oauthCaller')
  return handleAttachmentUpload(c, oauthUploaderId(caller))
})

app.post('/:agentId/invoke', async (c) => {
  const { agentId } = c.req.param()
  const agent = c.get('gatewayAgent')
  const oauthCaller = c.get('oauthCaller')

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.INVALID_REQUEST,
        'The request body is not valid JSON. Send a JSON object with a non-empty message field.',
        { source: 'caller', action: 'fix_request', retryable: false },
      ),
      400,
    )
  }
  const schema = z.object({
    message: z.string().min(1).max(100_000),
    context: z.record(z.string(), z.unknown()).optional(),
    sessionId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    resetSession: z.boolean().default(false),
    stream: z.boolean().default(false),
    async: z.boolean().default(true),
    attachments: attachmentsInputSchema,
  })
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.INVALID_REQUEST,
        'The request body is invalid. Correct the fields described in error.details, then retry.',
        {
          source: 'caller',
          action: 'fix_request',
          retryable: false,
          details: parsed.error.flatten(),
        },
      ),
      400,
    )
  }

  let agentConfig: Awaited<ReturnType<typeof buildAgentConfig>>
  try {
    // Must be awaited INSIDE the try: buildAgentConfig is async, so it rejects
    // rather than throwing synchronously. Without this the catch below is dead
    // code and ProviderConfigurationError escapes to Hono as a bare 500 instead
    // of the documented 424.
    agentConfig = await buildAgentConfig(agent)
  } catch (error) {
    if (error instanceof ProviderConfigurationError) {
      return c.json(
        createOAuthGatewayError(GatewayErrorCode.AGENT_CONFIGURATION_ERROR, error.message, {
          source: 'agent',
          action: 'contact_agent_owner',
          retryable: false,
          details: {
            providerId: error.providerId,
            providerKind: error.providerKind,
          },
        }),
        424,
      )
    }
    throw error
  }

  const engineType = await resolveOAuthEngineType(agent, agentConfig)
  if (!engineRegistry.get(engineType)) {
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.AGENT_CONFIGURATION_ERROR,
        "This agent's execution engine is unavailable. Ask the agent owner or platform administrator to correct the engine configuration.",
        {
          source: 'agent',
          action: 'contact_agent_owner',
          retryable: false,
          details: { engineType },
        },
      ),
      424,
    )
  }

  // Security: strip server-reserved keys (channel / caller / receive_id*) — an
  // OAuth caller could otherwise inject receive_id to weaponize the agent's Feishu
  // bot into a DM-to-arbitrary-target vector (oauth-gateway → registerPendingContext
  // → executeChatRun → runSteps.input.context → finishRun* reply-by-context).
  const stepContext: Record<string, unknown> = stripReservedContextKeys(parsed.data.context)
  const channelResult = buildOAuthChannel(c, { oauthCaller })
  stepContext.channel = channelResult.ctx
  const triggerSessionId = parsed.data.sessionId
    ? buildOAuthTriggerSessionId({
        agentId,
        caller: oauthCaller,
        sessionId: parsed.data.sessionId,
      })
    : undefined

  const activeSessionRun = triggerSessionId
    ? await findActiveOAuthSessionRun(agentId, triggerSessionId)
    : undefined
  if (activeSessionRun) {
    return c.json(
      sessionBusyError({
        runId: (await activeSessionRun).id,
        status: (await activeSessionRun).status,
      }),
      409,
    )
  }

  const previousChatId =
    triggerSessionId && !parsed.data.resetSession
      ? await lookupPreviousOAuthSessionChatId(agentId, triggerSessionId)
      : null

  const runId = createId('run')
  // 排队路径把附件 refs 藏进 pending-context 的内部保留键 __attachments，供 executeChatRun
  // 出队时 materialize；即时路径不走这里、在下方内联落盘。
  const attachmentRefs = parsed.data.attachments
  const pendingContext =
    attachmentRefs && attachmentRefs.length > 0
      ? { ...stepContext, __attachments: attachmentRefs }
      : stepContext
  const hasPendingContext = Object.keys(pendingContext).length > 0
  // executionMetadata 合并 oauth 会话字段（含 main 侧新增的 oauthEngineType，供错误分类/
  // 结果脱敏读取）+ 排队附件持久化（refs + 消费者身份），后者供出队时读取，不只依赖内存
  // pending-context（TTL/重启会丢，review [P1]）。
  const executionMetadata = {
    oauthEngineType: engineType,
    // Pin the calling IdP identity so run read/cancel can authorize per-caller
    // (not just per-agent) — two distinct OAuth callers of one shared agent are
    // separate principals and must not read/cancel each other's runs.
    oauthCallerId: oauthUploaderId(oauthCaller),
    ...(previousChatId ? { oauthPreviousChatId: previousChatId } : {}),
    ...(parsed.data.resetSession ? { oauthResetSession: true } : {}),
    ...(attachmentRefs && attachmentRefs.length > 0
      ? { attachments: attachmentRefs, attachmentConsumerId: oauthUploaderId(oauthCaller) }
      : {}),
  }
  try {
    await db.insert(runs).values({
      id: runId,
      intent: parsed.data.message,
      initiatorAgentId: agentId,
      status: 'pending',
      triggerSource: 'oauth',
      triggerUserName: channelResult.displayName,
      ...(triggerSessionId ? { triggerSessionId } : {}),
      // oauthEngineType 恒在 → executionMetadata 恒非空，直接写入。
      executionMetadata,
    })
  } catch (err) {
    if (triggerSessionId && isOAuthActiveSessionConflict(err)) {
      const racedRun = await findActiveOAuthSessionRun(agentId, triggerSessionId)
      return c.json(
        sessionBusyError({
          ...(racedRun ? { runId: racedRun.id, status: racedRun.status } : {}),
        }),
        409,
      )
    }
    throw err
  }
  if (hasPendingContext) registerPendingContext(runId, pendingContext)

  const maxConcurrency = agent.maxConcurrency ?? 1
  const slotResult = await tryAcquireSlot(taskQueueDb, agentId, runId, maxConcurrency)

  if (slotResult === 'queue_full') {
    if (hasPendingContext) takePendingContext(runId)
    await db.delete(runs).where(eq(runs.id, runId))
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.AGENT_QUEUE_FULL,
        'This agent has reached its queue limit. Retry after an active run finishes.',
        { source: 'agent', action: 'retry_later', retryable: true, details: { runId } },
      ),
      429,
    )
  }

  if (slotResult === 'queued') {
    return c.json(
      {
        data: {
          runId,
          status: 'queued',
          ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
        },
      },
      202,
    )
  }

  if (hasPendingContext) takePendingContext(runId)
  let resolvedWorkDir: string
  try {
    // runId in: the run row was inserted above (immediate path only — queued
    // runs re-resolve inside executeChatRun), so runs.workDir is recorded and
    // the workspace-delete occupancy check sees this run.
    resolvedWorkDir = await resolveWorkDir(agent, undefined, runId, agentConfig.agentEnv)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db
      .update(runs)
      .set({
        status: 'failed',
        result: { error: msg },
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId))
    completeExecutionLease(runId)
    void scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
    const busy =
      err instanceof WorktreeOccupiedError ||
      err instanceof WorktreeBranchLockedError ||
      err instanceof WorktreeDirtyError
    const classified = classifyOAuthWorkspaceError({ runId, busy })
    return c.json({ error: classified.error }, classified.httpStatus)
  }
  // 附件落盘 + prompt 注入（即时路径）。无附件时 mergedPrompt === message、rootDir === null。
  const {
    mergedPrompt,
    rootDir: attachmentRootDir,
    materialized,
  } = await materializeForRun({
    agentId,
    runId,
    message: parsed.data.message,
    sources: refsToSources(attachmentRefs),
    consumerId: oauthUploaderId(oauthCaller), // 与上传端点一致的用户级身份
  })

  const stepId = createId('rst')
  const stepInput: Record<string, unknown> = { message: mergedPrompt, context: stepContext }
  // 只记**实际落盘**的附件（materialized），被拒/过期的不写 chip（review [P2]）。
  if (materialized.length > 0) {
    stepInput.attachments = materialized
  }
  try {
    await db.insert(runSteps).values({
      id: stepId,
      runId,
      agentId,
      order: 1,
      input: stepInput,
      status: 'running',
    })

    await db.insert(chatMessages).values({
      id: createId('msg'),
      runId,
      role: 'user',
      // 存用户原文，不存注入了附件路径的 mergedPrompt（历史回显靠 runSteps.input.attachments）。
      content: parsed.data.message,
    })
  } catch (err) {
    // 先清理已落盘的附件目录（本分支），再走 main 侧的健壮失败收口（标 failed +
    // scheduleNext + 500，不 rethrow——避免槽泄漏）。
    if (attachmentRootDir) await cleanupMaterializedRoot(attachmentRootDir)
    logger.error({ err, runId, agentId }, 'Failed to initialize OAuth run after slot acquisition')
    try {
      await taskQueueDb.failRunSteps(runId)
    } catch (cleanupError) {
      logger.error({ err: cleanupError, runId }, 'Failed to mark OAuth run steps as failed')
    }
    try {
      await db
        .update(runs)
        .set({
          status: 'failed',
          result: { error: 'Run setup failed' },
          updatedAt: new Date(),
        })
        .where(eq(runs.id, runId))
    } catch (cleanupError) {
      logger.error({ err: cleanupError, runId }, 'Failed to mark OAuth run as failed')
    }
    try {
      completeExecutionLease(runId)
      void scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
    } catch (cleanupError) {
      logger.error({ err: cleanupError, runId, agentId }, 'Failed to schedule next OAuth run')
    }
    return c.json(internalOAuthError({ runId }), 500)
  }

  const taskId = buildTaskId('invoke/', runId, stepId)

  const payload: WorkerTaskPayload = {
    taskId,
    prompt: mergedPrompt,
    context: stepContext,
    model: agentConfig.model || undefined,
    workDir: resolvedWorkDir,
    chatId: previousChatId ?? undefined,
    agentConfig,
  }

  const lifecycleParams = { taskId, runId, stepId, agentId, startTime: Date.now() }

  // 分支顺序（main 侧语义）：stream 优先于 async——`stream:true` 即使 async 缺省（默认 true）
  // 也必须走 SSE，否则调用方拿到 202 却收不到流。
  if (parsed.data.stream) {
    return streamSSE(c, async (sseStream) => {
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
            data: JSON.stringify({
              type: 'done',
              reply: r.output,
              runId,
              ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
            }),
          })
        } else {
          // main 侧错误契约：对外只回分类后的 error（引擎细节脱敏）。
          const classified = classifyOAuthExecutionError(r.error, { runId, engineType: engineType })
          await sseStream.writeSSE({
            event: 'error',
            data: JSON.stringify({ type: 'error', error: classified.error }),
          })
        }
      } finally {
        if (attachmentRootDir) await cleanupMaterializedRoot(attachmentRootDir)
      }
    })
  }

  if (parsed.data.async) {
    void runWithLifecycle(taskId, payload, lifecycleParams)
      .catch((err) => {
        logger.error(
          { err, runId, taskId },
          'Unexpected error in async runWithLifecycle (should not happen)',
        )
      })
      .finally(() => {
        if (attachmentRootDir) void cleanupMaterializedRoot(attachmentRootDir)
      })
    return c.json(
      { data: { runId, ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}) } },
      202,
    )
  }

  // 同步路径：finally 清理附件目录（本分支）。
  let r: Awaited<ReturnType<typeof runWithLifecycle>>
  try {
    r = await runWithLifecycle(taskId, payload, lifecycleParams)
  } finally {
    if (attachmentRootDir) await cleanupMaterializedRoot(attachmentRootDir)
  }
  if (!r.success) {
    const classified = classifyOAuthExecutionError(r.error, { runId, engineType: engineType })
    return c.json({ error: classified.error }, classified.httpStatus)
  }
  return c.json({
    data: {
      reply: r.output,
      runId,
      ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
      durationMs: r.durationMs,
    },
  })
})

app.get('/:agentId/runs/:runId', async (c) => {
  const { agentId, runId } = c.req.param()

  const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0]
  if (!run) {
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.RUN_NOT_FOUND,
        'No run exists for the requested runId. Verify the runId returned by invoke.',
        { source: 'caller', action: 'fix_request', retryable: false },
      ),
      404,
    )
  }

  if (run.initiatorAgentId !== agentId) {
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.RUN_OWNERSHIP_MISMATCH,
        'The requested run belongs to a different agent. Use the agentId and runId returned by the same invoke request.',
        { source: 'caller', action: 'fix_request', retryable: false },
      ),
      403,
    )
  }

  // Per-caller authorization: a different OAuth user of the same agent must not
  // read this run's result. Return NOT_FOUND (not a distinct 403) so the runId's
  // existence is not confirmed to a non-owner.
  if (!isOAuthRunCaller(run, c.get('oauthCaller'))) {
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.RUN_NOT_FOUND,
        'No run exists for the requested runId. Verify the runId returned by invoke.',
        { source: 'caller', action: 'fix_request', retryable: false },
      ),
      404,
    )
  }

  return c.json({
    data: {
      runId: run.id,
      status: run.status,
      result: sanitizeOAuthRunResult(run.result, {
        runId,
        engineType:
          typeof run.executionMetadata?.oauthEngineType === 'string'
            ? run.executionMetadata.oauthEngineType
            : await resolveOAuthEngineType(c.get('gatewayAgent')),
      }),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
  })
})

app.post('/:agentId/runs/:runId/cancel', async (c) => {
  const { agentId, runId } = c.req.param()
  const agent = c.get('gatewayAgent')

  const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0]
  if (!run) {
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.RUN_NOT_FOUND,
        'No run exists for the requested runId. Verify the runId returned by invoke.',
        { source: 'caller', action: 'fix_request', retryable: false },
      ),
      404,
    )
  }

  if (run.initiatorAgentId !== agentId) {
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.RUN_OWNERSHIP_MISMATCH,
        'The requested run belongs to a different agent. Use the agentId and runId returned by the same invoke request.',
        { source: 'caller', action: 'fix_request', retryable: false },
      ),
      403,
    )
  }

  // Per-caller authorization: a different OAuth user of the same agent must not
  // cancel this run. NOT_FOUND (not a distinct 403) avoids confirming the runId.
  if (!isOAuthRunCaller(run, c.get('oauthCaller'))) {
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.RUN_NOT_FOUND,
        'No run exists for the requested runId. Verify the runId returned by invoke.',
        { source: 'caller', action: 'fix_request', retryable: false },
      ),
      404,
    )
  }

  if (run.status !== 'running' && run.status !== 'queued') {
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.RUN_NOT_CANCELLABLE,
        `This run cannot be cancelled because its current status is ${run.status}. No further cancellation action is needed.`,
        {
          source: 'caller',
          action: 'fix_request',
          retryable: false,
          details: { runId, status: run.status },
        },
      ),
      400,
    )
  }

  if (!(await claimRunCancellation(runId, run.status))) {
    const latestStatus = (
      await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1)
    )[0]?.status
    return c.json(
      createOAuthGatewayError(
        GatewayErrorCode.RUN_NOT_CANCELLABLE,
        `This run cannot be cancelled because its current status is ${latestStatus ?? 'unknown'}.`,
        { source: 'caller', action: 'fix_request', retryable: false },
      ),
      400,
    )
  }

  if (run.status === 'running') {
    const latestStep = (
      await db
        .select()
        .from(runSteps)
        .where(eq(runSteps.runId, runId))
        .orderBy(desc(runSteps.order))
        .limit(1)
    )[0]

    const taskIdVariants = latestStep ? allTaskIdVariants(runId, latestStep.id) : []
    if (latestStep) {
      await db
        .update(runSteps)
        .set({ status: 'cancelled' })
        .where(and(eq(runSteps.id, latestStep.id), eq(runSteps.status, 'running')))
    }
    cancelRunningTasksInBackground({ runId, agentId, taskIds: taskIdVariants })
  } else {
    takePendingContext(runId)
  }

  if (run.status === 'queued') {
    void scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
  }

  logger.info({ runId, agentId, prevStatus: run.status }, 'Run cancelled via oauth-gateway')

  return c.json({ data: { runId, status: 'cancelled' } })
})

export default app
