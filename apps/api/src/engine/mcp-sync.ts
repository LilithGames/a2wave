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
import type { Stats } from 'node:fs'
import { mkdir, readFile, readlink, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
 * Runs one git command for the trackedness probe.
 *
 * `null` means "there is no repository to ask" — no git binary on PATH, a
 * missing directory, or a plain non-checkout (a P4 workspace, a multi-repo
 * workspace root): nothing there can be committed by accident. Any other git
 * failure propagates, because inferring "untracked" from an unexplained error is
 * exactly the write this probe exists to prevent.
 *
 * `LC_ALL=C` pins the stderr wording the "not a repository" test matches;
 * `GIT_TERMINAL_PROMPT=0` keeps a misconfigured repository from hanging the run.
 */
async function runGitProbe(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_LS_FILES_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { stderr?: string }
    // No git binary on PATH, or the directory itself is gone.
    if (failure.code === 'ENOENT') return null
    if (/not a git repository/i.test(failure.stderr ?? '')) return null
    throw err
  }
}

/**
 * Whether git would ignore `relativePath` in `workTree`.
 *
 * `git check-ignore -q` answers by exit status: 0 ignored, 1 not ignored, 128
 * for a real failure. Only the "not ignored" code is turned into `false` — an
 * unexplained failure propagates, because assuming "ignored" is exactly the
 * write the caller is trying to prevent.
 */
async function isPathIgnoredByGit(workTree: string, relativePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '-q', '--', relativePath], {
      cwd: workTree,
      timeout: GIT_LS_FILES_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    })
    return true
  } catch (err) {
    // `execFile` reports a non-zero exit in `code` as a number; ENOENT-style
    // failures put a string there. Only exit 1 — "not ignored" — is an answer.
    const { code } = err as { code?: number | string }
    if (code === 1) return false
    throw err
  }
}

/** Bounds the symlink walk in `resolveWriteTarget`; git's own limit is smaller. */
const MAX_LINK_HOPS = 64

/**
 * The absolute path a write to `target` would actually touch.
 *
 * `realpath` answers directly for a file that exists, and resolves a symlinked
 * **parent directory** just as well as a symlinked file. A target that does not
 * exist yet (the common case — the sync creates the config) makes `realpath`
 * fail with ENOENT, so the deepest existing ancestor is resolved instead and the
 * missing tail rejoined onto it. A **dangling** symlink is followed by hand:
 * `realpath` refuses it, but the write would still land wherever it points.
 */
async function resolveWriteTarget(target: string): Promise<string> {
  const missingTail: string[] = []
  let current = target
  for (let hops = 0; hops < MAX_LINK_HOPS; hops++) {
    try {
      return join(await realpath(current), ...missingTail)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    try {
      const link = await readlink(current)
      current = isAbsolute(link) ? link : join(dirname(current), link)
      continue
    } catch {
      // Not a symlink — just absent. Climb to the parent and keep the name.
    }
    const parent = dirname(current)
    if (parent === current) break
    missingTail.unshift(basename(current))
    current = parent
  }
  return join(current, ...missingTail)
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** Escapes git pathspec glob metacharacters in a literal directory prefix. */
function escapeGlobPathspec(literal: string): string {
  return literal.replace(/[\\*?[\]]/g, (char) => `\\${char}`)
}

export interface McpConfigTargetProbe {
  /** Absolute path the write would actually touch, after symlink resolution. */
  resolvedPath: string
  /**
   * Work-tree-relative pathname git tracks for that target, or `null` when the
   * write cannot land on a tracked file.
   */
  trackedPath: string | null
  /**
   * Work tree of the repository that owns `resolvedPath` — which is not
   * necessarily the one `workDir` sits in, and exists even when `workDir` is a
   * multi-repo workspace root that is no checkout at all. `null` when no
   * repository owns the target, the one case where nothing there can be
   * committed by accident.
   */
  workTree: string | null
}

/**
 * Whether some repository already **tracks** the file a write to
 * `relativePath` would land on, and where that file actually is.
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
 * **The question is about the file, not the pathname.** git matches an index
 * entry as an exact, case-sensitive byte string; the write goes wherever the
 * *filesystem* resolves the same name. Ways those identities diverge, and what
 * covers each:
 *
 * - a **symlink**, at the file or at any parent directory component →
 *   `resolveWriteTarget`, before anything is asked of git, so the question is
 *   put about the path the bytes land on;
 * - **case folding** on macOS/Windows (`.MCP.JSON` tracked, `.mcp.json` written,
 *   one inode) → the tracked entries of the containing directory are compared to
 *   the target by **`dev`+`ino` identity**, which is exact on every platform and
 *   needs no guess about the filesystem's case sensitivity;
 * - a **hardlink**, one inode under two unrelated pathnames → not answerable by
 *   any listing this probe could afford, so it is not answered here: the writer
 *   severs a multiply-linked target instead of writing through it
 *   (`detachHardLinkedTarget`);
 * - the target **not existing yet**, where there is no inode to compare → a
 *   case-insensitive basename match is treated as tracked. Conservative by
 *   design: refusing a write is recoverable, publishing a credential is not.
 *
 * **The repository is found from the resolved target, not from `workDir`.**
 * Resolution can move the target into a different directory — or into a
 * different repository: a multi-repo workspace root is itself no checkout, and
 * inferring "nothing here is committable" from that would hand every sub-repo's
 * tracked file straight back to the leak. So `--show-toplevel` is asked at the
 * target, and containment is judged against `workDir`'s own work tree (or
 * `workDir` itself when it is no checkout). A target that resolves outside that
 * boundary is refused outright (`McpConfigOutsideWorkTreeError`): this writer
 * follows a config path into the workspace, never out of it.
 *
 * Deliberately local to this module rather than imported from `git-workspace`:
 * that module reaches `codegraph-index` (via `platformWorkspacePaths`) and so
 * the database client, which every engine module would then load.
 */
export async function probeMcpConfigTarget(
  workDir: string,
  relativePath: string,
): Promise<McpConfigTargetProbe> {
  const resolvedPath = await resolveWriteTarget(join(workDir, relativePath))
  const boundary = await workspaceBoundary(workDir)
  if (resolvedPath !== boundary && !resolvedPath.startsWith(`${boundary}${sep}`)) {
    throw new McpConfigOutsideWorkTreeError(relativePath, resolvedPath)
  }

  // Asked where the bytes land, so a nested repository inside a multi-repo
  // workspace answers for its own tracked files. The directory may not exist
  // yet (the sync creates it), and git needs a cwd that does.
  const workTree = await gitWorkTreeFor(resolvedPath)
  // Not a checkout: nothing there can be committed by accident.
  if (workTree === null) return { resolvedPath, trackedPath: null, workTree: null }

  const relativeToWorkTree = relative(workTree, resolvedPath)
  const parent = dirname(relativeToWorkTree)
  const prefix = parent === '.' ? '' : `${parent}/`
  // `:(glob)` keeps `*` from crossing `/`, so this lists the tracked entries of
  // the containing directory only — a repository-wide `ls-files` for a
  // root-level `.mcp.json` would be needlessly expensive.
  const listing = await runGitProbe(
    ['ls-files', '-z', '--', `:(glob)${escapeGlobPathspec(prefix)}*`],
    workTree,
  )
  if (listing === null) return { resolvedPath, trackedPath: null, workTree }

  const targetName = basename(relativeToWorkTree).toLowerCase()
  let targetStat: Stats | null | undefined
  for (const entry of listing.split('\0')) {
    if (entry.length === 0) continue
    // Exact pathname: tracked whatever the filesystem does, including a tracked
    // entry whose file is currently deleted from the working tree.
    if (entry === relativeToWorkTree) return { resolvedPath, trackedPath: entry, workTree }
    if (basename(entry).toLowerCase() !== targetName) continue
    if (targetStat === undefined) targetStat = await statOrNull(resolvedPath)
    const candidateStat = await statOrNull(join(workTree, entry))
    if (targetStat && candidateStat) {
      // Both on disk: same inode means the same file under two spellings, and
      // different inodes mean the filesystem keeps them apart.
      if (targetStat.dev === candidateStat.dev && targetStat.ino === candidateStat.ino) {
        return { resolvedPath, trackedPath: entry, workTree }
      }
      continue
    }
    // One of them is absent, so identity cannot be proven either way.
    return { resolvedPath, trackedPath: entry, workTree }
  }
  return { resolvedPath, trackedPath: null, workTree }
}

/**
 * The furthest a resolved config path may travel: `workDir`'s own work tree
 * when it is a checkout (a Provider may legitimately point at a sibling
 * directory of the same repository), and `workDir` itself otherwise.
 */
async function workspaceBoundary(workDir: string): Promise<string> {
  const topLevel = await runGitProbe(['rev-parse', '--show-toplevel'], workDir)
  return realpathOrSelf(topLevel === null ? workDir : topLevel.trim())
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/** Deepest existing ancestor of `dir` (inclusive) — a usable cwd for git. */
async function nearestExistingDir(dir: string): Promise<string> {
  let current = dir
  for (;;) {
    if ((await statOrNull(current))?.isDirectory()) return current
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

/** The `# a2wave` header `ensurePlatformPathsExcluded` writes; shared so the two never double up. */
const PLATFORM_EXCLUDE_HEADER = '# a2wave: platform-written workspace paths'

/**
 * Guarantee that the file this write creates stays invisible to `git add -A`.
 *
 * `ensurePlatformPathsExcluded` (lib/git-workspace.ts) excludes the pathnames
 * the platform *derives* — `/.mcp.json`, `/.cursor/mcp.json` — in each
 * repository of the workspace. Two things it cannot derive: a per-Agent
 * `mcpConfigPath` override that matches no Provider preset, and a path whose
 * indirection sends the bytes somewhere else entirely. `.mcp.json` symlinked to
 * `config/local-mcp.json` is excluded under the name that holds no credentials
 * and tracked-by-nobody under the name that does, so `git add -A` stages the
 * resolved Authorization headers — the very leak the exclude entry exists to
 * stop, reintroduced by one symlink.
 *
 * So the exclusion is verified where the bytes land, and appended to that
 * repository's `info/exclude` when it is missing. Anchored (`/config/x.json`)
 * and idempotent, matching the entries `ensurePlatformPathsExcluded` writes.
 *
 * If git still does not ignore the path afterwards — a `!negation` in a
 * committed `.gitignore` outranks `info/exclude` — the write is refused rather
 * than left to land in the index.
 */
async function ensureWriteTargetExcluded(
  probe: McpConfigTargetProbe,
  relativePath: string,
  literalPath: string,
): Promise<void> {
  // Both spellings have to be covered. The symlink at `literalPath` is an
  // untracked entry of its own — `git add -A` stages the link itself — and the
  // resolved target is where the credentials come to rest; the two can even sit
  // in different repositories of a multi-repo workspace.
  await ensurePathExcluded(probe.workTree, probe.resolvedPath, relativePath)
  // Canonicalised at the parent only — the link's own name is the entry git
  // sees — so the comparison and `relative()` below share one spelling of the
  // path with the realpath'd work tree.
  const literalTarget = await canonicalizeParent(literalPath)
  if (literalTarget === probe.resolvedPath) return
  await ensurePathExcluded(await gitWorkTreeFor(literalTarget), literalTarget, relativePath)
}

/** Excludes one absolute path in `workTree`, or refuses when git still won't ignore it. */
async function ensurePathExcluded(
  workTree: string | null,
  absolutePath: string,
  relativePath: string,
): Promise<void> {
  if (workTree === null) return
  const relativeToWorkTree = relative(workTree, absolutePath)
  if (await isPathIgnoredByGit(workTree, relativeToWorkTree)) return

  await appendGitExclude(workTree, `/${relativeToWorkTree}`)
  if (await isPathIgnoredByGit(workTree, relativeToWorkTree)) return
  throw new McpConfigNotExcludedError(relativePath, absolutePath)
}

/**
 * `absolutePath` with its directories canonicalised but its own name left
 * alone — the spelling git's realpath'd work tree can be `relative()`d against,
 * for a path whose parents may not exist yet.
 */
async function canonicalizeParent(absolutePath: string): Promise<string> {
  const parent = dirname(absolutePath)
  const existing = await nearestExistingDir(parent)
  return join(await realpathOrSelf(existing), relative(existing, parent), basename(absolutePath))
}

/** Work tree owning `absolutePath`, or `null` when no repository does. */
async function gitWorkTreeFor(absolutePath: string): Promise<string | null> {
  const topLevel = await runGitProbe(
    ['rev-parse', '--show-toplevel'],
    await nearestExistingDir(dirname(absolutePath)),
  )
  return topLevel === null ? null : await realpath(topLevel.trim())
}

/**
 * Appends one anchored pattern to a repository's `info/exclude`, once.
 *
 * `--git-path` answers **relative to the cwd in the main checkout and absolute
 * in a linked worktree**, whose exclude file lives in the main repository's
 * `.git`. Joining an absolute answer onto the work tree would build a nonsense
 * path, write the rule where no git reads it, and then refuse the run — in the
 * layout a2wave executes every Agent in (docs/agent/worktree-isolation.md), so
 * `resolve` is what handles both answers.
 *
 * One `info/exclude` serves the whole repository while every config path in the
 * workspace appends to it, so the read-modify-write is serialised on the file:
 * two syncs that both read the same "before" content would otherwise have the
 * later write drop the earlier rule, leaving a run that already verified its
 * exclusion unprotected. In-process only — the cross-replica half is bounded by
 * the re-check in `ensurePathExcluded`, which refuses rather than writes.
 */
async function appendGitExclude(workTree: string, pattern: string): Promise<void> {
  const gitPath = await runGitProbe(['rev-parse', '--git-path', 'info/exclude'], workTree)
  if (gitPath === null) return
  const excludePath = resolve(workTree, gitPath.trim())
  await withKeyedLock(`git-exclude:${excludePath}`, async () => {
    let existing = ''
    try {
      existing = await readFile(excludePath, 'utf-8')
    } catch {
      // No exclude file yet (a `git init` template can omit it) — create it.
    }
    const present = new Set(existing.split('\n').map((line) => line.trim()))
    if (present.has(pattern)) return
    await mkdir(dirname(excludePath), { recursive: true })
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
    const header = present.has(PLATFORM_EXCLUDE_HEADER) ? '' : `${PLATFORM_EXCLUDE_HEADER}\n`
    await writeFile(excludePath, `${existing}${prefix}${header}${pattern}\n`)
  })
}

/**
 * Break the target away from any file sharing its inode, before writing it.
 *
 * A hardlink is one inode under two unrelated pathnames: `.mcp.json` linked to
 * the tracked `config/team-mcp.json` is not a symlink to resolve, does not share
 * a basename with its twin, and is invisible to any listing the trackedness
 * probe can afford. Writing in place through either name modifies the tracked
 * file behind the other, and `git add -A` stages the credentials.
 *
 * Unlinking first gives the write a fresh inode at the same pathname — the one
 * the exclude entry covers — and leaves every other link's content exactly as
 * it was. The merged content is read before this runs, so nothing is lost; only
 * the sharing is.
 */
async function detachHardLinkedTarget(targetPath: string): Promise<void> {
  const stats = await statOrNull(targetPath)
  // A directory's link count is >= 2 by construction and unlinking one is not
  // this function's business; only a regular file can share an inode this way.
  if (!stats?.isFile() || stats.nlink <= 1) return
  logger.warn(
    { targetPath, nlink: stats.nlink },
    'Replacing a hardlinked MCP config instead of writing through it: another pathname shares its inode',
  )
  await unlink(targetPath)
}

/** Boolean face of {@link probeMcpConfigTarget}. */
export async function isPathTrackedByGit(workDir: string, relativePath: string): Promise<boolean> {
  return (await probeMcpConfigTarget(workDir, relativePath)).trackedPath !== null
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
  /**
   * @param relativePath the configured path, as the Provider spells it
   * @param trackedPath the work-tree-relative pathname git actually tracks — the
   *   same string for a plain tracked file, and a different one when a symlink
   *   or a case-folding filesystem sends the write somewhere else. The
   *   `git rm --cached` has to name *that* file to be actionable.
   */
  constructor(
    readonly relativePath: string,
    readonly trackedPath: string = relativePath,
  ) {
    super(
      `Refusing to write MCP credentials into "${relativePath}": the repository tracks the file ` +
        `it resolves to ("${trackedPath}"), so a "git add -A" by the agent would stage the ` +
        'resolved Authorization headers and stdio API keys. Untrack it in the repository ' +
        `("git rm --cached ${trackedPath}", commit, and add it to .gitignore), or point the ` +
        "Provider's MCP config path at a file the repository does not track.",
    )
    this.name = 'TrackedMcpConfigError'
  }
}

/**
 * Raised when the configured MCP config path resolves — through a symlink at the
 * file or at a parent directory — to somewhere outside the workspace's git work
 * tree.
 *
 * Following it would write plaintext bearer tokens and stdio API keys to a
 * location the run does not own and run-end cleanup reasons about incorrectly,
 * and the trackedness question cannot even be asked there. Refusing names the
 * destination instead.
 */
export class McpConfigOutsideWorkTreeError extends Error {
  constructor(
    readonly relativePath: string,
    readonly resolvedPath: string,
  ) {
    super(
      `Refusing to write MCP credentials for "${relativePath}": it resolves to "${resolvedPath}", ` +
        'which is outside the workspace git work tree. Replace the symlink, or point the ' +
        "Provider's MCP config path at a file inside the workspace.",
    )
    this.name = 'McpConfigOutsideWorkTreeError'
  }
}

/**
 * Raised when the file the write would land on cannot be kept out of git's
 * index — `info/exclude` was appended and `git check-ignore` still says the
 * path is not ignored, which a `!negation` in a committed `.gitignore` does.
 *
 * The target is untracked, so nothing is being overwritten; but the very next
 * `git add -A` would stage the plaintext bearer tokens this writer is about to
 * put there. Nothing is written, so the refusal leaves no credential behind.
 */
export class McpConfigNotExcludedError extends Error {
  constructor(
    readonly relativePath: string,
    readonly resolvedPath: string,
  ) {
    super(
      `Refusing to write MCP credentials for "${relativePath}": it resolves to "${resolvedPath}", ` +
        'which git still would not ignore after the platform added it to .git/info/exclude ' +
        '(a "!" negation in a committed .gitignore outranks it), so a "git add -A" by the agent ' +
        'would stage the resolved Authorization headers and stdio API keys. Remove the negation, ' +
        "or point the Provider's MCP config path at a file the repository ignores.",
    )
    this.name = 'McpConfigNotExcludedError'
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
  // of this function byte-identical, marker included. The probe answers about
  // the file the write would land on, not the pathname it was asked about, and
  // throws outright when that file is outside the work tree.
  const probe = await probeMcpConfigTarget(workDir, relativePath)
  const { trackedPath, resolvedPath } = probe
  if (trackedPath !== null) {
    // Nothing to inject means nothing to leak — leave the committed file alone
    // and take no reference, rather than failing a run over a file the platform
    // has no business rewriting.
    if (Object.keys(managedServers).length === 0) {
      logger.debug(
        { filePath, trackedPath },
        'Skipping MCP sync: the repository tracks this config and there is nothing to inject',
      )
      return false
    }
    throw new TrackedMcpConfigError(relativePath, trackedPath)
  }

  // The target is untracked, so this write overwrites nothing committed — but
  // "untracked" is only half the guarantee. `git add -A` stages an untracked
  // file too, so the exclusion is verified at the path the bytes actually land
  // on (which a symlink can move into another directory, or another
  // repository), and the write is refused when it cannot be guaranteed.
  const markerRelativePath = `${relativePath}${MCP_MANAGED_MARKER_SUFFIX}`
  const markerProbe = await probeMcpConfigTarget(workDir, markerRelativePath)
  await ensureWriteTargetExcluded(probe, relativePath, filePath)
  // The marker holds a fingerprint of every managed entry — headers and env
  // included — so it carries the same credentials as the config beside it.
  await ensureWriteTargetExcluded(
    markerProbe,
    markerRelativePath,
    `${filePath}${MCP_MANAGED_MARKER_SUFFIX}`,
  )

  await mkdir(dirname(filePath), { recursive: true })
  // A symlinked config can land the bytes in a directory that does not exist yet.
  await mkdir(dirname(resolvedPath), { recursive: true })
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

  // Severs any hardlink twin before writing, so the bytes cannot reach a tracked
  // file sharing this inode under an unrelated pathname.
  await detachHardLinkedTarget(resolvedPath)
  await detachHardLinkedTarget(markerProbe.resolvedPath)
  await writeFile(filePath, JSON.stringify(nextConfig, null, 2))
  try {
    await writeManagedMarkerAsync(markerPath, nextManagedMarker)
  } catch (err) {
    // The marker is what run-end cleanup reads to know this file is deletable.
    // Without it the sync reports failure, the run registers no cleanup, and the
    // bearer tokens just written stay on disk with nothing left owning them —
    // so the config goes back the way it was found.
    if (fileExistedBeforeSync) {
      await writeFile(filePath, JSON.stringify(existingConfig, null, 2))
    } else {
      await rm(resolvedPath, { force: true })
    }
    throw err
  }
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

  // The sync wrote through whatever indirection the configured path carries, so
  // cleanup has to follow it too: `rm` on a symlink unlinks the link and leaves
  // the plaintext bearer token the sync created sitting behind it for the life
  // of the worktree.
  const targetPath = await resolveWriteTarget(filePath)
  const markerPath = await resolveWriteTarget(`${filePath}${MCP_MANAGED_MARKER_SUFFIX}`)
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
    const { record: config } = await readJsonRecordAsync(targetPath)
    const serversRaw = config.mcpServers
    const servers = isRecord(serversRaw) ? { ...serversRaw } : {}
    for (const [name, fingerprint] of Object.entries(marker.managedServers)) {
      if (!(name in servers)) continue
      if (stableStringify(servers[name]) === fingerprint) delete servers[name]
    }

    const onlyOurContent =
      Object.keys(servers).length === 0 && Object.keys(config).every((key) => key === 'mcpServers')
    if (marker.createdByPlatform && onlyOurContent) {
      await rm(targetPath, { force: true })
    } else {
      await writeFile(targetPath, JSON.stringify({ ...config, mcpServers: servers }, null, 2))
    }
    await rm(markerPath, { force: true })
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to clean up managed MCP config after the run')
  }
}
