import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({ db: {} }))

import { resolveRerunContext } from '../rerun-builder.js'

describe('resolveRerunContext', () => {
  it('uses the current queued Feishu context and adds a durable reply target', () => {
    const currentContext = {
      channel: {
        channel_type: 'feishu',
        channel_info: { chat_id: 'oc_current' },
      },
      referenced_message: { text: 'Current alert' },
    }
    const previousStepContext = {
      channel: {
        channel_type: 'feishu',
        channel_info: { chat_id: 'oc_previous' },
      },
      referenced_message: { text: 'Previous alert' },
    }

    expect(
      resolveRerunContext(
        {
          triggerSource: 'feishu',
          executionMetadata: { queuedTurn: true, nativeChatContext: currentContext },
        } as never,
        previousStepContext,
      ),
    ).toEqual({
      ...currentContext,
      receive_id_type: 'chat_id',
      receive_id: 'oc_current',
    })
  })

  it('adds the Feishu reply target to a completed step context', () => {
    const stepContext = {
      channel: {
        channel_type: 'feishu',
        channel_info: { chat_id: 'oc_alerts' },
      },
      referenced_message: { text: 'Payment dependency timed out.' },
    }

    expect(
      resolveRerunContext(
        { triggerSource: 'feishu', executionMetadata: null } as never,
        stepContext,
      ),
    ).toEqual({
      ...stepContext,
      receive_id_type: 'chat_id',
      receive_id: 'oc_alerts',
    })
  })
})
