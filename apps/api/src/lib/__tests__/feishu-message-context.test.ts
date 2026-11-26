import { describe, expect, it } from 'vitest'

import {
  buildTriggerSessionId,
  P2P_SESSION_TIMEOUT_MS,
  quoteAnchorId,
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

describe('buildTriggerSessionId', () => {
  it('prefers the thread id in a threaded direct message', () => {
    expect(
      buildTriggerSessionId({
        thread_id: 'th_001',
        chat_type: 'p2p',
        chat_id: 'oc_chat_001',
      }),
    ).toBe('th_001')
  })

  it('uses the chat id for a direct message without a thread', () => {
    expect(
      buildTriggerSessionId({
        chat_type: 'p2p',
        chat_id: 'oc_chat_001',
      }),
    ).toBe('oc_chat_001')
  })

  it('anchors a standalone group message to its own id', () => {
    expect(
      buildTriggerSessionId({
        chat_type: 'group',
        chat_id: 'oc_group_001',
        message_id: 'om_msg_001',
      }),
    ).toBe('om_msg_001')
  })

  it('anchors a group reply chain to the root', () => {
    expect(
      buildTriggerSessionId({
        chat_type: 'group',
        chat_id: 'oc_group_001',
        root_id: 'om_root_001',
      }),
    ).toBe('om_root_001')
  })

  it('prefers the thread id over the root id in a native topic', () => {
    expect(
      buildTriggerSessionId({
        chat_type: 'group',
        chat_id: 'oc_group_001',
        thread_id: 'th_001',
        root_id: 'om_root_001',
      }),
    ).toBe('th_001')
  })
})

describe('quoteAnchorId', () => {
  it('anchors an ordinary reply to the current message', () => {
    expect(quoteAnchorId({ message_id: 'om_msg_001' })).toBe('om_msg_001')
  })

  it('anchors an interactive card continuation to the original question', () => {
    expect(
      quoteAnchorId({
        message_id: 'om_card_msg_002',
        quote_message_id: 'om_original_001',
      }),
    ).toBe('om_original_001')
  })
})
