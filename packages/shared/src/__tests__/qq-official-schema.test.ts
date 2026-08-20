import { describe, expect, it } from 'vitest'
import { runChannelContextSchema } from '../schemas/run-channel.js'

describe('QQ Official run channel context', () => {
  it('accepts a group message context without inventing an email identity', () => {
    expect(
      runChannelContextSchema.parse({
        channel_type: 'qq_official',
        channel_info: {
          app_id: '102000000',
          scene: 'group',
          message_id: 'msg-1',
          sender_open_id: 'member-open-id',
          member_openid: 'member-open-id',
          username: 'Alice',
          group_open_id: 'group-open-id',
        },
        user_info: null,
      }),
    ).toMatchObject({
      channel_type: 'qq_official',
      channel_info: {
        scene: 'group',
        group_open_id: 'group-open-id',
        member_openid: 'member-open-id',
        username: 'Alice',
      },
    })
  })

  it('rejects a group context without a group open id', () => {
    expect(
      runChannelContextSchema.safeParse({
        channel_type: 'qq_official',
        channel_info: {
          app_id: '102000000',
          scene: 'group',
          message_id: 'msg-1',
          sender_open_id: 'member-open-id',
        },
        user_info: null,
      }).success,
    ).toBe(false)
  })

  it.each(['guild', 'guild_dm'])('rejects the unsupported %s scene', (scene) => {
    expect(
      runChannelContextSchema.safeParse({
        channel_type: 'qq_official',
        channel_info: {
          app_id: '102000000',
          scene,
          message_id: 'msg-1',
          sender_open_id: 'member-open-id',
          channel_id: 'channel-open-id',
          guild_id: 'guild-open-id',
        },
        user_info: null,
      }).success,
    ).toBe(false)
  })
})
