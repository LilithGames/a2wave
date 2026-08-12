import {
  type GatewayError,
  GatewayErrorCode,
  attachmentsInputSchema,
  worktreeCallParamsSchema,
} from '@a2wave/shared'
import { and, desc, eq } from 'drizzle-orm'
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
import { WorktreeBranchLockedError, WorktreeDirtyError } from '../lib/git-workspace.js'
import { createId } from '../lib/id.js'
import { logger } from '../lib/logger.js'
import { registerPendingContext, takePendingContext } from '../lib/pending-job-registry.js'
import { cancelRunningTasksInBackground, claimRunCancellation } from '../lib/run-cancellation.js'
import { buildGatewayChannel, stripReservedContextKeys } from '../lib/run-channel.js'
import {
  type IdempotentRun,
  findIdempotentRun,
  isActiveOrCompletedRun,
  isRunIdempotencyConflict,
} from '../lib/run-idempotency.js'
import { runWithLifecycle } from '../lib/run-launcher.js'
import { createLogCollector, finishRunError, finishRunSuccess } from '../lib/run-lifecycle.js'
import {
  type GatewayCaller,
  normalizeAuthType,
  validateGatewayAuth,
} from '../middleware/gateway-auth.js'
import { rateLimit } from '../middleware/rate-limit.js'
import type { WorkerTaskPayload } from '../worker/index.js'

function gatewayError(
  code: GatewayErrorCode,
  message: string,
  details?: unknown,
): { error: GatewayError } {
  const err: GatewayError = { code, message }
  if (details !== undefined) err.details = details
  return { error: err }
}

function gatewayIdempotentResponse(c: Context, existing: IdempotentRun) {
  const data = {
    runId: existing.id,
    status: existing.status,
    result: existing.result,
    dedup: true,
  }
  if (
    existing.status === 'pending' ||
    existing.status === 'queued' ||
    existing.status === 'running'
  ) {
    return c.json({ data }, 202)
  }
  return c.json({ data }, 200)
}

// --- Shared auth middleware for all gateway routes ---

/** Hono context variables specific to gateway routes (set by requirePublishedAgent middleware). */
type GatewayVariables = {
  gatewayAgent: typeof agents.$inferSelect
  oauthCaller?: GatewayCaller
}

/** Extract client IP, look up agent, check publish status, and validate auth */
function requirePublishedAgent() {
  return async (c: Context<{ Variables: GatewayVariables }>, next: Next) => {
    const agentId = c.req.param('agentId')
    const agent = agentId
      ? (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
      : undefined
    if (!agent) {
      return c.json(gatewayError(GatewayErrorCode.AGENT_NOT_FOUND, 'Agent not found'), 404)
    }
    if (agent.publishStatus !== 'published') {
      return c.json(
        gatewayError(GatewayErrorCode.AGENT_NOT_PUBLISHED, 'Agent is not published'),
        403,
      )
    }

    const clientIp = resolveClientIp(c) ?? 'unknown'
    const authResult = await validateGatewayAuth(
      {
        publishIpWhitelist: (agent.publishIpWhitelist as string[]) || null,
        publishAuthType: agent.publishAuthType,
        endpointApiKey: agent.endpointApiKey,
      },
      { clientIp, authorizationHeader: c.req.header('Authorization') },
    )
    if (authResult.error) {
      const code =
        authResult.error.error === 'IP not allowed'
          ? GatewayErrorCode.IP_NOT_ALLOWED
          : GatewayErrorCode.AUTH_FAILED
      return c.json(gatewayError(code, authResult.error.error), authResult.error.status)
    }
    if (authResult.caller) {
      c.set('oauthCaller', authResult.caller)
    }

    c.set('gatewayAgent', agent)
    await next()
  }
}

const app = new Hono<{ Variables: GatewayVariables }>()

app.use('*', rateLimit({ windowMs: 60_000, max: 60 }))
app.use('/:agentId/*', requirePublishedAgent())

// 附件上传（外部集成用 Agent API Key 鉴权，两步上传第一步）。uploaderId 记 agent id，
// 便于 GET 取回时按「该 Agent 成员」放行。走 requirePublishedAgent 中间件已完成鉴权。
app.post('/:agentId/attachments', attachmentBodyLimit, (c) => {
  const { agentId } = c.req.param()
  return handleAttachmentUpload(c, `agent:${agentId}`)
})

app.post('/:agentId/invoke', async (c) => {
  const { agentId } = c.req.param()
  const agent = c.get('gatewayAgent')
  const oauthCaller = c.get('oauthCaller')

  const body = await c.req.json().catch(() => ({}))
  const schema = z.object({
    message: z.string().min(1).max(100_000),
    context: z.record(z.string(), z.unknown()).optional(),
    stream: z.boolean().default(false),
    async: z.boolean().default(true),
    worktree: worktreeCallParamsSchema.optional(),
    attachments: attachmentsInputSchema,
  })
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      gatewayError(
        GatewayErrorCode.INVALID_REQUEST,
        'Invalid request body',
        parsed.error.flatten(),
      ),
      400,
    )
  }
  // Reserved namespace, rejected only for NEW requests: an explicit worktree
  // addressing a per-agent workspace would downgrade its persistent state and
  // hand its long-lived branch to run-end removal. Sticky configs persisted
  // before this rule keep replaying (grandfathered in resolveWorkDir).
  if (parsed.data.worktree?.name.startsWith('agent-')) {
    return c.json(
      gatewayError(
        GatewayErrorCode.INVALID_REQUEST,
        "Worktree names with the 'agent-' prefix are reserved for per-agent workspaces",
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
        gatewayError(GatewayErrorCode.AGENT_CONFIGURATION_ERROR, error.message, {
          providerId: error.providerId,
          providerKind: error.providerKind,
        }),
        424,
      )
    }
    throw error
  }

  const engineType = agentConfig.engineType || 'cursor'
  if (!engineRegistry.get(engineType)) {
    return c.json(
      gatewayError(
        GatewayErrorCode.ENGINE_NOT_FOUND,
        `No engine registered for type "${engineType}"`,
      ),
      400,
    )
  }

  // Idempotency: clients can set X-Idempotency-Key to dedupe retries within
  // the window that the matching run is still alive. Key is stored in
  // runs.triggerSessionId (indexed alongside agent/source/status).
  const idempotencyKey = c.req.header('x-idempotency-key')
  if (idempotencyKey) {
    const existing = await findIdempotentRun(agentId, 'api', idempotencyKey)
    if (existing && isActiveOrCompletedRun(existing.status)) {
      logger.debug(
        { agentId, idempotencyKey, runId: existing.id, status: existing.status },
        'Gateway idempotent hit',
      )
      return gatewayIdempotentResponse(c, existing)
    }
  }

  // Build the request-time step context up-front so both the acquired and queued
  // paths persist the unified channel context (for queued runs we register it via
  // the pending-context registry; executeChatRun picks it up on dequeue).
  //
  // Security: strip server-reserved keys (channel / caller / receive_id*) from
  // user-supplied context BEFORE spreading. See stripReservedContextKeys for the
  // full rationale (audit-trail spoofing + Feishu DM-injection vector). Centralized
  // so every ingress endpoint shares one contract.
  const stepContext: Record<string, unknown> = stripReservedContextKeys(parsed.data.context)
  const channelResult = buildGatewayChannel(c, {
    channel: 'api',
    authType: normalizeAuthType(agent.publishAuthType),
    oauthCaller,
  })
  stepContext.channel = channelResult.ctx

  // Worktree 参数：在入库 run 记录时一并写入，保证排队场景调度器能读到
  const worktreeCfg = parsed.data.worktree
    ? {
        name: parsed.data.worktree.name,
        cleanup: parsed.data.worktree.cleanup,
        ...(parsed.data.worktree.branch ? { branch: parsed.data.worktree.branch } : {}),
      }
    : null

  // Execute: acquire slot or queue
  const runId = createId('run')
  // Pre-reserve the runId's context in the in-memory registry BEFORE the DB insert
  // + tryAcquireSlot. This guarantees that if any future code inserts an await
  // between `insert(runs)` and the queued-branch register, scheduleNext (fired by
  // a concurrent run completion) can never pop this runId off the queue without
  // its context already being visible to takePendingContext. Cleaned up below on
  // the queue_full / acquired branches so only queued runs retain the registry entry.
  // 排队路径把附件 refs 藏进 pending-context 的内部保留键 __attachments，供 executeChatRun
  // 出队时 materialize（run.intent 无法承载 refs）。即时路径不走这里、在下方内联落盘。
  const attachmentRefs = parsed.data.attachments
  const pendingContext =
    attachmentRefs && attachmentRefs.length > 0
      ? { ...stepContext, __attachments: attachmentRefs }
      : stepContext
  const hasPendingContext = Object.keys(pendingContext).length > 0
  if (hasPendingContext) registerPendingContext(runId, pendingContext)
  try {
    await db.insert(runs).values({
      id: runId,
      intent: parsed.data.message,
      initiatorAgentId: agentId,
      status: 'pending',
      triggerSource: 'api',
      triggerUserName: channelResult.displayName,
      worktreeConfig: worktreeCfg ?? undefined,
      ...(idempotencyKey ? { triggerSessionId: idempotencyKey } : {}),
      // 排队附件持久化：refs + 消费者身份存 run 行，出队时读——不只依赖内存 pending-context
      // （其 1h TTL < run 最长 120min，且重启即丢，review [P1]）。
      ...(attachmentRefs && attachmentRefs.length > 0
        ? {
            executionMetadata: {
              attachments: attachmentRefs,
              attachmentConsumerId: `agent:${agentId}`,
            },
          }
        : {}),
    })
  } catch (err) {
    if (hasPendingContext) takePendingContext(runId)
    if (idempotencyKey && isRunIdempotencyConflict(err)) {
      const existing = await findIdempotentRun(agentId, 'api', idempotencyKey)
      if (existing && isActiveOrCompletedRun(existing.status)) {
        logger.debug(
          { agentId, idempotencyKey, runId: existing.id, status: existing.status },
          'Gateway idempotent insert conflict',
        )
        return gatewayIdempotentResponse(c, existing)
      }
    }
    throw err
  }

  const maxConcurrency = agent.maxConcurrency ?? 1
  const slotResult = await tryAcquireSlot(taskQueueDb, agentId, runId, maxConcurrency)

  if (slotResult === 'queue_full') {
    if (hasPendingContext) takePendingContext(runId)
    await db.delete(runs).where(eq(runs.id, runId))
    return c.json(gatewayError(GatewayErrorCode.EXECUTION_ERROR, 'Agent queue is full'), 429)
  }

  if (slotResult === 'queued') {
    // Context already registered above (pre-reserve pattern from MR !83
    // follow-ups); executeChatRun will take it on dequeue.
    return c.json({ data: { runId, status: 'queued' } }, 202)
  }

  // Slot acquired — context is assembled into runSteps below synchronously, so
  // drop the pre-reserved registry entry to avoid a stale reference.
  if (hasPendingContext) takePendingContext(runId)

  // resolveWorkDir BEFORE inserting runSteps/chatMessages，避免 409 场景留下孤儿记录。
  // 传入 runId 让 resolveWorkDir 在同步事务内完成占用检查 + workDir 写回，
  // 防止并发请求在 createWorkspace 的 await 窗口里都通过占用检查。
  let resolvedWorkDir: string
  try {
    resolvedWorkDir = await resolveWorkDir(agent, parsed.data.worktree, runId, agentConfig.agentEnv)
  } catch (err) {
    // The run row already exists and the queue counts it as occupying a
    // concurrency slot, so it must be reclaimed on EVERY failure path — not
    // just the three typed ones. Leaving it behind wedges the Agent at
    // maxConcurrency forever, recoverable only by editing the database.
    await db.delete(runs).where(eq(runs.id, runId))
    completeExecutionLease(runId)
    void scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
    if (
      err instanceof WorktreeOccupiedError ||
      err instanceof WorktreeBranchLockedError ||
      err instanceof WorktreeDirtyError
    ) {
      return c.json(gatewayError(GatewayErrorCode.EXECUTION_ERROR, err.message), 409)
    }
    throw err
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
    consumerId: `agent:${agentId}`, // 上传经 gateway 上传端点，uploaderId=agent:<id>
  })

  const stepId = createId('rst')
  const stepInput: Record<string, unknown> = { message: mergedPrompt, context: stepContext }
  // 只记**实际落盘**的附件（materialized），被拒/过期的不写 chip（review [P2]）。
  if (materialized.length > 0) {
    stepInput.attachments = materialized
  }
  // materialize 已建 rootDir；到进入下方 lifecycle 的 finally 之前若 insert 抛错，rootDir 会
  // 泄漏（review [P2]）。这里兜一层：insert 失败即清理落盘目录再 rethrow。
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
    if (attachmentRootDir) await cleanupMaterializedRoot(attachmentRootDir)
    completeExecutionLease(runId)
    throw err
  }

  const taskId = buildTaskId('invoke/', runId, stepId)

  const payload: WorkerTaskPayload = {
    taskId,
    prompt: mergedPrompt,
    // Use stepContext (which already merges parsed.data.context + channel) so the
    // executor sees the unified channel context, not just the audit log.
    context: stepContext,
    model: agentConfig.model || undefined,
    workDir: resolvedWorkDir,
    agentConfig,
  }

  // workDir 必须透传给 lifecycleParams —— finishRunSuccess 靠它决定是否扫描并注册产物。
  // 缺失会导致 ephemeral cleanup 先跑、产物随磁盘目录被删（见 run-lifecycle.ts:154）。
  // userId 用 agent 所有者兜底，让 gateway 触发的产物归属 agent 创建者。
  const lifecycleParams = {
    taskId,
    runId,
    stepId,
    agentId,
    startTime: Date.now(),
    workDir: resolvedWorkDir,
    userId: agent.userId ?? undefined,
  }

  // --- Async mode: fire-and-forget (runWithLifecycle never throws) ---
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
    return c.json({ data: { runId } }, 202)
  }

  // --- Stream mode ---
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
            data: JSON.stringify({ type: 'done', reply: r.output, runId }),
          })
        } else {
          await sseStream.writeSSE({
            event: 'error',
            data: JSON.stringify({ type: 'error', error: r.error }),
          })
        }
      } finally {
        if (attachmentRootDir) await cleanupMaterializedRoot(attachmentRootDir)
      }
    })
  }

  // --- Sync mode ---
  let r: Awaited<ReturnType<typeof runWithLifecycle>>
  try {
    r = await runWithLifecycle(taskId, payload, lifecycleParams)
  } finally {
    if (attachmentRootDir) await cleanupMaterializedRoot(attachmentRootDir)
  }
  if (!r.success) {
    return c.json(
      gatewayError(GatewayErrorCode.EXECUTION_ERROR, r.error ?? 'Execution failed'),
      500,
    )
  }
  return c.json({ data: { reply: r.output, runId, durationMs: r.durationMs } })
})

app.get('/:agentId/runs/:runId', async (c) => {
  const { agentId, runId } = c.req.param()

  const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0]
  if (!run) {
    return c.json(gatewayError(GatewayErrorCode.RUN_NOT_FOUND, 'Run not found'), 404)
  }

  if (run.initiatorAgentId !== agentId) {
    return c.json(
      gatewayError(GatewayErrorCode.RUN_OWNERSHIP_MISMATCH, 'Run does not belong to this agent'),
      403,
    )
  }

  return c.json({
    data: {
      runId: run.id,
      status: run.status,
      result: run.result,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
  })
})

/** POST /:agentId/runs/:runId/cancel — 外部取消端点 */
app.post('/:agentId/runs/:runId/cancel', async (c) => {
  const { agentId, runId } = c.req.param()
  const agent = c.get('gatewayAgent')

  const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0]
  if (!run) {
    return c.json(gatewayError(GatewayErrorCode.RUN_NOT_FOUND, 'Run not found'), 404)
  }

  if (run.initiatorAgentId !== agentId) {
    return c.json(
      gatewayError(GatewayErrorCode.RUN_OWNERSHIP_MISMATCH, 'Run does not belong to this agent'),
      403,
    )
  }

  if (run.status !== 'running' && run.status !== 'queued') {
    return c.json(
      gatewayError(
        GatewayErrorCode.RUN_NOT_CANCELLABLE,
        `Run is not cancellable (current status: ${run.status})`,
      ),
      400,
    )
  }

  if (!(await claimRunCancellation(runId, run.status))) {
    const latestStatus = (
      await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1)
    )[0]?.status
    return c.json(
      gatewayError(
        GatewayErrorCode.RUN_NOT_CANCELLABLE,
        `Run is not cancellable (current status: ${latestStatus ?? 'unknown'})`,
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
    // Drop pending request context only after queued cancellation wins its CAS.
    takePendingContext(runId)
  }

  // A queued run owns no process, so its slot can be advanced immediately.
  if (run.status === 'queued') {
    void scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
  }

  logger.info({ runId, agentId, prevStatus: run.status }, 'Run cancelled via gateway')

  return c.json({ data: { runId, status: 'cancelled' } })
})

export default app
