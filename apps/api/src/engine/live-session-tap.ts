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
  const runId = extractRunId(taskId)
  // Evaluation replays (`eval/<task>/<case>/<seq>`) and memory tasks
  // (`mem_<agent>_<ts>_<seq>`) own no run row, and extractRunId falls back to
  // returning the whole task id rather than failing. Without this guard each
  // would issue a SELECT that can never match — per line, since OpenCode
  // repeats its session id on every event it emits.
  if (!runId.startsWith('run_')) return onStdoutLine

  const record = createLiveSessionRecorder({
    runId,
    // Imported lazily so the engine layer does not open a database connection
    // at module load; engines are constructed in contexts (version probes,
    // model listing) that legitimately have no database.
    persist: async (runId, sessionId) => {
      const { persistLiveSessionId } = await import('../lib/persist-live-session-id.js')
      // Return the verdict rather than swallowing it: false means the run row
      // is gone, which is what lets the recorder stand down.
      return await persistLiveSessionId(runId, sessionId)
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
