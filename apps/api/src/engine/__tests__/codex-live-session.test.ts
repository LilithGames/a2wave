import { describe, expect, it } from 'vitest'
import { extractLiveSessionId } from '../live-session-id.js'

describe('Codex app-server recovery session', () => {
  it('records only the primary thread/start or thread/resume RPC response', () => {
    expect(
      extractLiveSessionId(JSON.stringify({ id: 2, result: { thread: { id: 'thread-a' } } })),
    ).toBe('thread-a')
  })
  it.each([
    { method: 'thread/started', params: { thread: { id: 'child-thread' } } },
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 'child-thread', itemId: 'child-item', delta: 'hi' },
    },
  ])('does not overwrite the primary session with child-agent notifications', (event) => {
    expect(extractLiveSessionId(JSON.stringify(event))).toBeNull()
  })
  it('does not mistake turn or item identifiers for the recoverable thread', () => {
    expect(
      extractLiveSessionId(JSON.stringify({ id: 3, result: { turn: { id: 'turn-a' } } })),
    ).toBeNull()
    expect(
      extractLiveSessionId(
        JSON.stringify({ method: 'item/completed', params: { item: { id: 'item-a' } } }),
      ),
    ).toBeNull()
  })
})
