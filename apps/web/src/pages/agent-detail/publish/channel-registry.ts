/**
 * Publish channel metadata — the single source of truth for the channel grid,
 * the category filter, and the config modal titles.
 *
 * Deliberately pure data: no JSX and no state access, so the grid, the filter
 * chips and the `?publishTab=` URL contract all derive from one list and cannot
 * drift apart. `VALID_PUBLISH_TABS` used to be a second hand-maintained literal
 * in publish-tab.tsx; it is now derived from here.
 */
import type { LucideIcon } from 'lucide-react'
import {
  Bot,
  Clock,
  Gamepad2,
  Github,
  GitMerge,
  Globe,
  KeyRound,
  MessagesSquare,
  Network,
  Slack,
} from 'lucide-react'

/** Mirrors `publishChannelEnum` in @a2wave/shared. */
export type ChannelKey =
  | 'api'
  | 'oauth'
  | 'a2a'
  | 'feishu'
  | 'slack'
  | 'discord'
  | 'qq_official'
  | 'schedule'
  | 'chat_app'
  | 'glab'
  | 'gh'

/** Filter buckets shown above the grid. `all` is the implicit default. */
export type ChannelCategory = 'api' | 'protocol' | 'chatbot' | 'scheduled' | 'webapp' | 'gitRepo'

export interface ChannelMeta {
  key: ChannelKey
  category: ChannelCategory
  icon: LucideIcon
  /** i18n key for the card title. */
  titleKey: string
  /** i18n key for the one-line card description. */
  descKey: string
  /**
   * i18n key for the enable switch's accessible name. Reuses the existing
   * `Enable X` copy rather than the card title — it reads correctly for a
   * toggle, and it keeps `chat-app.spec.ts` targeting the same name.
   */
  switchLabelKey: string
  /**
   * REST API cannot be turned off — `buildChannels()` always seeds `['api']`,
   * so its card shows a static "always on" pill instead of a switch.
   */
  alwaysOn?: boolean
  /**
   * `data-tour` anchor for the card's switch. The onboarding tour reads
   * `[data-tour="feishu-enable"] .ant-switch` to decide whether step 5 is done,
   * and that step fires before any dialog is open — so the anchor has to live
   * on the card, not inside the config form.
   */
  tourAnchor?: string
}

export const CHANNEL_REGISTRY: readonly ChannelMeta[] = [
  {
    key: 'api',
    category: 'api',
    icon: Globe,
    titleKey: 'agentPublish.channelApi',
    descKey: 'agentPublish.cardDescApi',
    switchLabelKey: 'agentPublish.channelApi',
    alwaysOn: true,
  },
  {
    key: 'oauth',
    category: 'api',
    icon: KeyRound,
    titleKey: 'agentPublish.channelOauth',
    descKey: 'agentPublish.cardDescOauth',
    switchLabelKey: 'agentPublish.oauthChannelEnabled',
  },
  {
    key: 'a2a',
    category: 'protocol',
    icon: Network,
    titleKey: 'agentPublish.channelA2a',
    descKey: 'agentPublish.cardDescA2a',
    switchLabelKey: 'agentPublish.a2aChannelEnabled',
  },
  {
    key: 'feishu',
    category: 'chatbot',
    icon: Bot,
    titleKey: 'agentPublish.channelFeishu',
    descKey: 'agentPublish.cardDescFeishu',
    switchLabelKey: 'agentPublish.feishuChannelEnabled',
    tourAnchor: 'feishu-enable',
  },
  {
    key: 'slack',
    category: 'chatbot',
    icon: Slack,
    titleKey: 'agentPublish.channelSlack',
    descKey: 'agentPublish.cardDescSlack',
    switchLabelKey: 'agentPublish.slackChannelEnabled',
  },
  {
    key: 'discord',
    category: 'chatbot',
    icon: Gamepad2,
    titleKey: 'agentPublish.channelDiscord',
    descKey: 'agentPublish.cardDescDiscord',
    switchLabelKey: 'agentPublish.discordChannelEnabled',
  },
  {
    key: 'qq_official',
    category: 'chatbot',
    icon: Bot,
    titleKey: 'agentPublish.channelQQOfficial',
    descKey: 'agentPublish.cardDescQQOfficial',
    switchLabelKey: 'agentPublish.qqOfficialChannelEnabled',
  },
  {
    key: 'schedule',
    category: 'scheduled',
    icon: Clock,
    titleKey: 'agentPublish.channelSchedule',
    descKey: 'agentPublish.cardDescSchedule',
    switchLabelKey: 'agentPublish.scheduleChannelEnabled',
  },
  {
    key: 'chat_app',
    category: 'webapp',
    icon: MessagesSquare,
    titleKey: 'agentPublish.channelChatApp',
    descKey: 'agentPublish.cardDescChatApp',
    switchLabelKey: 'agentPublish.chatAppChannelEnabled',
  },
  {
    key: 'glab',
    category: 'gitRepo',
    icon: GitMerge,
    titleKey: 'agentPublish.channelGlab',
    descKey: 'agentPublish.cardDescGlab',
    switchLabelKey: 'agentPublish.glabChannelEnabled',
  },
  {
    key: 'gh',
    category: 'gitRepo',
    icon: Github,
    titleKey: 'agentPublish.channelGh',
    descKey: 'agentPublish.cardDescGh',
    switchLabelKey: 'agentPublish.ghChannelEnabled',
  },
]

/**
 * Valid values for the `?publishTab=` query param, which now addresses "which
 * channel's config modal is open" rather than "which sub-tab is active".
 */
export const VALID_PUBLISH_TABS: readonly ChannelKey[] = CHANNEL_REGISTRY.map((c) => c.key)

export function isChannelKey(value: string | null | undefined): value is ChannelKey {
  return !!value && VALID_PUBLISH_TABS.includes(value as ChannelKey)
}

/**
 * Channels with a config column of their own, i.e. those that can be saved
 * through `PATCH /agents/:id/channels/:channel`. `api`, `oauth` and `a2a` keep
 * their settings in flat agent columns and are only written by publish.
 */
const CONFIGURABLE_CHANNELS = [
  'feishu',
  'slack',
  'discord',
  'qq_official',
  'chat_app',
  'schedule',
  'glab',
  'gh',
] as const

export type ConfigurableChannelKey = (typeof CONFIGURABLE_CHANNELS)[number]

export function isConfigurableChannel(key: ChannelKey): key is ConfigurableChannelKey {
  return (CONFIGURABLE_CHANNELS as readonly string[]).includes(key)
}

/** Filter options in display order; `all` first. */
export const CHANNEL_FILTERS: readonly { value: ChannelCategory | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'agentPublish.filterAll' },
  { value: 'api', labelKey: 'agentPublish.filterApi' },
  { value: 'protocol', labelKey: 'agentPublish.filterProtocol' },
  { value: 'chatbot', labelKey: 'agentPublish.filterChatBot' },
  { value: 'scheduled', labelKey: 'agentPublish.filterScheduled' },
  { value: 'webapp', labelKey: 'agentPublish.filterWebApp' },
  { value: 'gitRepo', labelKey: 'agentPublish.filterGitRepo' },
]
