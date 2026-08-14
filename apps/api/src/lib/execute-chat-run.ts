import type { WorktreeCallParams } from '@a2wave/shared'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, chatMessages, runSteps, runs, scmSources } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { completeExecutionLease } from '../engine/execution-lease-registry.js'
import { buildTaskId } from '../engine/task-id.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { scheduleNext } from '../engine/task-queue.js'
import type { WorkerTaskPayload } from '../worker/index.js'
import { WorktreeOccupiedError, buildAgentConfig, resolveWorkDir } from './agent-helpers.js'
import {
  type AttachmentSource,
  cleanupMaterializedRoot,
  materializeForRun,
  refsToSources,
} from './attachment-materializer.js'
import { WorktreeBranchLockedError, WorktreeDirtyError } from './git-workspace.js'
import { createId } from './id.js'
import { logger } from './logger.js'
import { resolveNativeChatAttachments } from './native-chat-attachments.js'
import { lookupPreviousOAuthSessionChatId } from './oauth-session.js'
import { sweepPendingContexts, takePendingContext, takePendingJob } from './pending-job-registry.js'
import { retryUntilSuccess } from './retry-until-success.js'
import { runWithLifecycle } from './run-launcher.js'
import { cleanupWorkspaceOrHandOff } from './workspace-cleanup-retry.js'

/**
 * Execute a chat run (used for both immediate execution and queued run scheduling).
 * For queued runs, call this from scheduleNext's onExecute callback.
 *
 * If a pending Feishu job was registered for this runId (via registerPendingJob),
 * the closure is executed instead — preserving full Feishu reply capabilities
 * (streaming card, quote reply, etc.).
 */
export async function executeChatRun(
  agentId: string,
  runId: string,
  context?: Record<string, unknown>,
): Promise<void> {
  // Opportunistic leak defense for the in-memory pending-context registry.
  // Covers paths that bypass the cancel / take cleanup (worker crash, direct
  // run deletion). No-op in the common case.
  sweepPendingContexts()

  const pendingJob = takePendingJob(runId)
  // Fire-and-forget: the closure should have its own error handling, but add a safety net
  if (pendingJob) {
    void pendingJob().catch((err) => logger.error({ err, runId }, 'Pending job threw unexpectedly'))
    return
  }

  // If a request-time context was registered (e.g. OAuth caller from REST gateway
  // queued path), it takes precedence over any context passed by the caller.
  const pendingContext = takePendingContext(runId)
  let effectiveContext = pendingContext ? { ...(context ?? {}), ...pendingContext } : context

  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
  if (!agent) {
    logger.warn({ agentId, runId }, 'Agent not found for executeChatRun')
    const orphanedRun = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0]
    if (orphanedRun?.status === 'running') {
      await failRunBeforeLifecycle(runId, agentId, 'Agent not found')
    } else {
      completeExecutionLease(runId)
    }
    return
  }

  const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0]
  if (!run) {
    logger.warn({ runId }, 'Run not found for executeChatRun')
    completeExecutionLease(runId)
    return
  }
  if (run.status !== 'running') {
    logger.info({ runId, status: run.status }, 'Skipping execution for a non-running run')
    completeExecutionLease(runId)
    return
  }

  // Native chat events persist their channel context before acknowledgement. Restore it when a
  // queued run is executed after a process restart and the in-memory context no longer exists.
  if (!effectiveContext) {
    const nativeChatContext = run.executionMetadata?.nativeChatContext
    if (nativeChatContext && typeof nativeChatContext === 'object') {
      effectiveContext = { ...nativeChatContext }
    }
  }

  // Extract the internal attachment key only after all recoverable context sources are resolved.
  const pendingAttachmentSources = extractPendingAttachments(effectiveContext)

  // 附件来源：优先用持久化到 run 行的 refs（防内存 TTL/重启丢失），回退内存 pending-context。
  // consumerId 同样从持久化元数据读（内存路径无此信息）。
  const persistedAttachments = run.executionMetadata?.attachments
  const persistedAttachmentSources =
    (persistedAttachments && persistedAttachments.length > 0
      ? refsToSources(persistedAttachments)
      : pendingAttachmentSources) ?? []
  const attachmentConsumerId = run.executionMetadata?.attachmentConsumerId
  const nativeAttachments = run.executionMetadata?.nativeAttachments ?? []

  // consume-once handoff **不在此处清**（review [P1]）：若在 SCM/worktree/materialize 之前清掉
  // executionMetadata.attachments，一旦这些步骤失败，rerun 就找不到本轮附件；且清掉后 token 在
  // 「executionMetadata pin」与「attachment_refs pin」之间会有一段无 pin 窗口，TTL sweeper 可能
  // 在 materialize 落盘前把暂存字节删掉。所以推迟到**附件已落盘 + attachment_refs 已登记 + step
  // 已持久化**之后再清（见下方 runSteps insert 后）。
  const message = run.intent

  // 从 run 记录读取 worktree 参数（队列调度场景，参数在入队时已写入 run）。
  //
  // 粘性（sticky）语义：一个 run 的 worktreeConfig 在 insert 时落库，后续
  // 出队/重放（包括 queued→running、retry）都直接复用这份快照——新的请求
  // 要拿不同的 worktree 就要开新 run（新 runId），不会修改已排队 run 的配置。
  // 这避免了队列中的 run 被后来的请求"改道"到另一个 workspace，对并发排队的
  // 语义是必需的。此处不做任何合并/覆盖，保持字段原样透传。
  const worktreeParams: WorktreeCallParams | undefined = run.worktreeConfig
    ? {
        name: run.worktreeConfig.name,
        cleanup: run.worktreeConfig.cleanup,
        ...(run.worktreeConfig.branch ? { branch: run.worktreeConfig.branch } : {}),
      }
    : undefined

  let agentConfig: Awaited<ReturnType<typeof buildAgentConfig>>
  let queuedChatId: string | undefined
  let resolvedWorkDir: string
  let nextOrder: number
  try {
    agentConfig = await buildAgentConfig(agent, {
      runtimeAdminRequesterUserId: run.executionMetadata?.runtimeAdminRequesterUserId,
    })
    queuedChatId = await resolveQueuedChatId(run)

    if (agent.workspaceType === 'scm' && agent.scmSourceId) {
      const source = (
        await db.select().from(scmSources).where(eq(scmSources.id, agent.scmSourceId)).limit(1)
      )[0]
      if (source && source.initialSyncCompletedAt == null) {
        logger.warn({ agentId, runId }, 'SCM source not synced, skipping executeChatRun')
        await failRunBeforeLifecycle(runId, agentId, 'SCM source not synced')
        return
      }
    }

    // runId 传入让 resolveWorkDir 在同步事务内完成占用检查 + workDir 原子写回，
    // cleanupWorktreeIfEphemeral 和并发占用检查都依赖 runs.workDir 非空。
    resolvedWorkDir = await resolveWorkDir(agent, worktreeParams, runId, agentConfig.agentEnv)

    const lastStep = (
      await db
        .select({ maxOrder: sql<number>`MAX(${runSteps.order})` })
        .from(runSteps)
        .where(eq(runSteps.runId, runId))
        .limit(1)
    )[0]
    nextOrder = (lastStep?.maxOrder ?? 0) + 1
  } catch (err) {
    // 调用方全部是 fire-and-forget（scheduleNext callback / routes / run-lifecycle /
    // feishu-service / recoverOnStartup），外层没有 try/catch。任何 rethrow 都会让
    // run 永远停在 'running'、并发槽不释放、scheduleNext 不触发 → 队列死锁。
    // 所以 resolveWorkDir 的**任何**失败（包括 resolveWorkDir 自身的普通 Error：
    // SCM source 不存在 / worktree 名非法 / SCM 类型不支持 / scm.createWorkspace 原始
    // 错误）都必须在这里消化掉。
    const typed =
      err instanceof WorktreeOccupiedError ||
      err instanceof WorktreeBranchLockedError ||
      err instanceof WorktreeDirtyError
    const msg = err instanceof Error ? err.message : String(err)
    if (typed) {
      logger.warn({ agentId, runId, err: msg }, 'Worktree unavailable for queued run, failing')
    } else {
      logger.error({ agentId, runId, err }, 'Queued run preparation failed, failing run')
    }
    await failRunBeforeLifecycle(runId, agentId, msg)
    return
  }

  // 附件落盘 + prompt 注入（与飞书逐字节一致的路径提示）。无附件时 mergedPrompt === message、
  // rootDir === null。原始 refs 存 runSteps.input.attachments 做审计（免迁移）。
  const nativeAttachmentRefs =
    nativeAttachments.length > 0
      ? await resolveNativeChatAttachments(agentId, nativeAttachments).catch((error) => {
          logger.warn({ error, agentId, runId }, 'Native chat attachment resolution failed')
          return []
        })
      : []
  const attachmentSources = [
    ...persistedAttachmentSources,
    ...(refsToSources(nativeAttachmentRefs) ?? []),
  ]
  const effectiveAttachmentConsumerId =
    nativeAttachmentRefs.length > 0 ? `agent:${agentId}` : attachmentConsumerId

  const { mergedPrompt, rootDir, materialized } = await materializeForRun({
    agentId,
    runId,
    message,
    sources: attachmentSources,
    consumerId: effectiveAttachmentConsumerId,
  })
  // 只记**实际落盘**的附件（materialized），不用请求里的 sources——token 过期/被拒时
  // 附件全丢却仍写 chip 会让历史显示 agent 从没收到的文件（预览 404，review [P2]）。
  const attachmentRefs = materialized

  const stepId = createId('rst')
  const stepInput: Record<string, unknown> = effectiveContext
    ? { message: mergedPrompt, context: effectiveContext }
    : { message: mergedPrompt }
  if (attachmentRefs && attachmentRefs.length > 0) {
    stepInput.attachments = attachmentRefs
  }
  // ── lifecycle 之前的 DB 写入（step/message insert + consume-once update）──────────
  // 这些 .run() 可能抛（SQLITE_BUSY / 约束冲突等）。调用方全是 fire-and-forget，外层无
  // try/catch——若在这里抛出且不消化，run 会永远停在 'running'、并发槽不释放、scheduleNext
  // 不触发 → 队列死锁到进程重启（review [P2]）。所以与上方 resolveWorkDir 失败同构：标记
  // Run 失败 + 清理落盘目录 + scheduleNext + return，绝不 rethrow。
  try {
    // 三个写必须**同一事务**原子提交：若 step insert 已提交而后续写抛错（SQLITE_BUSY），
    // 会留下「孤儿 step（无对应 user message，历史配对错位）」或「step 已存在 + stale
    // queuedTurn/attachments（rerun 重放已 materialize 过的附件）」的半提交状态（review）。
    const prepared = await withTransaction(async (tx) => {
      const guard = await tx
        .update(runs)
        .set({ updatedAt: new Date() })
        .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
        .returning({ id: runs.id })
      if (!didChangeOneRow(guard)) return false

      await tx.insert(runSteps).values({
        id: stepId,
        runId,
        agentId,
        order: nextOrder,
        input: stepInput,
        status: 'running',
      })

      await tx.insert(chatMessages).values({
        id: createId('msg'),
        runId,
        role: 'user',
        // 存用户原文（message = run.intent），不存注入了附件路径的 mergedPrompt。
        content: message,
      })

      // consume-once handoff（review [P1]）：此刻附件已落盘、attachment_refs 已由 materializeForRun
      // 登记（pin 已从 executionMetadata 转到反查表）、step.input.attachments 已持久化——现在才安全地
      // 清掉 run 行上的附件字段，避免同 run 若被再次出队时重放旧附件。保留 oauth 会话等其它字段。
      // queuedTurn marker 也在此清除：本轮已 materialize 成 step，rerun 应重新以 step 为准（review [P2]）。
      // 无附件的排队轮同样带了 queuedTurn（仅 marker），因此这里不再以 persistedAttachments 为门槛。
      if (
        (persistedAttachments && persistedAttachments.length > 0) ||
        run.executionMetadata?.queuedTurn ||
        run.executionMetadata?.nativeChatContext ||
        nativeAttachments.length > 0
      ) {
        const {
          attachments: _a,
          attachmentConsumerId: _c,
          queuedTurn: _q,
          nativeChatContext: _n,
          nativeAttachments: _na,
          ...restMeta
        } = run.executionMetadata ?? {}
        await tx
          .update(runs)
          .set({ executionMetadata: Object.keys(restMeta).length > 0 ? restMeta : null })
          .where(eq(runs.id, runId))
      }
      return true
    })
    if (!prepared) {
      logger.info({ runId, agentId }, 'Run was finalized during async preparation')
      await cleanupPreparedExecution(runId, agentId, rootDir)
      return
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(
      { agentId, runId, err },
      'Pre-lifecycle DB write failed, failing run (queue guard)',
    )
    await failRunBeforeLifecycle(runId, agentId, msg, rootDir)
    return
  }

  const taskId = buildTaskId('chat/', runId, stepId)
  const payload: WorkerTaskPayload = {
    taskId,
    prompt: mergedPrompt,
    context: effectiveContext,
    model: (await agentConfig).model || undefined,
    workDir: resolvedWorkDir,
    chatId: queuedChatId,
    agentConfig: await agentConfig,
  }

  const lifecycleParams = {
    taskId,
    runId,
    stepId,
    agentId,
    startTime: Date.now(),
    workDir: resolvedWorkDir,
    userId: run.userId ?? undefined,
  }
  // runWithLifecycle never throws — it owns the entire success/error lifecycle（含 scheduleNext）。
  // 落盘目录清理放它之后的 finally，保证无论成功/失败都清（review [P2]）。
  try {
    await runWithLifecycle(taskId, payload, lifecycleParams)
  } finally {
    if (rootDir) await cleanupMaterializedRoot(rootDir)
  }
}

/**
 * Did the write affect exactly one row?
 *
 * Callers pass the array from `.returning()`. A driver row count cannot be used:
 * better-sqlite3 exposes `changes` and node-postgres `rowCount`, so the returned
 * rows are the only portable signal.
 */
function didChangeOneRow(result: unknown): boolean {
  return Array.isArray(result) && result.length === 1
}

async function cleanupPreparedExecution(
  runId: string,
  agentId: string,
  rootDir?: string | null,
): Promise<void> {
  if (rootDir) await cleanupMaterializedRoot(rootDir).catch(() => {})
  const { cleanupWorktreeIfEphemeral } = await import('./run-lifecycle.js')
  await cleanupWorkspaceOrHandOff(() => cleanupWorktreeIfEphemeral(runId, agentId), {
    context: { type: 'run', runId, agentId, phase: 'pre-execution' },
  })
  completeExecutionLease(runId)
}

export async function failRunBeforeLifecycle(
  runId: string,
  agentId: string,
  error: string,
  rootDir?: string | null,
): Promise<void> {
  let ownsTerminalTransition = false
  await retryUntilSuccess(
    async () => {
      const transition = await db
        .update(runs)
        .set({ status: 'failed', result: { error }, updatedAt: new Date() })
        .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
        .returning({ id: runs.id })
      ownsTerminalTransition = didChangeOneRow(transition)
      if (ownsTerminalTransition) return

      const current = (
        await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1)
      )[0]
      if (!current || current.status !== 'running') return
      throw new Error('Run is still running after the preparation-failure transition')
    },
    {
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      onFailure: (transitionError, retryDelayMs) => {
        logger.error(
          { err: transitionError, runId, agentId, retryDelayMs },
          'Failed to terminalize run preparation; retaining the workload lease and retrying',
        )
      },
    },
  )

  await cleanupPreparedExecution(runId, agentId, rootDir)
  if (ownsTerminalTransition) {
    void scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
  }
}

/**
 * 取出并从 context 剥离内部保留键 __attachments（排队路径的附件 refs）。
 * refs 形如 AttachmentRef[]；转成 token 源供 materializer 使用。
 */
function extractPendingAttachments(
  context: Record<string, unknown> | undefined,
): AttachmentSource[] | undefined {
  if (!context) return undefined
  const raw = context.__attachments
  // The key must actually disappear from the caller's context (it is serialised into the
  // step record downstream); an undefined assignment would leave `__attachments: null`.
  // biome-ignore lint/performance/noDelete: see above — the key must be removed, not nulled
  delete context.__attachments
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  return raw
    .filter((r): r is { token: string; name?: string; mimeType?: string } =>
      Boolean(r && typeof r === 'object' && typeof (r as { token?: unknown }).token === 'string'),
    )
    .map((r) => ({ kind: 'token' as const, token: r.token, name: r.name, mimeType: r.mimeType }))
}

async function resolveQueuedChatId(run: typeof runs.$inferSelect): Promise<string | undefined> {
  if (!run.initiatorAgentId || !run.triggerSessionId) return undefined

  if (run.triggerSource === 'oauth') {
    const metadata = run.executionMetadata as
      | { oauthPreviousChatId?: unknown; oauthResetSession?: unknown }
      | undefined
    if (metadata?.oauthResetSession === true) return undefined
    if (typeof metadata?.oauthPreviousChatId === 'string') return metadata.oauthPreviousChatId
    return (
      (await lookupPreviousOAuthSessionChatId(run.initiatorAgentId, run.triggerSessionId, {
        beforeCreatedAt: run.createdAt,
      })) ?? undefined
    )
  }

  if (run.triggerSource !== 'slack' && run.triggerSource !== 'discord') return undefined
  const previous = (
    await db
      .select({ result: runs.result })
      .from(runs)
      .where(
        and(
          eq(runs.initiatorAgentId, run.initiatorAgentId),
          eq(runs.triggerSource, run.triggerSource),
          eq(runs.triggerSessionId, run.triggerSessionId),
          eq(runs.status, 'completed'),
          lt(runs.createdAt, run.createdAt),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(1)
  )[0]
  const chatId = previous?.result?.chatId
  return typeof chatId === 'string' ? chatId : undefined
}
