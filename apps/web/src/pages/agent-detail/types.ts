import type { AuthHeaderStyle, FastModeAvailability, ModelCapabilities } from '@a2wave/shared'
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
  /**
   * 推理档位与 fast 模式跟着 model 走，而不是挂在 Agent 上：一条链里可以混用
   * 不同 Provider 和模型，合法档位由模型决定，Agent 级的值对其中某一档必然非法。
   */
  reasoningEffort?: string
  fastMode?: boolean
  enabled: boolean
  expanded: boolean
  /** 动态拉取的可用 model 列表（per-entry，仅前端 form state，不持久化） */
  dynamicModels?: string[]
  /**
   * 探测下发的按模型能力（档位清单 / 默认档位）。与 dynamicModels 同源同生命周期，
   * 只存在于表单态：平台不落模型目录，避免和账号真实权限脱节。
   */
  modelCapabilities?: Record<string, ModelCapabilities>
  /** 探测下发的快速模式资格。缺失＝没问到，此时不拦，交由运行结果回显。 */
  fastModeAvailability?: FastModeAvailability
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
