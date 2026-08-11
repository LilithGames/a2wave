import { and, desc, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { db } from '../db/client.js'
import { agents, chatMessages, runSteps, runs } from '../db/schema.js'
import { allTaskIdVariants } from '../engine/task-id.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { tryAcquireSlot } from '../engine/task-queue.js'
import { cleanupMaterializedRoot, materializeForRun } from '../lib/attachment-materializer.js'
import { logAudit } from '../lib/audit.js'
import { executeWithRetry } from '../lib/execute-with-retry.js'
import { createId } from '../lib/id.js'
import { logger } from '../lib/logger.js'
import { cancelRunningTasksInBackground, claimRunCancellation } from '../lib/run-cancellation.js'
import { buildGatewayChannel } from '../lib/run-channel.js'
import {
  type IdempotentRun,
  findIdempotentRun,
  isActiveOrCompletedRun,
  isRunIdempotencyConflict,
} from '../lib/run-idempotency.js'
import { finishRunError, finishRunSuccess } from '../lib/run-lifecycle.js'
import { stopLogCollector } from '../lib/run-log-registry.js'
import {
  type GatewayCaller,
  normalizeAuthType,
  oauthUploaderId,
} from '../middleware/gateway-auth.js'
import { extractCallerAgentFromHeaders } from './caller.js'
import type { CancelFn, ExecuteFn } from './executor.js'

type AgentRow = typeof agents.$inferSelect

export function createRecordedA2ACancelFn(c: Context, agent: AgentRow): CancelFn {
  return async (taskId) => {
    const run = await findIdempotentRun(agent.id, 'a2a', taskId)
    if (!run || (run.status !== 'running' && run.status !== 'queued')) {
      return 'not_cancellable'
    }

    if (run.status === 'running') {
      await stopLogCollector(run.id)
    }

    const currentStatus =
      (await db.select({ status: runs.status }).from(runs).where(eq(runs.id, run.id)).limit(1))[0]
        ?.status ?? run.status
    if (currentStatus !== 'running' && currentStatus !== 'queued') {
      return 'not_cancellable'
    }
    if (!claimRunCancellation(run.id, currentStatus)) {
      return 'not_cancellable'
    }

    if (currentStatus === 'running') {
      const [latestStep] = await db
        .select()
        .from(runSteps)
        .where(eq(runSteps.runId, run.id))
        .orderBy(desc(runSteps.order))
        .limit(1)
      const taskIds = [
        ...new Set([taskId, ...(latestStep ? allTaskIdVariants(run.id, latestStep.id) : [])]),
      ]
      if (latestStep) {
        await db
          .update(runSteps)
          .set({ status: 'cancelled' })
          .where(and(eq(runSteps.id, latestStep.id), eq(runSteps.status, 'running')))
      }
      cancelRunningTasksInBackground({
        runId: run.id,
        agentId: agent.id,
        taskIds,
      })
    }

    logAudit(c, {
      action: 'run.cancel',
      resource: 'run',
      resourceId: run.id,
      userId: agent.userId ?? undefined,
      details: { triggerSource: 'a2a', a2aTaskId: taskId },
    })
    logger.info({ taskId, runId: run.id, agentId: agent.id }, 'A2A task cancelled')
    return 'cancelled'
  }
}

function buildA2AIdempotentResult(taskId: string, existing: IdempotentRun) {
  if (existing.status === 'completed') {
    const cached = (existing.result as { output?: string } | null) ?? null
    logger.debug(
      { taskId, runId: existing.id },
      'A2A idempotent hit: returning cached completed run',
    )
    return { success: true, output: cached?.output ?? '', durationMs: 0 }
  }

  if (
    existing.status === 'running' ||
    existing.status === 'pending' ||
    existing.status === 'queued'
  ) {
    logger.debug(
      { taskId, runId: existing.id, status: existing.status },
      'A2A idempotent hit: task already in progress',
    )
    return {
      success: false,
      inProgress: true,
      output: '',
      error: 'Task already in progress for this taskId',
      durationMs: 0,
    }
  }

  return undefined
}

export async function createRecordedA2AExecuteFn(c: Context, agent: AgentRow): Promise<ExecuteFn> {
  const oauthCaller =
    typeof c.get === 'function'
      ? ((c.get as (k: string) => unknown)('oauthCaller') as GatewayCaller | undefined)
      : undefined
  const rawCallerAgent = extractCallerAgentFromHeaders(c)

  // Tighten trust on X-A2WAVE-Caller-Agent-Id header. Two checks:
  //   1. The claimed agent_id must exist in the local registry.
  //   2. The claimed agent must share the same owner (userId) as the target —
  //      otherwise a party holding *any* agent's api_key could claim to be an
  //      unrelated agent in another owner's workspace, contaminating that
  //      owner's audit log.
  // This is *audit-traceability*, not a security boundary — a party in
  // possession of the target's api_key can still claim any agent in the same
  // owner workspace. A full fix requires threading the caller's own
  // authenticated agent_id through the middleware (not possible with the
  // target-api_key auth model today) and is out of scope for MR !84.
  let callerAgent: { agentId?: string; agentName?: string } | undefined = rawCallerAgent
  if (rawCallerAgent?.agentId) {
    const known = (
      await db
        .select({ id: agents.id, userId: agents.userId })
        .from(agents)
        .where(eq(agents.id, rawCallerAgent.agentId))
        .limit(1)
    )[0]
    if (!known) {
      logger.warn(
        { claimedAgentId: rawCallerAgent.agentId, targetAgentId: agent.id },
        'A2A hop: X-A2WAVE-Caller-Agent-Id not found in registry; ignoring header',
      )
      callerAgent = undefined
    } else if (agent.userId && known.userId && known.userId !== agent.userId) {
      logger.warn(
        {
          claimedAgentId: rawCallerAgent.agentId,
          claimedOwnerId: known.userId,
          targetAgentId: agent.id,
          targetOwnerId: agent.userId,
        },
        'A2A hop: caller_agent belongs to a different owner; ignoring header',
      )
      callerAgent = undefined
    }
  }

  const baseChannelOpts = {
    channel: 'a2a',
    // A2A 入站走独立鉴权方式（与 REST 渠道解耦）；a2aAuthType 列 notNull，迁移已 backfill。
    authType: normalizeAuthType(agent.a2aAuthType),
    trustForwardedIdentity: Boolean(agent.trustForwardedIdentity),
    oauthCaller,
    ...(callerAgent ? { callerAgent } : {}),
  } as const
  const baseChannelResult = buildGatewayChannel(c, baseChannelOpts)

  return async (taskId, payload, options) => {
    const provenance = options?.provenance
    const channelResult = provenance
      ? buildGatewayChannel(c, {
          ...baseChannelOpts,
          ...(!oauthCaller && provenance.userName
            ? { assertedDisplayName: provenance.userName }
            : {}),
          ...(provenance.callerAgent
            ? {
                assertedCallerAgent: {
                  ...(provenance.callerAgent.id ? { agentId: provenance.callerAgent.id } : {}),
                  ...(provenance.callerAgent.name
                    ? { agentName: provenance.callerAgent.name }
                    : {}),
                },
              }
            : {}),
        })
      : baseChannelResult
    const channel = channelResult.ctx
    const triggerAgentName =
      channel.channel_type === 'a2a'
        ? (channel.channel_info.caller_agent?.agent_name ?? null)
        : null
    // --- Idempotency: same A2A taskId → reuse prior run ---
    // Prevents duplicate execution on client retries or on transport-level
    // re-delivery. Uses runs.triggerSessionId (indexed) as the A2A task-id key.
    const existing = await findIdempotentRun(agent.id, 'a2a', taskId)
    const idempotentResult = existing ? buildA2AIdempotentResult(taskId, existing) : undefined
    if (idempotentResult) return idempotentResult
    if (existing && !isActiveOrCompletedRun(existing.status)) {
      // failed / cancelled → allow a fresh retry (caller decided to re-send)
    }

    const runId = createId('run')
    const stepId = createId('rst')

    // 先插 run（intent 用原始文本）+ 抢槽；附件落盘放到抢到槽之后，避免为被拒/幂等
    // 冲突的请求白做 I/O 与外呼，也避免冲突分支泄漏已落盘的目录。
    try {
      await db.insert(runs).values({
        id: runId,
        intent: payload.prompt,
        initiatorAgentId: agent.id,
        status: 'pending',
        triggerSource: 'a2a',
        triggerSessionId: taskId,
        triggerUserName: channelResult.displayName,
        triggerAgentName,
        // The workspace was resolved before this run existed (handleA2ARequest
        // pre-flight), so record it at insert time — the workspace-delete
        // occupancy check reads runs.workDir to spot in-flight runs.
        ...(payload.workDir ? { workDir: payload.workDir } : {}),
        ...(agent.userId ? { userId: agent.userId } : {}),
      })
    } catch (err) {
      if (isRunIdempotencyConflict(err)) {
        const conflictingRun = await findIdempotentRun(agent.id, 'a2a', taskId)
        const conflictingResult = conflictingRun
          ? buildA2AIdempotentResult(taskId, conflictingRun)
          : undefined
        if (conflictingResult) return conflictingResult
      }
      throw err
    }

    const slotResult = await tryAcquireSlot(taskQueueDb, agent.id, runId, agent.maxConcurrency ?? 1)

    if (slotResult === 'queue_full') {
      await db.delete(runs).where(eq(runs.id, runId))
      return {
        success: false,
        output: '',
        error: 'Agent queue is full',
        durationMs: 0,
      }
    }

    if (slotResult === 'queued') {
      await db.delete(runs).where(eq(runs.id, runId))
      return {
        success: false,
        output: '',
        error: 'Agent is busy, request queued but A2A does not support waiting',
        durationMs: 0,
      }
    }

    const startTime = Date.now()
    const lifecycleParams = {
      taskId,
      runId,
      stepId,
      agentId: agent.id,
      startTime,
      retries: [] as Array<{ attempt: number; error?: string; durationMs?: number }>,
      workDir: payload.workDir,
      userId: agent.userId ?? undefined,
    }
    let attachmentRootDir: string | null = null

    // The execution lease is already reserved. Keep every asynchronous
    // preparation step inside the lifecycle boundary so any failure converges
    // the Run to a terminal state and releases the slot.
    try {
      const materializedResult = await materializeForRun({
        agentId: agent.id,
        runId,
        message: payload.prompt,
        sources: payload.attachments,
        // The consumer must match the uploader identity. OAuth-authenticated
        // A2A callers upload as oauth:<iss>:<sub>; API-key callers upload as
        // agent:<id>.
        consumerId: oauthCaller ? oauthUploaderId(oauthCaller) : `agent:${agent.id}`,
      })
      attachmentRootDir = materializedResult.rootDir

      const stepInput: Record<string, unknown> = {
        message: materializedResult.mergedPrompt,
        context: { channel },
      }
      if (materializedResult.materialized.length > 0) {
        stepInput.attachments = materializedResult.materialized
      }

      const enrichedPayload = {
        ...payload,
        prompt: materializedResult.mergedPrompt,
        context: { ...(payload.context ?? {}), channel },
      }

      await db.insert(runSteps).values({
        id: stepId,
        runId,
        agentId: agent.id,
        order: 1,
        input: stepInput,
        status: 'running',
      })

      await db.insert(chatMessages).values({
        id: createId('msg'),
        runId,
        role: 'user',
        // 存用户原文（payload.prompt，合并前），不存注入了附件路径的 mergedPrompt。
        content: payload.prompt,
      })

      const { provenance: _provenance, ...executeOptions } = options ?? {}
      const { result, retries, logs } = await executeWithRetry(taskId, enrichedPayload, {
        ...executeOptions,
        runId,
      })

      if (result.success) {
        await finishRunSuccess({ ...lifecycleParams, logs, retries }, result)
      } else {
        await finishRunError(
          { ...lifecycleParams, logs, retries },
          new Error(result.error ?? 'Execution failed'),
          result.usage,
        )
      }

      if (retries.length > 0) {
        logger.info({ taskId, runId, retries }, 'A2A execution completed with retries')
      }

      return result
    } catch (error) {
      const errorMsg = await finishRunError(lifecycleParams, error)
      return {
        success: false,
        output: '',
        error: errorMsg,
        durationMs: Date.now() - startTime,
      }
    } finally {
      if (attachmentRootDir) await cleanupMaterializedRoot(attachmentRootDir)
    }
  }
}
