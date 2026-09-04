/**
 * Execute agent task with retry (exponential backoff).
 * Wraps executeInWorker and retries on failure up to maxRetries times.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import { bindExecutionLeaseTask, hasExecutionLease } from '../engine/execution-lease-registry.js'
import type { StreamLogEntry, TokenUsage } from '../engine/types.js'
import { accumulateUsage } from '../engine/usage.js'
import { executeInWorker } from '../worker/index.js'
import type {
  ExecuteWorkerOptions,
  ExecuteWorkerResult,
  WorkerTaskPayload,
} from '../worker/types.js'
import { applyProviderBinding, type ResolvedProviderBinding } from './agent-helpers.js'
import { logger } from './logger.js'
import type { RetryRecord } from './run-lifecycle.js'
import { createLogCollector } from './run-lifecycle.js'
import { createRunLogFileWriter } from './run-log-file.js'

const A2WAVE_AGENT_ROUTER_MCP_NAME = 'a2wave-agent-router'

function injectRouterRuntimeEnvIntoAgentConfig(
  agentConfig: WorkerTaskPayload['agentConfig'],
  runtimeEnv: Record<string, string>,
): WorkerTaskPayload['agentConfig'] {
  const existingEnv = (agentConfig.agentEnv as Record<string, string> | undefined) ?? {}
  const resolvedMcpServers = agentConfig.resolvedMcpServers?.map((server) => {
    if (server.name !== A2WAVE_AGENT_ROUTER_MCP_NAME) return server
    return {
      ...server,
      env: {
        ...(server.env ?? {}),
        ...runtimeEnv,
      },
    }
  })

  return {
    ...agentConfig,
    agentEnv: { ...existingEnv, ...runtimeEnv },
    ...(resolvedMcpServers ? { resolvedMcpServers } : {}),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function backoffWithJitter(attempt: number): number {
  const baseMs = 2 ** (attempt - 1) * 1000
  const jitter = 1 + Math.random() * 0.2
  return Math.round(baseMs * jitter)
}

function getProviderChain(payload: WorkerTaskPayload): ResolvedProviderBinding[] {
  const chain = payload.agentConfig?.providerChain
  if (!Array.isArray(chain)) return []
  return chain.filter(
    (item): item is ResolvedProviderBinding =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as ResolvedProviderBinding).providerId === 'string' &&
      typeof (item as ResolvedProviderBinding).engineType === 'string',
  )
}

function withProviderBinding(
  payload: WorkerTaskPayload,
  binding: ResolvedProviderBinding,
  options?: { resetChat?: boolean },
): WorkerTaskPayload {
  const nextAgentConfig = { ...payload.agentConfig }
  applyProviderBinding(nextAgentConfig, binding)
  return {
    ...payload,
    model: binding.model,
    ...(options?.resetChat ? { chatId: undefined } : {}),
    agentConfig: nextAgentConfig,
  }
}

const STICKY_PROVIDER_FALLBACK_TTL_MS = 30 * 60 * 1000

interface StickyProviderFallback {
  bindingId: string
  providerId: string
  expiresAt: number
}

interface ChatProviderBinding {
  bindingId: string
  expiresAt: number
}

// 进程内 best-effort 优化：多 worker / 多 Pod 不共享这些 Map，sticky 命中可能退化，
// 但请求仍会按 providerChain 正常重试与降级。
const stickyProviderFallbackByAgentId = new Map<string, StickyProviderFallback>()
const chatBindingByChatId = new Map<string, ChatProviderBinding>()

function pruneExpiredStickyProviderFallbacks(now = Date.now()): void {
  for (const [agentId, sticky] of stickyProviderFallbackByAgentId) {
    if (sticky.expiresAt <= now) stickyProviderFallbackByAgentId.delete(agentId)
  }
}

function pruneExpiredChatBindings(now = Date.now()): void {
  for (const [chatId, binding] of chatBindingByChatId) {
    if (binding.expiresAt <= now) chatBindingByChatId.delete(chatId)
  }
}

function getStickyProviderFallback(agentId: string | undefined): StickyProviderFallback | null {
  if (!agentId) return null
  const sticky = stickyProviderFallbackByAgentId.get(agentId)
  if (!sticky) return null
  if (sticky.expiresAt <= Date.now()) {
    stickyProviderFallbackByAgentId.delete(agentId)
    pruneExpiredChatBindings()
    return null
  }
  return sticky
}

function rememberStickyProviderFallback(
  agentId: string | undefined,
  binding: ResolvedProviderBinding,
): void {
  if (!agentId) return
  const now = Date.now()
  pruneExpiredStickyProviderFallbacks(now)
  stickyProviderFallbackByAgentId.set(agentId, {
    bindingId: binding.id,
    providerId: binding.providerId,
    expiresAt: now + STICKY_PROVIDER_FALLBACK_TTL_MS,
  })
}

function rememberChatProvider(
  chatId: string | null | undefined,
  binding: ResolvedProviderBinding | undefined,
): void {
  if (!chatId || !binding) return
  const now = Date.now()
  pruneExpiredChatBindings(now)
  chatBindingByChatId.set(chatId, {
    bindingId: binding.id,
    expiresAt: now + STICKY_PROVIDER_FALLBACK_TTL_MS,
  })
}

function getChatBindingId(chatId: string): string | undefined {
  const binding = chatBindingByChatId.get(chatId)
  if (!binding) return undefined
  if (binding.expiresAt <= Date.now()) {
    chatBindingByChatId.delete(chatId)
    return undefined
  }
  return binding.bindingId
}

function rotateProviderChainForStickyFallback(
  providerChain: ResolvedProviderBinding[],
  sticky: StickyProviderFallback | null,
): ResolvedProviderBinding[] {
  if (!sticky) return providerChain
  const stickyIndex = providerChain.findIndex((provider) => provider.id === sticky.bindingId)
  if (stickyIndex <= 0) return providerChain
  return [...providerChain.slice(stickyIndex), ...providerChain.slice(0, stickyIndex)]
}

export function _resetStickyProviderFallbackForTests(): void {
  stickyProviderFallbackByAgentId.clear()
  chatBindingByChatId.clear()
}

export function _getStickyProviderFallbackCacheSizeForTests(): number {
  return stickyProviderFallbackByAgentId.size
}

async function isRunCancelled(runId: string | undefined): Promise<boolean> {
  if (!runId) return false
  const run = (
    await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1)
  )[0]
  return run?.status === 'cancelled'
}

// ─── 错误分类：三组互斥模式表 ──────────────────────────────────
//
// 模式既可以是 string（子串匹配）也可以是 RegExp（必须先 lowercase 再 test）。
// 短数字 token（HTTP status 401/403/429/5xx）使用 word-boundary 正则，防止匹配
// 到 "4012ms" / "1429 tokens" 之类带 digits 的无关字符串。
type ErrorPattern = string | RegExp

const NUMERIC_BOUNDARY = (n: number): RegExp => new RegExp(`(^|[^\\d])${n}($|[^\\d])`)

// 永久性错误：retry / fallback 都救不了，应直接失败
const PERMANENT_ERROR_PATTERNS: readonly ErrorPattern[] = [
  NUMERIC_BOUNDARY(401),
  NUMERIC_BOUNDARY(403),
  'unauthorized',
  'forbidden',
  'permission denied',
  'content policy',
  // 'safety' 用 word boundary 避免匹配 'safety_net' / 'thread-safety' 等普通词
  /\bsafety\b/,
  /\bworktree\b/,
  'scm source',
]

// 软限流（每秒/每分钟级 429）：一次短 backoff 往往就能过窗口。有 fallback 时先换
// provider，没有 fallback 时退回「同 provider backoff 重试」而不是快速失败。
const SOFT_RATELIMIT_PATTERNS: readonly ErrorPattern[] = [
  NUMERIC_BOUNDARY(429),
  'rate limit',
  'too many requests',
]

// 硬配额/会话限额：要等数小时~数天重置或换账户，同 provider backoff 救不了 ——
// 没有 fallback 可切时应快速失败，不浪费 backoff 重试。
const HARD_QUOTA_PATTERNS: readonly ErrorPattern[] = [
  'session limit',
  'hit your session',
  'session_limit',
  'daily limit',
  'weekly limit',
  'monthly limit',
  'quota',
  'usage limit',
]

// 确定性能力/模型不兼容：同 provider backoff 不会改变模型能力或工具 schema，
// 有 fallback provider 时应立即切换；没有 fallback 时也应快速失败。
const CAPABILITY_FALLBACK_PATTERNS: readonly ErrorPattern[] = [
  /^empty tool list$/,
  /^tool list empty$/,
  'tool calling is not supported',
  'tools are not supported',
  'does not support tools',
  /\bunsupported tools?\b/,
  /\b(?:invalid|unsupported|incompatible) tool schema\b/,
  /\btool schema\b.*\b(?:invalid|unsupported|incompatible|not supported|rejected)\b/,
  'schema incompatible',
  /\bmcp tools?\b.*\b(?:not supported|unsupported|incompatible|disabled)\b/,
]

const DETERMINISTIC_MODEL_FALLBACK_PATTERNS: readonly ErrorPattern[] = [
  'invalid model',
  'model not found',
  'unknown model',
  'unsupported model',
]

// 账户/配额/限速类（软限流 + 硬配额）：有不同账户的 provider 时换一个就可能解决。
// 这类错误即使带有 401/403 形态，也允许 providerChain fallback 尝试另一个账户。
const ACCOUNT_PROVIDER_FALLBACK_PATTERNS: readonly ErrorPattern[] = [
  ...SOFT_RATELIMIT_PATTERNS,
  ...HARD_QUOTA_PATTERNS,
]

// 所有允许 providerChain 切换的错误。软硬配额之分只影响「无 fallback 时是否还重试」；
// capability/model 错误只在不是永久错误时降级，避免把鉴权/权限问题错误切到备用 provider。
const PROVIDER_FALLBACK_PATTERNS: readonly ErrorPattern[] = [
  ...ACCOUNT_PROVIDER_FALLBACK_PATTERNS,
  ...CAPABILITY_FALLBACK_PATTERNS,
  ...DETERMINISTIC_MODEL_FALLBACK_PATTERNS,
]

// 瞬时错误（timeout / 网络抖 / 5xx / 进程 spawn 等）不单独建表：它们既非永久错误、
// 也非配额类，会自然落到重试循环的默认分支（同 provider backoff 重试），无需显式枚举。

function matchAnyPattern(error: string | undefined, patterns: readonly ErrorPattern[]): boolean {
  if (!error) return false
  const lower = error.toLowerCase()
  return patterns.some((p) => (typeof p === 'string' ? lower.includes(p) : p.test(lower)))
}

/**
 * Should we switch to the NEXT provider in the chain?
 * Only for account/quota/rate-limit class errors where a different
 * account/key actually helps. Transient errors (timeout, 5xx, network)
 * are NOT fallbackable — they get same-provider retry instead, so we
 * don't burn backup-provider quota on problems that switching can't fix.
 *
 * Fallback wins over permanent classification: if an error has BOTH a
 * permanent-shaped substring (e.g. '403') and an account-quota signal
 * (e.g. 'usage limit'), a different account/key may still resolve it.
 * Only mark permanent when no fallback signal is present.
 */
function isProviderFallbackableError(error: string | undefined): boolean {
  if (isPermanentError(error)) return false
  return matchAnyPattern(error, PROVIDER_FALLBACK_PATTERNS)
}

export function isPermanentError(error: string | undefined): boolean {
  // Account fallback errors are not permanent even if they share substrings with
  // permanent patterns — a different provider/account may still recover.
  if (matchAnyPattern(error, ACCOUNT_PROVIDER_FALLBACK_PATTERNS)) return false
  return matchAnyPattern(error, PERMANENT_ERROR_PATTERNS)
}

/**
 * Hard quota / session-limit class: a same-provider backoff retry can't clear it
 * (resets in hours/days, or needs a different account). Only this subset should
 * fast-fail when there's no fallback provider left — soft per-minute 429s instead
 * fall through to a backoff retry, which usually clears the rate window.
 */
export function isHardQuotaError(error: string | undefined): boolean {
  return matchAnyPattern(error, HARD_QUOTA_PATTERNS)
}

function isCapabilityOrModelError(error: string | undefined): boolean {
  return matchAnyPattern(error, [
    ...CAPABILITY_FALLBACK_PATTERNS,
    ...DETERMINISTIC_MODEL_FALLBACK_PATTERNS,
  ])
}

export interface ExecuteWithRetryOptions extends ExecuteWorkerOptions {
  runId?: string
}

export interface ExecuteWithRetryResult {
  result: ExecuteWorkerResult
  retries: RetryRecord[]
  logs: StreamLogEntry[]
}

/**
 * Execute with retry. Returns { result, retries }.
 * Retries on failure up to agentConfig.maxRetries (default 2) times with exponential backoff.
 * Skips retry if run is cancelled (when runId provided).
 *
 * 全量日志旁路：DB 内 logs 受 MAX_STREAM_LOGS 截断（保头丢尾），这里把完整的
 * StreamLogEntry 流 tee 到 data/run-logs/<runId>.ndjson。放在本函数（所有执行
 * 渠道的唯一咽喉点）而非 run-launcher，与 A2WAVE_CHANNEL_B64 注入同理 ——
 * a2a run-recording / feishu-service 不经过 run-launcher。
 */
export async function executeWithRetry(
  taskId: string,
  payload: WorkerTaskPayload,
  options?: ExecuteWithRetryOptions,
): Promise<ExecuteWithRetryResult> {
  const ownsExecutionLease = options?.runId ? !hasExecutionLease(options.runId) : false
  const executionLease = options?.runId
    ? bindExecutionLeaseTask(options.runId, taskId, payload.agentConfig?.agentId)
    : null
  try {
    const runLogFile = options?.runId ? createRunLogFileWriter(options.runId) : null
    if (!runLogFile) {
      return await executeWithRetryCore(taskId, payload, options)
    }
    try {
      // executeWithRetryCore's mergedOnLogEntry forwards every entry generated
      // by retries and provider fallback, so this layer can tee the full stream.
      return await executeWithRetryCore(taskId, payload, {
        ...options,
        onLogEntry: (entry) => {
          runLogFile.write(entry)
          options?.onLogEntry?.(entry)
        },
      })
    } finally {
      await runLogFile.close()
    }
  } finally {
    if (ownsExecutionLease) executionLease?.finish()
  }
}

async function executeWithRetryCore(
  taskId: string,
  payload: WorkerTaskPayload,
  options?: ExecuteWithRetryOptions,
): Promise<ExecuteWithRetryResult> {
  // Inject bounded runtime context into agentEnv and the Agent router MCP at
  // the common execution chokepoint. The router can then forward identity
  // assertions automatically and quoted material only on an explicit tool opt-in.
  //
  // PII NOTE: the encoded payload contains user_info (email / mobile) in
  // base64url (reversible, not encrypted). Agent authors must NOT dump
  // process.env to logs; log collectors must redact A2WAVE_CHANNEL_B64. See
  // `docs/agent/run-channel-context.md` § "运行期 env 注意事项".
  //
  // TODO(run-channel-ipc): move identity transport from env to stdin / Unix
  // socket so PII never enters the process env table. Keep channel_type +
  // channel_info (non-PII) in env for cheap reads; strip user_info.
  const channelCtx = (payload.context as { channel?: unknown } | undefined)?.channel
  const routerRuntimeEnv: Record<string, string> = {}
  if (channelCtx) {
    routerRuntimeEnv.A2WAVE_CHANNEL_B64 = Buffer.from(JSON.stringify(channelCtx), 'utf8').toString(
      'base64url',
    )
  }
  if (payload.referencedPromptContext) {
    routerRuntimeEnv.A2WAVE_REFERENCED_CONTEXT_B64 = Buffer.from(
      JSON.stringify(payload.referencedPromptContext),
      'utf8',
    ).toString('base64url')
  }
  let effectivePayload: WorkerTaskPayload = payload
  if (Object.keys(routerRuntimeEnv).length > 0 && payload.agentConfig) {
    effectivePayload = {
      ...payload,
      agentConfig: injectRouterRuntimeEnvIntoAgentConfig(payload.agentConfig, routerRuntimeEnv),
    }
  } else if (Object.keys(routerRuntimeEnv).length > 0 && !payload.agentConfig) {
    // Non-fatal: channel context built but no agentConfig to carry the env var
    // downstream. Downstream a2a hops from this run will NOT forward the
    // upstream identity — future sub-agent calls will look anonymous. Worth a
    // warn so the gap is discoverable if it ever slips through on a code path
    // that should have agentConfig.
    logger.warn(
      { taskId, runId: options?.runId },
      'A2A router runtime context not injected: payload.agentConfig missing; sub-agent calls will lose upstream context',
    )
  }

  const agentConfig = effectivePayload.agentConfig
  const maxRetries = agentConfig?.maxRetries ?? 2
  const maxAttempts = maxRetries + 1
  // Only pass timeoutMs when explicitly set on agent; otherwise executor will read from system settings
  const timeoutMs =
    agentConfig?.timeoutMinutes != null ? agentConfig.timeoutMinutes * 60 * 1000 : undefined

  logger.info(
    {
      taskId,
      runId: options?.runId,
      maxRetries,
      maxAttempts,
      timeoutMs,
      timeoutMinutes: agentConfig?.timeoutMinutes,
    },
    'executeWithRetry started',
  )

  const { runId, onLogEntry: externalOnLogEntry, ...workerOptions } = options || {}
  const retries: RetryRecord[] = []

  // Internal log collector — always active, persisted via lifecycle
  const { logs, onLogEntry: collectLog } = createLogCollector()
  const mergedOnLogEntry = (entry: StreamLogEntry) => {
    collectLog(entry)
    externalOnLogEntry?.(entry)
  }

  let lastResult: ExecuteWorkerResult = { success: false, output: '', durationMs: 0 }
  let usageAcrossAttempts: TokenUsage | undefined
  const rawProviderChain = getProviderChain(effectivePayload)
  const stickyProviderFallback = getStickyProviderFallback(agentConfig?.agentId)
  const providerChain = rotateProviderChainForStickyFallback(
    rawProviderChain,
    stickyProviderFallback,
  )
  const hasProviderFallback = providerChain.length > 1
  const resetChatForBindingIds = new Set<string>()

  // Run-level wall clock. `timeoutMs` bounds ONE worker execution; with a chain a
  // run can otherwise stack maxAttempts × chainLength of them. Unset (undefined)
  // keeps the previous unbounded shape.
  const deadlineAt =
    agentConfig?.totalTimeoutMinutes != null
      ? Date.now() + agentConfig.totalTimeoutMinutes * 60 * 1000
      : undefined
  const isPastDeadline = (): boolean => deadlineAt !== undefined && Date.now() >= deadlineAt

  // The between-executions check alone does NOT bound the run: one worker that
  // hangs outlives the budget regardless of what we decide after it returns. So
  // the remaining budget is also handed to the worker as ITS timeout, letting the
  // existing worker timeout/cancel path kill the subprocess at the deadline.
  // Without a per-execution timeout configured this still applies — otherwise
  // executor.ts falls back to the global default and overshoots the budget.
  const resolveWorkerTimeoutMs = (): number | undefined => {
    if (deadlineAt === undefined) return timeoutMs
    const remainingMs = Math.max(0, deadlineAt - Date.now())
    return timeoutMs !== undefined ? Math.min(timeoutMs, remainingMs) : remainingMs
  }

  // Depth-first over the chain: each provider gets its OWN budget of maxAttempts
  // executions, then the chain moves on and never comes back (no round-robin).
  // The outer loop walks providers; the inner loop spends one provider's budget.
  const providersToTry = hasProviderFallback ? providerChain : [undefined]
  for (let providerIndex = 0; providerIndex < providersToTry.length; providerIndex++) {
    // Any provider we reach after the first starts a FRESH chat: a chatId is a
    // session owned by one engine/model, so carrying it across a switch makes the
    // new CLI resume a session it never created. Marked here rather than on the
    // fallback path alone, because a provider is also reached by simply exhausting
    // the previous one's retry budget.
    const currentProvider = providersToTry[providerIndex]
    if (providerIndex > 0 && currentProvider) resetChatForBindingIds.add(currentProvider.id)

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (await isRunCancelled(runId)) {
        logger.info({ taskId, runId, attempt, providerIndex }, 'Run cancelled before attempt')
        return { result: lastResult, retries, logs }
      }

      if (isPastDeadline()) {
        logger.warn(
          {
            taskId,
            runId,
            attempt,
            providerIndex,
            totalTimeoutMinutes: agentConfig?.totalTimeoutMinutes,
          },
          'Run-level timeout budget exhausted; not starting another execution',
        )
        return { result: lastResult, retries, logs }
      }

      const providerBinding = providersToTry[providerIndex]
      const knownChatBindingId = effectivePayload.chatId
        ? getChatBindingId(effectivePayload.chatId)
        : undefined
      const resetChatForStickyProvider =
        !!providerBinding &&
        stickyProviderFallback?.bindingId === providerBinding.id &&
        rawProviderChain[0]?.id !== providerBinding.id &&
        !!effectivePayload.chatId &&
        knownChatBindingId !== undefined &&
        knownChatBindingId !== providerBinding.id
      const resetChat =
        !!providerBinding &&
        (resetChatForBindingIds.has(providerBinding.id) || resetChatForStickyProvider)
      const attemptPayload = providerBinding
        ? withProviderBinding(effectivePayload, providerBinding, {
            resetChat,
          })
        : effectivePayload
      const startTime = Date.now()
      logger.info(
        {
          taskId,
          runId,
          attempt,
          maxAttempts,
          providerId: providerBinding?.providerId,
          providerName: providerBinding?.providerName,
          engineType: attemptPayload.agentConfig?.engineType,
          stickyProviderFallback: stickyProviderFallback
            ? {
                bindingId: stickyProviderFallback.bindingId,
                providerId: stickyProviderFallback.providerId,
              }
            : undefined,
          resetChat,
        },
        `Starting execution attempt ${attempt}/${maxAttempts}`,
      )
      if (providerBinding) {
        mergedOnLogEntry({
          type: 'system',
          subtype: 'provider_attempt',
          providerName: providerBinding.providerName,
          model: attemptPayload.model,
          ts: Date.now(),
        })
      }
      const workerTimeoutMs = resolveWorkerTimeoutMs()
      lastResult = await executeInWorker(taskId, attemptPayload, {
        ...workerOptions,
        timeoutMs: workerTimeoutMs,
        onLogEntry: mergedOnLogEntry,
      })
      // Accumulate usage across retries and provider fallback attempts.
      if (lastResult.usage) {
        usageAcrossAttempts = accumulateUsage(usageAcrossAttempts, lastResult.usage)
      }
      if (usageAcrossAttempts) {
        lastResult = { ...lastResult, usage: usageAcrossAttempts }
      }

      if (lastResult.success) {
        rememberChatProvider(lastResult.chatId, providerBinding)
        if (providerBinding && stickyProviderFallback?.bindingId === providerBinding.id) {
          rememberStickyProviderFallback(agentConfig?.agentId, providerBinding)
        }
        if (attempt > 1 || providerIndex > 0) {
          if (providerBinding) {
            rememberStickyProviderFallback(agentConfig?.agentId, providerBinding)
          }
          logger.info(
            {
              taskId,
              runId,
              stepId: workerOptions.stepId,
              attempt,
              providerId: providerBinding?.providerId,
              totalAttempts: maxAttempts,
            },
            'Run succeeded after retry/provider fallback',
          )
        }
        return { result: lastResult, retries, logs }
      }

      // A worker killed by the shrunken budget reports a plain execution timeout,
      // which is indistinguishable from a normal per-execution one. Relabel it and
      // stop: the run budget is spent, so retrying or switching provider would only
      // start work the deadline check rejects immediately.
      if (!lastResult.success && isPastDeadline()) {
        logger.warn(
          {
            taskId,
            runId,
            attempt,
            providerIndex,
            workerTimeoutMs,
            totalTimeoutMinutes: agentConfig?.totalTimeoutMinutes,
          },
          'Run-level timeout budget exhausted during execution',
        )
        lastResult = {
          ...lastResult,
          error: `Run exceeded its total timeout of ${agentConfig?.totalTimeoutMinutes} minutes (last error: ${lastResult.error ?? 'execution failed'})`,
        }
        retries.push({
          attempt,
          error: providerBinding
            ? `[${providerBinding.providerName}] ${lastResult.error}`
            : lastResult.error,
          durationMs: Date.now() - startTime,
        })
        return { result: lastResult, retries, logs }
      }

      const durationMs = Date.now() - startTime

      // 「换个账户就能好」类错误（软限流 429 / 硬配额 / 能力不兼容）不消耗本 provider
      // 的重试预算：同 provider backoff 改变不了配额窗口或模型能力，换 provider 才是
      // 直接解法。这里 break 出本 provider 的预算，直接走下一个。
      // 注意 `retries` 只记录「同 provider 重试」，provider 切换不计入 —— 切换由
      // provider_fallback 日志条目表达，两者语义不同。
      const canFallbackProvider =
        hasProviderFallback &&
        providerIndex < providersToTry.length - 1 &&
        isProviderFallbackableError(lastResult.error)
      if (canFallbackProvider) {
        if (await isRunCancelled(runId)) {
          logger.info(
            { taskId, runId, attempt, providerIndex },
            'Run cancelled before provider fallback',
          )
          return { result: lastResult, retries, logs }
        }

        const nextProvider = providersToTry[providerIndex + 1]
        if (nextProvider) resetChatForBindingIds.add(nextProvider.id)
        logger.warn(
          {
            taskId,
            runId,
            providerId: providerBinding?.providerId,
            nextProviderId: nextProvider?.providerId,
            attempt,
            error: lastResult.error,
          },
          'Provider failed with fallbackable error, trying next provider',
        )
        mergedOnLogEntry({
          type: 'system',
          subtype: 'provider_fallback',
          providerName: providerBinding?.providerName,
          nextProviderName: nextProvider?.providerName,
          ts: Date.now(),
        })
        break
      }

      retries.push({
        attempt,
        error: providerBinding
          ? `[${providerBinding.providerName}] ${lastResult.error ?? 'Execution failed'}`
          : lastResult.error,
        durationMs,
      })

      // 永久错误：重试也救不了，换 provider 也救不了，直接返失败
      if (isPermanentError(lastResult.error)) {
        logger.warn(
          { taskId, runId, error: lastResult.error },
          'Permanent error detected; skipping further retries and provider fallback',
        )
        return { result: lastResult, retries, logs }
      }

      // 已无 provider 可切时：硬配额要等数小时~数天重置，能力不兼容是确定性的 ——
      // 同 provider backoff 撞的是同一堵墙，直接返。软限流（每分钟级 429）不在此列，
      // 它落到下面的 backoff 重试，往往下一拍就过窗口。
      if (isHardQuotaError(lastResult.error) || isCapabilityOrModelError(lastResult.error)) {
        logger.warn(
          { taskId, runId, error: lastResult.error },
          'Hard quota / capability error but no fallback provider remaining; failing without retry',
        )
        return { result: lastResult, retries, logs }
      }

      // 瞬时错误（timeout / 网络抖 / 5xx / spawn 失败）：消耗本 provider 的预算，
      // 指数退避后原地重试。预算用尽则落到外层，换下一个 provider。
      if (attempt < maxAttempts) {
        if (await isRunCancelled(runId)) {
          logger.info({ taskId, runId, attempt }, 'Run cancelled, skipping retry')
          return { result: lastResult, retries, logs }
        }

        const backoffMs = backoffWithJitter(attempt)
        // Don't sleep past the run budget: the retry it waits for would be
        // rejected by the deadline check at the top of the loop anyway, so the
        // sleep would just burn wall clock the caller explicitly capped.
        if (deadlineAt !== undefined && Date.now() + backoffMs >= deadlineAt) {
          logger.warn(
            {
              taskId,
              runId,
              attempt,
              backoffMs,
              totalTimeoutMinutes: agentConfig?.totalTimeoutMinutes,
            },
            'Backoff would outlast the run timeout budget; stopping instead of sleeping',
          )
          return { result: lastResult, retries, logs }
        }
        logger.info(
          { taskId, runId, stepId: workerOptions.stepId, attempt, maxAttempts, backoffMs },
          'Retrying after failure',
        )

        mergedOnLogEntry({ type: 'retry', attempt, nextAttemptIn: backoffMs, ts: Date.now() })

        await sleep(backoffMs)
      } else if (hasProviderFallback && providerIndex < providersToTry.length - 1) {
        // Budget spent on transient errors and another provider is left. This is a
        // provider switch too, so it emits the same entry as the early-switch path
        // above — retries[] records only same-provider retries, so without this the
        // run log cannot distinguish a retry from a post-budget switch.
        const nextProvider = providersToTry[providerIndex + 1]
        if (nextProvider) resetChatForBindingIds.add(nextProvider.id)
        logger.warn(
          {
            taskId,
            runId,
            providerId: providerBinding?.providerId,
            nextProviderId: nextProvider?.providerId,
            attempt,
            error: lastResult.error,
          },
          'Provider retry budget exhausted, trying next provider',
        )
        mergedOnLogEntry({
          type: 'system',
          subtype: 'provider_fallback',
          providerName: providerBinding?.providerName,
          nextProviderName: nextProvider?.providerName,
          ts: Date.now(),
        })
      }
    }
  }

  return { result: lastResult, retries, logs }
}
