import { describe, expect, it } from 'vitest'
import { runChannelContextSchema } from '../schemas/run-channel.js'

describe('Feishu run channel metadata', () => {
  it('preserves the group name and reply metadata', () => {
    const parsed = runChannelContextSchema.parse({
      channel_type: 'feishu',
      channel_info: {
        app_id: 'cli_test',
        chat_id: 'oc_chat',
        chat_type: 'group',
        chat_name: 'Design Review',
        message_id: 'om_reply',
        parent_id: 'om_parent',
        root_id: 'om_root',
        sender_type: 'user',
      },
      user_info: null,
    })

    expect(parsed.channel_info).toMatchObject({
      chat_name: 'Design Review',
      parent_id: 'om_parent',
      root_id: 'om_root',
    })
  })
})
