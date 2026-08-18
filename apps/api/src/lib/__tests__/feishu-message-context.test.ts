import { describe, expect, it } from 'vitest'

import {
  buildTriggerSessionId,
  P2P_SESSION_TIMEOUT_MS,
  resolveSessionTimeoutMs,
} from '../feishu-message-context.js'

/**
 * The timeout rule and the session-key rule have to agree about `root_id`.
 *
 * Regression: they did not. `buildTriggerSessionId` returns `chat_id` for a
 * direct message and never looks at `root_id`, but the timeout switch granted
 * `Number.POSITIVE_INFINITY` to any message carrying one. A quoted reply in a
 * direct message therefore did not open a side line — it removed the expiry
 * from the single line the chat has, resurrecting a three-day-old session.
 */
describe('resolveSessionTimeoutMs', () => {
  it('caps a quoted reply in a direct message at the P2P timeout', () => {
    expect(resolveSessionTimeoutMs({ chat_type: 'p2p', chat_id: 'oc_1', root_id: 'om_root' })).toBe(
      P2P_SESSION_TIMEOUT_MS,
    )
  })

  it('caps a plain direct message at the P2P timeout', () => {
    expect(resolveSessionTimeoutMs({ chat_type: 'p2p', chat_id: 'oc_1' })).toBe(
      P2P_SESSION_TIMEOUT_MS,
    )
  })

  it('never expires a group reply chain, whose root_id is also its session key', () => {
    expect(resolveSessionTimeoutMs({ chat_type: 'group', root_id: 'om_root' })).toBe(
      Number.POSITIVE_INFINITY,
    )
    // The premise of the exemption: root_id really is the session key here.
    expect(buildTriggerSessionId({ chat_type: 'group', root_id: 'om_root' })).toBe('om_root')
  })

  it('caps a standalone group mention, which anchors on its own message_id', () => {
    expect(resolveSessionTimeoutMs({ chat_type: 'group', message_id: 'om_msg' })).toBe(
      P2P_SESSION_TIMEOUT_MS,
    )
  })

  it('never expires a topic thread', () => {
    expect(resolveSessionTimeoutMs({ chat_type: 'group', thread_id: 'th_1' })).toBe(
      Number.POSITIVE_INFINITY,
    )
  })

  it('never expires a direct message carrying a thread_id, whose session key is that thread', () => {
    expect(resolveSessionTimeoutMs({ chat_type: 'p2p', chat_id: 'oc_1', thread_id: 'th_1' })).toBe(
      Number.POSITIVE_INFINITY,
    )
    expect(buildTriggerSessionId({ chat_type: 'p2p', chat_id: 'oc_1', thread_id: 'th_1' })).toBe(
      'th_1',
    )
  })

  it('is two hours', () => {
    expect(P2P_SESSION_TIMEOUT_MS).toBe(2 * 60 * 60 * 1000)
  })
})
