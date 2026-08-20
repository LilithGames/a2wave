import type { agents } from '../db/schema.js'
import { maskProviderChainConfig } from '../lib/agent-provider-config.js'
import { maskA2ARouteTargetSecrets, maskSensitiveEnv } from './agent-route-secrets.js'

const MASKED_SECRET = '********'

type AgentRow = typeof agents.$inferSelect

/** Mask every Agent secret except fields explicitly revealed to the detail editor. */
export function maskAgentSecrets<T extends AgentRow | undefined>(
  agent: T,
  opts?: {
    revealFeishuSecret?: boolean
    revealNativeChatSecrets?: boolean
    revealOauthToken?: boolean
  },
): T {
  if (!agent) return agent
  let masked = maskSensitiveEnv(agent)
  if (masked.endpointApiKey) {
    masked = { ...masked, endpointApiKey: MASKED_SECRET }
  }
  if (masked.a2aEndpointApiKey) {
    masked = { ...masked, a2aEndpointApiKey: MASKED_SECRET }
  }
  masked = {
    ...masked,
    config: maskProviderChainConfig(masked.config, MASKED_SECRET, {
      revealOauth: opts?.revealOauthToken,
    }),
    a2aRouteTargets: maskA2ARouteTargetSecrets(masked.a2aRouteTargets) ?? null,
  }
  if (!opts?.revealOauthToken && masked.providerOauthToken) {
    masked = { ...masked, providerOauthToken: MASKED_SECRET }
  }
  if (masked.memoryProviderApiKey) {
    masked = { ...masked, memoryProviderApiKey: MASKED_SECRET }
  }
  if (masked.embeddingApiKey) {
    masked = { ...masked, embeddingApiKey: MASKED_SECRET }
  }
  if (masked.providerApiKey) {
    masked = { ...masked, providerApiKey: MASKED_SECRET }
  }
  if (masked.providerBaseUrl) {
    masked = { ...masked, providerBaseUrl: MASKED_SECRET }
  }
  const feishu = masked.feishuConfig as { appSecret?: string } | null | undefined
  if (!opts?.revealFeishuSecret && feishu?.appSecret) {
    masked = {
      ...masked,
      feishuConfig: { ...feishu, appSecret: MASKED_SECRET } as typeof masked.feishuConfig,
    }
  }
  const slack = masked.slackConfig
  if (!opts?.revealNativeChatSecrets && slack) {
    masked = {
      ...masked,
      slackConfig: {
        ...slack,
        appToken: slack.appToken ? MASKED_SECRET : slack.appToken,
        botToken: slack.botToken ? MASKED_SECRET : slack.botToken,
      },
    }
  }
  const discord = masked.discordConfig
  if (!opts?.revealNativeChatSecrets && discord?.botToken) {
    masked = {
      ...masked,
      discordConfig: { ...discord, botToken: MASKED_SECRET },
    }
  }
  const qqOfficial = masked.qqOfficialConfig
  if (!opts?.revealNativeChatSecrets && qqOfficial?.appSecret) {
    masked = {
      ...masked,
      qqOfficialConfig: { ...qqOfficial, appSecret: MASKED_SECRET },
    }
  }
  return masked as T
}
