/**
 * Claude-Code style NDJSON event stream parser (shared by the qoder / trae engines).
 *
 * With `--output-format stream-json`, both qodercli and traecli emit an event
 * stream isomorphic to Claude Code's (observed with qodercli 1.1.51 /
 * traecli 0.120.52):
 * - `{"type":"system","subtype":"init","session_id":...}`
 * - `{"type":"assistant","message":{"content":[{type:'text'|'tool_use',...}]}}`
 * - `{"type":"user","message":{"content":[{type:'tool_result',...}]}}`
 * - `{"type":"stream_event","event":{"delta":{"type":"text_delta","text":...}}}`
 * - `{"type":"result","subtype":"success"|"error_*","is_error":bool,
 *    "result"?:string,"error"?:string,"errors"?:string[]}`
 *
 * Derived from the inline parsing logic in claude-code.ts; differences:
 * - The result error text comes in three carriers: the `result` string
 *   (claude/qoder), the `error` string (trae), and the `errors[]` array (qoder).
 * - Noise system subtypes (e.g. thinking_tokens) are dropped at the source.
 */

import type { HeartbeatTracker } from './heartbeat.js'
import type { StreamCallback, StreamLogCallback, TokenUsage } from './types.js'
import { extractClaudeStyleUsage } from './usage.js'

/** High-frequency counter-style system events; forwarding them only floods the log with noise (aligned with claude-code.ts). */
const NOISE_SYSTEM_SUBTYPES = new Set(['thinking_tokens'])

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export interface CcStreamParserOptions {
  onUpdate?: StreamCallback
  onLogEntry?: StreamLogCallback
  heartbeat: HeartbeatTracker
  /** Initial session ID (resume scenario); overridden by the in-stream session_id during parsing */
  initialSessionId?: string
  /**
   * Whether result events contribute token usage. Defaults to true. Qoder uses
   * credit-based billing and emits zero-valued placeholders instead of real
   * token counts, so its engine disables collection to preserve NULL as the
   * untracked sentinel rather than storing a misleading zero.
   */
  collectUsage?: boolean
}

export interface CcStreamParserState {
  sessionId?: string
  outputBuffer: string
  resultReceived: boolean
  resultIsError: boolean
  resultErrorText: string
  /** Latest result usage; Claude-style result usage is cumulative for the execution. */
  lastUsage?: TokenUsage
}

export interface CcStreamParser {
  parseLine(line: string): void
  readonly state: CcStreamParserState
}

/** Extract the error text from a result event (`result` string / `error` string / `errors[]`). */
function extractResultErrorText(data: Record<string, unknown>): string {
  if (typeof data.result === 'string' && data.result) return data.result
  if (typeof data.error === 'string' && data.error) return data.error
  if (Array.isArray(data.errors)) {
    const joined = data.errors.filter((e): e is string => typeof e === 'string').join('\n')
    if (joined) return joined
  }
  return ''
}

export function createCcStreamParser(options: CcStreamParserOptions): CcStreamParser {
  const { onUpdate, onLogEntry, heartbeat } = options
  const state: CcStreamParserState = {
    sessionId: options.initialSessionId,
    outputBuffer: '',
    resultReceived: false,
    resultIsError: false,
    resultErrorText: '',
  }
  // callId → toolName: tool_result events don't repeat toolName, so terminal entries need it backfilled
  const toolNameByCallId = new Map<string, string>()

  const parseLine = (line: string) => {
    if (!line.trim()) return
    const data = tryParseJson(line)
    if (!data) return

    if (typeof data.session_id === 'string' && data.session_id) {
      state.sessionId = data.session_id
    } else if (typeof data.chat_id === 'string' && data.chat_id) {
      state.sessionId = data.chat_id
    }

    const type = data.type as string | undefined
    const subtype = data.subtype as string | undefined
    if (!type) return

    switch (type) {
      case 'system': {
        if (subtype && NOISE_SYSTEM_SUBTYPES.has(subtype)) break
        onLogEntry?.({
          type: 'system',
          subtype: subtype || 'system',
          model: data.model as string | undefined,
          ts: Date.now(),
        })
        break
      }
      case 'stream_event': {
        const event = data.event as Record<string, unknown> | undefined
        const delta = event?.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          state.outputBuffer += delta.text
          onUpdate?.(state.outputBuffer)
          onLogEntry?.({ type: 'assistant', text: delta.text, ts: Date.now() })
        }
        break
      }
      case 'assistant': {
        const message = data.message as Record<string, unknown> | undefined
        const content = message?.content as unknown[] | undefined
        if (!Array.isArray(content)) break
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const typedBlock = block as Record<string, unknown>
          if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
            state.outputBuffer += typedBlock.text
            onUpdate?.(state.outputBuffer)
            onLogEntry?.({ type: 'assistant', text: typedBlock.text, ts: Date.now() })
          }
          if (typedBlock.type === 'tool_use') {
            const rawInput = typedBlock.input
            const input =
              rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
                ? (rawInput as Record<string, unknown>)
                : undefined
            const callId = (typedBlock.id as string) || ''
            const toolName = (typedBlock.name as string) || 'unknown'
            if (callId) toolNameByCallId.set(callId, toolName)
            onLogEntry?.({
              type: 'tool_call',
              subtype: 'started',
              callId,
              toolName,
              input,
              ts: Date.now(),
            })
            if (callId) heartbeat.onStarted(callId, toolName)
          }
        }
        break
      }
      case 'user': {
        const message = data.message as Record<string, unknown> | undefined
        const content = message?.content as unknown[] | undefined
        if (!Array.isArray(content)) break
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const typedBlock = block as Record<string, unknown>
          if (typedBlock.type !== 'tool_result') continue
          const callId = (typedBlock.tool_use_id as string) || ''
          if (!callId) continue
          const isError = typedBlock.is_error === true
          let errorText: string | undefined
          if (isError) {
            const raw = typedBlock.content
            if (typeof raw === 'string') {
              errorText = raw
            } else if (Array.isArray(raw)) {
              errorText =
                raw
                  .map((b) => {
                    if (
                      b &&
                      typeof b === 'object' &&
                      'text' in b &&
                      typeof (b as { text: unknown }).text === 'string'
                    ) {
                      return (b as { text: string }).text
                    }
                    return ''
                  })
                  .filter(Boolean)
                  .join('\n') || undefined
            }
          }
          heartbeat.onSettled(callId)
          const toolName = toolNameByCallId.get(callId) ?? ''
          toolNameByCallId.delete(callId)
          onLogEntry?.({
            type: 'tool_call',
            subtype: isError ? 'failed' : 'completed',
            callId,
            toolName,
            ...(errorText ? { error: errorText } : {}),
            ts: Date.now(),
          })
        }
        break
      }
      case 'result': {
        state.resultReceived = true
        if (options.collectUsage !== false) {
          const usage = extractClaudeStyleUsage(data)
          if (usage) state.lastUsage = usage
        }
        // A prior top-level `error` event is fatal and sticky: a later success
        // result must NOT clear resultIsError back to false (qoder/trae can emit
        // error → success result yet still exit 0, which would otherwise persist
        // a failed run as success). Only escalate to error, never de-escalate.
        if (data.is_error === true) state.resultIsError = true
        const resultText = typeof data.result === 'string' ? data.result : ''
        if (resultText) {
          state.outputBuffer = resultText.trim()
          onUpdate?.(state.outputBuffer)
        }
        if (state.resultIsError) {
          // Only an is_error result carries error text here — a success result
          // arriving after a sticky error must not have its `result` string
          // mistaken for the error cause. Prefer this event's own error text,
          // else keep the message a prior `error`/error-result already recorded.
          const ownErrorText = data.is_error === true ? extractResultErrorText(data) : ''
          state.resultErrorText =
            ownErrorText || state.resultErrorText || 'CLI returned an error result'
        }
        onLogEntry?.({
          type: 'result',
          subtype: state.resultIsError ? 'error' : 'success',
          durationMs: typeof data.duration_ms === 'number' ? data.duration_ms : undefined,
          ...(state.lastUsage ? { usage: state.lastUsage } : {}),
          ts: Date.now(),
        })
        break
      }
      case 'error': {
        // A top-level error event is fatal: qoder/trae can still exit 0 after
        // emitting one, so the settle verdict relies on resultIsError (not just
        // errorText) to reject the run — without this flag a failed run gets
        // persisted as a success (wrong result + wrong audit record).
        const message = (data.message as string) || (data.error as string) || 'Unknown error'
        state.resultIsError = true
        state.resultErrorText = message
        onLogEntry?.({ type: 'error', message, ts: Date.now() })
        break
      }
      default:
        break
    }
  }

  return { parseLine, state }
}
