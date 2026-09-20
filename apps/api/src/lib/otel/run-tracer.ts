/**
 * Maps one Agent execution onto OpenTelemetry spans:
 *
 *   invoke_agent <agent>          one per executeWithRetry call
 *   └─ attempt                    one per retry / provider-fallback iteration
 *      └─ execute_tool <tool>     paired from normalized tool_call events
 *
 * Provider-agnostic by construction: the only inputs are the WorkerTaskPayload, the normalized
 * StreamLogEntry stream and the ExecuteWorkerResult — nothing here knows which CLI ran.
 *
 * Observation only. Every method is synchronous and swallows its own failures; tracing must never
 * be able to fail, delay or reorder a run.
 */
import {
  type Attributes,
  type AttributeValue,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import type { StreamLogEntry } from '../../engine/types.js'
import type { ExecuteWorkerResult, WorkerTaskPayload } from '../../worker/types.js'
import { logger } from '../logger.js'
import {
  ATTR,
  classifyError,
  collectSecretValues,
  type ErrorClassifiers,
  toContentAttribute,
  usageAttributes,
} from './attributes.js'
import { formatTraceparent, parseTraceparent } from './propagation.js'
import { getOtelRuntime, type OtelRuntime } from './provider.js'

/** A runaway agent must not be able to grow the open-span map without bound. */
const MAX_OPEN_TOOL_SPANS = 256
const A2A_TASK_EVENT_RE = /^a2a\.task\./

export interface AttemptInfo {
  attempt: number
  providerIndex: number
  binding?: { providerId: string; providerName: string }
  model?: string
  engineType?: string
  resetChat: boolean
}

export interface RunOutcome {
  result?: ExecuteWorkerResult
  retries: number
  cancelled?: boolean
  thrown?: unknown
}

export interface AttemptTrace {
  /** `traceparent` of the attempt span, to hand to the CLI child and the agent-router. */
  traceparent(): string | undefined
  end(result: ExecuteWorkerResult): void
}

export interface RunTrace {
  readonly enabled: boolean
  onLogEntry(entry: StreamLogEntry): void
  startAttempt(info: AttemptInfo): AttemptTrace
  finish(outcome: RunOutcome): void
}

export interface RunTraceOptions {
  runId?: string
  classifiers?: ErrorClassifiers
}

const NOOP_ATTEMPT: AttemptTrace = { traceparent: () => undefined, end: () => {} }
const NOOP_RUN_TRACE: RunTrace = {
  enabled: false,
  onLogEntry: () => {},
  startAttempt: () => NOOP_ATTEMPT,
  finish: () => {},
}

interface OpenTool {
  span: Span
  startMs: number
}

function guard(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    logger.debug({ err: (err as Error).message, label }, 'otel: run tracer step failed')
  }
}

function primitiveAttributes(metadata: Record<string, unknown> | undefined): Attributes {
  const attrs: Attributes = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attrs[key] = value
    }
  }
  return attrs
}

class ActiveRunTrace implements RunTrace {
  readonly enabled = true
  private readonly secrets: string[]
  private readonly openTools = new Map<string, OpenTool>()
  private attemptSpan: Span | null = null
  private attemptCount = 0
  private lastModel: string | undefined
  private lastEngineType: string | undefined
  private anonymousToolSeq = 0
  private finished = false

  constructor(
    private readonly runtime: OtelRuntime,
    private readonly root: Span,
    private readonly payload: WorkerTaskPayload,
    private readonly classifiers: ErrorClassifiers,
  ) {
    this.secrets = runtime.captureContent ? collectSecretValues(payload.agentConfig) : []
  }

  onLogEntry(entry: StreamLogEntry): void {
    if (this.finished) return
    guard('onLogEntry', () => {
      if (entry.type === 'tool_call') this.onToolCall(entry)
      else if (entry.type === 'retry') {
        this.root.addEvent('retry', { attempt: entry.attempt, backoff_ms: entry.nextAttemptIn })
      } else if (entry.type === 'system') this.onSystem(entry)
    })
  }

  private onSystem(entry: Extract<StreamLogEntry, { type: 'system' }>): void {
    if (entry.subtype === 'provider_fallback') {
      const attrs: Attributes = {}
      if (entry.providerName) attrs.from = entry.providerName
      if (entry.nextProviderName) attrs.to = entry.nextProviderName
      this.root.addEvent('provider_fallback', attrs)
    } else if (A2A_TASK_EVENT_RE.test(entry.subtype)) {
      this.root.addEvent(entry.subtype, primitiveAttributes(entry.metadata))
    }
  }

  /** Empty call ids (some CLIs omit them) pair FIFO per tool name. */
  private findOpenToolKey(callId: string, toolName: string): string | undefined {
    if (callId) return this.openTools.has(`id:${callId}`) ? `id:${callId}` : undefined
    const prefix = `anon:${toolName}:`
    for (const key of this.openTools.keys()) if (key.startsWith(prefix)) return key
    return undefined
  }

  private onToolCall(entry: Extract<StreamLogEntry, { type: 'tool_call' }>): void {
    // Outside an attempt there is nothing to parent the span to (late events after a timeout).
    if (!this.attemptSpan) return
    const existingKey = this.findOpenToolKey(entry.callId, entry.toolName)

    if (entry.subtype === 'started') {
      if (entry.callId && existingKey) return
      if (this.openTools.size >= MAX_OPEN_TOOL_SPANS) return
      const key = entry.callId
        ? `id:${entry.callId}`
        : `anon:${entry.toolName}:${this.anonymousToolSeq++}`
      this.openTools.set(key, { span: this.startToolSpan(entry), startMs: entry.ts })
      return
    }

    let open = existingKey ? this.openTools.get(existingKey) : undefined
    if (existingKey) this.openTools.delete(existingKey)
    if (!open) {
      // Some CLIs deliver a tool call as a single terminal event.
      open = { span: this.startToolSpan(entry), startMs: entry.ts }
      open.span.setAttribute(ATTR.TOOL_UNPAIRED, true)
    }
    if (entry.subtype === 'failed') {
      open.span.setAttribute(ATTR.ERROR_TYPE, 'tool_error')
      open.span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(this.runtime.captureContent && entry.error
          ? { message: toContentAttribute(entry.error, this.secrets) }
          : {}),
      })
    } else {
      open.span.setStatus({ code: SpanStatusCode.OK })
    }
    open.span.end(Math.max(entry.ts, open.startMs))
  }

  private startToolSpan(entry: Extract<StreamLogEntry, { type: 'tool_call' }>): Span {
    const toolName = entry.toolName || 'unknown'
    const attributes: Attributes = {
      [ATTR.OPERATION_NAME]: 'execute_tool',
      [ATTR.TOOL_NAME]: toolName,
    }
    if (entry.callId) attributes[ATTR.TOOL_CALL_ID] = entry.callId
    if (this.runtime.captureContent && entry.input) {
      attributes[ATTR.TOOL_CALL_ARGUMENTS] = toContentAttribute(
        JSON.stringify(entry.input),
        this.secrets,
      )
    }
    return this.runtime.tracer.startSpan(
      `execute_tool ${toolName}`,
      { kind: SpanKind.INTERNAL, startTime: entry.ts, attributes },
      trace.setSpan(ROOT_CONTEXT, this.attemptSpan as Span),
    )
  }

  startAttempt(info: AttemptInfo): AttemptTrace {
    if (this.finished) return NOOP_ATTEMPT
    let span: Span | null = null
    guard('startAttempt', () => {
      this.closeAttempt()
      this.attemptCount++
      this.lastModel = info.model ?? this.lastModel
      this.lastEngineType = info.engineType ?? this.lastEngineType
      const attributes: Attributes = {
        [ATTR.ATTEMPT_NUMBER]: info.attempt,
        [ATTR.PROVIDER_INDEX]: info.providerIndex,
        [ATTR.CHAT_RESET]: info.resetChat,
      }
      if (info.binding) {
        attributes[ATTR.PROVIDER_ID] = info.binding.providerId
        attributes[ATTR.PROVIDER_DISPLAY_NAME] = info.binding.providerName
      }
      if (info.model) attributes[ATTR.REQUEST_MODEL] = info.model
      if (info.engineType) attributes[ATTR.PROVIDER_NAME] = info.engineType
      span = this.runtime.tracer.startSpan(
        'attempt',
        { kind: SpanKind.INTERNAL, attributes },
        trace.setSpan(ROOT_CONTEXT, this.root),
      )
      this.attemptSpan = span
    })
    const attemptSpan = span as Span | null
    if (!attemptSpan) return NOOP_ATTEMPT
    return {
      traceparent: () => formatTraceparent(attemptSpan.spanContext()),
      end: (result) =>
        guard('endAttempt', () => {
          if (this.attemptSpan !== attemptSpan) return
          attemptSpan.setAttributes(usageAttributes(result.usage))
          this.setResultStatus(attemptSpan, result)
          this.closeAttempt()
        }),
    }
  }

  private closeAttempt(): void {
    const span = this.attemptSpan
    if (!span) return
    this.attemptSpan = null
    for (const open of this.openTools.values()) {
      open.span.setAttribute(ATTR.TOOL_INCOMPLETE, true)
      open.span.end()
    }
    this.openTools.clear()
    span.end()
  }

  /** Status comes from the execution verdict, never from the last `result` stream event. */
  private setResultStatus(span: Span, result: ExecuteWorkerResult): string | undefined {
    if (result.success) {
      span.setStatus({ code: SpanStatusCode.OK })
      return undefined
    }
    const errorType = classifyError(result.error, this.classifiers)
    span.setAttribute(ATTR.ERROR_TYPE, errorType)
    span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(this.runtime.captureContent && result.error
        ? { message: toContentAttribute(result.error, this.secrets) }
        : {}),
    })
    return errorType
  }

  finish(outcome: RunOutcome): void {
    if (this.finished) return
    this.finished = true
    guard('finish', () => {
      this.closeAttempt()
      const { result } = outcome
      const attributes: Attributes = {
        [ATTR.ATTEMPT_COUNT]: this.attemptCount,
        [ATTR.RETRY_COUNT]: outcome.retries,
        ...usageAttributes(result?.usage),
      }
      const model = this.lastModel ?? this.payload.model ?? this.payload.agentConfig?.model
      if (model) attributes[ATTR.REQUEST_MODEL] = model
      if (this.lastEngineType) attributes[ATTR.PROVIDER_NAME] = this.lastEngineType
      const conversationId = result?.chatId ?? this.payload.chatId
      if (conversationId) attributes[ATTR.CONVERSATION_ID] = conversationId
      this.root.setAttributes(attributes)
      this.root.setAttribute(ATTR.RUN_OUTCOME, this.applyOutcome(outcome))
    })
    guard('finish.end', () => this.root.end())
    guard('finish.release', () => this.runtime.release())
  }

  private applyOutcome(outcome: RunOutcome): 'success' | 'failed' | 'timeout' | 'cancelled' {
    const { result } = outcome
    // A user-initiated stop is not an error: leave the status UNSET.
    if (outcome.cancelled) return 'cancelled'
    if (!result) {
      const thrown = outcome.thrown
      this.root.setAttribute(ATTR.ERROR_TYPE, thrown instanceof Error ? thrown.name : '_OTHER')
      this.root.setStatus({
        code: SpanStatusCode.ERROR,
        ...(this.runtime.captureContent && thrown instanceof Error
          ? { message: toContentAttribute(thrown.message, this.secrets) }
          : {}),
      })
      return 'failed'
    }
    const errorType = this.setResultStatus(this.root, result)
    if (result.success) {
      if (this.runtime.captureContent && result.output) {
        this.root.setAttribute(
          ATTR.OUTPUT_MESSAGES,
          JSON.stringify([
            {
              role: 'assistant',
              parts: [{ type: 'text', content: toContentAttribute(result.output, this.secrets) }],
              finish_reason: 'stop',
            },
          ]),
        )
      }
      return 'success'
    }
    return errorType === 'timeout' ? 'timeout' : 'failed'
  }
}

function rootAttributes(
  taskId: string,
  payload: WorkerTaskPayload,
  runId: string | undefined,
): Attributes {
  const agentConfig = payload.agentConfig
  const candidates: Record<string, AttributeValue | undefined> = {
    [ATTR.OPERATION_NAME]: 'invoke_agent',
    [ATTR.PROVIDER_NAME]: agentConfig?.engineType,
    [ATTR.AGENT_ID]: agentConfig?.agentId,
    [ATTR.AGENT_NAME]: agentConfig?.agentName,
    [ATTR.REQUEST_MODEL]: payload.model ?? agentConfig?.model,
    [ATTR.RUN_ID]: runId,
    [ATTR.TASK_ID]: taskId,
    // channel_type only: the rest of the channel context carries PII (email / mobile).
    [ATTR.TRIGGER_SOURCE]: channelType(payload),
  }
  const attributes: Attributes = {}
  for (const [key, value] of Object.entries(candidates)) {
    if (value !== undefined && value !== '') attributes[key] = value
  }
  return attributes
}

function channelType(payload: WorkerTaskPayload): string | undefined {
  const channel = (payload.context as { channel?: { channel_type?: unknown } } | undefined)?.channel
  return typeof channel?.channel_type === 'string' ? channel.channel_type : undefined
}

/** Starts the `invoke_agent` span, or returns an inert trace when export is off. Never throws. */
export function startRunTrace(
  taskId: string,
  payload: WorkerTaskPayload,
  options: RunTraceOptions = {},
): RunTrace {
  const runtime = getOtelRuntime()
  if (!runtime) return NOOP_RUN_TRACE
  let acquired = false
  try {
    runtime.acquire()
    acquired = true
    const agentConfig = payload.agentConfig
    const agentLabel = agentConfig?.agentName || agentConfig?.agentId || 'unknown'
    const attributes = rootAttributes(taskId, payload, options.runId)
    if (runtime.captureContent && payload.prompt) {
      attributes[ATTR.INPUT_MESSAGES] = JSON.stringify([
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              content: toContentAttribute(payload.prompt, collectSecretValues(agentConfig)),
            },
          ],
        },
      ])
    }
    const remoteParent = parseTraceparent(payload.traceParent)
    const parentContext = remoteParent
      ? trace.setSpanContext(ROOT_CONTEXT, remoteParent)
      : ROOT_CONTEXT
    const root = runtime.tracer.startSpan(
      `invoke_agent ${agentLabel}`,
      { kind: SpanKind.INTERNAL, attributes },
      parentContext,
    )
    return new ActiveRunTrace(runtime, root, payload, options.classifiers ?? {})
  } catch (err) {
    if (acquired) runtime.release()
    logger.debug({ err: (err as Error).message }, 'otel: failed to start the run trace')
    return NOOP_RUN_TRACE
  }
}
