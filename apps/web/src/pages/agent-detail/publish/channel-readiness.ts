/**
 * "Is this channel configured well enough to be switched on?"
 *
 * Two callers depend on the same answer and must never disagree: the card's
 * enable switch (disabled until the channel is ready) and `handlePublish`'s
 * pre-flight validation. The API enforces the same rules a third time
 * (SLACK_CONFIG_REQUIRED and friends in routes/agents.ts), so this is an
 * early, friendlier gate — not the only line of defence.
 *
 * Channels absent from the map need no credentials and are always ready.
 */
import {
  GIT_TRIGGER_MAX_INTERVAL_SECONDS,
  GIT_TRIGGER_MIN_INTERVAL_SECONDS,
  type GitTriggerScope,
  isSupportedScheduleCron,
} from '@a2wave/shared'
import type { ChannelKey } from './channel-registry'

export interface ChannelReadinessInput {
  feishuAppId: string
  feishuAppSecret: string
  /** The stored secret is never echoed back, so "already saved" is its own flag. */
  feishuSecretExists: boolean
  slackAppId: string
  slackAppToken: string
  slackBotToken: string
  discordApplicationId: string
  discordBotToken: string
  oauthAccessMode: 'all_idaas_users' | 'specified_users'
  oauthAllowedEmails: string[]
  scheduleConfigs: { cron: string; intent: string }[]
  glab: GitTriggerReadiness
  gh: GitTriggerReadiness
}

/**
 * Git trigger readiness deliberately checks only what the *user* supplies.
 *
 * CLI installation and authentication are NOT part of this gate: a2wave never
 * installs `glab` / `gh` and never holds a forge token, so those are properties
 * of the host that can change after publish and are reported separately as live
 * status. Blocking the switch on them would also make the channel unpublishable
 * on any deployment that authenticates the CLI later.
 */
export interface GitTriggerReadiness {
  /**
   * `url` is what the user typed, `project` is what parsed out of it. Both are
   * needed to tell an untouched blank row (ignore it) from a typed-but-
   * unparseable one (block, or it gets dropped from the payload in silence).
   */
  repos: { project: string; url?: string; scope?: GitTriggerScope }[]
  events: string[]
  intent: string
  intervalSeconds: number
}

function hasFeishuCredentials(input: ChannelReadinessInput): boolean {
  return !!input.feishuAppId && (!!input.feishuAppSecret || input.feishuSecretExists)
}

/**
 * Mirrors the validation order in `handlePublish`. Returns null when ready, or
 * an i18n key explaining what is missing — the card shows it in a tooltip so a
 * greyed-out switch is never a dead end.
 */
export function getChannelBlockReason(
  channel: ChannelKey,
  input: ChannelReadinessInput,
): string | null {
  switch (channel) {
    case 'feishu':
      return hasFeishuCredentials(input) ? null : 'agentPublish.feishuConfigRequired'

    case 'slack':
      return input.slackAppId && input.slackAppToken && input.slackBotToken
        ? null
        : 'agentPublish.slackConfigRequired'

    case 'discord':
      return input.discordApplicationId && input.discordBotToken
        ? null
        : 'agentPublish.discordConfigRequired'

    case 'oauth':
      // all_idaas_users has nothing to configure. specified_users needs at least one address:
      // publishing with an empty list produces a channel that is switched on but denies every
      // call, which reads as a broken Agent rather than a deliberate setting.
      if (input.oauthAccessMode !== 'specified_users') return null
      return input.oauthAllowedEmails.length > 0 ? null : 'agentPublish.oauthAllowedEmailsEmpty'

    case 'schedule': {
      if (input.scheduleConfigs.length === 0) return 'agentPublish.scheduleCronRequired'
      if (input.scheduleConfigs.some((s) => !s.cron.trim()))
        return 'agentPublish.scheduleCronRequired'
      if (input.scheduleConfigs.some((s) => !isSupportedScheduleCron(s.cron)))
        return 'agentPublish.scheduleCronInvalid'
      if (input.scheduleConfigs.some((s) => !s.intent.trim()))
        return 'agentPublish.scheduleIntentRequired'
      return null
    }

    case 'glab':
      return getGitTriggerBlockReason(input.glab)

    case 'gh':
      return getGitTriggerBlockReason(input.gh)

    // api is always on; a2a and chat_app need no credentials.
    default:
      return null
  }
}

function getGitTriggerBlockReason(input: GitTriggerReadiness): string | null {
  const repos = input.repos.filter((repo) => repo.project.trim())
  if (repos.length === 0) return 'agentPublish.gitTriggerRepoRequired'
  // A row the user typed into that yielded no project would otherwise be
  // filtered out of the payload without ever being mentioned.
  if (input.repos.some((repo) => (repo.url ?? '').trim() && !repo.project.trim())) {
    return 'agentPublish.gitTriggerRepoInvalid'
  }
  if (input.events.length === 0) return 'agentPublish.gitTriggerEventRequired'
  if (!input.intent.trim()) return 'agentPublish.gitTriggerIntentRequired'
  if (
    !Number.isFinite(input.intervalSeconds) ||
    input.intervalSeconds < GIT_TRIGGER_MIN_INTERVAL_SECONDS ||
    input.intervalSeconds > GIT_TRIGGER_MAX_INTERVAL_SECONDS
  ) {
    return 'agentPublish.gitTriggerIntervalInvalid'
  }
  return null
}

export function isChannelReady(channel: ChannelKey, input: ChannelReadinessInput): boolean {
  return getChannelBlockReason(channel, input) === null
}
