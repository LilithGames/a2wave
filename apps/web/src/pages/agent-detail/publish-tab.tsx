import {
  type Agent,
  CHAT_APP_SUGGESTED_QUESTION_MAX_LENGTH,
  CHAT_APP_SUGGESTED_QUESTIONS_MAX,
  GIT_TRIGGER_DEFAULT_INTERVAL_SECONDS,
  type GitTriggerCliStatus,
  type GitTriggerEvent,
  type GitTriggerProvider,
  type GitTriggerScope,
  isSupportedScheduleCron,
  type SsoConfigSource,
} from '@a2wave/shared'
import { useQuery } from '@tanstack/react-query'
import { Modal, Radio } from 'antd'
import { Globe, Info, Loader2, Play, RefreshCw, StopCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type {
  ChatAppPublishConfig,
  ConfigurableChannel,
  DiscordPublishConfig,
  FeishuPublishConfig,
  PublishConfig,
  QQOfficialPublishConfig,
  SaveChannelConfigVars,
  SchedulePublishConfig,
  SlackPublishConfig,
} from '@/hooks/use-agents'
import {
  fetchGitTriggerCliStatus,
  useNativeChatConnections,
  useRegenerateA2aApiKey,
  useRegenerateApiKey,
  useSaveChannelConfig,
} from '@/hooks/use-agents'
import { useCurrentUser, useOauthConfig } from '@/hooks/use-auth'
import { message } from '@/lib/antd-static'
import { api } from '@/lib/api'
import {
  type ConnectedChannelKey,
  isConnectedChannel,
  resolveChannelConnectionUi,
} from '@/lib/channel-connection-ui'
import { confirm } from '@/lib/confirm'
import type { SchedulePreset } from '@/lib/cron-utils'
import { cronToPreset, presetToCron } from '@/lib/cron-utils'
import { formatGitRepoUrl } from '@/lib/git-repo-url'
import { safeSetItem } from '@/lib/safe-storage'
import { cn } from '@/lib/utils'
import { resolveSsoMethods } from '@/pages/login'
import { ChatAppChannelSection } from './chat-app-channel-section'
import { CopyButton } from './copy-button'
import { A2aChannelSection } from './publish/a2a-channel-section'
import { ChannelConfigModal } from './publish/channel-config-modal'
import { ChannelConnectionStatus } from './publish/channel-connection-status'
import { ChannelGrid } from './publish/channel-grid'
import { type ChannelReadinessInput, getChannelBlockReason } from './publish/channel-readiness'
import {
  CHANNEL_REGISTRY,
  type ChannelKey,
  isChannelKey,
  isConfigurableChannel,
} from './publish/channel-registry'
import { DiscordChannelSection } from './publish/discord-channel-section'
import { FeishuChannelSection } from './publish/feishu-channel-section'
import {
  GitTriggerChannelSection,
  type GitTriggerRepoDraft,
  resolveGitTriggerIntentDefault,
} from './publish/git-trigger-channel-section'
import { OauthAllowedEmails } from './publish/oauth-allowed-emails'
import { QQOfficialChannelSection } from './publish/qq-official-channel-section'
import { ScheduleChannelSection } from './publish/schedule-channel-section'

/** Local draft shape for one git-trigger channel's form state. */
interface GitTriggerDraft {
  repos: GitTriggerRepoDraft[]
  events: GitTriggerEvent[]
  intervalSeconds: number
  intent: string
  /** Comma-separated in the form; split into an array only at submit time. */
  targetBranches: string
  ignoreDrafts: boolean
}

/**
 * @param defaultIntent Prefilled trigger intent, resolved in the caller so it
 *   follows the UI language. Seeding it here rather than leaving the field
 *   blank matters because the intent is the one field a user cannot guess the
 *   shape of — an empty textarea gives no hint that `{{title}}` and `{{url}}`
 *   are available, so the channel got published with a prompt that named no
 *   request and the Agent had to go looking for what changed.
 */
function createGitTriggerDraft(defaultIntent = ''): GitTriggerDraft {
  return {
    repos: [{ url: '', project: '', host: '', scope: 'project' as const }],
    // Default to the two events that represent "there is new work to look at".
    // `closed` is opt-in: an Agent usually has nothing to do once a request is
    // gone, and firing on it by default would spend tokens for no outcome.
    events: ['opened', 'updated'],
    intervalSeconds: GIT_TRIGGER_DEFAULT_INTERVAL_SECONDS,
    intent: defaultIntent,
    targetBranches: '',
    ignoreDrafts: true,
  }
}

/**
 * Hydrates the form draft from a persisted channel config.
 *
 * `defaultIntent` fills only a *missing* intent. A saved empty string is still
 * replaced, since the config could not have been published that way — but any
 * stored text wins, so reopening a channel never overwrites what the user
 * wrote with the template.
 */
function toGitTriggerDraft(config: unknown, defaultIntent = ''): GitTriggerDraft {
  const fallback = createGitTriggerDraft(defaultIntent)
  if (!config || typeof config !== 'object') return fallback
  const raw = config as {
    repos?: { project?: string; host?: string; scope?: GitTriggerScope }[]
    events?: GitTriggerEvent[]
    intervalSeconds?: number
    intent?: string
    targetBranches?: string[]
    ignoreDrafts?: boolean
  }
  // The stored config keeps host and project apart, so the URL the field shows
  // is rebuilt from them on load.
  const repos = (raw.repos ?? [])
    .filter((repo) => repo?.project)
    .map((repo) => {
      const parts = { project: repo.project ?? '', host: repo.host ?? '' }
      return {
        url: formatGitRepoUrl(parts),
        ...parts,
        scope: repo.scope ?? 'project',
      }
    })
  return {
    repos: repos.length > 0 ? repos : fallback.repos,
    events: raw.events?.length ? raw.events : fallback.events,
    intervalSeconds: raw.intervalSeconds ?? fallback.intervalSeconds,
    intent: raw.intent?.trim() ? raw.intent : fallback.intent,
    targetBranches: (raw.targetBranches ?? []).join(', '),
    ignoreDrafts: raw.ignoreDrafts ?? true,
  }
}

function toGitTriggerReadiness(draft: GitTriggerDraft) {
  return {
    repos: draft.repos.map((repo) => ({
      project: repo.project,
      url: repo.url,
      scope: repo.scope,
    })),
    events: draft.events,
    intent: draft.intent,
    intervalSeconds: draft.intervalSeconds,
  }
}

import { SlackChannelSection } from './publish/slack-channel-section'

const DESCRIPTION_MAX = 300
const DEFAULT_SCHEDULE_VALUES = {
  cron: '0 9 * * *',
  intent: '',
  timezone: 'Asia/Shanghai',
}

function createScheduleId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `sch_${crypto.randomUUID()}`
  }
  return `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function createDefaultScheduleConfig(): SchedulePublishConfig {
  return {
    id: createScheduleId(),
    ...DEFAULT_SCHEDULE_VALUES,
  }
}

/**
 * Suggested questions are authored one per line and stored as an array.
 *
 * Blank lines are dropped, each line is clamped to the schema's per-question
 * limit, and the list is capped. Both limits are enforced here rather than left
 * to the server: a publish rejected by Zod returns a field-error object, which
 * the UI's error formatter renders as an empty toast — so an over-long paste
 * would otherwise fail with no explanation at all.
 */
export function parseSuggestedQuestions(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim().slice(0, CHAT_APP_SUGGESTED_QUESTION_MAX_LENGTH))
    .filter(Boolean)
    .slice(0, CHAT_APP_SUGGESTED_QUESTIONS_MAX)
}

/**
 * The OAuth channel no longer borrows the Feishu app's visibility scope, so its credentials
 * are submitted only for the Feishu channel itself. Previously an OAuth-only Agent had to
 * carry Feishu credentials purely to answer "may this caller in?".
 */
export function shouldSubmitFeishuConfigForPublish(input: { feishuEnabled: boolean }): boolean {
  return input.feishuEnabled
}

function isSchedulePublishConfigLike(item: unknown): item is Partial<SchedulePublishConfig> {
  return item != null && typeof item === 'object'
}

export function normalizeSchedulePublishConfigs(
  config:
    | Agent['scheduleConfig']
    | SchedulePublishConfig
    | SchedulePublishConfig[]
    | null
    | undefined,
): SchedulePublishConfig[] {
  if (!config) return []
  const configs = Array.isArray(config) ? config : [config]
  return configs.map((item) => {
    if (!isSchedulePublishConfigLike(item)) return createDefaultScheduleConfig()
    return {
      id: item.id ?? createScheduleId(),
      cron: item.cron ?? DEFAULT_SCHEDULE_VALUES.cron,
      intent: item.intent ?? '',
      timezone: item.timezone ?? DEFAULT_SCHEDULE_VALUES.timezone,
    }
  })
}

/** 飞书开放平台「应用创建」入口（launcher / 应用模板），用于半自动创建机器人应用。 */
const FEISHU_LAUNCHER_URL = 'https://open.feishu.cn/page/launcher'

/**
 * 飞书租户身份 scopes：列表与一键复制 JSON 同源，避免漂移。
 *
 * 飞书通讯录权限分两层（**两层都适用于 tenant_access_token**，不是 OAuth 专属）：
 *   - `contact:contact.*` = 基础调用权限（决定能不能调 API）
 *   - `contact:user.*`    = 字段级权限（决定 response 里返回哪些字段）
 *
 * 覆盖两类调用：
 *   1. 启用「获取发送方用户信息」(fetchUserInfo)：`GET /contact/v3/users/:open_id`
 *      base : `contact:contact.base:readonly`（API 调用权）
 *      field: `contact:user.base:readonly`（name 等基础字段）
 *             `contact:user.email:readonly`（email 字段）
 *
 * 即使当前 Agent 没开这些功能，预先把权限挂上能省一次飞书后台改权限+重新发版的往返。
 *
 * 曾经还包含 `contact:user.id:readonly` + `contact:user.employee_id:readonly`，供 OAuth 渠道
 * 用 `batch_get_id` 反查「应用可见范围」。该判定已下线（改为邮箱白名单），唯一调用方也已删除，
 * 因此这两项一并移除——其中 user.id 在飞书后台需单独审批，留着只会白白抬高接入门槛，
 * 并让平台继续持有不再需要的通讯录查询权。
 */
const FEISHU_BASE_SCOPES = [
  'im:message:send_as_bot',
  'im:message',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  // 接收群里「所有消息」（不仅 @机器人）的事件，缺它则群聊里即便勾选「群内新增消息」
  // 触发，飞书也只会推送 @机器人 的消息。属敏感权限，需在飞书后台单独申请审批。
  'im:message.group_msg:readonly',
  'im:resource',
  'cardkit:card:write',
  'contact:contact.base:readonly',
  'contact:user.base:readonly',
  'contact:user.email:readonly',
] as const

interface PublishTabProps {
  agentId: string | undefined
  agent: Agent | undefined
  /**
   * Owner/editor. Defaults to true because the create flow has no permission yet (the caller
   * is by definition becoming the owner) and every existing call site passes it explicitly.
   */
  canWrite?: boolean
  onPublishConfirm: (config: PublishConfig) => Promise<{ endpointApiKey?: string } | undefined>
  isPublishing: boolean
  onStop: () => void
  onResume: () => Promise<void>
  isStopPending: boolean
  isResumePending: boolean
}

type OauthEnvStatus = {
  configured: boolean
  missing: string[]
  /**
   * Where the OIDC config was actually read from. Settings wins over the environment, so a
   * message naming env vars sends an admin to edit a file that will not be consulted.
   *
   * Typed from the shared `SsoConfigSource` rather than a hand-written literal: the value is
   * `'settings'`, and spelling it `'db'` here silently disabled the branch below while a test
   * asserting the same wrong literal still passed.
   */
  source?: SsoConfigSource | null
}

/**
 * Which "OAuth channel unavailable" message to show.
 *
 * The OIDC config resolves **Settings-first**: when it came from Settings, telling the admin to
 * add environment variables points them at a file the server will not consult — they would edit
 * it, restart, and see no change. Only an env-sourced (or entirely absent) config gets the
 * env-var wording; a Settings-sourced one that is merely incomplete (empty audience allowlist)
 * is sent back to Settings.
 */
export function oauthEnvErrorKey(status: Pick<OauthEnvStatus, 'missing' | 'source'>): string {
  if (status.missing.length === 0) return 'agentPublish.oauthEnvInvalidPublicKey'
  return status.source === 'settings'
    ? 'agentPublish.oauthEnvIncompleteSettings'
    : 'agentPublish.oauthEnvMissing'
}

/**
 * A persisted Feishu config as it may actually arrive from the API.
 *
 * `feishuConfigSchema` is `.passthrough()`, so a record written before the
 * group/topic split still carries the flat legacy fields and none of the new
 * ones. Every field is therefore optional here, and the three legacy keys are
 * declared so the compatibility fallbacks below type-check without `any`.
 */
type PersistedFeishuConfig = Partial<FeishuPublishConfig> & {
  triggerOnAt?: boolean
  triggerOnNewMessage?: boolean
  replyMode?: 'quote' | 'new' | 'none'
}

export function PublishTab({
  agentId,
  agent,
  canWrite = true,
  onPublishConfirm,
  isPublishing,
  onStop,
  onResume,
  isStopPending,
  isResumePending,
}: PublishTabProps) {
  const { t, i18n } = useTranslation()
  const regenerateKey = useRegenerateApiKey()
  const regenerateA2aKey = useRegenerateA2aApiKey()
  const saveChannelConfig = useSaveChannelConfig()
  const [searchParams, setSearchParams] = useSearchParams()

  // `?publishTab=` now addresses "which channel's config dialog is open"
  // rather than "which sub-tab is active"; absent means the grid alone. Keeping
  // the param name preserves every existing deep link — the onboarding tour
  // gates its whole Feishu branch on it, and the E2E specs navigate by it.
  const publishTabParam = searchParams.get('publishTab')
  const openChannel = isChannelKey(publishTabParam) ? publishTabParam : null

  const openChannelModal = (key: ChannelKey) => {
    const next = new URLSearchParams(searchParams)
    next.set('publishTab', key)
    setSearchParams(next, { replace: true })
  }

  const closeChannelModal = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('publishTab')
    setSearchParams(next, { replace: true })
  }

  /**
   * Seeds a channel toggle from the agent already in hand.
   *
   * The effect below re-syncs these on every agent reload, but it runs *after*
   * the first paint — so starting at `false` rendered every card as switched
   * off for a frame and then flipped the enabled ones on, which on refresh
   * reads as the page turning the user's channels off and back on. When the
   * agent is present at mount there is nothing to wait for.
   */
  const channelInitiallyOn = (channel: ChannelKey) =>
    (agent?.publishChannels ?? []).includes(channel)

  const [ipWhitelistStr, setIpWhitelistStr] = useState('')
  const [description, setDescription] = useState('')
  const [a2aEnabled, setA2aEnabled] = useState(() => channelInitiallyOn('a2a'))
  const [feishuEnabled, setFeishuEnabled] = useState(() => channelInitiallyOn('feishu'))
  const [slackEnabled, setSlackEnabled] = useState(() => channelInitiallyOn('slack'))
  const [discordEnabled, setDiscordEnabled] = useState(() => channelInitiallyOn('discord'))
  const [qqOfficialEnabled, setQQOfficialEnabled] = useState(() =>
    channelInitiallyOn('qq_official'),
  )
  // 明文 API Key 仅在「生成/重置」成功响应里一次性返回，存这里用于弹 modal 展示，关闭即清空。
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [authType, setAuthType] = useState<'none' | 'api_key'>('api_key')
  // A2A 入站独立鉴权（与 REST 渠道解耦）
  const [a2aAuthType, setA2aAuthType] = useState<'none' | 'api_key'>('api_key')
  const [trustForwardedIdentity, setTrustForwardedIdentity] = useState(false)
  const [generatedA2aKey, setGeneratedA2aKey] = useState<string | null>(null)
  // 生成/重置成功后本地标记 key 已存在——regenerate 不再 invalidate agent（避免覆盖未保存表单），
  // 因此首次生成后需靠本地标记把按钮从「生成密钥」切到「重置密钥」。agent 重载时在 useEffect 复位。
  const [keyGenerated, setKeyGenerated] = useState(false)
  const [a2aKeyGenerated, setA2aKeyGenerated] = useState(false)

  // Feishu config state.
  // Seeded like the toggles above: these four feed `channelBlockReasons`, so
  // starting them empty made a fully configured Feishu card render greyed-out
  // for a frame on every refresh.
  const [feishuAppId, setFeishuAppId] = useState(() => agent?.feishuConfig?.appId ?? '')
  const [feishuAppSecret, setFeishuAppSecret] = useState(() => agent?.feishuConfig?.appSecret ?? '')
  // 后端把已保存的 appSecret 脱敏返回，不回显明文；用这个标记区分"已配置"与"未配置"。
  const [feishuSecretExists, setFeishuSecretExists] = useState(
    () => (agent?.feishuConfig?.appSecret ?? '').length > 0,
  )
  // 开启飞书时弹出的「已有 / 创建」选择弹窗；选「创建」后展示 launcher 引导。
  const [feishuSetupOpen, setFeishuSetupOpen] = useState(false)
  const [feishuShowCreateGuide, setFeishuShowCreateGuide] = useState(false)
  // 选「创建」后把视图定位到 App ID 输入框，引导用户回填凭证。
  const feishuAppIdInputRef = useRef<HTMLInputElement>(null)
  const focusFeishuAppId = () => {
    // 等输入框随 feishuEnabled 渲染后再滚动/聚焦。
    window.setTimeout(() => {
      feishuAppIdInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      feishuAppIdInputRef.current?.focus()
    }, 150)
  }
  // 普通群
  const [groupTriggerOnAt, setGroupTriggerOnAt] = useState(true)
  const [groupTriggerOnNewMessage, setGroupTriggerOnNewMessage] = useState(false)
  const [groupReplyMode, setGroupReplyMode] = useState<'quote' | 'new' | 'none'>('quote')
  // 话题群
  const [topicTriggerOnAt, setTopicTriggerOnAt] = useState(true)
  const [topicTriggerOnNewTopic, setTopicTriggerOnNewTopic] = useState(false)
  const [topicTriggerOnNewComment, setTopicTriggerOnNewComment] = useState(false)
  const [topicReplyMode, setTopicReplyMode] = useState<'topic_reply' | 'none'>('topic_reply')
  const [topicReplyMentionTarget, setTopicReplyMentionTarget] = useState<
    'trigger_sender' | 'topic_creator' | 'none'
  >('trigger_sender')
  // Optionally include the topic root content in every topic reply.
  const [topicInjectRootMessage, setTopicInjectRootMessage] = useState(false)
  // P2P 单聊
  const [p2pReplyMode, setP2pReplyMode] = useState<'quote' | 'new' | 'none'>('quote')
  const [feishuReplyContentType, setFeishuReplyContentType] = useState<
    'text' | 'post' | 'interactive' | 'interactive_card' | 'streaming_card'
  >('text')
  const [feishuCardTemplateId, setFeishuCardTemplateId] = useState('')
  // 调试信息（回复末尾追加勾选的运行信息）
  const [feishuDebugShowSessionId, setFeishuDebugShowSessionId] = useState(false)
  const [feishuDebugShowProvider, setFeishuDebugShowProvider] = useState(false)
  const [feishuDebugShowModel, setFeishuDebugShowModel] = useState(false)
  const [feishuSendArtifactsAsFile, setFeishuSendArtifactsAsFile] = useState(true)
  const [feishuFetchUserInfo, setFeishuFetchUserInfo] = useState(false)
  // 开场白
  const [feishuWelcomeMessage, setFeishuWelcomeMessage] = useState('')
  const [feishuWelcomeOnP2pEnabled, setFeishuWelcomeOnP2pEnabled] = useState(false)
  const [feishuWelcomeP2pIdleDays, setFeishuWelcomeP2pIdleDays] = useState(7)
  const [feishuWelcomeOnGroupAddedEnabled, setFeishuWelcomeOnGroupAddedEnabled] = useState(false)

  // Slack config state
  const [slackAppId, setSlackAppId] = useState(() => agent?.slackConfig?.appId ?? '')
  const [slackAppToken, setSlackAppToken] = useState(() => agent?.slackConfig?.appToken ?? '')
  const [slackBotToken, setSlackBotToken] = useState(() => agent?.slackConfig?.botToken ?? '')
  const [slackGroupTriggerOnAt, setSlackGroupTriggerOnAt] = useState(true)
  const [slackGroupTriggerOnNewMessage, setSlackGroupTriggerOnNewMessage] = useState(false)
  const [slackGroupReplyMode, setSlackGroupReplyMode] = useState<'thread' | 'new' | 'none'>(
    'thread',
  )
  const [slackP2pReplyMode, setSlackP2pReplyMode] = useState<'new' | 'none'>('new')
  const [slackSendArtifactsAsFile, setSlackSendArtifactsAsFile] = useState(true)

  // Discord config state
  const [discordApplicationId, setDiscordApplicationId] = useState(
    () => agent?.discordConfig?.applicationId ?? '',
  )
  const [discordBotToken, setDiscordBotToken] = useState(() => agent?.discordConfig?.botToken ?? '')
  const [discordGuildTriggerOnMention, setDiscordGuildTriggerOnMention] = useState(true)
  const [discordGuildTriggerOnNewMessage, setDiscordGuildTriggerOnNewMessage] = useState(false)
  const [discordGuildReplyMode, setDiscordGuildReplyMode] = useState<'reply' | 'new' | 'none'>(
    'reply',
  )
  const [discordDmReplyMode, setDiscordDmReplyMode] = useState<'reply' | 'none'>('reply')
  const [discordSendArtifactsAsFile, setDiscordSendArtifactsAsFile] = useState(true)

  // QQ Official WebSocket Gateway config state.
  const [qqOfficialAppId, setQQOfficialAppId] = useState(() => agent?.qqOfficialConfig?.appId ?? '')
  const [qqOfficialAppSecret, setQQOfficialAppSecret] = useState(
    () => agent?.qqOfficialConfig?.appSecret ?? '',
  )
  const [qqGroupTriggerOnAt, setQQGroupTriggerOnAt] = useState(true)
  const [qqGroupReplyMode, setQQGroupReplyMode] = useState<'reply' | 'new' | 'none'>('reply')
  const [qqC2cReplyMode, setQQC2cReplyMode] = useState<'reply' | 'new' | 'none'>('reply')
  const [qqSendArtifactsAsFile, setQQSendArtifactsAsFile] = useState(true)

  // Chat app config state (presentation copy only — no credentials)
  const [chatAppEnabled, setChatAppEnabled] = useState(() => channelInitiallyOn('chat_app'))
  const [chatAppDisplayName, setChatAppDisplayName] = useState('')
  const [chatAppWelcomeMessage, setChatAppWelcomeMessage] = useState('')
  const [chatAppSuggestedQuestions, setChatAppSuggestedQuestions] = useState('')
  const [chatAppShowCreator, setChatAppShowCreator] = useState(true)
  const [chatAppAllowAttachments, setChatAppAllowAttachments] = useState(true)
  const [chatAppShowThinking, setChatAppShowThinking] = useState(true)

  const [oauthEnabled, setOauthEnabled] = useState(() => channelInitiallyOn('oauth'))
  const [oauthAccessMode, setOauthAccessMode] = useState<'all_idaas_users' | 'specified_users'>(
    () =>
      (agent as { oauthAccessMode?: string } | undefined)?.oauthAccessMode === 'specified_users'
        ? 'specified_users'
        : 'all_idaas_users',
  )
  const [oauthAllowedEmails, setOauthAllowedEmails] = useState<string[]>(
    () => (agent as { oauthAllowedEmails?: string[] | null } | undefined)?.oauthAllowedEmails ?? [],
  )
  const oauthEnvStatus = useQuery({
    queryKey: ['settings', 'oauth-env-status'],
    queryFn: () => api.get<OauthEnvStatus>('/settings/oauth-env/status'),
    select: (res) => res.data,
    enabled: oauthEnabled,
  })

  // Schedule config state
  const [scheduleEnabled, setScheduleEnabled] = useState(() => channelInitiallyOn('schedule'))
  /**
   * The persisted schedules, or one blank default.
   *
   * Read once at mount to seed both the list and the editor fields below.
   * Readiness substitutes the *editor* fields for the active row, so seeding
   * the list alone would still have left a configured schedule card disabled
   * on the first paint.
   */
  const persistedSchedules = normalizeSchedulePublishConfigs(agent?.scheduleConfig)
  /**
   * Editor seed — deliberately only from a *persisted* schedule.
   *
   * `createDefaultScheduleConfig()` carries a placeholder cron (`0 9 * * *`)
   * that the list needs as a blank row but the editor must not show: pre-filling
   * the advanced cron box for an agent that has no schedule leaves the user
   * typing into a field that already has content.
   */
  const initialSchedule = persistedSchedules[0] ?? null
  const initialSchedulePreset = cronToPreset(initialSchedule?.cron ?? '')

  const [scheduleConfigs, setScheduleConfigs] = useState<SchedulePublishConfig[]>(() =>
    persistedSchedules.length > 0 ? persistedSchedules : [createDefaultScheduleConfig()],
  )
  const [activeScheduleIndex, setActiveScheduleIndex] = useState(0)
  const [scheduleMode, setScheduleMode] = useState<'preset' | 'advanced'>(
    initialSchedule && !initialSchedulePreset ? 'advanced' : 'preset',
  )
  const [scheduleCron, setScheduleCron] = useState(() => initialSchedule?.cron ?? '')
  const [scheduleIntent, setScheduleIntent] = useState(() => initialSchedule?.intent ?? '')
  const [scheduleTimezone, setScheduleTimezone] = useState(
    () => initialSchedule?.timezone ?? 'Asia/Shanghai',
  )
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>(
    () => initialSchedulePreset?.preset ?? 'daily',
  )
  const [scheduleTime, setScheduleTime] = useState(() => initialSchedulePreset?.time ?? '09:00')
  const [scheduleWeekday, setScheduleWeekday] = useState(() => initialSchedulePreset?.weekday ?? 1)
  const [scheduleMonthDay, setScheduleMonthDay] = useState(
    () => initialSchedulePreset?.monthDay ?? 1,
  )
  // 定时任务以归属人 SSO 身份过网关（仅 gateway 接入 + schedule 渠道有意义）
  // Seeded too: `openChannelHasPublishOnlySettings` diffs this against the
  // persisted value, so a false start would flash the "publish required" hint.
  const [scheduleRunAsOwner, setScheduleRunAsOwner] = useState(() =>
    Boolean(agent?.scheduleRunAsOwner),
  )

  // ── Git repository trigger channels (glab / gh) ───────────────────────────
  // Two independent channels sharing one state shape; `gitTriggerState` keys by
  // provider so adding a third forge later needs no new state variables.
  const [glabEnabled, setGlabEnabled] = useState(() => channelInitiallyOn('glab'))
  const [ghEnabled, setGhEnabled] = useState(() => channelInitiallyOn('gh'))
  const gitTriggerDefaultIntent: Record<GitTriggerProvider, string> = {
    glab: resolveGitTriggerIntentDefault('glab', t),
    gh: resolveGitTriggerIntentDefault('gh', t),
  }
  const [gitTriggerState, setGitTriggerState] = useState<
    Record<GitTriggerProvider, GitTriggerDraft>
    // Seeded from the agent for the same reason as the toggles: a card whose
    // switch is gated on readiness would otherwise render disabled for a frame
    // before the persisted config arrived.
  >(() => ({
    glab: toGitTriggerDraft(agent?.glabConfig, gitTriggerDefaultIntent.glab),
    gh: toGitTriggerDraft(agent?.ghConfig, gitTriggerDefaultIntent.gh),
  }))
  const [gitTriggerCliStatus, setGitTriggerCliStatus] = useState<
    Record<GitTriggerProvider, GitTriggerCliStatus | null>
  >({ glab: null, gh: null })
  const [gitTriggerCliLoading, setGitTriggerCliLoading] = useState<
    Record<GitTriggerProvider, boolean>
  >({ glab: false, gh: false })

  const patchGitTrigger = (provider: GitTriggerProvider, patch: Partial<GitTriggerDraft>) => {
    setGitTriggerState((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }))
  }

  /**
   * Probes whether the CLI is installed and authenticated.
   *
   * Uses the FIRST configured repo's host: `glab auth status` reports every
   * configured host at once, so asking without a host would answer "some host
   * is logged in", which is not the question — the poll will use this repo's
   * host specifically.
   */
  const checkGitTriggerCli = async (provider: GitTriggerProvider) => {
    if (!agentId) return
    setGitTriggerCliLoading((prev) => ({ ...prev, [provider]: true }))
    try {
      const host = gitTriggerState[provider].repos.find((repo) => repo.host.trim())?.host.trim()
      const status = await fetchGitTriggerCliStatus(agentId, provider, host)
      setGitTriggerCliStatus((prev) => ({ ...prev, [provider]: status }))
    } catch (err) {
      console.error('Failed to probe git trigger CLI:', err)
      message.error(t('agentPublish.gitTriggerCliProbeFailed'))
    } finally {
      setGitTriggerCliLoading((prev) => ({ ...prev, [provider]: false }))
    }
  }

  const buildGitTriggerConfig = (provider: GitTriggerProvider) => {
    const draft = gitTriggerState[provider]
    return {
      provider,
      repos: draft.repos
        .filter((repo) => repo.project.trim())
        .map((repo) => ({
          scope: repo.scope ?? 'project',
          project: repo.project.trim(),
          ...(repo.host.trim() ? { host: repo.host.trim() } : {}),
        })),
      events: draft.events,
      intervalSeconds: draft.intervalSeconds,
      intent: draft.intent.trim(),
      targetBranches: draft.targetBranches
        .split(',')
        .map((branch) => branch.trim())
        .filter(Boolean),
      ignoreDrafts: draft.ignoreDrafts,
    }
  }
  const { data: currentUser } = useCurrentUser()
  const { data: oauthConfig } = useOauthConfig()
  // 「绑定身份」按钮在任一 SSO 方式可用时可用（oidc / saml）。
  // 取第一个方式发起 bind；oidc/saml 走服务端回调的 bind 分支。
  const bindMethod = resolveSsoMethods(oauthConfig)[0] ?? null

  const isPublished = agent?.publishStatus === 'published'
  const isStopped = agent?.publishStatus === 'stopped'
  const isEditMode = !!agent && agent.publishStatus !== 'draft'

  /**
   * Whether each chat channel has *persisted* credentials. Read from the agent
   * rather than the form so a fresh draft — where nothing was ever configured —
   * renders no connection pill at all instead of three "not connected" rows.
   */
  const persistedChannelConfigured: Record<ConnectedChannelKey, boolean> = {
    feishu: !!agent?.feishuConfig,
    slack: !!agent?.slackConfig,
    discord: !!agent?.discordConfig,
    qq_official: !!agent?.qqOfficialConfig,
  }

  // Live socket state for the Feishu / Slack / Discord cards. Polling is gated:
  // an Agent with no chat channel configured or enabled renders no pill, so it
  // must not pay for two 15s polls.
  const hasAnyChatChannel =
    persistedChannelConfigured.feishu ||
    persistedChannelConfigured.slack ||
    persistedChannelConfigured.discord ||
    persistedChannelConfigured.qq_official ||
    !!agent?.publishChannels?.some(isConnectedChannel)
  const {
    connections: chatConnections,
    isLoading: chatConnectionsLoading,
    errorByChannel: chatConnectionErrors,
  } = useNativeChatConnections({ enabled: hasAnyChatChannel })

  const loadScheduleIntoEditor = (config: SchedulePublishConfig) => {
    setScheduleCron(config.cron ?? '')
    setScheduleIntent(config.intent ?? '')
    setScheduleTimezone(config.timezone ?? 'Asia/Shanghai')
    const parsed = cronToPreset(config.cron ?? '')
    if (parsed) {
      setScheduleMode('preset')
      setSchedulePreset(parsed.preset)
      setScheduleTime(parsed.time)
      if (parsed.weekday !== undefined) setScheduleWeekday(parsed.weekday)
      if (parsed.monthDay !== undefined) setScheduleMonthDay(parsed.monthDay)
    } else {
      setScheduleMode('advanced')
    }
  }

  const buildCurrentScheduleConfig = (): SchedulePublishConfig => ({
    id: scheduleConfigs[activeScheduleIndex]?.id ?? createScheduleId(),
    cron: activeScheduleCron,
    intent: scheduleIntent,
    timezone: scheduleTimezone,
  })

  const syncCurrentScheduleConfig = () => {
    setScheduleConfigs((items) =>
      items.map((item, index) =>
        index === activeScheduleIndex ? buildCurrentScheduleConfig() : item,
      ),
    )
  }

  const buildScheduleConfigsForPublish = (): SchedulePublishConfig[] =>
    scheduleConfigs.map((item, index) =>
      index === activeScheduleIndex ? buildCurrentScheduleConfig() : item,
    )

  const selectScheduleConfig = (index: number) => {
    if (index === activeScheduleIndex) return
    const synced = buildScheduleConfigsForPublish()
    const next = synced[index]
    if (!next) return
    setScheduleConfigs(synced)
    setActiveScheduleIndex(index)
    loadScheduleIntoEditor(next)
  }

  const addScheduleConfig = () => {
    const synced = buildScheduleConfigsForPublish()
    const nextSchedule = createDefaultScheduleConfig()
    setScheduleConfigs([...synced, nextSchedule])
    setActiveScheduleIndex(synced.length)
    loadScheduleIntoEditor(nextSchedule)
  }

  const removeScheduleConfig = (index: number) => {
    if (scheduleConfigs.length <= 1) return
    const synced = buildScheduleConfigsForPublish()
    const next = synced.filter((_, itemIndex) => itemIndex !== index)
    const nextIndex =
      index === activeScheduleIndex
        ? Math.min(index, next.length - 1)
        : index < activeScheduleIndex
          ? activeScheduleIndex - 1
          : activeScheduleIndex
    setScheduleConfigs(next)
    setActiveScheduleIndex(nextIndex)
    loadScheduleIntoEditor(next[nextIndex])
  }

  // Key 在 agent 创建时即生成；detail 返回统一脱敏为 '********'，明文永不回显。
  // 因此这里只判断"是否已存在 key"，明文仅由 regenerate 接口一次性返回并弹 modal 展示。
  const hasExistingKey = !!agent?.endpointApiKey || keyGenerated
  const a2aHasExistingKey = !!agent?.a2aEndpointApiKey || a2aKeyGenerated

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
  const invokeUrl = agentId ? `${baseUrl}/api/gateway/${agentId}/invoke` : ''
  const oauthInvokeUrl = agentId ? `${baseUrl}/api/oauth/${agentId}/invoke` : ''
  const chatAppUrl = agentId ? `${baseUrl}/agents/${agentId}/chat_app` : ''
  const a2aCardUrl = agentId ? `${baseUrl}/api/a2a/${agentId}/.well-known/agent-card.json` : ''
  const a2aRpcUrl = agentId ? `${baseUrl}/api/a2a/${agentId}` : ''

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload persisted publish config only when the agent changes; loadScheduleIntoEditor is a setter bundle.
  useEffect(() => {
    if (agent) {
      setIpWhitelistStr((agent.publishIpWhitelist ?? []).join('\n'))
      setDescription(agent.publishDescription ?? '')
      // agent 真正重载（如发布后 invalidate）时复位本地 key 标记，回到服务端真值。
      setKeyGenerated(false)
      setA2aKeyGenerated(false)
      const at = agent.publishAuthType as string | null | undefined
      setAuthType(at === 'none' ? 'none' : 'api_key')
      setA2aAuthType(agent.a2aAuthType === 'none' ? 'none' : 'api_key')
      setTrustForwardedIdentity(Boolean(agent.trustForwardedIdentity))

      const channels = agent.publishChannels ?? []
      setA2aEnabled(channels.includes('a2a'))
      setFeishuEnabled(channels.includes('feishu'))
      setSlackEnabled(channels.includes('slack'))
      setDiscordEnabled(channels.includes('discord'))
      setQQOfficialEnabled(channels.includes('qq_official'))
      setScheduleEnabled(channels.includes('schedule'))
      setScheduleRunAsOwner(Boolean(agent.scheduleRunAsOwner))
      setOauthEnabled(channels.includes('oauth'))
      setChatAppEnabled(channels.includes('chat_app'))
      setGlabEnabled(channels.includes('glab'))
      setGhEnabled(channels.includes('gh'))
      setGitTriggerState({
        glab: toGitTriggerDraft(agent.glabConfig, gitTriggerDefaultIntent.glab),
        gh: toGitTriggerDraft(agent.ghConfig, gitTriggerDefaultIntent.gh),
      })
      // Main reshaped OAuth access mode into an allowlist; that version is kept.
      const persisted = agent as Agent & {
        oauthAccessMode?: 'all_idaas_users' | 'specified_users'
        oauthAllowedEmails?: string[] | null
      }
      setOauthAccessMode(
        persisted.oauthAccessMode === 'specified_users' ? 'specified_users' : 'all_idaas_users',
      )
      setOauthAllowedEmails(persisted.oauthAllowedEmails ?? [])

      const raw: PersistedFeishuConfig | null | undefined = agent.feishuConfig
      if (raw) {
        // 兼容旧配置：旧字段 triggerOnAt / triggerOnNewMessage / replyMode → 新 group* / topic* 结构
        const isLegacy = !('groupTriggerOnAt' in raw) && !('groupReplyMode' in raw)
        setFeishuAppId(raw.appId ?? '')
        // 不把脱敏掩码灌进输入框（否则点"显示"看到的只是星号）。已配置时输入框留空，
        // 用 placeholder 提示；提交时为空则回传 '********' 让后端保持原值不变。
        const savedSecret = raw.appSecret ?? ''
        setFeishuSecretExists(savedSecret.length > 0)
        // 详情接口回传明文 App Secret：加载真实值，默认以 8 个圆点遮罩，点眼睛查看。
        setFeishuAppSecret(savedSecret)
        const gTriggerOnAt = isLegacy ? (raw.triggerOnAt ?? true) : (raw.groupTriggerOnAt ?? true)
        const gTriggerOnNewMsg = isLegacy
          ? (raw.triggerOnNewMessage ?? false)
          : (raw.groupTriggerOnNewMessage ?? false)
        const gReplyMode = isLegacy ? (raw.replyMode ?? 'quote') : (raw.groupReplyMode ?? 'quote')

        setGroupTriggerOnAt(gTriggerOnAt)
        setGroupTriggerOnNewMessage(gTriggerOnNewMsg)
        setGroupReplyMode(gReplyMode)

        // 对齐：触发时机——普通群「群内新增消息」↔ 话题群「新增话题」
        setTopicTriggerOnAt(
          isLegacy ? (raw.triggerOnAt ?? true) : (raw.topicTriggerOnAt ?? gTriggerOnAt),
        )
        setTopicTriggerOnNewTopic(raw.topicTriggerOnNewTopic ?? gTriggerOnNewMsg)
        setTopicTriggerOnNewComment(raw.topicTriggerOnNewComment ?? false)
        // 对齐：回复方式——普通群有回复则话题群默认回复，普通群 none 则话题群也 none
        setTopicReplyMode(raw.topicReplyMode ?? (gReplyMode === 'none' ? 'none' : 'topic_reply'))
        setTopicReplyMentionTarget(raw.topicReplyMentionTarget ?? 'trigger_sender')
        setTopicInjectRootMessage(raw.topicInjectRootMessage ?? false)
        // P2P：与后端 normalizeFeishuConfig 对齐——只要 raw.replyMode 存在即作 legacy fallback，
        // 不区分 isLegacy。否则前端会显示 'quote' 而后端 normalize 出 'new'，保存时静默覆盖。
        setP2pReplyMode(raw.p2pReplyMode ?? raw.replyMode ?? 'quote')
        setFeishuReplyContentType(raw.replyContentType ?? 'text')
        setFeishuCardTemplateId(raw.cardTemplateId ?? '')
        setFeishuDebugShowSessionId(raw.debugShowSessionId ?? false)
        setFeishuDebugShowProvider(raw.debugShowProvider ?? false)
        setFeishuDebugShowModel(raw.debugShowModel ?? false)
        setFeishuSendArtifactsAsFile(raw.sendArtifactsAsFile ?? true)
        setFeishuFetchUserInfo(raw.fetchUserInfo ?? false)
        setFeishuWelcomeMessage(raw.welcomeMessage ?? '')
        setFeishuWelcomeOnP2pEnabled(raw.welcomeOnP2pEnabled ?? false)
        setFeishuWelcomeP2pIdleDays(raw.welcomeP2pIdleDays ?? 7)
        setFeishuWelcomeOnGroupAddedEnabled(raw.welcomeOnGroupAddedEnabled ?? false)
      }

      const savedSlack = agent.slackConfig
      if (savedSlack) {
        setSlackAppId(savedSlack.appId)
        setSlackAppToken(savedSlack.appToken)
        setSlackBotToken(savedSlack.botToken)
        setSlackGroupTriggerOnAt(savedSlack.groupTriggerOnAt)
        setSlackGroupTriggerOnNewMessage(savedSlack.groupTriggerOnNewMessage)
        setSlackGroupReplyMode(savedSlack.groupReplyMode)
        setSlackP2pReplyMode(savedSlack.p2pReplyMode)
        setSlackSendArtifactsAsFile(savedSlack.sendArtifactsAsFile ?? true)
      }

      const savedDiscord = agent.discordConfig
      if (savedDiscord) {
        setDiscordApplicationId(savedDiscord.applicationId)
        setDiscordBotToken(savedDiscord.botToken)
        setDiscordGuildTriggerOnMention(savedDiscord.guildTriggerOnMention)
        setDiscordGuildTriggerOnNewMessage(savedDiscord.guildTriggerOnNewMessage)
        setDiscordGuildReplyMode(savedDiscord.guildReplyMode)
        setDiscordDmReplyMode(savedDiscord.dmReplyMode)
        setDiscordSendArtifactsAsFile(savedDiscord.sendArtifactsAsFile ?? true)
      }

      const savedQQOfficial = agent.qqOfficialConfig
      setQQOfficialAppId(savedQQOfficial?.appId ?? '')
      setQQOfficialAppSecret(savedQQOfficial?.appSecret ?? '')
      setQQGroupTriggerOnAt(savedQQOfficial?.groupTriggerOnAt ?? true)
      setQQGroupReplyMode(savedQQOfficial?.groupReplyMode ?? 'reply')
      setQQC2cReplyMode(savedQQOfficial?.c2cReplyMode ?? 'reply')
      setQQSendArtifactsAsFile(savedQQOfficial?.sendArtifactsAsFile ?? true)

      // Hydrate unconditionally, falling back to defaults when the stored config is
      // null. Guarding on truthiness left the previous copy in the form after the
      // channel was disabled (which clears the column), so re-enabling it without
      // leaving the tab resurrected the supposedly-cleared title, welcome text and
      // questions — and republished them.
      const savedChatApp = agent.chatAppConfig
      setChatAppDisplayName(savedChatApp?.displayName ?? '')
      setChatAppWelcomeMessage(savedChatApp?.welcomeMessage ?? '')
      // Stored as an array, edited as one-per-line text.
      setChatAppSuggestedQuestions((savedChatApp?.suggestedQuestions ?? []).join('\n'))
      setChatAppShowCreator(savedChatApp?.showCreator ?? true)
      setChatAppAllowAttachments(savedChatApp?.allowAttachments ?? true)
      setChatAppShowThinking(savedChatApp?.showThinking ?? true)

      const schedConfigs = normalizeSchedulePublishConfigs(agent.scheduleConfig)
      if (schedConfigs.length > 0) {
        setScheduleConfigs(schedConfigs)
        setActiveScheduleIndex(0)
        loadScheduleIntoEditor(schedConfigs[0])
      } else {
        const fallbackSchedule = createDefaultScheduleConfig()
        setScheduleConfigs([fallbackSchedule])
        setActiveScheduleIndex(0)
        loadScheduleIntoEditor(fallbackSchedule)
      }
    }
  }, [agent])

  // ── 发布设置草稿（非凭证）──────────────────────────────────────────────
  // 后端配置是真值，草稿叠加「未保存改动」；刷新/误关不丢。凭证不落本地：appSecret 不进草稿。
  // 保存/发布后清理。restore effect 声明在 config-load effect 之后，确保草稿覆盖在已加载配置之上。
  const publishDraftKey = agentId ? `draft-publish:${agentId}` : null
  // key → setter 映射：序列化与恢复同源，避免漏字段。
  const draftSetters: Record<string, (v: unknown) => void> = {
    ipWhitelistStr: (v) => setIpWhitelistStr(v as string),
    description: (v) => setDescription(v as string),
    authType: (v) => setAuthType(v as 'none' | 'api_key'),
    a2aAuthType: (v) => setA2aAuthType(v as 'none' | 'api_key'),
    trustForwardedIdentity: (v) => setTrustForwardedIdentity(v as boolean),
    a2aEnabled: (v) => setA2aEnabled(v as boolean),
    feishuEnabled: (v) => setFeishuEnabled(v as boolean),
    slackEnabled: (v) => setSlackEnabled(v as boolean),
    discordEnabled: (v) => setDiscordEnabled(v as boolean),
    qqOfficialEnabled: (v) => setQQOfficialEnabled(v as boolean),
    chatAppEnabled: (v) => setChatAppEnabled(v as boolean),
    chatAppDisplayName: (v) => setChatAppDisplayName(v as string),
    chatAppWelcomeMessage: (v) => setChatAppWelcomeMessage(v as string),
    chatAppSuggestedQuestions: (v) => setChatAppSuggestedQuestions(v as string),
    chatAppShowCreator: (v) => setChatAppShowCreator(v as boolean),
    chatAppAllowAttachments: (v) => setChatAppAllowAttachments(v as boolean),
    chatAppShowThinking: (v) => setChatAppShowThinking(v as boolean),
    oauthEnabled: (v) => setOauthEnabled(v as boolean),
    oauthAccessMode: (v) =>
      setOauthAccessMode(v === 'specified_users' ? 'specified_users' : 'all_idaas_users'),
    oauthAllowedEmails: (v) => setOauthAllowedEmails(v as string[]),
    scheduleEnabled: (v) => setScheduleEnabled(v as boolean),
    feishuAppId: (v) => setFeishuAppId(v as string),
    groupTriggerOnAt: (v) => setGroupTriggerOnAt(v as boolean),
    groupTriggerOnNewMessage: (v) => setGroupTriggerOnNewMessage(v as boolean),
    groupReplyMode: (v) => setGroupReplyMode(v as 'quote' | 'new' | 'none'),
    topicTriggerOnAt: (v) => setTopicTriggerOnAt(v as boolean),
    topicTriggerOnNewTopic: (v) => setTopicTriggerOnNewTopic(v as boolean),
    topicTriggerOnNewComment: (v) => setTopicTriggerOnNewComment(v as boolean),
    topicReplyMode: (v) => setTopicReplyMode(v as 'topic_reply' | 'none'),
    topicReplyMentionTarget: (v) =>
      setTopicReplyMentionTarget(v as 'trigger_sender' | 'topic_creator' | 'none'),
    topicInjectRootMessage: (v) => setTopicInjectRootMessage(v as boolean),
    p2pReplyMode: (v) => setP2pReplyMode(v as 'quote' | 'new' | 'none'),
    feishuReplyContentType: (v) =>
      setFeishuReplyContentType(
        v as 'text' | 'post' | 'interactive' | 'interactive_card' | 'streaming_card',
      ),
    feishuCardTemplateId: (v) => setFeishuCardTemplateId(v as string),
    feishuDebugShowSessionId: (v) => setFeishuDebugShowSessionId(v as boolean),
    feishuDebugShowProvider: (v) => setFeishuDebugShowProvider(v as boolean),
    feishuDebugShowModel: (v) => setFeishuDebugShowModel(v as boolean),
    feishuSendArtifactsAsFile: (v) => setFeishuSendArtifactsAsFile(v as boolean),
    feishuFetchUserInfo: (v) => setFeishuFetchUserInfo(v as boolean),
    feishuWelcomeMessage: (v) => setFeishuWelcomeMessage(v as string),
    feishuWelcomeOnP2pEnabled: (v) => setFeishuWelcomeOnP2pEnabled(v as boolean),
    feishuWelcomeP2pIdleDays: (v) => setFeishuWelcomeP2pIdleDays(v as number),
    feishuWelcomeOnGroupAddedEnabled: (v) => setFeishuWelcomeOnGroupAddedEnabled(v as boolean),
    slackAppId: (v) => setSlackAppId(v as string),
    slackGroupTriggerOnAt: (v) => setSlackGroupTriggerOnAt(v as boolean),
    slackGroupTriggerOnNewMessage: (v) => setSlackGroupTriggerOnNewMessage(v as boolean),
    slackGroupReplyMode: (v) => setSlackGroupReplyMode(v as 'thread' | 'new' | 'none'),
    slackP2pReplyMode: (v) => setSlackP2pReplyMode(v as 'new' | 'none'),
    discordApplicationId: (v) => setDiscordApplicationId(v as string),
    discordGuildTriggerOnMention: (v) => setDiscordGuildTriggerOnMention(v as boolean),
    discordGuildTriggerOnNewMessage: (v) => setDiscordGuildTriggerOnNewMessage(v as boolean),
    discordGuildReplyMode: (v) => setDiscordGuildReplyMode(v as 'reply' | 'new' | 'none'),
    discordDmReplyMode: (v) => setDiscordDmReplyMode(v as 'reply' | 'none'),
    qqOfficialAppId: (v) => setQQOfficialAppId(v as string),
    qqGroupTriggerOnAt: (v) => setQQGroupTriggerOnAt(v as boolean),
    qqGroupReplyMode: (v) => setQQGroupReplyMode(v as 'reply' | 'new' | 'none'),
    qqC2cReplyMode: (v) => setQQC2cReplyMode(v as 'reply' | 'new' | 'none'),
    qqSendArtifactsAsFile: (v) => setQQSendArtifactsAsFile(v as boolean),
    scheduleConfigs: (v) => {
      const configs = normalizeSchedulePublishConfigs(
        v as SchedulePublishConfig | SchedulePublishConfig[] | null,
      )
      if (configs.length > 0) {
        setScheduleConfigs(configs)
        setActiveScheduleIndex(0)
        loadScheduleIntoEditor(configs[0])
      }
    },
    activeScheduleIndex: (v) => {
      if (typeof v === 'number') setActiveScheduleIndex(v)
    },
    scheduleMode: (v) => setScheduleMode(v as 'preset' | 'advanced'),
    scheduleCron: (v) => setScheduleCron(v as string),
    scheduleIntent: (v) => setScheduleIntent(v as string),
    scheduleTimezone: (v) => setScheduleTimezone(v as string),
    schedulePreset: (v) => setSchedulePreset(v as SchedulePreset),
    scheduleTime: (v) => setScheduleTime(v as string),
    scheduleWeekday: (v) => setScheduleWeekday(v as number),
    scheduleMonthDay: (v) => setScheduleMonthDay(v as number),
    scheduleRunAsOwner: (v) => setScheduleRunAsOwner(v as boolean),
  }
  const publishDraftRef = useRef<Record<string, unknown>>({})
  publishDraftRef.current = {
    ipWhitelistStr,
    description,
    authType,
    a2aAuthType,
    trustForwardedIdentity,
    a2aEnabled,
    feishuEnabled,
    slackEnabled,
    discordEnabled,
    qqOfficialEnabled,
    chatAppEnabled,
    chatAppDisplayName,
    chatAppWelcomeMessage,
    chatAppSuggestedQuestions,
    chatAppShowCreator,
    chatAppAllowAttachments,
    chatAppShowThinking,
    oauthEnabled,
    oauthAccessMode,
    // Must be in the snapshot, not just in draftSetters: without it a refresh restores the
    // mode but resets the list to the server value. Migrated Agents start on an empty list, so
    // that asymmetry silently discards exactly the roster the owner came here to enter.
    oauthAllowedEmails,
    scheduleEnabled,
    feishuAppId,
    groupTriggerOnAt,
    groupTriggerOnNewMessage,
    groupReplyMode,
    topicTriggerOnAt,
    topicTriggerOnNewTopic,
    topicTriggerOnNewComment,
    topicReplyMode,
    topicReplyMentionTarget,
    topicInjectRootMessage,
    p2pReplyMode,
    feishuReplyContentType,
    feishuCardTemplateId,
    feishuDebugShowSessionId,
    feishuDebugShowProvider,
    feishuDebugShowModel,
    feishuSendArtifactsAsFile,
    feishuFetchUserInfo,
    feishuWelcomeMessage,
    feishuWelcomeOnP2pEnabled,
    feishuWelcomeP2pIdleDays,
    feishuWelcomeOnGroupAddedEnabled,
    slackAppId,
    slackGroupTriggerOnAt,
    slackGroupTriggerOnNewMessage,
    slackGroupReplyMode,
    slackP2pReplyMode,
    discordApplicationId,
    discordGuildTriggerOnMention,
    discordGuildTriggerOnNewMessage,
    discordGuildReplyMode,
    discordDmReplyMode,
    qqOfficialAppId,
    qqGroupTriggerOnAt,
    qqGroupReplyMode,
    qqC2cReplyMode,
    qqSendArtifactsAsFile,
    scheduleConfigs,
    activeScheduleIndex,
    scheduleMode,
    scheduleCron,
    scheduleIntent,
    scheduleTimezone,
    schedulePreset,
    scheduleTime,
    scheduleWeekday,
    scheduleMonthDay,
    scheduleRunAsOwner,
  }

  const serializedPublishDraft = JSON.stringify(publishDraftRef.current)
  // 基线 = 「后端配置 + 已恢复草稿」稳定后的快照；只有用户在此之后的真实改动才写草稿，
  // 避免把加载/恢复阶段的 setState 误当成改动而覆盖。
  const publishBaselineRef = useRef<string | null>(null)

  const clearPublishDraft = () => {
    if (publishDraftKey) localStorage.removeItem(publishDraftKey)
    // 重置基线为当前快照，避免清理后 save-on-change 立刻把旧值再写回。
    publishBaselineRef.current = serializedPublishDraft
  }

  // 草稿覆盖在「后端配置」之上。声明在 config-load effect 之后 → 每次 agent 变化都在加载后
  // 重新覆盖，避免 StrictMode 双调用或 agent 重取时 load 把恢复结果冲掉（故意不加一次性守卫）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftSetters 为稳定 setter 组合，仅以 agent/key 为触发
  useEffect(() => {
    if (!agent || !publishDraftKey) return
    const saved = localStorage.getItem(publishDraftKey)
    if (saved) {
      try {
        const data = JSON.parse(saved) as Record<string, unknown>
        for (const [k, set] of Object.entries(draftSetters)) {
          if (data[k] !== undefined) set(data[k])
        }
      } catch {
        localStorage.removeItem(publishDraftKey)
      }
    }
    // 等加载+恢复的 setState 落定后再设基线（下一拍），此后才把改动写入草稿。只设一次。
    if (publishBaselineRef.current === null) {
      window.setTimeout(() => {
        publishBaselineRef.current = JSON.stringify(publishDraftRef.current)
      }, 0)
    }
  }, [agent, publishDraftKey])

  // save-on-change：基线设定后，用户每次改动即时写本地草稿（凭证已排除在快照外）。
  // 不用 unmount/beforeunload 保存——它们在 StrictMode/编程式跳转下会用过期空值覆盖草稿。
  useEffect(() => {
    if (!publishDraftKey || publishBaselineRef.current === null) return
    if (serializedPublishDraft !== publishBaselineRef.current) {
      safeSetItem(publishDraftKey, serializedPublishDraft)
    }
  }, [publishDraftKey, serializedPublishDraft])

  const buildChannels = () => {
    const channels: string[] = ['api']
    if (a2aEnabled) channels.push('a2a')
    if (feishuEnabled) channels.push('feishu')
    if (slackEnabled) channels.push('slack')
    if (discordEnabled) channels.push('discord')
    if (qqOfficialEnabled) channels.push('qq_official')
    if (scheduleEnabled) channels.push('schedule')
    if (oauthEnabled) channels.push('oauth')
    if (chatAppEnabled) channels.push('chat_app')
    if (glabEnabled) channels.push('glab')
    if (ghEnabled) channels.push('gh')
    return channels
  }

  const activeScheduleCron =
    scheduleMode === 'preset'
      ? presetToCron(schedulePreset, scheduleTime, scheduleWeekday, scheduleMonthDay)
      : scheduleCron.trim()
  // Not gated on scheduleEnabled: the config form is now reachable before the
  // channel is switched on, and a cron typed there should be validated
  // immediately rather than staying silently wrong until the switch is flipped.
  const isScheduleCronInvalid =
    activeScheduleCron.length > 0 && !isSupportedScheduleCron(activeScheduleCron)

  // Syncs the editor back into the active list entry. Runs regardless of
  // scheduleEnabled — the config dialog is reachable while the channel is off,
  // and edits made there must still reach scheduleConfigs, or a per-channel
  // save would persist the previous values.
  useEffect(() => {
    setScheduleConfigs((items) =>
      items.map((item, index) =>
        index === activeScheduleIndex
          ? {
              ...item,
              cron: activeScheduleCron,
              intent: scheduleIntent,
              timezone: scheduleTimezone,
            }
          : item,
      ),
    )
  }, [activeScheduleIndex, activeScheduleCron, scheduleIntent, scheduleTimezone])

  // ── Per-channel config builders ────────────────────────────────────────
  // Shared by handlePublish (whole payload) and saveChannel (one channel), so
  // the two paths can never serialise the same channel differently.
  const buildFeishuConfig = (): FeishuPublishConfig => ({
    appId: feishuAppId,
    // 留空且已配置 → 回传脱敏哨兵，后端识别为"保持原值不变"。
    appSecret: feishuAppSecret || (feishuSecretExists ? '********' : ''),
    groupTriggerOnAt,
    groupTriggerOnNewMessage,
    groupReplyMode,
    topicTriggerOnAt,
    topicTriggerOnNewTopic,
    topicTriggerOnNewComment,
    topicReplyMode,
    topicReplyMentionTarget,
    topicInjectRootMessage,
    p2pReplyMode,
    replyContentType: feishuReplyContentType,
    cardTemplateId: feishuCardTemplateId || undefined,
    debugShowSessionId: feishuDebugShowSessionId,
    debugShowProvider: feishuDebugShowProvider,
    debugShowModel: feishuDebugShowModel,
    sendArtifactsAsFile: feishuSendArtifactsAsFile,
    fetchUserInfo: feishuFetchUserInfo,
    welcomeMessage: feishuWelcomeMessage.trim() || undefined,
    welcomeOnP2pEnabled: feishuWelcomeOnP2pEnabled,
    welcomeP2pIdleDays: feishuWelcomeP2pIdleDays,
    welcomeOnGroupAddedEnabled: feishuWelcomeOnGroupAddedEnabled,
  })

  const buildSlackConfig = (): SlackPublishConfig => ({
    appId: slackAppId,
    appToken: slackAppToken,
    botToken: slackBotToken,
    groupTriggerOnAt: slackGroupTriggerOnAt,
    groupTriggerOnNewMessage: slackGroupTriggerOnNewMessage,
    groupReplyMode: slackGroupReplyMode,
    p2pReplyMode: slackP2pReplyMode,
    sendArtifactsAsFile: slackSendArtifactsAsFile,
  })

  const buildDiscordConfig = (): DiscordPublishConfig => ({
    applicationId: discordApplicationId,
    botToken: discordBotToken,
    guildTriggerOnMention: discordGuildTriggerOnMention,
    guildTriggerOnNewMessage: discordGuildTriggerOnNewMessage,
    guildReplyMode: discordGuildReplyMode,
    dmReplyMode: discordDmReplyMode,
    sendArtifactsAsFile: discordSendArtifactsAsFile,
  })

  const buildQQOfficialConfig = (): QQOfficialPublishConfig => ({
    appId: qqOfficialAppId.trim(),
    appSecret: qqOfficialAppSecret,
    groupTriggerOnAt: qqGroupTriggerOnAt,
    groupReplyMode: qqGroupReplyMode,
    c2cReplyMode: qqC2cReplyMode,
    sendArtifactsAsFile: qqSendArtifactsAsFile,
  })

  const buildChatAppConfig = (): ChatAppPublishConfig => ({
    displayName: chatAppDisplayName.trim() || undefined,
    welcomeMessage: chatAppWelcomeMessage.trim() || undefined,
    suggestedQuestions: parseSuggestedQuestions(chatAppSuggestedQuestions),
    showCreator: chatAppShowCreator,
    allowAttachments: chatAppAllowAttachments,
    showThinking: chatAppShowThinking,
  })

  /** Config for one channel, or null when that channel has nothing to persist. */
  const buildChannelConfig = (channel: ConfigurableChannel) => {
    switch (channel) {
      case 'feishu':
        return buildFeishuConfig()
      case 'slack':
        return buildSlackConfig()
      case 'discord':
        return buildDiscordConfig()
      case 'qq_official':
        return buildQQOfficialConfig()
      case 'chat_app':
        return buildChatAppConfig()
      case 'glab':
        return buildGitTriggerConfig('glab')
      case 'gh':
        return buildGitTriggerConfig('gh')
      case 'schedule':
        return buildScheduleConfigsForPublish().map((config) => ({
          id: config.id ?? createScheduleId(),
          cron: config.cron.trim(),
          intent: config.intent,
          timezone: config.timezone,
        }))
      default:
        return null
    }
  }

  // ── Channel grid wiring ────────────────────────────────────────────────
  // The cards own enabling; the dialogs own configuring. Readiness is computed
  // from the same predicates handlePublish validates with, so a switch is never
  // enabled into a state publish would immediately reject.
  const channelEnabledMap: Record<ChannelKey, boolean> = {
    api: true,
    oauth: oauthEnabled,
    a2a: a2aEnabled,
    feishu: feishuEnabled,
    slack: slackEnabled,
    discord: discordEnabled,
    qq_official: qqOfficialEnabled,
    schedule: scheduleEnabled,
    chat_app: chatAppEnabled,
    glab: glabEnabled,
    gh: ghEnabled,
  }

  const readinessInput: ChannelReadinessInput = {
    feishuAppId,
    feishuAppSecret,
    feishuSecretExists,
    slackAppId,
    slackAppToken,
    slackBotToken,
    discordApplicationId,
    discordBotToken,
    qqOfficialAppId,
    qqOfficialAppSecret,
    oauthAccessMode,
    oauthAllowedEmails,
    scheduleConfigs: buildScheduleConfigsForPublish(),
    glab: toGitTriggerReadiness(gitTriggerState.glab),
    gh: toGitTriggerReadiness(gitTriggerState.gh),
  }

  const channelBlockReasons = Object.fromEntries(
    CHANNEL_REGISTRY.map((c) => [c.key, getChannelBlockReason(c.key, readinessInput)]),
  ) as Record<ChannelKey, string | null>

  const handleChannelToggle = (channel: ChannelKey, value: boolean) => {
    switch (channel) {
      case 'oauth':
        return setOauthEnabled(value)
      case 'a2a':
        return setA2aEnabled(value)
      // Feishu routes through its own handler: switching it on opens the
      // "existing app / create one" chooser.
      case 'feishu':
        return handleFeishuToggle(value)
      case 'slack':
        return setSlackEnabled(value)
      case 'discord':
        return setDiscordEnabled(value)
      case 'qq_official':
        return setQQOfficialEnabled(value)
      case 'schedule':
        return setScheduleEnabled(value)
      case 'chat_app':
        return setChatAppEnabled(value)
      case 'glab':
        return setGlabEnabled(value)
      case 'gh':
        return setGhEnabled(value)
      // 'api' is always on and renders no switch.
      default:
        return
    }
  }

  /**
   * Saves the open channel's config on its own, without publishing the agent.
   *
   * Only writes that channel's config column. Settings that live on flat agent
   * columns instead — `scheduleRunAsOwner`, and chat_app's "clear the column
   * when the channel is off" rule — cannot be expressed here, so they stay
   * with publish. `channelHasUnsavedSideSettings` warns the user rather than
   * letting Save quietly drop them.
   */
  const saveChannel = async () => {
    if (!agentId || !openChannel || !isConfigurableChannel(openChannel)) return
    const config = buildChannelConfig(openChannel)
    if (config === null) return
    try {
      await saveChannelConfig.mutateAsync({
        id: agentId,
        channel: openChannel,
        config,
      } as SaveChannelConfigVars)
      message.success(t('agentPublish.channelConfigSaved'))
      closeChannelModal()
    } catch {
      // The mutation surfaces its own error toast.
    }
  }

  /**
   * True when the open channel has settings that Save cannot persist, so the
   * dialog must tell the user to publish instead of implying Save covered
   * everything.
   *
   * - schedule: `scheduleRunAsOwner` is a flat agent column, not part of
   *   `scheduleConfig`.
   * - chat_app: disabling is meant to null the column (see handlePublish), but
   *   a per-channel save always writes an object.
   */
  const openChannelHasPublishOnlySettings =
    // Compare against what is persisted, not just "is it on". Checking the
    // current value alone hid the hint in the case that needs it most: with a
    // stored value of true, switching it OFF made the hint disappear while Save
    // still reported success and left run-as-owner enabled server-side.
    (openChannel === 'schedule' && scheduleRunAsOwner !== !!agent?.scheduleRunAsOwner) ||
    (openChannel === 'chat_app' && !chatAppEnabled)

  const handlePublish = async () => {
    // Same predicates the card switches gate on, so the two can never disagree
    // about whether a channel is publishable. Only *enabled* channels are
    // checked — a disabled channel's half-filled config is not an error.
    const blockReason = CHANNEL_REGISTRY.filter((c) => channelEnabledMap[c.key])
      .map((c) => channelBlockReasons[c.key])
      .find((reason) => reason !== null)
    if (blockReason) {
      message.error(t(blockReason))
      return
    }

    const scheduleConfigsForPublish = buildScheduleConfigsForPublish()

    const ipWhitelist = ipWhitelistStr
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    const channels = buildChannels()

    const needsFeishuConfig = shouldSubmitFeishuConfigForPublish({ feishuEnabled })
    const feishuConfig: FeishuPublishConfig | undefined = needsFeishuConfig
      ? buildFeishuConfig()
      : undefined

    const slackConfig: SlackPublishConfig | undefined = slackEnabled
      ? buildSlackConfig()
      : undefined
    const discordConfig: DiscordPublishConfig | undefined = discordEnabled
      ? buildDiscordConfig()
      : undefined
    const qqOfficialConfig: QQOfficialPublishConfig | undefined = qqOfficialEnabled
      ? buildQQOfficialConfig()
      : undefined

    // Explicit null when disabled — not undefined. The publish route only writes
    // the column when the key is present, so omitting it would strand the previous
    // welcome message and suggested questions in the DB with no way to clear them.
    const chatAppConfig: ChatAppPublishConfig | null = chatAppEnabled ? buildChatAppConfig() : null

    let scheduleConfig: SchedulePublishConfig | SchedulePublishConfig[] | null = null
    if (scheduleEnabled) {
      scheduleConfig = scheduleConfigsForPublish.map((config) => ({
        id: config.id ?? createScheduleId(),
        cron: config.cron.trim(),
        intent: config.intent,
        timezone: config.timezone,
      }))
    }

    // Explicit null when disabled, same reasoning as chatAppConfig: the publish
    // route only writes a column when the key is present, so omitting it would
    // strand a disabled channel's repo list in the DB.
    const glabConfig = glabEnabled ? buildGitTriggerConfig('glab') : null
    const ghConfig = ghEnabled ? buildGitTriggerConfig('gh') : null

    const config: PublishConfig = {
      authType,
      ipWhitelist,
      description: description.slice(0, DESCRIPTION_MAX),
      regenerateApiKey: authType === 'api_key' && isEditMode && hasExistingKey ? false : undefined,
      channels,
      oauthAccessMode,
      // Only meaningful under specified_users; the route nulls the column out otherwise.
      oauthAllowedEmails: oauthAccessMode === 'specified_users' ? oauthAllowedEmails : undefined,
      feishuConfig,
      slackConfig,
      discordConfig,
      qqOfficialConfig,
      chatAppConfig,
      scheduleConfig,
      glabConfig,
      ghConfig,
      a2aAuthType,
      // trust 仅在 api_key 下有意义；非 api_key 一律提交 false，避免脏数据。
      trustForwardedIdentity: a2aAuthType === 'api_key' ? trustForwardedIdentity : false,
      // run-as-owner 仅在 schedule 渠道下有意义；未启用时提交 false。
      scheduleRunAsOwner: scheduleEnabled ? scheduleRunAsOwner : false,
    }

    // API Key 与发布解耦：发布只保存配置，密钥由独立的「生成/重置」按钮管理。
    await onPublishConfirm(config)
    // 发布/更新成功后清理本地草稿（已落库，避免下次用旧草稿覆盖服务端真值）。
    clearPublishDraft()
  }

  const runGenerateKey = async () => {
    if (!agentId) return
    try {
      const res = await regenerateKey.mutateAsync(agentId)
      // 明文 key 仅此一次返回，弹 modal 让用户复制，关闭后即不再展示。
      if (res?.data?.endpointApiKey) {
        setGeneratedKey(res.data.endpointApiKey)
        setKeyGenerated(true)
      }
    } catch (err) {
      console.error('Failed to regenerate API key:', err)
    }
  }

  const handleGenerateKey = () => {
    if (!agentId) return
    // 已有 key 时再次生成会使旧 key 失效，先二次确认；否则直接生成。
    if (hasExistingKey) {
      confirm({
        title: t('agentPublish.resetKeyConfirmTitle'),
        content: t('agentPublish.resetKeyConfirmContent'),
        okText: t('agentPublish.resetKey'),
        danger: true,
        cancelText: t('agentDetail.deleteCancel'),
        onOk: runGenerateKey,
      })
    } else {
      void runGenerateKey()
    }
  }

  const runGenerateA2aKey = async () => {
    if (!agentId) return
    try {
      const res = await regenerateA2aKey.mutateAsync(agentId)
      if (res?.data?.a2aEndpointApiKey) {
        setGeneratedA2aKey(res.data.a2aEndpointApiKey)
        setA2aKeyGenerated(true)
      }
    } catch (err) {
      console.error('Failed to regenerate A2A API key:', err)
    }
  }

  const handleGenerateA2aKey = () => {
    if (!agentId) return
    if (a2aHasExistingKey) {
      confirm({
        title: t('agentPublish.resetKeyConfirmTitle'),
        content: t('agentPublish.resetKeyConfirmContent'),
        okText: t('agentPublish.resetKey'),
        danger: true,
        cancelText: t('agentDetail.deleteCancel'),
        onOk: runGenerateA2aKey,
      })
    } else {
      void runGenerateA2aKey()
    }
  }

  // 飞书开关：未配置过 appId 时，先弹「已有 / 创建」二选一；已配置或关闭则直接生效。
  const handleFeishuToggle = (checked: boolean) => {
    if (!checked) {
      setFeishuEnabled(false)
      return
    }
    if (feishuAppId || feishuSecretExists) {
      setFeishuEnabled(true)
      return
    }
    setFeishuSetupOpen(true)
  }

  const chooseExistingFeishu = () => {
    setFeishuShowCreateGuide(false)
    setFeishuEnabled(true)
    setFeishuSetupOpen(false)
    // 凭据输入框在配置弹窗里：刚让用户去填 App ID，就得先把那个弹窗打开，
    // 否则 focusFeishuAppId() 找不到目标（新手引导也会卡在这一步）。
    openChannelModal('feishu')
    focusFeishuAppId()
  }

  const chooseCreateFeishu = () => {
    setFeishuShowCreateGuide(true)
    setFeishuEnabled(true)
    setFeishuSetupOpen(false)
    window.open(FEISHU_LAUNCHER_URL, '_blank', 'noopener,noreferrer')
    // 打开 launcher 后把视图定位到 App ID / App Secret 输入框，引导用户回填。
    openChannelModal('feishu')
    focusFeishuAppId()
  }

  const tabItems = [
    {
      key: 'api',
      label: t('agentPublish.channelApi'),
      children: (
        <div className="space-y-5">
          {/* API endpoint (read-only) */}
          {agentId && (
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium text-foreground">
                {t('agentPublish.apiAddress')}
              </Label>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
                <code className="flex-1 truncate">{invokeUrl}</code>
                <CopyButton text={invokeUrl} label={t('agentPublish.copyEndpoint')} />
                <span className="border-l border-border pl-2 flex items-center gap-1 text-muted-foreground">
                  <span className="text-xs">cURL</span>
                  <CopyButton
                    text={`curl -X POST ${invokeUrl} -H "Content-Type: application/json" ${
                      authType === 'api_key'
                        ? `-H "Authorization: Bearer ${generatedKey ?? '<API_KEY>'}" `
                        : ''
                    }-d '{"message": "Hello", "context": {"key": "value"}, "stream": false}'`}
                    label={t('agentPublish.copyCurl')}
                  />
                </span>
              </div>
            </div>
          )}

          {/* 鉴权方式 */}
          <div className="flex flex-col gap-2">
            <Label className="text-sm font-medium text-foreground">
              {t('agentPublish.authType')}
            </Label>
            <Radio.Group
              value={authType}
              onChange={(e) => setAuthType(e.target.value)}
              className="flex flex-col gap-1.5"
            >
              <Radio value="none">{t('agentPublish.authTypeNone')}</Radio>
              <Radio value="api_key">{t('agentPublish.authTypeApiKey')}</Radio>
            </Radio.Group>
          </div>

          {/* API Key（仅 api_key 鉴权方式下显示） */}
          {authType === 'api_key' && (
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium text-foreground">
                {t('agentPublish.apiKey')}
              </Label>
              <div className="flex items-center gap-2">
                <p className="flex-1 rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {hasExistingKey
                    ? t('agentPublish.keyHiddenPlaceholder')
                    : t('agentPublish.keyPlaceholder')}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateKey}
                  disabled={regenerateKey.isPending || !agentId}
                  aria-label={
                    hasExistingKey ? t('agentPublish.resetKey') : t('agentPublish.generateKey')
                  }
                >
                  {regenerateKey.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span className="ml-1.5">
                    {hasExistingKey ? t('agentPublish.resetKey') : t('agentPublish.generateKey')}
                  </span>
                </Button>
              </div>
            </div>
          )}

          {/* IP Whitelist */}
          <div className="flex flex-col gap-2">
            <Label className="text-sm font-medium text-foreground">
              {t('agentPublish.ipWhitelist')}
            </Label>
            <Textarea
              value={ipWhitelistStr}
              onChange={(e) => setIpWhitelistStr(e.target.value)}
              placeholder={t('agentPublish.ipWhitelistPlaceholder')}
              rows={3}
              className="resize-none font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">{t('agentPublish.ipWhitelistHelp')}</p>
          </div>

          {/* Description */}
          <div className="flex flex-col gap-2">
            <Label className="text-sm font-medium text-foreground">
              {t('agentPublish.description')}
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
              placeholder={t('agentPublish.descriptionPlaceholder')}
              rows={3}
              maxLength={DESCRIPTION_MAX}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground">
              {description.length}/{DESCRIPTION_MAX}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'oauth',
      label: t('agentPublish.channelOauth'),
      children: (
        <div className="space-y-5">
          {/* Enabling lives on the card, not here — see channel-card.tsx. The
              form renders regardless of the switch so a channel can be
              configured before it is turned on. */}
          {agentId && (
            <>
              <div className="flex flex-col gap-2">
                <Label className="text-sm font-medium text-foreground">
                  {t('agentPublish.apiAddress')}
                </Label>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
                  <code className="flex-1 truncate">{oauthInvokeUrl}</code>
                  <CopyButton text={oauthInvokeUrl} label={t('agentPublish.copyEndpoint')} />
                  <span className="border-l border-border pl-2 flex items-center gap-1 text-muted-foreground">
                    <span className="text-xs">cURL</span>
                    <CopyButton
                      text={`curl -X POST ${oauthInvokeUrl} -H "Content-Type: application/json" -H "Authorization: Bearer <OIDC_JWT>" -d '{"message": "Hello", "stream": false}'`}
                      label={t('agentPublish.copyCurl')}
                    />
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-sm font-medium text-foreground">
                  {t('agentPublish.oauthAccessScope')}
                </Label>
                <Radio.Group
                  value={oauthAccessMode}
                  onChange={(e) => setOauthAccessMode(e.target.value)}
                  className="flex flex-col gap-2"
                >
                  <Radio value="all_idaas_users">
                    <span className="flex flex-col">
                      <span>{t('agentPublish.oauthAccessAllIdaas')}</span>
                      <span className="text-xs text-muted-foreground">
                        {t('agentPublish.oauthAccessAllIdaasDesc')}
                      </span>
                    </span>
                  </Radio>
                  <Radio value="specified_users">
                    <span className="flex flex-col">
                      <span>{t('agentPublish.oauthAccessSpecifiedUsers')}</span>
                      <span className="text-xs text-muted-foreground">
                        {t('agentPublish.oauthAccessSpecifiedUsersDesc')}
                      </span>
                    </span>
                  </Radio>
                </Radio.Group>
              </div>

              {oauthAccessMode === 'specified_users' && (
                <OauthAllowedEmails
                  emails={oauthAllowedEmails}
                  onChange={setOauthAllowedEmails}
                  disabled={!canWrite}
                />
              )}

              {oauthEnvStatus.data && !oauthEnvStatus.data.configured && (
                <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <X className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{t(oauthEnvErrorKey(oauthEnvStatus.data))}</span>
                </div>
              )}

              <div className="flex items-start gap-2 info-panel px-3 py-2.5 text-sm text-muted-foreground">
                <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span className="whitespace-pre-line">
                  {t(
                    oauthAccessMode === 'specified_users'
                      ? 'agentPublish.oauthChannelHelpSpecifiedUsers'
                      : 'agentPublish.oauthChannelHelpAllIdaas',
                  )}
                </span>
              </div>
            </>
          )}
        </div>
      ),
    },
    {
      key: 'a2a',
      label: 'A2A',
      children: (
        <A2aChannelSection
          cardUrl={a2aCardUrl}
          rpcUrl={a2aRpcUrl}
          authType={a2aAuthType}
          onAuthTypeChange={setA2aAuthType}
          hasExistingKey={a2aHasExistingKey}
          onGenerateKey={handleGenerateA2aKey}
          isGeneratingKey={regenerateA2aKey.isPending}
          hasAgent={!!agentId}
          trustForwardedIdentity={trustForwardedIdentity}
          onTrustForwardedIdentityChange={setTrustForwardedIdentity}
        />
      ),
    },
    {
      key: 'feishu',
      label: t('agentPublish.channelFeishu'),
      children: (
        <FeishuChannelSection
          showCreateGuide={feishuShowCreateGuide}
          appIdInputRef={feishuAppIdInputRef}
          appId={feishuAppId}
          onAppIdChange={setFeishuAppId}
          appSecret={feishuAppSecret}
          onAppSecretChange={setFeishuAppSecret}
          baseScopes={FEISHU_BASE_SCOPES}
          launcherUrl={FEISHU_LAUNCHER_URL}
          group={{
            triggerOnAt: groupTriggerOnAt,
            triggerOnNewMessage: groupTriggerOnNewMessage,
            replyMode: groupReplyMode,
          }}
          onGroupChange={(patch) => {
            if (patch.triggerOnAt !== undefined) setGroupTriggerOnAt(patch.triggerOnAt)
            if (patch.triggerOnNewMessage !== undefined)
              setGroupTriggerOnNewMessage(patch.triggerOnNewMessage)
            if (patch.replyMode !== undefined) setGroupReplyMode(patch.replyMode)
          }}
          p2pReplyMode={p2pReplyMode}
          onP2pReplyModeChange={setP2pReplyMode}
          topic={{
            triggerOnAt: topicTriggerOnAt,
            triggerOnNewTopic: topicTriggerOnNewTopic,
            triggerOnNewComment: topicTriggerOnNewComment,
            replyMode: topicReplyMode,
            replyMentionTarget: topicReplyMentionTarget,
            injectRootMessage: topicInjectRootMessage,
          }}
          onTopicChange={(patch) => {
            if (patch.triggerOnAt !== undefined) setTopicTriggerOnAt(patch.triggerOnAt)
            if (patch.triggerOnNewTopic !== undefined)
              setTopicTriggerOnNewTopic(patch.triggerOnNewTopic)
            if (patch.triggerOnNewComment !== undefined)
              setTopicTriggerOnNewComment(patch.triggerOnNewComment)
            if (patch.replyMode !== undefined) setTopicReplyMode(patch.replyMode)
            if (patch.replyMentionTarget !== undefined)
              setTopicReplyMentionTarget(patch.replyMentionTarget)
            if (patch.injectRootMessage !== undefined)
              setTopicInjectRootMessage(patch.injectRootMessage)
          }}
          reply={{
            contentType: feishuReplyContentType,
            cardTemplateId: feishuCardTemplateId,
            debugShowSessionId: feishuDebugShowSessionId,
            debugShowProvider: feishuDebugShowProvider,
            debugShowModel: feishuDebugShowModel,
            sendArtifactsAsFile: feishuSendArtifactsAsFile,
            fetchUserInfo: feishuFetchUserInfo,
          }}
          onReplyChange={(patch) => {
            if (patch.contentType !== undefined) setFeishuReplyContentType(patch.contentType)
            if (patch.cardTemplateId !== undefined) setFeishuCardTemplateId(patch.cardTemplateId)
            if (patch.debugShowSessionId !== undefined)
              setFeishuDebugShowSessionId(patch.debugShowSessionId)
            if (patch.debugShowProvider !== undefined)
              setFeishuDebugShowProvider(patch.debugShowProvider)
            if (patch.debugShowModel !== undefined) setFeishuDebugShowModel(patch.debugShowModel)
            if (patch.sendArtifactsAsFile !== undefined)
              setFeishuSendArtifactsAsFile(patch.sendArtifactsAsFile)
            if (patch.fetchUserInfo !== undefined) setFeishuFetchUserInfo(patch.fetchUserInfo)
          }}
          welcome={{
            message: feishuWelcomeMessage,
            onP2pEnabled: feishuWelcomeOnP2pEnabled,
            p2pIdleDays: feishuWelcomeP2pIdleDays,
            onGroupAddedEnabled: feishuWelcomeOnGroupAddedEnabled,
          }}
          onWelcomeChange={(patch) => {
            if (patch.message !== undefined) setFeishuWelcomeMessage(patch.message)
            if (patch.onP2pEnabled !== undefined) setFeishuWelcomeOnP2pEnabled(patch.onP2pEnabled)
            if (patch.p2pIdleDays !== undefined) setFeishuWelcomeP2pIdleDays(patch.p2pIdleDays)
            if (patch.onGroupAddedEnabled !== undefined)
              setFeishuWelcomeOnGroupAddedEnabled(patch.onGroupAddedEnabled)
          }}
        />
      ),
    },
    {
      key: 'slack',
      label: 'Slack',
      children: (
        <SlackChannelSection
          appId={slackAppId}
          onAppIdChange={setSlackAppId}
          appToken={slackAppToken}
          onAppTokenChange={setSlackAppToken}
          botToken={slackBotToken}
          onBotTokenChange={setSlackBotToken}
          groupTriggerOnAt={slackGroupTriggerOnAt}
          onGroupTriggerOnAtChange={setSlackGroupTriggerOnAt}
          groupTriggerOnNewMessage={slackGroupTriggerOnNewMessage}
          onGroupTriggerOnNewMessageChange={setSlackGroupTriggerOnNewMessage}
          groupReplyMode={slackGroupReplyMode}
          onGroupReplyModeChange={setSlackGroupReplyMode}
          p2pReplyMode={slackP2pReplyMode}
          onP2pReplyModeChange={setSlackP2pReplyMode}
          sendArtifactsAsFile={slackSendArtifactsAsFile}
          onSendArtifactsAsFileChange={setSlackSendArtifactsAsFile}
        />
      ),
    },
    {
      key: 'discord',
      label: 'Discord',
      children: (
        <DiscordChannelSection
          applicationId={discordApplicationId}
          onApplicationIdChange={setDiscordApplicationId}
          botToken={discordBotToken}
          onBotTokenChange={setDiscordBotToken}
          guildTriggerOnMention={discordGuildTriggerOnMention}
          onGuildTriggerOnMentionChange={setDiscordGuildTriggerOnMention}
          guildTriggerOnNewMessage={discordGuildTriggerOnNewMessage}
          onGuildTriggerOnNewMessageChange={setDiscordGuildTriggerOnNewMessage}
          guildReplyMode={discordGuildReplyMode}
          onGuildReplyModeChange={setDiscordGuildReplyMode}
          dmReplyMode={discordDmReplyMode}
          onDmReplyModeChange={setDiscordDmReplyMode}
          sendArtifactsAsFile={discordSendArtifactsAsFile}
          onSendArtifactsAsFileChange={setDiscordSendArtifactsAsFile}
        />
      ),
    },
    {
      key: 'qq_official',
      label: t('agentPublish.channelQQOfficial'),
      children: (
        <QQOfficialChannelSection
          agentId={agentId}
          appId={qqOfficialAppId}
          onAppIdChange={setQQOfficialAppId}
          appSecret={qqOfficialAppSecret}
          onAppSecretChange={setQQOfficialAppSecret}
          groupTriggerOnAt={qqGroupTriggerOnAt}
          onGroupTriggerOnAtChange={setQQGroupTriggerOnAt}
          groupReplyMode={qqGroupReplyMode}
          onGroupReplyModeChange={setQQGroupReplyMode}
          c2cReplyMode={qqC2cReplyMode}
          onC2cReplyModeChange={setQQC2cReplyMode}
          sendArtifactsAsFile={qqSendArtifactsAsFile}
          onSendArtifactsAsFileChange={setQQSendArtifactsAsFile}
        />
      ),
    },
    {
      key: 'schedule',
      label: t('agentPublish.channelSchedule'),
      children: (
        <ScheduleChannelSection
          configs={scheduleConfigs}
          activeIndex={activeScheduleIndex}
          onSelectConfig={selectScheduleConfig}
          onAddConfig={addScheduleConfig}
          onRemoveConfig={removeScheduleConfig}
          mode={scheduleMode}
          onModeChange={setScheduleMode}
          preset={schedulePreset}
          onPresetChange={setSchedulePreset}
          time={scheduleTime}
          onTimeChange={setScheduleTime}
          weekday={scheduleWeekday}
          onWeekdayChange={setScheduleWeekday}
          monthDay={scheduleMonthDay}
          onMonthDayChange={setScheduleMonthDay}
          cron={scheduleCron}
          onCronChange={setScheduleCron}
          intent={scheduleIntent}
          onIntentChange={setScheduleIntent}
          timezone={scheduleTimezone}
          onTimezoneChange={setScheduleTimezone}
          runAsOwner={scheduleRunAsOwner}
          onRunAsOwnerChange={setScheduleRunAsOwner}
          activeCron={activeScheduleCron}
          isCronInvalid={isScheduleCronInvalid}
          bindMethod={bindMethod}
          identityBound={!!currentUser?.idaasBound}
        />
      ),
    },
    {
      key: 'chat_app',
      label: t('agentPublish.channelChatApp'),
      children: (
        <ChatAppChannelSection
          agentId={agentId}
          chatAppUrl={chatAppUrl}
          displayName={chatAppDisplayName}
          onDisplayNameChange={setChatAppDisplayName}
          welcomeMessage={chatAppWelcomeMessage}
          onWelcomeMessageChange={setChatAppWelcomeMessage}
          suggestedQuestions={chatAppSuggestedQuestions}
          onSuggestedQuestionsChange={setChatAppSuggestedQuestions}
          showCreator={chatAppShowCreator}
          onShowCreatorChange={setChatAppShowCreator}
          allowAttachments={chatAppAllowAttachments}
          onAllowAttachmentsChange={setChatAppAllowAttachments}
          showThinking={chatAppShowThinking}
          onShowThinkingChange={setChatAppShowThinking}
        />
      ),
    },
    ...(['glab', 'gh'] as const).map((provider) => ({
      key: provider,
      label: t(provider === 'glab' ? 'agentPublish.channelGlab' : 'agentPublish.channelGh'),
      children: (
        <GitTriggerChannelSection
          provider={provider}
          repos={gitTriggerState[provider].repos}
          onReposChange={(repos) => patchGitTrigger(provider, { repos })}
          events={gitTriggerState[provider].events}
          onEventsChange={(events) => patchGitTrigger(provider, { events })}
          intervalSeconds={gitTriggerState[provider].intervalSeconds}
          onIntervalSecondsChange={(intervalSeconds) =>
            patchGitTrigger(provider, { intervalSeconds })
          }
          intent={gitTriggerState[provider].intent}
          onIntentChange={(intent) => patchGitTrigger(provider, { intent })}
          targetBranches={gitTriggerState[provider].targetBranches}
          onTargetBranchesChange={(targetBranches) => patchGitTrigger(provider, { targetBranches })}
          ignoreDrafts={gitTriggerState[provider].ignoreDrafts}
          onIgnoreDraftsChange={(ignoreDrafts) => patchGitTrigger(provider, { ignoreDrafts })}
          cliStatus={gitTriggerCliStatus[provider]}
          cliStatusLoading={gitTriggerCliLoading[provider]}
          onCheckCliStatus={() => void checkGitTriggerCli(provider)}
        />
      ),
    })),
  ]

  // 新手语境（创建后带 ?onboarding=1 进入）：把飞书渠道排到第一位，引导优先接飞书。
  const onboarding = searchParams.get('onboarding') === '1'
  /**
   * Live socket state for the chat channels.
   *
   * Both state sources are passed in deliberately: the *persisted*
   * `publishChannels` decides whether a connection should exist, while the
   * card's switch (`channelEnabledMap`) carries unsaved intent. When they
   * disagree the resolver reports `pending`, so the pill never contradicts the
   * switch sitting directly above it on the same card.
   */
  const renderChannelConnection = (channel: ChannelKey) => {
    if (!agentId || !isConnectedChannel(channel)) return null
    const kind = resolveChannelConnectionUi({
      channel,
      persistedEnabled: !!agent?.publishChannels?.includes(channel),
      formEnabled: channelEnabledMap[channel],
      configured: persistedChannelConfigured[channel],
      publishStatus: agent?.publishStatus,
      agentId,
      connections: chatConnections,
      isLoading: chatConnectionsLoading,
      isError: chatConnectionErrors[channel],
    })
    return kind ? <ChannelConnectionStatus channel={channel} kind={kind} /> : null
  }

  /**
   * Compact, read-only summary on a card — the identifying detail you would
   * otherwise have to open the dialog to see. Only for channels that have one;
   * everything else returns null and the card skips the row.
   */
  const renderChannelInfo = (channel: ChannelKey) => {
    // All three chat channels show their app identity: when "one App, one
    // connection" preemption is what broke the socket, the status pill alone
    // does not say *which* app the status belongs to.
    const appIdByChannel: Partial<Record<ChannelKey, { label: string; value: string }>> = {
      feishu: { label: t('agentPublish.feishuAppId'), value: feishuAppId },
      slack: { label: t('agentPublish.slackAppId'), value: slackAppId },
      discord: { label: t('agentPublish.discordApplicationId'), value: discordApplicationId },
    }
    const appId = appIdByChannel[channel]
    if (appId?.value) {
      return (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-muted-foreground">{appId.label}</span>
          <code className="min-w-0 flex-1 truncate font-mono text-foreground">{appId.value}</code>
          <CopyButton text={appId.value} label={t('common.copy')} />
        </div>
      )
    }
    if (channel === 'chat_app' && chatAppUrl) {
      return (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
            {`/agents/${agentId}/chat_app`}
          </code>
          <CopyButton text={chatAppUrl} label={t('common.copy')} />
        </div>
      )
    }
    return null
  }

  /** Config form for whichever channel's dialog is open. */
  const openChannelMeta = openChannel
    ? (CHANNEL_REGISTRY.find((c) => c.key === openChannel) ?? null)
    : null
  const openChannelBody = openChannel
    ? (tabItems.find((item) => item.key === openChannel)?.children ?? null)
    : null

  return (
    <div className="space-y-5">
      {/* 一次性展示新生成的 API Key：关闭即清空，之后不再显示 */}
      <Modal
        open={!!generatedKey}
        title={t('agentPublish.apiKeyModalTitle')}
        onCancel={() => setGeneratedKey(null)}
        onOk={() => setGeneratedKey(null)}
        okText={t('agentPublish.apiKeyModalDone')}
        cancelButtonProps={{ style: { display: 'none' } }}
        mask={{ closable: false }}
      >
        <p className="mb-2 text-sm text-muted-foreground">{t('agentPublish.apiKeyWarning')}</p>
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
          <code className="flex-1 break-all">{generatedKey}</code>
          <CopyButton text={generatedKey ?? ''} label={t('agentPublish.copyApiKey')} />
        </div>
      </Modal>

      {/* 一次性展示新生成的 A2A 专属 API Key */}
      <Modal
        open={!!generatedA2aKey}
        title={t('agentPublish.apiKeyModalTitle')}
        onCancel={() => setGeneratedA2aKey(null)}
        onOk={() => setGeneratedA2aKey(null)}
        okText={t('agentPublish.apiKeyModalDone')}
        cancelButtonProps={{ style: { display: 'none' } }}
        mask={{ closable: false }}
      >
        <p className="mb-2 text-sm text-muted-foreground">{t('agentPublish.apiKeyWarning')}</p>
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
          <code className="flex-1 break-all">{generatedA2aKey}</code>
          <CopyButton text={generatedA2aKey ?? ''} label={t('agentPublish.copyApiKey')} />
        </div>
      </Modal>

      <Card>
        <CardContent className="p-5 space-y-5">
          {/* The tab strip already names this section, so the heading only
              repeated it. mb-3 keeps the note tighter to the strip than the
              card's 20px rhythm. */}
          <div className="flex items-center gap-2 info-panel px-3 py-2.5 text-sm text-muted-foreground !mb-3">
            <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('agentPublish.noteDesc')}</span>
          </div>

          <ChannelGrid
            enabled={channelEnabledMap}
            onEnabledChange={handleChannelToggle}
            blockReasons={channelBlockReasons}
            onConfigure={openChannelModal}
            pinnedChannel={onboarding ? 'feishu' : undefined}
            renderInfo={renderChannelInfo}
            renderConnection={renderChannelConnection}
          />

          <ChannelConfigModal
            meta={openChannelMeta}
            open={!!openChannel}
            onClose={closeChannelModal}
            onSave={
              openChannelMeta && isConfigurableChannel(openChannelMeta.key)
                ? saveChannel
                : undefined
            }
            isSaving={saveChannelConfig.isPending}
            saveBlockReason={openChannel ? channelBlockReasons[openChannel] : null}
            publishOnlyHint={openChannelHasPublishOnlySettings}
          >
            {openChannelBody}
          </ChannelConfigModal>

          {/* 飞书接入方式选择弹窗 */}
          <Modal
            open={feishuSetupOpen}
            title={t('agentPublish.feishuSetupTitle')}
            footer={null}
            onCancel={() => setFeishuSetupOpen(false)}
            width={560}
          >
            <p className="mb-4 text-sm text-muted-foreground">
              {t('agentPublish.feishuSetupDesc')}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-tour="feishu-setup">
              <button
                type="button"
                onClick={chooseExistingFeishu}
                className="rounded-lg border border-border bg-muted/30 p-4 text-left transition-all hover:border-border/80 hover:bg-surface-hover"
              >
                <div className="mb-1 text-sm font-medium text-foreground">
                  {t('agentPublish.feishuSetupExisting')}
                </div>
                <div className="text-xs leading-relaxed text-muted-foreground">
                  {t('agentPublish.feishuSetupExistingDesc')}
                </div>
              </button>
              <button
                type="button"
                onClick={chooseCreateFeishu}
                className="relative rounded-lg border-2 border-primary/40 bg-brand-gradient-subtle p-4 text-left transition-all hover:border-primary/70"
              >
                <span className="absolute -top-2 right-3 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium leading-none text-primary-foreground shadow-sm">
                  {t('agentPublish.feishuSetupRecommended')}
                </span>
                <div className="mb-1 text-sm font-medium text-foreground">
                  {t('agentPublish.feishuSetupCreate')}
                </div>
                <div className="text-xs leading-relaxed text-muted-foreground">
                  {t('agentPublish.feishuSetupCreateDesc')}
                </div>
              </button>
            </div>
          </Modal>

          {/* Actions */}
          <div className="mt-5 flex items-center justify-end gap-2 pt-4 border-t border-border">
            {isPublished && (
              <Button
                type="button"
                data-tour="agent-stop"
                variant="outline"
                onClick={onStop}
                disabled={isStopPending}
              >
                <StopCircle className="h-4 w-4" aria-hidden="true" />
                {t('agentDetail.stop')}
              </Button>
            )}

            {isStopped && (
              <Button type="button" variant="outline" onClick={onResume} disabled={isResumePending}>
                <Play className="h-4 w-4" aria-hidden="true" />
                {t('agentDetail.resume')}
              </Button>
            )}

            <Button
              type="button"
              data-tour="publish-btn"
              onClick={handlePublish}
              disabled={isPublishing}
            >
              {isPublishing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {t('agentPublish.publishing')}
                </>
              ) : (
                <>
                  <Globe className="h-4 w-4" aria-hidden="true" />
                  {isEditMode ? t('agentPublish.update') : t('agentDetail.publish')}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
