import { join } from 'node:path'
import {
  type RunChannelContextDiscord,
  type RunChannelContextSlack,
  artifactPolicySchema,
} from '@a2wave/shared'
/**
 * Run lifecycle helpers — centralize the repeated pattern of:
 *   execute → update runStep → update run → save agent message → scheduleNext
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, chatMessages, runSteps, runs, scmSources } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { extractUsageFromError } from '../engine/cli-engine-base.js'
import { completeExecutionLease } from '../engine/execution-lease-registry.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { scheduleNext } from '../engine/task-queue.js'
import type { StreamLogEntry, TokenUsage } from '../engine/types.js'
import type { ExecuteWorkerResult } from '../worker/types.js'
import { buildArtifactLinkLines } from './artifact-links.js'
import { type RegisteredArtifact, scanAndRegisterArtifacts } from './artifact-storage.js'
import { executeChatRun } from './execute-chat-run.js'
import { buildFeishuFallbackText } from './feishu-fallback.js'
import { isPerAgentWorkspaceName } from './git-workspace.js'
import { createId } from './id.js'
import { jsonPathIsAbsent, jsonSet } from './json-sql.js'
import { logger } from './logger.js'
import { appendNativeArtifactDownloadSection } from './native-chat-text.js'
import { createScmSource } from './scm-source.js'
import { notifyRunError } from './webhook-notifier.js'
import { generateWorkLog } from './worklog-generator.js'

/** Max serialized size (chars) for a single tool_call input when persisted */
const MAX_INPUT_JSON_LENGTH = 2000

/** Max number of stream log entries to collect per execution */
export const MAX_STREAM_LOGS = 1000

/**
 * Create a log collector callback that caps at MAX_STREAM_LOGS.
 * When the cap is reached, appends a truncation marker entry.
 */
export function createLogCollector(): {
  logs: StreamLogEntry[]
  onLogEntry: (entry: StreamLogEntry) => void
} {
  const logs: StreamLogEntry[] = []
  let truncated = false
  const onLogEntry = (entry: StreamLogEntry) => {
    if (logs.length < MAX_STREAM_LOGS) {
      logs.push(entry)
    } else if (!truncated) {
      truncated = true
      logs.push({ type: 'system', subtype: 'truncated', ts: Date.now() })
    }
  }
  return { logs, onLogEntry }
}

/** Sanitize stream logs for persistence: truncate large tool_call inputs */
export function sanitizeLogsForStorage(logs: StreamLogEntry[]): StreamLogEntry[] {
  return logs.map((entry) => {
    if (entry.type !== 'tool_call' || !entry.input) return entry
    const serialized = JSON.stringify(entry.input)
    if (serialized.length <= MAX_INPUT_JSON_LENGTH) return entry
    return { ...entry, input: { _truncated: true, _length: serialized.length } }
  })
}

/**
 * Persisting log collector — buffers entries in memory AND flushes to
 * `runSteps.output.logs` on a debounced interval so the web UI sees
 * incremental progress while a long-running step is still executing.
 *
 * Contract:
 * - `onLogEntry` appends and (re)arms the debounce timer.
 * - `stop()` cancels the pending timer, awaits any in-flight flush, and
 *   sets a terminal flag so post-stop `onLogEntry` calls are no-ops.
 * - Flushes are guarded with `ne(runSteps.status, 'cancelled')` so a late
 *   flush can never resurrect a cancelled step.
 * - Callers MUST `await stop()` before invoking `finishRunSuccess` /
 *   `finishRunError`; otherwise a debounce tick after the final write can
 *   clobber the authoritative `status` / `durationMs` values.
 */
export interface PersistingLogCollector {
  logs: StreamLogEntry[]
  onLogEntry: (entry: StreamLogEntry) => void
  stop: () => Promise<void>
}

export interface PersistingLogCollectorOptions {
  stepId: string
  /** Base output keys that should be preserved in each flush (e.g. input snapshot). Defaults to {}. */
  baseOutput?: Record<string, unknown>
  /** Debounce window for DB writes (ms). Defaults to 1500. */
  debounceMs?: number
}

export function createPersistingLogCollector(
  opts: PersistingLogCollectorOptions,
): PersistingLogCollector {
  const { stepId, baseOutput = {}, debounceMs = 1500 } = opts
  const logs: StreamLogEntry[] = []
  let truncated = false
  let timer: NodeJS.Timeout | null = null
  let inFlight: Promise<void> | null = null
  let stopped = false

  const writeNow = async (): Promise<void> => {
    try {
      await db
        .update(runSteps)
        .set({ output: { ...baseOutput, logs: sanitizeLogsForStorage(logs) } })
        .where(and(eq(runSteps.id, stepId), ne(runSteps.status, 'cancelled')))
    } catch (err) {
      logger.warn({ err, stepId }, 'Persisting log flush failed')
    }
  }

  const scheduleFlush = () => {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      inFlight = Promise.resolve().then(writeNow)
    }, debounceMs)
  }

  const onLogEntry = (entry: StreamLogEntry) => {
    if (stopped) return
    if (logs.length < MAX_STREAM_LOGS) {
      logs.push(entry)
    } else if (!truncated) {
      truncated = true
      logs.push({ type: 'system', subtype: 'truncated', ts: Date.now() })
    } else {
      return
    }
    scheduleFlush()
  }

  const stop = async (): Promise<void> => {
    if (stopped) {
      if (inFlight) await inFlight
      return
    }
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (inFlight) await inFlight
    // Final flush guarantees the latest buffer is persisted before the
    // downstream `finishRunSuccess` / `finishRunError` overwrites `output`.
    // Awaited: the write is async, so firing it bare lets the overwrite land
    // first and silently drop the tail of the log buffer.
    await writeNow()
  }

  return { logs, onLogEntry, stop }
}

export interface RetryRecord {
  attempt: number
  error?: string
  durationMs?: number
}

export interface FinishRunParams {
  taskId: string
  runId: string
  stepId: string
  agentId: string
  startTime: number
  logs?: StreamLogEntry[]
  retries?: RetryRecord[]
  workDir?: string
  userId?: string
}

/**
 * Did this call win the terminal-state transition?
 *
 * Callers pass the array from `.returning()`; see didChangeOneRow in
 * execute-chat-run.ts for why a driver row count is not portable.
 */
function didTransition(result: unknown): boolean {
  return Array.isArray(result) && result.length === 1
}

type TerminalTransitionOutcome = 'owned' | 'lost' | 'recovered'

async function attemptTerminalTransition(
  params: Pick<FinishRunParams, 'taskId' | 'runId' | 'stepId'>,
  recoveryError: string,
  // May be async: the transition is a DB write, which is a Promise on PostgreSQL.
  transition: () => boolean | Promise<boolean>,
): Promise<TerminalTransitionOutcome> {
  try {
    return (await transition()) ? 'owned' : 'lost'
  } catch (error) {
    const { taskId, runId, stepId } = params
    logger.error(
      { err: error, taskId, runId, stepId },
      'Atomic run terminal transition failed; attempting run-level recovery',
    )
    try {
      const recovery = await db
        .update(runs)
        .set({ status: 'failed', result: { error: recoveryError }, updatedAt: new Date() })
        .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
        .returning({ id: runs.id })
      if (didTransition(recovery)) return 'recovered'
    } catch (recoveryFailure) {
      logger.error(
        { err: recoveryFailure, taskId, runId, stepId },
        'Run-level terminal recovery failed',
      )
    }
    return 'lost'
  }
}

async function getRunStatus(runId: string): Promise<string | undefined> {
  return (await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1))[0]
    ?.status
}

async function cancelLateStep(stepId: string): Promise<void> {
  await db
    .update(runSteps)
    .set({ status: 'cancelled' })
    .where(and(eq(runSteps.id, stepId), eq(runSteps.status, 'running')))
}

async function cleanupFinishedExecution(
  runId: string,
  agentId: string,
  shouldScheduleNext: boolean,
): Promise<void> {
  await cleanupWorktreeIfEphemeral(runId, agentId).catch((err) =>
    logger.warn({ err, runId }, 'Worktree ephemeral cleanup failed'),
  )
  completeExecutionLease(runId)
  if (shouldScheduleNext) {
    void scheduleNext(taskQueueDb, agentId, (rid, aid) => void executeChatRun(aid, rid))
  }
}

/**
 * Read the persisted step input's `context` field, used by the reply-by-context
 * Feishu send paths (API trigger / rerun).
 */
async function loadStepContext(stepId: string): Promise<Record<string, unknown> | undefined> {
  const stepRow = (
    await db
      .select({ input: runSteps.input })
      .from(runSteps)
      .where(eq(runSteps.id, stepId))
      .limit(1)
  )[0]
  return (stepRow?.input as Record<string, unknown> | undefined)?.context as
    | Record<string, unknown>
    | undefined
}

/**
 * Check the agent's p2p reply mode. Returns true when an admin has explicitly
 * disabled DM replies via `feishuConfig.p2pReplyMode === 'none'`. Used to gate
 * the empty/failure FALLBACK reply-by-context send so admins can fully silence
 * the bot. Successful, non-empty replies still go through — the API caller
 * explicitly asked for a reply by providing receive_id.
 */
async function isP2pReplyDisabled(agentId: string): Promise<boolean> {
  const agent = (
    await db
      .select({ feishuConfig: agents.feishuConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
  )[0]
  const config = agent?.feishuConfig as { p2pReplyMode?: string } | null | undefined
  return config?.p2pReplyMode === 'none'
}

/**
 * Send a Feishu reply via the API/rerun reply-by-context path. Shared by
 * finishRunSuccess (success-or-empty) AND finishRunError (real engine failure),
 * so the "never stay silent" guarantee covers both branches — the original
 * commit only wired this into the success branch, leaving the failure branch
 * silent. Pass `output=undefined` to force the fallback text.
 *
 * Dynamic-imports feishu-service to avoid a static cycle. Fires-and-forgets
 * (errors logged, never thrown).
 */
async function sendFeishuReplyByContext(
  agentId: string,
  runId: string,
  context: Record<string, unknown> | undefined,
  output: string | undefined,
): Promise<void> {
  if (!context?.receive_id_type || !context?.receive_id) return
  const trimmedOutput = output?.trim() ? output : null
  const hasOutput = trimmedOutput !== null
  // Respect admin's p2pReplyMode='none' for the fallback case only; matches the
  // WS executeJob branch which also gates `if (replyMode !== 'none')` on the
  // empty/failed path.
  if (!hasOutput && (await isP2pReplyDisabled(agentId))) {
    logger.info({ runId, agentId }, 'Feishu DM fallback suppressed by p2pReplyMode=none')
    return
  }
  const replyText = trimmedOutput ?? buildFeishuFallbackText(runId)
  import('./feishu-service.js')
    .then(({ sendFeishuMessageByContext }) =>
      sendFeishuMessageByContext(agentId, context, replyText),
    )
    .catch((err) => logger.warn({ err, runId, agentId }, 'Feishu reply by context failed'))
}

function buildNativeChatFallbackText(runId: string): string {
  return `⚠️ The Agent did not return usable content. Please try again or inspect the run in a2wave (run_id=${runId}).`
}

function sendNativeChatReplyByContext(
  agentId: string,
  runId: string,
  context: Record<string, unknown> | undefined,
  output: string | undefined,
  artifacts: RegisteredArtifact[] = [],
): void {
  const channel = context?.channel as RunChannelContextSlack | RunChannelContextDiscord | undefined
  if (channel?.channel_type !== 'slack' && channel?.channel_type !== 'discord') return
  const replyText = output?.trim() ? output : buildNativeChatFallbackText(runId)
  const send =
    channel.channel_type === 'slack'
      ? import('./slack-service.js').then(({ slackConnectionManager }) =>
          slackConnectionManager.sendRunResultByContext(agentId, channel, replyText, artifacts),
        )
      : import('./discord-service.js').then(({ discordConnectionManager }) =>
          discordConnectionManager.sendRunResultByContext(agentId, channel, replyText, artifacts),
        )
  void send.catch((err) =>
    logger.warn(
      { err, runId, agentId, channel: channel.channel_type },
      'Native chat reply by context failed',
    ),
  )
}

function buildRunUsageSet(usage: TokenUsage): Record<string, unknown> {
  return {
    ...(typeof usage.inputTokens === 'number'
      ? { inputTokens: sql`COALESCE(${runs.inputTokens}, 0) + ${usage.inputTokens}` }
      : {}),
    ...(typeof usage.outputTokens === 'number'
      ? { outputTokens: sql`COALESCE(${runs.outputTokens}, 0) + ${usage.outputTokens}` }
      : {}),
    ...(typeof usage.reasoningTokens === 'number'
      ? {
          reasoningTokens: sql`COALESCE(${runs.reasoningTokens}, 0) + ${usage.reasoningTokens}`,
        }
      : {}),
    ...(typeof usage.cacheReadTokens === 'number'
      ? { cacheReadTokens: sql`COALESCE(${runs.cacheReadTokens}, 0) + ${usage.cacheReadTokens}` }
      : {}),
    ...(typeof usage.cacheWriteTokens === 'number'
      ? {
          cacheWriteTokens: sql`COALESCE(${runs.cacheWriteTokens}, 0) + ${usage.cacheWriteTokens}`,
        }
      : {}),
  }
}

/**
 * Persist one settled execution's usage exactly once.
 *
 * The step JSON path is the idempotency guard. The run aggregate is incremented
 * only in the same transaction that first claims that path, so duplicate or
 * late callbacks cannot make run and step totals diverge.
 */
async function recordUsageOnce(
  runId: string,
  stepId: string,
  usage: TokenUsage | undefined,
): Promise<boolean> {
  if (!usage) return false
  const runUsageSet = buildRunUsageSet(usage)
  if (Object.keys(runUsageSet).length === 0) return false

  return await withTransaction(async (tx) => {
    const stepClaim = await tx
      .update(runSteps)
      .set({
        output: jsonSet(runSteps.output, ['usage'], usage),
      })
      .where(and(eq(runSteps.id, stepId), jsonPathIsAbsent(runSteps.output, ['usage'])))
      .returning({ id: runSteps.id })
    if (!didTransition(stepClaim)) return false

    const runUpdate = await tx
      .update(runs)
      .set(runUsageSet)
      .where(eq(runs.id, runId))
      .returning({ id: runs.id })
    if (!didTransition(runUpdate)) {
      throw new Error(`Run "${runId}" disappeared while recording usage for step "${stepId}"`)
    }
    return true
  })
}

async function tryRecordUsageOnce(
  runId: string,
  stepId: string,
  usage: TokenUsage | undefined,
): Promise<boolean> {
  try {
    return await recordUsageOnce(runId, stepId, usage)
  } catch (error) {
    logger.error({ err: error, runId, stepId }, 'Run usage persistence failed')
    return false
  }
}

/**
 * Finalize a successful or failed run execution.
 * Updates runSteps, runs, inserts agent message on success, and schedules next queued run.
 * Returns registered artifacts (empty array if none or scan skipped).
 */
export async function finishRunSuccess(
  params: FinishRunParams,
  result: ExecuteWorkerResult,
): Promise<RegisteredArtifact[]> {
  const { taskId, runId, stepId, agentId, startTime, logs, retries, workDir, userId } = params
  const durationMs = Date.now() - startTime

  const stepOutput: Record<string, unknown> = {
    result: result.output,
    chatId: result.chatId,
  }
  if (!result.success && result.error) {
    stepOutput.error = result.error
  }
  if (logs && logs.length > 0) {
    stepOutput.logs = sanitizeLogsForStorage(logs)
  }
  if (retries && retries.length > 0) {
    stepOutput.retries = retries
  }

  const finalStatus = result.success ? 'completed' : 'failed'
  const transitionOutcome = attemptTerminalTransition(
    params,
    `Run step "${stepId}" lost terminal-state ownership`,
    async () =>
      await withTransaction(async (tx) => {
        const runTransition = await tx
          .update(runs)
          .set({
            status: finalStatus,
            result: result.success
              ? { output: result.output, chatId: result.chatId, durationMs }
              : { error: result.error ?? 'Execution failed' },
            updatedAt: new Date(),
          })
          .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
          .returning({ id: runs.id })
        if (!didTransition(runTransition)) return false

        const stepTransition = await tx
          .update(runSteps)
          .set({ output: stepOutput, status: finalStatus, durationMs })
          .where(and(eq(runSteps.id, stepId), eq(runSteps.status, 'running')))
          .returning({ id: runSteps.id })
        if (!didTransition(stepTransition)) {
          throw new Error(`Run step "${stepId}" lost terminal-state ownership`)
        }
        return true
      }),
  )

  // A terminal owner records usage after persisting the authoritative step
  // output. Lost transitions are handled by their current-state branch below.
  if ((await transitionOutcome) !== 'lost') {
    await tryRecordUsageOnce(runId, stepId, result.usage)
  }

  if ((await transitionOutcome) === 'recovered') {
    logger.warn(
      { taskId, runId, stepId },
      'Run terminal transition recovered as failed; skipping success side effects',
    )
    await cleanupFinishedExecution(runId, agentId, true)
    return []
  }

  if ((await transitionOutcome) === 'lost') {
    // Awaited here rather than at each use: an unresolved Promise reaching the
    // logger below serialises as {}, blanking the one field this warning exists
    // to report. Mirrors finishRunFailure, which already awaits it.
    const currentStatus = await getRunStatus(runId)
    logger.warn(
      { taskId, runId, stepId, currentStatus },
      'finishRunSuccess lost terminal-state ownership; skipping success side effects',
    )
    if ((await currentStatus) === 'cancelled') {
      await tryRecordUsageOnce(runId, stepId, result.usage)
      try {
        await cancelLateStep(stepId)
      } finally {
        await cleanupFinishedExecution(runId, agentId, false)
      }
    } else if ((await currentStatus) === undefined) {
      // No terminal owner remains to finish cleanup for a deleted Run.
      completeExecutionLease(runId)
    } else if ((await currentStatus) === 'running') {
      // Recovery could not persist a terminal state. Release the in-memory
      // lease so cancellation is not left waiting forever; the running DB row
      // still prevents over-admission until recovery or cancellation repairs it.
      await cleanupFinishedExecution(runId, agentId, true)
    }
    return []
  }

  logger.info(
    { taskId, runId, stepId, success: result.success, durationMs, chatId: result.chatId },
    'Run execution completed',
  )

  const msgId = createId('msg')

  // Hoisted so the post-artifact-scan update (below) appends the download links
  // to the SAME base content we persisted on insert — for empty-output Feishu
  // runs that base is the run_id fallback, not the empty string.
  let persistedContent = result.output
  let successContext: Record<string, unknown> | undefined

  let registered: RegisteredArtifact[] = []
  try {
    if (result.success) {
      // Load the step context once and reuse it for both the persist decision and
      // the reply-by-context send (avoids a duplicate runSteps SELECT).
      const context = await loadStepContext(stepId)
      successContext = context
      const hasOutput = !!result.output?.trim()
      // When output is empty, persist the fallback (with run_id) ONLY for runs the
      // user actually saw it on — Feishu runs (WS bot, or API/rerun reply-by-context).
      // For non-Feishu runs (web / CLI / gateway API) keep the original output so we
      // don't inject a Feishu-flavored fallback into unrelated chat history.
      const channelType = (context?.channel as { channel_type?: string } | undefined)?.channel_type
      const isChatChannel =
        channelType === 'feishu' ||
        channelType === 'slack' ||
        channelType === 'discord' ||
        (!!context?.receive_id_type && !!context?.receive_id)
      const fallbackContent =
        channelType === 'slack' || channelType === 'discord'
          ? buildNativeChatFallbackText(runId)
          : buildFeishuFallbackText(runId)
      persistedContent = hasOutput || !isChatChannel ? result.output : fallbackContent
      await db.insert(chatMessages).values({
        id: msgId,
        runId,
        role: 'agent',
        content: persistedContent,
      })

      // API-triggered Feishu DM reply. Deliberately not awaited — the reply must
      // not hold up run settlement — but the rejection MUST be caught: the
      // function awaits a DB read before its own internal catch takes over, and
      // there is no process-level unhandledRejection handler, so a connection
      // blip here would otherwise take the API down.
      void sendFeishuReplyByContext(agentId, runId, context, result.output).catch((err) => {
        logger.warn({ err, runId, agentId }, 'Feishu reply failed')
      })
    }

    // Artifact scanning must finish before ephemeral worktree cleanup.
    if (result.success && workDir) {
      const agentRow = (
        await db
          .select({ artifactPolicy: agents.artifactPolicy })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1)
      )[0]
      const rawPolicy = agentRow?.artifactPolicy
      const artifactPolicy = rawPolicy ? artifactPolicySchema.parse(rawPolicy) : null
      registered = await scanAndRegisterArtifacts(runId, agentId, userId ?? null, workDir, {
        registeredAfterMs: startTime,
      }).catch((err) => {
        logger.warn({ err }, 'Artifact registration failed')
        return [] as RegisteredArtifact[]
      })
      if (registered.length > 0) {
        const links = await buildArtifactLinkLines(registered, userId ?? null, artifactPolicy)
        const channelType = (successContext?.channel as { channel_type?: string } | undefined)
          ?.channel_type
        if (!result.output?.trim() && (channelType === 'slack' || channelType === 'discord')) {
          persistedContent = ''
        }
        persistedContent = appendNativeArtifactDownloadSection(persistedContent, links)
        await db
          .update(chatMessages)
          .set({ content: persistedContent })
          .where(eq(chatMessages.id, msgId))
      }
    }
    if (result.success) {
      sendNativeChatReplyByContext(agentId, runId, successContext, persistedContent, registered)
    }
  } catch (err) {
    logger.error({ err, runId, stepId }, 'Post-success side effect failed')
  } finally {
    await cleanupFinishedExecution(runId, agentId, true)
  }

  // Async worklog + insight generation — fire-and-forget, does not affect caller
  generateWorkLog(agentId, runId, result.success, stepId).catch((err) =>
    logger.warn({ err, runId, agentId }, 'Work log generation failed'),
  )

  return registered
}

interface FinishRunFailureOptions {
  notifyWebhook: boolean
  generateWorklog: boolean
}

async function finishRunFailure(
  params: FinishRunParams,
  errorMsg: string,
  options: FinishRunFailureOptions,
  usage?: TokenUsage,
): Promise<void> {
  const { taskId, runId, stepId, agentId, startTime, logs, retries } = params
  const durationMs = Date.now() - startTime

  const stepOutput: Record<string, unknown> = { error: errorMsg }
  if (logs && logs.length > 0) {
    stepOutput.logs = sanitizeLogsForStorage(logs)
  }
  if (retries && retries.length > 0) {
    stepOutput.retries = retries
  }

  const transitionOutcome = await attemptTerminalTransition(
    params,
    errorMsg,
    async () =>
      await withTransaction(async (tx) => {
        const runTransition = await tx
          .update(runs)
          .set({ status: 'failed', result: { error: errorMsg }, updatedAt: new Date() })
          .where(and(eq(runs.id, runId), eq(runs.status, 'running')))
          .returning({ id: runs.id })
        if (!didTransition(runTransition)) return false

        const stepTransition = await tx
          .update(runSteps)
          .set({ status: 'failed', durationMs, output: stepOutput })
          .where(and(eq(runSteps.id, stepId), eq(runSteps.status, 'running')))
          .returning({ id: runSteps.id })
        if (!didTransition(stepTransition)) {
          throw new Error(`Run step "${stepId}" lost terminal-state ownership`)
        }
        return true
      }),
  )
  if (transitionOutcome === 'lost') {
    const currentStatus = await getRunStatus(runId)
    logger.warn(
      { taskId, runId, stepId, currentStatus, err: errorMsg },
      'finishRunFailure called on already-finalized run; skipping re-finalization',
    )
    if (currentStatus === 'cancelled') {
      // A cancelled run still records settled usage. Other terminal states have
      // already passed through a usage-recording path, so skip them to avoid duplicates.
      await tryRecordUsageOnce(runId, stepId, usage)
      try {
        await cancelLateStep(stepId)
      } finally {
        await cleanupFinishedExecution(runId, agentId, false)
      }
    } else if ((await currentStatus) === undefined) {
      // No terminal owner remains to finish cleanup for a deleted Run.
      completeExecutionLease(runId)
    } else if (currentStatus === 'running') {
      await cleanupFinishedExecution(runId, agentId, true)
    }
    return
  }

  await tryRecordUsageOnce(runId, stepId, usage)

  try {
    if (options.notifyWebhook) {
      // API/rerun trigger 携带 receive_id 的失败 run: 也送一份 run_id 兜底给飞书,
      // 否则用户在 DM 里完全收不到回应("failed" 分支原本是哑的)。chatMessages 同步
      // 记一份, 让 Web UI chat history 与飞书一致。仅在真正失败(notifyWebhook)时发,
      // 预执行 abort(finishRunAborted, notifyWebhook=false) 不发。
      const failureContext = await loadStepContext(stepId)
      const failureChannelType = (failureContext?.channel as { channel_type?: string } | undefined)
        ?.channel_type
      const isNativeChatFailure = failureChannelType === 'slack' || failureChannelType === 'discord'
      if ((failureContext?.receive_id_type && failureContext?.receive_id) || isNativeChatFailure) {
        const fallbackText = isNativeChatFailure
          ? buildNativeChatFallbackText(runId)
          : buildFeishuFallbackText(runId)
        await db.insert(chatMessages).values({
          id: createId('msg'),
          runId,
          role: 'agent',
          content: fallbackText,
        })
        if (isNativeChatFailure) {
          sendNativeChatReplyByContext(agentId, runId, failureContext, undefined)
        } else {
          void sendFeishuReplyByContext(agentId, runId, failureContext, undefined).catch((err) => {
            logger.warn({ err, runId, agentId }, 'Feishu failure reply failed')
          })
        }
      }

      const agentName =
        (
          await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1)
        )[0]?.name ?? agentId

      notifyRunError({ agentId, agentName, runId, errorMsg, errorTime: new Date() }).catch((err) =>
        logger.warn({ err }, 'Webhook notification failed'),
      )
    }

    if (options.generateWorklog) {
      // Async worklog generation even on error — fire-and-forget
      generateWorkLog(agentId, runId, false, stepId).catch((err) =>
        logger.warn({ err, runId, agentId }, 'Work log generation failed'),
      )
    }
  } catch (err) {
    logger.error({ err, runId, stepId }, 'Post-failure side effect failed')
  } finally {
    await cleanupFinishedExecution(runId, agentId, true)
  }
}

/**
 * Finalize a run aborted before engine execution.
 * Shares failed terminal writes with finishRunError, but does not send error webhooks.
 */
export async function finishRunAborted(params: FinishRunParams, reason: string): Promise<void> {
  const { taskId, runId, stepId, startTime } = params
  const durationMs = Date.now() - startTime
  logger.info({ taskId, runId, stepId, durationMs, reason }, 'Run aborted before execution')
  await finishRunFailure(params, reason, { notifyWebhook: false, generateWorklog: false })
}

/**
 * Finalize a run that threw an exception.
 * Updates runSteps and runs with failed status, and schedules next queued run.
 */
export async function finishRunError(
  params: FinishRunParams,
  error: unknown,
  usage?: TokenUsage,
): Promise<string> {
  const { taskId, runId, stepId, startTime } = params
  const durationMs = Date.now() - startTime
  const errorMsg = error instanceof Error ? error.message : String(error)
  const publicErrorMsg = 'Execution failed. Check server logs for details.'

  logger.error({ taskId, runId, stepId, durationMs, err: errorMsg }, 'Run execution failed')
  // Explicit usage wins; thrown engine errors may carry usage on the Error object.
  await finishRunFailure(
    params,
    errorMsg,
    { notifyWebhook: true, generateWorklog: true },
    usage ?? extractUsageFromError(error),
  )

  return publicErrorMsg
}

// ============================================================
// Worktree cleanup helper
// ============================================================

export async function cleanupWorktreeIfEphemeral(runId: string, agentId: string): Promise<void> {
  const run = (await db.select().from(runs).where(eq(runs.id, runId)).limit(1))[0]
  if (!run?.worktreeConfig || !run.workDir) return

  const wtConfig = run.worktreeConfig as { name: string; cleanup: string }
  if (wtConfig.cleanup !== 'ephemeral') return

  // A grandfathered sticky config may name a per-agent worktree. Run-end
  // cleanup must not touch it at all: keeping the branch is not enough,
  // deleting the directory would discard uncommitted work. The shape test, not
  // just this Agent's own name — a config naming *another* Agent's worktree
  // would otherwise hand that Agent's branch to `git branch -D`.
  if (isPerAgentWorkspaceName(wtConfig.name)) {
    logger.info(
      { runId, agentId, workspace: wtConfig.name },
      'Skipping ephemeral cleanup for the per-agent worktree',
    )
    return
  }

  // 检查是否有其他 run 还在使用同一 workDir
  const occupied = (
    await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(eq(runs.workDir, run.workDir), inArray(runs.status, ['running', 'pending', 'queued'])),
      )
      .limit(1)
  )[0]
  if (occupied) {
    logger.info(
      { runId, workDir: run.workDir },
      'Worktree still occupied, skipping ephemeral cleanup',
    )
    return
  }

  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
  if (!agent?.scmSourceId) return

  const source = (
    await db.select().from(scmSources).where(eq(scmSources.id, agent.scmSourceId)).limit(1)
  )[0]
  if (!source) return

  const scm = await createScmSource(source)
  if (!scm) return

  // Path-safety guard：agent.scmSourceId 可能在 run 结束前被改绑（PATCH /agents/:id），
  // 当前 source 解析出来的 join(wsRoot, name) 若不等于 run.workDir，说明 workDir
  // 是在旧 source 下生成的——贸然 remove 会误删新 source 下同名的别人家 worktree。
  const expectedPath = join(scm.wsRoot, wtConfig.name)
  if (expectedPath !== run.workDir) {
    logger.warn(
      { runId, runWorkDir: run.workDir, expectedPath, currentSourceId: source.id },
      'Skipping ephemeral cleanup: scm source changed after run started',
    )
    return
  }

  logger.info(
    { runId, workDir: run.workDir, worktreeName: wtConfig.name },
    'Cleaning up ephemeral worktree',
  )
  await scm.removeWorkspace(wtConfig.name)
}
