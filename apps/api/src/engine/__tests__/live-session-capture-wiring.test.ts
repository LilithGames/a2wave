/**
 * The capture must be wired at the shared engine seam, not per provider.
 *
 * Every CLI engine funnels through `runCliStream`, so tapping the stream there
 * covers Claude Code, Codex, Cursor, Kimi, Pi, OpenCode, Qoder and Trae at
 * once — and cannot be forgotten by the next engine added.
 */
import { describe, expect, it, vi } from 'vitest'

// Resolves true — "the row was found and updated" — so a test that asserts the
// tap stopped querying is proving a latch, not riding on a falsy default.
const persistLiveSessionId = vi.fn().mockResolvedValue(true)
const markExecutionStarted = vi.fn().mockResolvedValue(true)
vi.mock('../../lib/persist-live-session-id.js', () => ({
  persistLiveSessionId,
  markExecutionStarted,
  readLiveSessionId: vi.fn(),
  LIVE_CHAT_ID_KEY: 'liveChatId',
  EXECUTION_STARTED_KEY: 'executionStarted',
}))

const { tapLiveSessionId } = await import('../live-session-tap.js')

describe('tapLiveSessionId', () => {
  // Recovery needs to tell "died during setup" apart from "ran and may have
  // committed side effects". The first line of CLI output is the earliest proof
  // of the latter, and marking it here covers every engine at once.
  it('marks execution as started for a CLI that emits output but no session id', async () => {
    markExecutionStarted.mockClear()
    const tapped = tapLiveSessionId('run_mark/step_1', () => {})
    tapped('Loading...')

    await vi.waitFor(() => expect(markExecutionStarted).toHaveBeenCalledWith('run_mark'))
    expect(markExecutionStarted).toHaveBeenCalledTimes(1)
  })

  it('leaves the marking to persistLiveSessionId once a session is recorded', async () => {
    // persistLiveSessionId writes both fields in one merge, so a second write
    // here would be a concurrent compare-and-set on the same row for no gain.
    markExecutionStarted.mockClear()
    const tapped = tapLiveSessionId('run_sess/step_1', () => {})
    tapped(JSON.stringify({ session_id: 'sess_a' }))

    await vi.waitFor(() => expect(persistLiveSessionId).toHaveBeenCalledWith('run_sess', 'sess_a'))
    expect(markExecutionStarted).not.toHaveBeenCalled()
  })

  it('does not mark a task that owns no run row', async () => {
    markExecutionStarted.mockClear()
    // Evaluation replays and memory tasks own no run; a write here could never
    // match, and would cost one statement per line.
    const tapped = tapLiveSessionId('eval/task_1/case_1/0', () => {})
    tapped(JSON.stringify({ session_id: 'sess_a' }))

    expect(markExecutionStarted).not.toHaveBeenCalled()
  })

  it('forwards every line to the engine parser unchanged', async () => {
    const parsed: string[] = []
    const tapped = tapLiveSessionId('run_x/step_1', (line) => parsed.push(line))
    tapped('Loading...')
    tapped(JSON.stringify({ session_id: 'sess_a' }))
    expect(parsed).toEqual(['Loading...', JSON.stringify({ session_id: 'sess_a' })])
  })

  it('records the session id against the run id embedded in the task id', async () => {
    const tapped = tapLiveSessionId('run_x/step_1', () => {})
    tapped(JSON.stringify({ session_id: 'sess_a' }))
    await vi.waitFor(() => expect(persistLiveSessionId).toHaveBeenCalledWith('run_x', 'sess_a'))
  })

  it('never queries for a task that is not a run', async () => {
    // Evaluation replays (`eval/...`) and memory tasks (`mem_...`) have no
    // run row to update, and OpenCode repeats its session id on every event
    // line — so an unguarded tap issues one wasted SELECT per line of output.
    persistLiveSessionId.mockClear()
    const tapped = tapLiveSessionId('mem_agt_1_123_1', () => {})
    tapped(JSON.stringify({ sessionID: 'oc_1' }))
    tapped(JSON.stringify({ sessionID: 'oc_2' }))
    // Drain the fire-and-forget writes before asserting absence; waitFor would
    // pass on its first tick, before any of them had a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(persistLiveSessionId).not.toHaveBeenCalled()
  })

  it('stops querying once the run row is gone', async () => {
    // The reaper can settle and archive a run while its CLI still streams.
    persistLiveSessionId.mockClear()
    persistLiveSessionId.mockResolvedValue(false)
    const tapped = tapLiveSessionId('run_z_gone', () => {})
    // Distinct ids on purpose: identical ones are deduped by the recorder, so
    // repeating one would pass whether or not the row-gone case latches.
    tapped(JSON.stringify({ sessionID: 'oc_a' }))
    await vi.waitFor(() => expect(persistLiveSessionId).toHaveBeenCalledTimes(1))
    tapped(JSON.stringify({ sessionID: 'oc_b' }))
    tapped(JSON.stringify({ sessionID: 'oc_c' }))
    await vi.waitFor(() => expect(persistLiveSessionId).toHaveBeenCalledTimes(1))
  })

  it('still forwards the line when recording throws', () => {
    persistLiveSessionId.mockRejectedValueOnce(new Error('database is locked'))
    const parsed: string[] = []
    const tapped = tapLiveSessionId('run_y', (line) => parsed.push(line))
    expect(() => tapped(JSON.stringify({ session_id: 'sess_b' }))).not.toThrow()
    expect(parsed).toHaveLength(1)
  })
})
