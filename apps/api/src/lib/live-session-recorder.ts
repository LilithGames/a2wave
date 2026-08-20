import { extractLiveSessionId } from '../engine/live-session-id.js'
import { logger } from './logger.js'

export interface LiveSessionRecorderOptions {
  runId: string
  persist: (runId: string, sessionId: string) => Promise<void>
}

/**
 * Durably record a run's provider session id the moment the CLI announces it.
 *
 * Until now the id only reached the database via the success path, so a run
 * killed mid-flight — the one case that needs to resume — was the one case
 * that lost it. This runs per stdout line, so it must stay cheap: after the
 * first successful write the common path is a string compare.
 */
export function createLiveSessionRecorder(
  options: LiveSessionRecorderOptions,
): (line: string) => Promise<void> {
  const { runId, persist } = options
  let recorded: string | null = null

  return async (line: string): Promise<void> => {
    const sessionId = extractLiveSessionId(line)
    // Every subsequent line repeats the id; only a change is worth a write.
    // A change is real on provider fallback, where the new CLI opens its own
    // session and the old id would resume nothing.
    if (!sessionId || sessionId === recorded) return

    try {
      await persist(runId, sessionId)
      recorded = sessionId
    } catch (error) {
      // Losing this write costs resumability, not correctness — the run itself
      // must survive. `recorded` stays unset so the next line retries.
      logger.warn({ error, runId }, 'live-session-recorder: could not persist session id')
    }
  }
}
