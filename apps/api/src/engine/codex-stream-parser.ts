/**
 * Pure parser for Codex CLI's `codex exec --json` stream output lines.
 *
 * Mirrors the shape of `cursor-stream-parser.ts`: side-effect free, takes a
 * single JSON line and returns a normalized event list. The caller
 * (codex-agent.ts) owns logging, callback invocation, and mutable state.
 *
 * Codex 官方文档列出的 7 种事件：thread.started / thread.error / turn.started /
 * turn.completed / turn.failed / item.started / item.updated / item.completed。
 * 其中 item 的 `item.type` 决定工具/消息种类，主要为：
 *
 *   - agent_message     → 文字回答
 *   - reasoning         → 推理过程（不在 UI 中展示 token）
 *   - command_execution → 执行 shell 命令
 *   - mcp_tool_call     → MCP 工具调用
 *   - file_change       → 文件改动
 *   - plan_update       → 计划更新
 *   - web_search        → 联网搜索
 */
import { toolResultText } from './tool-output.js'

/** Normalized event types emitted by the parser. */
export type ParsedCodexEvent =
  /** Non-JSON line — caller should ignore but may want to log. */
  | { kind: 'non_json' }
  /** Unrecognized JSON message type — caller may debug-log. */
  | { kind: 'unknown'; msgType: string; subtype?: string }
  /** Thread id surfaced from `thread.started.thread_id`. */
  | { kind: 'session'; chatId: string }
  /** Turn started — lightweight heartbeat. */
  | { kind: 'turn_started' }
  /** Turn completed — signals result ready; usage included when present. */
  | {
      kind: 'turn_completed'
      usage?: {
        inputTokens?: number
        cachedInputTokens?: number
        outputTokens?: number
      }
    }
  /** Turn failed — caller treats as error result. */
  | { kind: 'result_other'; subtype: 'error'; error?: string }
  /** Final agent_message text (from item.completed). */
  | { kind: 'assistant_text'; text: string }
  /** Tool call started (command_execution / mcp_tool_call item.started). */
  | {
      kind: 'tool_call'
      toolName: string
      callId: string
      input?: Record<string, unknown>
      subtype: 'started' | 'completed' | 'failed'
      error?: string
      /** Non-content facts about the call (`exit_code`); safe to export with content capture off. */
      metadata?: Record<string, unknown>
      /** What the tool returned, capped. Tracer-only content — see engine/tool-output.ts. */
      output?: string
    }
  /** Stream-level error (thread.error). */
  | { kind: 'error'; message: string }

/** Stat key in the format used by the engine's messageStats map. */
export function statKeyFor(msgType: string, subtype?: string): string {
  return subtype ? `${msgType}:${subtype}` : msgType
}

export interface ParsedCodexLine {
  events: ParsedCodexEvent[]
  /** Raw `type` field value (e.g. 'item.completed'). */
  msgType?: string
  /** Derived "subtype": for item.* lines this is the item's `item.type`. */
  subtype?: string
}

/**
 * Compose codex's stream of `assistant_text` events into a single output string.
 *
 * - `cleanResult=false` (default): concatenate every event with newlines — preserves
 *   thinking-process / scratchpad text so the run log is fully reproducible.
 * - `cleanResult=true`: keep only the LAST non-empty assistant_text. We can't blindly
 *   take `texts[len-1].trim()` because codex sometimes emits a trailing whitespace
 *   frame after the real final answer; trimming a whitespace-only frame would
 *   produce '' and overwrite the buffer on the next `onUpdate` tick, leaving the
 *   run with an empty result. Scanning from the back for the first non-empty
 *   entry guards against that.
 */
export function composeCodexAssistantOutput(texts: string[], cleanResult = false): string {
  if (texts.length === 0) return ''
  if (cleanResult) {
    for (let i = texts.length - 1; i >= 0; i--) {
      const trimmed = texts[i].trim()
      if (trimmed) return trimmed
    }
    return ''
  }
  return texts.join('\n')
}

/** Map a command_execution / mcp_tool_call item to a tool_call event. */
function parseCommandItem(
  item: Record<string, unknown>,
  phase: 'started' | 'completed',
): ParsedCodexEvent {
  const toolName =
    (item.type as string) === 'mcp_tool_call'
      ? (item.tool as string) || (item.name as string) || 'mcp'
      : 'shell'
  const callId = (item.id as string) || ''
  const rawInput: Record<string, unknown> = {}
  if (typeof item.command === 'string') rawInput.command = item.command
  if (typeof item.tool === 'string') rawInput.tool = item.tool
  if (item.arguments && typeof item.arguments === 'object') {
    rawInput.arguments = item.arguments
  }
  const input = Object.keys(rawInput).length > 0 ? rawInput : undefined

  const status = item.status as string | undefined
  let subtype: 'started' | 'completed' | 'failed' = phase
  let error: string | undefined
  if (phase === 'completed') {
    if (status === 'failed' || status === 'error') {
      subtype = 'failed'
      if (typeof item.error === 'string') error = item.error
    } else {
      subtype = 'completed'
    }
  }

  // A finished command's combined stdout/stderr. Content: it goes on `output`, never in metadata.
  const output = phase === 'completed' ? toolResultText(item.aggregated_output) : undefined

  // Only the exit code: `aggregated_output` is content and never goes into metadata.
  const metadata =
    phase === 'completed' && typeof item.exit_code === 'number'
      ? { exit_code: item.exit_code }
      : undefined

  return {
    kind: 'tool_call',
    toolName,
    callId,
    ...(input ? { input } : {}),
    subtype,
    ...(error ? { error } : {}),
    ...(metadata ? { metadata } : {}),
    ...(output ? { output } : {}),
  }
}

/** Decode an item.* event into zero or more normalized events. */
function parseItemEvent(
  data: Record<string, unknown>,
  phase: 'started' | 'updated' | 'completed',
): ParsedCodexEvent[] {
  const item = data.item as Record<string, unknown> | undefined
  if (!item || typeof item !== 'object') return []
  const itemType = (item.type as string) || 'unknown'

  switch (itemType) {
    case 'agent_message': {
      // 只在 completed 时拿权威文本；started/updated 的流式 token 不在稳定文档里
      if (phase !== 'completed') return []
      const text = typeof item.text === 'string' ? item.text : ''
      if (!text) return []
      return [{ kind: 'assistant_text', text }]
    }
    case 'command_execution':
    case 'mcp_tool_call': {
      if (phase === 'updated') return []
      return [parseCommandItem(item, phase)]
    }
    case 'reasoning':
      // 推理过程不对外展示（和 cursor 的 thinking 对齐，当前无副作用）
      return []
    case 'file_change':
    case 'plan_update':
    case 'web_search': {
      // 作为 started/completed 通用 tool_call 呈现一次
      if (phase === 'updated') return []
      return [
        {
          kind: 'tool_call',
          toolName: itemType,
          callId: (item.id as string) || '',
          subtype: phase,
        },
      ]
    }
    default:
      return [{ kind: 'unknown', msgType: 'item', subtype: itemType }]
  }
}

/**
 * Normalize an `error` field that may be a string, an object with `message`,
 * or an arbitrary value. Codex 在稳定版里 turn.failed / thread.error 的 error
 * 字段形状为 `{ message: string; ... }`，但老版本偶见直接给字符串，
 * 这里做兼容提取。
 */
function extractErrorMessage(raw: unknown): string | undefined {
  if (raw == null) return undefined
  if (typeof raw === 'string') return raw || undefined
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (typeof obj.message === 'string' && obj.message) return obj.message
    if (typeof obj.error === 'string' && obj.error) return obj.error
    if (obj.error && typeof obj.error === 'object') {
      const inner = obj.error as Record<string, unknown>
      if (typeof inner.message === 'string' && inner.message) return inner.message
    }
    try {
      return JSON.stringify(raw)
    } catch {
      return undefined
    }
  }
  return String(raw)
}

/** Parse a `turn.completed` usage payload. */
function extractUsage(
  data: Record<string, unknown>,
): { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | undefined {
  const usage = data.usage as Record<string, unknown> | undefined
  if (!usage || typeof usage !== 'object') return undefined
  const out: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
  } = {}
  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens
  if (typeof usage.cached_input_tokens === 'number')
    out.cachedInputTokens = usage.cached_input_tokens
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Parse one stdout line from `codex exec --json`.
 *
 * Returns `{ events, msgType?, subtype? }`:
 * - `events` — list of normalized events; non-JSON lines yield
 *   `[{kind: 'non_json'}]`.
 * - `msgType` — raw top-level `type` (e.g. 'item.completed').
 * - `subtype` — for item.* lines, the `item.type` value; otherwise undefined.
 *
 * A `session` event is emitted before any other event on the `thread.started`
 * line so callers can update their chat id state first.
 */
export function parseCodexStreamLine(line: string): ParsedCodexLine {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(line)
  } catch {
    return { events: [{ kind: 'non_json' }] }
  }

  const msgType = data.type as string | undefined
  const events: ParsedCodexEvent[] = []
  let subtype: string | undefined

  switch (msgType) {
    case 'thread.started': {
      const threadId = (data.thread_id as string) || ''
      if (threadId) events.push({ kind: 'session', chatId: threadId })
      break
    }
    case 'thread.error': {
      const message =
        extractErrorMessage(data.error) ||
        extractErrorMessage(data.message) ||
        'Unknown thread error'
      events.push({ kind: 'error', message })
      break
    }
    case 'turn.started':
      events.push({ kind: 'turn_started' })
      break
    case 'turn.completed': {
      const usage = extractUsage(data)
      events.push({ kind: 'turn_completed', ...(usage ? { usage } : {}) })
      break
    }
    case 'turn.failed': {
      const errorText = extractErrorMessage(data.error) ?? extractErrorMessage(data.message)
      events.push({
        kind: 'result_other',
        subtype: 'error',
        ...(errorText ? { error: errorText } : {}),
      })
      break
    }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const phase = msgType.split('.')[1] as 'started' | 'updated' | 'completed'
      const item = data.item as Record<string, unknown> | undefined
      if (item && typeof item.type === 'string') subtype = item.type
      events.push(...parseItemEvent(data, phase))
      break
    }
    default:
      if (msgType) events.push({ kind: 'unknown', msgType, subtype })
      break
  }

  return { events, msgType, subtype }
}
