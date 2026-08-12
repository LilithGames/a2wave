/**
 * MCP 配置文件同步
 *
 * 与 skill-sync 的"托管内容 + 用户内容共存"原则一致：
 * - 不直接覆盖整个 mcp.json；
 * - 仅替换 a2wave 托管的 MCP 条目；
 * - 用户手工维护的条目始终保留；
 * - 若与用户同名冲突，自动避让到 `<name>--a2w`（必要时递增）。
 *
 * 额外约定：
 * - 在 MCP 配置文件旁写入 sidecar marker：`<mcpConfigPath>.a2wave-managed`；
 * - marker 记录"上次由 a2wave 写入的条目名与指纹"，用于下次安全清理旧托管条目。
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BUILTIN_PROVIDER_MANIFESTS } from './provider-catalog.js'

export interface ResolvedMcpServer {
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string | null
  args?: string[]
  cwd?: string | null
  url?: string | null
  headers?: Record<string, string>
  env?: Record<string, string>
  /** 非敏感、可安全以字面值 inline 进引擎配置的 env key 列表(codex 用其逐台隔离，避免多台
   *  stdio server 共用同名 env 时互相覆盖）。secret 不要放进来——只放确定非敏感的运行参数。 */
  publicEnvKeys?: string[]
  /** Filtered group credentials held in memory until executeInWorker materializes a one-run carrier. */
  runtimeGroupConfig?: {
    legacyMcpServerId: string
    config: object
  }
}

const MCP_MANAGED_MARKER_SUFFIX = '.a2wave-managed'

/**
 * Workspace paths this writer owns: every Provider's MCP config file plus the
 * sidecar marker written beside it. Registered with `platformWorkspacePaths()`,
 * which derives the root-entry set from these.
 */
export function mcpSyncWorkspacePaths(): string[] {
  const paths: string[] = []
  for (const manifest of Object.values(BUILTIN_PROVIDER_MANIFESTS)) {
    const delivery = manifest.capabilities?.mcpDelivery
    if (delivery?.mode !== 'workspace-file' || !delivery.defaultPath) continue
    paths.push(delivery.defaultPath, `${delivery.defaultPath}${MCP_MANAGED_MARKER_SUFFIX}`)
  }
  return paths
}

interface ManagedMcpMarker {
  managedServers: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// --- Async helpers ---

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function readJsonRecordAsync(filePath: string): Promise<Record<string, unknown>> {
  if (!(await pathExists(filePath))) return {}
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function readManagedMarkerAsync(markerPath: string): Promise<ManagedMcpMarker> {
  const parsed = await readJsonRecordAsync(markerPath)
  if (!isRecord(parsed.managedServers)) return { managedServers: {} }
  const managedServers: Record<string, string> = {}
  for (const [name, fingerprint] of Object.entries(parsed.managedServers)) {
    if (typeof fingerprint === 'string') managedServers[name] = fingerprint
  }
  return { managedServers }
}

async function writeManagedMarkerAsync(
  markerPath: string,
  marker: ManagedMcpMarker,
): Promise<void> {
  await writeFile(markerPath, JSON.stringify(marker, null, 2))
}

function resolveNonConflictingMcpName(
  baseName: string,
  existingServers: Record<string, unknown>,
): string {
  const fallbackBase = `${baseName}--a2w`
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? baseName : i === 1 ? fallbackBase : `${fallbackBase}-${i}`
    if (!(candidate in existingServers)) return candidate
  }
  return `${fallbackBase}-${Date.now()}`
}

/**
 * Remote-transport spelling for the target CLI's mcp.json reader.
 *
 * `default` is the Claude-Code-family shape every other provider consumes
 * (`type: 'http'`, and a bare `url` for SSE).
 *
 * `kimi` is required because Kimi Code keys the transport off `transport` and
 * treats a `url` entry *without* one as streamable HTTP — so an SSE server
 * written in the default shape would be silently connected over the wrong
 * transport instead of failing loudly.
 */
export type McpConfigDialect = 'default' | 'kimi'

export interface SyncMcpOptions {
  dialect?: McpConfigDialect
}

function buildManagedMcpServers(
  servers: ResolvedMcpServer[],
  dialect: McpConfigDialect = 'default',
): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {}
  for (const server of servers) {
    if (server.type === 'stdio' && server.command) {
      mcpServers[server.name] = {
        command: server.command,
        args: server.args ?? [],
        ...(server.cwd?.trim() ? { cwd: server.cwd.trim() } : {}),
        ...(server.env ? { env: server.env } : {}),
      }
    } else if (server.type === 'sse' && server.url) {
      mcpServers[server.name] = {
        ...(dialect === 'kimi' ? { transport: 'sse' } : {}),
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      }
    } else if (server.type === 'http' && server.url) {
      mcpServers[server.name] = {
        ...(dialect === 'kimi' ? { transport: 'http' } : { type: 'http' }),
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      }
    }
  }
  return mcpServers
}

/**
 * 将 MCP 服务器配置异步同步到工作区指定路径（不阻塞事件循环）。
 *
 * 写入规则（与 skill-sync 一致）：
 * - 配置文件：{workDir}/{relativePath}
 * - marker 文件：{workDir}/{relativePath}.a2wave-managed
 *
 * 同步流程：
 * 1) 读取现有 mcp 配置与 marker。
 * 2) 基于 marker 清理旧托管条目（仅当条目内容指纹匹配，避免误删用户改动）。
 * 3) 写入本次托管条目；若与用户同名冲突，自动避让命名。
 * 4) 回写 mcp 配置与 marker。
 *
 * @param workDir 工作区根目录绝对路径
 * @param relativePath 相对 workDir 的文件路径，如 ".cursor/mcp.json" 或 ".mcp.json"
 * @param servers MCP 服务器列表
 * @param options `dialect` 选择远程传输字段写法（Kimi 用 `transport`）
 */
export async function syncMcpToWorkspaceAtPathAsync(
  workDir: string,
  relativePath: string,
  servers: ResolvedMcpServer[],
  options: SyncMcpOptions = {},
): Promise<void> {
  const filePath = join(workDir, relativePath)
  await mkdir(dirname(filePath), { recursive: true })
  const markerPath = `${filePath}${MCP_MANAGED_MARKER_SUFFIX}`

  const existingConfig = await readJsonRecordAsync(filePath)
  const existingServersRaw = existingConfig.mcpServers
  const existingServers = isRecord(existingServersRaw) ? { ...existingServersRaw } : {}

  // 清理上次托管内容；仅在指纹匹配时删除，避免误删用户手工修改条目。
  const previousMarker = await readManagedMarkerAsync(markerPath)
  for (const [managedName, fingerprint] of Object.entries(previousMarker.managedServers)) {
    if (!(managedName in existingServers)) continue
    if (stableStringify(existingServers[managedName]) === fingerprint) {
      delete existingServers[managedName]
    }
  }

  const managedServers = buildManagedMcpServers(servers, options.dialect)
  const nextManagedMarker: ManagedMcpMarker = { managedServers: {} }
  for (const [requestedName, serverConfig] of Object.entries(managedServers)) {
    const resolvedName = resolveNonConflictingMcpName(requestedName, existingServers)
    existingServers[resolvedName] = serverConfig
    nextManagedMarker.managedServers[resolvedName] = stableStringify(serverConfig)
  }

  const nextConfig = {
    ...existingConfig,
    mcpServers: existingServers,
  }

  await writeFile(filePath, JSON.stringify(nextConfig, null, 2))
  await writeManagedMarkerAsync(markerPath, nextManagedMarker)
}
