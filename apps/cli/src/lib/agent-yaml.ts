/**
 * YAML → CreateAgentInput parser for `a2wave agents apply`.
 *
 * Field naming mirrors @a2wave/shared `createAgentInput` (camelCase). The only
 * deliberate aliases are name-based references that the CLI resolves to IDs:
 *   provider       → providerId
 *   skills[]       → skills[] (already string[]; resolved name → skl_xxx)
 *   skillGroups[]  → skillGroupIds[] (resolved name → skg_xxx)
 *   mcpServers[]   → mcpServerIds[]
 *   kbDocuments[]  → kbDocumentIds[] (resolved name → kbd_xxx)
 *   workspace.{type, source} → {workspaceType, scmSourceId}
 *
 * Sensitive fields can use `${ENV_VAR}` placeholders that the CLI expands at
 * apply-time from the calling shell — keeps secrets out of yaml-on-disk.
 */
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { CliError } from '../errors.js'

export interface AgentYamlRefs {
  provider?: string
  skills?: string[]
  /** Skill groups (resolved by name to skg_xxx). Merged and deduped with skills at runtime. */
  skillGroups?: string[]
  mcpServers?: string[]
  /** Knowledge base documents (resolved by name to kbd_xxx). */
  kbDocuments?: string[]
  workspace?: { type?: 'temp' | 'scm'; source?: string }
}

/**
 * Feishu channel config (mirrors @a2wave/shared feishuConfigSchema).
 * appId / appSecret are required; all other fields have defaults — override as needed.
 *
 * WHY a key list rather than a 23-field type mirror: the type version drifted
 * eight fields behind the platform, and nothing failed until a user's YAML was
 * rejected. The CLI only needs to know which keys are legal to pass through, so
 * the mirror is one runtime array pinned against the generated snapshot by
 * src/lib/__tests__/agent-yaml-schema-drift.test.ts. Values stay unvalidated
 * here on purpose — the API owns that, and duplicating it is what rots.
 */
export const FEISHU_CONFIG_KEYS = [
  'appId',
  'appSecret',
  // Regular group chat settings
  'groupTriggerOnAt',
  'groupTriggerOnNewMessage',
  'groupReplyMode',
  // Topic group settings
  'topicTriggerOnAt',
  'topicTriggerOnNewTopic',
  'topicTriggerOnNewComment',
  'topicReplyMode',
  'topicReplyMentionTarget',
  'topicInjectRootMessage',
  // P2P direct chat settings (always triggers; only the reply style is configurable)
  'p2pReplyMode',
  // Shared settings
  'replyContentType',
  'cardTemplateId',
  'debugShowSessionId',
  'debugShowProvider',
  'debugShowModel',
  'sendArtifactsAsFile',
  'fetchUserInfo',
  'welcomeMessage',
  'welcomeOnP2pEnabled',
  'welcomeP2pIdleDays',
  'welcomeOnGroupAddedEnabled',
] as const

export type AgentYamlFeishuConfigKey = (typeof FEISHU_CONFIG_KEYS)[number]

/** appId / appSecret are required; every other key is optional and server-defaulted. */
export type AgentYamlFeishuConfig = { appId: string; appSecret: string } & Partial<
  Record<AgentYamlFeishuConfigKey, unknown>
>

/** Mirrors artifactPolicySchema's `autoShare` enum. */
export const ARTIFACT_AUTO_SHARE = ['off', 'on'] as const
/** Mirrors artifactPolicySchema's `shareAccessLevel` enum. */
export const ARTIFACT_SHARE_ACCESS_LEVELS = ['authenticated', 'public'] as const

/**
 * Artifact policy (mirrors @a2wave/shared artifactPolicySchema).
 * When enabled, every html/md/directory artifact automatically gets a share link
 * attached to the message / Feishu notification.
 */
export interface AgentYamlArtifactPolicy {
  /** Auto-share toggle (default off) */
  autoShare?: (typeof ARTIFACT_AUTO_SHARE)[number]
  /** Default access level for share links: authenticated (login required) | public (default authenticated) */
  shareAccessLevel?: (typeof ARTIFACT_SHARE_ACCESS_LEVELS)[number]
  /** Share link validity in days, 1–365 (default 7) */
  shareExpiryDays?: number
}

/** Schedule trigger config. cron is standard 5-field format; timezone defaults to Asia/Shanghai. */
export interface AgentYamlScheduleConfig {
  id?: string
  cron: string
  intent: string
  timezone?: string
}

/**
 * A2A route target (mirrors @a2wave/shared a2aRouteTargetSchema).
 * When configured, the runtime auto-mounts the `a2wave-agent-router` MCP and the
 * Agent can call these downstream Agents over the A2A protocol via invoke_agent /
 * invoke_agents_parallel.
 *   - local:  calls an Agent published on this instance (with the a2a channel enabled), referenced by agt_xxx
 *   - remote: discovers a standard service from its Agent Card, or directly calls a known JSON-RPC endpoint
 *             set apiKey when auth is required (sent as Authorization: Bearer at runtime; supports ${ENV} placeholders)
 */
export const A2A_ROUTE_TARGET_TYPES = ['local', 'remote'] as const
export const A2A_CONNECTION_MODES = ['agent_card', 'direct'] as const
export const A2A_PROTOCOL_VERSIONS = ['1.0', '0.3'] as const

export type AgentYamlA2ARouteTarget =
  | { type: 'local'; agentId: string }
  | {
      type: 'remote'
      name: string
      url: string
      /** Agent Card discovery for standard services, or direct for a known JSON-RPC endpoint. */
      connectionMode?: (typeof A2A_CONNECTION_MODES)[number]
      /** Direct endpoint protocol version; omitted legacy routes remain direct A2A 0.3. */
      protocolVersion?: (typeof A2A_PROTOCOL_VERSIONS)[number]
      description?: string
      apiKey?: string
    }

/**
 * A2A outbound skill declaration (mirrors @a2wave/shared a2aSkillSchema).
 * Describes the capabilities this Agent exposes over the A2A protocol for
 * upstream Agents to discover and invoke.
 */
export interface AgentYamlA2ASkill {
  id: string
  name: string
  description: string
  tags?: string[]
}

/**
 * Publish channels, mirroring @a2wave/shared `publishChannelEnum`.
 *
 * This list was hand-maintained and fell five members behind: a YAML declaring
 * `channels: [slack]` was rejected by the CLI's own type while the API accepted
 * it. It is now pinned to the generated snapshot by
 * src/lib/__tests__/agent-yaml-schema-drift.test.ts, so the next channel added
 * upstream fails a test instead of a user's apply.
 */
export const PUBLISH_CHANNELS = [
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
] as const

export const PUBLISH_AUTH_TYPES = ['none', 'api_key'] as const

export interface AgentYamlPublishBlock {
  /** Channel list; if this block is present, apply automatically calls POST /publish once */
  channels?: Array<(typeof PUBLISH_CHANNELS)[number]>
  authType?: (typeof PUBLISH_AUTH_TYPES)[number]
  ipWhitelist?: string[]
  description?: string
  /** Whether to regenerate endpointApiKey on publish; existing key is kept by default */
  regenerateApiKey?: boolean
}

export interface AgentYaml {
  name: string
  description?: string
  type?: 'llm' | 'cursor' | 'script'
  icon?: string
  systemPrompt?: string
  config?: Record<string, unknown>
  env?: Record<string, { value: string; sensitive?: boolean }>
  maxConcurrency?: number
  authMode?: 'apiKey' | 'oauth' | 'localSession'
  providerApiKey?: string
  providerOauthToken?: string
  providerBaseUrl?: string
  /** Feishu channel config (written into the agent record on create; later publish just uses channels:[feishu]) */
  feishuConfig?: AgentYamlFeishuConfig
  /** Schedule trigger config (same as above) */
  scheduleConfig?: AgentYamlScheduleConfig | AgentYamlScheduleConfig[]
  /** A2A route targets: let this Agent orchestrate/call other Agents over the A2A protocol */
  a2aRouteTargets?: AgentYamlA2ARouteTarget[]
  /** A2A outbound skill declarations: capabilities this Agent exposes over A2A */
  a2aSkills?: AgentYamlA2ASkill[]
  /** Dedicated credential for memory embedding (inherits the Agent Provider credential when unset) */
  embeddingApiKey?: string
  /** Show local child Agent (A2A local) intermediate output in replies */
  showLocalChildOutput?: boolean
  /** Show remote child Agent (A2A remote) intermediate output in replies */
  showRemoteChildOutput?: boolean
  /** Artifact policy: whether html/md/directory artifacts automatically get a previewable share link */
  artifactPolicy?: AgentYamlArtifactPolicy
  publish?: AgentYamlPublishBlock
}

export type AgentYamlDoc = AgentYaml & AgentYamlRefs

/**
 * Replace `${VAR}` and `${VAR:-default}` with values from `env`. Throws when a
 * referenced variable is missing and has no default — silent empty-string would
 * masquerade as "configured" and burn the user later.
 */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name: string, fallback?: string) => {
      const v = env[name]
      if (v !== undefined) return v
      if (fallback !== undefined) return fallback
      throw new CliError(
        `Environment variable not set: ${name} (referenced in yaml as \${${name}}). Export it and retry, or write \${${name}:-default} in the yaml.`,
      )
    },
  )
}

/** Recursively walk a JSON-like value and expand strings via `expandEnvVars`. */
function deepExpand<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') return expandEnvVars(value, env) as unknown as T
  if (Array.isArray(value)) return value.map((v) => deepExpand(v, env)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepExpand(v, env)
    }
    return out as unknown as T
  }
  return value
}

export function parseAgentYaml(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentYamlDoc {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new CliError(`Failed to read yaml file: ${filePath} (${(err as Error).message})`)
  }
  let doc: unknown
  try {
    doc = parseYaml(raw)
  } catch (err) {
    throw new CliError(`Failed to parse yaml (${filePath}): ${(err as Error).message}`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new CliError(`yaml top level must be a mapping (${filePath})`)
  }
  const expanded = deepExpand(doc, env) as AgentYamlDoc
  if (!expanded.name || typeof expanded.name !== 'string') {
    throw new CliError(`yaml is missing required field 'name' (${filePath})`)
  }
  return expanded
}

export interface ResolveClient {
  resolveProviderId(idOrName: string): Promise<string>
  resolveSkillId(idOrName: string): Promise<string>
  resolveSkillGroupId(idOrName: string): Promise<string>
  resolveMcpServerId(idOrName: string): Promise<string>
  resolveKbDocumentId(idOrName: string): Promise<string>
  resolveScmSourceId(idOrName: string): Promise<string>
}

/** Resolve all name-based refs to IDs in a single pass (parallel where safe). */
export async function resolveRefs(client: ResolveClient, doc: AgentYamlDoc) {
  const [providerId, skills, skillGroupIds, mcpServerIds, kbDocumentIds, scmSourceId] =
    await Promise.all([
      doc.provider ? client.resolveProviderId(doc.provider) : Promise.resolve(undefined),
      doc.skills
        ? Promise.all(doc.skills.map((s) => client.resolveSkillId(s)))
        : Promise.resolve(undefined),
      doc.skillGroups
        ? Promise.all(doc.skillGroups.map((g) => client.resolveSkillGroupId(g)))
        : Promise.resolve(undefined),
      doc.mcpServers
        ? Promise.all(doc.mcpServers.map((m) => client.resolveMcpServerId(m)))
        : Promise.resolve(undefined),
      doc.kbDocuments
        ? Promise.all(doc.kbDocuments.map((d) => client.resolveKbDocumentId(d)))
        : Promise.resolve(undefined),
      doc.workspace?.type === 'scm' && doc.workspace.source
        ? client.resolveScmSourceId(doc.workspace.source)
        : Promise.resolve(undefined),
    ])
  return { providerId, skills, skillGroupIds, mcpServerIds, kbDocumentIds, scmSourceId }
}

export interface ResolvedRefs {
  providerId?: string
  skills?: string[]
  skillGroupIds?: string[]
  mcpServerIds?: string[]
  kbDocumentIds?: string[]
  scmSourceId?: string
}

/** Build the body POSTed to /api/agents (matches createAgentInput shape). */
export function toCreatePayload(doc: AgentYamlDoc, refs: ResolvedRefs): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: doc.name,
  }
  if (doc.description !== undefined) payload.description = doc.description
  if (doc.type !== undefined) payload.type = doc.type
  if (doc.icon !== undefined) payload.icon = doc.icon
  if (doc.systemPrompt !== undefined) payload.systemPrompt = doc.systemPrompt
  if (doc.config !== undefined) payload.config = doc.config
  if (doc.env !== undefined) {
    // Normalize: yaml may give `value` only; default sensitive: false.
    const out: Record<string, { value: string; sensitive: boolean }> = {}
    for (const [k, v] of Object.entries(doc.env)) {
      out[k] = { value: v.value, sensitive: v.sensitive ?? false }
    }
    payload.env = out
  }
  if (doc.maxConcurrency !== undefined) payload.maxConcurrency = doc.maxConcurrency
  if (doc.authMode !== undefined) payload.authMode = doc.authMode
  if (doc.providerApiKey !== undefined) payload.providerApiKey = doc.providerApiKey
  if (doc.providerOauthToken !== undefined) payload.providerOauthToken = doc.providerOauthToken
  if (doc.providerBaseUrl !== undefined) payload.providerBaseUrl = doc.providerBaseUrl
  if (refs.providerId !== undefined) payload.providerId = refs.providerId
  if (refs.skills !== undefined) payload.skills = refs.skills
  if (refs.skillGroupIds !== undefined) payload.skillGroupIds = refs.skillGroupIds
  if (refs.mcpServerIds !== undefined) payload.mcpServerIds = refs.mcpServerIds
  if (refs.kbDocumentIds !== undefined) payload.kbDocumentIds = refs.kbDocumentIds
  if (doc.workspace?.type !== undefined) payload.workspaceType = doc.workspace.type
  if (refs.scmSourceId !== undefined) payload.scmSourceId = refs.scmSourceId
  if (doc.feishuConfig !== undefined) payload.feishuConfig = doc.feishuConfig
  if (doc.scheduleConfig !== undefined) payload.scheduleConfig = doc.scheduleConfig
  if (doc.a2aRouteTargets !== undefined) payload.a2aRouteTargets = doc.a2aRouteTargets
  if (doc.a2aSkills !== undefined) {
    // Normalize: tags defaults to [] to match a2aSkillSchema.
    payload.a2aSkills = doc.a2aSkills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags ?? [],
    }))
  }
  if (doc.embeddingApiKey !== undefined) payload.embeddingApiKey = doc.embeddingApiKey
  if (doc.showLocalChildOutput !== undefined)
    payload.showLocalChildOutput = doc.showLocalChildOutput
  if (doc.showRemoteChildOutput !== undefined)
    payload.showRemoteChildOutput = doc.showRemoteChildOutput
  if (doc.artifactPolicy !== undefined) {
    // Fill schema defaults so the proposed payload matches what the server persists
    // (artifactPolicySchema defaults: off / authenticated / 7). Without this, a partial
    // policy in yaml diffs against the server's fully-defaulted object on every apply,
    // making apply report a spurious "Updated" + redundant PATCH instead of "Unchanged".
    payload.artifactPolicy = {
      autoShare: doc.artifactPolicy.autoShare ?? 'off',
      shareAccessLevel: doc.artifactPolicy.shareAccessLevel ?? 'authenticated',
      shareExpiryDays: doc.artifactPolicy.shareExpiryDays ?? 7,
    }
  }
  return payload
}

/**
 * Build the body POSTed to /api/agents/:id/publish.
 * The server reads feishuConfig / scheduleConfig from the agent record, so the
 * publish body only sends channel + auth-related fields.
 */
export function toPublishPayload(doc: AgentYamlDoc): Record<string, unknown> | null {
  if (!doc.publish) return null
  const p = doc.publish
  const body: Record<string, unknown> = {}
  if (p.channels !== undefined) body.channels = p.channels
  if (p.authType !== undefined) body.authType = p.authType
  if (p.ipWhitelist !== undefined) body.ipWhitelist = p.ipWhitelist
  if (p.description !== undefined) body.description = p.description
  if (p.regenerateApiKey !== undefined) body.regenerateApiKey = p.regenerateApiKey
  return body
}

/**
 * Compute a shallow diff between server's existing agent shape and the proposed
 * payload. Returns only the fields that differ — fed to PATCH /agents/:id.
 *
 * Equality uses JSON.stringify with stable key order (good enough for the
 * primitive / array / shallow-object shapes in agent fields).
 */
/** Mask placeholder the server's GET returns for secret fields; PATCH treats this value as "keep unchanged". */
const SECRET_MASK = '********'

type RemoteRouteForDiff = Record<string, unknown> & {
  type: 'remote'
  name?: unknown
  url?: unknown
  connectionMode?: unknown
  protocolVersion?: unknown
  apiKey?: unknown
}

function isRemoteRouteForDiff(value: unknown): value is RemoteRouteForDiff {
  return Boolean(
    value && typeof value === 'object' && (value as { type?: unknown }).type === 'remote',
  )
}

function remoteRouteEndpointIdentity(target: RemoteRouteForDiff): string {
  const connectionMode = target.connectionMode ?? 'direct'
  const protocolVersion = connectionMode === 'direct' ? (target.protocolVersion ?? '0.3') : ''
  return JSON.stringify([target.url, connectionMode, protocolVersion])
}

/**
 * Replace a YAML plaintext route key with the server's keep-existing sentinel
 * when both sides describe the same endpoint. This makes apply idempotent and
 * avoids needlessly retransmitting a credential the GET response cannot reveal.
 * Endpoint changes deliberately keep the submitted key: carrying a stored key
 * to another URL would cross the server's credential boundary.
 */
function preserveMaskedRouteSecretsForDiff(existing: unknown, proposed: unknown): unknown {
  if (!Array.isArray(existing) || !Array.isArray(proposed)) return proposed

  const candidates = existing
    .map((target, index) => ({ index, target }))
    .filter(
      (entry): entry is { index: number; target: RemoteRouteForDiff } =>
        isRemoteRouteForDiff(entry.target) && entry.target.apiKey === SECRET_MASK,
    )
  const consumed = new Set<number>()

  return proposed.map((target) => {
    if (!isRemoteRouteForDiff(target) || typeof target.apiKey !== 'string' || !target.apiKey) {
      return target
    }

    const sameEndpoint = candidates.filter(
      (candidate) =>
        !consumed.has(candidate.index) &&
        remoteRouteEndpointIdentity(candidate.target) === remoteRouteEndpointIdentity(target),
    )
    const sameName = sameEndpoint.filter((candidate) => candidate.target.name === target.name)
    const match =
      sameName.length === 1 ? sameName[0] : sameEndpoint.length === 1 ? sameEndpoint[0] : null
    if (!match) return target

    consumed.add(match.index)
    return { ...target, apiKey: SECRET_MASK }
  })
}

export function computeDiff(
  existing: Record<string, unknown>,
  proposed: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(proposed)) {
    if (k === 'name') continue // name is the identity key; never PATCH it
    const before = existing[k]
    // Secret fields: GET masks the value as '********', so we can't tell whether the
    // server's real value matches the yaml plaintext. Comparing via stableEqual would
    // mean plaintext never equals the mask → every apply falsely reports "changed" and
    // sends a redundant PATCH; apply is never idempotent and --dry-run always shows
    // pending. The server's PATCH treats '********' as "keep unchanged", so we skip
    // fields whose existing value is the mask (embeddingApiKey / providerOauthToken alike).
    // Trade-off: yaml can't reset an already-set secret to a new value — use the
    // dedicated command / Web UI to rotate secrets.
    if (before === SECRET_MASK) continue
    const comparable = k === 'a2aRouteTargets' ? preserveMaskedRouteSecretsForDiff(before, v) : v
    if (!stableEqual(before, comparable)) diff[k] = comparable
  }
  return diff
}

function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => stableEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
  }
  return false
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/**
 * Fully annotated example YAML, printed to stdout by `a2wave agents apply --example`.
 * Covers all P0 fields; users can copy it and tweak to get started.
 */
export const EXAMPLE_AGENT_YAML = `# a2wave agent.yaml — full field example
# Usage:
#   a2wave agents apply -f my-bot.yaml             # apply this yaml
#   a2wave agents apply -f my-bot.yaml --dry-run   # preview only
#   a2wave agents apply --example                  # print this example

name: my-bot                              # Required; used as the lookup key for idempotent apply
description: Demo agent
type: cursor                              # cursor | llm | script (default cursor)
icon: "🤖"
systemPrompt: |
  You are an internal company assistant...

# Provider — resolved by name (a prv_xxx ID also works)
provider: claude-code-builtin

# Skills / groups / MCP / knowledge base — all resolved by name
skills:
  - lark-mail
  - lark-im
skillGroups:
  - feishu-tools                          # Mounts the whole group; merged and deduped with skills at runtime
mcpServers:
  - lark-cli
kbDocuments:
  - company-policies
  - faq

# Workspace: temp (default) or scm (linked to a code source)
workspace:
  type: temp
  # source: my-repo                       # Required when type=scm

maxConcurrency: 1                         # Concurrency limit 1-5

# Whether child Agent intermediate output is shown in replies (for A2A orchestration)
# showLocalChildOutput: false             # Local child Agents
# showRemoteChildOutput: false            # Remote child Agents

# Free-form config (passed through to agent.config, any structure)
# config:
#   customKey: customValue

# Agent-level environment variables; \${ENV} placeholders are expanded by the CLI at apply time
env:
  LARK_APP_ID:
    value: \${LARK_APP_ID}
    sensitive: true

# Provider credentials (when authMode=apiKey)
# authMode: apiKey                         # apiKey | oauth | localSession
# providerApiKey: \${ANTHROPIC_API_KEY}
# providerBaseUrl: https://api.anthropic.com
# embeddingApiKey: \${EMBEDDING_API_KEY}   # Dedicated memory embedding credential (inherits Provider credential when unset)

# Feishu channel config (written into the agent record on create; later publish reuses it automatically)
# feishuConfig:
#   appId: \${FEISHU_APP_ID}
#   appSecret: \${FEISHU_APP_SECRET}
#   groupTriggerOnAt: true
#   groupTriggerOnNewMessage: false
#   groupReplyMode: quote                  # quote | new | none
#   topicTriggerOnAt: true
#   topicReplyMode: topic_reply            # topic_reply | none
#   p2pReplyMode: quote                    # Direct chat: quote | new | none (default quote)
#   replyContentType: text                 # text | post | interactive | streaming_card
#   sendArtifactsAsFile: true
#   fetchUserInfo: false

# Schedule trigger config (same as above)
# scheduleConfig:
#   - id: sch_morning                       # Optional; keeps the scheduled task identity stable
#     cron: "0 9 * * 1-5"                  # Standard 5-field cron: min hour dom mon dow
#     intent: Send the daily report reminder at 9 AM
#     timezone: Asia/Shanghai              # Default Asia/Shanghai
#   - id: sch_evening
#     cron: "0 18 * * 1-5"
#     intent: Send the summary reminder at 6 PM

# Artifact policy: whether html/md/directory artifacts automatically get an online-previewable share link
# artifactPolicy:
#   autoShare: on                          # on | off (default off)
#   shareAccessLevel: authenticated        # authenticated (login required) | public (default authenticated)
#   shareExpiryDays: 7                      # Share link validity in days 1–365 (default 7)

# A2A route targets: this Agent orchestrates/calls other Agents over the A2A protocol.
# When configured, the runtime auto-mounts the built-in a2wave-agent-router MCP
# (no need to list it in mcpServers manually); the Agent can then call the Agents
# below via invoke_agent / invoke_agents_parallel.
# a2aRouteTargets:
#   - type: local                          # Calls an Agent published on this instance (with the a2a channel enabled)
#     agentId: agt_xxxxxxxx
#   - type: remote                         # Discovers a standard A2A service from its Agent Card
#     name: payment-agent                  # Display name (also the remote:<name> identifier when invoking)
#     url: https://agent.example.com/.well-known/agent-card.json
#     connectionMode: agent_card           # Recommended for standard A2A services; protocol is negotiated from the Card
#     description: Handles payment-related inquiries # Optional; helps this Agent decide when to call it
#     apiKey: \${PGAME_PAY_API_KEY}         # Optional; set when auth is required (sent as Authorization: Bearer)
#   - type: remote                         # Direct endpoint for compatibility or when no Agent Card is available
#     name: legacy-a2wave-agent
#     url: https://a2wave.example.com/api/a2a/agt_xxxxxxxx
#     connectionMode: direct
#     protocolVersion: "0.3"               # "1.0" | "0.3"; quote YAML versions so they remain strings
#                                          # Omitting mode/version preserves legacy direct A2A 0.3 behavior

# A2A outbound skills: capabilities this Agent exposes over A2A for upstream Agents to discover and invoke
# a2aSkills:
#   - id: summarize
#     name: Text summarization
#     description: Condense long text into key points
#     tags: [nlp, summary]                  # Optional, default []

# Publish block (optional; when present, /publish is called automatically after apply)
# publish:
#   channels: [api, feishu]                # ${PUBLISH_CHANNELS.join(' | ')}
#   authType: api_key                      # none | api_key
#   ipWhitelist: []
#   description: Public API documentation
#   regenerateApiKey: false                # true = rotate endpointApiKey
`

/**
 * Name the parts of a diff that REMOVE something.
 *
 * `agents apply` is an ordinary `write` almost always, but a diff that unmounts
 * a Skill or clears a system prompt is not recoverable from the YAML in hand —
 * the thing being removed is precisely what the new YAML no longer names. That
 * subset is treated as `high-risk-write` and gated on `--yes`.
 *
 * Only removals count. Growing a list or replacing a value is an edit the
 * caller can reverse by editing again; a `write` label is honest about that,
 * and labelling every apply high-risk would train callers to pass `--yes`
 * unconditionally, which costs the protection on the cases that need it.
 */
export function describeDestructiveDiff(
  existing: Record<string, unknown>,
  diff: Record<string, unknown>,
): string[] {
  const findings: string[] = []
  for (const [key, next] of Object.entries(diff)) {
    const before = existing[key]
    if (before === undefined || before === null) continue

    if (Array.isArray(before)) {
      const after = new Set((Array.isArray(next) ? next : []).map((v) => JSON.stringify(v)))
      const removed = before.filter((v) => !after.has(JSON.stringify(v)))
      if (removed.length > 0) {
        findings.push(`${key}: removes ${removed.length} (${removed.map(String).join(', ')})`)
      }
      continue
    }

    // A non-empty scalar replaced by an empty one. A different non-empty value
    // is an edit, not a loss.
    if (before !== '' && (next === '' || next === null)) findings.push(`${key}: cleared`)
  }
  return findings
}
