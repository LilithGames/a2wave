import { z } from 'zod'
import { isSupportedScheduleCron } from '../cron-utils.js'
import { ghTriggerConfigSchema, glabTriggerConfigSchema } from './git-trigger.js'
import { envEntrySchema } from './tool'

/**
 * Agent config stays a broad record — engines read their own keys out of it and
 * the set is deliberately open. The single exception is `providerChain`, which
 * drives runtime provider fallback: an oversized or malformed chain would only
 * surface at execution time, as wasted subprocess launches or an agent silently
 * left with no provider bound at all. It is validated below, after this file
 * declares `providerChainItemSchema`.
 */
export const PROVIDER_CHAIN_MAX = 5
export type AgentConfig = Record<string, unknown>

export const artifactPolicySchema = z.object({
  autoShare: z.enum(['off', 'on']).default('off'),
  shareAccessLevel: z.enum(['authenticated', 'public']).default('authenticated'),
  shareExpiryDays: z.number().int().min(1).max(365).default(7),
})
export type ArtifactPolicy = z.infer<typeof artifactPolicySchema>

export const agentTypeEnum = z.enum(['llm', 'cursor', 'script'])
export type AgentType = z.infer<typeof agentTypeEnum>

export const agentStatusEnum = z.enum(['active', 'inactive'])
export type AgentStatus = z.infer<typeof agentStatusEnum>

export const publishStatusEnum = z.enum(['draft', 'published', 'stopped'])
export type PublishStatus = z.infer<typeof publishStatusEnum>

export const publishAuthTypeEnum = z.enum(['none', 'api_key'])
export type PublishAuthType = z.infer<typeof publishAuthTypeEnum>

export const workspaceTypeEnum = z.enum(['scm', 'temp'])
export type WorkspaceType = z.infer<typeof workspaceTypeEnum>

export const publishChannelEnum = z.enum([
  'api',
  'a2a',
  'feishu',
  'slack',
  'discord',
  'schedule',
  'oauth',
  'chat_app',
  'glab',
  'gh',
])
export const oauthAccessModeEnum = z.enum(['all_idaas_users', 'specified_users'])
export type OauthAccessMode = z.infer<typeof oauthAccessModeEnum>

/** Upper bound on the `specified_users` allowlist — every entry is compared on each invoke. */
export const OAUTH_ALLOWED_EMAILS_MAX = 500

/**
 * The single normalization rule for an OAuth allowlist address.
 *
 * Called from three places that MUST agree — the schema below, the runtime gate in
 * `gateway-auth.ts`, and the allowlist editor in the web UI. If they ever diverge (someone adds
 * NFC normalization or IDN handling to one of them), the list the owner sees and the list that
 * actually admits callers quietly become different lists, and no test goes red. Hence one
 * exported function rather than three copies of `.trim().toLowerCase()`.
 */
export function normalizeOauthAllowedEmail(value: string): string {
  return value.trim().toLowerCase()
}

/** One allowlist entry, so the web UI can validate a single address the way the server will. */
export const oauthAllowedEmailSchema = z
  .string()
  .transform(normalizeOauthAllowedEmail)
  .pipe(z.string().email().max(320))

/**
 * Email allowlist backing `oauthAccessMode = 'specified_users'`.
 *
 * Normalized because the gate compares the IdP's `email` claim against it: an owner who types
 * `Alice@Corp.com` while the IdP emits `alice@corp.com` would otherwise be silently locked out.
 * Deduplicated so the cap counts distinct people — without it a list could hold 500 copies of
 * one address, and the duplicate keys would also break rendering. Empty is legal and
 * fail-closed: it is the state a migrated Agent lands in, and it must deny rather than admit.
 */
export const oauthAllowedEmailsSchema = z
  .array(oauthAllowedEmailSchema)
  .transform((list) => [...new Set(list)])
  .pipe(z.array(z.string()).max(OAUTH_ALLOWED_EMAILS_MAX))

/**
 * Credential modes:
 * - apiKey: injects providerApiKey (Claude also uses authHeaderStyle to choose
 *   ANTHROPIC_API_KEY vs ANTHROPIC_AUTH_TOKEN; other CLIs use their equivalent)
 * - oauth: injects providerOauthToken (CLAUDE_CODE_OAUTH_TOKEN, effective for Claude Code only)
 * - localSession: uses the CLI's local login state (~/.claude, etc.); injects no credentials
 */
export const authModeEnum = z.enum(['apiKey', 'oauth', 'localSession'])
export type AuthMode = z.infer<typeof authModeEnum>
export const authHeaderStyleEnum = z.enum(['x-api-key', 'bearer'])
export type AuthHeaderStyle = z.infer<typeof authHeaderStyleEnum>
export type PublishChannel = z.infer<typeof publishChannelEnum>

export const providerChainItemSchema = z.object({
  id: z.string().optional(),
  providerId: z.string().nullable(),
  model: z.string().optional(),
  // The effective default belongs to the selected Provider manifest. Keeping
  // this optional prevents a platform-wide apiKey default from overriding
  // Providers such as Pi whose native/default mode is localSession.
  authMode: authModeEnum.optional(),
  authHeaderStyle: authHeaderStyleEnum.optional(),
  providerApiKey: z.string().nullable().optional(),
  providerBaseUrl: z.string().nullable().optional(),
  providerOauthToken: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
})
export type ProviderChainItem = z.infer<typeof providerChainItemSchema>

/**
 * Only the length is validated here, and deliberately so.
 *
 * The cap is the real constraint: an oversized chain multiplies into wasted
 * subprocess launches that surface only at execution time.
 *
 * A chain that is empty, fully disabled, or full of null providerIds is NOT
 * rejected. An Agent saved before a Provider was picked persists `providerChain:
 * []`, and a draft Agent is a legitimate state — rejecting it here would brick
 * every existing one and block the very save that would repair it. Whether a
 * chain resolves to a usable Provider depends on rows that are deleted
 * independently of this config, so it can only be settled at execution time:
 * buildAgentConfig raises UnusableProviderChainError there.
 */
export const providerChainSchema = z
  .array(providerChainItemSchema)
  .max(PROVIDER_CHAIN_MAX, `providerChain supports at most ${PROVIDER_CHAIN_MAX} providers`)

export const agentConfigSchema = z
  .record(z.unknown())
  .and(z.object({ providerChain: providerChainSchema.optional() }))

export const feishuConfigSchema = z
  .object({
    appId: z.string(),
    appSecret: z.string(),
    // Regular group settings
    groupTriggerOnAt: z.boolean().default(true),
    groupTriggerOnNewMessage: z.boolean().default(false),
    groupReplyMode: z.enum(['quote', 'new', 'none']).default('quote'),
    // Topic group settings
    topicTriggerOnAt: z.boolean().default(true),
    topicTriggerOnNewTopic: z.boolean().default(false),
    topicTriggerOnNewComment: z.boolean().default(false),
    topicReplyMode: z.enum(['topic_reply', 'none']).default('topic_reply'),
    // Controls who receives an @ mention in topic replies. Looking up the topic creator
    // is opt-in because it requires an additional Feishu message read for topic comments.
    topicReplyMentionTarget: z
      .enum(['trigger_sender', 'topic_creator', 'none'])
      .default('trigger_sender'),
    // Optionally fetch the topic root's text, images, and files for each reply.
    // Disabled by default because topic continuity normally relies on session history.
    topicInjectRootMessage: z.boolean().default(false),
    // P2P direct-chat settings (always triggers; only the reply style is configurable)
    p2pReplyMode: z.enum(['quote', 'new', 'none']).default('quote'),
    // Shared settings
    // Reply content format:
    // - text plain text / post rich text / interactive template card (driven by cardTemplateId)
    // - interactive_card: the Agent declares confirm/input/select/date components in an
    //   ```a2wave-card``` block, which the platform renders as card JSON 2.0; user actions are
    //   posted back through the Feishu long connection via the card.action.trigger callback and
    //   resume the same session. Requires enabling "card callback interaction + receive callbacks
    //   over the long connection" in the Feishu admin console.
    // - streaming_card streaming card
    replyContentType: z
      .enum(['text', 'post', 'interactive', 'interactive_card', 'streaming_card'])
      .default('text'),
    cardTemplateId: z.string().optional(),
    // Debug info: appends the selected run details to the end of a normal reply (as a text suffix;
    // for interactive cards it is rendered at the bottom of the card) to aid troubleshooting.
    // The three switches are independent; checking any one attaches that card, and if none are
    // checked nothing is sent.
    debugShowSessionId: z.boolean().default(false),
    debugShowProvider: z.boolean().default(false),
    debugShowModel: z.boolean().default(false),
    sendArtifactsAsFile: z.boolean().default(true),
    fetchUserInfo: z.boolean().default(false),
    // Welcome message: Markdown text, delivered as an interactive CardKit card; empty/absent =
    // disabled entirely
    welcomeMessage: z.string().max(5000).optional(),
    welcomeOnP2pEnabled: z.boolean().default(false),
    // Effective only when welcomeOnP2pEnabled: resend when a user enters the direct chat and at
    // least this many days have passed since the last message; 0 = send on every entry
    welcomeP2pIdleDays: z.number().int().min(0).default(7),
    welcomeOnGroupAddedEnabled: z.boolean().default(false),
  })
  .passthrough() // Lets legacy fields triggerOnAt / triggerOnNewMessage / replyMode pass validation; normalizeFeishuConfig normalizes them
export type FeishuConfig = z.input<typeof feishuConfigSchema>

export const slackConfigSchema = z.object({
  appId: z.string().min(1),
  appToken: z.string().min(1),
  botToken: z.string().min(1),
  groupTriggerOnAt: z.boolean().default(true),
  groupTriggerOnNewMessage: z.boolean().default(false),
  groupReplyMode: z.enum(['thread', 'new', 'none']).default('thread'),
  p2pReplyMode: z.enum(['new', 'none']).default('new'),
  sendArtifactsAsFile: z.boolean().default(true),
})
export type SlackConfig = z.input<typeof slackConfigSchema>

export const discordConfigSchema = z.object({
  applicationId: z.string().min(1),
  botToken: z.string().min(1),
  guildTriggerOnMention: z.boolean().default(true),
  guildTriggerOnNewMessage: z.boolean().default(false),
  guildReplyMode: z.enum(['reply', 'new', 'none']).default('reply'),
  dmReplyMode: z.enum(['reply', 'none']).default('reply'),
  sendArtifactsAsFile: z.boolean().default(true),
})
export type DiscordConfig = z.input<typeof discordConfigSchema>

/** Max number of starter questions offered on the chat app landing screen. */
export const CHAT_APP_SUGGESTED_QUESTIONS_MAX = 6

/** Max length of a single starter question. */
export const CHAT_APP_SUGGESTED_QUESTION_MAX_LENGTH = 200

/**
 * Chat app channel: a shareable web page at /agents/:agentId/chat_app that renders
 * the Agent's profile beside a chat window.
 *
 * Access is NOT anonymous — the page reuses the platform session, so every turn is
 * attributed to a real a2wave user and lands in the audit trail (Iron Rule 5). This
 * config therefore only carries presentation copy, never credentials.
 */
export const chatAppConfigSchema = z.object({
  /** Overrides the Agent name in the page header; falls back to the Agent name when blank. */
  displayName: z.string().max(100).optional(),
  /** Markdown greeting shown before the first turn; blank hides the greeting card. */
  welcomeMessage: z.string().max(5000).optional(),
  /** One-tap starter prompts on the empty state. */
  suggestedQuestions: z
    // Trimmed before the length check: `min(1)` alone accepts "   ", which the
    // publish form filters out but a direct API call does not, leaving a blank
    // chip on the page. Normalising here keeps both entry points honest.
    .array(z.string().trim().min(1).max(CHAT_APP_SUGGESTED_QUESTION_MAX_LENGTH))
    .max(CHAT_APP_SUGGESTED_QUESTIONS_MAX)
    .default([]),
  /** Show the Agent creator in the profile sidebar. */
  showCreator: z.boolean().default(true),
  /** Let visitors attach files, reusing the global attachment limits. */
  allowAttachments: z.boolean().default(true),
  /** Expose the tool-call / thinking timeline. Off keeps the page conversational. */
  showThinking: z.boolean().default(true),
})
export type ChatAppConfig = z.input<typeof chatAppConfigSchema>

export const singleScheduleConfigSchema = z.object({
  id: z.string().min(1).optional(),
  cron: z.string().min(1).refine(isSupportedScheduleCron, {
    message:
      'Unsupported cron expression. Use 5 fields: min hour dom mon dow. Examples: 0 9 * * *, 0 7,19 * * *.',
  }),
  intent: z.string().min(1),
  timezone: z.string().default('Asia/Shanghai'),
})
export type SingleScheduleConfig = z.infer<typeof singleScheduleConfigSchema>

export const scheduleConfigSchema = z.union([
  singleScheduleConfigSchema,
  z.array(singleScheduleConfigSchema).min(1),
])
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>

export const a2aRouteTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local'), agentId: z.string() }),
  z.object({
    type: z.literal('remote'),
    name: z.string().min(1),
    url: z.string().url(),
    /**
     * Omitted by legacy rows, which are interpreted as a direct A2A 0.3
     * endpoint. New clients should prefer Agent Card discovery so the remote
     * service can advertise its protocol version and transport endpoint.
     */
    connectionMode: z.enum(['agent_card', 'direct']).optional(),
    /** Only used by direct targets; Agent Card targets negotiate automatically. */
    protocolVersion: z.enum(['1.0', '0.3']).optional(),
    /** Explicit opt-in for sending caller provenance to a direct A2A 1.0 endpoint. */
    callerProvenance: z.boolean().optional(),
    description: z.string().optional(),
    apiKey: z.string().optional(),
  }),
])
export type A2ARouteTarget = z.infer<typeof a2aRouteTargetSchema>

export const a2aSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
})
export type A2ASkill = z.infer<typeof a2aSkillSchema>

/** Models available to cursor-agent */
export const cursorAgentModels = [
  'claude-sonnet',
  'claude-opus',
  'gpt-4o',
  'gemini-2.5-pro',
] as const

// ============================================================
// Defaults — single source of truth for DB & Zod
// ============================================================

export const AGENT_DEFAULTS = {
  type: 'cursor' as const,
  status: 'active' as const,
  icon: '🤖',
  workspaceType: 'temp' as const,
  maxConcurrency: 1,
  publishStatus: 'draft' as const,
  publishAuthType: 'api_key' as const,
  publishChannels: ['api'] as const,
} as const

// ============================================================
// Agent Schema
// ============================================================

export const agentSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
  type: agentTypeEnum,
  config: agentConfigSchema.nullable().optional(),
  status: agentStatusEnum,
  icon: z.string().default('🤖'),
  systemPrompt: z.string().nullable().optional(),
  skills: z.array(z.string()).default([]),
  /** Mounted Skill group IDs (skg_xxx); merged with `skills` and deduplicated at runtime */
  skillGroupIds: z.array(z.string()).default([]),
  /** Mounted MCP Server IDs */
  mcpServerIds: z.array(z.string()).default([]),
  /** Mounted knowledge base document IDs */
  kbDocumentIds: z.array(z.string()).default([]),
  /** Agent environment variables */
  env: z.record(z.string(), envEntrySchema).nullable().optional(),
  /** Working directory type: scm = linked code source, temp = temporary directory */
  workspaceType: workspaceTypeEnum.default('temp'),
  /** Linked SCM source ID (effective when workspaceType === 'scm') */
  scmSourceId: z.string().nullable().optional(),
  maxConcurrency: z.number().int().min(1).max(5).default(1),
  publishStatus: publishStatusEnum.default('draft'),
  providerApiKey: z.string().nullable().optional(),
  providerBaseUrl: z.string().nullable().optional(),
  providerOauthToken: z.string().nullable().optional(),
  /** @deprecated Auto-memory inherits the Agent Provider credentials; kept only for legacy client compatibility */
  memoryProviderApiKey: z.string().nullable().optional(),
  embeddingApiKey: z.string().nullable().optional(),
  authMode: authModeEnum.default('apiKey'),
  endpointApiKey: z.string().nullable().optional(),
  publishAuthType: publishAuthTypeEnum.nullable().optional(),
  publishIpWhitelist: z.array(z.string()).nullable().optional(),
  publishDescription: z.string().nullable().optional(),
  publishChannels: z.array(publishChannelEnum).default(['api']),
  /** OAuth channel access scope: every enterprise SSO user, or only the addresses in oauthAllowedEmails */
  oauthAccessMode: oauthAccessModeEnum.default('all_idaas_users'),
  /** Email allowlist consulted only when oauthAccessMode === 'specified_users' */
  oauthAllowedEmails: oauthAllowedEmailsSchema.nullable().optional(),
  a2aSkills: z.array(a2aSkillSchema).nullable().optional(),
  a2aRouteTargets: z.array(a2aRouteTargetSchema).nullable().optional(),
  showLocalChildOutput: z.boolean().optional(),
  showRemoteChildOutput: z.boolean().optional(),
  feishuConfig: feishuConfigSchema.nullable().optional(),
  slackConfig: slackConfigSchema.nullable().optional(),
  discordConfig: discordConfigSchema.nullable().optional(),
  chatAppConfig: chatAppConfigSchema.nullable().optional(),
  scheduleConfig: scheduleConfigSchema.nullable().optional(),
  /**
   * Git repository polling triggers. Each column is bound to its own provider
   * literal rather than the shared shape: a `glab` config saved into `ghConfig`
   * validated cleanly and then silently never polled, and that had to be
   * guarded by hand at every write path until the schema itself rejected it.
   */
  glabConfig: glabTriggerConfigSchema.nullable().optional(),
  ghConfig: ghTriggerConfigSchema.nullable().optional(),
  artifactPolicy: artifactPolicySchema.nullable().optional(),
  publishedAt: z.coerce.date().nullable().optional(),
  /** ID of the referenced Provider entity */
  providerId: z.string().nullable().optional(),
  /** Dedicated inbound A2A auth method (decoupled from the REST API channel) */
  a2aAuthType: publishAuthTypeEnum.default('api_key'),
  /** API Key dedicated to inbound A2A (always masked to '********' on read paths) */
  a2aEndpointApiKey: z.string().nullable().optional(),
  /** Trust the user identity forwarded by an upstream A2A: only an a2a hop with a2aAuthType=api_key signs the gateway token from it */
  trustForwardedIdentity: z.boolean().default(false),
  /** Scheduled tasks pass through the gateway using the IDaaS identity bound to "whoever turned this switch on" (on/off switch) */
  scheduleRunAsOwner: z.boolean().default(false),
  /** User id owning the scheduled gateway identity (pinned server-side to the logged-in user at publish time; read-only, client writes are rejected) */
  scheduleRunAsUserId: z.string().nullable().optional(),
  /**
   * Pin timestamp: a non-null value means the Agent is pinned, and the list sorts pinned items
   * ahead of unpinned ones by ascending pinnedAt.
   * Read-only — the timestamp can only be stamped server-side via the dedicated pin/unpin routes;
   * create/PATCH writes are rejected.
   */
  pinnedAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type Agent = z.infer<typeof agentSchema>

export const createAgentInput = z.object({
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
  type: agentTypeEnum.default(AGENT_DEFAULTS.type),
  config: agentConfigSchema.nullable().optional(),
  icon: z.string().default(AGENT_DEFAULTS.icon),
  systemPrompt: z.string().nullable().optional(),
  skills: z.array(z.string()).optional(),
  skillGroupIds: z.array(z.string()).optional(),
  mcpServerIds: z.array(z.string()).optional(),
  kbDocumentIds: z.array(z.string()).optional(),
  env: z.record(z.string(), envEntrySchema).nullable().optional(),
  workspaceType: workspaceTypeEnum.default(AGENT_DEFAULTS.workspaceType),
  scmSourceId: z.string().nullable().optional(),
  maxConcurrency: z.number().int().min(1).max(5).default(AGENT_DEFAULTS.maxConcurrency),
  // Publish lifecycle is server-controlled through publish / stop / resume.
  // Accepting this field here would let create/PATCH bypass activation preflight.
  providerApiKey: z.string().nullable().optional(),
  providerBaseUrl: z.string().nullable().optional(),
  providerOauthToken: z.string().nullable().optional(),
  /** @deprecated Auto-memory inherits the Agent Provider credentials; kept only for legacy client compatibility */
  memoryProviderApiKey: z.string().nullable().optional(),
  embeddingApiKey: z.string().nullable().optional(),
  authMode: authModeEnum.optional(),
  endpointApiKey: z.string().nullable().optional(),
  publishChannels: z.array(publishChannelEnum).optional(),
  a2aSkills: z.array(a2aSkillSchema).nullable().optional(),
  a2aRouteTargets: z.array(a2aRouteTargetSchema).nullable().optional(),
  showLocalChildOutput: z.boolean().optional(),
  showRemoteChildOutput: z.boolean().optional(),
  feishuConfig: feishuConfigSchema.nullable().optional(),
  slackConfig: slackConfigSchema.nullable().optional(),
  discordConfig: discordConfigSchema.nullable().optional(),
  chatAppConfig: chatAppConfigSchema.nullable().optional(),
  scheduleConfig: scheduleConfigSchema.nullable().optional(),
  glabConfig: glabTriggerConfigSchema.nullable().optional(),
  ghConfig: ghTriggerConfigSchema.nullable().optional(),
  artifactPolicy: artifactPolicySchema.nullable().optional(),
  providerId: z.string().nullable().optional(),
  // NOTE: scheduleRunAsOwner is intentionally NOT here — it must only be set via the
  // publish route, which pins scheduleRunAsUserId server-side in lockstep. Allowing it
  // through create/PATCH would let a client flip the boolean without re-pinning the
  // user id, desyncing the two columns / re-enabling a stale run-as identity.
})

export type CreateAgentInput = z.infer<typeof createAgentInput>

export const updateAgentInput = createAgentInput.partial()
export type UpdateAgentInput = z.infer<typeof updateAgentInput>

// ============================================================
// Agent Membership
// ============================================================

export const agentMemberRoleEnum = z.enum(['viewer', 'editor'])
export type AgentMemberRole = z.infer<typeof agentMemberRoleEnum>

export const addAgentMemberInput = z.object({
  userId: z.string().min(1),
  role: agentMemberRoleEnum,
})
export type AddAgentMemberInput = z.infer<typeof addAgentMemberInput>

export const updateAgentMemberInput = z.object({
  role: agentMemberRoleEnum,
})
export type UpdateAgentMemberInput = z.infer<typeof updateAgentMemberInput>

export type AgentPermission = 'owner' | 'editor' | 'viewer'
