import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { GitConfig } from '@a2wave/shared'
import { logger } from './logger.js'
import { redactRepoUrlCredential } from './scm-secret-mask.js'

const execFileAsync = promisify(execFile)

/** 执行超时：5 分钟 */
const EXEC_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 统一凭据脱敏：清除 HTTPS URL 中嵌入的 username:password@
 * 用于所有日志输出和错误消息，防止凭据泄露
 */
export function sanitizeCredentials(text: string): string {
  return text
    .replace(/\bhttps?:\/\/[^@\s]*@/g, (match) => match.replace(/\/\/[^@\s]*@/, '//***@'))
    .replace(/([?&](?:access_token|token)=)[^&\s]+/gi, '$1***')
    .replace(/\b(P4PASSWD|P4PASSWD=|p4passwd|p4passwd=)([^\s&]+)/gi, (match, key) =>
      key.endsWith('=') ? `${key}***` : `${key}=***`,
    )
}

// ============================================================
// 构建带认证的 Git URL
// ============================================================

function buildAuthUrlFromParts(repoUrl: string, username?: string, pat?: string): string {
  if (!repoUrl.startsWith('https://')) return repoUrl
  if (!username && !pat) return repoUrl

  try {
    const url = new URL(repoUrl)
    if (username) url.username = username
    if (pat) url.password = pat
    return url.toString()
  } catch {
    return repoUrl
  }
}

/**
 * 将 username/pat 嵌入 HTTPS URL 用于 clone/fetch 认证。
 * 对非 HTTPS URL（如 git:// 或 ssh）原样返回。
 */
export function buildAuthUrl(config: GitConfig): string {
  return buildAuthUrlFromParts(config.repoUrl, config.username, config.pat)
}

// ============================================================
// 连接检测
// ============================================================

/**
 * Outcome for one repository inside a check. `directory` is '' for the
 * single-repo shape, which has no per-repo directory.
 *
 * `repoUrl` is echoed back **redacted** — a probe may be run against a URL with
 * inline `user:token@` userinfo, and this result is rendered client-side.
 */
export interface GitRepoCheckResult {
  directory: string
  repoUrl: string
  ok: boolean
  message: string
}

export interface GitCheckResult {
  ok: boolean
  message: string
  defaultBranch?: string
  /**
   * Per-repository breakdown, always populated (one entry in the single-repo
   * shape). The aggregate `message` only counts passes/failures, so this is what
   * lets a caller show *why* a specific repo failed.
   */
  repos?: GitRepoCheckResult[]
}

async function checkSingleRepoConnection(
  repoUrl: string,
  branch: string,
  username?: string,
  pat?: string,
): Promise<GitCheckResult> {
  const authUrl = buildAuthUrlFromParts(repoUrl, username, pat)

  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', authUrl], {
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })

    const branchExists = stdout.includes(`refs/heads/${branch}`)

    if (branchExists) {
      return {
        ok: true,
        message: `Git connection is healthy, branch "${branch}" found`,
        defaultBranch: branch,
      }
    }

    const availableBranches = stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/.*refs\/heads\//, ''))
      .slice(0, 10)

    return {
      ok: true,
      message: `Connected, but branch "${branch}" not found. Available: ${availableBranches.join(', ')}`,
      defaultBranch: availableBranches[0],
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const safeMsg = sanitizeCredentials(msg)
    return { ok: false, message: `Git connection failed: ${safeMsg}` }
  }
}

/**
 * How many repo probes may be in flight at once.
 *
 * Each probe is a `git ls-remote` subprocess with a 30s timeout, and the repo
 * list arrives from a request body — an unbounded fan-out would let one request
 * hold `repos.length` subprocesses, file descriptors and outbound connections,
 * starving every other SCM operation in the same single container.
 * Small enough to stay polite to the host, large enough that a realistic
 * multi-repo source still finishes in roughly one probe's latency.
 */
export const GIT_PROBE_CONCURRENCY = 6

/**
 * Map over `items` with at most `limit` callbacks in flight, preserving input
 * order in the result. Workers pull from a shared cursor, so a slow item (an
 * unreachable host burning its full timeout) never blocks the ones behind it.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index] as T)
    }
  }
  const workerCount = Math.min(Math.max(1, limit), items.length)
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

/**
 * 检测 Git 仓库连接是否可用。
 * 单仓库模式：检测 config.repoUrl
 * 多仓库模式：逐一检测每个 repo 的连通性，返回聚合结果
 *
 * Both shapes populate `repos[]` so a caller can always render a per-repo
 * breakdown rather than parsing the aggregate message.
 */
export async function checkGitConnection(config: GitConfig): Promise<GitCheckResult> {
  if (!config.repos?.length) {
    const result = await checkSingleRepoConnection(
      config.repoUrl,
      config.branch || 'main',
      config.username,
      config.pat,
    )
    return {
      ...result,
      repos: [
        {
          directory: '',
          repoUrl: redactRepoUrlCredential(config.repoUrl),
          ok: result.ok,
          message: result.message,
        },
      ],
    }
  }

  // Probe concurrently: repos are independent, and a serial loop makes the
  // 30s-per-repo timeout additive — a 10-repo source with one unreachable host
  // would otherwise keep the request open far longer than any client waits.
  // Bounded, because `repos` reaches here straight from a request body and each
  // entry is a subprocess plus an outbound dial (see GIT_PROBE_CONCURRENCY).
  const repos: GitRepoCheckResult[] = await mapWithConcurrency(
    config.repos,
    GIT_PROBE_CONCURRENCY,
    async (repo) => {
      const result = await checkSingleRepoConnection(
        repo.repoUrl,
        repo.branch || 'main',
        config.username,
        config.pat,
      )
      return {
        directory: repo.directory,
        repoUrl: redactRepoUrlCredential(repo.repoUrl),
        ok: result.ok,
        message: result.message,
      }
    },
  )

  const total = repos.length
  const passed = repos.filter((r) => r.ok).length
  const failed = repos.filter((r) => !r.ok).map((r) => r.directory)

  if (passed === total) {
    return { ok: true, message: `${passed}/${total} repos connected`, repos }
  }

  return {
    ok: false,
    message: `${passed}/${total} repos connected, failed: ${failed.join(', ')}`,
    repos,
  }
}

// ============================================================
// 同步执行
// ============================================================

export interface GitSyncResult {
  ok: boolean
  message: string
  filesUpdated?: number
}

/**
 * Marks an error as having come from our own filesystem call rather than from a
 * git subprocess. `spawn git ENOENT` and a genuinely missing directory share an
 * errno, so the source is the only thing that tells them apart.
 */
const FS_ERROR = Symbol('a2wave.fsError')

/**
 * Recognise a failure of the *checkout root* rather than of the repository.
 *
 * A non-writable or unmounted local path is an infrastructure problem — a
 * missing volume mount, a read-only filesystem, wrong ownership — and no amount
 * of editing the repo URL or credentials will fix it. Left as raw git output
 * ("could not create leading directories of …") it reads like a config typo and
 * sends people to the wrong field, so name the real cause instead.
 *
 * Deliberately narrow. A bare errno or a loose text match cannot tell a
 * filesystem failure from a network one, and two realistic git failures look
 * exactly like one:
 *   - `spawn git ENOENT` — the git binary is missing, errno ENOENT, nothing to
 *     do with the local path.
 *   - `git@host: Permission denied (publickey)` — an SSH *credential* failure
 *     whose text says "permission denied".
 * Mislabelling either as "your volume is not mounted" is worse than the raw
 * message it replaces. So a filesystem errno only counts when it came from our
 * own mkdir (`fsError`), and text only counts when git names the local path
 * alongside the complaint.
 */
function describeCheckoutRootFailure(
  error: unknown,
  localPath: string,
  fsError: boolean,
): string | null {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code
  const text = [
    (error as { stderr?: string } | undefined)?.stderr,
    error instanceof Error ? error.message : '',
  ]
    .filter(Boolean)
    .join('\n')

  // git's own wording for "I could not build the destination directory". It
  // always quotes the path, which is what separates it from a remote-side error.
  const gitPathFailure = /could not create leading directories|unable to mkdir/i.test(text)

  const permissionDenied = fsError && (errno === 'EACCES' || errno === 'EPERM')
  const readOnly = (fsError && errno === 'EROFS') || /read-only file system/i.test(text)
  const notADirectory = fsError && (errno === 'ENOTDIR' || errno === 'EEXIST')
  const cannotCreate = (fsError && errno === 'ENOENT') || gitPathFailure

  if (!permissionDenied && !readOnly && !notADirectory && !cannotCreate) return null

  const reason = readOnly
    ? 'the filesystem is read-only'
    : permissionDenied
      ? 'permission was denied'
      : notADirectory
        ? 'part of the path exists but is not a directory'
        : 'it could not be created'
  return `Local path "${localPath}" is not usable — ${reason}. This is a storage problem rather than a repository one: check that the volume is mounted at this path and writable by the service user.`
}

async function syncSingleRepo(
  repoUrl: string,
  branch: string,
  localPath: string,
  username?: string,
  pat?: string,
  timeoutMs: number = EXEC_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<GitSyncResult> {
  const authUrl = buildAuthUrlFromParts(repoUrl, username, pat)
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const isGitRepo = existsSync(join(localPath, '.git'))

  try {
    if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
      throw new Error(`Invalid branch name: ${branch}`)
    }
    if (!isGitRepo) {
      logger.info({ localPath, branch }, 'Cloning git repository')
      // Create the checkout root up front, like P4 sync and the multi-repo path
      // already do. `git clone` would build the parent chain itself, so this is
      // not what makes a clone succeed — it exists so a non-writable checkout
      // root fails here, as a plain EACCES/EROFS we can classify, instead of
      // surfacing as git's "could not create leading directories" wording.
      try {
        await mkdir(dirname(localPath), { recursive: true })
      } catch (error) {
        // Tagged as a filesystem error so the classifier can trust the errno —
        // an identical errno off a git subprocess means something else entirely.
        throw Object.assign(error as Error, { [FS_ERROR]: true })
      }
      const { stdout, stderr } = await execFileAsync(
        'git',
        ['clone', '--branch', branch, '--single-branch', authUrl, localPath],
        { timeout: timeoutMs, env: gitEnv, signal },
      )
      const output = stdout + stderr
      const safeOutput = sanitizeCredentials(output)
      logger.info({ localPath }, 'Git clone completed')
      return { ok: true, message: `Cloned successfully. ${safeOutput.trim()}` }
    }

    logger.info({ localPath, branch }, 'Fetching git updates')

    await execFileAsync('git', ['remote', 'set-url', 'origin', authUrl], {
      cwd: localPath,
      timeout: 15_000,
      env: gitEnv,
      signal,
    })

    // 显式 refspec 抓取目标分支并写入 refs/remotes/origin/<branch>。
    // 首次 clone 使用了 --single-branch，remote.origin.fetch 会被锁死为
    // 最初那一个分支；若之后在数据源配置里切换分支，裸 `git fetch origin`
    // 不会创建新的 origin/<branch>，后续 `git reset --hard origin/<branch>`
    // 就会报 "unknown revision"。显式 refspec 与 --single-branch 无关，
    // 任何情况下都能把目标分支更新到 refs/remotes/origin/<branch>。
    await execFileAsync(
      'git',
      ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      {
        cwd: localPath,
        timeout: timeoutMs,
        env: gitEnv,
        signal,
      },
    )

    const { stdout: oldHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: localPath,
      env: gitEnv,
      signal,
    })

    // 用 `checkout -f -B` 而不是 `reset --hard`：后者只会把当前本地分支指针
    // 挪到 origin/<branch>，HEAD 还停留在旧分支上（如原来的 main），导致
    // agent 读 `git branch --show-current` 得到错误分支名。
    // `-B` 创建或重置本地分支 <branch> 指向 origin/<branch> 并切换 HEAD；
    // `-f` 放弃本地未提交改动，保留原 `--hard` 的「对齐远端」语义。
    await execFileAsync('git', ['checkout', '-f', '-B', branch, `origin/${branch}`], {
      cwd: localPath,
      timeout: 60_000,
      env: gitEnv,
      signal,
    })

    const { stdout: newHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: localPath,
      env: gitEnv,
      signal,
    })

    const oldHash = oldHead.trim()
    const newHash = newHead.trim()

    if (oldHash === newHash) {
      return { ok: true, message: 'Already up-to-date', filesUpdated: 0 }
    }

    try {
      const { stdout: diffStat } = await execFileAsync(
        'git',
        ['diff', '--stat', oldHash, newHash],
        { cwd: localPath, env: gitEnv, signal },
      )
      const fileMatches = diffStat.match(/(\d+) files? changed/)
      const filesUpdated = fileMatches ? Number.parseInt(fileMatches[1], 10) : 0
      return {
        ok: true,
        message: `Synced ${filesUpdated} files (${oldHash.slice(0, 7)}..${newHash.slice(0, 7)})`,
        filesUpdated,
      }
    } catch {
      return {
        ok: true,
        message: `Synced to ${newHash.slice(0, 7)}`,
        filesUpdated: 0,
      }
    }
  } catch (error) {
    // Checked before the generic formatting below: an unusable checkout root
    // has a specific, actionable cause that the raw git text obscures.
    const rootFailure = describeCheckoutRootFailure(
      error,
      localPath,
      (error as Record<symbol, boolean> | null)?.[FS_ERROR] === true,
    )
    if (rootFailure) {
      logger.error({ localPath }, 'Git checkout root is not writable')
      return { ok: false, message: `Git sync failed: ${rootFailure}` }
    }

    // A filesystem error carries an errno but no stderr/stdout, so the generic
    // formatting below would reduce it to a bare "exit code ENOTDIR" and drop
    // the message naming the offending path. Keep the message for any fs errno
    // the classifier above did not already phrase.
    if ((error as Record<symbol, boolean> | null)?.[FS_ERROR] === true) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `Git sync failed: ${sanitizeCredentials(message)}` }
    }

    const execErr = error as Error & {
      stderr?: string
      stdout?: string
      code?: string
      killed?: boolean
    }
    const parts: string[] = []

    if (execErr.killed || execErr.code === 'ETIMEDOUT') {
      parts.push('timed out')
    } else if (execErr.code !== undefined) {
      parts.push(`exit code ${execErr.code}`)
    }

    const stderr = execErr.stderr?.trim()
    const stdout = execErr.stdout?.trim()
    if (stderr) parts.push(sanitizeCredentials(stderr))
    else if (stdout) parts.push(sanitizeCredentials(stdout))
    else if (parts.length === 0) {
      const msg = error instanceof Error ? error.message : String(error)
      parts.push(sanitizeCredentials(msg))
    }

    return { ok: false, message: `Git sync failed: ${parts.join(' — ')}` }
  }
}

function aggregateSyncResults(
  results: Array<{ directory: string; result: GitSyncResult }>,
): GitSyncResult {
  const failed = results.filter((r) => !r.result.ok)
  const totalFiles = results.reduce((sum, r) => sum + (r.result.filesUpdated ?? 0), 0)

  if (failed.length === 0) {
    return {
      ok: true,
      message: `${results.length}/${results.length} repos synced, ${totalFiles} files updated`,
      filesUpdated: totalFiles,
    }
  }

  const failedDirs = failed.map((r) => r.directory)
  const passed = results.length - failed.length
  return {
    ok: false,
    message: `${passed}/${results.length} repos synced, failed: ${failedDirs.join(', ')}`,
    filesUpdated: totalFiles,
  }
}

function detectModeConflict(localPath: string, isMultiRepo: boolean): string | null {
  const hasRootGit = existsSync(join(localPath, '.git'))

  if (isMultiRepo && hasRootGit) {
    return `Mode conflict: localPath "${localPath}" contains a .git directory from single-repo mode. Please remove it or use a different path before syncing in multi-repo mode.`
  }

  return null
}

async function findOrphanDirectories(localPath: string, expectedDirs: string[]): Promise<string[]> {
  try {
    const entries = await readdir(localPath, { withFileTypes: true })
    const expected = new Set(expectedDirs)
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !expected.has(e.name))
      .filter((e) => existsSync(join(localPath, e.name, '.git')))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * 执行 Git 同步（clone 或 fetch+reset）。
 * 单仓库模式：直接 clone/fetch 到 localPath
 * 多仓库模式：遍历 repos，每个 clone/fetch 到 localPath/<directory>/
 */
export async function executeGitSync(
  config: GitConfig,
  localPath: string,
  timeoutMs: number = EXEC_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<GitSyncResult> {
  const isMultiRepo = Boolean(config.repos?.length)

  const conflict = detectModeConflict(localPath, isMultiRepo)
  if (conflict) {
    return { ok: false, message: conflict }
  }

  if (!isMultiRepo) {
    return syncSingleRepo(
      config.repoUrl,
      config.branch || 'main',
      localPath,
      config.username,
      config.pat,
      timeoutMs,
      signal,
    )
  }

  await mkdir(localPath, { recursive: true })

  const repos = config.repos ?? []
  const results: Array<{ directory: string; result: GitSyncResult }> = []
  for (const repo of repos) {
    const subPath = join(localPath, repo.directory)
    const result = await syncSingleRepo(
      repo.repoUrl,
      repo.branch || 'main',
      subPath,
      config.username,
      config.pat,
      timeoutMs,
      signal,
    )
    results.push({ directory: repo.directory, result })
  }

  const syncResult = aggregateSyncResults(results)

  const orphans = await findOrphanDirectories(
    localPath,
    repos.map((r) => r.directory),
  )
  if (orphans.length > 0) {
    logger.warn({ localPath, orphans }, 'Orphan repo directories detected')
    syncResult.message += `. Warning: orphan directories found: ${orphans.join(', ')}`
  }

  return syncResult
}
