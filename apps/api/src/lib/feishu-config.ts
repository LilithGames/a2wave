import type { FeishuConfig } from '@a2wave/shared'

export type NormalizedFeishuConfig = FeishuConfig & {
  groupTriggerOnAt: boolean
  groupTriggerOnNewMessage: boolean
  groupReplyMode: 'quote' | 'new' | 'none'
  groupInjectReferencedMessage: boolean
  topicTriggerOnAt: boolean
  topicTriggerOnNewTopic: boolean
  topicTriggerOnNewComment: boolean
  topicReplyMode: 'topic_reply' | 'none'
  topicReplyMentionTarget: 'trigger_sender' | 'topic_creator' | 'none'
  topicInjectRootMessage: boolean
  p2pReplyMode: 'quote' | 'new' | 'none'
  replyContentType: 'text' | 'post' | 'interactive' | 'interactive_card' | 'streaming_card'
  debugShowSessionId: boolean
  debugShowProvider: boolean
  debugShowModel: boolean
  sendArtifactsAsFile: boolean
  fetchUserInfo: boolean
}

/** Normalize persisted legacy Feishu settings before runtime use. */
export function normalizeFeishuConfig(raw: Record<string, unknown>): NormalizedFeishuConfig {
  const legacyTriggerOnAt = raw.triggerOnAt ?? true
  const legacyReplyMode = raw.replyMode ?? 'quote'

  return {
    appId: raw.appId,
    appSecret: raw.appSecret,
    groupTriggerOnAt: raw.groupTriggerOnAt ?? legacyTriggerOnAt,
    groupTriggerOnNewMessage: raw.groupTriggerOnNewMessage ?? raw.triggerOnNewMessage ?? false,
    groupReplyMode: raw.groupReplyMode ?? legacyReplyMode,
    groupInjectReferencedMessage: raw.groupInjectReferencedMessage === true,
    topicTriggerOnAt: raw.topicTriggerOnAt ?? legacyTriggerOnAt,
    topicTriggerOnNewTopic: raw.topicTriggerOnNewTopic ?? false,
    topicTriggerOnNewComment: raw.topicTriggerOnNewComment ?? false,
    topicReplyMode: raw.topicReplyMode ?? 'topic_reply',
    topicReplyMentionTarget:
      raw.topicReplyMentionTarget === 'topic_creator' || raw.topicReplyMentionTarget === 'none'
        ? raw.topicReplyMentionTarget
        : 'trigger_sender',
    topicInjectRootMessage: raw.topicInjectRootMessage === true,
    p2pReplyMode: raw.p2pReplyMode ?? legacyReplyMode,
    replyContentType: raw.replyContentType ?? 'text',
    cardTemplateId: raw.cardTemplateId,
    debugShowSessionId: raw.debugShowSessionId === true,
    debugShowProvider: raw.debugShowProvider === true,
    debugShowModel: raw.debugShowModel === true,
    sendArtifactsAsFile: raw.sendArtifactsAsFile ?? true,
    fetchUserInfo: raw.fetchUserInfo ?? false,
    welcomeMessage: typeof raw.welcomeMessage === 'string' ? raw.welcomeMessage : undefined,
    welcomeOnP2pEnabled: raw.welcomeOnP2pEnabled === true,
    welcomeP2pIdleDays:
      typeof raw.welcomeP2pIdleDays === 'number' &&
      Number.isFinite(raw.welcomeP2pIdleDays) &&
      raw.welcomeP2pIdleDays >= 0
        ? raw.welcomeP2pIdleDays
        : undefined,
    welcomeOnGroupAddedEnabled: raw.welcomeOnGroupAddedEnabled === true,
  } as NormalizedFeishuConfig
}
