import { z } from 'zod'

/**
 * Feishu channel config accepted by `POST /agents/:id/publish`.
 *
 * Deliberately its own schema rather than shared's `feishuConfigSchema`: the API must reject
 * values that would break runtime behaviour (a negative `welcomeP2pIdleDays` makes the idle
 * check always fire), while `.passthrough()` keeps legacy fields — `triggerOnAt`,
 * `triggerOnNewMessage`, `replyMode` — accepted from older clients.
 */
export const feishuConfigBodySchema = z
  .object({
    appId: z.string(),
    appSecret: z.string(),
    groupTriggerOnAt: z.boolean().default(true),
    groupTriggerOnNewMessage: z.boolean().default(false),
    groupReplyMode: z.enum(['quote', 'new', 'none']).default('quote'),
    groupInjectReferencedMessage: z.boolean().default(false),
    topicTriggerOnAt: z.boolean().default(true),
    topicTriggerOnNewTopic: z.boolean().default(false),
    topicTriggerOnNewComment: z.boolean().default(false),
    topicReplyMode: z.enum(['topic_reply', 'none']).default('topic_reply'),
    p2pReplyMode: z.enum(['quote', 'new', 'none']).default('quote'),
    replyContentType: z
      .enum(['text', 'post', 'interactive', 'interactive_card', 'streaming_card'])
      .default('text'),
    cardTemplateId: z.string().optional(),
    // 调试信息开关：与 shared 的 feishuConfigSchema 对齐，避免 API 直接写入非布尔值绕过校验。
    debugShowSessionId: z.boolean().default(false),
    debugShowProvider: z.boolean().default(false),
    debugShowModel: z.boolean().default(false),
    sendArtifactsAsFile: z.boolean().default(true),
    fetchUserInfo: z.boolean().default(false),
    // 开场白：与 shared 的 feishuConfigSchema 约束对齐，避免 API 直接写入非法
    // welcomeP2pIdleDays（负数/字符串会让空闲判定失效 → 每次进入都发）
    welcomeMessage: z.string().max(5000).optional(),
    welcomeOnP2pEnabled: z.boolean().default(false),
    welcomeP2pIdleDays: z.number().int().min(0).default(7),
    welcomeOnGroupAddedEnabled: z.boolean().default(false),
  })
  .passthrough() // 允许旧字段 triggerOnAt / triggerOnNewMessage / replyMode 通过校验
