import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { GitConfig, WorktreeCleanup } from '@a2wave/shared'
import { withKeyedLock } from './keyed-mutex.js'
import { logger } from './logger.js'
import { defaultScmWorkspacesPath } from './scm-storage.js'
import { platformWorkspaceEntries, platformWorkspacePaths } from './workspace-platform-entries.js'

const execFileAsyncRaw = promisify(execFile)

const GIT_TIMEOUT_MS = 60_000

/**
 * 统一的 git exec 环境变量：
 * - `LC_ALL=C`：强制 git 输出英文，保证我们在 stderr 上 regex 匹配（例如
 *   `rethrowIfBranchLocked` 里对 "already checked out at '...'" 的解析）能稳定命中。
 *   宿主机 locale 为 zh_CN.UTF-8 时 git 会输出 "已经检出到 '...'"，regex 失配导致
 *   WorktreeBranchLockedError 不会抛，外层降级成 500 而不是 409。
 * - `GIT_TERMINAL_PROMPT=0`：禁用 git 交互式密码提示，避免挂住。
 */
const GIT_ENV = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }

/**
 * execFile 的 git 专用 wrapper：自动注入 GIT_ENV。
 * 任何 env 覆盖都走 `opts.env`（本文件暂无此用法），默认走 GIT_ENV。
 */
type ExecOpts = Parameters<typeof execFileAsyncRaw>[2]
const execFileAsync: typeof execFileAsyncRaw = ((
  file: string,
  args?: readonly string[],
  options?: ExecOpts,
) => execFileAsyncRaw(file, args, { env: GIT_ENV, ...(options ?? {}) })) as typeof execFileAsyncRaw

export const WORKTREE_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/

// ============================================================
// Workspace state file (~/.a2wave-workspace.json inside each workspace)
// - 内容：cleanup mode + 可选 lastRunId
// - mtime：lastActivityAt（写入时自动更新）
// - last-run-wins：每次 run 覆盖写
// ============================================================

export const WORKSPACE_STATE_FILE = '.a2wave-workspace.json'
const WORKSPACE_STATE_TEMP_FILE_PATTERN = /^\.a2wave-workspace\.json\.[0-9a-f]{8}\.tmp$/
const WORKSPACE_ARTIFACTS_DIRECTORY = 'artifacts'

export interface WorkspaceState {
  cleanup: WorktreeCleanup
  lastRunId?: string | null
}

/**
 * 原子写状态文件：写 .tmp 再 rename，rename 在 POSIX 上原子。
 * 并发场景下最后一个 rename 胜出——天然匹配 last-run-wins 语义。
 */
export async function writeWorkspaceState(wsPath: string, state: WorkspaceState): Promise<void> {
  const target = join(wsPath, WORKSPACE_STATE_FILE)
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(state), 'utf8')
  await rename(tmp, target)
}

export interface ReadWorkspaceStateResult {
  state: WorkspaceState | null
  lastActivityAt: number | null // ms timestamp, state 文件 mtime
}

export async function readWorkspaceState(wsPath: string): Promise<ReadWorkspaceStateResult> {
  const target = join(wsPath, WORKSPACE_STATE_FILE)
  try {
    const [raw, st] = await Promise.all([readFile(target, 'utf8'), stat(target)])
    const parsed = JSON.parse(raw) as WorkspaceState
    return { state: parsed, lastActivityAt: st.mtimeMs }
  } catch {
    return { state: null, lastActivityAt: null }
  }
}

export class WorktreeBranchLockedError extends Error {
  constructor(
    public readonly branch: string,
    public readonly lockedBy: string,
  ) {
    super(`Branch '${branch}' is already checked out in worktree '${lockedBy}'`)
    this.name = 'WorktreeBranchLockedError'
  }
}

export class WorktreeDirtyError extends Error {
  constructor(
    public readonly wsPath: string,
    public readonly directory?: string,
  ) {
    super(
      directory
        ? `Workspace '${wsPath}' sub-repo '${directory}' has uncommitted changes; cannot switch branch`
        : `Workspace '${wsPath}' has uncommitted changes; cannot switch branch`,
    )
    this.name = 'WorktreeDirtyError'
  }
}

// ============================================================
// Default workspaces path
// ============================================================

/**
 * Default workspacesPath: SCM_STORAGE_ROOT/workspaces/<sourceIdSuffix>
 *
 * Keep the complete random suffix after the first underscore (drop `scm_`).
 * Use slice rather than split('_').pop(): createId's base64url alphabet
 * includes underscores, so pop would discard entropy and could make wsRoot
 * collide across sources.
 */
export function idSuffix(id: string): string {
  const underscoreIdx = id.indexOf('_')
  const suffix = underscoreIdx >= 0 ? id.slice(underscoreIdx + 1) : id
  return suffix || id
}

/**
 * Managed storage decides this, with one exception: a source whose legacy
 * `~/.a2wave/workspaces/<suffix>` directory still exists keeps it, so an
 * upgrade never strands worktrees the previous release created.
 */
export function defaultWorkspacesPath(
  sourceId: string,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const legacyPath = join(homedir(), '.a2wave', 'workspaces', idSuffix(sourceId))
  return pathExists(legacyPath) ? legacyPath : defaultScmWorkspacesPath(sourceId)
}

/**
 * Workspace name of an Agent's own long-lived worktree. Callers compare against
 * this exact value rather than an `agent-` prefix test: a workspace explicitly
 * named e.g. `agent-refactor` predates the reservation and must keep the
 * ordinary explicit-worktree semantics (its branch is disposable).
 */
export function perAgentWorkspaceName(agentId: string): string {
  return `agent-${idSuffix(agentId)}`
}

/**
 * Whether a workspace name looks like a per-Agent worktree. Used only where the
 * Agent id is not available (the TTL sweeper walks the filesystem); call sites
 * that know the Agent compare against `perAgentWorkspaceName` exactly, because
 * a legacy explicit workspace such as `agent-refactor` is NOT one of these.
 */
export function isPerAgentWorkspaceName(name: string): boolean {
  // `createId` is randomBytes(12).toString('base64url') — EXACTLY 16 base64url
  // chars. Matching `{16,}` instead let a legacy hand-typed workspace such as
  // `agent-payments-refactor` (17) read as per-agent, which leaks its branch on
  // every removal. Anchored at 16, only a hand-typed name of exactly that
  // length still collides.
  return /^agent-[A-Za-z0-9_-]{16}$/.test(name)
}

// ============================================================
// Create workspace
// ============================================================

/**
 * 创建 git workspace（支持单仓库和多仓库）。
 *
 * 单仓库：git worktree add <wsRoot>/<name> [--detach | <branch> | -b <branch>]
 * 多仓库：对每个子 repo 分别创建 worktree，保持目录结构。
 *
 * 如果目录已存在则跳过（幂等）。
 *
 * @returns `{ path, created }` — created=false 表示复用已有 worktree
 */
/**
 * One mutex key per worktree path: creation and removal of the same worktree
 * must never interleave in this process. Cross-replica, Git's own admin lock
 * files on the shared volume arbitrate the raw operations, and the durable
 * workload lease (written before any creation) is what a removal's
 * `beforeRemove` re-check observes.
 */
export function workspaceMutexKey(wsRoot: string, name: string): string {
  return `scm-worktree:${join(wsRoot, name)}`
}

export async function createGitWorkspace(
  localPath: string,
  wsRoot: string,
  name: string,
  config: GitConfig,
  options?: { branch?: string; followSource?: boolean; advance?: boolean },
): Promise<{ path: string; created: boolean }> {
  return withKeyedLock(workspaceMutexKey(wsRoot, name), () =>
    createGitWorkspaceUnlocked(localPath, wsRoot, name, config, options),
  )
}

async function createGitWorkspaceUnlocked(
  localPath: string,
  wsRoot: string,
  name: string,
  config: GitConfig,
  options?: { branch?: string; followSource?: boolean; advance?: boolean },
): Promise<{ path: string; created: boolean }> {
  const wsPath = join(wsRoot, name)

  if (existsSync(wsPath)) {
    // 多仓库模式下校验所有 sub-repo 子目录都存在；任一缺失则视为残缺，
    // 强制清理后走 fresh create（防止上次 create 回滚失败留下的半成品被复用）。
    const reuseRepos = config.repos?.length ? config.repos : null
    const incompleteRepos = reuseRepos
      ? reuseRepos.filter((r) => !existsSync(join(wsPath, r.directory))).map((r) => r.directory)
      : []

    if (incompleteRepos.length > 0) {
      logger.warn(
        { wsPath, incompleteRepos },
        'Workspace is incomplete (missing sub-repo dirs), rebuilding',
      )
      // Unlocked variant: this call site already holds the workspace mutex.
      //
      // followSource branches are long-lived and may carry unmerged agent
      // commits — a rebuild must never destroy them; the fresh create below
      // re-attaches them via buildFollowSourceAddArgs. The name test covers the
      // other caller: a legacy sticky config reaches a per-agent worktree
      // through the explicit path, which never sets followSource.
      await removeGitWorkspaceUnlocked(localPath, wsRoot, name, config, {
        keepBranches: Boolean(options?.followSource) || isPerAgentWorkspaceName(name),
      })
      // fall through to fresh create below
    } else {
      logger.info({ wsPath }, 'Workspace already exists, reusing')
      if (options?.followSource && !options?.branch) {
        // advance === false: a sibling run of the same agent is executing in
        // this workspace right now — reset --hard is not a read-only share, so
        // freshness waits for the next solo run.
        if (options.advance !== false) {
          await followSourceHeadOnReuse(wsPath, localPath, config, name)
        }
      } else {
        await switchBranchOnReuse(wsPath, localPath, config, options?.branch)
      }
      return { path: wsPath, created: false }
    }
  }

  await mkdir(wsRoot, { recursive: true })

  const multiRepos = config.repos?.length ? config.repos : null

  if (multiRepos) {
    await mkdir(wsPath, { recursive: true })
    const errors: string[] = []
    let lockedError: WorktreeBranchLockedError | undefined

    for (const repo of multiRepos) {
      const repoLocalPath = join(localPath, repo.directory)
      const repoWsPath = join(wsPath, repo.directory)

      try {
        const args =
          options?.followSource && !options?.branch
            ? await buildFollowSourceAddArgs(repoWsPath, repoLocalPath, name, repo.branch || 'main')
            : await buildWorktreeAddArgs(
                repoWsPath,
                repoLocalPath,
                options?.branch,
                repo.branch || 'main',
              )
        await execFileAsync('git', args, { cwd: repoLocalPath, timeout: GIT_TIMEOUT_MS })
        logger.info({ repoWsPath, directory: repo.directory }, 'Created workspace for sub-repo')
      } catch (err) {
        try {
          // followSource attaches the workspace's own branch, so a lock on it
          // must surface as a typed error, not a generic create failure.
          rethrowIfBranchLocked(err, options?.branch ?? (options?.followSource ? name : undefined))
        } catch (lockErr) {
          if (lockErr instanceof WorktreeBranchLockedError) {
            lockedError = lockErr
            break
          }
          throw lockErr
        }
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${repo.directory}: ${msg}`)
        logger.error({ err, directory: repo.directory }, 'Failed to create workspace for sub-repo')
      }
    }

    if (lockedError || errors.length > 0) {
      // 回滚已创建的 worktree。keepBranches follows the same two-sided rule as
      // the rebuild above: a per-agent branch may hold unpushed commits from an
      // earlier run, and the explicit path that a legacy sticky config takes
      // never sets followSource.
      try {
        // Unlocked variant: this call site already holds the workspace mutex.
        await removeGitWorkspaceUnlocked(localPath, wsRoot, name, config, {
          keepBranches: Boolean(options?.followSource) || isPerAgentWorkspaceName(name),
        })
      } catch (rollbackErr) {
        // If the first `git worktree add` failed, there is no Git registration
        // to prove. The parent directory was created by this invocation and is
        // still empty, so remove that exact directory with `rmdir`. Unlike a
        // recursive fallback, this fails closed if anything was placed inside.
        try {
          await rmdir(wsPath)
        } catch (emptyDirRemovalErr) {
          logger.error(
            { err: rollbackErr, emptyDirRemovalErr, wsPath },
            'Rollback after failed multi-repo create also failed — workspace may be left in incomplete state',
          )
        }
      }
      if (lockedError) throw lockedError
      throw new Error(`Failed to create workspace for repos: ${errors.join('; ')}`)
    }
  } else {
    try {
      const args =
        options?.followSource && !options?.branch
          ? await buildFollowSourceAddArgs(wsPath, localPath, name, config.branch || 'main')
          : await buildWorktreeAddArgs(wsPath, localPath, options?.branch, config.branch || 'main')
      await execFileAsync('git', args, { cwd: localPath, timeout: GIT_TIMEOUT_MS })
      logger.info({ wsPath }, 'Created workspace')
    } catch (err) {
      rethrowIfBranchLocked(err, options?.branch ?? (options?.followSource ? name : undefined))
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to create workspace: ${msg}`)
    }
  }

  return { path: wsPath, created: true }
}

type BranchResolution = 'local' | 'remote' | 'new'

/**
 * 判断 `<branch>` 在 checkout 时应当走哪条路径：
 *   - 'local'  → 本地已有同名分支，直接 `checkout <branch>`
 *   - 'remote' → 仅在 origin 可见（本地或按需 fetch 到了 refs/remotes/origin/<branch>），
 *                需要显式 `origin/<branch>` 建立本地追踪分支
 *   - 'new'    → origin 上也不存在，属于新建分支场景
 *
 * 关键：git-sync.ts 首次克隆用了 `--single-branch`，`.git/config` 的 fetch refspec
 * 被锁成 `+refs/heads/<X>:refs/remotes/origin/<X>`，裸 `git fetch origin` 不会同步
 * 别的分支的 ref。这里在找不到 `refs/remotes/origin/<B>` 时显式 `fetch origin
 * <B>:refs/remotes/origin/<B>`，把该 ref 拉下来再返回 'remote'。否则旧实现会静默
 * 走 `-b` 从当前 HEAD 凭空开一条空分支，内容不是远端 branch 的真实提交。
 */
/**
 * 解析"新分支"场景下的 base ref —— 新分支永远应从**配置的 baseBranch** 分叉，
 * 而不是 local repo 当前的 HEAD（HEAD 可能是上一次 run 留下的任意分支）。
 *
 * 优先 `origin/<baseBranch>`（按需触发显式 refspec fetch，兼容 --single-branch 克隆）；
 * 若 remote 真的拿不到（离线 / 本地 init 的裸仓），退回本地 `<baseBranch>` ref。
 * 两者都没有 → 抛错，不允许悄悄从 HEAD 兜底。
 */
async function resolveBaseRef(localRepoPath: string, baseBranch: string): Promise<string> {
  const res = await resolveBranchForCheckout(localRepoPath, baseBranch)
  if (res === 'remote') return `origin/${baseBranch}`
  if (res === 'local') return baseBranch
  throw new Error(
    `Configured base branch '${baseBranch}' not found locally or on origin — refusing to create new branch from arbitrary HEAD`,
  )
}

async function resolveBranchForCheckout(
  localRepoPath: string,
  branch: string,
): Promise<BranchResolution> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', branch], {
      cwd: localRepoPath,
      timeout: 5_000,
    })
    return 'local'
  } catch {
    /* not local */
  }

  try {
    await execFileAsync('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
      cwd: localRepoPath,
      timeout: 5_000,
    })
    return 'remote'
  } catch {
    /* may be single-branch lockout — try explicit refspec fetch */
  }

  // 用 `ls-remote --exit-code` 明确区分「远端没有该分支」(exit 2) 与「网络/鉴权失败」(其他非零)。
  // 依赖 stderr 文案是不可靠的（locale / git 版本会变），exit code 是 git 的稳定契约。
  try {
    await execFileAsync('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], {
      cwd: localRepoPath,
      timeout: GIT_TIMEOUT_MS,
    })
  } catch (err) {
    const code = (err as { code?: number | string } | null)?.code
    if (code === 2) {
      logger.debug({ localRepoPath, branch }, 'Remote branch not found — treating as new branch')
      return 'new'
    }
    // 网络 / 鉴权 / 超时等——不要静默降级为 new，否则会在 base 上新建同名分支覆盖远端历史
    logger.warn(
      { err, localRepoPath, branch },
      'ls-remote failed for non-missing-ref reason — failing run',
    )
    throw err
  }

  // 远端确实有该分支，fetch 到本地
  await execFileAsync(
    'git',
    ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { cwd: localRepoPath, timeout: GIT_TIMEOUT_MS },
  )
  logger.info(
    { localRepoPath, branch },
    'Fetched missing remote branch ref (single-branch clone recovery)',
  )
  return 'remote'
}

/**
 * 扫描 `git worktree list --porcelain`，找出哪个 worktree（不是 `selfPath`）正持有
 * 目标 branch。没有的话返回 null。
 *
 * porcelain 输出每条 worktree 块如：
 *   worktree /path/to/wt
 *   HEAD <sha>
 *   branch refs/heads/<name>   （detached 时是 `detached`）
 */
async function findBranchLockHolder(
  cwd: string,
  branch: string,
  selfPath: string,
): Promise<string | null> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd,
    timeout: 5_000,
  })
  const blocks = stdout.split(/\n\n+/)
  for (const block of blocks) {
    let wtPath: string | null = null
    let wtBranch: string | null = null
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim()
        wtBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      }
    }
    if (wtBranch === branch && wtPath && wtPath !== selfPath) {
      return wtPath
    }
  }
  return null
}

/**
 * 复用 workspace 时根据 options.branch 切换分支：
 * - 无 branch：保持不动（允许 detached 或任意分支）
 * - branch 等于当前分支：no-op
 * - branch 不同：
 *    - 任一 sub-repo 脏 → WorktreeDirtyError
 *    - 目标 branch 被其他 worktree 独占 → WorktreeBranchLockedError
 *    - 否则执行 git checkout <branch>
 *
 * 多 repo 先 pre-validate（收集脏/锁状态）再统一切换，以保证原子性：
 * 任何 sub-repo 不满足条件时不触碰任何 sub-repo。
 */
/** True when refs/heads/<name> exists. Any git failure reads as "missing". */
async function localBranchExists(cwd: string, name: string): Promise<boolean> {
  return execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
    cwd,
    timeout: 5_000,
  })
    .then(() => true)
    .catch(() => false)
}

/**
 * True when `ref` is an ancestor of `target` — advancing from ref to target is
 * then a fast-forward that cannot orphan any commit. Any git failure reads as
 * "not an ancestor": the caller pins the workspace, which is the safe side.
 */
async function isAncestor(cwd: string, ref: string, target: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ref, target], {
      cwd,
      timeout: 5_000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Advance a followSource workspace to the source checkout's current commit.
 *
 * The workspace lives on its own branch (named after the workspace), so agent
 * commits land on a real branch and `git branch --show-current` answers — the
 * contract git-sync keeps for the shared checkout. Freshness is best-effort; a
 * stale checkout is strictly better than a failed run or a lost commit, so
 * every skip path degrades to "keep the previous commit":
 * - sub-repo sits on a different named branch (someone switched it
 *   deliberately) → keep it
 * - sub-repo has tracked modifications → keep it (untracked files never block:
 *   the platform itself mounts skills/config as untracked content)
 * - HEAD is not an ancestor of the source HEAD (the agent committed work that
 *   is not merged yet) → keep it; once those commits reach the source branch
 *   the guard passes again and the workspace follows the source once more
 * - a legacy detached workspace (created before the branch strategy) is
 *   adopted onto the branch when the same guards pass
 */
/** What the advance should do to one sub-repo, decided before anything moves. */
type FollowSourcePlan =
  | { kind: 'skip'; wsRepoPath: string }
  | { kind: 'pin'; wsRepoPath: string; reason: string }
  | { kind: 'advance'; wsRepoPath: string; target: string }
  | { kind: 'adopt'; wsRepoPath: string; target: string; branchExists: boolean }

async function followSourceHeadOnReuse(
  wsPath: string,
  localPath: string,
  config: GitConfig,
  name: string,
): Promise<void> {
  const repoDirs = config.repos?.length ? config.repos.map((r) => r.directory) : ['']

  // Two passes. Deciding every sub-repo before moving any of them is what makes
  // a multi-repo advance all-or-nothing: advancing repo A while repo B pins on
  // an unmerged commit hands the agent a tree whose repos sit at commits that
  // never coexisted upstream — a mismatch nothing downstream can detect.
  // `switchBranchOnReuse` already pre-validates for the same reason.
  const plans: FollowSourcePlan[] = []
  for (const dir of repoDirs) {
    const wsRepoPath = dir ? join(wsPath, dir) : wsPath
    const localRepoPath = dir ? join(localPath, dir) : localPath

    try {
      const { stdout: onBranchRaw } = await execFileAsync(
        'git',
        ['symbolic-ref', '--short', '-q', 'HEAD'],
        { cwd: wsRepoPath, timeout: 5_000 },
      ).catch(() => ({ stdout: '' }))
      const onBranch = onBranchRaw.trim()
      if (onBranch && onBranch !== name) {
        plans.push({ kind: 'skip', wsRepoPath })
        continue
      }

      const { stdout: sourceHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: localRepoPath,
        timeout: 5_000,
      })
      const target = sourceHead.trim()
      const { stdout: wsHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: wsRepoPath,
        timeout: 5_000,
      })
      const upToDate = wsHead.trim() === target
      if (upToDate && onBranch) {
        plans.push({ kind: 'skip', wsRepoPath })
        continue
      }

      // The platform rewrites these on every run (skill/MCP mounts, artifacts),
      // so changes there are not agent work and must not pin the workspace —
      // repos that track e.g. .claude/skills would otherwise never advance.
      // reset --hard reverts them to repo state; the engine re-mounts before
      // spawning the CLI.
      //
      // Excluded at FULL DEPTH, never by root entry: a repo that tracks
      // `.claude/settings.json` or `.claude/hooks/*` (a common layout) shares a
      // root with the skill mount, and excluding `.claude` wholesale would let
      // the reset below discard those edits with no error and no log.
      const { stdout: dirty } = await execFileAsync(
        'git',
        [
          'status',
          '--porcelain',
          '-uno',
          '--',
          '.',
          `:(exclude)${WORKSPACE_ARTIFACTS_DIRECTORY}`,
          ...[...platformWorkspacePaths()].map((path) => `:(exclude)${path}`),
        ],
        { cwd: wsRepoPath, timeout: 5_000 },
      )
      if (dirty.trim()) {
        plans.push({ kind: 'pin', wsRepoPath, reason: 'tracked modifications' })
        continue
      }

      if (!upToDate && !(await isAncestor(wsRepoPath, 'HEAD', target))) {
        plans.push({ kind: 'pin', wsRepoPath, reason: 'unmerged local commits' })
        continue
      }

      if (onBranch) {
        plans.push({ kind: 'advance', wsRepoPath, target })
      } else {
        // Legacy detached workspace: adopt it onto the branch. Attach to an
        // existing branch as-is — it may carry unmerged commits, and forcing
        // it to the source HEAD would orphan them; the next reuse advances it
        // through the ancestor guard. Only a missing branch is created here.
        const branchExists = await localBranchExists(wsRepoPath, name)
        if (branchExists) {
          const { stdout: branchTip } = await execFileAsync(
            'git',
            ['rev-parse', `refs/heads/${name}`],
            { cwd: wsRepoPath, timeout: 5_000 },
          )
          if (branchTip.trim() !== wsHead.trim()) {
            // Attaching moves the working tree to the branch tip — surface it
            // like the other non-advancing paths instead of moving silently.
            logger.warn(
              { wsRepoPath, from: wsHead.trim(), to: branchTip.trim() },
              'followSource: adopting existing branch moves the workspace off its detached commit',
            )
          }
        }
        plans.push({ kind: 'adopt', wsRepoPath, target, branchExists })
      }
    } catch (err) {
      plans.push({
        kind: 'pin',
        wsRepoPath,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const pinned = plans.filter((plan) => plan.kind === 'pin')
  if (pinned.length > 0) {
    logger.warn(
      { wsPath, pinned: pinned.map((plan) => ({ repo: plan.wsRepoPath, reason: plan.reason })) },
      'followSource: workspace pinned behind source HEAD',
    )
    return
  }

  for (const plan of plans) {
    try {
      if (plan.kind === 'advance') {
        await execFileAsync('git', ['reset', '--hard', plan.target], {
          cwd: plan.wsRepoPath,
          timeout: GIT_TIMEOUT_MS,
        })
      } else if (plan.kind === 'adopt') {
        await execFileAsync(
          'git',
          plan.branchExists ? ['checkout', name] : ['checkout', '-b', name, plan.target],
          { cwd: plan.wsRepoPath, timeout: GIT_TIMEOUT_MS },
        )
      }
    } catch (err) {
      // Nothing to roll back to: `reset --hard` on an earlier repo already
      // discarded the state it would revert to. Freshness is best-effort, so a
      // partial advance is logged and the run proceeds.
      logger.warn(
        { err, wsRepoPath: plan.wsRepoPath },
        'followSource: failed to advance workspace to source HEAD, keeping previous commit',
      )
    }
  }
}

async function switchBranchOnReuse(
  wsPath: string,
  localPath: string,
  config: GitConfig,
  branch?: string,
): Promise<void> {
  if (!branch) {
    return
  }

  const repoDirs = config.repos?.length ? config.repos.map((r) => r.directory) : ['']

  // Pre-validate：所有 sub-repo 的 dirty 状态 + 目标 branch 被其它 worktree 独占的情况，
  // 都要在一次遍历里发现。如果在 checkout 阶段才发现被 locked，已经切走的 repo 会被留
  // 在一个不一致的状态里（半切成功）——必须原子拒绝。
  for (const dir of repoDirs) {
    const wsRepoPath = join(wsPath, dir)
    const localRepoPath = dir ? join(localPath, dir) : localPath

    const { stdout: current } = await execFileAsync(
      'git',
      ['symbolic-ref', '--short', '-q', 'HEAD'],
      { cwd: wsRepoPath, timeout: 5_000 },
    ).catch(() => ({ stdout: '' }))
    if (current.trim() === branch) {
      continue
    }

    const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: wsRepoPath,
      timeout: 5_000,
    })
    if (dirty.trim()) {
      throw new WorktreeDirtyError(wsPath, dir || undefined)
    }

    // 检查目标 branch 是否被任何别的 worktree 独占
    const lockedBy = await findBranchLockHolder(localRepoPath, branch, wsRepoPath)
    if (lockedBy) {
      throw new WorktreeBranchLockedError(branch, lockedBy)
    }
  }

  // Execute checkouts with rollback on failure.
  // pre-validate 只覆盖 dirty/lock 两类已知错误；checkout 阶段仍可能因权限、磁盘、
  // 未追踪文件冲突等原因失败。任何一个 sub-repo 失败 → 已切走的逐个回切到原 ref，
  // 保持多仓原子语义（不允许半切）。
  const switched: Array<{ wsRepoPath: string; original: string }> = []
  for (const dir of repoDirs) {
    const wsRepoPath = join(wsPath, dir)
    const localRepoPath = dir ? join(localPath, dir) : localPath

    // 记录原 ref：优先 branch 名，detached 时退回 commit SHA
    let original = ''
    const { stdout: currentBranch } = await execFileAsync(
      'git',
      ['symbolic-ref', '--short', '-q', 'HEAD'],
      { cwd: wsRepoPath, timeout: 5_000 },
    ).catch(() => ({ stdout: '' }))
    original = currentBranch.trim()
    if (!original) {
      const { stdout: sha } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: wsRepoPath,
        timeout: 5_000,
      }).catch(() => ({ stdout: '' }))
      original = sha.trim()
    }
    if (original === branch) {
      continue
    }

    // local / remote / new 三分支：remote 场景必须显式 `origin/<branch>`，否则 DWIM
    // 失败；new 场景以配置的 baseBranch 为分叉点（不是 HEAD）。
    const resolution = await resolveBranchForCheckout(localRepoPath, branch)
    let checkoutArgs: string[]
    if (resolution === 'local') {
      checkoutArgs = ['checkout', branch]
    } else if (resolution === 'remote') {
      checkoutArgs = ['checkout', '-B', branch, `origin/${branch}`]
    } else {
      const baseBranch = dir
        ? (config.repos?.find((r) => r.directory === dir)?.branch ?? 'main')
        : config.branch || 'main'
      const baseRef = await resolveBaseRef(localRepoPath, baseBranch)
      checkoutArgs = ['checkout', '-b', branch, baseRef]
    }
    try {
      await execFileAsync('git', checkoutArgs, { cwd: wsRepoPath, timeout: GIT_TIMEOUT_MS })
      logger.info({ wsPath, dir, branch }, 'Switched branch on reused workspace')
      if (original) switched.push({ wsRepoPath, original })
    } catch (err) {
      for (const entry of [...switched].reverse()) {
        try {
          await execFileAsync('git', ['checkout', entry.original], {
            cwd: entry.wsRepoPath,
            timeout: GIT_TIMEOUT_MS,
          })
          logger.warn(
            { wsPath, ...entry },
            'Rolled back partial branch switch after later-repo failure',
          )
        } catch (rbErr) {
          logger.error(
            { err: rbErr, wsPath, ...entry },
            'Failed to roll back partial branch switch — workspace may be in inconsistent state',
          )
        }
      }
      rethrowIfBranchLocked(err, branch)
      throw err
    }
  }
}

/**
 * 构建 git worktree add 参数：
 * - 无 branch → --detach
 * - branch 已存在（本地或远程）→ 直接 checkout（尊重本地现状，不主动 fetch）
 * - branch 不存在 → -b 新建，**以配置的 baseBranch 为分叉点**（而非当前 HEAD）
 */
async function buildWorktreeAddArgs(
  wsPath: string,
  cwd: string,
  branch: string | undefined,
  baseBranch: string,
): Promise<string[]> {
  if (!branch) {
    return ['worktree', 'add', wsPath, '--detach']
  }

  const resolution = await resolveBranchForCheckout(cwd, branch)
  if (resolution === 'local') {
    return ['worktree', 'add', wsPath, branch]
  }
  // remote 场景必须显式 `origin/<branch>` —— `worktree add <path> <bare-name>` 在
  // 只有 remote-tracking ref 的情况下不会 DWIM，会报 "invalid reference"。
  if (resolution === 'remote') {
    return ['worktree', 'add', '-b', branch, wsPath, `origin/${branch}`]
  }
  // new：必须显式指定 base，否则会从当前 HEAD（可能是任意分支）分叉。
  const baseRef = await resolveBaseRef(cwd, baseBranch)
  return ['worktree', 'add', '-b', branch, wsPath, baseRef]
}

/**
 * Build `git worktree add` args for a followSource workspace: the worktree
 * lives on its own branch, named after the workspace.
 * - branch already exists (workspace was removed but its branch survived, e.g.
 *   carrying unmerged agent commits) → re-attach it as-is; resetting it here
 *   could orphan those commits, and the reuse path will advance it later once
 *   the ancestor guard passes
 * - otherwise → create the branch at the source's configured base branch
 */
async function buildFollowSourceAddArgs(
  wsPath: string,
  cwd: string,
  name: string,
  baseBranch: string,
): Promise<string[]> {
  if (await localBranchExists(cwd, name)) {
    return ['worktree', 'add', wsPath, name]
  }
  const baseRef = await resolveBaseRef(cwd, baseBranch)
  return ['worktree', 'add', '-b', name, wsPath, baseRef]
}

/**
 * 检测 git 错误是否为 branch 锁定（同一 branch 不能被两个 worktree checkout），
 * 如果是则抛出 WorktreeBranchLockedError。
 */
function rethrowIfBranchLocked(err: unknown, branch?: string): void {
  if (!branch) return
  const stderr = (err as { stderr?: string })?.stderr ?? (err instanceof Error ? err.message : '')
  // git 报错格式（版本差异）:
  //   "fatal: 'branch' is already checked out at '/path/to/worktree'"
  //   "fatal: 'branch' is already used by worktree at '/path/to/worktree'"
  const match = stderr.match(/already (?:checked out|used by worktree) at '([^']+)'/)
  if (match) {
    throw new WorktreeBranchLockedError(branch, match[1])
  }
}

// ============================================================
// Remove workspace
// ============================================================

/**
 * 读出 worktree 的 HEAD branch 名；detached 或读不到时返回 null。
 * 必须在 `git worktree remove` **之前**调用（remove 之后 wsPath 已不存在）。
 */
async function readWorktreeBranch(wsRepoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: wsRepoPath,
      timeout: 5_000,
    })
    const name = stdout.trim()
    return name || null
  } catch {
    return null
  }
}

/**
 * 删除主 repo 中的 local branch；失败只 warn（branch 可能被其他 worktree 独占，
 * 或是主 clone 的当前 HEAD，git 会拒绝 —— 这是天然的安全网）。
 */
async function deleteLocalBranch(repoLocalPath: string, branch: string): Promise<void> {
  try {
    await execFileAsync('git', ['branch', '-D', branch], {
      cwd: repoLocalPath,
      timeout: GIT_TIMEOUT_MS,
    })
    logger.info({ repoLocalPath, branch }, 'Deleted local branch along with worktree')
  } catch (err) {
    logger.warn(
      { err, repoLocalPath, branch },
      'Failed to delete local branch (likely held by another worktree or is main HEAD) — left in place',
    )
  }
}

interface RegisteredWorktree {
  repoLocalPath: string
  workspacePath: string
}

function isContainedPath(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent)
  const normalizedChild = resolve(child)
  return normalizedChild.startsWith(`${normalizedParent}${sep}`)
}

async function assertRegisteredWorktree(
  repoLocalPath: string,
  wsRoot: string,
  workspacePath: string,
): Promise<RegisteredWorktree> {
  const workspaceRealPath = await assertWorkspaceWithinRoot(wsRoot, workspacePath)

  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoLocalPath,
    timeout: GIT_TIMEOUT_MS,
  })
  const registeredPaths = stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())

  for (const registeredPath of registeredPaths) {
    try {
      if ((await realpath(registeredPath)) === workspaceRealPath) {
        return { repoLocalPath, workspacePath: workspaceRealPath }
      }
    } catch {
      // A stale Git registration is not proof that the requested live path is
      // managed. `git worktree prune` may clean it separately.
    }
  }
  throw new Error(`Workspace '${workspacePath}' is not a registered Git worktree`)
}

async function assertWorkspaceWithinRoot(wsRoot: string, workspacePath: string): Promise<string> {
  const [rootRealPath, workspaceRealPath] = await Promise.all([
    realpath(wsRoot),
    realpath(workspacePath),
  ])
  if (!isContainedPath(rootRealPath, workspaceRealPath)) {
    throw new Error(`Workspace '${workspacePath}' resolves outside the configured workspaces root`)
  }
  return workspaceRealPath
}

/**
 * 删除 workspace（支持单仓库和多仓库）。
 *
 * 语义：workspace 是云端 Agent 的一次性环境 —— 删除时**一并删除**对应的 local branch，
 * 和 Codex / Claude Cloud 对齐。未 push 的提交会随 workspace 一起丢失，push 是保留工作
 * 的唯一途径。这样可以避免：
 *   1. 残留 branch 在主 repo 里越堆越多
 *   2. 下次同名 branch 创建 worktree 时误复用陈旧的 local ref（而不是从配置的
 *      baseBranch 分叉）
 *
 * `options.beforeRemove` runs inside the workspace mutex, immediately before
 * any filesystem work. It is the caller's authoritative occupancy re-check:
 * a workload admitted between the caller's earlier decision and this lock
 * acquisition has already written its durable lease (admission precedes
 * worktree creation on every replica), so a re-check here observes it. Throw
 * from the callback to abort the removal with nothing touched.
 */
export interface RemoveGitWorkspaceOptions {
  /**
   * Re-check the removal decision immediately before touching the filesystem,
   * inside the per-worktree mutex. Throw to abort with nothing touched.
   */
  beforeRemove?: () => Promise<void>
  /**
   * Keep the worktree's local branch. Required for a per-Agent worktree: it is
   * long-lived and runs on its own branch, so that branch can hold unpushed
   * commits from an earlier run. Deleting it reclaims the directory *and*
   * discards that work.
   */
  keepBranches?: boolean
}

export async function removeGitWorkspace(
  localPath: string,
  wsRoot: string,
  name: string,
  config: GitConfig,
  options?: RemoveGitWorkspaceOptions,
): Promise<void> {
  return withKeyedLock(workspaceMutexKey(wsRoot, name), async () => {
    await options?.beforeRemove?.()
    return removeGitWorkspaceUnlocked(localPath, wsRoot, name, config, options)
  })
}

async function removeGitWorkspaceUnlocked(
  localPath: string,
  wsRoot: string,
  name: string,
  config: GitConfig,
  options?: Pick<RemoveGitWorkspaceOptions, 'keepBranches'>,
): Promise<void> {
  if (!WORKTREE_NAME_REGEX.test(name)) {
    throw new Error(`Invalid workspace name: ${name}`)
  }
  const wsPath = join(wsRoot, name)

  if (!existsSync(wsPath)) {
    logger.info({ wsPath }, 'Workspace does not exist, nothing to remove')
    return
  }

  const multiRepos = config.repos?.length ? config.repos : null

  // Preflight every live repository before removing any of them. This gives
  // deletion two independent boundaries: the configured root (realpath
  // containment) and Git's own worktree registry. Never turn a failed Git
  // removal into an arbitrary recursive filesystem delete. An interrupted
  // multi-repo create may have only the parent directory and no Git entry yet;
  // that case is recoverable through containment + the exact entry allowlist +
  // a final non-recursive rmdir.
  if (multiRepos) {
    await assertWorkspaceWithinRoot(wsRoot, wsPath)
    // Every entry the platform itself writes (skill mounts, MCP configs, the
    // CodeGraph link) is expected at the workspace root — deriving the list
    // from the Provider definitions keeps the next Provider from wedging
    // removal the way .codegraph once did.
    const allowedEntries = new Set([
      WORKSPACE_STATE_FILE,
      WORKSPACE_ARTIFACTS_DIRECTORY,
      ...platformWorkspaceEntries(),
      ...multiRepos.map((repo) => repo.directory),
    ])
    const unexpectedEntries = (await readdir(wsPath)).filter(
      (entry) => !allowedEntries.has(entry) && !WORKSPACE_STATE_TEMP_FILE_PATTERN.test(entry),
    )
    if (unexpectedEntries.length > 0) {
      throw new Error(
        `Workspace '${wsPath}' contains unexpected entries and cannot be safely removed: ${unexpectedEntries.join(', ')}`,
      )
    }
    for (const repo of multiRepos) {
      const repoWsPath = join(wsPath, repo.directory)
      if (!existsSync(repoWsPath)) continue
      await assertRegisteredWorktree(join(localPath, repo.directory), wsRoot, repoWsPath)
    }
  } else {
    await assertRegisteredWorktree(localPath, wsRoot, wsPath)
  }

  if (multiRepos) {
    for (const repo of multiRepos) {
      const repoLocalPath = join(localPath, repo.directory)
      const repoWsPath = join(wsPath, repo.directory)

      if (!existsSync(repoWsPath)) continue

      // 必须在 remove 前读出 branch
      const branch = await readWorktreeBranch(repoWsPath)

      try {
        await execFileAsync('git', ['worktree', 'remove', repoWsPath, '--force'], {
          cwd: repoLocalPath,
          timeout: GIT_TIMEOUT_MS,
        })
      } catch (err) {
        throw new Error(`Failed to remove registered Git worktree '${repoWsPath}'`, {
          cause: err,
        })
      }

      if (branch && !options?.keepBranches) {
        await deleteLocalBranch(repoLocalPath, branch)
      }
    }
  } else {
    const branch = await readWorktreeBranch(wsPath)

    try {
      await execFileAsync('git', ['worktree', 'remove', wsPath, '--force'], {
        cwd: localPath,
        timeout: GIT_TIMEOUT_MS,
      })
    } catch (err) {
      throw new Error(`Failed to remove registered Git worktree '${wsPath}'`, { cause: err })
    }

    if (branch && !options?.keepBranches) {
      await deleteLocalBranch(localPath, branch)
    }
  }

  // Multi-repo worktrees leave only platform-owned runtime entries and their
  // parent directory behind. Artifacts are explicitly disposable output under
  // A2WAVE_ARTIFACTS_DIR; state temp files can survive a crash between write
  // and rename. Remove only these allowlisted entries, then require rmdir to
  // prove nothing else appeared during cleanup.
  if (existsSync(wsPath)) {
    await rm(join(wsPath, WORKSPACE_ARTIFACTS_DIRECTORY), { recursive: true, force: true })
    await rm(join(wsPath, WORKSPACE_STATE_FILE), { force: true })
    // Remove the platform's own paths first, at full depth, type-aware:
    // symlinks are unlinked without following (the .codegraph link points into
    // the shared index), directories removed recursively (skill mounts, MCP
    // config dirs), plain files force-removed. fs.rm without recursive throws
    // EISDIR on a real directory, which once wedged removal permanently.
    for (const path of platformWorkspacePaths()) {
      const entryPath = join(wsPath, path)
      const entryStat = await lstat(entryPath).catch(() => null)
      if (entryStat) {
        await rm(entryPath, { force: true, recursive: entryStat.isDirectory() })
      }
    }
    // A shared root (.claude, .cursor) may hold content the platform never
    // wrote — a repo-tracked settings.json, or settings.local.json the CLI
    // wrote itself. The workspace directory is going away either way (the repo
    // checkouts were just removed with --force), so refusing here would only
    // wedge TTL sweeps and Agent-deletion reclaims. Name what is being removed
    // instead of deleting it silently, which is what the top-level
    // unexpected-entries check does for the level above.
    for (const entry of platformWorkspaceEntries()) {
      const entryPath = join(wsPath, entry)
      const leftovers = await readdir(entryPath).catch(() => null)
      if (!leftovers) {
        // Unreadable as a directory: absent, or something non-directory sits
        // where the shared root belongs (a plain file, a dangling symlink).
        // The platform never writes that shape, so treat it as one more
        // leftover to name — skipping it leaves the final rmdir failing
        // ENOTEMPTY on every later sweep of this workspace.
        const entryStat = await lstat(entryPath).catch(() => null)
        if (entryStat) {
          logger.warn(
            { wsPath, entry },
            'Removing a non-directory entry in place of a platform workspace root',
          )
          await rm(entryPath, { force: true, recursive: entryStat.isDirectory() })
        }
        continue
      }
      if (leftovers.length > 0) {
        logger.warn(
          { wsPath, entry, leftovers },
          'Removing workspace entries the platform did not write',
        )
      }
      await rm(entryPath, { force: true, recursive: true })
    }
    for (const entry of await readdir(wsPath)) {
      if (WORKSPACE_STATE_TEMP_FILE_PATTERN.test(entry)) {
        await rm(join(wsPath, entry), { recursive: true, force: true })
      }
    }
    await rmdir(wsPath)
  }
}

// ============================================================
// List workspaces
// ============================================================

export interface WorkspaceRepoInfo {
  /** 子 repo 目录名；单仓库模式为空字符串（代表 workspace 根） */
  directory: string
  branch: string | null // null = detached HEAD
  commit: string | null // null = 读不到 HEAD（error 必非空）
  error?: string
}

export interface WorkspaceInfo {
  name: string
  path: string
  repos: WorkspaceRepoInfo[]
  /** 状态文件内容；null = 无状态文件（老的/外部创建的 workspace） */
  cleanup: WorktreeCleanup | null
  lastRunId: string | null
  /** 状态文件 mtime（ms），null = 无状态文件 */
  lastActivityAt: number | null
}

/**
 * 读取单个 git 目录的 branch / commit，失败返回 error。
 */
async function readRepoInfo(gitDir: string, directory: string): Promise<WorkspaceRepoInfo> {
  if (!existsSync(gitDir)) {
    return { directory, branch: null, commit: null, error: 'Directory missing' }
  }
  try {
    const { stdout: commitRaw } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: gitDir,
      timeout: 5_000,
    })
    let branch: string | null = null
    try {
      const { stdout: branchRaw } = await execFileAsync(
        'git',
        ['symbolic-ref', '--short', 'HEAD'],
        { cwd: gitDir, timeout: 5_000 },
      )
      branch = branchRaw.trim()
    } catch {
      // detached HEAD — branch stays null
    }
    return { directory, branch, commit: commitRaw.trim() }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { directory, branch: null, commit: null, error: msg }
  }
}

/**
 * 列出 wsRoot 下所有 workspace 及其 git 信息。
 *
 * 单仓库：每个 workspace 产生 repos=[单项]，directory=''。
 * 多仓库：每个 workspace 产生 repos=[每个子 repo 一项]，子 repo 缺失或读失败会带 error。
 */
export async function listGitWorkspaces(
  localPath: string,
  wsRoot: string,
  config: GitConfig,
): Promise<WorkspaceInfo[]> {
  if (!existsSync(wsRoot)) return []

  const entries = await readdir(wsRoot, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())

  const results: WorkspaceInfo[] = []
  const multiRepos = config.repos?.length ? config.repos : null

  for (const dir of dirs) {
    const wsPath = join(wsRoot, dir.name)
    const repos: WorkspaceRepoInfo[] = []

    if (multiRepos) {
      for (const repo of multiRepos) {
        repos.push(await readRepoInfo(join(wsPath, repo.directory), repo.directory))
      }
    } else {
      repos.push(await readRepoInfo(wsPath, ''))
    }

    const { state, lastActivityAt } = await readWorkspaceState(wsPath)
    results.push({
      name: dir.name,
      path: wsPath,
      repos,
      cleanup: state?.cleanup ?? null,
      lastRunId: state?.lastRunId ?? null,
      lastActivityAt,
    })
  }

  // 按最近活动时间倒序（无状态文件排最后）
  results.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))

  return results
}

// ============================================================
// TTL 清理：idle > 7d 或 LRU > 20
// ============================================================

export const TTL_IDLE_DAYS = 7
export const TTL_LRU_CAP = 20

export interface CleanupOptions {
  /** 这些 workspace 路径视为"被占用"，不清理（由 caller 从 runs 表计算） */
  activePaths: Set<string>
  idleDays?: number
  lruCap?: number
  now?: number // 注入 now 便于测试
  /**
   * Removal executor. `activePaths` is a snapshot taken before the scan, so a
   * workload can claim a candidate AFTER the snapshot — the caller supplies
   * the guarded removal protocol (durable reservation + fresh occupancy
   * re-check inside the workspace mutex) and this function treats a thrown
   * block as "skip", not a failure. Falls back to a bare removeGitWorkspace
   * only when absent (tests exercising pure fs behavior).
   */
  removeWorkspace?: (name: string) => Promise<void>
}

/**
 * 清理 `ttl` workspace：idle 超阈值 OR 总数超容量（LRU 淘汰最旧）。
 * 跳过：persistent / 无状态文件 / 活跃占用 / dirty（有未提交改动）。
 */
export async function cleanupStaleWorkspaces(
  localPath: string,
  wsRoot: string,
  config: GitConfig,
  opts: CleanupOptions,
): Promise<string[]> {
  const idleDays = opts.idleDays ?? TTL_IDLE_DAYS
  const lruCap = opts.lruCap ?? TTL_LRU_CAP
  const now = opts.now ?? Date.now()
  const removeWorkspaceImpl =
    opts.removeWorkspace ??
    ((name: string) =>
      removeGitWorkspace(localPath, wsRoot, name, config, {
        // Defense in depth: a per-agent workspace should never carry `ttl`, but
        // if a legacy state file says so, its branch may still hold the only
        // copy of unpushed work — reclaim the directory, keep the refs.
        keepBranches: isPerAgentWorkspaceName(name),
      }))
  const idleThreshold = now - idleDays * 24 * 60 * 60 * 1000

  const all = await listGitWorkspaces(localPath, wsRoot, config)
  // 只考虑 ttl 候选
  const ttlWorkspaces = all.filter((w) => w.cleanup === 'ttl')

  const removed: string[] = []
  const survivors: WorkspaceInfo[] = []

  for (const ws of ttlWorkspaces) {
    if (opts.activePaths.has(ws.path)) {
      survivors.push(ws)
      continue
    }
    if (await isWorkspaceDirty(ws, config)) {
      logger.info({ wsPath: ws.path }, 'TTL cleanup: skipping dirty workspace')
      survivors.push(ws)
      continue
    }
    if (ws.lastActivityAt != null && ws.lastActivityAt < idleThreshold) {
      try {
        // Goes through the guarded protocol the caller injected (durable
        // reservation + fresh occupancy re-check); its fallback carries the
        // same keepBranches rule.
        await removeWorkspaceImpl(ws.name)
        removed.push(ws.name)
        logger.info(
          { wsPath: ws.path, lastActivityAt: ws.lastActivityAt },
          'TTL cleanup: removed idle workspace',
        )
      } catch (err) {
        logger.warn({ err, wsPath: ws.path }, 'TTL cleanup: failed to remove idle workspace')
        survivors.push(ws)
      }
    } else {
      survivors.push(ws)
    }
  }

  // LRU：survivors 按 lastActivityAt 倒序，超容量的尾部淘汰
  if (survivors.length > lruCap) {
    survivors.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    const excess = survivors.slice(lruCap)
    for (const ws of excess) {
      if (opts.activePaths.has(ws.path)) continue
      if (await isWorkspaceDirty(ws, config)) continue
      try {
        // Goes through the guarded protocol the caller injected (durable
        // reservation + fresh occupancy re-check); its fallback carries the
        // same keepBranches rule.
        await removeWorkspaceImpl(ws.name)
        removed.push(ws.name)
        logger.info({ wsPath: ws.path }, 'TTL cleanup: removed LRU excess workspace')
      } catch (err) {
        logger.warn({ err, wsPath: ws.path }, 'TTL cleanup: failed to remove LRU excess workspace')
      }
    }
  }

  return removed
}

async function isWorkspaceDirty(ws: WorkspaceInfo, config: GitConfig): Promise<boolean> {
  const dirs = config.repos?.length
    ? config.repos.map((r) => join(ws.path, r.directory))
    : [ws.path]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      // 用 pathspec 排除我们自己写的状态文件（只在 wsPath 根存在），避免误判 dirty
      const { stdout } = await execFileAsync(
        'git',
        [
          'status',
          '--porcelain',
          '--',
          '.',
          `:!${WORKSPACE_STATE_FILE}`,
          `:!${WORKSPACE_STATE_FILE}.*.tmp`,
        ],
        { cwd: dir, timeout: 5_000 },
      )
      if (stdout.trim()) return true
    } catch {
      /* 读不到状态视为不 dirty，让 remove 自行处理 */
    }
  }
  return false
}
