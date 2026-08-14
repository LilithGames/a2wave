import { PROVIDER_CHAIN_MAX } from '@a2wave/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProviderConfigurationError,
  ProviderMcpUnsupportedError,
  UnusableProviderChainError,
} from '../errors.js'

// --- Mocks ---

const mockDbSelect = vi.fn()
const mockDbFrom = vi.fn()
const mockDbWhere = vi.fn()
const mockDbGet = vi.fn()
const mockDbAll = vi.fn()

const { mockDbUpdate, mockDbUpdateSet, mockDbUpdateWhere, mockDbUpdateRun } = vi.hoisted(() => {
  const update = vi.fn()
  const set = vi.fn()
  const where = vi.fn()
  const run = vi.fn()
  update.mockImplementation(() => asyncQuery({ set }))
  set.mockImplementation(() => asyncQuery({ where }))
  where.mockImplementation(() => asyncQuery({ run }))
  return {
    mockDbUpdate: update,
    mockDbUpdateSet: set,
    mockDbUpdateWhere: where,
    mockDbUpdateRun: run,
  }
})

vi.mock('../../db/client.js', () => {
  const dbMock = {
    select: () => ({ from: mockDbFrom }),
    update: mockDbUpdate,
    // Audit inserts (logBackgroundAudit) go through this; swallow them.
    insert: () => ({ values: () => asyncQuery({ run: () => ({ changes: 1 }) }) }),
    // transaction 在 better-sqlite3 中是同步执行 callback，mock 透传 dbMock 本身
    // 作为 tx 参数，让被测代码内部的 select/update 调用走到同一套 mock 上。
    transaction: (cb: (tx: unknown) => unknown) => cb(dbMock),
  }
  // db/transaction.ts reads isPostgres + sqliteDatabase at module load, so the
  // mock must expose them or importing agent-helpers throws.
  return { db: dbMock, isPostgres: false, sqliteDatabase: { inTransaction: false, exec: vi.fn() } }
})

vi.mock('../../db/schema.js', () => ({
  agents: { id: 'agents.id' },
  providers: { id: 'providers.id' },
  skills: { id: 'skills.id', groupId: 'skills.groupId' },
  scmSources: { id: 'scmSources.id' },
  mcpServers: { id: 'mcpServers.id' },
  kbDocuments: { id: 'kbDocuments.id' },
  users: { id: 'users.id', role: 'users.role', isActive: 'users.isActive' },
  auditLogs: {},
  runs: { id: 'runs.id', workDir: 'runs.workDir', status: 'runs.status' },
  scmWorkspaceRemovals: {
    id: 'scmWorkspaceRemovals.id',
    scmSourceId: 'scmWorkspaceRemovals.scmSourceId',
    workspaceName: 'scmWorkspaceRemovals.workspaceName',
  },
  settings: {},
}))

const mockCreateScmSource = vi.hoisted(() => vi.fn())
vi.mock('../scm-source.js', () => ({
  createScmSource: mockCreateScmSource,
}))

const mockExistsSync = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: mockExistsSync }
})

vi.mock('../../engine/mcp-sync.js', () => ({}))

vi.mock('../seed-builtin-mcp.js', () => ({
  resolveBuiltinMcpConfig: vi.fn().mockReturnValue({
    command: '/usr/local/bin/node',
    args: ['dist/mcp-servers/a2wave-mcp-group-proxy.js'],
    env: {},
  }),
  isOwnerSafeBuiltinMcp: (name: string, userId: string | null) =>
    userId === null && name === 'a2wave-agent-router',
}))

vi.mock('../settings.js', () => ({
  getCategorySettings: vi.fn().mockReturnValue({ workspacePath: '/workspace' }),
}))

vi.mock('../slug.js', () => ({
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}))

import {
  WorkspaceOccupancyRecordError,
  WorktreeOccupiedError,
  _resetTtlCleanupDebounce,
  buildAgentConfig,
  injectScmEnv,
  removePerAgentWorkspace,
  resolveCleanupWorkDirs,
  resolveWorkDir,
  validateAgentProviderConfiguration,
} from '../agent-helpers.js'

import { asyncQuery } from '../../test/async-query.js'

function chainResult(value: unknown) {
  // An array stands for a multi-row result and must surface through `all`; the
  // adapter consults `get` first, so also exposing it there would wrap the whole
  // array as a single row.
  const terminator = Array.isArray(value)
    ? { all: () => value }
    : { get: () => value, all: () => [] }
  return {
    where: () => asyncQuery(terminator),
  }
}

// Split out of agent-helpers.test.ts, which crossed the 3000-line gate once the async
// DB rewrite expanded its mocks. resolveWorkDir/injectScmEnv form a self-contained
// concern (workspace and env resolution) and reuse only the mock preamble above.

describe('resolveWorkDir', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns SCM source localPath for non-git sources', async () => {
    const source = { id: 'scm_1', type: 'p4', localPath: '/data/repos/my-project' }
    // resolveWorkDir calls db.select().from(scmSources).where(...).get()
    mockDbFrom.mockReturnValueOnce(asyncQuery({ where: () => asyncQuery({ get: () => source }) }))

    const agent = {
      id: 'agt_abc123',
      name: 'Test Agent',
      config: {},
      workspaceType: 'scm',
      scmSourceId: 'scm_1',
    } as any

    expect(await resolveWorkDir(agent)).toBe('/data/repos/my-project')
    expect(mockCreateScmSource).not.toHaveBeenCalled()
  })

  describe('per-agent default worktree (git SCM, no explicit worktree)', () => {
    beforeEach(() => {
      _resetTtlCleanupDebounce()
    })

    function gitAgent(): any {
      return {
        id: 'agt_abc123',
        name: 'Test Agent',
        config: {},
        workspaceType: 'scm',
        scmSourceId: 'scm_1',
      }
    }

    const gitSource = { id: 'scm_1', type: 'git', config: {}, localPath: '/git' }

    /**
     * A run-scoped resolve re-reads the Agent binding before anything else —
     * the check that stops a stale pre-admission snapshot from mounting another
     * source's checkout after a rebind. Tests that pass a runId must queue that
     * row ahead of the source lookup.
     */
    const expectBindingRecheck = () =>
      mockDbFrom.mockReturnValueOnce(chainResult({ workspaceType: 'scm', scmSourceId: 'scm_1' }))

    it('resolves to a followSource worktree with persistent state', async () => {
      mockDbFrom.mockReturnValueOnce(chainResult(gitSource)).mockReturnValueOnce(chainResult([])) // no sibling run → advance allowed
      const createWorkspace = vi
        .fn()
        .mockResolvedValue({ path: '/workspaces/scm_1/agent-abc123', created: true })
      const writeWorkspaceState = vi.fn().mockResolvedValue(undefined)
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace,
        writeWorkspaceState,
        cleanupStale: vi.fn().mockResolvedValue([]),
      })

      expect(await resolveWorkDir(gitAgent())).toBe('/workspaces/scm_1/agent-abc123')
      expect(createWorkspace).toHaveBeenCalledWith('agent-abc123', {
        followSource: true,
        advance: true,
      })
      expect(writeWorkspaceState).toHaveBeenCalledWith('agent-abc123', { cleanup: 'persistent' })
    })

    it('suppresses the advance while a sibling run of the agent is executing', async () => {
      // reset --hard is not a read-only share: advancing under a sibling run
      // would swap the files it is executing. Sharing stays lock-free, but
      // freshness waits for the next solo run.
      expectBindingRecheck()
      mockDbFrom
        .mockReturnValueOnce(chainResult(gitSource))
        .mockReturnValueOnce(chainResult([{ id: 'run_other' }]))
      const createWorkspace = vi
        .fn()
        .mockResolvedValue({ path: '/workspaces/scm_1/agent-abc123', created: false })
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace,
        writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
        cleanupStale: vi.fn().mockResolvedValue([]),
      })

      await resolveWorkDir(gitAgent(), undefined, 'run_1')
      expect(createWorkspace).toHaveBeenCalledWith('agent-abc123', {
        followSource: true,
        advance: false,
      })
    })

    it('records workDir for the run without an occupancy check', async () => {
      // Same-agent runs share the worktree by design: no occupancy error is
      // raised — an occupancy gate would serialize concurrent chat messages.
      expectBindingRecheck()
      mockDbFrom.mockReturnValueOnce(chainResult(gitSource)).mockReturnValueOnce(chainResult([]))
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace: vi
          .fn()
          .mockResolvedValue({ path: '/workspaces/scm_1/agent-abc123', created: false }),
        writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
        cleanupStale: vi.fn().mockResolvedValue([]),
      })

      expect(await resolveWorkDir(gitAgent(), undefined, 'run_1')).toBe(
        '/workspaces/scm_1/agent-abc123',
      )
      expect(mockDbUpdateSet).toHaveBeenCalledWith({ workDir: '/workspaces/scm_1/agent-abc123' })
    })

    it('falls back to the shared checkout when worktree creation fails', async () => {
      mockDbFrom.mockReturnValueOnce(chainResult(gitSource)).mockReturnValueOnce(chainResult([]))
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace: vi.fn().mockRejectedValue(new Error('worktree add failed')),
        writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
      })

      expect(await resolveWorkDir(gitAgent())).toBe('/git')
    })

    it('falls back to the shared checkout when the source does not support workspaces', async () => {
      mockDbFrom.mockReturnValueOnce(chainResult(gitSource))
      mockCreateScmSource.mockReturnValueOnce(null)

      expect(await resolveWorkDir(gitAgent())).toBe('/git')
    })

    it('publishes A2WAVE_WORKSPACE_BRANCH only when the run lands in its worktree', async () => {
      mockDbFrom.mockReturnValueOnce(chainResult(gitSource)).mockReturnValueOnce(chainResult([]))
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace: vi
          .fn()
          .mockResolvedValue({ path: '/workspaces/scm_1/agent-abc123', created: false }),
        writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
        cleanupStale: vi.fn().mockResolvedValue([]),
      })

      const env: Record<string, string> = {}
      await resolveWorkDir(gitAgent(), undefined, undefined, env)
      expect(env.A2WAVE_WORKSPACE_BRANCH).toBe('agent-abc123')
    })

    it('fails the run when the occupancy marker cannot be persisted', async () => {
      // runs.workDir is the only thing that says "this worktree is busy" — the
      // delete route's 409, removePerAgentWorkspace and the sibling probe all
      // read it. Swallowing the write would let an admin delete a running
      // Agent's worktree; falling back would run it in the shared checkout.
      expectBindingRecheck()
      mockDbFrom.mockReturnValueOnce(chainResult(gitSource)).mockReturnValueOnce(chainResult([]))
      // Once per attempt — scoped with `Once` so the rejection does not leak
      // into the next test (clearAllMocks keeps implementations).
      for (let i = 0; i < 3; i++) {
        mockDbUpdateWhere.mockImplementationOnce(() => Promise.reject(new Error('SQLITE_BUSY')))
      }
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace: vi
          .fn()
          .mockResolvedValue({ path: '/workspaces/scm_1/agent-abc123', created: false }),
        writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
        cleanupStale: vi.fn().mockResolvedValue([]),
      })

      await expect(resolveWorkDir(gitAgent(), undefined, 'run_1')).rejects.toBeInstanceOf(
        WorkspaceOccupancyRecordError,
      )
      // Retried before giving up — SQLITE_BUSY is usually transient.
      expect(mockDbUpdateWhere).toHaveBeenCalledTimes(3)
    })

    // Grandfathered sticky configs are normalized away in ONE place, so both a
    // config naming this Agent's own worktree and one naming another Agent's
    // land in the Agent's own per-agent worktree — never on the explicit path,
    // which would write the state file, switch the branch, and expose the
    // workspace to run-end cleanup.
    it.each([
      ['its own worktree', 'agent-abc123def456ghi7'],
      ["another Agent's worktree", 'agent-zzz999yyy888xxx7'],
    ])('normalizes a sticky worktree config naming %s', async (_label, stickyName) => {
      const agent = { ...gitAgent(), id: 'agt_abc123def456ghi7' }
      const wsPath = '/workspaces/scm_1/agent-abc123def456ghi7'
      mockDbFrom.mockReturnValueOnce(chainResult(gitSource)).mockReturnValueOnce(chainResult([]))
      const createWorkspace = vi.fn().mockResolvedValue({ path: wsPath, created: false })
      const writeWorkspaceState = vi.fn().mockResolvedValue(undefined)
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace,
        writeWorkspaceState,
        cleanupStale: vi.fn().mockResolvedValue([]),
      })

      const workDir = await resolveWorkDir(agent, {
        name: stickyName,
        cleanup: 'ephemeral',
        branch: 'feature/x',
      } as any)

      expect(workDir).toBe(wsPath)
      expect(createWorkspace).toHaveBeenCalledWith('agent-abc123def456ghi7', {
        followSource: true,
        advance: true,
      })
      expect(writeWorkspaceState).toHaveBeenCalledWith('agent-abc123def456ghi7', {
        cleanup: 'persistent',
      })
    })

    it('clears the branch env when degrading to the shared checkout', async () => {
      // A stale value would send the agent off to move the shared checkout
      // onto the per-agent branch — the cross-agent interference this feature
      // exists to prevent.
      mockDbFrom.mockReturnValueOnce(chainResult(gitSource)).mockReturnValueOnce(chainResult([]))
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace: vi.fn().mockRejectedValue(new Error('worktree add failed')),
        writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
      })

      const env: Record<string, string> = { A2WAVE_WORKSPACE_BRANCH: 'agent-abc123' }
      expect(await resolveWorkDir(gitAgent(), undefined, undefined, env)).toBe('/git')
      expect(env).not.toHaveProperty('A2WAVE_WORKSPACE_BRANCH')
    })
  })

  it('rejects a stale SCM snapshot after the Agent binding changed during admission', async () => {
    mockDbFrom.mockReturnValueOnce(
      asyncQuery({
        where: () => asyncQuery({ get: () => ({ workspaceType: 'temp', scmSourceId: null }) }),
      }),
    )
    const agent = {
      id: 'agt_abc123',
      name: 'Test Agent',
      config: {},
      workspaceType: 'scm',
      scmSourceId: 'scm_1',
    } as any

    await expect(resolveWorkDir(agent, undefined, 'run_1')).rejects.toThrow(
      'Agent SCM binding changed before workload admission',
    )
  })

  it('returns config.workDir when set within allowed workspace', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_abc123',
      name: 'Test',
      config: { workDir: '/workspace/custom-dir' },
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    expect(await resolveWorkDir(agent)).toBe('/workspace/custom-dir')
  })

  it('falls back to workspace path with slugified name', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_abc123',
      name: 'My Agent',
      config: {},
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await resolveWorkDir(agent)
    expect(result).toContain('/workspace/')
    expect(result).toContain('my-agent')
  })

  describe('worktree mode', () => {
    function worktreeAgent(overrides: Record<string, unknown> = {}): any {
      return {
        id: 'agt_1',
        name: 'Test',
        config: {},
        workspaceType: 'scm',
        scmSourceId: 'scm_1',
        ...overrides,
      }
    }

    it('throws when workspaceType is not scm', async () => {
      const agent = worktreeAgent({ workspaceType: 'temp', scmSourceId: null })
      await expect(resolveWorkDir(agent, { name: 'fix-bug', cleanup: 'ttl' })).rejects.toThrow(
        /requires SCM workspace type/,
      )
    })

    it('throws when worktree name is invalid', async () => {
      const agent = worktreeAgent()
      await expect(
        resolveWorkDir(agent, { name: 'invalid name!', cleanup: 'ttl' }),
      ).rejects.toThrow(/Invalid worktree name/)
    })

    it('grandfathers legacy sticky agent-* names instead of rejecting them', async () => {
      // The reserved-prefix rejection lives at the request entry points; a
      // persisted worktreeConfig from before the rule must keep replaying —
      // this call proceeds past the name gate and fails only on the missing
      // source, proving no reservation error fired.
      mockDbFrom.mockReturnValueOnce(chainResult(undefined))
      const agent = worktreeAgent()
      const env: Record<string, string> = { A2WAVE_WORKSPACE_BRANCH: 'stale' }
      await expect(
        resolveWorkDir(agent, { name: 'agent-legacy1', cleanup: 'ttl' }, undefined, env),
      ).rejects.toThrow(/SCM source .* not found/)
      expect(env).not.toHaveProperty('A2WAVE_WORKSPACE_BRANCH')
    })

    it('throws when SCM source not found', async () => {
      mockDbFrom.mockReturnValueOnce(chainResult(undefined))
      const agent = worktreeAgent()
      await expect(resolveWorkDir(agent, { name: 'fix-bug', cleanup: 'ttl' })).rejects.toThrow(
        /SCM source.*not found/,
      )
    })

    it('throws when scm type does not support workspaces', async () => {
      const source = { id: 'scm_1', type: 'p4', config: {}, localPath: '/p4' }
      mockDbFrom.mockReturnValueOnce(chainResult(source))
      mockCreateScmSource.mockReturnValueOnce(null)

      const agent = worktreeAgent()
      await expect(resolveWorkDir(agent, { name: 'fix-bug', cleanup: 'ttl' })).rejects.toThrow(
        /does not support workspaces/,
      )
    })

    it('throws WorktreeOccupiedError when worktree is occupied', async () => {
      const source = { id: 'scm_1', type: 'git', config: {}, localPath: '/git' }
      mockDbFrom
        .mockReturnValueOnce(chainResult(source))
        .mockReturnValueOnce(chainResult({ id: 'run_active' }))
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace: vi.fn(),
      })

      const agent = worktreeAgent()
      await expect(
        resolveWorkDir(agent, { name: 'fix-bug', cleanup: 'ttl' }),
      ).rejects.toBeInstanceOf(WorktreeOccupiedError)
    })

    // A remover commits its durable reservation BEFORE touching the
    // filesystem — possibly on another replica. Creating or reusing the
    // worktree in that window hands the run a directory about to disappear.
    it('refuses to resolve a worktree with a pending removal reservation', async () => {
      const source = { id: 'scm_1', type: 'git', config: {}, localPath: '/git' }
      const createWorkspace = vi.fn()
      mockDbFrom
        .mockReturnValueOnce(chainResult(source))
        .mockReturnValueOnce(chainResult(undefined)) // not occupied
        .mockReturnValueOnce(chainResult({ id: 'scm_1:fix-bug', workspaceName: 'fix-bug' }))
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace,
      })

      const agent = worktreeAgent()
      await expect(resolveWorkDir(agent, { name: 'fix-bug', cleanup: 'ttl' })).rejects.toThrow(
        /being removed/,
      )
      expect(createWorkspace).not.toHaveBeenCalled()
    })

    it('creates a new worktree', async () => {
      const source = {
        id: 'scm_1',
        type: 'git',
        config: {},
        localPath: '/git',
      }
      mockDbFrom
        .mockReturnValueOnce(chainResult(source))
        .mockReturnValueOnce(chainResult(undefined))
        .mockReturnValueOnce(chainResult(undefined)) // no pending removal reservation

      const createWorkspace = vi.fn().mockResolvedValue({
        path: '/workspaces/scm_1/fix-bug',
        created: true,
      })
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace,
      })
      const agent = worktreeAgent()
      const result = await resolveWorkDir(agent, {
        name: 'fix-bug',
        branch: 'main',
        cleanup: 'ttl',
      })

      expect(result).toBe('/workspaces/scm_1/fix-bug')
      expect(createWorkspace).toHaveBeenCalledWith('fix-bug', { branch: 'main' })
    })

    it('propagates original createWorkspace error even if workDir rollback throws', async () => {
      const source = { id: 'scm_1', type: 'git', config: {}, localPath: '/git' }
      mockDbFrom
        .mockReturnValueOnce(chainResult({ workspaceType: 'scm', scmSourceId: 'scm_1' }))
        .mockReturnValueOnce(chainResult(source))
        .mockReturnValueOnce(chainResult(undefined))
        .mockReturnValueOnce(chainResult(undefined)) // no pending removal reservation

      const createWorkspace = vi.fn().mockRejectedValue(new Error('git clone failed'))
      mockCreateScmSource.mockReturnValueOnce({
        wsRoot: '/workspaces/scm_1',
        createWorkspace,
      })

      // 第 1 次 run = 事务里写入 workDir=wsPath（成功）；第 2 次 run = rollback 清 workDir（抛）。
      // 原 createWorkspace 错误必须继续传播，不能被 rollback 异常遮蔽。
      mockDbUpdateRun.mockReturnValueOnce(undefined).mockImplementationOnce(() => {
        throw new Error('db locked')
      })

      const agent = worktreeAgent()
      await expect(
        resolveWorkDir(agent, { name: 'fix-bug', cleanup: 'ttl' }, 'run_1'),
      ).rejects.toThrow(/git clone failed/)
    })

    describe('triggerTtlCleanup 调度', () => {
      beforeEach(() => {
        _resetTtlCleanupDebounce()
      })

      async function runResolve(
        sourceId: string,
        activeRunsRows: Array<{ workDir: string | null }>,
      ) {
        const source = {
          id: sourceId,
          type: 'git',
          config: {},
          localPath: '/git',
        }
        // Four DB reads: source / occupied check / pending removal / active runs.
        mockDbFrom
          .mockReturnValueOnce(chainResult(source))
          .mockReturnValueOnce(chainResult(undefined))
          .mockReturnValueOnce(chainResult(undefined)) // no pending removal reservation
          .mockReturnValueOnce(chainResult(activeRunsRows))

        const cleanupStale = vi.fn().mockResolvedValue([])
        const writeWorkspaceState = vi.fn().mockResolvedValue(undefined)
        mockCreateScmSource.mockReturnValueOnce({
          wsRoot: `/workspaces/${sourceId}`,
          createWorkspace: vi.fn().mockResolvedValue({
            path: `/workspaces/${sourceId}/ws`,
            created: true,
          }),
          writeWorkspaceState,
          cleanupStale,
        })

        const agent = worktreeAgent({ scmSourceId: sourceId })
        await resolveWorkDir(agent, { name: 'ws', cleanup: 'ttl' })
        // Let the fire-and-forget cleanup settle.
        await new Promise((r) => setImmediate(r))
        return { cleanupStale }
      }

      it('首次调用触发 cleanupStale，activePaths 来自 runs 表', async () => {
        const { cleanupStale } = await runResolve('scm_a', [
          { workDir: '/workspaces/scm_a/busy' },
          { workDir: null },
          { workDir: '/workspaces/scm_a/other' },
        ])
        expect(cleanupStale).toHaveBeenCalledTimes(1)
        const arg = cleanupStale.mock.calls[0][0]
        // activePaths is only the prefilter; authority is the guarded removal
        // protocol handed down here (fresh occupancy re-check per candidate).
        expect(arg.removeWorkspace).toBeTypeOf('function')
        expect(arg.activePaths).toBeInstanceOf(Set)
        expect(Array.from(arg.activePaths).sort()).toEqual([
          '/workspaces/scm_a/busy',
          '/workspaces/scm_a/other',
        ])
      })

      it('1h 内再次调用不重复触发（debounce）', async () => {
        const r1 = await runResolve('scm_b', [])
        expect(r1.cleanupStale).toHaveBeenCalledTimes(1)

        // The second call reads only source + occupied + pending removal;
        // triggerTtlCleanup hits the debounce and does not query active runs.
        const source = {
          id: 'scm_b',
          type: 'git',
          config: {},
          localPath: '/git',
        }
        mockDbFrom
          .mockReturnValueOnce(chainResult(source))
          .mockReturnValueOnce(chainResult(undefined))
          .mockReturnValueOnce(chainResult(undefined))
        const cleanupStale2 = vi.fn().mockResolvedValue([])
        mockCreateScmSource.mockReturnValueOnce({
          wsRoot: '/workspaces/scm_b',
          createWorkspace: vi
            .fn()
            .mockResolvedValue({ path: '/workspaces/scm_b/ws2', created: true }),
          writeWorkspaceState: vi.fn().mockResolvedValue(undefined),
          cleanupStale: cleanupStale2,
        })
        await resolveWorkDir(worktreeAgent({ scmSourceId: 'scm_b' }), {
          name: 'ws2',
          cleanup: 'ttl',
        })
        await new Promise((r) => setImmediate(r))
        expect(cleanupStale2).not.toHaveBeenCalled()
      })

      it('不同 sourceId 的 debounce 互不影响', async () => {
        const r1 = await runResolve('scm_c1', [])
        const r2 = await runResolve('scm_c2', [])
        expect(r1.cleanupStale).toHaveBeenCalledTimes(1)
        expect(r2.cleanupStale).toHaveBeenCalledTimes(1)
      })
    })
  })
})

describe('resolveCleanupWorkDirs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const gitAgent = {
    id: 'agt_abc123',
    name: 'Test Agent',
    config: {},
    workspaceType: 'scm',
    scmSourceId: 'scm_1',
  } as any
  const gitSource = { id: 'scm_1', type: 'git', config: {}, localPath: '/git' }

  it('returns worktree + shared checkout when the worktree exists on disk', async () => {
    mockDbFrom.mockReturnValueOnce(chainResult(gitSource))
    mockCreateScmSource.mockReturnValueOnce({ wsRoot: '/workspaces/scm_1' })
    mockExistsSync.mockReturnValue(true)

    expect(await resolveCleanupWorkDirs(gitAgent)).toEqual([
      '/workspaces/scm_1/agent-abc123',
      '/git',
    ])
  })

  it('returns only the shared checkout when no worktree exists', async () => {
    mockDbFrom.mockReturnValueOnce(chainResult(gitSource))
    mockCreateScmSource.mockReturnValueOnce({ wsRoot: '/workspaces/scm_1' })
    mockExistsSync.mockReturnValue(false)

    expect(await resolveCleanupWorkDirs(gitAgent)).toEqual(['/git'])
  })

  it('returns only localPath for p4 sources', async () => {
    mockDbFrom.mockReturnValueOnce(
      chainResult({ id: 'scm_1', type: 'p4', config: {}, localPath: '/p4root' }),
    )

    expect(await resolveCleanupWorkDirs(gitAgent)).toEqual(['/p4root'])
    expect(mockCreateScmSource).not.toHaveBeenCalled()
  })

  it('degrades to localPath when createScmSource fails', async () => {
    mockDbFrom.mockReturnValueOnce(chainResult(gitSource))
    mockCreateScmSource.mockRejectedValueOnce(new Error('invalid workspaces root'))

    expect(await resolveCleanupWorkDirs(gitAgent)).toEqual(['/git'])
  })

  it('falls back to the default workspace dir when the source row is dangling', async () => {
    // Runs of such an agent execute in resolveWorkDir's non-SCM fallback dir —
    // that is where memory-override files live and must be cleaned from.
    mockDbFrom.mockReturnValueOnce(chainResult(undefined)) // cleanup's source lookup
    mockDbFrom.mockReturnValueOnce(chainResult(undefined)) // resolveWorkDir's source lookup
    const dirs = await resolveCleanupWorkDirs(gitAgent)
    expect(dirs).toHaveLength(1)
    expect(dirs[0]).toContain('/workspace/')
  })
})

describe('removePerAgentWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const gitAgent = {
    id: 'agt_abc123',
    name: 'Test Agent',
    config: {},
    workspaceType: 'scm',
    scmSourceId: 'scm_1',
  } as any

  it('removes the per-agent worktree when it exists and is idle', async () => {
    mockDbFrom
      .mockReturnValueOnce(chainResult({ id: 'scm_1', type: 'git', config: {}, localPath: '/git' }))
      .mockReturnValueOnce(chainResult([])) // no run occupies the worktree
    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    mockCreateScmSource.mockReturnValueOnce({ wsRoot: '/workspaces/scm_1', removeWorkspace })
    mockExistsSync.mockReturnValue(true)

    await removePerAgentWorkspace(gitAgent)
    expect(removeWorkspace).toHaveBeenCalledWith('agent-abc123', { keepBranches: true })
  })

  it('leaves an occupied worktree in place but hands it to the TTL sweeper', async () => {
    // Yanking the cwd from under an in-flight run (e.g. a chat debug on a
    // draft agent) loses its unpushed work. Leaving it as `persistent` leaked
    // it forever though: the Agent row is gone, so no run resolves it again and
    // the sweeper skips persistent workspaces. Demote it to ttl instead.
    mockDbFrom
      .mockReturnValueOnce(chainResult({ id: 'scm_1', type: 'git', config: {}, localPath: '/git' }))
      .mockReturnValueOnce(chainResult([{ id: 'run_active' }]))
    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    const writeWorkspaceState = vi.fn().mockResolvedValue(undefined)
    mockCreateScmSource.mockReturnValueOnce({
      wsRoot: '/workspaces/scm_1',
      removeWorkspace,
      writeWorkspaceState,
    })
    mockExistsSync.mockReturnValue(true)

    await removePerAgentWorkspace(gitAgent)
    expect(removeWorkspace).not.toHaveBeenCalled()
    expect(writeWorkspaceState).toHaveBeenCalledWith('agent-abc123', { cleanup: 'ttl' })
  })

  it('does nothing for non-scm agents and never throws on removal failure', async () => {
    await removePerAgentWorkspace({ id: 'agt_x', workspaceType: 'temp', scmSourceId: null } as any)
    expect(mockCreateScmSource).not.toHaveBeenCalled()

    mockDbFrom
      .mockReturnValueOnce(chainResult({ id: 'scm_1', type: 'git', config: {}, localPath: '/git' }))
      .mockReturnValueOnce(chainResult([]))
    mockCreateScmSource.mockReturnValueOnce({
      wsRoot: '/workspaces/scm_1',
      removeWorkspace: vi.fn().mockRejectedValue(new Error('worktree dirty')),
    })
    mockExistsSync.mockReturnValue(true)

    await expect(removePerAgentWorkspace(gitAgent)).resolves.toBeUndefined()
  })
})

describe('injectScmEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when workspaceType is not scm', async () => {
    const env: Record<string, string> = {}
    const agent = { workspaceType: 'temp', scmSourceId: null } as any

    await injectScmEnv(env, agent)
    expect(env).toEqual({})
  })

  it('injects P4 env variables for p4 source', async () => {
    const source = {
      type: 'p4',
      config: {
        p4port: 'ssl:perforce:1666',
        p4user: 'admin',
        p4passwd: 'secret',
        p4client: 'my-workspace',
      },
      localPath: '/data/p4',
    }
    mockDbFrom.mockReturnValue(chainResult(source))

    const env: Record<string, string> = {}
    const agent = { id: 'agt_abc123', workspaceType: 'scm', scmSourceId: 'scm_1' } as any

    await injectScmEnv(env, agent)
    expect(env.P4PORT).toBe('ssl:perforce:1666')
    expect(env.P4USER).toBe('admin')
    expect(env.P4PASSWD).toBe('secret')
    expect(env.P4CLIENT).toBe('my-workspace')
    expect(env.P4_CLIENT_ROOT).toBe('/data/p4')
  })

  it('injects GIT_BRANCH for git source', async () => {
    const source = {
      type: 'git',
      config: { branch: 'develop' },
      localPath: '/data/git',
    }
    mockDbFrom.mockReturnValue(chainResult(source))

    const env: Record<string, string> = {}
    const agent = { id: 'agt_abc123', workspaceType: 'scm', scmSourceId: 'scm_1' } as any

    await injectScmEnv(env, agent)
    expect(env.GIT_BRANCH).toBe('develop')
  })

  it('does not set A2WAVE_WORKSPACE_BRANCH (resolveWorkDir owns that variable)', async () => {
    const source = {
      type: 'git',
      config: { branch: 'develop' },
      localPath: '/data/git',
    }
    mockDbFrom.mockReturnValue(chainResult(source))

    const env: Record<string, string> = {}
    const agent = { id: 'agt_abc123', workspaceType: 'scm', scmSourceId: 'scm_1' } as any

    await injectScmEnv(env, agent)
    expect(env).not.toHaveProperty('A2WAVE_WORKSPACE_BRANCH')
  })

  it('defaults GIT_BRANCH to main when not specified', async () => {
    const source = {
      type: 'git',
      config: {},
      localPath: '/data/git',
    }
    mockDbFrom.mockReturnValue(chainResult(source))

    const env: Record<string, string> = {}
    const agent = { id: 'agt_abc123', workspaceType: 'scm', scmSourceId: 'scm_1' } as any

    await injectScmEnv(env, agent)
    expect(env.GIT_BRANCH).toBe('main')
  })
})
