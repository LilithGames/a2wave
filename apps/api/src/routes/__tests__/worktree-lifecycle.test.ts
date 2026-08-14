import { GatewayErrorCode } from '@a2wave/shared'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

type Json = Record<string, unknown>
type ErrorJson = { error: { code: string; message: string; details?: unknown } }

// ============================================================
// Mock error classes (match production behavior)
// ============================================================

class WorktreeOccupiedErrorMock extends Error {
  constructor(public readonly worktreePath: string) {
    super(`Worktree '${worktreePath}' is occupied by a running or pending run`)
    this.name = 'WorktreeOccupiedError'
  }
}

class WorktreeBranchLockedErrorMock extends Error {
  constructor(
    public readonly branch: string,
    public readonly lockedBy: string,
  ) {
    super(`Branch '${branch}' is already checked out in worktree '${lockedBy}'`)
    this.name = 'WorktreeBranchLockedError'
  }
}

// ============================================================
// Hoisted mocks / call capture
// ============================================================

const {
  mockResolveWorkDir,
  runsSetCalls,
  mockRunWithLifecycle,
  insertCalls,
  deleteCalls,
  mockTryAcquireSlot,
  mockScheduleNext,
  mockFailRunBeforeLifecycle,
  mockFailRunSteps,
  mockCleanupWorktreeIfEphemeral,
} = vi.hoisted(() => ({
  mockResolveWorkDir: vi.fn(),
  runsSetCalls: [] as unknown[],
  mockRunWithLifecycle: vi.fn().mockResolvedValue({ success: true, output: 'ok', durationMs: 10 }),
  insertCalls: [] as unknown[],
  deleteCalls: [] as unknown[],
  mockTryAcquireSlot: vi.fn().mockReturnValue('acquired'),
  mockScheduleNext: vi.fn(),
  mockFailRunBeforeLifecycle: vi.fn().mockResolvedValue(undefined),
  mockFailRunSteps: vi.fn().mockResolvedValue(undefined),
  mockCleanupWorktreeIfEphemeral: vi.fn().mockResolvedValue(undefined),
}))

// ============================================================
// vi.mock — shared between gateway + agents routes
// ============================================================

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi
      .fn()
      .mockReturnValue(
        asyncQuery({ where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }),
      ),
  },
}))

vi.mock('../../middleware/gateway-auth.js', () => ({
  validateGatewayAuth: vi.fn().mockResolvedValue({}),
  normalizeAuthType: vi.fn().mockReturnValue('none'),
}))

vi.mock('../../lib/pending-job-registry.js', () => ({
  registerPendingContext: vi.fn(),
  takePendingContext: vi.fn(() => null),
  sweepPendingContexts: vi.fn(),
  takePendingJob: vi.fn(() => null),
}))

vi.mock('../../lib/run-channel.js', () => ({
  buildGatewayChannel: vi.fn().mockReturnValue({ ctx: { channel_type: 'api' }, displayName: null }),
  buildDebugChannel: vi.fn().mockReturnValue({ ctx: { channel_type: 'debug' }, displayName: null }),
  buildFeishuChannel: vi
    .fn()
    .mockReturnValue({ ctx: { channel_type: 'feishu' }, displayName: null }),
  buildScheduleChannel: vi
    .fn()
    .mockReturnValue({ ctx: { channel_type: 'schedule' }, displayName: null }),
  encodeChannelContextHeader: vi.fn().mockReturnValue(''),
  decodeUpstreamChannelHeader: vi.fn().mockReturnValue(null),
  stripReservedContextKeys: (ctx: Record<string, unknown> | undefined | null) => {
    const copy = { ...(ctx ?? {}) }
    for (const k of ['channel', 'caller', 'receive_id_type', 'receive_id']) {
      delete copy[k]
    }
    return copy
  },
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  resolveWorkDir: mockResolveWorkDir,
  WorktreeOccupiedError: WorktreeOccupiedErrorMock,
  injectScmEnv: vi.fn(),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor', maxRetries: 0 }),
  resolveEngineType: vi.fn(
    (agentConfig, agentType) => agentConfig.engineType || agentType || 'cursor',
  ),
}))

vi.mock('../../lib/git-workspace.js', () => ({
  WorktreeBranchLockedError: WorktreeBranchLockedErrorMock,
}))

vi.mock('../../lib/run-launcher.js', () => ({
  runWithLifecycle: mockRunWithLifecycle,
}))

vi.mock('../../lib/run-lifecycle.js', () => ({
  createLogCollector: vi.fn().mockReturnValue({ logs: [], onLogEntry: vi.fn() }),
  finishRunSuccess: vi.fn().mockResolvedValue([]),
  finishRunError: vi.fn().mockReturnValue('Execution failed. Check server logs for details.'),
  cleanupWorktreeIfEphemeral: mockCleanupWorktreeIfEphemeral,
}))

vi.mock('../../lib/workspace-cleanup-retry.js', () => ({
  cleanupWorkspaceOrHandOff: (cleanup: () => Promise<void>) => cleanup(),
}))

vi.mock('../../worker/index.js', () => ({
  executeInWorker: vi.fn(),
}))

vi.mock('../../engine/index.js', () => ({
  engineRegistry: {
    get: vi.fn().mockReturnValue({ kill: vi.fn().mockReturnValue(true) }),
    types: ['cursor'],
  },
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: mockTryAcquireSlot,
  scheduleNext: mockScheduleNext,
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: { failRunSteps: mockFailRunSteps },
}))

vi.mock('../../lib/execute-chat-run.js', () => ({
  executeChatRun: vi.fn(),
  failRunBeforeLifecycle: mockFailRunBeforeLifecycle,
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('../../lib/id.js', () => {
  let counter = 0
  return {
    createId: vi.fn((prefix?: string) => {
      counter++
      return prefix ? `${prefix}_test${counter}` : `test${counter}`
    }),
  }
})

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))

vi.mock('../../lib/feishu-service.js', () => ({
  feishuConnectionManager: {
    start: vi.fn(),
    stop: vi.fn(),
    getFeishuConnectionStatuses: vi.fn().mockReturnValue([]),
    isRegistered: vi.fn().mockReturnValue(false),
    isSocketOpen: vi.fn().mockReturnValue(false),
  },
}))

vi.mock('../../lib/feishu-diagnose.js', () => ({ runAgentFeishuDiagnose: vi.fn() }))
vi.mock('../../lib/agent-execution-diagnose.js', () => ({
  collectAgentExecutionChecks: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../lib/schedule-trigger.js', () => ({
  scheduleTriggerManager: {
    start: vi.fn(),
    stop: vi.fn(),
    getActiveAgentIds: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('@a2wave/shared', async () => {
  const actual = await vi.importActual<typeof import('@a2wave/shared')>('@a2wave/shared')
  return {
    ...actual,
  }
})

// ============================================================
// DB chain helpers
// ============================================================

function makeSelectChain(result: unknown) {
  const terminal = {
    get: vi.fn().mockReturnValue(result),
    all: vi.fn().mockReturnValue(result ? [result] : []),
    limit: vi.fn().mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue(result) })),
    orderBy: vi.fn().mockReturnValue(
      asyncQuery({
        limit: vi.fn().mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue(result) })),
        get: vi.fn().mockReturnValue(result),
        all: vi.fn().mockReturnValue(result ? [result] : []),
      }),
    ),
  }
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(terminal),
        orderBy: vi
          .fn()
          .mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(result ? [result] : []) })),
        all: vi.fn().mockReturnValue(result ? [result] : []),
      }),
    ),
  }
}

function makeInsertChain() {
  return {
    values: vi.fn().mockImplementation((arg: unknown) => {
      insertCalls.push(arg)
      return { run: vi.fn() }
    }),
  }
}

function makeDeleteChain() {
  return {
    where: vi.fn().mockImplementation((arg: unknown) => {
      deleteCalls.push(arg)
      return { run: vi.fn() }
    }),
  }
}

/**
 * Update chain that captures set() args into runsSetCalls for assertion.
 */
function makeUpdateChain() {
  return {
    set: vi.fn().mockImplementation((arg: unknown) => {
      runsSetCalls.push(arg)
      return { where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }
    }),
  }
}

import { db } from '../../db/client.js'

/**
 * Local copy of src/test/async-query.ts, deliberately NOT imported.
 *
 * This file calls asyncQuery from inside a `vi.mock` factory, which vitest
 * hoists above every import. Referencing the shared module there fails at
 * runtime with "Cannot access '__vi_import_N__' before initialization" and
 * silently collects 0 tests, so the duplication is load-bearing.
 */
/**
 * Wrap a legacy sync mock terminator so it works with awaited queries.
 *
 * Production code awaits every query now, so a mock exposing only
 * `get`/`all`/`run` breaks at `.limit(1)` or at `await`. The returned value is
 * a real thenable (resolving to the row list) that also answers the builder
 * methods, while keeping the original mock fns reachable for assertions.
 */
// biome-ignore lint/suspicious/noExplicitAny: stands in for drizzle's builder
// across ~340 mock sites with differing terminator shapes.
function asyncQuery(term: Record<string, unknown>): any {
  const rows = (): unknown[] => {
    // `get` is consulted BEFORE `all`. Many mocks define both — a configured
    // `get` alongside a placeholder `all: () => []` — and preferring `all` made
    // every single-row lookup resolve empty, so callers saw `undefined`.
    const get = term.get as (() => unknown) | undefined
    if (get) {
      const row = get()
      if (row != null) return [row]
    }
    const all = term.all as (() => unknown[]) | undefined
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    if (get) return []
    const run = term.run as (() => unknown) | undefined
    if (run) {
      // A write mock returns better-sqlite3's `{ changes: n }`. Production now
      // counts `.returning()` rows instead, so surface n placeholder rows —
      // otherwise a successful claim looks like "0 rows affected" and every
      // compare-and-set guard reports that it lost the race.
      const res = run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 1
      return Array.from({ length: changes }, () => ({}))
    }
    return []
  }
  const make = (): any => {
    // Compose rather than choose: the test's own chain methods run first (so a
    // nested `where`/`orderBy` it defined still drives the data), and whatever
    // they return is itself wrapped — so `.limit(1)` and `await` work at every
    // depth. Picking one side or the other broke the opposite set of files.
    const wrap = (v: unknown): unknown =>
      v && typeof v === 'object' && !(v as { then?: unknown }).then
        ? asyncQuery(v as Record<string, unknown>)
        : v
    const chained: Record<string, unknown> = {}
    for (const key of [
      'limit',
      'orderBy',
      'offset',
      'groupBy',
      'having',
      'where',
      'returning',
      'onConflictDoNothing',
      'onConflictDoUpdate',
      'for',
    ]) {
      const own = term[key] as ((...a: unknown[]) => unknown) | undefined
      chained[key] = own ? (...a: unknown[]) => wrap(own(...a)) : () => make()
    }
    // Lazy: the row-resolving function must run only when the node is actually
    // awaited. `Promise.resolve().then(rows)` fires eagerly at construction, so
    // building a chain consumed a queued `get` per intermediate node and every
    // sequence-driven mock desynchronised.
    let settled: Promise<unknown[]> | undefined
    const node = Object.assign(
      {
        // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable — it stands in for drizzle's awaitable query builder.
        then: (
          onFulfilled?: (v: unknown[]) => unknown,
          onRejected?: (e: unknown) => unknown,
        ): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.then(onFulfilled, onRejected)
        },
        catch: (onRejected?: (e: unknown) => unknown): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.catch(onRejected)
        },
        finally: (onFinally?: () => void): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.finally(onFinally)
        },
      },
      term,
      chained,
    )
    return node
  }
  return make()
}

const mockDb = db as unknown as { select: Mock; insert: Mock; update: Mock; delete: Mock }

// ============================================================
// Fixtures
// ============================================================

const publishedAgent = {
  id: 'agt_test1',
  name: 'Test Agent',
  publishStatus: 'published' as const,
  publishAuthType: 'none' as const,
  publishIpWhitelist: [],
  endpointApiKey: null,
  config: {},
  providerId: null,
  systemPrompt: null,
  skills: [],
  env: null,
  workspaceType: 'scm' as const,
  scmSourceId: 'scm_1',
  maxConcurrency: 3,
}

// ============================================================
// Gateway routes — worktree lifecycle
// ============================================================

describe('Gateway /invoke — worktree lifecycle', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    runsSetCalls.length = 0
    insertCalls.length = 0
    deleteCalls.length = 0
    mockResolveWorkDir.mockReset()
    mockTryAcquireSlot.mockReset().mockReturnValue('acquired')
    mockScheduleNext.mockReset()
    mockRunWithLifecycle.mockResolvedValue({ success: true, output: 'ok', durationMs: 10 })
    mockDb.insert.mockImplementation(() => makeInsertChain())
    mockDb.update.mockImplementation(() => makeUpdateChain())
    mockDb.delete.mockImplementation(() => makeDeleteChain())

    const mod = await import('../gateway.js')
    app = new Hono()
    app.route('/api/gateway', mod.default)
  })

  function invoke(body: Record<string, unknown>) {
    return app.request('/api/gateway/agt_test1/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('闭环: worktree 参数 + runId 透传给 resolveWorkDir，worktreeConfig 入库', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))
    mockResolveWorkDir.mockResolvedValue('/ws-root/feat-x')

    const res = await invoke({
      message: 'hi',
      async: true,
      worktree: { name: 'feat-x', branch: 'feature/x', cleanup: 'ephemeral' },
    })

    expect(res.status).toBe(202)

    // resolveWorkDir 收到了 worktree 参数 + runId（后者用于同步事务内的原子占用+workDir 回写）
    expect(mockResolveWorkDir).toHaveBeenCalledTimes(1)
    const [agentArg, worktreeArg, runIdArg] = mockResolveWorkDir.mock.calls[0]
    expect(agentArg.id).toBe('agt_test1')
    expect(worktreeArg).toEqual({ name: 'feat-x', branch: 'feature/x', cleanup: 'ephemeral' })
    expect(typeof runIdArg).toBe('string')
    expect(runIdArg.length).toBeGreaterThan(0)

    // worktreeConfig 在 run insert 时落库（已前置以支持 queued 场景）。
    // workDir 的写回由 resolveWorkDir 内部的同步事务负责，不再由 route 事后 update。
    const runInsert = insertCalls.find(
      (c) => (c as Record<string, unknown>).intent === 'hi' && 'worktreeConfig' in (c as object),
    )
    expect(runInsert).toBeDefined()
    expect((runInsert as any).worktreeConfig).toEqual({
      name: 'feat-x',
      branch: 'feature/x',
      cleanup: 'ephemeral',
    })
  })

  it('persistent 对照: worktreeConfig.cleanup 保留 persistent 值', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))
    mockResolveWorkDir.mockResolvedValue('/ws-root/keep-me')

    const res = await invoke({
      message: 'hi',
      async: true,
      worktree: { name: 'keep-me', cleanup: 'persistent' },
    })

    expect(res.status).toBe(202)
    const runInsert = insertCalls.find(
      (c) => (c as Record<string, unknown>).intent === 'hi' && 'worktreeConfig' in (c as object),
    )
    expect(runInsert).toBeDefined()
    expect((runInsert as any).worktreeConfig).toEqual({ name: 'keep-me', cleanup: 'persistent' })
  })

  it('无 worktree 参数时不写入 workDir/worktreeConfig', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))
    mockResolveWorkDir.mockResolvedValue('/tmp/default')

    const res = await invoke({ message: 'hi', async: true })

    expect(res.status).toBe(202)
    const worktreeWrite = runsSetCalls.find(
      (c) => (c as Record<string, unknown>).workDir === '/tmp/default',
    )
    expect(worktreeWrite).toBeUndefined()

    // resolveWorkDir 仍然被调用但 worktreeParams 为 undefined
    expect(mockResolveWorkDir.mock.calls[0][1]).toBeUndefined()
  })

  it('WorktreeOccupiedError → 409 EXECUTION_ERROR', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))
    mockResolveWorkDir.mockRejectedValue(new WorktreeOccupiedErrorMock('/ws/busy'))

    const res = await invoke({
      message: 'hi',
      async: true,
      worktree: { name: 'busy', cleanup: 'ephemeral' },
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as ErrorJson
    expect(body.error.code).toBe(GatewayErrorCode.EXECUTION_ERROR)
    expect(body.error.message).toContain('/ws/busy')
  })

  it('WorktreeBranchLockedError → 409 EXECUTION_ERROR', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))
    mockResolveWorkDir.mockRejectedValue(new WorktreeBranchLockedErrorMock('main', '/ws/first'))

    const res = await invoke({
      message: 'hi',
      async: true,
      worktree: { name: 'second', branch: 'main', cleanup: 'ephemeral' },
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as ErrorJson
    expect(body.error.code).toBe(GatewayErrorCode.EXECUTION_ERROR)
    expect(body.error.message).toContain('main')
    expect(body.error.message).toContain('/ws/first')
  })

  it('worktree name 不合法时 schema 拒绝 → 400 INVALID_REQUEST', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))

    const res = await invoke({
      message: 'hi',
      async: true,
      worktree: { name: 'has spaces!', cleanup: 'ephemeral' },
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorJson
    expect(body.error.code).toBe(GatewayErrorCode.INVALID_REQUEST)
    expect(mockResolveWorkDir).not.toHaveBeenCalled()
  })

  it('resolvedWorkDir 透传进 runWithLifecycle 的 lifecycleParams — 否则 finishRunSuccess 跳过 artifact 扫描', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))
    mockResolveWorkDir.mockResolvedValue('/ws-root/with-artifacts')

    const res = await invoke({
      message: 'hi',
      async: true,
      worktree: { name: 'with-artifacts', cleanup: 'ephemeral' },
    })

    expect(res.status).toBe(202)
    // runWithLifecycle(taskId, payload, lifecycleParams[, hooks?])
    expect(mockRunWithLifecycle).toHaveBeenCalled()
    const lifecycleParams = mockRunWithLifecycle.mock.calls[0][2] as Record<string, unknown>
    expect(lifecycleParams.workDir).toBe('/ws-root/with-artifacts')
  })

  it('worktree cleanup 默认值 ttl 写入 worktreeConfig', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))
    mockResolveWorkDir.mockResolvedValue('/ws-root/default-ttl')

    const res = await invoke({
      message: 'hi',
      async: true,
      worktree: { name: 'default-ttl' },
    })

    expect(res.status).toBe(202)
    const runInsert = insertCalls.find(
      (c) => (c as Record<string, unknown>).intent === 'hi' && 'worktreeConfig' in (c as object),
    )
    expect(runInsert).toBeDefined()
    expect((runInsert as any).worktreeConfig.cleanup).toBe('ttl')
  })
})

// ============================================================
// Agents /chat — worktree lifecycle (smoke coverage of parallel path)
// ============================================================

describe('Agents POST /:id/chat — worktree lifecycle', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    runsSetCalls.length = 0
    insertCalls.length = 0
    deleteCalls.length = 0
    mockResolveWorkDir.mockReset()
    mockTryAcquireSlot.mockReset().mockReturnValue('acquired')
    mockScheduleNext.mockReset()
    mockRunWithLifecycle.mockResolvedValue({ success: true, output: 'ok', durationMs: 10 })
    mockDb.insert.mockImplementation(() => makeInsertChain())
    mockDb.update.mockImplementation(() => makeUpdateChain())
    mockDb.delete.mockImplementation(() => makeDeleteChain())

    const mod = await import('../agents.js')
    app = new Hono().route('/agents', mod.default)
  })

  function chat(body: Record<string, unknown>) {
    return app.request('/agents/agt_test1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  const scmSyncedSource = { id: 'scm_1', initialSyncCompletedAt: new Date('2025-01-01') }

  function selectChainForChat(opts: {
    agent?: typeof publishedAgent | undefined
    source?: typeof scmSyncedSource
  }) {
    // agents/:id/chat 的 select 序列：agent → scmSource → ... → step max → agent again
    // 简化：所有 select 都返回同一份 agent-or-source 选择器；通过 get() 返回不同对象
    const getResults = [opts.agent, opts.source, { maxOrder: 0 }, opts.agent]
    let idx = 0
    return {
      from: vi.fn().mockReturnValue(
        asyncQuery({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockImplementation(() => {
                const v = getResults[idx] ?? undefined
                idx++
                return v
              }),
            }),
          ),
        }),
      ),
    }
  }

  it('闭环: /chat 带 worktree 参数时回写 workDir/worktreeConfig', async () => {
    mockDb.select.mockReturnValue(
      selectChainForChat({ agent: publishedAgent, source: scmSyncedSource }),
    )
    mockResolveWorkDir.mockResolvedValue('/ws-root/chat-feat')

    const res = await chat({
      message: 'hello',
      worktree: { name: 'chat-feat', cleanup: 'ephemeral' },
    })

    expect(res.status).toBe(200)
    expect(mockResolveWorkDir).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agt_test1' }),
      { name: 'chat-feat', cleanup: 'ephemeral' },
      expect.any(String),
      undefined,
    )

    const runInsert = insertCalls.find(
      (c) => (c as Record<string, unknown>).intent === 'hello' && 'worktreeConfig' in (c as object),
    )
    expect(runInsert).toBeDefined()
    expect((runInsert as any).worktreeConfig).toEqual({ name: 'chat-feat', cleanup: 'ephemeral' })
  })

  it("rejects new explicit worktrees using the reserved 'agent-' prefix (400)", async () => {
    mockDb.select.mockReturnValue(
      selectChainForChat({ agent: publishedAgent, source: scmSyncedSource }),
    )

    const res = await chat({
      message: 'hi',
      worktree: { name: 'agent-abc123', cleanup: 'ephemeral' },
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('agent-')
    expect(mockResolveWorkDir).not.toHaveBeenCalled()
  })

  it('WorktreeOccupiedError → 409', async () => {
    mockDb.select.mockReturnValue(
      selectChainForChat({ agent: publishedAgent, source: scmSyncedSource }),
    )
    mockResolveWorkDir.mockRejectedValue(new WorktreeOccupiedErrorMock('/ws/taken'))

    const res = await chat({ message: 'hi', worktree: { name: 'taken', cleanup: 'ephemeral' } })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('/ws/taken')
  })

  it('WorktreeBranchLockedError → 409', async () => {
    mockDb.select.mockReturnValue(
      selectChainForChat({ agent: publishedAgent, source: scmSyncedSource }),
    )
    mockResolveWorkDir.mockRejectedValue(new WorktreeBranchLockedErrorMock('hotfix', '/ws/older'))

    const res = await chat({
      message: 'hi',
      worktree: { name: 'newer', branch: 'hotfix', cleanup: 'ephemeral' },
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('hotfix')
  })

  it('hands post-resolution insert failures to the lifecycle cleanup boundary', async () => {
    mockDb.select.mockReturnValue(
      selectChainForChat({ agent: publishedAgent, source: scmSyncedSource }),
    )
    mockResolveWorkDir.mockResolvedValue('/ws/prepared')
    let insertNumber = 0
    mockDb.insert.mockImplementation(() => {
      insertNumber += 1
      if (insertNumber === 2) {
        return { values: vi.fn().mockRejectedValue(new Error('step insert failed')) }
      }
      return makeInsertChain()
    })

    const res = await chat({
      message: 'hi',
      worktree: { name: 'prepared', cleanup: 'ephemeral' },
    })

    expect(res.status).toBe(500)
    // The ephemeral worktree acquired by resolveWorkDir must be released BEFORE
    // abandonRun clears runs.workDir / deletes the row: cleanupWorktreeIfEphemeral
    // reads those columns to decide, so afterwards it silently no-ops and the
    // worktree leaks. recoverRunStartup runs `cleanup` ahead of `settleRun`.
    expect(mockCleanupWorktreeIfEphemeral).toHaveBeenCalledWith(expect.any(String), 'agt_test1')
    expect(mockCleanupWorktreeIfEphemeral.mock.invocationCallOrder[0]).toBeLessThan(
      mockScheduleNext.mock.invocationCallOrder[0],
    )
    // ...and the run must still converge: steps failed, run row reclaimed, and
    // the queue woken so the released slot is reused.
    expect(mockFailRunSteps).toHaveBeenCalledWith(expect.any(String))
    expect(deleteCalls.length).toBeGreaterThan(0)
    expect(mockScheduleNext).toHaveBeenCalled()
  })

  it('复用 run 的轮 worktree 冲突回滚时还原 worktreeConfig（不残留新一轮配置，review 回归）', async () => {
    // 多轮会话复用已完成 run：新一轮带 worktree wt-B 覆盖了行上的 wt-A（line ~1350），
    // 随后 resolveWorkDir 冲突 409 → abandonRun 回滚。修复前回滚漏了 worktreeConfig，
    // 行上残留 wt-B，后续 rerun/出队会跑错 workspace。
    const priorWorktreeConfig = { name: 'wt-A', cleanup: 'persistent' as const }
    const existingRun = {
      id: 'run_prior',
      status: 'completed',
      intent: 'turn 1',
      executionMetadata: null,
      worktreeConfig: priorWorktreeConfig,
      result: { chatId: 'chat_1' },
    }
    // select 序列：agent → scmSource → existingRun（chatId 命中复用）
    const getResults = [publishedAgent, scmSyncedSource, existingRun]
    let idx = 0
    mockDb.select.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockImplementation(() => {
                const v = getResults[idx] ?? undefined
                idx++
                return v
              }),
            }),
          ),
        }),
      }),
    )
    mockResolveWorkDir.mockRejectedValue(new WorktreeOccupiedErrorMock('/ws/taken'))

    const res = await chat({
      message: 'turn 2',
      chatId: 'chat_1',
      worktree: { name: 'wt-B', cleanup: 'ephemeral' },
    })
    expect(res.status).toBe(409)

    // abandonRun 还原 update：intent 回 turn 1，worktreeConfig 必须回 wt-A。
    const restore = runsSetCalls.find((c) => (c as Record<string, unknown>).intent === 'turn 1') as
      | Record<string, unknown>
      | undefined
    expect(restore).toBeDefined()
    expect(restore?.worktreeConfig).toEqual(priorWorktreeConfig)
  })
})

// ============================================================
// 回归: 排队场景也要持久化 worktreeConfig
// ============================================================

describe('Gateway /invoke — queued 场景', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    runsSetCalls.length = 0
    insertCalls.length = 0
    deleteCalls.length = 0
    mockResolveWorkDir.mockReset()
    mockTryAcquireSlot.mockReset().mockReturnValue('queued') // 模拟达到并发上限
    mockScheduleNext.mockReset()
    mockDb.insert.mockImplementation(() => makeInsertChain())
    mockDb.update.mockImplementation(() => makeUpdateChain())
    mockDb.delete.mockImplementation(() => makeDeleteChain())
    mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))

    const mod = await import('../gateway.js')
    app = new Hono()
    app.route('/api/gateway', mod.default)
  })

  it('排队返回 202 时，run insert 已带上 worktreeConfig（修复前 queued 会丢参数）', async () => {
    const res = await app.request('/api/gateway/agt_test1/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'queued-one',
        async: true,
        worktree: { name: 'feat-queued', branch: 'feat/q', cleanup: 'ephemeral' },
      }),
    })

    expect(res.status).toBe(202)
    const body = (await res.json()) as { data: { status: string } }
    expect(body.data.status).toBe('queued')

    // resolveWorkDir 在排队路径不应被调用（延迟到 scheduler 拉起时）
    expect(mockResolveWorkDir).not.toHaveBeenCalled()

    // runs insert 必须包含 worktreeConfig，供后续 executeChatRun 读取
    const runsInsert = insertCalls.find(
      (v) => (v as { worktreeConfig?: unknown }).worktreeConfig !== undefined,
    )
    expect(runsInsert).toBeDefined()
    // 回归: branch 字段也必须随 worktreeConfig 一同落库，否则 executeChatRun
    // 出队还原 worktreeParams 时会丢失 branch，导致队列路径走错分支（#MR89 review）
    expect((runsInsert as { worktreeConfig: unknown }).worktreeConfig).toEqual({
      name: 'feat-queued',
      branch: 'feat/q',
      cleanup: 'ephemeral',
    })
  })
})

// ============================================================
// 回归: 409 场景不应残留 runSteps / chatMessages + 应释放 slot
// ============================================================

describe('Gateway /invoke — 409 清理', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    runsSetCalls.length = 0
    insertCalls.length = 0
    deleteCalls.length = 0
    mockResolveWorkDir.mockReset()
    mockTryAcquireSlot.mockReset().mockReturnValue('acquired')
    mockScheduleNext.mockReset()
    mockDb.insert.mockImplementation(() => makeInsertChain())
    mockDb.update.mockImplementation(() => makeUpdateChain())
    mockDb.delete.mockImplementation(() => makeDeleteChain())
    mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))

    const mod = await import('../gateway.js')
    app = new Hono()
    app.route('/api/gateway', mod.default)
  })

  it('worktree 409 时：不写 runSteps/chatMessages，删除 run，并触发 scheduleNext 释放 slot', async () => {
    mockResolveWorkDir.mockRejectedValue(new WorktreeOccupiedErrorMock('/ws/busy'))

    const res = await app.request('/api/gateway/agt_test1/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'x',
        async: true,
        worktree: { name: 'busy', cleanup: 'ephemeral' },
      }),
    })

    expect(res.status).toBe(409)

    // 没有 runSteps / chatMessages 插入（只有最初的 runs insert）
    const hasStepInsert = insertCalls.some(
      (v) => (v as { order?: unknown; status?: unknown }).order !== undefined,
    )
    const hasMessageInsert = insertCalls.some((v) => (v as { role?: unknown }).role === 'user')
    expect(hasStepInsert).toBe(false)
    expect(hasMessageInsert).toBe(false)

    // run 被删除 + slot 释放
    expect(deleteCalls.length).toBeGreaterThan(0)
    expect(mockScheduleNext).toHaveBeenCalled()
  })
})
