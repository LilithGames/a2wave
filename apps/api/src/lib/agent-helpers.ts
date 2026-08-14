import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PROVIDER_CHAIN_MAX, providerKindSchema } from '@a2wave/shared'
import type {
  AuthHeaderStyle,
  GitConfig,
  GroupBackend,
  GroupConfig,
  P4Config,
  ProviderChainItem,
  ProviderKind,
  ProviderMcpDelivery,
  WorktreeCallParams,
} from '@a2wave/shared'
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  agents,
  kbDocuments,
  mcpServers,
  providers,
  runs,
  scmSources,
  skills,
  users,
} from '../db/schema.js'
import { runExclusive, withTransaction } from '../db/transaction.js'
import { kbDocFilename } from '../engine/kb-sync.js'
import type { ResolvedMcpServer } from '../engine/mcp-sync.js'
import { providerCatalog } from '../engine/provider-catalog.js'
import { env } from '../env.js'
import { RUNTIME_MEMORY_READ_ACTIONS, registerAgentToken } from './agent-memory-token.js'
import { logBackgroundAudit } from './audit.js'
import { ensureCodegraphLink, isCodegraphEnabled } from './codegraph-index.js'
import {
  ProviderBindingInvalidError,
  ProviderChainTooLongError,
  ProviderConfigurationError,
  ProviderMcpUnsupportedError,
  UnusableProviderChainError,
} from './errors.js'
import {
  WORKTREE_NAME_REGEX,
  WorktreeBranchLockedError,
  WorktreeDirtyError,
  isPerAgentWorkspaceName,
  perAgentWorkspaceName,
  readWorkspaceState,
} from './git-workspace.js'
import { INTERNAL_ADMIN_TOKEN_ENV, getInternalAdminToken } from './internal-admin-auth.js'
import { withKeyedLock } from './keyed-mutex.js'
import { logger } from './logger.js'
import { canNonAdminUseMcp, introducesStdioExecution } from './mcp-stdio.js'
import { cleanupLegacyRuntimeGroupConfig } from './runtime-group-config.js'
import { type CreateWorkspaceResult, type ScmSource, createScmSource } from './scm-source.js'
import {
  findPendingWorkspaceRemoval,
  removeSourceWorkspaceGuarded,
} from './scm-workspace-removal.js'
import {
  isControlPlaneOnlyBuiltinMcp,
  isOwnerSafeBuiltinMcp,
  resolveBuiltinMcpConfig,
} from './seed-builtin-mcp.js'
import { getCategorySettings } from './settings.js'
import { canAgentOwnerUseSkill } from './skill-access.js'
import { slugify } from './slug.js'

type AgentRow = typeof agents.$inferSelect
type McpRow = typeof mcpServers.$inferSelect

interface McpRuntimeAuthorization {
  requesterIsActiveAdmin: boolean
  agentOwnerIsActiveAdmin: boolean
}

const CODEGRAPH_SKILL_CONTENT = `# CodeGraph

This workspace has a CodeGraph index in \`.codegraph/\`.

## Usage
- Prefer \`codegraph explore "<question or symbols>"\` when you need to understand a feature, flow, or cross-file behavior.
- Use \`codegraph node <symbol-or-file>\` to inspect one symbol or file with callers and related code.
- Use CodeGraph before broad grep/read-file exploration when the question is about code structure, call paths, or impact.
- If CodeGraph reports that no index exists or the command fails, continue with the normal file and search tools.`

async function toResolvedMcp(
  s: McpRow,
  extraEnv?: Record<string, string>,
  authorization: McpRuntimeAuthorization = {
    requesterIsActiveAdmin: false,
    agentOwnerIsActiveAdmin: false,
  },
  agentOwnerId?: string | null,
): Promise<ResolvedMcpServer> {
  // Group type → convert to stdio proxy process
  if (s.type === 'group' && s.groupConfig) {
    // Ref access is decided against the AGENT owner (who is binding and running the
    // group), NOT the group MCP's own owner. Using s.userId here would be a confused
    // deputy: an admin's all-users group that refs the admin's OWN private server
    // would resolve that server's credentials for ANY user who binds the group,
    // because canNonAdminUseMcp(private, ownerId=adminId) is true. Passing the agent
    // owner's id makes the ref check match what the agent owner could bind directly.
    const resolvedGroupConfig = await resolveGroupRefs(
      s.groupConfig as GroupConfig,
      agentOwnerId,
      authorization,
    )
    // (ref access is decided inside resolveGroupRefs via canNonAdminUseMcp)
    const proxyConfig = resolveBuiltinMcpConfig('a2wave-mcp-group-proxy')
    // buildAgentConfig is also used by diagnostics and snapshots, so it must not
    // create credential-bearing files. Keep the filtered config in memory;
    // executeInWorker materializes a unique per-attempt carrier immediately
    // before engine startup. The group name remains safe to inline per server.
    const groupPublicEnv = { A2WAVE_GROUP_NAME: s.name }
    const env = {
      ...proxyConfig.env,
      ...groupPublicEnv,
      ...extraEnv,
    }
    return {
      name: s.name,
      type: 'stdio',
      command: proxyConfig.command,
      args: proxyConfig.args,
      env,
      publicEnvKeys: Object.keys(groupPublicEnv),
      runtimeGroupConfig: {
        legacyMcpServerId: s.id,
        config: resolvedGroupConfig,
      },
    }
  }

  const env = { ...(s.env ? s.env : {}), ...extraEnv }
  return {
    name: s.name,
    type: s.type as 'stdio' | 'sse' | 'http',
    command: s.command,
    args: s.args,
    cwd: s.cwd ?? undefined,
    url: s.url,
    headers: s.headers || undefined,
    env: Object.keys(env).length > 0 ? env : undefined,
  }
}

type ResolvedInlineBackend = {
  mode: 'inline'
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string | null
  args?: string[]
  cwd?: string | null
  url?: string | null
  headers?: Record<string, string> | null
  env?: Record<string, string> | null
}

/** Resolve ref backends in a GroupConfig by looking up the referenced MCP Server from DB.
 *  `ownerId` is the AGENT owner (the user binding/running the group), NOT the group
 *  MCP's own owner — ref access must match what THIS agent owner could bind directly,
 *  else a shared group becomes a confused deputy that leaks its author's private refs.
 *  Runtime authorization decides whether an admin-only or stdio ref may resolve. */
async function resolveGroupRefs(
  groupConfig: GroupConfig,
  ownerId?: string | null,
  authorization: McpRuntimeAuthorization = {
    requesterIsActiveAdmin: false,
    agentOwnerIsActiveAdmin: false,
  },
): Promise<{ backends: Record<string, ResolvedInlineBackend[]> }> {
  // Batch-fetch all ref targets in one query
  const allRefIds: string[] = []
  for (const backends of Object.values(groupConfig.backends)) {
    for (const b of backends) {
      if (b.mode === 'ref') allRefIds.push(b.mcpServerId)
    }
  }
  const refMap = new Map<string, typeof mcpServers.$inferSelect>()
  if (allRefIds.length > 0) {
    // Resolve refs the group owner may use: their OWN rows, plus genuinely shared
    // ones (all-users) and system builtins (userId IS NULL). An active admin owner
    // or requester may fetch admin-bound refs. The per-row predicate below still
    // gates each candidate's execution capability and private ownership.
    const scopeCondition = ownerId
      ? or(
          eq(mcpServers.userId, ownerId),
          eq(mcpServers.usageScope, 'all-users'),
          isNull(mcpServers.userId),
        )
      : undefined
    const condition =
      canRunAdminBoundMcp(authorization) || !scopeCondition
        ? inArray(mcpServers.id, allRefIds)
        : and(inArray(mcpServers.id, allRefIds), scopeCondition)
    const rows = await db.select().from(mcpServers).where(condition)
    for (const row of rows) refMap.set(row.id, row)
  }

  const resolved: Record<string, ResolvedInlineBackend[]> = {}

  for (const [groupKey, backends] of Object.entries(groupConfig.backends)) {
    const resolvedBackends: ResolvedInlineBackend[] = []

    for (const backend of backends) {
      if (backend.mode === 'inline') {
        resolvedBackends.push(backend)
        continue
      }

      // mode === 'ref'
      const refServer = refMap.get(backend.mcpServerId)

      if (!refServer) {
        logger.warn(
          { mcpServerId: backend.mcpServerId },
          'Group ref target not found or not accessible, skipping',
        )
        continue
      }

      // Skip group type refs (prevent recursion)
      if (refServer.type === 'group') {
        logger.warn(
          { mcpServerId: backend.mcpServerId, name: refServer.name },
          'Group ref targets another group, skipping',
        )
        continue
      }

      // Re-apply the SAME access predicate at ref resolution: a group ref must not
      // reach a server the agent owner couldn't bind directly (an admin narrowing a
      // server to admin-only/private is bypassed otherwise — the owner references it
      // in their own group and its URL/headers/env get written into the proxy config
      // and run). A current active admin requester may bypass owner scope, while
      // an active admin Agent owner may use admin-bound refs.
      // usage_scope already encodes stdio => admin-only; the explicit stdio check
      // is belt-and-suspenders for legacy rows.
      if (isMcpBlockedAtRuntime(refServer, ownerId, authorization)) {
        logger.warn(
          { mcpServerId: backend.mcpServerId, name: refServer.name },
          'Group ref target not usable by the agent owner (scope/stdio), skipping',
        )
        continue
      }

      // Sanitize name: replace disallowed characters with hyphens, append short ID to prevent collisions
      const baseName = refServer.name
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
      const shortId = refServer.id.replace(/^mcp_/, '').slice(0, 6)
      const safeName = baseName ? `${baseName}-${shortId}` : `ref-${refServer.id}`
      const controlPlaneEnv = getControlPlaneMcpRuntimeEnv(
        refServer,
        authorization.requesterIsActiveAdmin,
      )
      resolvedBackends.push({
        mode: 'inline',
        name: safeName,
        type: refServer.type as 'stdio' | 'sse' | 'http',
        command: refServer.command,
        args: refServer.args,
        cwd: refServer.cwd,
        url: refServer.url,
        headers: refServer.headers,
        env: controlPlaneEnv ? { ...refServer.env, ...controlPlaneEnv } : refServer.env,
      })
    }

    if (resolvedBackends.length > 0) {
      resolved[groupKey] = resolvedBackends
    }
  }

  return { backends: resolved }
}

/** Remove a legacy deterministic group config file (best-effort; never read or written). */
export function cleanupTempGroupConfig(mcpServerId: string): void {
  cleanupLegacyRuntimeGroupConfig(mcpServerId)
}

/** Resolved agent configuration produced by buildAgentConfig */
export interface AgentConfig {
  /** Agent ID — buildAgentConfig 写入，供执行链路日志与归因 */
  agentId?: string
  /** Agent 可读名 */
  agentName?: string
  providerKind?: ProviderKind
  engineType?: string
  model?: string
  fallbackModels?: string[]
  providerId?: string | null
  providerName?: string
  providerChain?: unknown
  initScript?: string | null
  checkScript?: string | null
  skillsDir?: string
  mcpConfigPath?: string
  mcpDelivery?: ProviderMcpDelivery
  systemPrompt?: string
  /** 交互卡片规范说明：仅 interactive_card 回复格式注入，prompt-builder 渲染为独立 <interactive_card> 标签 */
  interactiveCardPrompt?: string
  resolvedSkills?: Array<{
    name: string
    description?: string | null
    content: string | null
    storagePath?: string | null
  }>
  // `id` is load-bearing, not incidental: it is the sole input to `kbDocFilename`, which
  // the workspace writer calls before base-engine's try/catch — a producer that omitted it
  // would throw there and fail every run of every Agent mounting the document.
  resolvedKbDocs?: Array<{ id: string; name: string; storagePath: string | null }>
  resolvedMcpServers?: ResolvedMcpServer[]
  availableAgentsSummary?: Array<{
    id: string
    name: string
    description: string
    source: 'local' | 'remote'
  }>
  agentEnv?: Record<string, string>
  providerApiKey?: string
  providerBaseUrl?: string
  providerOauthToken?: string
  authMode?: 'apiKey' | 'oauth' | 'localSession'
  authHeaderStyle?: AuthHeaderStyle
  readOnly?: boolean
  force?: boolean
  workDir?: string
  workspaceType?: 'scm' | 'temp'
  scmSourceId?: string | null
  /** 单次执行超时（分钟），5–120，默认 10 */
  timeoutMinutes?: number
  /** 单个 Provider 的最大重试次数，0–5，默认 2；预算用尽后换链上下一个 Provider */
  maxRetries?: number
  /** 整个 Run 的挂钟预算（分钟），5–600；未配置则不限。在两次执行之间判定，不打断进行中的 worker */
  totalTimeoutMinutes?: number
  [key: string]: unknown
}

export interface ResolvedProviderBinding {
  id: string
  providerId: string
  providerName: string
  providerKind: ProviderKind
  /** Compatibility alias consumed by the current engine registry. */
  engineType: ProviderKind
  model?: string
  initScript?: string | null
  checkScript?: string | null
  skillsDir?: string
  mcpConfigPath?: string
  mcpDelivery: ProviderMcpDelivery
  providerApiKey?: string
  providerBaseUrl?: string
  providerOauthToken?: string
  authMode: 'apiKey' | 'oauth' | 'localSession'
  authHeaderStyle?: AuthHeaderStyle
}

type AvailableAgentSummary = NonNullable<AgentConfig['availableAgentsSummary']>[number]

interface LocalRouteTarget {
  type: 'local'
  agentId: string
}

interface RemoteRouteTarget {
  type: 'remote'
  name: string
  url: string
  description?: string
  apiKey?: string
}

type RouteTarget = LocalRouteTarget | RemoteRouteTarget

const TIMEOUT_MIN = 5
const TIMEOUT_MAX = 120
const RETRIES_MIN = 0
const RETRIES_MAX = 5
// 总预算的下界取单次 timeout 的下界；上界给足 5 provider × 6 次 × 长任务的空间。
const TOTAL_TIMEOUT_MIN = 5
const TOTAL_TIMEOUT_MAX = 600

function clampTimeout(v: number): number {
  return Math.max(TIMEOUT_MIN, Math.min(TIMEOUT_MAX, v))
}

function clampRetries(v: number): number {
  return Math.max(RETRIES_MIN, Math.min(RETRIES_MAX, Math.floor(v)))
}

function clampTotalTimeout(v: number): number {
  return Math.max(TOTAL_TIMEOUT_MIN, Math.min(TOTAL_TIMEOUT_MAX, Math.floor(v)))
}

function authModeFrom(
  value: unknown,
  fallback: 'apiKey' | 'oauth' | 'localSession',
): 'apiKey' | 'oauth' | 'localSession' {
  return value === 'localSession' || value === 'oauth' || value === 'apiKey' ? value : fallback
}

function unmasked(value: string | null | undefined): string | null | undefined {
  return value === '********' ? undefined : value
}

function requireProviderKind(providerId: string, value: unknown): ProviderKind {
  const parsed = providerKindSchema.safeParse(value)
  if (!parsed.success) {
    throw new ProviderConfigurationError(providerId, String(value))
  }
  return parsed.data
}

/**
 * 从已 build 的 AgentConfig 中提取最终生效的 engineType。
 * 优先用 providerChain 解析出的 engineType，退化到 agent.type（cursor/llm/script），
 * 最终兜底 'cursor'。集中此逻辑以便 router/UI/网关共享同一份兜底链。
 */
export function resolveEngineType(agentConfig: AgentConfig, agentType?: string | null): string {
  return agentConfig.engineType || agentType || 'cursor'
}

async function resolveProviderBinding(
  agent: AgentRow,
  binding: ProviderChainItem,
  index: number,
  options: { allowLegacySecrets?: boolean } = {},
): Promise<ResolvedProviderBinding | null> {
  if (!binding.providerId) return null
  const provider = (
    await db.select().from(providers).where(eq(providers.id, binding.providerId)).limit(1)
  )[0]
  if (!provider) return null

  const providerKind = requireProviderKind(provider.id, provider.kind)
  const providerAdapter = providerCatalog.getOrThrow(providerKind)
  const authMode = authModeFrom(
    binding.authMode,
    providerAdapter.manifest.capabilities.defaultAuthMode,
  )
  const resolved: ResolvedProviderBinding = {
    id: binding.id || `provider-${index + 1}`,
    providerId: provider.id,
    providerName: provider.name ?? '',
    providerKind,
    engineType: providerKind,
    model: binding.model || undefined,
    initScript: provider.initScript,
    checkScript: provider.checkScript,
    authMode,
    mcpDelivery: providerAdapter.manifest.capabilities.mcpDelivery,
  }
  if (provider.skillsDir) resolved.skillsDir = provider.skillsDir
  if (provider.mcpConfigPath) resolved.mcpConfigPath = provider.mcpConfigPath
  if (providerKind === 'claude-code' && authMode === 'apiKey') {
    resolved.authHeaderStyle = binding.authHeaderStyle === 'bearer' ? 'bearer' : 'x-api-key'
  }
  if (authMode !== 'localSession') {
    const apiKey =
      unmasked(binding.providerApiKey) ??
      (options.allowLegacySecrets ? agent.providerApiKey : undefined)
    const baseUrl =
      unmasked(binding.providerBaseUrl) ??
      (options.allowLegacySecrets ? agent.providerBaseUrl : undefined)
    const oauthToken =
      unmasked(binding.providerOauthToken) ??
      (options.allowLegacySecrets ? agent.providerOauthToken : undefined)
    if (apiKey) resolved.providerApiKey = apiKey
    if (baseUrl) resolved.providerBaseUrl = baseUrl
    if (oauthToken) resolved.providerOauthToken = oauthToken
  }

  // Most legacy engines deliberately allow an Agent binding to fall back to a
  // deployment-level credential, so their model-probe requirement must not be
  // turned into a blanket activation requirement here. Pi apiKey mode has no
  // such fallback. Codex may fall back only while it also uses the deployment
  // endpoint: pairing an Agent-controlled URL with a deployment key would leak
  // that key to an untrusted proxy.
  const requiresAgentScopedCredentials =
    (providerKind === 'pi' && authMode === 'apiKey') ||
    (providerKind === 'codex' && authMode === 'apiKey' && Boolean(resolved.providerBaseUrl?.trim()))
  if (requiresAgentScopedCredentials) {
    const validation = providerAdapter.validateBinding({
      authMode,
      ...(resolved.authHeaderStyle ? { authHeaderStyle: resolved.authHeaderStyle } : {}),
      ...(resolved.providerApiKey ? { apiKey: resolved.providerApiKey } : {}),
      ...(resolved.providerBaseUrl ? { baseUrl: resolved.providerBaseUrl } : {}),
      ...(resolved.providerOauthToken ? { oauthToken: resolved.providerOauthToken } : {}),
    })
    if (!validation.valid) {
      throw new ProviderBindingInvalidError(
        agent.id,
        resolved.id,
        provider.id,
        providerKind,
        provider.name || provider.id,
        validation.code,
        validation.missingFields,
        validation.message || 'Provider binding validation failed',
      )
    }
  }
  return resolved
}

export function clearProviderBinding(agentConfig: AgentConfig): void {
  agentConfig.providerId = undefined
  agentConfig.providerName = undefined
  agentConfig.providerKind = undefined
  agentConfig.engineType = undefined
  agentConfig.initScript = undefined
  agentConfig.checkScript = undefined
  agentConfig.model = undefined
  agentConfig.skillsDir = undefined
  agentConfig.mcpConfigPath = undefined
  agentConfig.mcpDelivery = undefined
  agentConfig.providerApiKey = undefined
  agentConfig.providerBaseUrl = undefined
  agentConfig.providerOauthToken = undefined
  agentConfig.authHeaderStyle = undefined
}

export function applyProviderBinding(
  agentConfig: AgentConfig,
  binding: ResolvedProviderBinding,
): void {
  clearProviderBinding(agentConfig)
  agentConfig.providerId = binding.providerId
  agentConfig.providerName = binding.providerName
  agentConfig.providerKind = binding.providerKind
  agentConfig.engineType = binding.engineType
  agentConfig.initScript = binding.initScript
  agentConfig.checkScript = binding.checkScript
  agentConfig.authMode = binding.authMode
  if (binding.authHeaderStyle) agentConfig.authHeaderStyle = binding.authHeaderStyle
  if (binding.model) agentConfig.model = binding.model
  if (binding.skillsDir) agentConfig.skillsDir = binding.skillsDir
  if (binding.mcpConfigPath) agentConfig.mcpConfigPath = binding.mcpConfigPath
  agentConfig.mcpDelivery = binding.mcpDelivery
  if (binding.authMode !== 'localSession') {
    if (binding.providerApiKey) agentConfig.providerApiKey = binding.providerApiKey
    if (binding.providerBaseUrl) agentConfig.providerBaseUrl = binding.providerBaseUrl
    if (binding.providerOauthToken) agentConfig.providerOauthToken = binding.providerOauthToken
  }
}

function getConfiguredProviderChain(agentConfig: AgentConfig): {
  hasConfiguredChain: boolean
  enabledChain: ProviderChainItem[]
  rawLength: number
} {
  const raw = agentConfig.providerChain
  if (!Array.isArray(raw)) return { hasConfiguredChain: false, enabledChain: [], rawLength: 0 }
  return {
    hasConfiguredChain: true,
    rawLength: raw.length,
    enabledChain: raw.filter(
      (item): item is ProviderChainItem =>
        !!item &&
        typeof item === 'object' &&
        'providerId' in item &&
        (item as ProviderChainItem).enabled !== false,
    ),
  }
}

/**
 * Build a fully resolved agent config from an AgentRow.
 *
 * Steps:
 * 1. Spread agent.config
 * 2. Merge Provider config (engineType, initScript, checkScript, skillsDir)
 * 3. Inject systemPrompt
 * 4. Resolve and mount Skills (resolvedSkills)
 * 5. Flatten env + injectScmEnv
 */
/**
 * Runtime RCE / privilege / IDOR backstop. Drops any bound MCP server that is
 * not authorized for this execution:
 *   - stdio-capable (top-level stdio or a group with an inline stdio backend →
 *     arbitrary host commands),
 *   - adminOnly (e.g. platform-admin → global MCP/Provider/Settings/user/audit),
 *   - owned by a DIFFERENT user (its URL/headers/env — private credentials —
 *     would otherwise be resolved under this agent: a cross-owner IDOR).
 *
 * The bind-time gate and clone filter only guard NEW bindings. Bindings created
 * before those checks, surviving a PATCH that skips existing ids, or owned by a
 * later-demoted administrator therefore need this runtime recheck. Enforced HERE
 * because every execution entrypoint funnels through buildAgentConfig. Dropped
 * servers are audited.
 *
 * Generic admin-bound MCPs are authorized while either the Agent owner or an
 * explicitly named backend requester is still an active admin. Platform
 * builtins (userId === null) remain explicit exceptions: agent-router is safe
 * for every owner, while platform-admin requires the active backend requester.
 */
function canRunAdminBoundMcp(authorization: McpRuntimeAuthorization): boolean {
  return authorization.requesterIsActiveAdmin || authorization.agentOwnerIsActiveAdmin
}

function getControlPlaneMcpRuntimeEnv(
  server: McpRow,
  requesterIsActiveAdmin: boolean,
): Record<string, string> | undefined {
  if (!requesterIsActiveAdmin || !isControlPlaneOnlyBuiltinMcp(server.name, server.userId)) {
    return undefined
  }
  return { [INTERNAL_ADMIN_TOKEN_ENV]: getInternalAdminToken() }
}

function isMcpBlockedAtRuntime(
  server: McpRow,
  agentOwnerId: string | null | undefined,
  authorization: McpRuntimeAuthorization,
): boolean {
  if (isOwnerSafeBuiltinMcp(server.name, server.userId)) return false
  if (isControlPlaneOnlyBuiltinMcp(server.name, server.userId)) {
    return !authorization.requesterIsActiveAdmin
  }
  const descriptor = {
    type: server.type,
    groupConfig: server.groupConfig as GroupConfig | null,
    usageScope: server.usageScope,
    userId: server.userId,
  }
  const requiresAdmin =
    server.usageScope === 'admin-only' ||
    introducesStdioExecution(server.type, descriptor.groupConfig)
  if (requiresAdmin) return !canRunAdminBoundMcp(authorization)
  return !authorization.requesterIsActiveAdmin && !canNonAdminUseMcp(descriptor, agentOwnerId)
}

function filterRestrictedMcpForRuntime(
  agent: AgentRow,
  rows: McpRow[],
  authorization: McpRuntimeAuthorization,
  runtimeAdminRequesterUserId?: string,
): McpRow[] {
  const ownerId = agent.userId
  const restricted = rows.filter((server) => isMcpBlockedAtRuntime(server, ownerId, authorization))
  if (restricted.length === 0) return rows

  const blockedIds = new Set(restricted.map((s) => s.id))
  logBackgroundAudit({
    userId: runtimeAdminRequesterUserId ?? ownerId ?? undefined,
    action: 'agent.restricted_mcp_blocked',
    resource: 'agent',
    resourceId: agent.id,
    details: {
      reason: 'runtime_mcp_not_authorized',
      requesterUserId: runtimeAdminRequesterUserId,
      agentOwnerId: ownerId,
      requesterIsActiveAdmin: authorization.requesterIsActiveAdmin,
      agentOwnerIsActiveAdmin: authorization.agentOwnerIsActiveAdmin,
      blockedMcpServerIds: [...blockedIds],
    },
  })
  logger.warn(
    {
      agentId: agent.id,
      ownerId,
      runtimeAdminRequesterUserId,
      requesterIsActiveAdmin: authorization.requesterIsActiveAdmin,
      agentOwnerIsActiveAdmin: authorization.agentOwnerIsActiveAdmin,
      blockedMcpServerIds: [...blockedIds],
    },
    'Skipping MCP server(s) not authorized for this execution',
  )
  return rows.filter((s) => !blockedIds.has(s.id))
}

export interface BuildAgentConfigOptions {
  /**
   * Authenticated backend user requesting this execution. This is deliberately
   * an id rather than a persisted boolean: role and active state are re-read at
   * config-build time so queued work loses privilege after demotion or disable.
   * Omit for gateway, OAuth, A2A, native chat, schedules and other external work.
   */
  runtimeAdminRequesterUserId?: string
}

/**
 * Resolve and validate only the Provider portion of an Agent configuration.
 *
 * This function deliberately stops before Skills, MCP rows, group proxy files,
 * audit backstops, and memory-token registration. Activation boundaries can
 * therefore reject deterministic Provider configuration errors without causing
 * runtime-resolution side effects.
 */
async function resolveAgentProviderConfiguration(
  agent: AgentRow,
  agentConfig: AgentConfig,
): Promise<void> {
  // New agents may carry an ordered providerChain inside config; legacy agents
  // continue to use agents.provider_id + provider* columns exactly as before.
  const { hasConfiguredChain, enabledChain, rawLength } = getConfiguredProviderChain(agentConfig)

  // The length cap is enforced here as well as in the create/update schema:
  // import (agent-import.ts) and clone (routes/agents.ts) copy `config` verbatim,
  // and rows written before the cap existed are never revalidated. Checking the
  // RAW length (not the enabled subset) mirrors the schema, which counts entries
  // rather than enabled ones.
  if (rawLength > PROVIDER_CHAIN_MAX) {
    throw new ProviderChainTooLongError(agent.id, rawLength, PROVIDER_CHAIN_MAX)
  }
  // Promise.all: resolveProviderBinding reads the provider row, so the map
  // yields promises. Resolving together preserves chain order (fallback
  // priority) while keeping the reads concurrent.
  const resolvedChain = (
    await Promise.all(
      enabledChain.map((binding, index) => resolveProviderBinding(agent, binding, index)),
    )
  ).filter((binding): binding is ResolvedProviderBinding => Boolean(binding))
  let legacyBinding: ResolvedProviderBinding | null = null

  if (hasConfiguredChain) {
    clearProviderBinding(agentConfig)
    agentConfig.providerChain = resolvedChain
    // A chain that HAS entries but resolves to none means every one is disabled or
    // points at a deleted Provider. Fail loudly rather than run unbound —
    // executor.ts would otherwise default engineType to 'cursor' and launch a CLI
    // with no credentials, failing far from the actual cause. This deliberately
    // does NOT fall back to the legacy provider columns: an operator who disabled
    // the chain must not silently keep executing on the old top-level credentials.
    //
    // An EMPTY chain is different and must not throw: that is what the web client
    // persists for an Agent saved before a Provider was chosen. Such a draft still
    // needs to load in the editor so it can be repaired, and it still fails later
    // at the engine — just not here, where it would also break the save path.
    const configuredButUnresolvable = enabledChain.length > 0 && resolvedChain.length === 0
    if (configuredButUnresolvable) throw new UnusableProviderChainError(agent.id)
    if (resolvedChain.length > 0) applyProviderBinding(agentConfig, resolvedChain[0])
  } else if (agent.providerId) {
    legacyBinding = await resolveProviderBinding(
      agent,
      {
        providerId: agent.providerId,
        model: typeof agentConfig.model === 'string' ? agentConfig.model : undefined,
        authMode: agent.authMode,
        providerApiKey: agent.providerApiKey,
        providerBaseUrl: agent.providerBaseUrl,
        providerOauthToken: agent.providerOauthToken,
        enabled: true,
      },
      0,
      { allowLegacySecrets: true },
    )
    if (legacyBinding) applyProviderBinding(agentConfig, legacyBinding)
  }

  // An MCP-less Provider must never make a configured capability disappear at
  // runtime. Check every enabled Provider, not only the primary one: a fallback
  // can become active after retries and would otherwise silently lose the same
  // MCP tools. A2A routes count because they are delivered through the built-in
  // agent-router MCP even when the user did not mount a server directly.
  const hasMountedMcp = Array.isArray(agent.mcpServerIds) && agent.mcpServerIds.length > 0
  const hasA2aRoutes = Array.isArray(agent.a2aRouteTargets) && agent.a2aRouteTargets.length > 0
  if (hasMountedMcp || hasA2aRoutes) {
    const bindings = resolvedChain.length > 0 ? resolvedChain : legacyBinding ? [legacyBinding] : []
    const unsupported = bindings.find((binding) => binding.mcpDelivery.mode === 'none')
    if (unsupported) {
      throw new ProviderMcpUnsupportedError(
        agent.id,
        unsupported.providerId,
        unsupported.providerKind,
        unsupported.providerName || unsupported.providerId,
      )
    }
  }
}

/**
 * Validate the effective Provider configuration without resolving runtime
 * resources or producing runtime side effects.
 */
export async function validateAgentProviderConfiguration(agent: AgentRow): Promise<void> {
  const agentConfig: AgentConfig = { ...((agent.config || {}) as AgentConfig) }
  await resolveAgentProviderConfiguration(agent, agentConfig)
}

export async function buildAgentConfig(
  agent: AgentRow,
  options: BuildAgentConfigOptions = {},
): Promise<AgentConfig> {
  const agentConfig: AgentConfig = { ...((agent.config || {}) as AgentConfig) }
  // agentId is a runtime identity field derived from the DB row, not stored in config JSON.
  // Required by fetchMemoryContext to locate the agent's memory directory.
  agentConfig.agentId = agent.id
  // availableAgentsSummary 属于运行时派生字段，只能由下面 4c 基于 a2aRouteTargets 填充，
  // 清除 agent.config JSON 里可能残留的陈旧/畸形值，避免渲染时出现幽灵 agent 或非数组崩溃。
  agentConfig.availableAgentsSummary = undefined

  // Stamp identity so downstream execution logs can attribute the run.
  agentConfig.agentId = agent.id
  agentConfig.agentName = agent.name
  agentConfig.workspaceType = agent.workspaceType
  agentConfig.scmSourceId = agent.scmSourceId

  let agentOwnerLookupDone = false
  let agentOwner: { role: string; isActive: boolean } | undefined
  const getAgentOwner = async () => {
    if (agentOwnerLookupDone) return agentOwner
    agentOwnerLookupDone = true
    agentOwner = agent.userId
      ? (
          await db
            .select({ role: users.role, isActive: users.isActive })
            .from(users)
            .where(eq(users.id, agent.userId))
            .limit(1)
        )[0]
      : undefined
    return agentOwner
  }

  // 1. Merge and validate Provider configuration before resolving any runtime
  // resources. Activation preflights call the same logic through the side-effect-
  // free validateAgentProviderConfiguration() wrapper above.
  await resolveAgentProviderConfiguration(agent, agentConfig)

  // 2. Inject systemPrompt
  if (agent.systemPrompt) {
    agentConfig.systemPrompt = agent.systemPrompt
  }

  // 3. Resolve Skills（合并直挂 Skill + 分组下所有 Skill，去重）
  const directSkillIds = (agent.skills as string[] | null) || []
  const groupIds = (agent.skillGroupIds as string[] | null) || []
  let mountedSkills: Array<typeof skills.$inferSelect> = []
  if (directSkillIds.length > 0 || groupIds.length > 0) {
    // 一次查询拿回所有直挂 + 分组成员，SQLite OR 条件组合
    const byId =
      directSkillIds.length > 0
        ? await db.select().from(skills).where(inArray(skills.id, directSkillIds))
        : []
    const byGroup =
      groupIds.length > 0
        ? await db.select().from(skills).where(inArray(skills.groupId, groupIds))
        : []
    const seen = new Set<string>()
    const owner = await getAgentOwner()
    const ownerIsActiveAdmin = owner?.role === 'admin' && owner.isActive === true
    mountedSkills = [...byId, ...byGroup].filter((s) => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      return canAgentOwnerUseSkill(s, agent.userId, ownerIsActiveAdmin)
    })
  }
  if (mountedSkills.length > 0) {
    agentConfig.resolvedSkills = mountedSkills.map((s) => ({
      name: s.name,
      description: s.description,
      content: s.content,
      storagePath: s.storagePath,
    }))
  }

  // 3b. Resolve KB Documents & auto-inject KB Skill
  const agentKbDocIds = (agent.kbDocumentIds as string[] | null) || []
  if (agentKbDocIds.length > 0) {
    const kbDocs = await db.select().from(kbDocuments).where(inArray(kbDocuments.id, agentKbDocIds))
    if (kbDocs.length > 0) {
      agentConfig.resolvedKbDocs = kbDocs
        .filter((d) => d.storagePath)
        .map((d) => ({ id: d.id, name: d.name, storagePath: d.storagePath }))

      // Auto-generate KB Skill. Listed documents must be exactly the ones the workspace
      // writer copies: same `storagePath` filter (a metadata-only row has no file yet),
      // and the same filename helper (a second copy of the naming rule would hand the
      // Agent a path that is not on disk the moment either copy changes).
      const docList = agentConfig.resolvedKbDocs
        .map((d) => {
          const source = kbDocs.find((doc) => doc.id === d.id)
          return `- **${d.name}** (\`${kbDocFilename(d.id, d.name)}\`)${source?.description ? ` — ${source.description}` : ''}`
        })
        .join('\n')

      const kbSkillContent = `# Knowledge Base\n\nYou have reference documents in the \`.kb/\` directory of your workspace.\n\n## Available Documents\n${docList}\n\n## Usage\n- Read files from \`.kb/\` when the user's question may be answered by these documents\n- Use standard file reading tools to access document content\n- Cite the document name when referencing information from the KB`

      const existingSkills = agentConfig.resolvedSkills || []
      agentConfig.resolvedSkills = [
        ...existingSkills,
        {
          name: 'Knowledge Base',
          description: 'Reference documents available in the .kb/ directory of your workspace',
          content: kbSkillContent,
        },
      ]
    }
  }

  // 4. Resolve MCP Servers
  const agentMcpIds = (agent.mcpServerIds as string[] | null) || []
  const rawMcpRows =
    agentMcpIds.length > 0
      ? await db.select().from(mcpServers).where(inArray(mcpServers.id, agentMcpIds))
      : []
  // Re-read the Agent owner's role and active state for every build. Generic
  // admin-bound MCPs remain part of an admin-owned Agent's published capability
  // surface, including external channels, but fail closed immediately after the
  // owner is demoted, disabled, or deleted. An explicitly named active backend
  // admin requester is a second authorization path for control-plane execution.
  const owner = await getAgentOwner()
  const agentOwnerIsActiveAdmin = owner?.role === 'admin' && owner.isActive === true
  const runtimeRequesterUserId = options.runtimeAdminRequesterUserId
  const runtimeRequester = runtimeRequesterUserId
    ? runtimeRequesterUserId === agent.userId
      ? owner
      : (
          await db
            .select({ role: users.role, isActive: users.isActive })
            .from(users)
            .where(eq(users.id, runtimeRequesterUserId))
            .limit(1)
        )[0]
    : undefined
  const requesterIsActiveAdmin =
    runtimeRequester?.role === 'admin' && runtimeRequester.isActive === true
  const mcpRuntimeAuthorization = { requesterIsActiveAdmin, agentOwnerIsActiveAdmin }
  const mcpRows = filterRestrictedMcpForRuntime(
    agent,
    rawMcpRows,
    mcpRuntimeAuthorization,
    options.runtimeAdminRequesterUserId,
  )
  // toResolvedMcp resolves group refs from the DB, so the map yields promises;
  // Promise.all keeps the reads concurrent while preserving binding order.
  agentConfig.resolvedMcpServers = await Promise.all(
    mcpRows.map((s) => {
      let extraEnv: Record<string, string> | undefined
      if (s.name === 'a2wave-agent-router') {
        extraEnv = {
          ...(agent.a2aRouteTargets?.length
            ? { A2WAVE_ROUTE_TARGETS: JSON.stringify(agent.a2aRouteTargets) }
            : {}),
          A2WAVE_CALLER_AGENT_ID: agent.id,
          A2WAVE_CALLER_AGENT_NAME: agent.name,
        }
      } else {
        // The process credential never enters SQLite. Inject it only after system
        // ownership and the current runtime requester's active admin role are proven.
        extraEnv = getControlPlaneMcpRuntimeEnv(s, requesterIsActiveAdmin)
      }
      return toResolvedMcp(s, extraEnv, mcpRuntimeAuthorization, agent.userId)
    }),
  )

  // 自动注入 agent-router MCP：当 agent 配置了路由目标但未手动挂载时，自动追加
  if (agent.a2aRouteTargets?.length) {
    const alreadyIncluded = agentConfig.resolvedMcpServers.some(
      (s) => s.name === 'a2wave-agent-router',
    )
    if (!alreadyIncluded) {
      // Only the SYSTEM router row (userId IS NULL) may be auto-injected. Without
      // the userId filter, a user-created stdio MCP sharing the reserved name
      // 'a2wave-agent-router' could be picked up here — bypassing the runtime
      // backstop, which only guards the manually-bound rows above. Both the query
      // and isOwnerSafeBuiltinMcp enforce system ownership (name is not unique).
      const routerMcp = (
        await db
          .select()
          .from(mcpServers)
          .where(and(eq(mcpServers.name, 'a2wave-agent-router'), isNull(mcpServers.userId)))
          .limit(1)
      )[0]
      if (routerMcp && isOwnerSafeBuiltinMcp(routerMcp.name, routerMcp.userId)) {
        agentConfig.resolvedMcpServers.push(
          await toResolvedMcp(
            routerMcp,
            {
              A2WAVE_ROUTE_TARGETS: JSON.stringify(agent.a2aRouteTargets),
              A2WAVE_CALLER_AGENT_ID: agent.id,
              A2WAVE_CALLER_AGENT_NAME: agent.name,
            },
            mcpRuntimeAuthorization,
            agent.userId,
          ),
        )
      }
    }
  }

  // 4b. Inject auth：non-localSession 模式把所有 per-agent 凭证字段全部透传给引擎，
  //       由引擎自己的 buildEnv 按 authMode 决定注入哪份。这样 cursor/codex 在
  //       「authMode=oauth 但引擎不支持」回退到 apiKey 时仍能用 Agent 自己的 API Key，
  //       不会因 helper 层提前丢字段而被迫用全局 fallback 或失败。
  //       localSession 模式则全不透传，引擎也会主动剥离凭证类 env。
  // A resolved Provider binding has already applied its manifest default above.
  // The generic fallback is only for an unbound/legacy row with no Provider
  // manifest to consult.
  const authMode = agentConfig.authMode ?? authModeFrom(agent.authMode, 'apiKey')
  agentConfig.authMode = authMode
  if (!agentConfig.providerChain && authMode !== 'localSession') {
    if (agent.providerApiKey) agentConfig.providerApiKey = agent.providerApiKey
    if (agent.providerBaseUrl) agentConfig.providerBaseUrl = agent.providerBaseUrl
    if (agent.providerOauthToken) agentConfig.providerOauthToken = agent.providerOauthToken
  }

  // 4c. Resolve A2A available agents summary for prompt hints
  const routeTargets = (agent.a2aRouteTargets as RouteTarget[] | null) ?? []
  if (routeTargets.length > 0) {
    const localTargetIds = routeTargets
      .filter((target): target is LocalRouteTarget => target.type === 'local')
      .map((target) => target.agentId)

    const localAgentMap = new Map<string, typeof agents.$inferSelect>()
    if (localTargetIds.length > 0) {
      const localRows = await db.select().from(agents).where(inArray(agents.id, localTargetIds))

      for (const row of localRows) {
        const channels = (row.publishChannels as string[] | null) ?? ['api']
        if (row.publishStatus === 'published' && channels.includes('a2a')) {
          localAgentMap.set(row.id, row)
        }
      }
    }

    const summaries: AvailableAgentSummary[] = routeTargets.flatMap<AvailableAgentSummary>(
      (target) => {
        if (target.type === 'local') {
          const localAgent = localAgentMap.get(target.agentId)
          if (!localAgent) return []
          return [
            {
              id: localAgent.id,
              name: localAgent.name,
              description: localAgent.publishDescription || localAgent.description || '',
              source: 'local' as const,
            },
          ]
        }

        return [
          {
            id: `remote:${target.name}`,
            name: target.name,
            description: target.description ?? '',
            source: 'remote' as const,
          },
        ]
      },
    )

    if (summaries.length > 0) {
      agentConfig.availableAgentsSummary = summaries
    }
  }

  // 5. Flatten env + inject SCM env
  const agentEnvRaw = agent.env as Record<string, { value: string; sensitive: boolean }> | null
  const flatEnv: Record<string, string> = {}
  if (agentEnvRaw) {
    for (const [key, entry] of Object.entries(agentEnvRaw)) {
      flatEnv[key] = entry.value
    }
  }
  await injectScmEnv(flatEnv, agent)
  if (flatEnv.A2WAVE_CODEGRAPH_ENABLED === 'true') {
    agentConfig.resolvedSkills = [
      ...(agentConfig.resolvedSkills || []),
      {
        name: 'CodeGraph',
        description: 'Use CodeGraph for code structure, call path, and impact lookup.',
        content: CODEGRAPH_SKILL_CONTENT,
      },
    ]
  }
  // Always inject platform env vars so a2wave-memory scripts can call the API
  flatEnv.A2WAVE_AGENT_ID = agent.id
  flatEnv.A2WAVE_API_URL = `http://127.0.0.1:${env.PORT}`
  flatEnv.A2WAVE_MEMORY_TOKEN = registerAgentToken(agent.id, {
    allowedActions: RUNTIME_MEMORY_READ_ACTIONS,
  })
  agentConfig.agentEnv = flatEnv

  // 6. Timeout & retries: inject defaults and clamp
  const rawTimeout = agentConfig.timeoutMinutes
  agentConfig.timeoutMinutes = clampTimeout(
    rawTimeout != null && Number.isFinite(Number(rawTimeout)) ? Number(rawTimeout) : 10,
  )
  const rawRetries = agentConfig.maxRetries
  agentConfig.maxRetries = clampRetries(
    rawRetries != null && Number.isFinite(Number(rawRetries)) ? Number(rawRetries) : 2,
  )
  // 未配置总预算时保持 undefined（不限），不套默认值 —— 加默认值会改变既有 Agent 的行为。
  const rawTotalTimeout = agentConfig.totalTimeoutMinutes
  agentConfig.totalTimeoutMinutes =
    rawTotalTimeout != null && Number.isFinite(Number(rawTotalTimeout))
      ? clampTotalTimeout(Number(rawTotalTimeout))
      : undefined

  return agentConfig
}

// ============================================================
// TTL 清理：懒触发 + 每 source 1h debounce
// ============================================================

const TTL_CLEANUP_DEBOUNCE_MS = 60 * 60 * 1000
const lastCleanupAt = new Map<string, number>()

async function triggerTtlCleanup(sourceId: string, scm: ScmSource): Promise<void> {
  const now = Date.now()
  const last = lastCleanupAt.get(sourceId) ?? 0
  if (now - last < TTL_CLEANUP_DEBOUNCE_MS) return
  lastCleanupAt.set(sourceId, now)

  const activeRuns = await db
    .select({ workDir: runs.workDir })
    .from(runs)
    .where(inArray(runs.status, ['running', 'pending', 'queued']))
  const activePaths = new Set(activeRuns.map((r) => r.workDir).filter((p): p is string => !!p))

  // activePaths is only a prefilter — it is a snapshot, and a workload can
  // claim a candidate after it was taken (or occupy it invisibly: an
  // Evaluation writes no runs row, a terminal Run's cleanup outlives its
  // status). Authority is the guarded protocol: durable removal reservation
  // plus a fresh occupancy re-check inside the workspace mutex, the same one
  // the manual DELETE route uses. A candidate that became occupied throws,
  // which cleanupStale records as a skip.
  const removed = await scm.cleanupStale({
    activePaths,
    removeWorkspace: (name) => removeSourceWorkspaceGuarded({ sourceId, name, scm }),
  })
  if (removed.length > 0) {
    logger.info({ sourceId, removed }, 'TTL cleanup removed stale workspaces')
  }
}

/** 仅供测试：清空 debounce 状态 */
export function _resetTtlCleanupDebounce(): void {
  lastCleanupAt.clear()
}

/** In-flight run statuses: rows whose workDir may still be in use. */
export const IN_FLIGHT_RUN_STATUSES = ['running', 'pending', 'queued'] as const

/**
 * `runs.workDir` failed to persist, so nothing marks the worktree as occupied.
 *
 * Distinct from every other resolve failure because it must NOT degrade to the
 * shared checkout: the worktree is fine, only its occupancy marker is missing.
 */
export class WorkspaceOccupancyRecordError extends Error {
  constructor(runId: string, workDir: string, cause: unknown) {
    super(`Failed to record workDir '${workDir}' for run '${runId}'`, { cause })
    this.name = 'WorkspaceOccupancyRecordError'
  }
}

const WORKDIR_RECORD_ATTEMPTS = 3
const WORKDIR_RECORD_RETRY_MS = 25

/**
 * Persist `runs.workDir` — the only marker that says "this worktree is busy".
 *
 * The workspace-delete route's 409, `removePerAgentWorkspace`'s occupancy probe
 * and the sibling-advance check all read it, so a swallowed write leaves an
 * administrator free to delete the worktree of a running Agent. A transient
 * failure is retried; a persistent one fails the run instead of executing
 * unprotected.
 *
 * `runExclusive` is what makes the retry meaningful. On SQLite the process
 * shares one connection, so a bare write landing inside another request's
 * transaction is erased by that transaction's ROLLBACK — silently, with no
 * error for the retry to catch. Serialising against transactions removes the
 * failure mode instead of reacting to it.
 */
async function recordRunWorkDir(runId: string, wsPath: string): Promise<void> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= WORKDIR_RECORD_ATTEMPTS; attempt++) {
    try {
      await runExclusive(() => db.update(runs).set({ workDir: wsPath }).where(eq(runs.id, runId)))
      return
    } catch (err) {
      lastErr = err
      logger.warn({ err, runId, wsPath, attempt }, 'Failed to record runs.workDir, retrying')
      if (attempt < WORKDIR_RECORD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, WORKDIR_RECORD_RETRY_MS * attempt))
      }
    }
  }
  throw new WorkspaceOccupancyRecordError(runId, wsPath, lastErr)
}

/**
 * Locate an Agent's per-agent worktree without side effects. Returns null when
 * the source is not git or the SCM layer is unavailable — callers degrade.
 */
async function locatePerAgentWorktree(
  agent: typeof agents.$inferSelect,
  source: typeof scmSources.$inferSelect,
): Promise<{ scm: ScmSource; wsPath: string; name: string } | null> {
  if (source.type !== 'git') return null
  let scm: Awaited<ReturnType<typeof createScmSource>> = null
  try {
    scm = await createScmSource(source)
  } catch {
    scm = null
  }
  if (!scm) return null
  const name = perAgentWorkspaceName(agent.id)
  return { scm, wsPath: join(scm.wsRoot, name), name }
}

/**
 * Keep agentEnv's A2WAVE_WORKSPACE_BRANCH truthful for the resolved workspace:
 * set only when the run actually executes in its per-agent worktree; removed on
 * explicit-worktree, fallback and non-git paths, where the per-agent branch is
 * a ref the run is not on. Deciding this at resolution time is what makes it
 * impossible for a channel to advertise a branch it did not get.
 */
function recordWorkspaceBranchEnv(
  agentEnv: Record<string, string> | undefined,
  branch: string | null,
): void {
  if (!agentEnv) return
  if (branch) agentEnv.A2WAVE_WORKSPACE_BRANCH = branch
  else delete agentEnv.A2WAVE_WORKSPACE_BRANCH
}

/**
 * Resolve the per-Agent default worktree for a git SCM Agent.
 *
 * Deliberately no occupancy check: runs of the same Agent share this worktree
 * by design (their mounted skill set is identical), and probing occupancy here
 * would serialize every concurrent chat message. `runs.workDir` is still
 * recorded as bookkeeping for recovery and cleanup display — it is not a lock.
 */
async function resolvePerAgentWorkspace(
  source: typeof scmSources.$inferSelect,
  agent: typeof agents.$inferSelect,
  runId?: string,
): Promise<string> {
  const located = await locatePerAgentWorktree(agent, source)
  if (!located) {
    return source.localPath
  }
  const { scm, wsPath, name } = located

  // Serialize workspace-mutating git operations per worktree within this
  // process: two runs resolving concurrently must not interleave
  // `worktree add` / `reset --hard` / `checkout` on one tree.
  //
  // Probe, create and occupancy write all live INSIDE the lock. Probing
  // outside it left a window where a sibling started executing between the
  // probe and the `reset --hard`, which is the one thing the probe exists to
  // prevent; recording workDir inside it means the next run to take the lock
  // sees this one, instead of both reading an empty table and both advancing.
  const result = await withKeyedLock(`workspace:${wsPath}`, async () => {
    // Advancing runs `reset --hard`, which is not a read-only share — while a
    // sibling run is EXECUTING here (workDir recorded, status running), skip
    // the advance; freshness resumes on the next solo run. pending/queued rows
    // are deliberately excluded: Feishu reserves its row at message receipt and
    // a backlog would otherwise suppress the advance forever on a busy agent.
    const sibling = (
      await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.workDir, wsPath),
            eq(runs.status, 'running'),
            ...(runId ? [ne(runs.id, runId)] : []),
          ),
        )
        .limit(1)
    )[0]

    const created = await scm.createWorkspace(name, { followSource: true, advance: !sibling })
    if (runId) await recordRunWorkDir(runId, created.path)
    return created
  })

  const ensureState = async () => {
    try {
      // persistent: never TTL-swept, never removed after a run — the worktree
      // is the Agent's long-lived workspace, carrying cross-run state. Skip
      // the rewrite when the file already says so (the common case); a missing
      // or divergent file (fresh create, legacy v1, manual edit) is healed.
      if (!result.created) {
        const { state } = await readWorkspaceState(result.path)
        if (state?.cleanup === 'persistent') return
      }
      await scm.writeWorkspaceState(name, { cleanup: 'persistent' })
    } catch (err) {
      logger.warn({ err, wsPath: result.path }, 'Failed to write workspace state file')
    }
  }

  await Promise.all([
    ensureState(),
    // The index lives in the shared checkout and the query CLI is cwd-relative;
    // without this link a worktree run silently degrades to grep.
    isCodegraphEnabled(source.config)
      ? ensureCodegraphLink(result.path, source.localPath)
      : Promise.resolve(),
  ])

  triggerTtlCleanup(source.id, scm).catch((err) =>
    logger.warn({ err, sourceId: source.id }, 'TTL cleanup trigger failed'),
  )

  return result.path
}

/**
 * Directories where an Agent's workspace files (e.g. memory-override files) may
 * live, resolved WITHOUT side effects — a config PATCH must never create a
 * worktree or move a HEAD. For git SCM Agents this covers the per-agent
 * worktree (only if it already exists on disk) plus the shared checkout, where
 * pre-worktree deployments left the same files.
 */
export async function resolveCleanupWorkDirs(agent: typeof agents.$inferSelect): Promise<string[]> {
  if (agent.workspaceType === 'scm' && agent.scmSourceId) {
    const source = (
      await db.select().from(scmSources).where(eq(scmSources.id, agent.scmSourceId)).limit(1)
    )[0]
    if (source) {
      const dirs: string[] = []
      const located = await locatePerAgentWorktree(agent, source)
      if (located && existsSync(located.wsPath)) dirs.push(located.wsPath)
      dirs.push(source.localPath)
      return dirs
    }
    // Dangling scmSourceId: runs execute in the non-SCM fallback directory
    // (resolveWorkDir's tail), so that is where override files live.
  }

  // Non-SCM resolution never touches git — safe to reuse as-is.
  return [await resolveWorkDir(agent)]
}

/**
 * Best-effort reclaim of an Agent's per-agent worktree on Agent deletion.
 * Removal goes through scm.removeWorkspace (registry-checked, never a raw
 * recursive delete) with keepBranches: the branch is a few refs while the
 * commits on it may be the only copy of unpushed work — reclaim the disk,
 * keep the history recoverable. Failures only log: a stuck worktree must not
 * block the deletion.
 */
export async function removePerAgentWorkspace(agent: typeof agents.$inferSelect): Promise<void> {
  if (agent.workspaceType !== 'scm' || !agent.scmSourceId) return
  const source = (
    await db.select().from(scmSources).where(eq(scmSources.id, agent.scmSourceId)).limit(1)
  )[0]
  if (!source) return

  const located = await locatePerAgentWorktree(agent, source)
  if (!located) return
  const { scm, wsPath, name } = located
  if (!existsSync(wsPath)) return

  // Probe and removal share the workspace lock so a run resolving this
  // worktree concurrently (A2A resolves before its run row exists) cannot
  // slip between the occupancy check and the removal.
  await withKeyedLock(`workspace:${wsPath}`, async () => {
    // A chat-debug run can be in flight even though only stopped agents are
    // deletable — yanking its cwd would lose unpushed work. Leave the worktree
    // behind instead; the workspace-delete route can reclaim it once idle.
    const occupant = (
      await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.workDir, wsPath), inArray(runs.status, [...IN_FLIGHT_RUN_STATUSES])))
        .limit(1)
    )[0]
    if (occupant) {
      // Leaving it behind used to mean leaking it forever: the Agent row is
      // gone, so no run will ever resolve this worktree again, and `persistent`
      // excludes it from the TTL sweeper. Demote the state file so the sweeper
      // reclaims it once it goes idle — with keepBranches, since it is still
      // shaped like a per-agent worktree.
      try {
        await scm.writeWorkspaceState(name, { cleanup: 'ttl' })
      } catch (err) {
        logger.warn(
          { err, agentId: agent.id, workspace: name },
          'Failed to demote an occupied per-agent worktree to ttl; it will need manual cleanup',
        )
      }
      logger.warn(
        { agentId: agent.id, workspace: name, runId: occupant.id },
        'Per-agent worktree occupied by an in-flight run; left for TTL cleanup',
      )
      return
    }

    try {
      await scm.removeWorkspace(name, { keepBranches: true })
    } catch (err) {
      logger.warn(
        { err, agentId: agent.id, workspace: name },
        'Failed to remove per-agent worktree during agent deletion',
      )
    }
  })
}

/**
 * The single place a per-agent worktree is protected from explicit addressing.
 *
 * Per-agent worktrees are platform-owned: only `resolvePerAgentWorkspace` may
 * touch one. Request entry points reject the reserved `agent-` prefix with 400,
 * but a worktree config persisted before that rule keeps replaying, and
 * honouring it sends the run down the explicit path — which writes the
 * workspace's state file, switches its branch, and hands it to run-end cleanup.
 * Those were three separately-guarded ways to lose an Agent's work; dropping
 * the params here removes the whole branch instead of guarding each end of it.
 *
 * The run then lands in the Agent's own per-agent worktree, which is where the
 * same request would have gone without the stale config.
 */
function normalizeWorktreeParams(
  agent: typeof agents.$inferSelect,
  params?: WorktreeCallParams,
): WorktreeCallParams | undefined {
  if (!params || !isPerAgentWorkspaceName(params.name)) return params
  logger.warn(
    {
      agentId: agent.id,
      workspace: params.name,
      own: params.name === perAgentWorkspaceName(agent.id),
    },
    'Ignoring a worktree config that addresses a per-agent worktree',
  )
  return undefined
}

export class WorktreeOccupiedError extends Error {
  constructor(public readonly worktreePath: string) {
    super(`Worktree '${worktreePath}' is occupied by a running or pending run`)
    this.name = 'WorktreeOccupiedError'
  }
}

export async function resolveWorkDir(
  agent: typeof agents.$inferSelect,
  worktreeParams?: WorktreeCallParams,
  runId?: string,
  agentEnv?: Record<string, string>,
): Promise<string> {
  // Re-read the binding before resolving anything: the snapshot this call was
  // given predates admission, and a PATCH may have rebound the Agent since.
  // Resolving against the stale snapshot would mount another source's checkout.
  if (runId && agent.workspaceType === 'scm' && agent.scmSourceId) {
    const current = (
      await db
        .select({ workspaceType: agents.workspaceType, scmSourceId: agents.scmSourceId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1)
    )[0]
    if (!current || current.workspaceType !== 'scm' || current.scmSourceId !== agent.scmSourceId) {
      throw new Error('Agent SCM binding changed before workload admission')
    }
  }

  const explicitWorktree = normalizeWorktreeParams(agent, worktreeParams)

  // SCM + worktree 模式
  if (explicitWorktree) {
    const worktreeParams = explicitWorktree
    recordWorkspaceBranchEnv(agentEnv, null)
    if (agent.workspaceType !== 'scm' || !agent.scmSourceId) {
      throw new Error('Worktree requires SCM workspace type with a linked code source')
    }
    if (!WORKTREE_NAME_REGEX.test(worktreeParams.name)) {
      throw new Error(`Invalid worktree name: ${worktreeParams.name}`)
    }

    const source = (
      await db.select().from(scmSources).where(eq(scmSources.id, agent.scmSourceId)).limit(1)
    )[0]
    if (!source) {
      throw new Error(`SCM source '${agent.scmSourceId}' not found`)
    }

    const scm = await createScmSource(source)
    if (!scm) {
      throw new Error(`SCM type '${source.type}' does not support workspaces`)
    }

    // 计算 worktree 路径并原子占用（同步事务内完成检查 + 写入 runs.workDir，
    // 防止"检查→createWorkspace→回写"之间的 await 窗口被并发请求竞争）。
    const wsPath = join(scm.wsRoot, worktreeParams.name)
    await withTransaction(async (tx) => {
      const occupancyFilter = runId
        ? and(
            eq(runs.workDir, wsPath),
            inArray(runs.status, ['running', 'pending', 'queued']),
            ne(runs.id, runId),
          )
        : and(eq(runs.workDir, wsPath), inArray(runs.status, ['running', 'pending', 'queued']))
      const occupied = (
        await tx.select({ id: runs.id }).from(runs).where(occupancyFilter).limit(1)
      )[0]
      if (occupied) {
        throw new WorktreeOccupiedError(wsPath)
      }
      // Cross-replica removal gate: a remover commits its durable reservation
      // BEFORE touching the filesystem, so a reservation visible here means
      // this exact worktree may be mid-deletion on another replica. Creating
      // or reusing it now hands the run a directory about to disappear. This
      // read and the workDir claim below are one transaction, mirroring how
      // the removal protocol pairs its re-check with the reservation.
      const pendingRemoval = await findPendingWorkspaceRemoval(
        tx,
        agent.scmSourceId as string,
        worktreeParams.name,
      )
      if (pendingRemoval) {
        throw new Error(
          `Worktree '${worktreeParams.name}' is currently being removed; retry shortly`,
        )
      }
      if (runId) {
        await tx.update(runs).set({ workDir: wsPath }).where(eq(runs.id, runId))
      }
    })

    // 创建或复用 worktree；失败需回滚预占的 workDir，否则 run 会挂在占用列表里
    // 拖住其它请求（这条 run 本身在上游 catch 里要么被删要么 revert 到 pending）。
    let result: CreateWorkspaceResult
    try {
      result = await scm.createWorkspace(worktreeParams.name, { branch: worktreeParams.branch })
    } catch (err) {
      if (runId) {
        try {
          await db.update(runs).set({ workDir: null }).where(eq(runs.id, runId))
        } catch (rbErr) {
          logger.error(
            { err: rbErr, runId },
            'Failed to rollback workDir after createWorkspace failure',
          )
        }
      }
      throw err
    }

    // 写状态文件（last-run-wins + 更新 mtime = lastActivityAt）。
    // A per-agent worktree can no longer reach this line — normalizeWorktreeParams
    // drops those params — so the caller's cleanup mode is always this
    // workspace's own.
    try {
      await scm.writeWorkspaceState(worktreeParams.name, { cleanup: worktreeParams.cleanup })
    } catch (err) {
      logger.warn({ err, wsPath: result.path }, 'Failed to write workspace state file')
    }

    // 懒触发 TTL 清理（fire-and-forget + 每 source 1h debounce）
    triggerTtlCleanup(source.id, scm).catch((err) =>
      logger.warn({ err, sourceId: source.id }, 'TTL cleanup trigger failed'),
    )

    return result.path
  }

  // Default (no explicit worktree): git SCM Agents run in a per-Agent worktree.
  // Agents sharing one SCM source used to share its checkout directly, so a run
  // starting on Agent B re-mounted skills/config mid-run of Agent A and deleted
  // the files A was executing. A stable per-Agent worktree makes that physically
  // impossible while keeping cross-run state (the worktree is persistent) and
  // freshness (followSource advances it to the synced HEAD on every reuse).
  if (agent.workspaceType === 'scm' && agent.scmSourceId) {
    const source = (
      await db.select().from(scmSources).where(eq(scmSources.id, agent.scmSourceId)).limit(1)
    )[0]
    if (source) {
      if (source.type === 'git') {
        try {
          const wsPath = await resolvePerAgentWorkspace(source, agent, runId)
          recordWorkspaceBranchEnv(
            agentEnv,
            wsPath === source.localPath ? null : perAgentWorkspaceName(agent.id),
          )
          return wsPath
        } catch (err) {
          // Exception: the worktree resolved fine, only its occupancy marker
          // did not persist. Falling back would run the Agent in the shared
          // checkout *and* leave the worktree deletable mid-run — fail loudly.
          if (err instanceof WorkspaceOccupancyRecordError) throw err
          // A broken worktree must not take the Agent down — degrade to the
          // shared checkout, which is exactly the pre-worktree behavior. The
          // env must not keep naming the per-agent branch here: an agent
          // following it would move the shared checkout off the source branch.
          logger.warn(
            { err, agentId: agent.id, sourceId: source.id },
            'Per-agent worktree unavailable, falling back to the shared checkout',
          )
          recordWorkspaceBranchEnv(agentEnv, null)
          return source.localPath
        }
      }
      // P4 has no isolation mechanism (client spec is server-side state bound to
      // a single Root) — the shared checkout remains the only option.
      recordWorkspaceBranchEnv(agentEnv, null)
      return source.localPath
    }
  }

  const agentConfig = (agent.config || {}) as AgentConfig
  const configWorkDir = agentConfig.workDir
  if (configWorkDir) {
    const generalSettings = getCategorySettings('general')
    const allowedBases = [resolve((await generalSettings).workspacePath), resolve('./data')]
    const resolved = resolve(configWorkDir)
    const allowed = allowedBases.some(
      (base) => resolved === base || resolved.startsWith(base + sep),
    )
    if (allowed) return resolved
    logger.warn(
      { configWorkDir },
      'Agent config.workDir is outside allowed workspace paths, ignoring',
    )
  }

  const generalSettings = getCategorySettings('general')
  const idSuffix = agent.id.split('_').pop() || agent.id
  return join(generalSettings.workspacePath, `${slugify(agent.name)}-${idSuffix}`)
}

export async function injectScmEnv(
  agentEnv: Record<string, string>,
  agent: typeof agents.$inferSelect,
): Promise<void> {
  if (agent.workspaceType !== 'scm' || !agent.scmSourceId) return
  const source = (
    await db.select().from(scmSources).where(eq(scmSources.id, agent.scmSourceId)).limit(1)
  )[0]
  if (!source) return

  if (source.type === 'p4') {
    const config = source.config as unknown as P4Config
    agentEnv.P4PORT = config.p4port
    agentEnv.P4USER = config.p4user
    if (config.p4passwd) agentEnv.P4PASSWD = config.p4passwd
    agentEnv.P4CLIENT = config.p4client
    agentEnv.P4_CLIENT_ROOT = source.localPath
  } else if (source.type === 'git') {
    const config = source.config as unknown as GitConfig
    agentEnv.GIT_BRANCH = config.branch || 'main'
    // A2WAVE_WORKSPACE_BRANCH is deliberately NOT set here: only resolveWorkDir
    // knows whether the run really lands in its per-agent worktree, so it owns
    // that variable (recordWorkspaceBranchEnv) — absence beats a wrong value.
  }
  if (isCodegraphEnabled(source.config)) {
    agentEnv.A2WAVE_CODEGRAPH_ENABLED = 'true'
  }
}
