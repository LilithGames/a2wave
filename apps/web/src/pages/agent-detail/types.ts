import type { AuthHeaderStyle } from '@a2wave/shared'
import type { UseFormReturn } from 'react-hook-form'

export type FormData = {
  name: string
  description: string
  systemPrompt: string
  icon: string
  providerApiKey: string
  providerBaseUrl: string
  providerOauthToken: string
  authMode: 'apiKey' | 'oauth' | 'localSession'
  providerId: string | null
  model: string
  readOnly: boolean
  force: boolean
  cleanResult: boolean
  maxConcurrency: number
  timeoutMinutes: number
  maxRetries: number
  /** null = 不限（沿用历史行为） */
  totalTimeoutMinutes: number | null
}

export type EnvEntry = {
  id: string
  key: string
  value: string
  sensitive: boolean
}

export type ProviderChainEntry = {
  id: string
  providerId: string | null
  model: string
  authMode: 'apiKey' | 'oauth' | 'localSession'
  authHeaderStyle?: AuthHeaderStyle
  providerApiKey: string
  providerBaseUrl: string
  providerOauthToken: string
  enabled: boolean
  expanded: boolean
  /** 动态拉取的可用 model 列表（per-entry，仅前端 form state，不持久化） */
  dynamicModels?: string[]
  /** 上次 probe 失败的错误信息（成功时清空） */
  probeError?: string
  /** probe 进行中 */
  probing?: boolean
  /** 上次 probe 返回的失败 code（用于 UI 决定提示文案，如 no_account_models 时给容器登录提示） */
  probeErrorCode?: string
}

export type AgentFormMethods = UseFormReturn<FormData>

export type RemoteEntry = {
  id: string
  name: string
  url: string
  /** Missing on legacy form fixtures/rows and therefore treated as direct. */
  connectionMode?: 'agent_card' | 'direct'
  /** Only applies to direct targets; discovery negotiates from the Agent Card. */
  protocolVersion?: '1.0' | '0.3'
  /** Explicit opt-in for sending display-only caller provenance to a direct v1 endpoint. */
  callerProvenance?: boolean
  description: string
  apiKey: string
  showApiKey: boolean
}
