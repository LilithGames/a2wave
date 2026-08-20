import { createLiveSessionRecorder } from '../lib/live-session-recorder.js'
import { extractRunId } from './runtime-context.js'

/**
 * Wrap an engine's stdout-line handler so the run's session id is recorded.
 *
 * Placed at the shared `runCliStream` seam rather than in each engine: every
 * CLI engine funnels through it, so one tap covers all providers and a newly
 * added engine cannot forget to opt in.
 */
export function tapLiveSessionId(
  taskId: string,
  onStdoutLine: (line: string) => void,
): (line: string) => void {
  const record = createLiveSessionRecorder({
    runId: extractRunId(taskId),
    // Imported lazily so the engine layer does not open a database connection
    // at module load; engines are constructed in contexts (version probes,
    // model listing) that legitimately have no database.
    persist: async (runId, sessionId) => {
      const { persistLiveSessionId } = await import('../lib/persist-live-session-id.js')
      await persistLiveSessionId(runId, sessionId)
    },
  })

  return (line: string): void => {
    // Parsing stays synchronous and first: the recorder is a side channel and
    // must never delay — or drop — the output the run itself depends on.
    onStdoutLine(line)
    // Fire-and-forget. The recorder swallows its own failures; this catch is
    // belt-and-braces so a rejection can never surface as an unhandled one.
    void record(line).catch(() => {})
  }
}
