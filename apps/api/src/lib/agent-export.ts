import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
/**
 * Agent 导出逻辑
 * 将 Agent 及其关联实体（MCP Server、Skill）打包为 ZIP，导出时脱敏敏感数据。
 */
import AdmZip from 'adm-zip'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, kbDocuments, mcpServers, providers, scmSources, skills } from '../db/schema.js'
import { normalizeOauthAccessMode } from './gateway-auth-errors.js'
import { maskAllStringRecord, redactMcpGroupConfig, redactMcpUrl } from './mcp-redaction.js'
import { canNonAdminUseSkill } from './skill-access.js'
import { getSkillStoragePath } from './skill-storage.js'
import { slugify } from './slug.js'

// ============================================================
// Types
// ============================================================

export interface ExportManifest {
  version: string
  exportedAt: string
  sourceInstance: string
  agentName: string
  a2waveVersion: string
}

export interface ExportedAgent {
  name: string
  description: string | null
  type: string
  icon: string
  systemPrompt: string | null
  config: Record<string, unknown> | null
  workspaceType: string
  maxConcurrency: number
  env: Record<string, { value: string; sensitive: boolean }> | null
  feishuConfig: Record<string, unknown> | null
  slackConfig?: Record<string, unknown> | null
  discordConfig?: Record<string, unknown> | null
  qqOfficialConfig?: Record<string, unknown> | null
  chatAppConfig?: Record<string, unknown> | null
  scheduleConfig: Record<string, unknown> | Array<Record<string, unknown>> | null
  /** Git repository trigger configs; no credentials, so no masking pass. */
  glabConfig?: Record<string, unknown> | null
  ghConfig?: Record<string, unknown> | null
  publishChannels: string[]
  /** `feishu_scope` is a retired mode kept readable so bundles exported before its removal still import. */
  oauthAccessMode?: 'all_idaas_users' | 'specified_users' | 'feishu_scope'
  /** Always exported as null — see the note at the write site in `sanitizeAgent`. */
  oauthAllowedEmails?: string[] | null
  a2aSkills: unknown[] | null
  a2aRouteTargets: unknown[] | null
  showLocalChildOutput: boolean | null
  showRemoteChildOutput: boolean | null
  providerRef: string | null
  scmSourceRef: string | null
  kbDocumentRefs: string[]
  mcpServerRefs: string[]
  skillRefs: string[]
}

/**
 * Does this bundle's `oauthAccessMode` predate the removal of the Feishu visible-scope mode?
 *
 * True for an explicit `'feishu_scope'` **and** for a missing value: bundles exported before
 * migration 0071 introduced the column carry no mode at all, yet their source Agent ran on that
 * column's DEFAULT — which was `feishu_scope`. Both therefore mean "was restricted", and the
 * importer must land them fail-closed rather than on the new open default.
 */
export function isRetiredOauthAccessMode(
  mode: ExportedAgent['oauthAccessMode'],
): mode is 'feishu_scope' | undefined {
  return mode === undefined || mode === 'feishu_scope'
}

export interface ExportedMcpServer {
  name: string
  description: string | null
  type: string
  command: string | null
  args: string[]
  cwd: string | null
  url: string | null
  headers: Record<string, string> | null
  env: Record<string, string> | null
  isEnabled: boolean
  groupConfig: { backends: Record<string, unknown[]> } | null
}

export interface ExportedSkillMetadata {
  name: string
  description: string | null
  origin?:
    | {
        kind: 'system-builtin'
        name: string
        digest: string
      }
    | {
        kind: 'user-owned'
      }
}

/**
 * Built-in Skills that an import may rebind to the target instance's own copy
 * instead of creating a private duplicate.
 *
 * `frontend-design` was removed from the platform, so it is deliberately absent:
 * a package exported from an older instance still carries it, and dropping it
 * from this set makes the import create a normal user-owned private Skill —
 * the Agent keeps working, with content the importer owns outright.
 */
export const REBINDABLE_SYSTEM_SKILL_NAMES: ReadonlySet<string> = new Set(['a2wave-memory'])

export interface ExportedSkillPackageFile {
  path: string
  data: Buffer
}

/**
 * Hash the complete portable Skill representation, excluding skill.json's
 * provenance field itself. Length and per-file content hashes make the framing
 * unambiguous, while path sorting keeps the result stable across filesystems.
 */
export function computeExportedSkillPackageDigest(
  metadata: Pick<ExportedSkillMetadata, 'name' | 'description'>,
  files: ExportedSkillPackageFile[],
): string {
  const canonicalFiles = files
    .map((file) => ({
      path: file.path,
      size: file.data.length,
      digest: createHash('sha256').update(file.data).digest('hex'),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const canonical = JSON.stringify({
    name: metadata.name,
    description: metadata.description,
    files: canonicalFiles,
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export type AgentExportAudience =
  | {
      kind: 'authenticated'
      requesterUserId: string
      requesterIsAdmin: boolean
    }
  | { kind: 'public' }

// ============================================================
// Sensitive Key Detection
// ============================================================

/**
 * Sensitive key detection using word-boundary matching.
 * Splits key names by _ / - / camelCase boundaries, then checks each word.
 *
 * Examples:
 *   API_KEY       → [api, key]       → match "key"
 *   MONKEY_COUNT  → [monkey, count]  → no match
 *   appSecret     → [app, secret]    → match "secret"
 *   Authorization → [authorization]  → match (substring "auth")
 */
const SENSITIVE_WORDS = new Set(['token', 'secret', 'key', 'password', 'passwd', 'credential'])

/** Matched via substring for cases like P4PASSWD, Authorization, credentials */
const SENSITIVE_SUBSTRINGS = ['auth', 'passwd', 'password', 'credential']

/** Split a key name into words: FOO_BAR → [foo,bar], appSecret → [app,secret] */
function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z])([A-Z])/g, '$1_$2') // camelCase → snake
    .toLowerCase()
    .split(/[_\-./]+/)
    .filter(Boolean)
}

/** Check if a key name likely holds sensitive data */
export function isSensitiveKey(key: string): boolean {
  const words = splitKeyWords(key)
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true
  const lower = key.toLowerCase()
  return SENSITIVE_SUBSTRINGS.some((s) => lower.includes(s))
}

function sanitizeProviderChainConfig(
  config: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!config || !Array.isArray(config.providerChain)) return config
  return {
    ...config,
    providerChain: (config.providerChain as Array<Record<string, unknown>>).map((item) => ({
      ...item,
      ...(item.providerApiKey ? { providerApiKey: '********' } : {}),
      ...(item.providerBaseUrl ? { providerBaseUrl: '********' } : {}),
      ...(item.providerOauthToken ? { providerOauthToken: '********' } : {}),
    })),
  }
}

// ============================================================
// Sanitization
// ============================================================

type AgentRow = typeof agents.$inferSelect
type McpRow = typeof mcpServers.$inferSelect

/** Sanitize an Agent row, stripping runtime fields and masking secrets */
export function sanitizeAgent(agent: AgentRow): ExportedAgent {
  // Mask env entries: sensitive flag OR key name matches sensitive pattern
  let sanitizedEnv: Record<string, { value: string; sensitive: boolean }> | null = null
  if (agent.env) {
    const raw = agent.env as Record<string, { value: string; sensitive: boolean }>
    sanitizedEnv = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [
        k,
        v.sensitive || isSensitiveKey(k) ? { ...v, value: '********' } : v,
      ]),
    )
  }

  // Mask feishu appSecret
  let sanitizedFeishuConfig: Record<string, unknown> | null = null
  if (agent.feishuConfig) {
    const fc = agent.feishuConfig as Record<string, unknown>
    sanitizedFeishuConfig = { ...fc, appSecret: '********' }
  }
  const sanitizedSlackConfig = agent.slackConfig
    ? { ...agent.slackConfig, appToken: '********', botToken: '********' }
    : null
  const sanitizedDiscordConfig = agent.discordConfig
    ? { ...agent.discordConfig, botToken: '********' }
    : null
  const sanitizedQQOfficialConfig = agent.qqOfficialConfig
    ? { ...agent.qqOfficialConfig, appSecret: '********' }
    : null

  // Mask a2aRouteTargets apiKey
  let sanitizedRouteTargets: unknown[] | null = null
  if (agent.a2aRouteTargets) {
    const targets = agent.a2aRouteTargets as Array<Record<string, unknown>>
    sanitizedRouteTargets = targets.map((t) => {
      if (t.apiKey) return { ...t, apiKey: '********' }
      return t
    })
  }

  return {
    name: agent.name,
    description: agent.description,
    type: agent.type,
    icon: agent.icon,
    systemPrompt: agent.systemPrompt,
    config: sanitizeProviderChainConfig(agent.config as Record<string, unknown> | null),
    workspaceType: agent.workspaceType,
    maxConcurrency: agent.maxConcurrency,
    env: sanitizedEnv,
    feishuConfig: sanitizedFeishuConfig,
    slackConfig: sanitizedSlackConfig,
    discordConfig: sanitizedDiscordConfig,
    qqOfficialConfig: sanitizedQQOfficialConfig,
    // No masking pass: chat app config is presentation copy with no credentials.
    chatAppConfig: (agent.chatAppConfig as Record<string, unknown> | null) ?? null,
    scheduleConfig: agent.scheduleConfig as
      | Record<string, unknown>
      | Array<Record<string, unknown>>
      | null,
    // No masking pass: forge credentials live in the glab / gh CLI keyring, so
    // these configs carry only repository paths and polling preferences.
    glabConfig: (agent.glabConfig as Record<string, unknown> | null) ?? null,
    ghConfig: (agent.ghConfig as Record<string, unknown> | null) ?? null,
    publishChannels: (agent.publishChannels as string[]) ?? ['api'],
    oauthAccessMode: normalizeOauthAccessMode(agent.oauthAccessMode),
    // Deliberately not exported. The allowlist is an internal personnel roster, not config the
    // bundle needs to work, and a bundle travels further than the people on that list agreed
    // to. The importing owner re-enters their own; `specified_users` therefore lands
    // fail-closed on import, matching how the feishu_scope migration behaves.
    //
    // `GET /api/agents/:id` **does** return it, and that is not an inconsistency — the two
    // paths differ in how far the data travels, not in what it is. A bundle leaves the
    // permission model entirely: it lands in a file, gets forwarded, and outlives the Agent.
    // A read stays inside it, and the Agent owner has to see the roster to edit it on the
    // publish page. Same field, different blast radius, different answer.
    oauthAllowedEmails: null,
    a2aSkills: agent.a2aSkills as unknown[] | null,
    a2aRouteTargets: sanitizedRouteTargets,
    showLocalChildOutput: agent.showLocalChildOutput ?? null,
    showRemoteChildOutput: agent.showRemoteChildOutput ?? null,
    // References by name (resolved during import)
    providerRef: null, // filled below
    scmSourceRef: null,
    kbDocumentRefs: [],
    mcpServerRefs: [],
    skillRefs: [],
  }
}

/** Sanitize an MCP Server row without trusting credential key names. */
export function sanitizeMcpServer(mcp: McpRow): ExportedMcpServer {
  const sanitizedEnv = maskAllStringRecord(mcp.env) ?? null
  const sanitizedHeaders = maskAllStringRecord(mcp.headers) ?? null

  // Sanitize groupConfig: mask env/headers in inline backends, drop ref backends (IDs are instance-specific)
  let sanitizedGroupConfig: { backends: Record<string, unknown[]> } | null = null
  if (mcp.type === 'group' && mcp.groupConfig) {
    sanitizedGroupConfig = redactMcpGroupConfig(mcp.groupConfig, {
      dropRefBackends: true,
    }) as { backends: Record<string, unknown[]> }
  }

  return {
    name: mcp.name,
    description: mcp.description,
    type: mcp.type,
    command: mcp.command,
    args: mcp.args ?? [],
    cwd: mcp.cwd,
    url: redactMcpUrl(mcp.url) as string | null,
    headers: sanitizedHeaders,
    env: sanitizedEnv,
    isEnabled: mcp.isEnabled,
    groupConfig: sanitizedGroupConfig,
  }
}

// ============================================================
// Slug Deduplication
// ============================================================

/** Return a unique slug by appending -2, -3, ... if the base slug is already used */
export function deduplicateSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let i = 2
  while (used.has(`${base}-${i}`)) i++
  const unique = `${base}-${i}`
  used.add(unique)
  return unique
}

// ============================================================
// ZIP Builder
// ============================================================

/** Recursively add a directory to a ZIP under the given prefix */
function addDirectoryToZip(zip: AdmZip, dirPath: string, zipPrefix: string): void {
  if (!existsSync(dirPath)) return
  const entries = readdirSync(dirPath)
  for (const entry of entries) {
    const fullPath = join(dirPath, entry)
    const zipPath = `${zipPrefix}/${entry}`
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      addDirectoryToZip(zip, fullPath, zipPath)
    } else {
      zip.addFile(zipPath, readFileSync(fullPath))
    }
  }
}

/** Build an export ZIP whose materialized Skills are limited to the audience. */
export async function buildExportZip(
  agentId: string,
  audience: AgentExportAudience,
): Promise<Buffer> {
  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
  if (!agent) throw new Error('Agent not found')

  const zip = new AdmZip()
  const exported = sanitizeAgent(agent)

  // Resolve provider name
  if (agent.providerId) {
    const provider = (
      await db.select().from(providers).where(eq(providers.id, agent.providerId)).limit(1)
    )[0]
    if (provider) exported.providerRef = provider.name
  }

  // Resolve SCM source name
  if (agent.scmSourceId) {
    const scm = (
      await db.select().from(scmSources).where(eq(scmSources.id, agent.scmSourceId)).limit(1)
    )[0]
    if (scm) exported.scmSourceRef = scm.name
  }

  // Resolve KB document names
  const kbDocIds = (agent.kbDocumentIds as string[] | null) ?? []
  if (kbDocIds.length > 0) {
    const docs = await db.select().from(kbDocuments).where(inArray(kbDocuments.id, kbDocIds))
    exported.kbDocumentRefs = docs.map((d) => d.name)
  }

  // Export MCP Servers
  const mcpIds = (agent.mcpServerIds as string[] | null) ?? []
  if (mcpIds.length > 0) {
    const mcpRows = await db.select().from(mcpServers).where(inArray(mcpServers.id, mcpIds))
    const usedMcpSlugs = new Set<string>()
    for (const mcp of mcpRows) {
      const filename = `${deduplicateSlug(slugify(mcp.name), usedMcpSlugs)}.json`
      const sanitized = sanitizeMcpServer(mcp)
      zip.addFile(
        `mcp-servers/${filename}`,
        Buffer.from(JSON.stringify(sanitized, null, 2), 'utf-8'),
      )
      exported.mcpServerRefs.push(filename)
    }
  }

  // Export Skills（合并直挂 + 分组下所有 Skill，展开为单个 Skill，避免引用残留）
  const directSkillIds = (agent.skills as string[] | null) ?? []
  const groupIds = (agent.skillGroupIds as string[] | null) ?? []
  let skillRows: Array<typeof skills.$inferSelect> = []
  if (directSkillIds.length > 0 || groupIds.length > 0) {
    const byId =
      directSkillIds.length > 0
        ? await db.select().from(skills).where(inArray(skills.id, directSkillIds))
        : []
    const byGroup =
      groupIds.length > 0
        ? await db.select().from(skills).where(inArray(skills.groupId, groupIds))
        : []
    const seen = new Set<string>()
    skillRows = [...byId, ...byGroup].filter((s) => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      // A public share has no authenticated Skill visibility at all. Authenticated
      // exports mirror the Skills API: admins may export every row; other callers
      // may materialize only their own private rows or all-users rows.
      if (audience.kind === 'public') return false
      return audience.requesterIsAdmin || canNonAdminUseSkill(s, audience.requesterUserId)
    })
  }
  if (skillRows.length > 0) {
    const usedSkillSlugs = new Set<string>()
    for (const skill of skillRows) {
      const dirName = deduplicateSlug(slugify(skill.name), usedSkillSlugs)
      const isRebindableSystemBuiltin =
        skill.userId === null &&
        skill.visibility === 'all-users' &&
        REBINDABLE_SYSTEM_SKILL_NAMES.has(skill.name)

      if (skill.content) {
        zip.addFile(`skills/${dirName}/SKILL.md`, Buffer.from(skill.content, 'utf-8'))
      }

      // Copy additional files from storage
      if (skill.storagePath) {
        const storagePath = getSkillStoragePath(skill.id)
        if (existsSync(storagePath)) {
          const entries = readdirSync(storagePath)
          for (const entry of entries) {
            if (entry === 'SKILL.md' || entry === 'skill.json') continue
            const fullPath = join(storagePath, entry)
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              addDirectoryToZip(zip, fullPath, `skills/${dirName}/${entry}`)
            } else {
              zip.addFile(`skills/${dirName}/${entry}`, readFileSync(fullPath))
            }
          }
        }
      }

      const packagePrefix = `skills/${dirName}/`
      const skillMeta: ExportedSkillMetadata = {
        name: skill.name,
        description: skill.description,
        ...(isRebindableSystemBuiltin
          ? {
              origin: {
                kind: 'system-builtin' as const,
                name: skill.name,
                digest: computeExportedSkillPackageDigest(
                  skill,
                  zip
                    .getEntries()
                    .filter(
                      (entry) => !entry.isDirectory && entry.entryName.startsWith(packagePrefix),
                    )
                    .map((entry) => ({
                      path: entry.entryName.slice(packagePrefix.length),
                      data: entry.getData(),
                    })),
                ),
              },
            }
          : { origin: { kind: 'user-owned' as const } }),
      }
      zip.addFile(
        `${packagePrefix}skill.json`,
        Buffer.from(JSON.stringify(skillMeta, null, 2), 'utf-8'),
      )

      exported.skillRefs.push(`${dirName}/`)
    }
  }

  // Add agent.json
  zip.addFile('agent.json', Buffer.from(JSON.stringify(exported, null, 2), 'utf-8'))

  // Add manifest.json
  const manifest: ExportManifest = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    sourceInstance: 'a2wave',
    agentName: agent.name,
    a2waveVersion: '0.1.1',
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))

  return zip.toBuffer()
}
