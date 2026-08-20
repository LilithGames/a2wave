import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { createLiveSessionRecorder } from '../live-session-recorder.js'

/**
 * The recorder sits on the hot stream path, so it must write once and then get
 * out of the way: the session id is announced early and never changes for the
 * life of a run.
 */
describe('createLiveSessionRecorder', () => {
  let persist: Mock<(runId: string, sessionId: string) => Promise<void>>

  beforeEach(() => {
    persist = vi
      .fn<(runId: string, sessionId: string) => Promise<void>>()
      .mockResolvedValue(undefined)
  })

  it('persists the session id on the line that first carries it', async () => {
    const record = createLiveSessionRecorder({ runId: 'run_1', persist })
    await record(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_a' }))
    expect(persist).toHaveBeenCalledWith('run_1', 'sess_a')
  })

  it('ignores lines with no session id', async () => {
    const record = createLiveSessionRecorder({ runId: 'run_1', persist })
    await record('Loading...')
    await record(JSON.stringify({ type: 'assistant', text: 'hi' }))
    expect(persist).not.toHaveBeenCalled()
  })

  it('writes only once even though every later line repeats the id', async () => {
    const record = createLiveSessionRecorder({ runId: 'run_1', persist })
    const line = JSON.stringify({ session_id: 'sess_a' })
    await record(line)
    await record(line)
    await record(line)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('records a genuinely new session id, so a provider fallback is resumable', async () => {
    // A fallback provider starts a fresh session; resuming the dead provider's
    // id would target a session the new CLI has never heard of.
    const record = createLiveSessionRecorder({ runId: 'run_1', persist })
    await record(JSON.stringify({ session_id: 'sess_a' }))
    await record(JSON.stringify({ session_id: 'sess_b' }))
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenLastCalledWith('run_1', 'sess_b')
  })

  it('never rejects: a failed write must not kill the run it is protecting', async () => {
    persist.mockRejectedValue(new Error('database is locked'))
    const record = createLiveSessionRecorder({ runId: 'run_1', persist })
    await expect(record(JSON.stringify({ session_id: 'sess_a' }))).resolves.toBeUndefined()
  })

  it('retries on the next line after a failed write', async () => {
    persist.mockRejectedValueOnce(new Error('database is locked')).mockResolvedValue(undefined)
    const record = createLiveSessionRecorder({ runId: 'run_1', persist })
    const line = JSON.stringify({ session_id: 'sess_a' })
    await record(line)
    await record(line)
    expect(persist).toHaveBeenCalledTimes(2)
  })
})
