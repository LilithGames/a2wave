/**
 * Recover the provider session id from a raw CLI stream line.
 *
 * Every supported CLI announces its session on the first line or two of
 * output, but each spells it differently. Engines already track it in a local
 * for the success result; this reads the same fact early enough that a run
 * killed mid-flight can still be resumed.
 *
 * Covers Claude Code, Codex, Cursor, Kimi, Pi, OpenCode, Qoder and Trae.
 */

/**
 * Ids that only mean "session" on a specific line type.
 *
 * `id` is the whole reason this table exists: Pi announces its session as
 * `{type:'session', id}` (`pi-stream-parser.ts`), but `id` labels tool calls,
 * messages and events everywhere else, so reading it unconditionally would
 * store the first random identifier the CLI printed.
 */
const TYPE_SCOPED_SESSION_KEYS: Record<string, string> = {
  session: 'id', // Pi
  'thread.started': 'thread_id', // Codex
}

/**
 * Ids that identify a session on any line.
 *
 * Ordered by specificity. A line may carry more than one — a proxied envelope
 * can hold an outer `session_id` beside an inner `thread_id` — so the
 * type-scoped table above is consulted first and decides those cases by
 * meaning rather than by position here.
 */
const GLOBAL_SESSION_KEYS = [
  'session_id', // Claude Code, Cursor, Kimi, Qoder, Trae
  'chat_id', // Claude Code (alternate)
  'sessionID', // OpenCode
  'sessionId',
] as const

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  // An empty or non-string id would be persisted as a resume target the CLI
  // cannot honour, which fails the next turn instead of continuing it.
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function extractLiveSessionId(line: string): string | null {
  const trimmed = line.trim()
  // CLIs interleave plain-text banners with the JSON stream; a non-JSON line
  // is normal traffic, not an error.
  if (!trimmed.startsWith('{')) return null

  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null

  const record = data as Record<string, unknown>

  const type = record.type
  if (typeof type === 'string') {
    const scopedKey = TYPE_SCOPED_SESSION_KEYS[type]
    if (scopedKey) {
      const scoped = readStringField(record, scopedKey)
      if (scoped) return scoped
    }
  }

  for (const key of GLOBAL_SESSION_KEYS) {
    const value = readStringField(record, key)
    if (value) return value
  }
  return null
}
