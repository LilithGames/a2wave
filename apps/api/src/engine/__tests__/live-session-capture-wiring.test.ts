/**
 * The capture must be wired at the shared engine seam, not per provider.
 *
 * Every CLI engine funnels through `runCliStream`, so tapping the stream there
 * covers Claude Code, Codex, Cursor, Kimi, Pi, OpenCode, Qoder and Trae at
 * once — and cannot be forgotten by the next engine added.
 */
import { describe, expect, it, vi } from 'vitest'

const persistLiveSessionId = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/persist-live-session-id.js', () => ({
  persistLiveSessionId,
  readLiveSessionId: vi.fn(),
  LIVE_CHAT_ID_KEY: 'liveChatId',
}))

const { tapLiveSessionId } = await import('../live-session-tap.js')

describe('tapLiveSessionId', () => {
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

  it('still forwards the line when recording throws', () => {
    persistLiveSessionId.mockRejectedValueOnce(new Error('database is locked'))
    const parsed: string[] = []
    const tapped = tapLiveSessionId('run_y', (line) => parsed.push(line))
    expect(() => tapped(JSON.stringify({ session_id: 'sess_b' }))).not.toThrow()
    expect(parsed).toHaveLength(1)
  })
})
