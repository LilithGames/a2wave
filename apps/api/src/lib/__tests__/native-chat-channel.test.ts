import { describe, expect, it } from 'vitest'
import { isNativeChatChannel } from '../native-chat-channel.js'

describe('isNativeChatChannel', () => {
  it.each(['slack', 'discord', 'qq_official'])('recognizes %s', (channel) => {
    expect(isNativeChatChannel(channel)).toBe(true)
  })

  it.each(['feishu', 'api', undefined])('rejects %s', (channel) => {
    expect(isNativeChatChannel(channel)).toBe(false)
  })
})
