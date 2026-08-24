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

  const markStarted = async (runId: string): Promise<void> => {
    const { markExecutionStarted } = await import('../lib/persist-live-session-id.js')
    await markExecutionStarted(runId)
  }

  // Set once the recorder has written a session id, which already implies the
  // run started — persistLiveSessionId sets both fields in one merge.
  let sessionRecorded = false

  const record = createLiveSessionRecorder({
    runId,
    // Imported lazily so the engine layer does not open a database connection
    // at module load; engines are constructed in contexts (version probes,
    // model listing) that legitimately have no database.
    persist: async (runId, sessionId) => {
      const { persistLiveSessionId } = await import('../lib/persist-live-session-id.js')
      // Return the verdict rather than swallowing it: false means the run row
      // is gone, which is what lets the recorder stand down.
      const written = await persistLiveSessionId(runId, sessionId)
      if (written) sessionRecorded = true
      return written
    },
  })

  // Written once, on the first line the CLI emits — the earliest proof this run
  // can have committed side effects, and what lets recovery restart a run killed
  // during setup without risking a replay of work already done. Shares the
  // recorder's single lazy import so the engine layer still opens no database
  // connection at module load.
  let startMarked = false

  return (line: string): void => {
    // Parsing stays synchronous and first: the recorder is a side channel and
    // must never delay — or drop — the output the run itself depends on.
    onStdoutLine(line)
    // Fire-and-forget. The recorder swallows its own failures; this catch is
    // belt-and-braces so a rejection can never surface as an unhandled one.
    void record(line)
      .then(() => {
        // Only when the recorder did not already write it: persistLiveSessionId
        // sets both fields in one merge, and a second concurrent merge on the
        // same row buys nothing but contention.
        if (startMarked || sessionRecorded) return
        startMarked = true
        return markStarted(runId)
      })
      .catch(() => {})
  }
}
