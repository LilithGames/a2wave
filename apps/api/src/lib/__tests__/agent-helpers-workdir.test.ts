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
  settings: {},
}))

const mockCreateScmSource = vi.hoisted(() => vi.fn())
vi.mock('../scm-source.js', () => ({
  createScmSource: mockCreateScmSource,
}))

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
  WorktreeOccupiedError,
  _resetTtlCleanupDebounce,
  buildAgentConfig,
  injectScmEnv,
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

  it('returns SCM source localPath when workspaceType is scm', async () => {
    const source = { localPath: '/data/repos/my-project' }
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
        // 3 次 db 查询：source / occupied-check / active-runs
        mockDbFrom
          .mockReturnValueOnce(chainResult(source))
          .mockReturnValueOnce(chainResult(undefined))
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
        // 等 fire-and-forget 完成
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
        expect(arg.activePaths).toBeInstanceOf(Set)
        expect(Array.from(arg.activePaths).sort()).toEqual([
          '/workspaces/scm_a/busy',
          '/workspaces/scm_a/other',
        ])
      })

      it('1h 内再次调用不重复触发（debounce）', async () => {
        const r1 = await runResolve('scm_b', [])
        expect(r1.cleanupStale).toHaveBeenCalledTimes(1)

        // 第二次调用：只消费 source + occupied（triggerTtlCleanup 命中 debounce 不查 activeRuns）
        const source = {
          id: 'scm_b',
          type: 'git',
          config: {},
          localPath: '/git',
        }
        mockDbFrom
          .mockReturnValueOnce(chainResult(source))
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
    const agent = { workspaceType: 'scm', scmSourceId: 'scm_1' } as any

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
    const agent = { workspaceType: 'scm', scmSourceId: 'scm_1' } as any

    await injectScmEnv(env, agent)
    expect(env.GIT_BRANCH).toBe('develop')
  })

  it('defaults GIT_BRANCH to main when not specified', async () => {
    const source = {
      type: 'git',
      config: {},
      localPath: '/data/git',
    }
    mockDbFrom.mockReturnValue(chainResult(source))

    const env: Record<string, string> = {}
    const agent = { workspaceType: 'scm', scmSourceId: 'scm_1' } as any

    await injectScmEnv(env, agent)
    expect(env.GIT_BRANCH).toBe('main')
  })
})
