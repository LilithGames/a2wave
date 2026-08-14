import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { GitConfig } from '@a2wave/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_STATE_FILE,
  WorktreeBranchLockedError,
  WorktreeDirtyError,
  cleanupStaleWorkspaces,
  createGitWorkspace,
  defaultWorkspacesPath,
  listGitWorkspaces,
  readWorkspaceState,
  removeGitWorkspace,
  writeWorkspaceState,
} from '../git-workspace.js'
import { logger } from '../logger.js'
import { createScmSource } from '../scm-source.js'

vi.mock('../scm-workspace-safety.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scm-workspace-safety.js')>()),
  assertStoredScmWorkspacesRoot: vi.fn().mockResolvedValue(undefined),
}))

const execFileAsync = promisify(execFile)

const TEST_DIR = join(tmpdir(), `git-workspace-test-${Date.now()}`)
const REPO_DIR = join(TEST_DIR, 'repo')
const WS_ROOT = join(TEST_DIR, 'workspaces')

async function initGitRepo(dir: string, opts: { withOrigin?: boolean } = {}): Promise<void> {
  await mkdir(dir, { recursive: true })
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(join(dir, 'README.md'), '# Test')
  await execFileAsync('git', ['add', '.'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
  // 默认补一个本地 bare origin，真实 scm-source 都是 clone 出来的一定有 origin；
  // 没有 origin 时 resolveBranchForCheckout 的 ls-remote 会报 fatal，被当作网络故障抛出。
  // 单独测试自己 push 过 origin 的可以传 withOrigin=false 以免冲突。
  if (opts.withOrigin !== false) {
    const originDir = `${dir}.origin.git`
    await mkdir(originDir, { recursive: true })
    await execFileAsync('git', ['init', '--bare', '-b', 'main'], { cwd: originDir })
    await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: dir })
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: dir })
  }
}

const singleRepoConfig: GitConfig = {
  repoUrl: 'https://example.com/repo.git',
  branch: 'main',
  autoSync: false,
  syncIntervalMin: 30,
  initialSyncTimeoutMin: 60,
}

describe('git-workspace', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  describe('defaultWorkspacesPath', () => {
    it('returns ~/.a2wave/workspaces/<id-suffix>', async () => {
      const result = defaultWorkspacesPath('scm__abc123')
      expect(result).toContain('.a2wave')
      expect(result).toContain('workspaces')
      // 保留 prefix 之后的完整随机段（含开头的 '_'）
      expect(result).toMatch(/\/_abc123$/)
    })

    it('preserves entropy when random segment contains underscores (no split/pop collision)', async () => {
      // base64url 字母表含 '_'，如果用 split('_').pop() 截尾会丢失前面的随机段，
      // 导致两个前缀相同但前段不同的 id 解析到同一个 wsRoot。
      const a = defaultWorkspacesPath('scm_ABC_XYZ')
      const b = defaultWorkspacesPath('scm_DEF_XYZ')
      expect(a).not.toBe(b)
      expect(a).toMatch(/\/ABC_XYZ$/)
      expect(b).toMatch(/\/DEF_XYZ$/)
    })

    it('recovers the historical default when that per-source directory still exists', () => {
      const legacyPath = defaultWorkspacesPath('scm_legacy', () => true)
      expect(legacyPath).toMatch(/\.a2wave\/workspaces\/legacy$/)
    })

    it('uses managed storage when no historical per-source directory exists', () => {
      const managedPath = defaultWorkspacesPath('scm_fresh', () => false)
      expect(managedPath).toContain('workspaces')
      expect(managedPath).toMatch(/\/fresh$/)
    })
  })

  describe('createGitWorkspace — single repo', () => {
    beforeEach(async () => {
      await initGitRepo(REPO_DIR)
    })

    it('creates a workspace with detached HEAD', async () => {
      const result = await createGitWorkspace(REPO_DIR, WS_ROOT, 'fix-bug', singleRepoConfig)

      expect(result.path).toBe(join(WS_ROOT, 'fix-bug'))
      expect(result.created).toBe(true)
      expect(existsSync(result.path)).toBe(true)
      expect(existsSync(join(result.path, 'README.md'))).toBe(true)

      // Verify detached HEAD (message varies by git version)
      const { stdout } = await execFileAsync('git', ['status'], { cwd: result.path })
      expect(stdout).toMatch(/HEAD detached|Not currently on any branch/)
    })

    it('is idempotent — returns existing workspace without error', async () => {
      const ws1 = await createGitWorkspace(REPO_DIR, WS_ROOT, 'fix-bug', singleRepoConfig)
      const ws2 = await createGitWorkspace(REPO_DIR, WS_ROOT, 'fix-bug', singleRepoConfig)
      expect(ws1.path).toBe(ws2.path)
      expect(ws1.created).toBe(true)
      expect(ws2.created).toBe(false)
    })

    it('creates multiple independent workspaces', async () => {
      const ws1 = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-a', singleRepoConfig)
      const ws2 = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-b', singleRepoConfig)

      expect(ws1.path).not.toBe(ws2.path)
      expect(existsSync(ws1.path)).toBe(true)
      expect(existsSync(ws2.path)).toBe(true)
    })

    it('checkouts existing local branch', async () => {
      await execFileAsync('git', ['branch', 'feature-a'], { cwd: REPO_DIR })
      const result = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-a', singleRepoConfig, {
        branch: 'feature-a',
      })

      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: result.path,
      })
      expect(stdout.trim()).toBe('feature-a')
    })

    it('creates new branch with -b when branch does not exist', async () => {
      const result = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-new', singleRepoConfig, {
        branch: 'feature-new',
      })

      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: result.path,
      })
      expect(stdout.trim()).toBe('feature-new')

      const { stdout: branches } = await execFileAsync('git', ['branch', '--list', 'feature-new'], {
        cwd: REPO_DIR,
      })
      expect(branches).toContain('feature-new')
    })

    it('fails run when origin is unreachable (does not silently create new branch)', async () => {
      // 把 origin 指到不存在的路径模拟网络/鉴权故障 —— 之前 catch-all 的 fetch 会吞错返回 'new'，
      // 从 base 无声创建同名分支，可能覆盖远端真实存在的分支历史。
      await execFileAsync('git', ['remote', 'set-url', 'origin', '/non/existent/path.git'], {
        cwd: REPO_DIR,
      })

      // 抛错必须是 ls-remote 这条路径，否则可能是其他回归（比如 resolveBaseRef 失败）
      // 导致 pass 而不是真正锁住"网络故障不降级为 new"的不变量。
      await expect(
        createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-err', singleRepoConfig, {
          branch: 'some-branch',
        }),
      ).rejects.toThrow(/ls-remote/)

      // 关键不变量：没有因 fallback 产生一个叫 some-branch 的本地分支
      const { stdout } = await execFileAsync('git', ['branch', '--list', 'some-branch'], {
        cwd: REPO_DIR,
      })
      expect(stdout.trim()).toBe('')
    })

    it('throws WorktreeBranchLockedError when branch is already checked out elsewhere', async () => {
      await execFileAsync('git', ['branch', 'feature-lock'], { cwd: REPO_DIR })
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-first', singleRepoConfig, {
        branch: 'feature-lock',
      })

      await expect(
        createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-second', singleRepoConfig, {
          branch: 'feature-lock',
        }),
      ).rejects.toBeInstanceOf(WorktreeBranchLockedError)
    })

    it('logs warning when reusing dirty workspace', async () => {
      const ws1 = await createGitWorkspace(REPO_DIR, WS_ROOT, 'fix-bug', singleRepoConfig)
      await writeFile(join(ws1.path, 'dirty.txt'), 'uncommitted')

      const ws2 = await createGitWorkspace(REPO_DIR, WS_ROOT, 'fix-bug', singleRepoConfig)
      expect(ws2.created).toBe(false)
      expect(ws2.path).toBe(ws1.path)
    })
  })

  describe('createGitWorkspace — reuse with branch switch (single repo)', () => {
    beforeEach(async () => {
      await initGitRepo(REPO_DIR)
      await execFileAsync('git', ['branch', 'feature-a'], { cwd: REPO_DIR })
      await execFileAsync('git', ['branch', 'feature-b'], { cwd: REPO_DIR })
    })

    it('switches branch on reuse when workspace is clean', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, { branch: 'feature-a' })

      const reused = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, {
        branch: 'feature-b',
      })
      expect(reused.created).toBe(false)

      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: reused.path,
      })
      expect(stdout.trim()).toBe('feature-b')
    })

    it('no-op when reuse branch equals current branch', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, {
        branch: 'feature-a',
      })
      const reused = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, {
        branch: 'feature-a',
      })
      expect(reused.path).toBe(first.path)

      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: reused.path,
      })
      expect(stdout.trim()).toBe('feature-a')
    })

    it('throws WorktreeDirtyError when reusing dirty workspace with different branch', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, {
        branch: 'feature-a',
      })
      await writeFile(join(first.path, 'dirty.txt'), 'uncommitted')

      await expect(
        createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, {
          branch: 'feature-b',
        }),
      ).rejects.toBeInstanceOf(WorktreeDirtyError)

      // Dirty file remains; branch unchanged
      expect(existsSync(join(first.path, 'dirty.txt'))).toBe(true)
      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: first.path,
      })
      expect(stdout.trim()).toBe('feature-a')
    })

    it('throws WorktreeBranchLockedError when switching to a branch held by another worktree', async () => {
      // feature-a 被 ws-holder 独占
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-holder', singleRepoConfig, {
        branch: 'feature-a',
      })
      // ws 当前在 feature-b（干净）
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, { branch: 'feature-b' })

      await expect(
        createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, {
          branch: 'feature-a',
        }),
      ).rejects.toBeInstanceOf(WorktreeBranchLockedError)
    })

    it('does not switch when branch option is omitted on reuse', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, {
        branch: 'feature-a',
      })
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig)

      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: first.path,
      })
      expect(stdout.trim()).toBe('feature-a')
    })
  })

  describe('createGitWorkspace — followSource reuse (single repo)', () => {
    beforeEach(async () => {
      await initGitRepo(REPO_DIR)
    })

    async function currentCommit(cwd: string): Promise<string> {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })
      return stdout.trim()
    }

    async function commitNewFile(name: string): Promise<void> {
      await writeFile(join(REPO_DIR, name), name)
      await execFileAsync('git', ['add', '.'], { cwd: REPO_DIR })
      await execFileAsync('git', ['commit', '-m', `add ${name}`], { cwd: REPO_DIR })
    }

    async function currentBranch(cwd: string): Promise<string> {
      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
        cwd,
      }).catch(() => ({ stdout: '' }))
      return stdout.trim()
    }

    it('creates the workspace on a branch named after it, at the source HEAD', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(first.created).toBe(true)
      expect(await currentBranch(first.path)).toBe('agent-1')
      expect(await currentCommit(first.path)).toBe(await currentCommit(REPO_DIR))
    })

    it('advances a clean workspace to the source HEAD on reuse', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(first.created).toBe(true)

      // Untracked content (the platform mounts skills/config as untracked files)
      // must survive the advance.
      await writeFile(join(first.path, 'untracked.txt'), 'keep me')
      await commitNewFile('new-file.txt')

      const second = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(second.created).toBe(false)
      expect(await currentCommit(second.path)).toBe(await currentCommit(REPO_DIR))
      expect(await currentBranch(second.path)).toBe('agent-1')
      expect(existsSync(join(second.path, 'new-file.txt'))).toBe(true)
      expect(await readFile(join(second.path, 'untracked.txt'), 'utf8')).toBe('keep me')
    })

    it('pins a workspace whose branch carries unmerged commits, and unpins once they merge', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      // The agent commits work on its branch — the normal way an agent finishes a task.
      await writeFile(join(first.path, 'agent-work.txt'), 'committed by agent')
      await execFileAsync('git', ['add', '.'], { cwd: first.path })
      await execFileAsync('git', ['commit', '-m', 'agent work'], { cwd: first.path })
      const agentCommit = await currentCommit(first.path)

      await commitNewFile('upstream-moves.txt')

      const pinned = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(await currentCommit(pinned.path)).toBe(agentCommit)
      expect(await readFile(join(pinned.path, 'agent-work.txt'), 'utf8')).toBe('committed by agent')

      // Once the agent's commit is merged into the source branch, the ancestor
      // guard passes again and the workspace follows the source once more.
      await execFileAsync('git', ['merge', 'agent-1'], { cwd: REPO_DIR })
      const unpinned = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(await currentCommit(unpinned.path)).toBe(await currentCommit(REPO_DIR))
      expect(await currentBranch(unpinned.path)).toBe('agent-1')
    })

    it('migrates a legacy detached workspace onto the branch when clean', async () => {
      // v1 of this feature created followSource workspaces with --detach.
      await mkdir(WS_ROOT, { recursive: true })
      const wsPath = join(WS_ROOT, 'agent-1')
      await execFileAsync('git', ['worktree', 'add', wsPath, '--detach'], { cwd: REPO_DIR })
      await commitNewFile('new-file.txt')

      const reused = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(reused.created).toBe(false)
      expect(await currentBranch(reused.path)).toBe('agent-1')
      expect(await currentCommit(reused.path)).toBe(await currentCommit(REPO_DIR))
    })

    it('skips the advance when asked (concurrent run of the same agent)', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      const pinned = await currentCommit(first.path)
      await commitNewFile('new-file.txt')

      const second = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
        advance: false,
      })
      expect(await currentCommit(second.path)).toBe(pinned)
    })

    it('adopts a legacy detached workspace without force-moving an existing branch', async () => {
      // v1 detached workspace + a pre-existing branch of the same name carrying
      // an unmerged commit — adoption must not orphan that commit via checkout -B.
      const scratch = join(TEST_DIR, 'scratch')
      await execFileAsync('git', ['worktree', 'add', '-b', 'agent-1', scratch, 'main'], {
        cwd: REPO_DIR,
      })
      await writeFile(join(scratch, 'branch-work.txt'), 'unmerged')
      await execFileAsync('git', ['add', '.'], { cwd: scratch })
      await execFileAsync('git', ['commit', '-m', 'branch work'], { cwd: scratch })
      const { stdout: branchTipBefore } = await execFileAsync('git', ['rev-parse', 'agent-1'], {
        cwd: scratch,
      })
      await execFileAsync('git', ['worktree', 'remove', scratch], { cwd: REPO_DIR })

      await mkdir(WS_ROOT, { recursive: true })
      const wsPath = join(WS_ROOT, 'agent-1')
      await execFileAsync('git', ['worktree', 'add', wsPath, '--detach'], { cwd: REPO_DIR })

      await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })

      const { stdout: branchTipAfter } = await execFileAsync(
        'git',
        ['rev-parse', 'refs/heads/agent-1'],
        { cwd: REPO_DIR },
      )
      expect(branchTipAfter.trim()).toBe(branchTipBefore.trim())
    })

    it('surfaces a branch lock instead of a generic create failure', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      // Free the directory but keep the branch, then occupy the branch elsewhere.
      await execFileAsync('git', ['worktree', 'remove', first.path], { cwd: REPO_DIR })
      await execFileAsync('git', ['worktree', 'add', join(TEST_DIR, 'other'), 'agent-1'], {
        cwd: REPO_DIR,
      })

      await expect(
        createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
          followSource: true,
        }),
      ).rejects.toBeInstanceOf(WorktreeBranchLockedError)
    })

    it('still advances when a non-default provider skills dir is modified', async () => {
      // The exemption list is derived from the provider definitions — a repo
      // tracking .kimi-code/skills content must not pin the workspace either.
      await mkdir(join(REPO_DIR, '.kimi-code', 'skills', 'seeded'), { recursive: true })
      await writeFile(join(REPO_DIR, '.kimi-code', 'skills', 'seeded', 'SKILL.md'), 'v1')
      await execFileAsync('git', ['add', '.'], { cwd: REPO_DIR })
      await execFileAsync('git', ['commit', '-m', 'seed kimi skill'], { cwd: REPO_DIR })

      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      await writeFile(
        join(first.path, '.kimi-code', 'skills', 'seeded', 'SKILL.md'),
        'platform-mounted',
      )
      await commitNewFile('new-file.txt')

      const second = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(await currentCommit(second.path)).toBe(await currentCommit(REPO_DIR))
    })

    it('still advances when only platform-managed paths differ from the index', async () => {
      // Repos may track .claude/skills content; the platform re-mounts it every
      // run, so those modifications must not pin the workspace forever.
      await mkdir(join(REPO_DIR, '.claude', 'skills', 'seeded'), { recursive: true })
      await writeFile(join(REPO_DIR, '.claude', 'skills', 'seeded', 'SKILL.md'), 'v1')
      await execFileAsync('git', ['add', '.'], { cwd: REPO_DIR })
      await execFileAsync('git', ['commit', '-m', 'seed tracked skill'], { cwd: REPO_DIR })

      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      await writeFile(
        join(first.path, '.claude', 'skills', 'seeded', 'SKILL.md'),
        'platform-mounted',
      )
      await commitNewFile('new-file.txt')

      const second = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(await currentCommit(second.path)).toBe(await currentCommit(REPO_DIR))
    })

    it('pins on a tracked .claude file the platform does not write', async () => {
      // The skill mount lives at .claude/skills, but repos commonly track
      // .claude/settings.json and .claude/hooks/* too. Exempting the whole
      // .claude root would let the reset below revert an agent's edit to them
      // with no error and no log — the exemption is per path, not per root.
      await mkdir(join(REPO_DIR, '.claude', 'skills', 'seeded'), { recursive: true })
      await writeFile(join(REPO_DIR, '.claude', 'skills', 'seeded', 'SKILL.md'), 'v1')
      await writeFile(join(REPO_DIR, '.claude', 'settings.json'), '{"hooks":[]}')
      await execFileAsync('git', ['add', '.'], { cwd: REPO_DIR })
      await execFileAsync('git', ['commit', '-m', 'seed tracked claude config'], { cwd: REPO_DIR })

      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      const pinned = await currentCommit(first.path)
      await writeFile(join(first.path, '.claude', 'settings.json'), '{"hooks":["agent-edit"]}')
      await commitNewFile('new-file.txt')

      const second = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(await currentCommit(second.path)).toBe(pinned)
      expect(await readFile(join(second.path, '.claude', 'settings.json'), 'utf8')).toBe(
        '{"hooks":["agent-edit"]}',
      )
    })

    it('re-attaches an orphaned branch instead of resetting it', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      await writeFile(join(first.path, 'agent-work.txt'), 'committed by agent')
      await execFileAsync('git', ['add', '.'], { cwd: first.path })
      await execFileAsync('git', ['commit', '-m', 'agent work'], { cwd: first.path })
      const agentCommit = await currentCommit(first.path)

      // Ops removed the worktree directory; the branch (and its commit) survive.
      await execFileAsync('git', ['worktree', 'remove', first.path], { cwd: REPO_DIR })

      const resurrected = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(resurrected.created).toBe(true)
      expect(await currentBranch(resurrected.path)).toBe('agent-1')
      expect(await currentCommit(resurrected.path)).toBe(agentCommit)
    })

    it('keeps the branch when an incomplete followSource workspace is rebuilt', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      await writeFile(join(first.path, 'agent-work.txt'), 'committed by agent')
      await execFileAsync('git', ['add', '.'], { cwd: first.path })
      await execFileAsync('git', ['commit', '-m', 'agent work'], { cwd: first.path })
      const agentCommit = await currentCommit(first.path)

      // Multi-repo shape: simulate a half-destroyed workspace so the rebuild
      // path (remove + fresh create) runs. Single-repo dirs cannot go
      // incomplete, so drive the rebuild via a multi-repo config over the
      // same name — the point is that removeGitWorkspace is invoked with
      // keepBranches for followSource and the branch survives to re-attach.
      await execFileAsync('git', ['worktree', 'remove', '--force', first.path], { cwd: REPO_DIR })
      const again = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(await currentBranch(again.path)).toBe('agent-1')
      expect(await currentCommit(again.path)).toBe(agentCommit)
    })

    it('keeps the previous commit when the workspace has tracked modifications', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      const pinned = await currentCommit(first.path)
      await writeFile(join(first.path, 'README.md'), 'locally modified')
      await commitNewFile('new-file.txt')

      const second = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      expect(await currentCommit(second.path)).toBe(pinned)
      expect(await readFile(join(second.path, 'README.md'), 'utf8')).toBe('locally modified')
    })

    it('leaves a workspace that was switched onto a branch untouched', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      await execFileAsync('git', ['checkout', '-b', 'my-work'], { cwd: first.path })
      const pinned = await currentCommit(first.path)
      await commitNewFile('new-file.txt')

      await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', singleRepoConfig, {
        followSource: true,
      })
      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: first.path,
      })
      expect(stdout.trim()).toBe('my-work')
      expect(await currentCommit(first.path)).toBe(pinned)
    })
  })

  describe('createGitWorkspace — reuse with branch switch (multi repo)', () => {
    const FRONTEND_DIR = join(REPO_DIR, 'frontend')
    const BACKEND_DIR = join(REPO_DIR, 'backend')

    const multiRepoConfig: GitConfig = {
      ...singleRepoConfig,
      repos: [
        { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
        { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
      ],
    }

    beforeEach(async () => {
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(FRONTEND_DIR)
      await initGitRepo(BACKEND_DIR)
      await execFileAsync('git', ['branch', 'feature-a'], { cwd: FRONTEND_DIR })
      await execFileAsync('git', ['branch', 'feature-a'], { cwd: BACKEND_DIR })
      await execFileAsync('git', ['branch', 'feature-b'], { cwd: FRONTEND_DIR })
      await execFileAsync('git', ['branch', 'feature-b'], { cwd: BACKEND_DIR })
    })

    it('switches branch on all sub-repos when all are clean', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', multiRepoConfig, {
        branch: 'feature-a',
      })

      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', multiRepoConfig, { branch: 'feature-b' })

      for (const sub of ['frontend', 'backend']) {
        const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
          cwd: join(first.path, sub),
        })
        expect(stdout.trim()).toBe('feature-b')
      }
    })

    it('pre-validates branch lock across all sub-repos — no partial switch', async () => {
      // ws-holder 独占两个仓的 feature-b。ws 新建在 feature-a，尝试切到 feature-b
      // 必须在 checkout 前就因 lock 被拒绝，frontend 不能被先切走留下不一致。
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-holder', multiRepoConfig, {
        branch: 'feature-b',
      })
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', multiRepoConfig, {
        branch: 'feature-a',
      })

      await expect(
        createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', multiRepoConfig, { branch: 'feature-b' }),
      ).rejects.toBeInstanceOf(WorktreeBranchLockedError)

      // frontend 不应被先切到 feature-b
      for (const sub of ['frontend', 'backend']) {
        const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
          cwd: join(first.path, sub),
        })
        expect(stdout.trim()).toBe('feature-a')
      }
    })

    it('throws WorktreeDirtyError if any sub-repo is dirty during switch', async () => {
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', multiRepoConfig, {
        branch: 'feature-a',
      })
      await writeFile(join(first.path, 'backend', 'dirty.txt'), 'uncommitted')

      await expect(
        createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', multiRepoConfig, { branch: 'feature-b' }),
      ).rejects.toBeInstanceOf(WorktreeDirtyError)

      // frontend 不应被切走（原子性）
      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: join(first.path, 'frontend'),
      })
      expect(stdout.trim()).toBe('feature-a')
    })

    // Forces the failure with `chmod 555`, which root ignores — as root the
    // checkout simply succeeds and nothing rejects. The CI runner's container
    // is root, so gate on the uid rather than assert something untrue there.
    // (`process.getuid` is undefined on Windows; treat that as non-root.)
    it.skipIf(process.getuid?.() === 0)(
      'rolls back already-switched sub-repos when a later checkout fails',
      async () => {
        const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', multiRepoConfig, {
          branch: 'feature-a',
        })

        // 让 backend 的 worktree 元数据目录只读：pre-validate（只读命令）仍能通过，
        // 但 checkout 阶段需要写 HEAD/index，会失败。frontend 会先切到 feature-b，
        // 触发 rollback 路径 —— 必须回切到 feature-a。
        const wtMetaRoot = join(REPO_DIR, 'backend', '.git', 'worktrees')
        const wtName = (await readdir(wtMetaRoot))[0]
        const wtMetaDir = join(wtMetaRoot, wtName)
        await execFileAsync('chmod', ['555', wtMetaDir])

        try {
          await expect(
            createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', multiRepoConfig, {
              branch: 'feature-b',
            }),
          ).rejects.toThrow()

          // frontend 必须回切到 feature-a（不允许半切状态）
          const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
            cwd: join(first.path, 'frontend'),
          })
          expect(stdout.trim()).toBe('feature-a')
        } finally {
          await execFileAsync('chmod', ['755', wtMetaDir]).catch(() => {})
        }
      },
    )
  })

  describe('createGitWorkspace — single-branch clone（refspec 锁死场景）', () => {
    const ORIGIN_DIR = join(TEST_DIR, 'origin.git')
    const SINGLE_CLONE = join(TEST_DIR, 'single-clone')

    beforeEach(async () => {
      // 构造 bare origin：含 main + feature-a，feature-a 上有独占文件 FEATURE.md
      await mkdir(ORIGIN_DIR, { recursive: true })
      await execFileAsync('git', ['init', '--bare', '-b', 'main'], { cwd: ORIGIN_DIR })

      const seed = join(TEST_DIR, 'seed')
      await initGitRepo(seed, { withOrigin: false })
      await execFileAsync('git', ['checkout', '-b', 'feature-a'], { cwd: seed })
      await writeFile(join(seed, 'FEATURE.md'), 'feature content')
      await execFileAsync('git', ['add', '.'], { cwd: seed })
      await execFileAsync('git', ['commit', '-m', 'feature commit'], { cwd: seed })
      await execFileAsync('git', ['checkout', 'main'], { cwd: seed })
      await execFileAsync('git', ['remote', 'add', 'origin', ORIGIN_DIR], { cwd: seed })
      await execFileAsync('git', ['push', 'origin', 'main', 'feature-a'], { cwd: seed })

      // 模拟 git-sync.ts 里的 --single-branch 克隆：refspec 被锁到 main
      await execFileAsync('git', [
        'clone',
        '--branch',
        'main',
        '--single-branch',
        ORIGIN_DIR,
        SINGLE_CLONE,
      ])
    })

    it('创建 worktree 时能拿到 single-branch 未同步的 remote 分支内容（feature-a）', async () => {
      const result = await createGitWorkspace(SINGLE_CLONE, WS_ROOT, 'ws', singleRepoConfig, {
        branch: 'feature-a',
      })

      // 若走 `-b feature-a` 兜底路径，会从当前 HEAD (main) 开一个空分支 —— FEATURE.md 不存在
      expect(existsSync(join(result.path, 'FEATURE.md'))).toBe(true)
      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: result.path,
      })
      expect(stdout.trim()).toBe('feature-a')
    })

    it('复用 worktree 切到 single-branch 未同步的分支时也能同步 ref 并切过去', async () => {
      // main 被 SINGLE_CLONE 自身独占，初次创建走 detached，避开 branch lock
      const first = await createGitWorkspace(SINGLE_CLONE, WS_ROOT, 'ws', singleRepoConfig)
      await createGitWorkspace(SINGLE_CLONE, WS_ROOT, 'ws', singleRepoConfig, {
        branch: 'feature-a',
      })

      expect(existsSync(join(first.path, 'FEATURE.md'))).toBe(true)
      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: first.path,
      })
      expect(stdout.trim()).toBe('feature-a')
    })

    it('真正不存在的分支仍然走 -b 创建（不被 fetch fallback 淹没）', async () => {
      const result = await createGitWorkspace(SINGLE_CLONE, WS_ROOT, 'ws', singleRepoConfig, {
        branch: 'brand-new',
      })

      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: result.path,
      })
      expect(stdout.trim()).toBe('brand-new')
      // 新分支基于 main，不含 FEATURE.md
      expect(existsSync(join(result.path, 'FEATURE.md'))).toBe(false)
    })
  })

  describe('createGitWorkspace — 新分支从配置 baseBranch 分叉', () => {
    beforeEach(async () => {
      await initGitRepo(REPO_DIR)
      // feature-a 独占提交 FEATURE.md（main 上不存在）
      await execFileAsync('git', ['checkout', '-b', 'feature-a'], { cwd: REPO_DIR })
      await writeFile(join(REPO_DIR, 'FEATURE.md'), 'feature-only')
      await execFileAsync('git', ['add', '.'], { cwd: REPO_DIR })
      await execFileAsync('git', ['commit', '-m', 'feature commit'], { cwd: REPO_DIR })
      // 注意：HEAD 停在 feature-a，模拟 local repo HEAD != 配置的 baseBranch。
      // 当前代码 bug 会导致 `-b brand-new` 从 HEAD (feature-a) 分叉，携带 FEATURE.md。
    })

    it('首次创建：新分支以 config.branch (main) 为基，而非当前 HEAD (feature-a)', async () => {
      const result = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, {
        branch: 'brand-new',
      })

      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: result.path,
      })
      expect(stdout.trim()).toBe('brand-new')
      // 从 main 分叉 → 不含 feature-a 的 FEATURE.md
      expect(existsSync(join(result.path, 'FEATURE.md'))).toBe(false)
    })

    it('复用切分支：brand-new 以 main 为基，而非复用前的 worktree HEAD (feature-a)', async () => {
      // 让 REPO_DIR HEAD 回到 main，解除 feature-a 的独占，worktree 才能 checkout feature-a
      await execFileAsync('git', ['checkout', 'main'], { cwd: REPO_DIR })

      // 初次创建落到 feature-a：worktree HEAD = feature-a（含 FEATURE.md）
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, {
        branch: 'feature-a',
      })
      expect(existsSync(join(first.path, 'FEATURE.md'))).toBe(true)

      // 复用时切到全新分支 brand-new → 应从 main 分叉，不该继承 feature-a
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws', singleRepoConfig, { branch: 'brand-new' })

      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: first.path,
      })
      expect(stdout.trim()).toBe('brand-new')
      expect(existsSync(join(first.path, 'FEATURE.md'))).toBe(false)
    })
  })

  describe('createGitWorkspace — multi repo branch handling', () => {
    const FRONTEND_DIR = join(REPO_DIR, 'frontend')
    const BACKEND_DIR = join(REPO_DIR, 'backend')

    const multiRepoConfig: GitConfig = {
      ...singleRepoConfig,
      repos: [
        { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
        { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
      ],
    }

    beforeEach(async () => {
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(FRONTEND_DIR)
      await initGitRepo(BACKEND_DIR)
    })

    it('rolls back all sub-repo worktrees when one fails', async () => {
      await execFileAsync('git', ['branch', 'shared-branch'], { cwd: FRONTEND_DIR })
      await execFileAsync('git', ['branch', 'shared-branch'], { cwd: BACKEND_DIR })
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-first', multiRepoConfig, {
        branch: 'shared-branch',
      })

      await expect(
        createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-second', multiRepoConfig, {
          branch: 'shared-branch',
        }),
      ).rejects.toBeInstanceOf(WorktreeBranchLockedError)

      // rollback: ws-second 应已清理（存在 ws-first 独占 shared-branch）
      expect(existsSync(join(WS_ROOT, 'ws-second'))).toBe(false)
    })
  })

  describe('createGitWorkspace — multi repo', () => {
    const FRONTEND_DIR = join(REPO_DIR, 'frontend')
    const BACKEND_DIR = join(REPO_DIR, 'backend')

    const multiRepoConfig: GitConfig = {
      ...singleRepoConfig,
      repos: [
        { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
        { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
      ],
    }

    beforeEach(async () => {
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(FRONTEND_DIR)
      await initGitRepo(BACKEND_DIR)
    })

    it('creates worktrees for each sub-repo maintaining directory structure', async () => {
      const result = await createGitWorkspace(REPO_DIR, WS_ROOT, 'fix-bug', multiRepoConfig)

      expect(result.path).toBe(join(WS_ROOT, 'fix-bug'))
      expect(result.created).toBe(true)
      expect(existsSync(join(result.path, 'frontend', 'README.md'))).toBe(true)
      expect(existsSync(join(result.path, 'backend', 'README.md'))).toBe(true)
    })
  })

  describe('removeGitWorkspace', () => {
    beforeEach(async () => {
      await initGitRepo(REPO_DIR)
    })

    it('removes a workspace', async () => {
      const result = await createGitWorkspace(REPO_DIR, WS_ROOT, 'fix-bug', singleRepoConfig)
      expect(existsSync(result.path)).toBe(true)

      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'fix-bug', singleRepoConfig)
      expect(existsSync(result.path)).toBe(false)
    })

    it('is a no-op if workspace does not exist', async () => {
      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'nonexistent', singleRepoConfig)
      // No error thrown
    })

    // beforeRemove is the caller's authoritative occupancy re-check, executed
    // inside the workspace mutex immediately before any filesystem work. A
    // throw must abort the removal with the worktree untouched.
    it('aborts with nothing removed when beforeRemove throws', async () => {
      const result = await createGitWorkspace(REPO_DIR, WS_ROOT, 'guarded', singleRepoConfig)
      expect(existsSync(result.path)).toBe(true)

      const beforeRemove = vi.fn().mockRejectedValue(new Error('workspace is occupied'))
      await expect(
        removeGitWorkspace(REPO_DIR, WS_ROOT, 'guarded', singleRepoConfig, { beforeRemove }),
      ).rejects.toThrow('workspace is occupied')

      expect(beforeRemove).toHaveBeenCalledTimes(1)
      expect(existsSync(result.path)).toBe(true)

      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'guarded', singleRepoConfig)
    })

    // Creation and removal of the same worktree must never interleave: the
    // shared mutex key makes a removal issued mid-create wait for the create
    // to settle (and vice versa), instead of `git worktree remove --force`
    // racing `git worktree add` on the same path.
    it('serializes removal behind an in-flight create on the same worktree', async () => {
      // Issued concurrently, with the removal queued while the create is
      // mid-flight. If the mutex holds, beforeRemove observes a COMPLETE
      // worktree (git registration finished), never a half-created one.
      let worktreeCompleteAtRecheck: boolean | undefined
      const createPromise = createGitWorkspace(REPO_DIR, WS_ROOT, 'serial', singleRepoConfig)
      const removePromise = removeGitWorkspace(REPO_DIR, WS_ROOT, 'serial', singleRepoConfig, {
        beforeRemove: async () => {
          const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
            cwd: REPO_DIR,
          })
          worktreeCompleteAtRecheck =
            existsSync(join(WS_ROOT, 'serial')) && stdout.includes(join(WS_ROOT, 'serial'))
        },
      })

      await Promise.all([createPromise, removePromise])

      expect(worktreeCompleteAtRecheck).toBe(true)
      expect(existsSync(join(WS_ROOT, 'serial'))).toBe(false)
    })

    it('deletes the local branch when removing a worktree that checked out a branch', async () => {
      // 语义：workspace 是云端 Agent 的一次性环境，未 push 的提交随清理一并丢弃。
      // 这样同名 branch 下次复用不会拿到陈旧代码。
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-new', singleRepoConfig, {
        branch: 'feat-new',
      })
      // 确认主 repo 已有该 branch
      const { stdout: before } = await execFileAsync('git', ['branch', '--list', 'feat-new'], {
        cwd: REPO_DIR,
      })
      expect(before.trim()).toMatch(/feat-new/)

      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-new', singleRepoConfig)

      const { stdout: after } = await execFileAsync('git', ['branch', '--list', 'feat-new'], {
        cwd: REPO_DIR,
      })
      expect(after.trim()).toBe('')
    })

    it('deletes the local branch even for a pre-existing branch (cloud-agent semantics)', async () => {
      // 把"预先存在的 branch"也一并删，避免残留累积 + 下次同名复用拿到陈旧代码。
      await execFileAsync('git', ['branch', 'pre-existing'], { cwd: REPO_DIR })
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-pre', singleRepoConfig, {
        branch: 'pre-existing',
      })
      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-pre', singleRepoConfig)

      const { stdout } = await execFileAsync('git', ['branch', '--list', 'pre-existing'], {
        cwd: REPO_DIR,
      })
      expect(stdout.trim()).toBe('')
    })

    it('does not touch any branch when worktree is detached', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-detached', singleRepoConfig)
      const { stdout: beforeList } = await execFileAsync('git', ['branch', '--list'], {
        cwd: REPO_DIR,
      })

      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-detached', singleRepoConfig)

      const { stdout: afterList } = await execFileAsync('git', ['branch', '--list'], {
        cwd: REPO_DIR,
      })
      expect(afterList).toBe(beforeList)
    })

    it('deletes branches from every sub-repo in multi-repo mode', async () => {
      const FRONTEND_DIR = join(REPO_DIR, 'frontend')
      const BACKEND_DIR = join(REPO_DIR, 'backend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(FRONTEND_DIR)
      await initGitRepo(BACKEND_DIR)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
          { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
        ],
      }
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-multi', multiRepoConfig, {
        branch: 'feat-multi',
      })
      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-multi', multiRepoConfig)

      const { stdout: f } = await execFileAsync('git', ['branch', '--list', 'feat-multi'], {
        cwd: FRONTEND_DIR,
      })
      const { stdout: b } = await execFileAsync('git', ['branch', '--list', 'feat-multi'], {
        cwd: BACKEND_DIR,
      })
      expect(f.trim()).toBe('')
      expect(b.trim()).toBe('')
    })

    it('removes a multi-repo workspace carrying the platform CodeGraph link', async () => {
      const frontendDir = join(REPO_DIR, 'frontend')
      const backendDir = join(REPO_DIR, 'backend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      await initGitRepo(backendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
          { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
        ],
      }
      const created = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-codegraph', multiRepoConfig)
      // The platform links the source's CodeGraph index into every workspace.
      const indexDir = join(TEST_DIR, 'source-codegraph')
      await mkdir(indexDir, { recursive: true })
      await symlink(indexDir, join(created.path, '.codegraph'), 'dir')

      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-codegraph', multiRepoConfig)
      expect(existsSync(created.path)).toBe(false)
      // Removing the link must never follow it into the shared index.
      expect(existsSync(indexDir)).toBe(true)
    })

    it('removes a multi-repo workspace carrying skill mounts and MCP configs', async () => {
      // Every run writes provider-specific entries at the workspace root
      // (.claude skill mounts, .mcp.json, .cursor, ...). Removal must treat
      // all of them as platform output — hardcoding one name at a time is how
      // .codegraph wedged removal before.
      const frontendDir = join(REPO_DIR, 'frontend')
      const backendDir = join(REPO_DIR, 'backend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      await initGitRepo(backendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
          { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
        ],
      }
      const created = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-mounts', multiRepoConfig)
      await mkdir(join(created.path, '.claude', 'skills', 'my-skill'), { recursive: true })
      await writeFile(join(created.path, '.claude', 'skills', 'my-skill', 'SKILL.md'), 'x')
      await writeFile(join(created.path, '.mcp.json'), '{}')
      await writeFile(join(created.path, '.mcp.json.a2wave-managed'), '{}')
      await mkdir(join(created.path, '.cursor'), { recursive: true })
      await writeFile(join(created.path, '.cursor', 'mcp.json'), '{}')
      await mkdir(join(created.path, '.kb'), { recursive: true })
      await writeFile(join(created.path, '.kb', 'doc.md'), '# kb')

      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-mounts', multiRepoConfig)
      expect(existsSync(created.path)).toBe(false)
    })

    it('names content the platform did not write before removing it', async () => {
      // The platform writes .claude/skills; a repo or the CLI itself may put
      // settings.json / hooks in the same root. The workspace is going away
      // either way — refusing would wedge every TTL sweep — but the removal
      // must not be silent about deleting something it never wrote.
      const frontendDir = join(REPO_DIR, 'frontend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
        ],
      }
      const created = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-user-files', multiRepoConfig)
      await mkdir(join(created.path, '.claude', 'skills', 'mounted'), { recursive: true })
      await writeFile(join(created.path, '.claude', 'skills', 'mounted', 'SKILL.md'), 'platform')
      await writeFile(join(created.path, '.claude', 'settings.local.json'), '{}')

      const warn = vi.spyOn(logger, 'warn')
      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-user-files', multiRepoConfig)

      expect(existsSync(created.path)).toBe(false)
      const named = warn.mock.calls.some(
        (call) =>
          (call[0] as { leftovers?: string[] })?.leftovers?.includes('settings.local.json') ??
          false,
      )
      expect(named).toBe(true)
      warn.mockRestore()
    })

    it('removes a workspace where a shared root exists as a plain file', async () => {
      // The leftover-naming pass reads each shared root with readdir, which
      // throws ENOTDIR on a plain file. Skipping it on that error leaves the
      // file behind and the final rmdir fails ENOTEMPTY — wedging every later
      // TTL sweep of this workspace.
      const frontendDir = join(REPO_DIR, 'frontend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
        ],
      }
      const created = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-file-root', multiRepoConfig)
      await writeFile(join(created.path, '.claude'), 'not a directory')

      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-file-root', multiRepoConfig)
      expect(existsSync(created.path)).toBe(false)
    })

    it('removes a multi-repo workspace where .codegraph is a real directory', async () => {
      // A cwd-relative CodeGraph CLI can materialize a real index directory in
      // the workspace when the link was absent — a disposable cache that must
      // not wedge removal (plain rm throws EISDIR on directories).
      const frontendDir = join(REPO_DIR, 'frontend')
      const backendDir = join(REPO_DIR, 'backend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      await initGitRepo(backendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
          { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
        ],
      }
      const created = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-cg-dir', multiRepoConfig)
      await mkdir(join(created.path, '.codegraph'), { recursive: true })
      await writeFile(join(created.path, '.codegraph', 'index.db'), 'cache')

      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-cg-dir', multiRepoConfig)
      expect(existsSync(created.path)).toBe(false)
    })

    it('removes platform-created artifacts and interrupted state writes in multi-repo mode', async () => {
      const frontendDir = join(REPO_DIR, 'frontend')
      const backendDir = join(REPO_DIR, 'backend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      await initGitRepo(backendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
          { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
        ],
      }
      const created = await createGitWorkspace(
        REPO_DIR,
        WS_ROOT,
        'ws-with-artifacts',
        multiRepoConfig,
      )
      const outsideArtifacts = join(TEST_DIR, 'outside-artifacts')
      await mkdir(outsideArtifacts, { recursive: true })
      await writeFile(join(outsideArtifacts, 'keep.txt'), 'must survive')
      await mkdir(join(created.path, 'artifacts'), { recursive: true })
      await writeFile(join(created.path, 'artifacts', 'report.txt'), 'generated output')
      await symlink(outsideArtifacts, join(created.path, 'artifacts', 'outside-link'))
      await writeFile(join(created.path, '.a2wave-workspace.json.deadbeef.tmp'), '{}')

      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-with-artifacts', multiRepoConfig)

      expect(existsSync(created.path)).toBe(false)
      expect(existsSync(join(outsideArtifacts, 'keep.txt'))).toBe(true)
    })

    it('rebuilds an empty multi-repo parent left by an interrupted create', async () => {
      const frontendDir = join(REPO_DIR, 'frontend')
      const backendDir = join(REPO_DIR, 'backend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      await initGitRepo(backendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
          { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
        ],
      }
      const wsPath = join(WS_ROOT, 'ws-incomplete')
      await mkdir(wsPath, { recursive: true })

      const rebuilt = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-incomplete', multiRepoConfig)

      expect(rebuilt.created).toBe(true)
      expect(existsSync(join(rebuilt.path, 'frontend', 'README.md'))).toBe(true)
      expect(existsSync(join(rebuilt.path, 'backend', 'README.md'))).toBe(true)
    })

    it('advances multi-repo workspaces all-or-nothing', async () => {
      // Advancing one sub-repo while another pins leaves the agent with repos at
      // commits that never coexisted upstream, and nothing downstream can see
      // it. One pinned repo therefore pins the whole workspace.
      const frontendDir = join(REPO_DIR, 'frontend')
      const backendDir = join(REPO_DIR, 'backend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      await initGitRepo(backendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
          { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
        ],
      }
      const first = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', multiRepoConfig, {
        followSource: true,
      })
      const headOf = async (cwd: string) =>
        (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
      const pinnedFrontendHead = await headOf(join(first.path, 'frontend'))

      // backend pins (tracked modification); both source repos move on.
      await writeFile(join(first.path, 'backend', 'README.md'), 'agent edit')
      for (const dir of [frontendDir, backendDir]) {
        await writeFile(join(dir, 'upstream.txt'), 'moved')
        await execFileAsync('git', ['add', '.'], { cwd: dir })
        await execFileAsync('git', ['commit', '-m', 'upstream'], { cwd: dir })
      }

      const reused = await createGitWorkspace(REPO_DIR, WS_ROOT, 'agent-1', multiRepoConfig, {
        followSource: true,
      })

      // frontend could have advanced on its own — it must not have.
      expect(await headOf(join(reused.path, 'frontend'))).toBe(pinnedFrontendHead)
      expect(existsSync(join(reused.path, 'frontend', 'upstream.txt'))).toBe(false)
      expect(await readFile(join(reused.path, 'backend', 'README.md'), 'utf8')).toBe('agent edit')
    })

    it('keeps a per-agent branch when a multi-repo create rolls back', async () => {
      // Rollback is the third removal call in this function; rebuild and the
      // route were fixed first. It runs on the explicit path too, where
      // followSource is never set, so the flag alone cannot decide.
      const frontendDir = join(REPO_DIR, 'frontend')
      const backendDir = join(REPO_DIR, 'backend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      await initGitRepo(backendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
          { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
        ],
      }
      const wsName = 'agent-abcdefghij123456'

      // The branch pre-exists with an unmerged commit — an earlier run's work.
      const scratch = join(TEST_DIR, 'scratch-rollback')
      await execFileAsync('git', ['worktree', 'add', '-b', wsName, scratch, 'main'], {
        cwd: frontendDir,
      })
      await writeFile(join(scratch, 'unpushed.txt'), 'agent work')
      await execFileAsync('git', ['add', '.'], { cwd: scratch })
      await execFileAsync('git', ['commit', '-m', 'agent work'], { cwd: scratch })
      const { stdout: branchTipBefore } = await execFileAsync('git', ['rev-parse', wsName], {
        cwd: scratch,
      })
      await execFileAsync('git', ['worktree', 'remove', scratch], { cwd: frontendDir })

      // Break the second repo so its `worktree add` fails and create rolls back.
      await rm(join(backendDir, '.git'), { recursive: true, force: true })

      await expect(
        createGitWorkspace(REPO_DIR, WS_ROOT, wsName, multiRepoConfig, { branch: wsName }),
      ).rejects.toThrow()

      const { stdout: branchTipAfter } = await execFileAsync(
        'git',
        ['rev-parse', `refs/heads/${wsName}`],
        { cwd: frontendDir },
      )
      expect(branchTipAfter.trim()).toBe(branchTipBefore.trim())
    })

    it('keeps a per-agent branch when an incomplete workspace is rebuilt without followSource', async () => {
      // The rebuild's keepBranches came from the followSource flag alone, but a
      // grandfathered sticky config reaches the very same worktree through the
      // explicit path, which never sets it — and the branch may hold the only
      // copy of the agent's unpushed commits.
      const frontendDir = join(REPO_DIR, 'frontend')
      const backendDir = join(REPO_DIR, 'backend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      await initGitRepo(backendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
          { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
        ],
      }
      const wsName = 'agent-abcdefghij123456'
      const created = await createGitWorkspace(REPO_DIR, WS_ROOT, wsName, multiRepoConfig, {
        followSource: true,
      })
      const wsFrontend = join(created.path, 'frontend')
      await writeFile(join(wsFrontend, 'agent-work.txt'), 'unpushed')
      await execFileAsync('git', ['add', '.'], { cwd: wsFrontend })
      await execFileAsync('git', ['commit', '-m', 'agent work'], { cwd: wsFrontend })
      const { stdout: agentCommit } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: wsFrontend,
      })

      // Half-destroyed workspace → the reuse branch takes the rebuild path.
      await execFileAsync('git', ['worktree', 'remove', '--force', join(created.path, 'backend')], {
        cwd: backendDir,
      })
      await createGitWorkspace(REPO_DIR, WS_ROOT, wsName, multiRepoConfig)

      const { stdout: branchTip } = await execFileAsync(
        'git',
        ['rev-parse', `refs/heads/${wsName}`],
        { cwd: frontendDir },
      )
      expect(branchTip.trim()).toBe(agentCommit.trim())
    })

    it('refuses multi-repo deletion when the parent contains an unexpected entry', async () => {
      const frontendDir = join(REPO_DIR, 'frontend')
      const backendDir = join(REPO_DIR, 'backend')
      await rm(REPO_DIR, { recursive: true, force: true })
      await mkdir(REPO_DIR, { recursive: true })
      await initGitRepo(frontendDir)
      await initGitRepo(backendDir)
      const multiRepoConfig: GitConfig = {
        ...singleRepoConfig,
        repos: [
          { repoUrl: 'https://example.com/frontend.git', branch: 'main', directory: 'frontend' },
          { repoUrl: 'https://example.com/backend.git', branch: 'main', directory: 'backend' },
        ],
      }
      const created = await createGitWorkspace(
        REPO_DIR,
        WS_ROOT,
        'ws-with-unexpected-entry',
        multiRepoConfig,
      )
      await writeFile(join(created.path, 'operator-data.txt'), 'must survive')

      await expect(
        removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-with-unexpected-entry', multiRepoConfig),
      ).rejects.toThrow(/unexpected entries/)

      expect(existsSync(join(created.path, 'operator-data.txt'))).toBe(true)
      expect(existsSync(join(created.path, 'frontend', 'README.md'))).toBe(true)
      expect(existsSync(join(created.path, 'backend', 'README.md'))).toBe(true)
    })

    it('does not touch unrelated branches', async () => {
      await execFileAsync('git', ['branch', 'other'], { cwd: REPO_DIR })
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-x', singleRepoConfig, { branch: 'feat-x' })
      await removeGitWorkspace(REPO_DIR, WS_ROOT, 'ws-x', singleRepoConfig)

      const { stdout } = await execFileAsync('git', ['branch', '--list', 'other'], {
        cwd: REPO_DIR,
      })
      expect(stdout.trim()).toMatch(/other/)
      const { stdout: main } = await execFileAsync('git', ['branch', '--list', 'main'], {
        cwd: REPO_DIR,
      })
      expect(main.trim()).toMatch(/main/)
    })

    it.each([
      ['parent traversal', '../evil'],
      ['absolute path', '/etc/passwd'],
      ['contains slash', 'foo/bar'],
      ['dot', '.'],
      ['double dot', '..'],
      ['whitespace', 'foo bar'],
      ['shell metachar', 'foo;rm'],
      ['empty', ''],
    ])('rejects invalid workspace name and does not touch disk (%s)', async (_desc, name) => {
      // Seed a sibling directory that traversal would otherwise hit.
      const sibling = join(TEST_DIR, 'sibling')
      await mkdir(sibling, { recursive: true })
      await writeFile(join(sibling, 'keep.txt'), 'keep')

      await expect(removeGitWorkspace(REPO_DIR, WS_ROOT, name, singleRepoConfig)).rejects.toThrow(
        /Invalid workspace name/,
      )

      // Filesystem outside wsRoot must be untouched.
      expect(existsSync(join(sibling, 'keep.txt'))).toBe(true)
    })
  })

  describe('listGitWorkspaces', () => {
    beforeEach(async () => {
      await initGitRepo(REPO_DIR)
    })

    it('returns empty array when no workspaces exist', async () => {
      const result = await listGitWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig)
      expect(result).toEqual([])
    })

    it('lists created workspaces with branch info', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-a', singleRepoConfig)
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-b', singleRepoConfig)

      const result = await listGitWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig)
      expect(result).toHaveLength(2)

      const names = result.map((w) => w.name).sort()
      expect(names).toEqual(['ws-a', 'ws-b'])

      // Detached HEAD → branch should be null
      for (const ws of result) {
        expect(ws.repos).toHaveLength(1)
        expect(ws.repos[0].directory).toBe('')
        expect(ws.repos[0].branch).toBeNull()
        expect(ws.repos[0].commit).toBeTruthy()
        expect(ws.repos[0].error).toBeUndefined()
      }
    })

    it('shows branch after checkout', async () => {
      const { path: wsPath } = await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-a', singleRepoConfig)
      await execFileAsync('git', ['checkout', '-b', 'feature-x'], { cwd: wsPath })

      const result = await listGitWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig)
      expect(result).toHaveLength(1)
      expect(result[0].repos[0].branch).toBe('feature-x')
    })
  })

  describe('createScmSource — real git create + remove round-trip', () => {
    beforeEach(async () => {
      await initGitRepo(REPO_DIR)
    })

    /**
     * Exercises the complete ephemeral cleanup path through real Git commands:
     * createScmSource(git) -> createWorkspace -> removeWorkspace.
     * The stored-path database assertion is injected because unit tests never
     * connect to a real database; its behavior is covered by its own tests.
     */
    it('creates and removes a worktree via scm-source wrapper without mocking Git', async () => {
      const source = await createScmSource({
        id: `scm__round-trip-${Date.now()}`,
        type: 'git',
        localPath: REPO_DIR,
        workspacesPath: WS_ROOT,
        name: 'round-trip',
        config: singleRepoConfig as unknown as Record<string, unknown>,
      })
      expect(source).not.toBeNull()
      if (!source) throw new Error('Expected a Git SCM source')

      const created = await source.createWorkspace('ephemeral-ws')
      expect(created.created).toBe(true)
      expect(existsSync(created.path)).toBe(true)

      // The new worktree must be registered with Git.
      const { stdout: beforeRemove } = await execFileAsync('git', ['worktree', 'list'], {
        cwd: REPO_DIR,
      })
      expect(beforeRemove).toContain('ephemeral-ws')

      await source.removeWorkspace('ephemeral-ws')
      expect(existsSync(created.path)).toBe(false)

      // Removal must also clear the Git worktree registration.
      const { stdout: afterRemove } = await execFileAsync('git', ['worktree', 'list'], {
        cwd: REPO_DIR,
      })
      expect(afterRemove).not.toContain('ephemeral-ws')
    })

    it('refuses to delete an unregistered directory under workspacesPath', async () => {
      const unmanaged = join(WS_ROOT, 'unmanaged')
      await mkdir(unmanaged, { recursive: true })
      await writeFile(join(unmanaged, 'keep.txt'), 'must survive')

      await expect(
        removeGitWorkspace(REPO_DIR, WS_ROOT, 'unmanaged', singleRepoConfig),
      ).rejects.toThrow(/registered Git worktree/)
      expect(existsSync(join(unmanaged, 'keep.txt'))).toBe(true)
    })

    it('refuses a workspace symlink that resolves outside workspacesPath', async () => {
      const outside = join(TEST_DIR, 'platform-data')
      await mkdir(outside, { recursive: true })
      await writeFile(join(outside, 'keep.txt'), 'must survive')
      await mkdir(WS_ROOT, { recursive: true })
      await symlink(outside, join(WS_ROOT, 'linked'))

      await expect(
        removeGitWorkspace(REPO_DIR, WS_ROOT, 'linked', singleRepoConfig),
      ).rejects.toThrow(/outside the configured workspaces root/)
      expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
      expect(existsSync(join(WS_ROOT, 'linked'))).toBe(true)
    })
  })

  // ============================================================
  // 状态文件 + TTL 清理
  // ============================================================
  describe('workspace state file', () => {
    beforeEach(async () => {
      await initGitRepo(REPO_DIR)
    })

    it('writeWorkspaceState + readWorkspaceState round-trip，mtime 对应 lastActivityAt', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws1', singleRepoConfig)
      const wsPath = join(WS_ROOT, 'ws1')

      await writeWorkspaceState(wsPath, { cleanup: 'ttl', lastRunId: 'run__abc' })
      const { state, lastActivityAt } = await readWorkspaceState(wsPath)
      expect(state).toEqual({ cleanup: 'ttl', lastRunId: 'run__abc' })
      expect(lastActivityAt).not.toBeNull()

      const fileStat = await stat(join(wsPath, WORKSPACE_STATE_FILE))
      expect(lastActivityAt).toBe(fileStat.mtimeMs)
    })

    it('readWorkspaceState 缺失文件 → state=null, lastActivityAt=null', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-no-state', singleRepoConfig)
      const result = await readWorkspaceState(join(WS_ROOT, 'ws-no-state'))
      expect(result.state).toBeNull()
      expect(result.lastActivityAt).toBeNull()
    })

    it('readWorkspaceState 损坏 JSON → 降级为 null 而非抛错', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-corrupt', singleRepoConfig)
      const wsPath = join(WS_ROOT, 'ws-corrupt')
      await writeFile(join(wsPath, WORKSPACE_STATE_FILE), '{not-valid-json', 'utf8')

      const result = await readWorkspaceState(wsPath)
      expect(result.state).toBeNull()
      expect(result.lastActivityAt).toBeNull()
    })

    it('并发 writeWorkspaceState：last-rename-wins，内容合法（非半写状态）', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'ws-concurrent', singleRepoConfig)
      const wsPath = join(WS_ROOT, 'ws-concurrent')

      await Promise.all([
        await writeWorkspaceState(wsPath, { cleanup: 'ephemeral', lastRunId: 'run__1' }),
        await writeWorkspaceState(wsPath, { cleanup: 'ttl', lastRunId: 'run__2' }),
        await writeWorkspaceState(wsPath, { cleanup: 'persistent', lastRunId: 'run__3' }),
      ])

      const { state } = await readWorkspaceState(wsPath)
      expect(state).not.toBeNull()
      // 不保证哪个胜出，但必须是其中一个完整值，不会是半写
      expect(['ephemeral', 'ttl', 'persistent']).toContain(state!.cleanup)
      expect(['run__1', 'run__2', 'run__3']).toContain(state!.lastRunId!)
    })

    it('listGitWorkspaces 按 lastActivityAt 倒序，返回 cleanup/lastRunId 字段', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'old', singleRepoConfig)
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'new', singleRepoConfig)
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'nostate', singleRepoConfig)

      await writeWorkspaceState(join(WS_ROOT, 'old'), { cleanup: 'ttl', lastRunId: 'r1' })
      // 手动把 old 的 mtime 往前调
      const oldPath = join(WS_ROOT, 'old', WORKSPACE_STATE_FILE)
      const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      await utimes(oldPath, past, past)

      await writeWorkspaceState(join(WS_ROOT, 'new'), { cleanup: 'persistent', lastRunId: 'r2' })

      const list = await listGitWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig)
      expect(list.map((w) => w.name)).toEqual(['new', 'old', 'nostate'])
      expect(list[0].cleanup).toBe('persistent')
      expect(list[0].lastRunId).toBe('r2')
      expect(list[2].cleanup).toBeNull()
      expect(list[2].lastActivityAt).toBeNull()
    })
  })

  describe('cleanupStaleWorkspaces', () => {
    beforeEach(async () => {
      await initGitRepo(REPO_DIR)
    })

    it('idle > idleDays 的 ttl workspace 被删', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'stale', singleRepoConfig)
      await writeWorkspaceState(join(WS_ROOT, 'stale'), { cleanup: 'ttl' })
      const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      await utimes(join(WS_ROOT, 'stale', WORKSPACE_STATE_FILE), past, past)

      const removed = await cleanupStaleWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig, {
        activePaths: new Set(),
      })
      expect(removed).toContain('stale')
      expect(existsSync(join(WS_ROOT, 'stale'))).toBe(false)
    })

    // The caller-supplied removal executor is the guarded protocol (durable
    // reservation + fresh occupancy re-check): activePaths is a snapshot, and
    // a workload can claim a candidate AFTER it was taken. A throw from the
    // guard means "occupied now" and must degrade to a skip, not a failure.
    it('delegates removal to opts.removeWorkspace and records a thrown block as a skip', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'guarded-stale', singleRepoConfig)
      await writeWorkspaceState(join(WS_ROOT, 'guarded-stale'), { cleanup: 'ttl' })
      const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      await utimes(join(WS_ROOT, 'guarded-stale', WORKSPACE_STATE_FILE), past, past)

      const blockedRemove = vi.fn().mockRejectedValue(new Error('claimed after snapshot'))
      const blockedRun = await cleanupStaleWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig, {
        activePaths: new Set(),
        removeWorkspace: blockedRemove,
      })
      expect(blockedRemove).toHaveBeenCalledWith('guarded-stale')
      expect(blockedRun).toEqual([])
      expect(existsSync(join(WS_ROOT, 'guarded-stale'))).toBe(true)

      const allowedRemove = vi.fn((name: string) =>
        removeGitWorkspace(REPO_DIR, WS_ROOT, name, singleRepoConfig),
      )
      const allowedRun = await cleanupStaleWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig, {
        activePaths: new Set(),
        removeWorkspace: allowedRemove,
      })
      expect(allowedRun).toContain('guarded-stale')
      expect(existsSync(join(WS_ROOT, 'guarded-stale'))).toBe(false)
    })

    it('persistent / 无状态文件 / 新 ttl 都不删', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'pinned', singleRepoConfig)
      await writeWorkspaceState(join(WS_ROOT, 'pinned'), { cleanup: 'persistent' })
      const past = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
      await utimes(join(WS_ROOT, 'pinned', WORKSPACE_STATE_FILE), past, past)

      await createGitWorkspace(REPO_DIR, WS_ROOT, 'nostate', singleRepoConfig)

      await createGitWorkspace(REPO_DIR, WS_ROOT, 'fresh', singleRepoConfig)
      await writeWorkspaceState(join(WS_ROOT, 'fresh'), { cleanup: 'ttl' })

      const removed = await cleanupStaleWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig, {
        activePaths: new Set(),
      })
      expect(removed).toEqual([])
    })

    it('dirty ttl workspace 不删', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'dirty', singleRepoConfig)
      await writeWorkspaceState(join(WS_ROOT, 'dirty'), { cleanup: 'ttl' })
      await writeFile(join(WS_ROOT, 'dirty', 'untracked.txt'), 'x')
      const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      await utimes(join(WS_ROOT, 'dirty', WORKSPACE_STATE_FILE), past, past)

      const removed = await cleanupStaleWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig, {
        activePaths: new Set(),
      })
      expect(removed).toEqual([])
      expect(existsSync(join(WS_ROOT, 'dirty'))).toBe(true)
    })

    it('activePaths 中的 ttl 不删（即便 idle）', async () => {
      await createGitWorkspace(REPO_DIR, WS_ROOT, 'busy', singleRepoConfig)
      await writeWorkspaceState(join(WS_ROOT, 'busy'), { cleanup: 'ttl' })
      const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      await utimes(join(WS_ROOT, 'busy', WORKSPACE_STATE_FILE), past, past)

      const removed = await cleanupStaleWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig, {
        activePaths: new Set([join(WS_ROOT, 'busy')]),
      })
      expect(removed).toEqual([])
    })

    it('LRU：超过 lruCap 的 ttl 从最旧开始淘汰', async () => {
      // 建 3 个全新 ttl，lruCap=2 → 最旧的 1 个被删
      const baseTime = Date.now()
      for (const [i, name] of ['a', 'b', 'c'].entries()) {
        await createGitWorkspace(REPO_DIR, WS_ROOT, name, singleRepoConfig)
        await writeWorkspaceState(join(WS_ROOT, name), { cleanup: 'ttl' })
        const t = new Date(baseTime - (3 - i) * 60_000) // a 最早，c 最新
        await utimes(join(WS_ROOT, name, WORKSPACE_STATE_FILE), t, t)
      }

      const removed = await cleanupStaleWorkspaces(REPO_DIR, WS_ROOT, singleRepoConfig, {
        activePaths: new Set(),
        idleDays: 365, // 不让 idle 触发
        lruCap: 2,
      })
      expect(removed).toEqual(['a'])
    })
  })
})
