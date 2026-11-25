import { describe, expect, it } from 'vitest'
import { normalizeFeishuConfig } from '../feishu-config.js'

describe('normalizeFeishuConfig topic settings', () => {
  it('uses safe defaults for legacy configs', async () => {
    const config = normalizeFeishuConfig({ appId: 'cli_x', appSecret: 'secret' })

    expect(config.topicInjectRootMessage).toBe(false)
    expect(config.topicReplyMentionTarget).toBe('trigger_sender')
  })

  it.each(['trigger_sender', 'topic_creator', 'none'] as const)(
    'preserves topicReplyMentionTarget=%s',
    (topicReplyMentionTarget) => {
      const config = normalizeFeishuConfig({
        appId: 'cli_x',
        appSecret: 'secret',
        topicReplyMentionTarget,
      })

      expect(config.topicReplyMentionTarget).toBe(topicReplyMentionTarget)
    },
  )

  it('falls back when topicReplyMentionTarget is invalid', async () => {
    const config = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 'secret',
      topicReplyMentionTarget: 'second_mention',
    })

    expect(config.topicReplyMentionTarget).toBe('trigger_sender')
  })

  it('preserves an explicit boolean opt-in', async () => {
    const config = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 'secret',
      topicInjectRootMessage: true,
    })

    expect(config.topicInjectRootMessage).toBe(true)
  })

  it('rejects non-boolean persisted values', async () => {
    const config = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 'secret',
      topicInjectRootMessage: 'yes',
    })

    expect(config.topicInjectRootMessage).toBe(false)
  })
})

describe('normalizeFeishuConfig', () => {
  it('migrates legacy trigger and reply options', () => {
    const legacy = {
      appId: 'cli_x',
      appSecret: 's',
      triggerOnAt: true,
      triggerOnNewMessage: true,
      replyMode: 'new',
      replyContentType: 'post',
      sendArtifactsAsFile: false,
    }
    const result = normalizeFeishuConfig(legacy)
    expect(result.groupTriggerOnAt).toBe(true)
    expect(result.groupTriggerOnNewMessage).toBe(true)
    expect(result.groupReplyMode).toBe('new')
    expect(result.topicTriggerOnAt).toBe(true)
    expect(result.topicTriggerOnNewTopic).toBe(false)
    expect(result.topicTriggerOnNewComment).toBe(false)
    expect(result.topicReplyMode).toBe('topic_reply')
    expect(result.p2pReplyMode).toBe('new') // legacy replyMode → p2pReplyMode
    expect(result.replyContentType).toBe('post')
    expect(result.sendArtifactsAsFile).toBe(false)
  })

  it('defaults legacy direct message replies to quote', () => {
    const result = normalizeFeishuConfig({ appId: 'cli_x', appSecret: 's' })
    expect(result.p2pReplyMode).toBe('quote')
    expect(result.groupInjectReferencedMessage).toBe(false)
  })

  it('preserves an explicitly enabled regular-group referenced-message setting', () => {
    const result = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 's',
      groupInjectReferencedMessage: true,
    })
    expect(result.groupInjectReferencedMessage).toBe(true)
  })

  it('prefers the explicit direct message reply mode', () => {
    const result = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 's',
      replyMode: 'new', // legacy
      p2pReplyMode: 'none', // explicit
    })
    expect(result.p2pReplyMode).toBe('none')
  })

  it('preserves explicit group and topic configuration', () => {
    const config = {
      appId: 'cli_test',
      appSecret: 'secret_test',
      groupTriggerOnAt: true,
      groupTriggerOnNewMessage: false,
      groupReplyMode: 'quote',
      topicTriggerOnAt: true,
      topicTriggerOnNewTopic: false,
      topicTriggerOnNewComment: false,
      topicReplyMode: 'topic_reply',
      p2pReplyMode: 'quote',
    }
    const result = normalizeFeishuConfig(config)
    expect(result).toMatchObject(config)
    expect(result.replyContentType).toBe('text')
    expect(result.sendArtifactsAsFile).toBe(true)
    expect(result.fetchUserInfo).toBe(false)
  })

  it('normalizes invalid welcome settings', () => {
    const result = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 's',
      welcomeMessage: 123 as unknown as string,
      welcomeOnP2pEnabled: 'false' as unknown as boolean,
      welcomeP2pIdleDays: -5,
      welcomeOnGroupAddedEnabled: true,
    })
    expect(result.welcomeMessage).toBeUndefined()
    expect(result.welcomeOnP2pEnabled).toBe(false)
    expect(result.welcomeP2pIdleDays).toBeUndefined()
    expect(result.welcomeOnGroupAddedEnabled).toBe(true)
  })

  it('preserves valid welcome settings, including zero idle days', () => {
    const result = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 's',
      welcomeMessage: 'hi',
      welcomeOnP2pEnabled: true,
      welcomeP2pIdleDays: 0,
      welcomeOnGroupAddedEnabled: false,
    })
    expect(result.welcomeMessage).toBe('hi')
    expect(result.welcomeOnP2pEnabled).toBe(true)
    expect(result.welcomeP2pIdleDays).toBe(0)
    expect(result.welcomeOnGroupAddedEnabled).toBe(false)
  })

  it('fills in missing legacy settings', () => {
    const minimal = { appId: 'cli_x', appSecret: 's' }
    const result = normalizeFeishuConfig(minimal)
    expect(result.groupTriggerOnAt).toBe(true)
    expect(result.groupTriggerOnNewMessage).toBe(false)
    expect(result.groupReplyMode).toBe('quote')
  })

  it('fills in missing fields in a partial configuration', () => {
    const partial = { appId: 'cli_x', appSecret: 's', groupTriggerOnAt: false }
    const result = normalizeFeishuConfig(partial)
    expect(result.groupTriggerOnAt).toBe(false)
    expect(result.groupTriggerOnNewMessage).toBe(false)
    expect(result.groupReplyMode).toBe('quote')
    expect(result.topicTriggerOnAt).toBe(true)
    expect(result.topicTriggerOnNewTopic).toBe(false)
    expect(result.topicTriggerOnNewComment).toBe(false)
    expect(result.topicReplyMode).toBe('topic_reply')
  })
})
