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

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { withKeyedLock } from '../lib/keyed-mutex.js'
import { logger } from '../lib/logger.js'
import { processInstanceId } from '../lib/process-instance.js'
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

const execFileAsync = promisify(execFile)
const GIT_LS_FILES_TIMEOUT_MS = 30_000

/**
 * Whether the repository containing `workDir` already **tracks** `relativePath`.
 *
 * `ensurePlatformPathsExcluded` (lib/git-workspace.ts) keeps the platform's
 * workspace files out of `git status` by appending them to `info/exclude` — but
 * a git ignore rule applies to **untracked** files only. A repository that
 * legitimately commits its own `.mcp.json` (teams share non-secret MCP server
 * definitions that way) therefore gets no cover from it at all: this writer's
 * output lands as a modification to a tracked file, `git add -A` stages the
 * resolved Authorization headers and stdio API keys, and "commit and push my
 * changes" ships the MCP owner's credentials to the remote. So the write asks
 * first, and refuses.
 *
 * Deliberately local to this module rather than imported from `git-workspace`:
 * that module reaches `codegraph-index` (via `platformWorkspacePaths`) and so
 * the database client, which every engine module would then load.
 *
 * A directory that is no git repository at all — a P4 workspace, a multi-repo
 * workspace root — answers `false`: nothing there can be committed by accident.
 * Any other git failure propagates, because inferring "untracked" from an
 * unexplained error is exactly the write this probe exists to prevent.
 *
 * `LC_ALL=C` pins the stderr wording the "not a repository" test matches;
 * `GIT_TERMINAL_PROMPT=0` keeps a misconfigured repository from hanging the run.
 */
export async function isPathTrackedByGit(workDir: string, relativePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', relativePath], {
      cwd: workDir,
      timeout: GIT_LS_FILES_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout.length > 0
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stderr?: string }
    // No git binary on PATH, or the directory itself is gone.
    if (failure.code === 'ENOENT') return false
    if (/not a git repository/i.test(failure.stderr ?? '')) return false
    throw err
  }
}

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
  /**
   * True when the config file exists only because a2wave created it, so run-end
   * cleanup may delete the whole file. A file that predates the first sync is
   * user-authored and is only ever stripped of managed entries.
   */
  createdByPlatform?: boolean
  /**
   * The API instance whose sync last wrote this file — the durable half of the
   * refcount below.
   *
   * With PostgreSQL and a shared workspace volume, an Agent with
   * `maxConcurrency > 1` can execute on two replicas at once against the SAME
   * per-Agent worktree (`agent-<idSuffix>`, no occupancy check by design), and
   * neither replica's in-process refcount can see the other's runs. Cleanup
   * therefore also has to own the marker: a foreign stamp means the live
   * config on disk belongs to the peer, and this run releases nothing.
   *
   * Absent on markers written before stamping existed, and equal to this
   * instance id when a previous life of this container wrote it; both count as
   * ours, so a single-replica deployment always reclaims its own credentials.
   */
  ownerInstanceId?: string
}

/**
 * Live references to a managed MCP config file, keyed by absolute path.
 *
 * Same-Agent runs share one worktree without an occupancy check (see
 * docs/agent/worktree-isolation.md), so a sibling's run-end cleanup must not
 * pull the config out from under a run still executing. Every sync takes a
 * reference and every cleanup releases one; the file is deleted only when the
 * last one goes.
 *
 * This map only ever sees THIS process's runs. The cross-replica half of the
 * same question — a peer replica executing the same Agent in the same shared
 * worktree — is answered by the marker's `ownerInstanceId`, which the release
 * path checks after the count reaches zero.
 */
const managedMcpConfigRefs = new Map<string, number>()

/**
 * Lock key serialising every reference change and file operation on one config
 * path. Both the sync and the cleanup are read-modify-write sequences spanning
 * several awaits, so without this a sibling run's fresh config could be written
 * inside another run's cleanup window and then deleted by it.
 */
function mcpConfigLockKey(filePath: string): string {
  return `mcp-config:${filePath}`
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

interface JsonFileRead {
  /**
   * Whether the file is on disk. Only a missing file reads as absent: an
   * existing one that cannot be read or parsed still counts as present, so it
   * is never mistaken for a file a2wave created and may delete in full.
   */
  exists: boolean
  record: Record<string, unknown>
}

/** One read answers both "is it there?" and "what is in it?". */
async function readJsonRecordAsync(filePath: string): Promise<JsonFileRead> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err) {
    const absent = (err as NodeJS.ErrnoException).code === 'ENOENT'
    return { exists: !absent, record: {} }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return { exists: true, record: isRecord(parsed) ? parsed : {} }
  } catch {
    return { exists: true, record: {} }
  }
}

/** The sidecar marker, or null when no a2wave sync has written one yet. */
async function readManagedMarkerAsync(markerPath: string): Promise<ManagedMcpMarker | null> {
  const { exists, record } = await readJsonRecordAsync(markerPath)
  if (!exists) return null
  const createdByPlatform = record.createdByPlatform === true
  const ownerInstanceId =
    typeof record.ownerInstanceId === 'string' ? record.ownerInstanceId : undefined
  if (!isRecord(record.managedServers)) {
    return { managedServers: {}, createdByPlatform, ownerInstanceId }
  }
  const managedServers: Record<string, string> = {}
  for (const [name, fingerprint] of Object.entries(record.managedServers)) {
    if (typeof fingerprint === 'string') managedServers[name] = fingerprint
  }
  return { managedServers, createdByPlatform, ownerInstanceId }
}

/**
 * Whether this process may act on the file the marker describes.
 *
 * A missing stamp is a marker from before stamping existed, and this instance's
 * own id covers both this process and a previous life of the same container —
 * either way no peer's live config is at stake. A peer's stamp is refused: the
 * worst case then is a credential file left for the next run in this worktree
 * to overwrite, instead of a config pulled out from under a running Agent CLI.
 */
function ownsManagedMarker(marker: ManagedMcpMarker): boolean {
  return marker.ownerInstanceId === undefined || marker.ownerInstanceId === processInstanceId
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
 * Raised instead of writing resolved MCP credentials into a config file the
 * repository already tracks.
 *
 * The workspace `info/exclude` entry (`ensurePlatformPathsExcluded`) only ever
 * covers untracked files, so a repository that commits its own `.mcp.json` —
 * teams share non-secret server definitions that way — would take the platform's
 * write as a modification to a tracked file: `git add -A` stages the bearer
 * tokens and stdio API keys, and the next "commit and push my changes" ships
 * them to the remote.
 *
 * Failing the run is deliberate. None of the workspace-file engines (Claude
 * Code, Cursor, Qoder, Trae, Kimi) exposes a flag pointing at an MCP config
 * outside the working tree, so the only alternatives are writing the secret
 * (the leak) or dropping the Agent's MCP servers silently (an Agent that
 * behaves differently with no explanation). The operator gets a named file and
 * the one command that fixes it instead.
 */
export class TrackedMcpConfigError extends Error {
  constructor(readonly relativePath: string) {
    super(
      `Refusing to write MCP credentials into "${relativePath}": the repository tracks this file, ` +
        'so a "git add -A" by the agent would stage the resolved Authorization headers and stdio ' +
        `API keys. Untrack it in the repository ("git rm --cached ${relativePath}", commit, and add ` +
        "it to .gitignore), or point the Provider's MCP config path at a file the repository " +
        'does not track.',
    )
    this.name = 'TrackedMcpConfigError'
  }
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
 * @returns `true` when the write landed and took a reference on the managed
 *   config that run-end cleanup must release; `false` when nothing was written.
 * @throws {TrackedMcpConfigError} when the repository tracks the target file and
 *   there are managed entries to inject.
 */
export async function syncMcpToWorkspaceAtPathAsync(
  workDir: string,
  relativePath: string,
  servers: ResolvedMcpServer[],
  options: SyncMcpOptions = {},
): Promise<boolean> {
  const filePath = join(workDir, relativePath)
  return withKeyedLock(mcpConfigLockKey(filePath), () =>
    writeMcpConfig(workDir, relativePath, servers, options),
  )
}

async function writeMcpConfig(
  workDir: string,
  relativePath: string,
  servers: ResolvedMcpServer[],
  options: SyncMcpOptions,
): Promise<boolean> {
  const filePath = join(workDir, relativePath)
  const managedServers = buildManagedMcpServers(servers, options.dialect)

  // Asked before anything is created or written: a tracked target must come out
  // of this function byte-identical, marker included.
  if (await isPathTrackedByGit(workDir, relativePath)) {
    // Nothing to inject means nothing to leak — leave the committed file alone
    // and take no reference, rather than failing a run over a file the platform
    // has no business rewriting.
    if (Object.keys(managedServers).length === 0) {
      logger.debug(
        { filePath },
        'Skipping MCP sync: the repository tracks this config and there is nothing to inject',
      )
      return false
    }
    throw new TrackedMcpConfigError(relativePath)
  }

  await mkdir(dirname(filePath), { recursive: true })
  const markerPath = `${filePath}${MCP_MANAGED_MARKER_SUFFIX}`

  // Sampled before the write so run-end cleanup can tell a file a2wave created
  // (deletable in full — it holds MCP bearer tokens and API keys) from a
  // user-authored one (only managed entries may be stripped).
  const { exists: fileExistedBeforeSync, record: existingConfig } =
    await readJsonRecordAsync(filePath)
  const existingServersRaw = existingConfig.mcpServers
  const existingServers = isRecord(existingServersRaw) ? { ...existingServersRaw } : {}

  // 清理上次托管内容；仅在指纹匹配时删除，避免误删用户手工修改条目。
  const previousMarker = await readManagedMarkerAsync(markerPath)
  for (const [managedName, fingerprint] of Object.entries(previousMarker?.managedServers ?? {})) {
    if (!(managedName in existingServers)) continue
    if (stableStringify(existingServers[managedName]) === fingerprint) {
      delete existingServers[managedName]
    }
  }

  const nextManagedMarker: ManagedMcpMarker = {
    managedServers: {},
    createdByPlatform: !fileExistedBeforeSync || previousMarker?.createdByPlatform === true,
    ownerInstanceId: processInstanceId,
  }
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
  managedMcpConfigRefs.set(filePath, (managedMcpConfigRefs.get(filePath) ?? 0) + 1)
  return true
}

/**
 * Drop the MCP config a run's sync wrote, at run end.
 *
 * The managed entries carry live credentials — `headers.Authorization` bearer
 * tokens and stdio `env` API keys — in plaintext, and a per-Agent worktree is
 * persistent, so leaving the file behind means those secrets sit on disk
 * between runs and land in `git add -A` when a colleague asks the Agent to
 * commit. (`.gitignore` coverage is the other half of that fix; see
 * `ensurePlatformPathsExcluded` in lib/git-workspace.ts.)
 *
 * The sidecar marker decides what may be removed:
 * - **no marker** → the file predates any a2wave sync; never touched;
 * - **marker + `createdByPlatform`** and nothing left but our own entries →
 *   the whole file goes;
 * - otherwise → only the managed entries whose fingerprint still matches are
 *   stripped, so a user-authored file (and any entry the user edited) survives.
 *
 * Best-effort: a failure here must never fail a finished run.
 */
export async function cleanupManagedMcpConfigAsync(
  workDir: string,
  relativePath: string,
): Promise<void> {
  const filePath = join(workDir, relativePath)
  await withKeyedLock(mcpConfigLockKey(filePath), () => releaseMcpConfig(filePath))
}

async function releaseMcpConfig(filePath: string): Promise<void> {
  const remainingRefs = (managedMcpConfigRefs.get(filePath) ?? 0) - 1
  if (remainingRefs > 0) {
    managedMcpConfigRefs.set(filePath, remainingRefs)
    return
  }
  managedMcpConfigRefs.delete(filePath)

  const markerPath = `${filePath}${MCP_MANAGED_MARKER_SUFFIX}`
  try {
    const marker = await readManagedMarkerAsync(markerPath)
    // No marker: the file predates any a2wave sync and is never touched.
    if (!marker) return
    // A peer replica re-synced this shared worktree after us: the config and
    // marker on disk are its live run's, and only its own cleanup may remove
    // them.
    if (!ownsManagedMarker(marker)) {
      logger.debug(
        { filePath, ownerInstanceId: marker.ownerInstanceId },
        'Skipping managed MCP config cleanup: another instance owns the marker',
      )
      return
    }
    const { record: config } = await readJsonRecordAsync(filePath)
    const serversRaw = config.mcpServers
    const servers = isRecord(serversRaw) ? { ...serversRaw } : {}
    for (const [name, fingerprint] of Object.entries(marker.managedServers)) {
      if (!(name in servers)) continue
      if (stableStringify(servers[name]) === fingerprint) delete servers[name]
    }

    const onlyOurContent =
      Object.keys(servers).length === 0 && Object.keys(config).every((key) => key === 'mcpServers')
    if (marker.createdByPlatform && onlyOurContent) {
      await rm(filePath, { force: true })
    } else {
      await writeFile(filePath, JSON.stringify({ ...config, mcpServers: servers }, null, 2))
    }
    await rm(markerPath, { force: true })
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to clean up managed MCP config after the run')
  }
}
