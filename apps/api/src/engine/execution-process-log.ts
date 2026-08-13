import type { StreamLogCallback, StreamLogEntry } from './types.js'

const AGENT_ROUTER_LOG_PREFIX = '[agent-router] '
const ROUTER_EVENT_PATTERN = /^a2a\.task\.[a-z_]+$/
const STRING_FIELD_LIMITS = {
  target: 256,
  taskId: 128,
  contextId: 128,
  state: 64,
} as const

const sinksByTaskId = new Map<string, StreamLogCallback>()

function boundedString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : undefined
}

export function parseAgentRouterProcessLog(line: string): StreamLogEntry | undefined {
  if (!line.startsWith(AGENT_ROUTER_LOG_PREFIX)) return undefined

  try {
    const payload = JSON.parse(line.slice(AGENT_ROUTER_LOG_PREFIX.length)) as Record<
      string,
      unknown
    >
    const subtype = boundedString(payload.event, 128)
    if (!subtype || !ROUTER_EVENT_PATTERN.test(subtype)) return undefined

    const metadata: Record<string, unknown> = {}
    for (const [field, limit] of Object.entries(STRING_FIELD_LIMITS)) {
      const value = boundedString(payload[field], limit)
      if (value) metadata[field] = value
    }
    if (typeof payload.attempt === 'number' && Number.isSafeInteger(payload.attempt)) {
      metadata.attempt = payload.attempt
    }

    return {
      type: 'system',
      subtype,
      ...(Object.keys(metadata).length > 0 && { metadata }),
      ts: Date.now(),
    }
  } catch {
    return undefined
  }
}

export function registerExecutionProcessLogSink(
  taskId: string,
  sink: StreamLogCallback | undefined,
): () => void {
  if (!sink) return () => undefined
  sinksByTaskId.set(taskId, sink)
  return () => {
    if (sinksByTaskId.get(taskId) === sink) sinksByTaskId.delete(taskId)
  }
}

export function emitExecutionProcessLogLine(taskId: string, line: string): void {
  const sink = sinksByTaskId.get(taskId)
  if (!sink) return
  const entry = parseAgentRouterProcessLog(line)
  if (entry) sink(entry)
}

export function _resetExecutionProcessLogSinksForTests(): void {
  sinksByTaskId.clear()
}
