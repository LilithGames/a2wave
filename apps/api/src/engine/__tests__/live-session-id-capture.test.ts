import { describe, expect, it } from 'vitest'
import { extractLiveSessionId } from '../live-session-id.js'

/**
 * A run killed mid-flight must still know which provider session to resume.
 *
 * The session id arrives on the CLI's first stream line, but before this it
 * only reached the database through the success path — so the one case that
 * needs it (a crash) was the one case that lost it.
 */
describe('extractLiveSessionId', () => {
  it('reads session_id from a Claude Code init line', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_abc' })
    expect(extractLiveSessionId(line)).toBe('sess_abc')
  })

  it('accepts chat_id as the alternate Claude Code spelling', () => {
    const line = JSON.stringify({ type: 'system', chat_id: 'chat_xyz' })
    expect(extractLiveSessionId(line)).toBe('chat_xyz')
  })

  it('reads the Codex thread id from thread.started', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'th_123' })
    expect(extractLiveSessionId(line)).toBe('th_123')
  })

  it('reads the OpenCode sessionID spelling', () => {
    const line = JSON.stringify({ sessionID: 'oc_77' })
    expect(extractLiveSessionId(line)).toBe('oc_77')
  })

  it('returns null for a line carrying no session id', () => {
    expect(extractLiveSessionId(JSON.stringify({ type: 'assistant', text: 'hi' }))).toBeNull()
  })

  it('returns null for non-JSON output rather than throwing', () => {
    expect(extractLiveSessionId('Loading model...')).toBeNull()
  })

  it('ignores an empty session id instead of persisting a blank resume target', () => {
    expect(extractLiveSessionId(JSON.stringify({ session_id: '' }))).toBeNull()
  })

  it('ignores a non-string session id', () => {
    expect(extractLiveSessionId(JSON.stringify({ session_id: 42 }))).toBeNull()
  })
})
