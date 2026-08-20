/**
 * Recover the provider session id from a raw CLI stream line.
 *
 * Every supported CLI announces its session on the first line or two of
 * output, but each spells it differently. Engines already track it in a local
 * for the success result; this reads the same fact early enough that a run
 * killed mid-flight can still be resumed.
 */

/** Session-id spellings across the supported provider CLIs. */
const SESSION_ID_KEYS = [
  'session_id', // Claude Code
  'chat_id', // Claude Code (alternate)
  'thread_id', // Codex (thread.started)
  'sessionID', // OpenCode
  'sessionId',
] as const

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
  for (const key of SESSION_ID_KEYS) {
    const value = record[key]
    // An empty or non-string id would be persisted as a resume target the CLI
    // cannot honour, which fails the next turn instead of continuing it.
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}
