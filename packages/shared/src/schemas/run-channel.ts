/**
 * Unified run channel context schema.
 *
 * Every run that triggers an a2wave Agent — regardless of which channel it came in
 * through (OAuth/REST gateway, A2A, Feishu bot, schedule cron, web debug) — writes a
 * `RunChannelContext` blob into both `runSteps.input.context.channel` and the worker
 * payload's `context.channel`. This gives the agent executor and downstream consumers
 * (audit log, sub-agents, debug UI) one consistent shape to read instead of N
 * channel-specific shapes.
 *
 * Three top-level fields:
 *   - `channel_type`: which transport — drives the discriminated union
 *   - `channel_info`: per-channel metadata (auth method, IDs, IPs, native handles)
 *   - `user_info`:   end-user identity normalized to `{ email, name, mobile, source, source_id }`,
 *                    or `null` when the channel can't resolve one (schedule, missing email)
 *
 * Field naming is snake_case throughout so the JSON shape lines up with Feishu's
 * native convention and IDaaS's `user_id`.
 */
import { z } from 'zod'

// ── User info ─────────────────────────────────────────────────────────────────
//
// `email` is the primary cross-channel join key. If a channel can't get it, the
// builder returns `user_info: null` and warns rather than synthesizing a fake one.
export const userInfoSourceEnum = z.enum(['idaas', 'feishu', 'a2wave'])
export type UserInfoSource = z.infer<typeof userInfoSourceEnum>

export const userInfoSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  mobile: z.string().optional(),
  source: userInfoSourceEnum,
  source_id: z.string().optional(),
})
export type UserInfo = z.infer<typeof userInfoSchema>

// ── Channel info: gateway (api + a2a) ─────────────────────────────────────────
export const gatewayAuthEnum = z.enum(['oauth', 'api_key', 'none'])
export type GatewayAuth = z.infer<typeof gatewayAuthEnum>

export const gatewayOauthInfoSchema = z.object({
  issuer: z.string(),
  sub: z.string(),
  tenant_id: z.string().optional(),
  union_id: z.string().optional(),
})
export type GatewayOauthInfo = z.infer<typeof gatewayOauthInfoSchema>

// Feishu app visibility-scope identity — populated only on successful oauth
// visibility check against the agent's feishuConfig app. Downstream code can
// use these IDs to make fine-grained permission calls against Feishu APIs.
export const gatewayFeishuScopeSchema = z.object({
  app_id: z.string(),
  open_id: z.string().optional(),
  user_id: z.string().optional(),
  union_id: z.string().optional(),
})
export type GatewayFeishuScope = z.infer<typeof gatewayFeishuScopeSchema>

export const callerAgentInfoSchema = z.object({
  agent_id: z.string().optional(),
  agent_name: z.string().optional(),
})
export type CallerAgentInfo = z.infer<typeof callerAgentInfoSchema>

export const gatewayChannelInfoSchema = z.object({
  auth: gatewayAuthEnum,
  client_ip: z.string().optional(),
  request_id: z.string().optional(),
  oauth: gatewayOauthInfoSchema.optional(),
  feishu_scope: gatewayFeishuScopeSchema.optional(),
  caller_agent: callerAgentInfoSchema.optional(),
})
export type GatewayChannelInfo = z.infer<typeof gatewayChannelInfoSchema>

// ── Channel info: feishu ──────────────────────────────────────────────────────
export const feishuChannelInfoSchema = z.object({
  // Bot app_id is always known at production call sites; tightening to .min(1)
  // catches test/fixture regressions that forget to pass it.
  app_id: z.string().min(1),
  chat_id: z.string(),
  chat_type: z.string(), // 'p2p' | 'group' | 'topic' | ... (kept open: feishu may add more)
  message_id: z.string(),
  thread_id: z.string().optional(),
  sender_type: z.string(), // 'user' | 'bot' | ...
  // Omitted rather than empty: upstream sometimes lacks open_id for app/bot
  // events and the builder drops the key entirely when it would be ''.
  sender_open_id: z.string().min(1).optional(),
  sender_union_id: z.string().optional(),
  sender_user_id: z.string().optional(),
})
export type FeishuChannelInfo = z.infer<typeof feishuChannelInfoSchema>

// ── Channel info: Slack ──────────────────────────────────────────────────────
export const slackChannelInfoSchema = z.object({
  app_id: z.string().min(1),
  team_id: z.string().min(1),
  channel_id: z.string().min(1),
  chat_type: z.enum(['p2p', 'channel']),
  message_ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  sender_user_id: z.string().min(1),
})
export type SlackChannelInfo = z.infer<typeof slackChannelInfoSchema>

// ── Channel info: Discord ────────────────────────────────────────────────────
export const discordChannelInfoSchema = z.object({
  application_id: z.string().min(1),
  guild_id: z.string().min(1).optional(),
  channel_id: z.string().min(1),
  chat_type: z.enum(['dm', 'guild']),
  message_id: z.string().min(1),
  thread_id: z.string().min(1).optional(),
  sender_user_id: z.string().min(1),
})
export type DiscordChannelInfo = z.infer<typeof discordChannelInfoSchema>

// ── Channel info: QQ Official ────────────────────────────────────────────────
const qqOfficialChannelInfoBase = {
  app_id: z.string().min(1),
  message_id: z.string().min(1),
  sender_open_id: z.string().min(1),
}

export const qqOfficialChannelInfoSchema = z.discriminatedUnion('scene', [
  z.object({
    ...qqOfficialChannelInfoBase,
    scene: z.literal('group'),
    group_open_id: z.string().min(1),
    /** QQ GROUP_AT_MESSAGE_CREATE author.member_openid. */
    member_openid: z.string().min(1).optional(),
    /** QQ display name when the Gateway includes author.username. */
    username: z.string().min(1).optional(),
  }),
  z.object({
    ...qqOfficialChannelInfoBase,
    scene: z.literal('c2c'),
  }),
])
export type QQOfficialChannelInfo = z.infer<typeof qqOfficialChannelInfoSchema>

// ── Channel info: schedule ────────────────────────────────────────────────────
export const scheduleChannelInfoSchema = z.object({
  schedule_id: z.string().optional(),
  cron: z.string().optional(),
})
export type ScheduleChannelInfo = z.infer<typeof scheduleChannelInfoSchema>

// ── Channel info: git repository trigger (glab / gh) ──────────────────────────
//
// Records *which* repository event woke the Agent, not just that something did.
// A poll-driven Run is otherwise indistinguishable from any other in run
// history, and "why did this fire?" is the first question asked when one
// misbehaves — so the merge/pull request identity is part of the context rather
// than being buried in the rendered intent string.
export const gitTriggerChannelInfoSchema = z.object({
  provider: z.enum(['glab', 'gh']),
  /** Which state transition fired: opened / updated / commented / closed. */
  event: z.string(),
  /** Full project path, e.g. `acme/demo`. */
  project: z.string(),
  /** Forge host; absent means the CLI's default host. */
  host: z.string().optional(),
  /** MR `iid` on GitLab, PR `number` on GitHub. */
  number: z.number().int(),
  url: z.string().optional(),
  sha: z.string().optional(),
})
export type GitTriggerChannelInfo = z.infer<typeof gitTriggerChannelInfoSchema>

// ── Channel info: debug ───────────────────────────────────────────────────────
export const debugChannelInfoSchema = z.object({
  triggered_by_user_id: z.string(),
})
export type DebugChannelInfo = z.infer<typeof debugChannelInfoSchema>

// ── Channel info: chat app ────────────────────────────────────────────────────
//
// The chat app page reuses the platform session rather than allowing anonymous
// access, so the identity shape matches debug: a real a2wave user id. It stays a
// distinct channel_type (rather than reusing `debug`) so chat-app traffic is
// separable from in-product test conversations in run history and stats.
export const chatAppChannelInfoSchema = z.object({
  triggered_by_user_id: z.string(),
})
export type ChatAppChannelInfo = z.infer<typeof chatAppChannelInfoSchema>

// ── Discriminated union ───────────────────────────────────────────────────────
//
// `user_info` is the strict, fully-resolved identity (requires email). `display_name`
// is the loose, name-only fallback that survives even when `user_info` had to be
// nulled out — feishu without `contact:user.email:readonly` is the canonical case.
// Multi-hop A2A reads `display_name` so the asker label on every hop matches the
// original caller's display name, not just the first hop's.
//
// schedule's `user_info` is normally null since cron has no end user, but an agent
// may opt into running its schedule as the owner's bound IDaaS identity
// (scheduleRunAsOwner) — resolved server-side at trigger time. So it's
// `userInfoSchema.nullable()` like the other channels, staying null when not opted in.
export const runChannelContextSchema = z.discriminatedUnion('channel_type', [
  z.object({
    channel_type: z.literal('api'),
    channel_info: gatewayChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('a2a'),
    channel_info: gatewayChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('feishu'),
    channel_info: feishuChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('slack'),
    channel_info: slackChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('discord'),
    channel_info: discordChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('qq_official'),
    channel_info: qqOfficialChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('schedule'),
    channel_info: scheduleChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('debug'),
    channel_info: debugChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('oauth'),
    channel_info: gatewayChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('chat_app'),
    channel_info: chatAppChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('glab'),
    channel_info: gitTriggerChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
  z.object({
    channel_type: z.literal('gh'),
    channel_info: gitTriggerChannelInfoSchema,
    user_info: userInfoSchema.nullable(),
    display_name: z.string().min(1).optional(),
  }),
])
export type RunChannelContext = z.infer<typeof runChannelContextSchema>

// Convenience aliases for code that wants to narrow by channel
export type RunChannelContextApi = Extract<RunChannelContext, { channel_type: 'api' }>
export type RunChannelContextA2A = Extract<RunChannelContext, { channel_type: 'a2a' }>
export type RunChannelContextFeishu = Extract<RunChannelContext, { channel_type: 'feishu' }>
export type RunChannelContextSlack = Extract<RunChannelContext, { channel_type: 'slack' }>
export type RunChannelContextDiscord = Extract<RunChannelContext, { channel_type: 'discord' }>
export type RunChannelContextQQOfficial = Extract<
  RunChannelContext,
  { channel_type: 'qq_official' }
>
export type RunChannelContextSchedule = Extract<RunChannelContext, { channel_type: 'schedule' }>
export type RunChannelContextDebug = Extract<RunChannelContext, { channel_type: 'debug' }>
export type RunChannelContextOAuth = Extract<RunChannelContext, { channel_type: 'oauth' }>
export type RunChannelContextChatApp = Extract<RunChannelContext, { channel_type: 'chat_app' }>
