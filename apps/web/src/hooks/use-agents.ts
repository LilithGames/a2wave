import type {
  Agent,
  AgentPermission,
  CreateAgentInput,
  FastModeState,
  GitTriggerCliStatus,
  GitTriggerConfig,
  GitTriggerProvider,
  UpdateAgentInput,
} from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { ChatConnectionMaps, ConnectedChannelKey } from '@/lib/channel-connection-ui'

const AGENTS_KEY = ['agents'] as const
/** 供诊断等场景手动 invalidate */
export const FEISHU_CONNECTIONS_QUERY_KEY = ['feishu-connections'] as const
const FEISHU_CONNECTIONS_KEY = FEISHU_CONNECTIONS_QUERY_KEY
/** Slack/Discord long-connection registries of the current API process. */
export const CHAT_CONNECTIONS_QUERY_KEY = ['chat-connections'] as const

/** 与 GET /agents/feishu-connections 的 data 项一致 */
export type FeishuConnectionRow = { agentId: string; socketOpen: boolean }

/**
 * Every registry a publish/stop/resume touches. Slack and Discord open and
 * close their sockets on exactly the same lifecycle events Feishu does, so they
 * must be refreshed together — invalidating only Feishu is what left the other
 * two cards stale for a full poll interval after the operator acted.
 */
const CONNECTION_QUERY_KEYS = [FEISHU_CONNECTIONS_QUERY_KEY, CHAT_CONNECTIONS_QUERY_KEY] as const

/** Matches the `data` payload of GET /agents/chat-connections. */
export type ChatConnectionsResponse = {
  slack: FeishuConnectionRow[]
  discord: FeishuConnectionRow[]
  qqOfficial: FeishuConnectionRow[]
}

function toSocketMap(rows: FeishuConnectionRow[] | undefined): Map<string, boolean> {
  const byId = new Map<string, boolean>()
  for (const row of rows ?? []) byId.set(row.agentId, row.socketOpen)
  return byId
}

export function useFeishuConnections(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: FEISHU_CONNECTIONS_KEY,
    queryFn: () => api.get<FeishuConnectionRow[]>('/agents/feishu-connections'),
    refetchInterval: 15_000,
    enabled: options?.enabled ?? true,
    select: (res) => ({ byId: toSocketMap(res.data), meta: res.meta }),
  })
}

export function useChatConnections(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: CHAT_CONNECTIONS_QUERY_KEY,
    queryFn: () => api.get<ChatConnectionsResponse>('/agents/chat-connections'),
    refetchInterval: 15_000,
    enabled: options?.enabled ?? true,
    select: (res) => ({
      slack: toSocketMap(res.data?.slack),
      discord: toSocketMap(res.data?.discord),
      qq_official: toSocketMap(res.data?.qqOfficial),
      meta: res.meta,
    }),
  })
}

/**
 * The three native chat registries merged into the shape the channel cards
 * consume.
 *
 * Resolved **per channel**, not all-or-nothing: the two endpoints fail
 * independently, so a broken `/chat-connections` must not discard a perfectly
 * good Feishu map and blank all three cards. Each channel reports `error` only
 * when its own query failed.
 *
 * `options.enabled` gates the polling entirely — an Agent with no chat channel
 * renders no pill, so it should not pay for two 15s polls.
 */
export function useNativeChatConnections(options?: { enabled?: boolean }): {
  connections: ChatConnectionMaps | undefined
  isLoading: boolean
  /** Per-channel query failure, so one dead endpoint does not blank the others. */
  errorByChannel: Record<ConnectedChannelKey, boolean>
} {
  const enabled = options?.enabled ?? true
  const feishu = useFeishuConnections({ enabled })
  const chat = useChatConnections({ enabled })

  const errorByChannel = {
    feishu: feishu.isError,
    slack: chat.isError,
    discord: chat.isError,
    qq_official: chat.isError,
  }
  // A query still in flight has no data yet; a failed one never will. Both are
  // represented by an empty map plus the per-channel error flag, so a partial
  // failure still shows the healthy channels' real state.
  const connections: ChatConnectionMaps = {
    feishu: feishu.data?.byId ?? new Map(),
    slack: chat.data?.slack ?? new Map(),
    discord: chat.data?.discord ?? new Map(),
    qq_official: chat.data?.qq_official ?? new Map(),
  }
  return {
    connections,
    isLoading: feishu.isLoading || chat.isLoading,
    errorByChannel,
  }
}

/**
 * 列表项在 Agent 基础上附带 `canManage`：后端按调用者对该 Agent 的写权限（owner/editor/admin）计算，
 * 前端据此决定是否渲染置顶按钮。建模成类型而非 inline cast，字段改名/删除时 tsc 能立刻报错。
 */
export type AgentListItem = Agent & { canManage: boolean }

export function useAgents(params?: { page?: number; pageSize?: number; enabled?: boolean }) {
  const { page = 1, pageSize = 50, enabled } = params ?? {}
  return useQuery({
    queryKey: [...AGENTS_KEY, page, pageSize],
    queryFn: () => api.list<AgentListItem>(`/agents?page=${page}&pageSize=${pageSize}`),
    enabled,
  })
}

export function useAllAgents(params?: { enabled?: boolean }) {
  const { enabled } = params ?? {}
  return useQuery({
    queryKey: [...AGENTS_KEY, 'all'],
    queryFn: async () => {
      const pageSize = 100
      const firstPage = await api.list<Agent>(`/agents?page=1&pageSize=${pageSize}`)
      const pages = [firstPage.data]

      for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
        const nextPage = await api.list<Agent>(`/agents?page=${page}&pageSize=${pageSize}`)
        pages.push(nextPage.data)
      }

      return {
        data: pages.flat(),
        total: firstPage.pagination.total,
      }
    },
    enabled,
  })
}

/** Selected shape for `useAgent` — surfaces both the agent payload and the
 * caller's permission level (carried via `meta.permission`).
 */
export type AgentDetailSelection = {
  data: Agent
  permission: AgentPermission | undefined
  /** Resources a caller may newly attach under the Agent owner's runtime permissions. */
  skillBindingScope: 'all-visible' | 'owner-or-shared'
}

export function useAgent(id: string) {
  return useQuery({
    queryKey: [...AGENTS_KEY, id],
    queryFn: () => api.get<Agent>(`/agents/${id}`),
    select: (res): AgentDetailSelection => ({
      data: res.data,
      permission: (res.meta?.permission as AgentPermission | undefined) ?? undefined,
      skillBindingScope:
        res.meta?.skillBindingScope === 'all-visible' ? 'all-visible' : 'owner-or-shared',
    }),
    enabled: !!id,
    // Permission and binding scope are live access-control projections. They must
    // not inherit the global five-minute cache because the Agent owner's role may
    // change in another session while this editor page remains open.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })
}

export function useCreateAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateAgentInput) => api.post<Agent>('/agents', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENTS_KEY }),
  })
}

export function useUpdateAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateAgentInput & { id: string }) =>
      api.patch<Agent>(`/agents/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENTS_KEY }),
  })
}

export function useCloneAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<Agent>(`/agents/${id}/clone`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENTS_KEY }),
  })
}

/**
 * 置顶 / 取消置顶：pinnedAt 由服务端戳，前端只发意图，成功后 invalidate 列表触发重排。
 * 无乐观更新——排序依赖服务端 pinnedAt 精确顺序，等一次往返再刷新，避免乐观态与真实顺序不一致。
 */
export function useSetAgentPinned() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.post<Agent>(`/agents/${id}/${pinned ? 'pin' : 'unpin'}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: AGENTS_KEY }),
  })
}

export function useDeleteAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<Agent>(`/agents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AGENTS_KEY })
    },
  })
}

export type FeishuPublishConfig = {
  appId: string
  appSecret: string
  // 普通群
  groupTriggerOnAt: boolean
  groupTriggerOnNewMessage: boolean
  groupReplyMode: 'quote' | 'new' | 'none'
  // 话题群
  topicTriggerOnAt: boolean
  topicTriggerOnNewTopic: boolean
  topicTriggerOnNewComment: boolean
  topicReplyMode: 'topic_reply' | 'none'
  topicReplyMentionTarget: 'trigger_sender' | 'topic_creator' | 'none'
  /** Fetch the topic root's text, images, and files for each topic reply. */
  topicInjectRootMessage: boolean
  // P2P 单聊
  p2pReplyMode: 'quote' | 'new' | 'none'
  // 共享
  replyContentType: 'text' | 'post' | 'interactive' | 'interactive_card' | 'streaming_card'
  cardTemplateId?: string
  // 调试信息（回复末尾追加运行信息）
  debugShowSessionId?: boolean
  debugShowProvider?: boolean
  debugShowModel?: boolean
  sendArtifactsAsFile: boolean
  fetchUserInfo: boolean
  // 开场白
  welcomeMessage?: string
  welcomeOnP2pEnabled?: boolean
  welcomeP2pIdleDays?: number
  welcomeOnGroupAddedEnabled?: boolean
}

export type SlackPublishConfig = {
  appId: string
  appToken: string
  botToken: string
  groupTriggerOnAt: boolean
  groupTriggerOnNewMessage: boolean
  groupReplyMode: 'thread' | 'new' | 'none'
  p2pReplyMode: 'new' | 'none'
  sendArtifactsAsFile: boolean
}

export type DiscordPublishConfig = {
  applicationId: string
  botToken: string
  guildTriggerOnMention: boolean
  guildTriggerOnNewMessage: boolean
  guildReplyMode: 'reply' | 'new' | 'none'
  dmReplyMode: 'reply' | 'none'
  sendArtifactsAsFile: boolean
}

export type QQOfficialPublishConfig = {
  appId: string
  appSecret: string
  groupTriggerOnAt: boolean
  groupReplyMode: 'reply' | 'new' | 'none'
  c2cReplyMode: 'reply' | 'new' | 'none'
  sendArtifactsAsFile: boolean
}

/** Chat app page presentation config — copy only, never credentials. */
export type ChatAppPublishConfig = {
  displayName?: string
  welcomeMessage?: string
  suggestedQuestions: string[]
  showCreator: boolean
  allowAttachments: boolean
  showThinking: boolean
}

export type SchedulePublishConfig = {
  id?: string
  cron: string
  intent: string
  timezone: string
}

export type PublishConfig = {
  authType: 'none' | 'api_key'
  ipWhitelist: string[]
  description: string
  /** When false, preserves existing API key on update. Default: true for first publish. */
  regenerateApiKey?: boolean
  channels?: string[]
  oauthAccessMode?: 'all_idaas_users' | 'specified_users'
  /** Email allowlist; only meaningful under specified_users */
  oauthAllowedEmails?: string[]
  a2aSkills?: Array<{ id: string; name: string; description: string; tags: string[] }> | null
  feishuConfig?: FeishuPublishConfig | null
  slackConfig?: SlackPublishConfig | null
  discordConfig?: DiscordPublishConfig | null
  qqOfficialConfig?: QQOfficialPublishConfig | null
  chatAppConfig?: ChatAppPublishConfig | null
  scheduleConfig?: SchedulePublishConfig | SchedulePublishConfig[] | null
  /** GitLab 仓库轮询触发配置（glab CLI） */
  glabConfig?: GitTriggerConfig | null
  /** GitHub 仓库轮询触发配置（gh CLI） */
  ghConfig?: GitTriggerConfig | null
  /** A2A 入站独立鉴权方式（与 REST API 渠道解耦） */
  a2aAuthType?: 'none' | 'api_key'
  /** 信任上游 A2A 转发的用户身份（仅 a2aAuthType=api_key 生效） */
  trustForwardedIdentity?: boolean
  /** 定时任务以归属人身份过网关（仅 schedule 渠道生效） */
  scheduleRunAsOwner?: boolean
}

export function usePublishAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, config }: { id: string; config: PublishConfig }) =>
      api.post<Agent>(`/agents/${id}/publish`, {
        authType: config.authType,
        ipWhitelist: config.ipWhitelist,
        description: config.description,
        ...(config.regenerateApiKey !== undefined && { regenerateApiKey: config.regenerateApiKey }),
        ...(config.channels && { channels: config.channels }),
        ...(config.oauthAccessMode !== undefined && { oauthAccessMode: config.oauthAccessMode }),
        ...(config.oauthAllowedEmails !== undefined && {
          oauthAllowedEmails: config.oauthAllowedEmails,
        }),
        ...(config.a2aSkills !== undefined && { a2aSkills: config.a2aSkills }),
        ...(config.feishuConfig !== undefined && { feishuConfig: config.feishuConfig }),
        ...(config.slackConfig !== undefined && { slackConfig: config.slackConfig }),
        ...(config.discordConfig !== undefined && { discordConfig: config.discordConfig }),
        ...(config.qqOfficialConfig !== undefined && {
          qqOfficialConfig: config.qqOfficialConfig,
        }),
        ...(config.chatAppConfig !== undefined && { chatAppConfig: config.chatAppConfig }),
        ...(config.scheduleConfig !== undefined && { scheduleConfig: config.scheduleConfig }),
        ...(config.glabConfig !== undefined && { glabConfig: config.glabConfig }),
        ...(config.ghConfig !== undefined && { ghConfig: config.ghConfig }),
        ...(config.a2aAuthType !== undefined && { a2aAuthType: config.a2aAuthType }),
        ...(config.trustForwardedIdentity !== undefined && {
          trustForwardedIdentity: config.trustForwardedIdentity,
        }),
        ...(config.scheduleRunAsOwner !== undefined && {
          scheduleRunAsOwner: config.scheduleRunAsOwner,
        }),
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: AGENTS_KEY }),
        ...CONNECTION_QUERY_KEYS.map((key) => qc.invalidateQueries({ queryKey: key })),
      ])
    },
  })
}

/** Channels whose config can be saved on its own, independently of publishing. */
export type ConfigurableChannel =
  | 'feishu'
  | 'slack'
  | 'discord'
  | 'qq_official'
  | 'chat_app'
  | 'schedule'
  | 'glab'
  | 'gh'

/**
 * Discriminated on `channel` so a Slack config cannot be sent to the Feishu
 * route. Written as a union rather than a generic mutationFn — TanStack Query
 * cannot infer variables through a generic signature.
 */
export type SaveChannelConfigVars =
  | { id: string; channel: 'feishu'; config: FeishuPublishConfig }
  | { id: string; channel: 'slack'; config: SlackPublishConfig }
  | { id: string; channel: 'discord'; config: DiscordPublishConfig }
  | { id: string; channel: 'qq_official'; config: QQOfficialPublishConfig }
  | { id: string; channel: 'chat_app'; config: ChatAppPublishConfig }
  | { id: string; channel: 'schedule'; config: SchedulePublishConfig | SchedulePublishConfig[] }
  | { id: string; channel: 'glab'; config: GitTriggerConfig }
  | { id: string; channel: 'gh'; config: GitTriggerConfig }

/**
 * Saves one channel's config without publishing the agent.
 *
 * Configuring and enabling are separate actions: this writes only that
 * channel's config column, so a draft agent stays a draft and no long
 * connection is started. Enabling still goes through publish, which owns
 * `publishChannels`.
 */
export function useSaveChannelConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, channel, config }: SaveChannelConfigVars) =>
      api.patch<Agent>(`/agents/${id}/channels/${channel}`, { config }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AGENTS_KEY })
      for (const key of CONNECTION_QUERY_KEYS) qc.invalidateQueries({ queryKey: key })
    },
  })
}

export function useStopAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<Agent>(`/agents/${id}/stop`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AGENTS_KEY })
      for (const key of CONNECTION_QUERY_KEYS) qc.invalidateQueries({ queryKey: key })
    },
  })
}

/** 与 API 侧 FEISHU_WS_POLL_MS 对齐：首轮 socket OPEN 后再拉一次连接状态 */
const CHAT_WS_STATUS_REFETCH_DELAY_MS = 2500

export function useResumeAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<Agent>(`/agents/${id}/resume`, {}),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: AGENTS_KEY })
      // Concurrently: the two endpoints are independent, so awaiting them in
      // sequence would make the operator wait for the sum of both round trips
      // before the resume button re-enables.
      await Promise.all(
        CONNECTION_QUERY_KEYS.map(async (key) => {
          await qc.invalidateQueries({ queryKey: key })
          await qc.refetchQueries({ queryKey: key })
        }),
      )
      setTimeout(() => {
        for (const key of CONNECTION_QUERY_KEYS) void qc.invalidateQueries({ queryKey: key })
      }, CHAT_WS_STATUS_REFETCH_DELAY_MS)
    },
  })
}

// 重置/生成密钥不 invalidate agents 查询：明文 key 由响应一次性返回并弹 modal 展示，
// 表单只关心「key 是否存在」（本地标记即可）。若在此 invalidate，会触发 agent detail 重拉，
// 进而让 publish-tab 的 useEffect 用已持久化的 publishChannels 覆盖未保存的本地表单状态
// （典型表现：A2A 开关被重置回关闭）。详见 publish-tab 的 a2aKeyGenerated 处理。
export function useRegenerateApiKey() {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ endpointApiKey: string }>(`/agents/${id}/regenerate-api-key`, {}),
  })
}

export function useRegenerateA2aApiKey() {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ a2aEndpointApiKey: string }>(`/agents/${id}/regenerate-a2a-api-key`, {}),
  })
}

export type QQOfficialRegistrationTask = {
  taskId: string
  bindKey: string
  qrCodeUrl: string
  intervalMs: number
}

export type QQOfficialRegistrationResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'completed'; appId: string; appSecret: string }

export function useQQOfficialRegistration() {
  return useMutation({
    mutationFn: async (
      input:
        | { agentId: string; action: 'start' }
        | { agentId: string; action: 'poll'; taskId: string; bindKey: string },
    ) => {
      if (input.action === 'start') {
        return api.post<QQOfficialRegistrationTask>(
          `/agents/${input.agentId}/qq-official/registration`,
          { action: 'start' },
        )
      }
      return api.post<QQOfficialRegistrationResult>(
        `/agents/${input.agentId}/qq-official/registration`,
        { action: 'poll', taskId: input.taskId, bindKey: input.bindKey },
      )
    },
  })
}

export function useChatAgent() {
  return useMutation({
    mutationFn: ({ id, message }: { id: string; message: string }) =>
      api.post<{ reply: string }>(`/agents/${id}/chat`, { message }),
  })
}

/** Stream 日志条目 — 与后端 StreamLogEntry 对应 */
export type StreamLogEntry =
  | {
      type: 'system'
      subtype: string
      model?: string
      providerName?: string
      nextProviderName?: string
      metadata?: {
        target?: string
        taskId?: string
        contextId?: string
        state?: string
        attempt?: number
      }
      /** log_file_size_capped / log_file_entries_dropped 标记携带的丢弃条数 */
      dropped?: number
      ts: number
    }
  | { type: 'assistant'; text: string; ts: number }
  | {
      type: 'tool_call'
      subtype: 'started' | 'completed' | 'failed'
      callId: string
      toolName: string
      input?: Record<string, unknown>
      error?: string
      metadata?: Record<string, unknown>
      ts: number
    }
  | { type: 'tool_heartbeat'; callId: string; toolName: string; elapsedMs: number; ts: number }
  | {
      type: 'result'
      subtype: string
      durationMs?: number
      /** The engine's verdict on fast mode; absent when it reported none. */
      fastModeState?: FastModeState
      usage?: {
        inputTokens?: number
        outputTokens?: number
        reasoningTokens?: number
        cacheReadTokens?: number
        cacheWriteTokens?: number
      }
      ts: number
    }
  | { type: 'error'; message: string; ts: number }
  | { type: 'retry'; attempt: number; nextAttemptIn: number; ts: number }
  | { type: 'exec_params'; engine: string; params: Record<string, unknown>; ts: number }

export type StreamCallbacks = {
  onUpdate?: (content: string) => void
  onDone?: (reply: string, chatId?: string) => void
  onError?: (error: string) => void
  onLog?: (entry: StreamLogEntry) => void
}

export function useChatAgentStream() {
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(
    async (
      { id, message, chatId }: { id: string; message: string; chatId?: string },
      callbacks?: StreamCallbacks,
    ) => {
      abortControllerRef.current?.abort()
      const controller = new AbortController()
      abortControllerRef.current = controller

      setIsStreaming(true)
      setError(null)

      try {
        const response = await fetch(`/api/agents/${id}/chat`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, stream: true, chatId }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Request failed' }))
          throw new Error(err.error || `HTTP ${response.status}`)
        }

        if (!response.body) throw new Error('No response body')

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          let eventType = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                if (eventType === 'update' && data.content) {
                  callbacks?.onUpdate?.(data.content)
                } else if (eventType === 'log') {
                  callbacks?.onLog?.(data as StreamLogEntry)
                } else if (eventType === 'done') {
                  callbacks?.onDone?.(data.reply, data.chatId)
                } else if (eventType === 'error') {
                  const errMsg = data.error || 'Execution failed'
                  setError(errMsg)
                  callbacks?.onError?.(errMsg)
                }
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        const errMsg = err instanceof Error ? err.message : 'Stream failed'
        setError(errMsg)
        callbacks?.onError?.(errMsg)
      } finally {
        setIsStreaming(false)
      }
    },
    [],
  )

  const abort = useCallback(() => {
    abortControllerRef.current?.abort()
    setIsStreaming(false)
  }, [])

  return { sendMessage, isStreaming, error, abort }
}

export type ChatStatus = {
  canChat: boolean
  reason: string | null
}

export function useAgentChatStatus(agentId: string): ChatStatus {
  const { data: selection } = useAgent(agentId)
  const agent = selection?.data

  if (!agent) return { canChat: false, reason: 'Agent not loaded' }
  if (agent.status !== 'active') return { canChat: false, reason: 'Agent is inactive.' }

  return { canChat: true, reason: null }
}

/**
 * Probes `glab` / `gh` installation and authentication for the config dialog.
 *
 * A plain function rather than a query hook: it is a deliberate user action
 * ("check now") that spawns a subprocess, so it must not run on mount or be
 * refetched in the background by cache invalidation.
 */
export async function fetchGitTriggerCliStatus(
  agentId: string,
  provider: GitTriggerProvider,
  host?: string,
): Promise<GitTriggerCliStatus> {
  const params = new URLSearchParams({ provider })
  if (host) params.set('host', host)
  const res = await api.get<GitTriggerCliStatus>(
    `/agents/${agentId}/git-trigger/status?${params.toString()}`,
  )
  return res.data
}
