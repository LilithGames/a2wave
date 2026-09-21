/**
 * Tool OUTPUT in the normalized stream.
 *
 * A tool call's result is the most useful thing to see when debugging an Agent and the most
 * dangerous thing to keep: it is unbounded (a `cat` of a large file) and routinely sensitive (env
 * dumps, file contents, API responses). So it travels on `tool_call.output` for exactly one
 * consumer — the OpenTelemetry tracer, which exports it only with content capture on, masked and
 * truncated — and is stripped before every other one.
 */
import type { StreamLogEntry } from './types.js'

/** Bound at the source so a huge result is never held per entry; the tracer truncates further. */
export const TOOL_OUTPUT_MAX_CHARS = 8192

export function capToolOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return text
  return `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}… [truncated]`
}

/**
 * Text of a tool result as CLIs report it: a plain string, or a Claude-style content array whose
 * `text` blocks are joined. Non-text blocks (images) are ignored. Undefined when nothing usable.
 */
export function toolResultText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw ? capToolOutput(raw) : undefined
  if (!Array.isArray(raw)) return undefined
  const text = raw
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .filter(Boolean)
    .join('\n')
  return text ? capToolOutput(text) : undefined
}

/** The entry without `output`; the same object when there is nothing to strip. */
export function stripToolOutput(entry: StreamLogEntry): StreamLogEntry {
  if (entry.type !== 'tool_call' || entry.output === undefined) return entry
  const { output: _output, ...rest } = entry
  return rest
}
