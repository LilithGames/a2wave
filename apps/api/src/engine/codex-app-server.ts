import { composeCodexAssistantOutput, parseCodexStreamLine } from './codex-stream-parser.js'
import type { ExecuteResult, StreamCallback, StreamLogCallback, TokenUsage } from './types.js'
import { mapCodexUsage } from './usage.js'

interface SessionOptions {
  model: string
  prompt: string
  cwd: string
  version: string
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  chatId?: string
  reasoningEffort?: string
  fastMode?: boolean
  cleanResult?: boolean
  onUpdate?: StreamCallback
  onLogEntry?: StreamLogCallback
  onToolStarted?: (id: string, name: string) => void
  onToolSettled?: (id: string) => void
}

interface ProtocolInput {
  write: (line: string) => unknown
  end: () => unknown
}

type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const message = object(value).message
  return typeof message === 'string' ? message : undefined
}

/** One app-server process owns one turn; the engine restarts it with fresh credentials per run. */
export class CodexAppServerSession {
  result?: Omit<ExecuteResult, 'durationMs'>
  usage?: TokenUsage
  authenticationFailed = false
  private input?: ProtocolInput
  private readonly startedAt = Date.now()
  private chatId?: string
  private turnId?: string
  private readonly messages = new Map<string, string>()
  private readonly streamedItems = new Set<string>()
  private readonly completedItems = new Set<string>()
  private pendingRequest = 1
  private usageBaseline?: Record<string, number>

  constructor(private readonly options: SessionOptions) {
    this.chatId = options.chatId
  }

  start(input: ProtocolInput): void {
    this.input = input
    this.send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'a2wave', title: 'a2wave', version: this.options.version },
      },
    })
  }

  private send(message: JsonObject): void {
    this.input?.write(`${JSON.stringify(message)}\n`)
  }

  private output(): string {
    return composeCodexAssistantOutput([...this.messages.values()], this.options.cleanResult)
  }

  private finish(success: boolean, error?: string): void {
    if (this.result) return
    this.result = {
      success,
      output: this.output(),
      chatId: this.chatId,
      ...(error ? { error } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
    }
    this.options.onLogEntry?.({
      type: 'result',
      subtype: success ? 'success' : 'error',
      durationMs: Date.now() - this.startedAt,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(success && this.options.fastMode ? { fastModeState: 'requested' } : {}),
      ts: Date.now(),
    })
    this.input?.end()
  }

  receive(line: string): void {
    if (this.result) return
    let message: JsonObject
    try {
      message = object(JSON.parse(line))
    } catch {
      return
    }
    if ('id' in message && typeof message.method === 'string') {
      // Headless runs never prompt for approvals or collect interactive answers.
      this.send({
        id: message.id,
        error: { code: -32601, message: 'Interactive requests are unavailable in an a2wave run' },
      })
      this.finish(false, `Codex requested unsupported interaction: ${message.method}`)
      return
    }
    if ('id' in message) {
      if (message.id !== this.pendingRequest) return
      if (message.error) {
        this.finish(false, errorMessage(message.error) ?? 'Codex app-server request failed')
        return
      }
      if (!('result' in message)) return
      this.handleResponse(object(message.result))
      return
    }
    const params = object(message.params)
    if (typeof params.threadId === 'string' && this.chatId && params.threadId !== this.chatId)
      return
    if (typeof params.turnId === 'string' && this.turnId && params.turnId !== this.turnId) return
    switch (message.method) {
      case 'turn/started': {
        const id = object(params.turn).id
        if (typeof id === 'string' && this.pendingRequest === 3) this.turnId = id
        break
      }
      case 'item/agentMessage/delta': {
        if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') return
        if (this.completedItems.has(params.itemId)) return
        this.streamedItems.add(params.itemId)
        this.messages.set(params.itemId, (this.messages.get(params.itemId) ?? '') + params.delta)
        this.options.onUpdate?.(this.output())
        this.options.onLogEntry?.({
          type: 'assistant',
          text: params.delta,
          partial: true,
          ts: Date.now(),
        })
        break
      }
      case 'item/started':
      case 'item/completed':
        this.handleItem(object(params.item), message.method === 'item/completed')
        break
      case 'thread/tokenUsage/updated': {
        // Resume replays the previous turn's usage before the new turn starts.
        if (!this.turnId) break
        const tokenUsage = object(params.tokenUsage)
        const last = object(tokenUsage.last)
        const total = object(tokenUsage.total)
        // A tool loop contains several model calls. `last` is only one call;
        // subtract the history preceding its first update from cumulative totals.
        // This also makes repeated notifications idempotent on resumed threads.
        const current: Record<string, number> = {}
        const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']
        if (typeof total.inputTokens === 'number') {
          if (!this.usageBaseline) {
            this.usageBaseline = {}
            for (const key of fields) {
              if (typeof total[key] === 'number')
                this.usageBaseline[key] = Math.max(
                  0,
                  total[key] - (typeof last[key] === 'number' ? last[key] : 0),
                )
            }
          }
          for (const key of fields) {
            if (typeof total[key] === 'number')
              current[key] = Math.max(0, total[key] - (this.usageBaseline[key] ?? 0))
          }
        } else {
          for (const key of fields) if (typeof last[key] === 'number') current[key] = last[key]
        }
        this.usage = mapCodexUsage(current) ?? this.usage
        if (this.usage && typeof current.reasoningOutputTokens === 'number') {
          this.usage.reasoningTokens = current.reasoningOutputTokens
        }
        break
      }
      case 'turn/completed': {
        const turn = object(params.turn)
        if (this.turnId && typeof turn.id === 'string' && turn.id !== this.turnId) return
        const info = object(turn.error).codexErrorInfo
        this.authenticationFailed =
          info === 'unauthorized' ||
          Object.values(object(info)).some((value) => object(value).httpStatusCode === 401)
        const success = turn.status === 'completed'
        this.finish(
          success,
          success
            ? undefined
            : (errorMessage(turn.error) ?? `Codex turn ${String(turn.status ?? 'failed')}`),
        )
        break
      }
      case 'error':
        // Recoverable transport errors may be followed by a successful retry.
        this.options.onLogEntry?.({
          type: 'error',
          message: errorMessage(params.error) ?? 'Codex app-server error',
          ts: Date.now(),
        })
        break
    }
  }

  private handleResponse(result: JsonObject): void {
    if (this.pendingRequest === 1) {
      this.send({ method: 'initialized' })
      this.pendingRequest = 2
      this.send({
        id: 2,
        method: this.chatId ? 'thread/resume' : 'thread/start',
        params: {
          ...(this.chatId ? { threadId: this.chatId } : {}),
          model: this.options.model,
          modelProvider: 'openai_chatgpt_plan',
          cwd: this.options.cwd,
          approvalPolicy: 'never',
          sandbox: this.options.sandbox,
        },
      })
    } else if (this.pendingRequest === 2) {
      const threadId = object(result.thread).id
      if (typeof threadId !== 'string' || !threadId) {
        this.finish(false, 'Codex app-server returned no thread ID')
        return
      }
      this.chatId = threadId
      this.options.onLogEntry?.({
        type: 'system',
        subtype: 'init',
        model: this.options.model,
        ts: Date.now(),
      })
      this.pendingRequest = 3
      this.send({
        id: 3,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: this.options.prompt, text_elements: [] }],
          ...(this.options.reasoningEffort ? { effort: this.options.reasoningEffort } : {}),
          ...(this.options.fastMode ? { serviceTier: 'priority' } : {}),
        },
      })
    } else if (this.pendingRequest === 3) {
      const turnId = object(result.turn).id
      if (typeof turnId === 'string') this.turnId = turnId
      this.pendingRequest = 0
    }
  }

  private handleItem(item: JsonObject, completed: boolean): void {
    if (item.type === 'agentMessage') {
      if (!completed || typeof item.id !== 'string' || typeof item.text !== 'string') return
      if (this.completedItems.has(item.id)) return
      this.completedItems.add(item.id)
      this.messages.set(item.id, item.text)
      this.options.onUpdate?.(this.output())
      if (!this.streamedItems.has(item.id)) {
        this.options.onLogEntry?.({ type: 'assistant', text: item.text, ts: Date.now() })
      }
      return
    }
    const types: Record<string, string> = {
      commandExecution: 'command_execution',
      mcpToolCall: 'mcp_tool_call',
      fileChange: 'file_change',
      webSearch: 'web_search',
      plan: 'plan_update',
    }
    const mappedType = types[String(item.type)]
    if (!mappedType) return
    const parsed = parseCodexStreamLine(
      JSON.stringify({
        type: completed ? 'item.completed' : 'item.started',
        item: {
          ...item,
          type: mappedType,
          exit_code: item.exitCode,
          aggregated_output:
            item.aggregatedOutput ?? (item.result ? JSON.stringify(item.result) : undefined),
          error: errorMessage(item.error),
        },
      }),
    )
    for (const event of parsed.events) {
      if (event.kind !== 'tool_call') continue
      const { kind: _kind, ...entry } = event
      this.options.onLogEntry?.({ type: 'tool_call', ...entry, ts: Date.now() })
      if (completed) this.options.onToolSettled?.(event.callId)
      else this.options.onToolStarted?.(event.callId, event.toolName)
    }
  }
}
