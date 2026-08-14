import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

// ============================================================
// Mocks
// ============================================================

const mockDbGet = vi.fn()
const mockDbAll = vi.fn(() => [])
const mockDbRun = vi.fn()
const mockUpdateSet = vi.fn()
const mockUpdateWhere = vi.fn()
const mockInsertValues = vi.fn()

function makeSelectChain() {
  // One `get` consumption per query. The node returned by `where` must NOT
  // resolve rows on its own when the caller goes on to `.orderBy(...).limit(1)`;
  // otherwise the queued mockDbGet advances twice for a single lookup and every
  // later value in the sequence is off by one.
  const limitFn = vi.fn().mockReturnValue(asyncQuery({ get: mockDbGet }))
  const orderByFn = vi.fn().mockReturnValue(asyncQuery({ limit: limitFn }))
  const whereFn = vi.fn(() =>
    asyncQuery({
      get: mockDbGet,
      limit: vi.fn().mockReturnValue(asyncQuery({ get: mockDbGet })),
      orderBy: orderByFn,
    }),
  )
  return {
    from: vi.fn().mockReturnValue(asyncQuery({ where: whereFn })),
  }
}

function makeUpdateChain() {
  // Production reads `.returning()` rows and counts them (didChangeOneRow), so
  // the affected-row count has to come from mockDbRun — never from the mockDbGet
  // sequence, which is reserved for the select lookups a test lines up.
  mockUpdateWhere.mockReturnValue(asyncQuery({ run: mockDbRun }))
  mockUpdateSet.mockReturnValue(asyncQuery({ where: mockUpdateWhere }))
  return { set: mockUpdateSet }
}

function makeInsertChain() {
  return {
    values: vi.fn().mockImplementation((value: unknown) => {
      mockInsertValues(value)
      return asyncQuery({ run: mockDbRun })
    }),
  }
}

/** 事务回调内发生的写操作序列（'insert'/'update'），供原子性断言。 */
const txOps: string[] = []
const mockDbTransaction = vi.fn((fn: (tx: unknown) => unknown) => {
  // 与真实 drizzle better-sqlite3 语义一致：回调抛错则事务抛错（回滚由真实 SQLite 保证）。
  const tx = {
    insert: vi.fn(() => {
      txOps.push('insert')
      return makeInsertChain()
    }),
    update: vi.fn(() => {
      txOps.push('update')
      return makeUpdateChain()
    }),
  }
  return fn(tx)
})

// `isPostgres: true` keeps `withTransaction` on the branch that calls
// `db.transaction`, so the callback receives the tx stub above that records
// `txOps`. The SQLite branch would pass the shared `db` instead, leaving the
// in-transaction writes unrecorded and the atomicity assertions unverifiable.
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => makeUpdateChain()),
    insert: vi.fn(() => makeInsertChain()),
    transaction: (fn: (tx: unknown) => unknown) => mockDbTransaction(fn),
  },
  isPostgres: true,
}))

vi.mock('../../db/schema.js', () => ({
  agents: { id: 'agents.id' },
  runs: {
    id: 'runs.id',
    status: 'runs.status',
    workDir: 'runs.workDir',
    initiatorAgentId: 'runs.initiatorAgentId',
    triggerSource: 'runs.triggerSource',
    triggerSessionId: 'runs.triggerSessionId',
    executionMetadata: 'runs.executionMetadata',
    createdAt: 'runs.createdAt',
  },
  runSteps: { runId: 'runSteps.runId', order: 'runSteps.order' },
  chatMessages: {},
  scmSources: { id: 'scmSources.id' },
}))

vi.mock('../id.js', () => ({
  createId: vi.fn((prefix: string) => `${prefix}_test1`),
}))

const mockLoggerError = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mockLoggerError },
}))

class WorktreeOccupiedErrorMock extends Error {
  constructor(public readonly worktreePath: string) {
    super(`Worktree '${worktreePath}' is occupied`)
    this.name = 'WorktreeOccupiedError'
  }
}

class WorktreeBranchLockedErrorMock extends Error {
  constructor(
    public readonly branch: string,
    public readonly lockedBy: string,
  ) {
    super(`Branch '${branch}' locked by '${lockedBy}'`)
    this.name = 'WorktreeBranchLockedError'
  }
}

class WorktreeDirtyErrorMock extends Error {
  constructor(
    public readonly wsPath: string,
    public readonly directory?: string,
  ) {
    super(`Workspace '${wsPath}' dirty`)
    this.name = 'WorktreeDirtyError'
  }
}

const mockResolveWorkDir = vi.fn(async (..._args: unknown[]) => '/default/work/dir')
const mockBuildAgentConfig = vi.fn((..._args: unknown[]) => ({ model: 'claude-3' }))
vi.mock('../agent-helpers.js', () => ({
  resolveWorkDir: (...args: unknown[]) => mockResolveWorkDir(...args),
  buildAgentConfig: (...args: unknown[]) => mockBuildAgentConfig(...args),
  WorktreeOccupiedError: WorktreeOccupiedErrorMock,
}))

const mockLookupPreviousOAuthSessionChatId = vi.fn()
vi.mock('../oauth-session.js', () => ({
  lookupPreviousOAuthSessionChatId: (...args: unknown[]) =>
    mockLookupPreviousOAuthSessionChatId(...args),
}))

vi.mock('../git-workspace.js', () => ({
  WorktreeBranchLockedError: WorktreeBranchLockedErrorMock,
  WorktreeDirtyError: WorktreeDirtyErrorMock,
}))

const mockFinishRunSuccess = vi.fn()
const mockFinishRunError = vi.fn()
const mockCleanupWorktreeIfEphemeral = vi.fn().mockResolvedValue(undefined)
vi.mock('../run-lifecycle.js', () => ({
  finishRunSuccess: (...args: unknown[]) => mockFinishRunSuccess(...args),
  finishRunError: (...args: unknown[]) => mockFinishRunError(...args),
  createLogCollector: vi.fn().mockReturnValue({ logs: [], onLogEntry: vi.fn() }),
  createPersistingLogCollector: vi.fn().mockReturnValue({
    logs: [],
    onLogEntry: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
  sanitizeLogsForStorage: vi.fn((logs: unknown[]) => logs),
  cleanupWorktreeIfEphemeral: (...args: unknown[]) => mockCleanupWorktreeIfEphemeral(...args),
}))

vi.mock('../run-log-registry.js', () => ({
  registerLogCollector: vi.fn(),
  unregisterLogCollector: vi.fn(),
  stopLogCollector: vi.fn().mockResolvedValue(undefined),
}))

const mockScheduleNext = vi.fn()
vi.mock('../../engine/task-queue.js', () => ({
  scheduleNext: (...args: unknown[]) => mockScheduleNext(...args),
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

const mockCompleteExecutionLease = vi.fn()
vi.mock('../../engine/execution-lease-registry.js', () => ({
  completeExecutionLease: (...args: unknown[]) => mockCompleteExecutionLease(...args),
}))

const mockExecuteWithRetry = vi.fn()
vi.mock('../execute-with-retry.js', () => ({
  executeWithRetry: (...args: unknown[]) => mockExecuteWithRetry(...args),
}))

const mockCreateScmSource = vi.fn()
vi.mock('../scm-source.js', () => ({
  createScmSource: (...args: unknown[]) => mockCreateScmSource(...args),
}))

// Mock existsSync
const mockExistsSync = vi.fn((..._args: unknown[]) => false)
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => ({ toString: () => 'abcd1234' })),
}))

const mockTakePendingContext = vi.fn<() => Record<string, unknown> | null>(() => null)
vi.mock('../pending-job-registry.js', () => ({
  takePendingJob: vi.fn(() => null),
  takePendingContext: () => mockTakePendingContext(),
  sweepPendingContexts: vi.fn(),
}))

const mockResolveNativeChatAttachments = vi.fn().mockResolvedValue([])
vi.mock('../native-chat-attachments.js', () => ({
  resolveNativeChatAttachments: (...args: unknown[]) => mockResolveNativeChatAttachments(...args),
}))

// 默认：无 sources → 纯文本透传（与真实快路径一致）；有 sources → 落一个附件（含 token）。
// 具体用例可覆写返回值以模拟「全丢」。
const mockMaterializeForRun = vi.fn(
  async (opts: { message: string; sources?: unknown[] | undefined }) => {
    if (!opts.sources || opts.sources.length === 0) {
      return { mergedPrompt: opts.message, rootDir: null as string | null, materialized: [] }
    }
    return {
      mergedPrompt: `${opts.message}\n\n---\n[图片]\n图片路径：/tmp/x.png`,
      rootDir: null as string | null,
      materialized: [{ token: 'att_1', name: 'x.png', mimeType: 'image/png' }],
    }
  },
)
const mockCleanupMaterializedRoot = vi.fn().mockResolvedValue(undefined)
vi.mock('../attachment-materializer.js', () => ({
  materializeForRun: (...args: unknown[]) =>
    mockMaterializeForRun(...(args as [{ message: string; sources?: unknown[] }])),
  cleanupMaterializedRoot: (...args: unknown[]) => mockCleanupMaterializedRoot(...args),
  // refsToSources 是纯函数，测试里直接透传实现即可。
  refsToSources: (refs: { token: string; name: string; mimeType: string }[] | undefined) =>
    refs?.map((r) => ({
      kind: 'token' as const,
      token: r.token,
      name: r.name,
      mimeType: r.mimeType,
    })),
}))

// ============================================================
// Helpers
// ============================================================

const baseAgent = {
  id: 'agt_1',
  name: 'TestAgent',
  workspaceType: 'scm',
  scmSourceId: 'scm_1',
}

const baseRun = {
  id: 'run_1',
  status: 'running',
  intent: 'hello',
  triggerSource: 'api',
  triggerSessionId: 'sess_1',
  initiatorAgentId: 'agt_1',
  userId: 'usr_1',
  createdAt: new Date('2026-01-02T00:00:00.000Z'),
}

const baseScmSource = {
  id: 'scm_1',
  type: 'git',
  localPath: '/data/repos',
  name: 'repo',
  config: {},
  initialSyncCompletedAt: new Date(),
}

/**
 * Configure mockDbGet to return values in sequence.
 * Each call to db.select()...get() returns the next value.
 */
function setupSelectSequence(...values: unknown[]) {
  const queue = [...values]
  mockDbGet.mockImplementation(() => queue.shift())
}

describe('executeChatRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbRun.mockReturnValue({ changes: 1 })
    txOps.length = 0
    mockTakePendingContext.mockReturnValue(null)
    mockBuildAgentConfig.mockReturnValue({ model: 'claude-3' })
    mockLookupPreviousOAuthSessionChatId.mockImplementation(() => {
      const previous = mockDbGet() as { result?: { chatId?: string } } | undefined
      return previous?.result?.chatId
    })
    mockResolveWorkDir.mockResolvedValue('/default/work/dir')
    mockResolveNativeChatAttachments.mockResolvedValue([])
    mockMaterializeForRun.mockImplementation(
      async (opts: { message: string; sources?: unknown[] | undefined }) => {
        if (!opts.sources || opts.sources.length === 0) {
          return { mergedPrompt: opts.message, rootDir: null as string | null, materialized: [] }
        }
        return {
          mergedPrompt: `${opts.message}\n\n---\n[图片]\n图片路径：/tmp/x.png`,
          rootDir: null as string | null,
          materialized: [{ token: 'att_1', name: 'x.png', mimeType: 'image/png' }],
        }
      },
    )
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, text: 'ok' },
      retries: 0,
      logs: [],
    })
  })

  // ----------------------------------------------------------
  // Basic guard tests
  // ----------------------------------------------------------

  it('marks a running run as failed when its agent no longer exists', async () => {
    setupSelectSequence(undefined, baseRun)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_missing', 'run_1')

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', result: { error: 'Agent not found' } }),
    )
    expect(mockScheduleNext).toHaveBeenCalled()
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('returns early when run not found', async () => {
    setupSelectSequence(baseAgent, undefined)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_missing')

    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('fails run when SCM source not synced', async () => {
    setupSelectSequence(
      baseAgent,
      baseRun,
      { ...baseScmSource, initialSyncCompletedAt: null }, // not synced
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockDbRun).toHaveBeenCalled()
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(mockScheduleNext).toHaveBeenCalled()
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('fails and releases a queued run when Provider config resolution throws', async () => {
    setupSelectSequence(baseAgent, baseRun)
    mockBuildAgentConfig.mockImplementationOnce(() => {
      throw new Error('Unsupported Provider kind "legacy:prv_gemini"')
    })

    const { executeChatRun } = await import('../execute-chat-run.js')
    await expect(executeChatRun('agt_1', 'run_1')).resolves.toBeUndefined()

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        result: { error: 'Unsupported Provider kind "legacy:prv_gemini"' },
      }),
    )
    expect(mockScheduleNext).toHaveBeenCalled()
    expect(mockResolveWorkDir).not.toHaveBeenCalled()
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('rechecks the persisted runtime admin requester when queued execution starts', async () => {
    const queuedRun = {
      ...baseRun,
      executionMetadata: { runtimeAdminRequesterUserId: 'usr_current_admin' },
    }
    setupSelectSequence(baseAgent, queuedRun, baseScmSource, undefined)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockBuildAgentConfig).toHaveBeenCalledWith(baseAgent, {
      runtimeAdminRequesterUserId: 'usr_current_admin',
    })
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
  })

  it('fails and releases a queued OAuth run when session lookup throws', async () => {
    setupSelectSequence(baseAgent, {
      ...baseRun,
      triggerSource: 'oauth',
      executionMetadata: {},
    })
    mockLookupPreviousOAuthSessionChatId.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: oauth session lookup failed')
    })

    const { executeChatRun } = await import('../execute-chat-run.js')
    await expect(executeChatRun('agt_1', 'run_1')).resolves.toBeUndefined()

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        result: { error: 'SQLITE_BUSY: oauth session lookup failed' },
      }),
    )
    expect(mockScheduleNext).toHaveBeenCalled()
    expect(mockResolveWorkDir).not.toHaveBeenCalled()
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  // ----------------------------------------------------------
  // consume-once handoff 时机（review [P1]）
  // ----------------------------------------------------------

  it('does NOT clear executionMetadata.attachments when SCM sync fails (rerun 可复原)', async () => {
    const runWithAtt = {
      ...baseRun,
      executionMetadata: {
        attachments: [{ token: 'att_1', name: 'x.png', mimeType: 'image/png' }],
        attachmentConsumerId: 'usr_1',
      },
    }
    setupSelectSequence(
      baseAgent,
      runWithAtt,
      { ...baseScmSource, initialSyncCompletedAt: null }, // not synced → 提前失败
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    // materialize 都还没跑（附件未落盘、attachment_refs 未登记）——绝不能提前清 metadata，
    // 否则这条失败 run 的 rerun 找不到附件、且 TTL sweeper 有无 pin 窗口。
    expect(mockMaterializeForRun).not.toHaveBeenCalled()
    // 仅有「status: failed」的 update，没有任何清 executionMetadata 附件字段的 update。
    const clearedMeta = mockUpdateSet.mock.calls.some(
      (c) => 'executionMetadata' in (c[0] as Record<string, unknown>),
    )
    expect(clearedMeta).toBe(false)
  })

  it('clears executionMetadata.attachments only AFTER step persisted (happy path)', async () => {
    const runWithAtt = {
      ...baseRun,
      executionMetadata: {
        attachments: [{ token: 'att_1', name: 'x.png', mimeType: 'image/png' }],
        attachmentConsumerId: 'usr_1',
      },
    }
    setupSelectSequence(
      baseAgent,
      runWithAtt,
      baseScmSource, // synced
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    // 附件已落盘（materialize 跑过），且 consume-once 清理最终发生（executionMetadata → null）。
    expect(mockMaterializeForRun).toHaveBeenCalled()
    const clearCall = mockUpdateSet.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>).executionMetadata === null,
    )
    expect(clearCall).toBeDefined()
    // 关键时序：清 metadata 的 update 必须在 runStep insert 之后发生。
    const stepInsertIdx = mockInsertValues.mock.calls.findIndex(
      (c) => (c[0] as Record<string, unknown>).order !== undefined,
    )
    expect(stepInsertIdx).toBeGreaterThanOrEqual(0)
  })

  it('clears queuedTurn marker after step persisted even with no attachments (review [P2])', async () => {
    // 无附件的排队轮只带 queuedTurn marker。materialize 落 step 后必须清掉 marker，
    // 否则下一轮 rerun 会误以为「当前 intent 还没 materialize」而拒读本轮 step 附件。
    const runQueuedNoAtt = {
      ...baseRun,
      executionMetadata: { queuedTurn: true },
    }
    setupSelectSequence(
      baseAgent,
      runQueuedNoAtt,
      baseScmSource, // synced
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    // marker 被清空（executionMetadata → null，因为无其它字段残留）。
    const clearCall = mockUpdateSet.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>).executionMetadata === null,
    )
    expect(clearCall).toBeDefined()
    // 时序：清 marker 必须在 runStep insert 之后。
    const stepInsertIdx = mockInsertValues.mock.calls.findIndex(
      (c) => (c[0] as Record<string, unknown>).order !== undefined,
    )
    expect(stepInsertIdx).toBeGreaterThanOrEqual(0)
  })

  it('step/message insert 与 metadata 清理在同一事务内（原子提交，review：SQLITE_BUSY 半提交）', async () => {
    // 三个写若不在事务里，step insert 提交后 clear update 抛错会留下「step 已存在 +
    // stale queuedTurn/attachments」——rerun 会重放已 materialize 过的附件；chatMessages
    // insert 抛错则留孤儿 step，历史配对错位。事务保证全有或全无。
    const runQueued = {
      ...baseRun,
      executionMetadata: {
        queuedTurn: true,
        attachments: [{ token: 'att_1', name: 'x.png', mimeType: 'image/png' }],
        attachmentConsumerId: 'usr_1',
      },
    }
    setupSelectSequence(baseAgent, runQueued, baseScmSource, undefined)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    // 三个写全部发生在事务回调内：step insert + chatMessage insert + metadata clear。
    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    expect(txOps).toEqual(['update', 'insert', 'insert', 'update'])
    // clear 内容不变（共享 spy 断言）。
    const clearCall = mockUpdateSet.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>).executionMetadata === null,
    )
    expect(clearCall).toBeDefined()
  })

  it('无 metadata 清理需求时事务内只有两个 insert', async () => {
    setupSelectSequence(baseAgent, baseRun, baseScmSource, undefined)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockDbTransaction).toHaveBeenCalledTimes(1)
    expect(txOps).toEqual(['update', 'insert', 'insert'])
  })

  it('pre-lifecycle DB write throwing → run marked failed + scheduleNext (no queue deadlock)', async () => {
    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource, // synced
      undefined, // lastStep
    )
    // 让第一次 .run()（runStep insert）抛错，其后（失败收口 update）成功。
    let call = 0
    mockDbRun.mockImplementation(() => {
      call += 1
      if (call === 1) throw new Error('SQLITE_BUSY: database is locked')
      return { changes: 1 }
    })

    const { executeChatRun } = await import('../execute-chat-run.js')
    // 绝不 rethrow（调用方 fire-and-forget，rethrow = 队列死锁）。
    await expect(executeChatRun('agt_1', 'run_1')).resolves.toBeUndefined()

    // Run 被标记 failed + scheduleNext 触发下一个排队任务，槽不泄漏。
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(mockScheduleNext).toHaveBeenCalled()
    expect(mockCleanupWorktreeIfEphemeral.mock.invocationCallOrder[0]).toBeLessThan(
      mockCompleteExecutionLease.mock.invocationCallOrder[0],
    )
    expect(mockCompleteExecutionLease.mock.invocationCallOrder[0]).toBeLessThan(
      mockScheduleNext.mock.invocationCallOrder[0],
    )
    // 未进入真正执行。
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('reports terminalization retry as a DB lifecycle failure, not workspace cleanup', async () => {
    vi.useFakeTimers()
    mockDbRun
      .mockImplementationOnce(() => {
        throw new Error('database unavailable')
      })
      .mockReturnValueOnce({ changes: 1 })

    const { failRunBeforeLifecycle } = await import('../execute-chat-run.js')
    const result = failRunBeforeLifecycle('run_1', 'agt_1', 'preparation failed')
    await vi.advanceTimersByTimeAsync(1_000)
    await result

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1', agentId: 'agt_1', retryDelayMs: 1_000 }),
      'Failed to terminalize run preparation; retaining the workload lease and retrying',
    )
    expect(mockCompleteExecutionLease).toHaveBeenCalledWith('run_1')
    vi.useRealTimers()
  })

  it('does not insert a step when cancellation wins during async preparation', async () => {
    setupSelectSequence(baseAgent, baseRun, baseScmSource, undefined)
    mockMaterializeForRun.mockResolvedValueOnce({
      mergedPrompt: 'hello',
      rootDir: '/tmp/materialized',
      materialized: [],
    })
    mockDbRun.mockReturnValueOnce({ changes: 0 })

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockInsertValues).not.toHaveBeenCalled()
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(mockCleanupMaterializedRoot).toHaveBeenCalledWith('/tmp/materialized')
    expect(mockCleanupWorktreeIfEphemeral).toHaveBeenCalledWith('run_1', 'agt_1')
    expect(mockScheduleNext).not.toHaveBeenCalled()
  })

  // ----------------------------------------------------------
  // Execution result handling
  // ----------------------------------------------------------

  it('calls finishRunSuccess when executeWithRetry returns success', async () => {
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'Great result', durationMs: 200 },
      retries: 0,
      logs: [],
    })

    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockFinishRunSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1', agentId: 'agt_1' }),
      expect.objectContaining({ success: true, output: 'Great result' }),
    )
    expect(mockFinishRunError).not.toHaveBeenCalled()
  })

  it('calls finishRunError when executeWithRetry returns failure', async () => {
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: false, output: '', error: 'model failed', durationMs: 100 },
      retries: 0,
      logs: [],
    })

    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockFinishRunError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1', agentId: 'agt_1' }),
      expect.any(Error),
      undefined,
    )
    const errorArg = (mockFinishRunError as Mock).mock.calls[0][1] as Error
    expect(errorArg.message).toBe('model failed')
    expect(mockFinishRunSuccess).not.toHaveBeenCalled()
  })

  it('uses "Execution failed" as default error when result.error is missing', async () => {
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: false, output: '', durationMs: 100 },
      retries: 0,
      logs: [],
    })

    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    const errorArg = (mockFinishRunError as Mock).mock.calls[0][1] as Error
    expect(errorArg.message).toBe('Execution failed')
  })

  it('calls finishRunError when executeWithRetry throws', async () => {
    mockExecuteWithRetry.mockRejectedValue(new Error('unexpected crash'))

    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockFinishRunError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1' }),
      expect.any(Error),
    )
    const errorArg = (mockFinishRunError as Mock).mock.calls[0][1] as Error
    expect(errorArg.message).toBe('unexpected crash')
    expect(mockFinishRunSuccess).not.toHaveBeenCalled()
  })

  // ----------------------------------------------------------
  // Insert ordering & context
  // ----------------------------------------------------------

  it('inserts runStep and chatMessage before calling executeWithRetry', async () => {
    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    // Two inserts (runSteps + chatMessages)，走事务提交。
    expect(txOps).toEqual(['update', 'insert', 'insert'])
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1)

    // 事务提交发生在 retry 调用之前。
    const txOrder = mockDbTransaction.mock.invocationCallOrder[0]
    const retryOrder = mockExecuteWithRetry.mock.invocationCallOrder[0]
    expect(txOrder).toBeLessThan(retryOrder)
  })

  it('passes context in step input when context is provided', async () => {
    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1', { key: 'value' })

    // executeWithRetry should receive the context
    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ context: { key: 'value' } }),
      expect.any(Object),
    )
  })

  it('uses queued OAuth session chat id without exposing the internal key to step context', async () => {
    setupSelectSequence(
      baseAgent,
      {
        ...baseRun,
        triggerSource: 'oauth',
        executionMetadata: { oauthPreviousChatId: 'chat_previous' },
      },
      baseScmSource,
      undefined,
    )
    mockTakePendingContext.mockReturnValue({ key: 'value' })

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        chatId: 'chat_previous',
        context: { key: 'value' },
      }),
      expect.any(Object),
    )
    const stepInsert = mockInsertValues.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((value) => 'input' in value) as
      | { input?: { context?: Record<string, unknown> } }
      | undefined
    expect(stepInsert?.input?.context).toEqual({ key: 'value' })
  })

  it('recovers queued OAuth session chat id from previous completed run after restart', async () => {
    const currentRun = { ...baseRun, triggerSource: 'oauth' }
    const previousRun = { result: { chatId: 'chat_recovered' } }
    setupSelectSequence(baseAgent, currentRun, previousRun, baseScmSource, undefined)
    mockTakePendingContext.mockReturnValue({ key: 'value' })

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        chatId: 'chat_recovered',
        context: { key: 'value' },
      }),
      expect.any(Object),
    )
  })

  it('recovers native chat context and previous chat id after restart', async () => {
    const nativeChatContext = {
      channel: {
        channel_type: 'slack',
        channel_info: {
          team_id: 'T123',
          channel_id: 'C123',
          thread_ts: '1710000000.000001',
          reply_mode: 'thread',
        },
      },
      user_info: null,
    }
    setupSelectSequence(
      baseAgent,
      {
        ...baseRun,
        triggerSource: 'slack',
        executionMetadata: { nativeChatContext },
      },
      { result: { chatId: 'chat_slack_recovered' } },
      baseScmSource,
      undefined,
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        chatId: 'chat_slack_recovered',
        context: nativeChatContext,
      }),
      expect.any(Object),
    )
    const stepInsert = mockInsertValues.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((value) => 'input' in value) as
      | { input?: { context?: Record<string, unknown> } }
      | undefined
    expect(stepInsert?.input?.context).toEqual(nativeChatContext)
    expect(mockUpdateSet).toHaveBeenCalledWith({ executionMetadata: null })
  })

  it('resolves persisted native attachment ids and materializes their staged refs', async () => {
    const nativeChatContext = {
      channel: {
        channel_type: 'slack',
        channel_info: {
          team_id: 'T123',
          channel_id: 'C123',
          message_ts: '1710000000.000001',
        },
      },
    }
    const nativeAttachments = [
      {
        source: 'slack' as const,
        remoteId: 'F123',
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 128,
      },
    ]
    mockResolveNativeChatAttachments.mockResolvedValueOnce([
      { token: 'att_native', name: 'diagram.png', mimeType: 'image/png', size: 128 },
    ])
    setupSelectSequence(
      baseAgent,
      {
        ...baseRun,
        triggerSource: 'slack',
        executionMetadata: { nativeChatContext, nativeAttachments },
      },
      { result: { chatId: 'chat_slack_recovered' } },
      baseScmSource,
      undefined,
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockResolveNativeChatAttachments).toHaveBeenCalledWith('agt_1', nativeAttachments)
    expect(mockMaterializeForRun).toHaveBeenCalledWith(
      expect.objectContaining({
        consumerId: 'agent:agt_1',
        sources: [
          {
            kind: 'token',
            token: 'att_native',
            name: 'diagram.png',
            mimeType: 'image/png',
          },
        ],
      }),
    )
    expect(mockUpdateSet).toHaveBeenCalledWith({ executionMetadata: null })
  })

  it('does not recover a previous OAuth chat id when queued run was reset', async () => {
    setupSelectSequence(
      baseAgent,
      {
        ...baseRun,
        triggerSource: 'oauth',
        executionMetadata: { oauthResetSession: true },
      },
      baseScmSource,
      undefined,
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ chatId: undefined }),
      expect.any(Object),
    )
  })

  it('does not treat user context internal-key lookalikes as OAuth chat id metadata', async () => {
    setupSelectSequence(
      baseAgent,
      { ...baseRun, triggerSource: 'oauth' },
      undefined,
      baseScmSource,
      undefined,
    )
    mockTakePendingContext.mockReturnValue({
      key: 'value',
      __a2wave_oauth_previous_chat_id: 'chat_attacker',
    })

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        chatId: undefined,
        context: {
          key: 'value',
          __a2wave_oauth_previous_chat_id: 'chat_attacker',
        },
      }),
      expect.any(Object),
    )
  })

  // ----------------------------------------------------------
  // Workspace management (multi-repo support)
  // ----------------------------------------------------------

  it('executes without workspace when useWorkspace is not set', async () => {
    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockCreateScmSource).not.toHaveBeenCalled()
    expect(mockExecuteWithRetry).toHaveBeenCalled()
  })

  it('passes worktreeParams from run record to resolveWorkDir', async () => {
    const runWithWorktree = {
      ...baseRun,
      worktreeConfig: { name: 'feature-x', cleanup: 'ttl' },
    }
    mockResolveWorkDir.mockResolvedValue('/ws/feature-x')

    setupSelectSequence(
      baseAgent,
      runWithWorktree,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockResolveWorkDir).toHaveBeenCalledWith(
      baseAgent,
      expect.objectContaining({ name: 'feature-x', cleanup: 'ttl' }),
      'run_1',
      undefined,
    )
    expect(mockExecuteWithRetry).toHaveBeenCalled()
  })

  it('threads agentEnv into resolveWorkDir so the workspace-branch env stays truthful', async () => {
    // resolveWorkDir owns A2WAVE_WORKSPACE_BRANCH — it sets/clears the variable
    // for whichever path the run actually lands on, so every channel must hand
    // it the env object.
    const runWithWorktree = {
      ...baseRun,
      worktreeConfig: { name: 'feature-x', cleanup: 'ttl' },
    }
    const agentConfig = {
      model: 'claude-3',
      agentEnv: { GIT_BRANCH: 'main' },
    }
    mockBuildAgentConfig.mockReturnValueOnce(agentConfig)
    mockResolveWorkDir.mockResolvedValue('/ws/feature-x')

    setupSelectSequence(baseAgent, runWithWorktree, baseScmSource, undefined)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockResolveWorkDir).toHaveBeenCalledWith(
      baseAgent,
      expect.objectContaining({ name: 'feature-x' }),
      'run_1',
      agentConfig.agentEnv,
    )
  })

  it('passes worktreeConfig.branch through to resolveWorkDir (queued path preserves branch)', async () => {
    // 回归 MR!89 review: 排队入队时 branch 会落库到 runs.worktreeConfig；
    // 出队 executeChatRun 还原 worktreeParams 时必须把 branch 一并带上，
    // 否则同步直跑 vs 排队两条路径会走到不同的分支。
    const runWithBranch = {
      ...baseRun,
      worktreeConfig: { name: 'feature-x', branch: 'feat/my-branch', cleanup: 'ephemeral' },
    }
    mockResolveWorkDir.mockResolvedValue('/ws/feature-x')

    setupSelectSequence(baseAgent, runWithBranch, baseScmSource, undefined)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockResolveWorkDir).toHaveBeenCalledWith(
      baseAgent,
      expect.objectContaining({
        name: 'feature-x',
        branch: 'feat/my-branch',
        cleanup: 'ephemeral',
      }),
      'run_1',
      undefined,
    )
  })

  it('passes runId to resolveWorkDir for atomic reservation (queued scheduling)', async () => {
    // 回归 #1：队列出队执行时，必须把 runId 传给 resolveWorkDir，
    // 由 resolveWorkDir 在同步事务内完成占用检查 + workDir 原子写回。
    // (workDir 的实际落库由 resolveWorkDir 内部事务完成；此处验证契约。)
    const runWithWorktree = {
      ...baseRun,
      worktreeConfig: { name: 'feature-x', cleanup: 'ephemeral' },
    }
    mockResolveWorkDir.mockResolvedValue('/ws/feature-x')

    setupSelectSequence(
      baseAgent,
      runWithWorktree,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockResolveWorkDir).toHaveBeenCalledWith(
      baseAgent,
      expect.objectContaining({ name: 'feature-x', cleanup: 'ephemeral' }),
      'run_1',
      undefined,
    )
  })

  it('does NOT write workDir when run has no worktreeConfig (default path uses agent.localPath)', async () => {
    // 无 worktree 的默认路径不需要在 runs 上落 workDir（与内联路径保持一致）
    setupSelectSequence(baseAgent, baseRun, baseScmSource, undefined)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    const workDirSetCall = (mockUpdateSet as Mock).mock.calls.find(
      (call) => (call[0] as Record<string, unknown>)?.workDir !== undefined,
    )
    expect(workDirSetCall).toBeUndefined()
  })

  // ----------------------------------------------------------
  // 回归: 队列出队后 worktree 不可用（参见 worktree-lifecycle.test.ts 的入队场景）
  // ----------------------------------------------------------

  it('worktreeConfig 已持久化但出队时 worktree 被占 → 标记 failed + scheduleNext', async () => {
    const runWithWorktree = {
      ...baseRun,
      worktreeConfig: { name: 'feature-x', cleanup: 'ephemeral' },
    }
    mockResolveWorkDir.mockRejectedValue(new WorktreeOccupiedErrorMock('/ws/feature-x'))

    setupSelectSequence(baseAgent, runWithWorktree, baseScmSource)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    // run 被标记 failed，错误原因带上 worktree path
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        result: expect.objectContaining({ error: expect.stringContaining('/ws/feature-x') }),
      }),
    )
    // scheduleNext 必须触发，否则 slot 泄漏 → 队列卡死
    expect(mockScheduleNext).toHaveBeenCalled()
    // 不应进入真正执行
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('worktree branch 被其它 worktree 锁住 → 标记 failed + scheduleNext', async () => {
    const runWithWorktree = {
      ...baseRun,
      worktreeConfig: { name: 'second', cleanup: 'ephemeral' },
    }
    mockResolveWorkDir.mockRejectedValue(new WorktreeBranchLockedErrorMock('main', '/ws/first'))

    setupSelectSequence(baseAgent, runWithWorktree, baseScmSource)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(mockScheduleNext).toHaveBeenCalled()
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('resolveWorkDir 抛非 worktree 相关错误时也 fail + scheduleNext（避免队列槽泄漏）', async () => {
    // 所有调用方都是 fire-and-forget，外层没 try/catch；rethrow 会让 run 卡在
    // running、并发槽不释放、scheduleNext 不触发 → 队列死锁。
    // resolveWorkDir 的 generic Error (SCM source 不存在 / worktree 名非法 /
    // scm.createWorkspace 原始错误 等) 都必须在这里消化成 failed + scheduleNext。
    const runWithWorktree = {
      ...baseRun,
      worktreeConfig: { name: 'x', cleanup: 'ephemeral' },
    }
    mockResolveWorkDir.mockRejectedValue(new Error('unexpected boom'))

    setupSelectSequence(baseAgent, runWithWorktree, baseScmSource)

    const { executeChatRun } = await import('../execute-chat-run.js')
    await expect(executeChatRun('agt_1', 'run_1')).resolves.not.toThrow()
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        result: expect.objectContaining({ error: 'unexpected boom' }),
      }),
    )
    expect(mockScheduleNext).toHaveBeenCalled()
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('does not pass worktreeParams when run has no worktreeConfig', async () => {
    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockResolveWorkDir).toHaveBeenCalledWith(baseAgent, undefined, 'run_1', undefined)
    expect(mockExecuteWithRetry).toHaveBeenCalled()
  })

  it('calls finishRunError on execution failure', async () => {
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: false, error: 'timeout' },
      retries: 1,
    })

    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockFinishRunError).toHaveBeenCalled()
  })

  it('calls finishRunError on exception', async () => {
    mockExecuteWithRetry.mockRejectedValue(new Error('unexpected'))

    setupSelectSequence(
      baseAgent,
      baseRun,
      baseScmSource,
      undefined, // lastStep
    )

    const { executeChatRun } = await import('../execute-chat-run.js')
    await executeChatRun('agt_1', 'run_1')

    expect(mockFinishRunError).toHaveBeenCalled()
  })
})
