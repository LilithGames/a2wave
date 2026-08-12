import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/client.js'
import { runSteps, runs } from '../../db/schema.js'
import { scheduleNext } from '../../engine/task-queue.js'
import {
  cleanupWorktreeIfEphemeral,
  finishRunAborted,
  finishRunError,
  finishRunSuccess,
} from '../run-lifecycle.js'

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

/**
 * A `sql\`...\`` accumulation expression (e.g. `COALESCE(${runs.inputTokens}, 0) + ${delta}`)
 * is a real drizzle SQL object, not a plain value — asserting `toHaveProperty('inputTokens')`
 * on the `.set()` payload only proves a key was set, NOT that it's an accumulation (as opposed
 * to e.g. an accidental overwrite with a literal number). This walks `sql.queryChunks` (drizzle's
 * public fragment list — string literals, column refs, and bound params interleaved) and
 * reconstructs a readable SQL string plus the list of bound numeric params, so tests can assert
 * both "this references COALESCE(<column>, 0)" and "the bound delta is exactly <value>".
 */
function sqlFragmentSummary(fragment: unknown): { text: string; values: number[] } {
  const chunks = (fragment as { queryChunks: unknown[] }).queryChunks
  const values: number[] = []
  const text = chunks
    .map((chunk) => {
      if (
        chunk &&
        typeof chunk === 'object' &&
        Array.isArray((chunk as { value?: unknown }).value)
      ) {
        // StringChunk: raw SQL text fragment, e.g. "COALESCE(" / ", 0) + " / ""
        return ((chunk as { value: string[] }).value ?? []).join('')
      }
      if (chunk && typeof chunk === 'object' && 'columnType' in (chunk as object)) {
        // Column reference, e.g. runs.inputTokens → 'input_tokens'
        return (chunk as { name: string }).name
      }
      // Bound literal (boxed Number for the delta value)
      const num = Number(chunk)
      values.push(num)
      return String(num)
    })
    .join('')
  return { text, values }
}

const {
  whereCalls,
  setCalls,
  insertCalls,
  sqliteExec,
  sqliteState,
  mockScanAndRegisterArtifacts,
  mockDbGet,
  mockDbRun,
  mockDbInsertRun,
  mockCreateScmSource,
  mockNotifyRunError,
} = vi.hoisted(() => ({
  whereCalls: [] as unknown[],
  setCalls: [] as unknown[],
  insertCalls: [] as Record<string, unknown>[],
  // Records the BEGIN/COMMIT/ROLLBACK the SQLite branch of `withTransaction`
  // drives, which is that path's equivalent of a `db.transaction` call.
  sqliteExec: vi.fn(),
  sqliteState: { inTransaction: false },
  mockScanAndRegisterArtifacts: vi.fn().mockResolvedValue([]),
  mockDbGet: vi.fn().mockReturnValue({ name: 'Test Agent' }),
  mockDbRun: vi.fn().mockReturnValue({ changes: 1 }),
  mockDbInsertRun: vi.fn(),
  mockCreateScmSource: vi.fn(),
  mockNotifyRunError: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../db/client.js', () => ({
  db: (() => {
    const database = {
      update: vi.fn().mockReturnValue(
        asyncQuery({
          // The `set` payload is handed to `mockDbRun` so a test can key its outcome on
          // the write it is actually terminating. Peeking at `setCalls.at(-1)` instead
          // is unreliable now that writes are awaited: an unrelated `.set()` can be
          // pushed between this chain's `.set()` and the moment it is awaited.
          set: vi.fn().mockImplementation((arg: unknown) => {
            setCalls.push(arg)
            return {
              where: vi.fn().mockImplementation((cond: unknown) => {
                whereCalls.push(cond)
                return asyncQuery({ run: () => mockDbRun(arg) })
              }),
            }
          }),
        }),
      ),
      insert: vi.fn().mockReturnValue(
        asyncQuery({
          values: vi.fn().mockImplementation((arg: Record<string, unknown>) => {
            insertCalls.push(arg)
            return asyncQuery({ run: mockDbInsertRun })
          }),
        }),
      ),
      select: vi.fn().mockReturnValue(
        asyncQuery({
          from: vi.fn().mockReturnValue(
            asyncQuery({
              where: vi.fn().mockReturnValue(
                asyncQuery({
                  get: mockDbGet,
                }),
              ),
            }),
          ),
        }),
      ),
      transaction: vi.fn(),
    }
    database.transaction.mockImplementation((fn: (tx: typeof database) => unknown) => fn(database))
    return database
  })(),
  // Stay on the SQLite dialect: these tests assert the SQLite JSON builder
  // (`json_set`), so flipping to PostgreSQL would rewrite the fragment to
  // `jsonb_set`. `withTransaction` therefore drives BEGIN/COMMIT on the raw
  // handle below instead of calling `db.transaction`, and `sqliteExec` records
  // that boundary for the ownership assertions.
  isPostgres: false,
  sqliteDatabase: {
    get inTransaction() {
      return sqliteState.inTransaction
    },
    exec: (statement: string) => {
      sqliteExec(statement)
      sqliteState.inTransaction = statement === 'BEGIN'
    },
  },
}))

const mockCompleteExecutionLease = vi.hoisted(() => vi.fn())
vi.mock('../../engine/execution-lease-registry.js', () => ({
  completeExecutionLease: mockCompleteExecutionLease,
}))

vi.mock('../scm-source.js', () => ({
  createScmSource: mockCreateScmSource,
}))

vi.mock('../webhook-notifier.js', () => ({
  notifyRunError: mockNotifyRunError,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('../../engine/task-queue.js', () => ({
  scheduleNext: vi.fn(),
  taskQueueDb: {},
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

vi.mock('../execute-chat-run.js', () => ({
  executeChatRun: vi.fn(),
}))

const mockSendSlackResultByContext = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockSendDiscordResultByContext = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../slack-service.js', () => ({
  slackConnectionManager: { sendRunResultByContext: mockSendSlackResultByContext },
}))
vi.mock('../discord-service.js', () => ({
  discordConnectionManager: { sendRunResultByContext: mockSendDiscordResultByContext },
}))

vi.mock('../artifact-storage.js', () => ({
  scanAndRegisterArtifacts: mockScanAndRegisterArtifacts,
}))

const mockGetArtifactDownloadUrl = vi.hoisted(() =>
  vi.fn((id: string) => `https://a2wave.example.com/api/artifacts/${id}/download`),
)
vi.mock('../server-url.js', () => ({
  getArtifactDownloadUrl: mockGetArtifactDownloadUrl,
  getShareUrl: vi.fn((id: string) => `https://a2wave.example.com/s/${id}`),
}))

const mockBuildArtifactLinkLines = vi.hoisted(() =>
  vi.fn(async (artifacts: Array<{ id: string; filename: string }>) =>
    artifacts
      .map((a) => `- [${a.filename}](https://a2wave.example.com/api/artifacts/${a.id}/download)`)
      .join('\n'),
  ),
)
vi.mock('../artifact-links.js', () => ({
  buildArtifactLinkLines: mockBuildArtifactLinkLines,
}))

const runId = 'run_1'
const stepId = 'rst_1'
const agentId = 'agt_1'
const baseParams = {
  taskId: 'run_1/rst_1',
  runId,
  stepId,
  agentId,
  startTime: Date.now() - 1000,
}

describe('finishRunSuccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbRun.mockReturnValue({ changes: 1 })
    mockDbInsertRun.mockReset()
    whereCalls.length = 0
    setCalls.length = 0
    insertCalls.length = 0
    sqliteExec.mockClear()
    sqliteState.inTransaction = false
  })

  // ── Empty-output persisted content: Feishu fallback must NOT leak into
  //    non-Feishu chat history (web/CLI/gateway API). ──
  const agentChatContent = () =>
    (insertCalls.find((c) => c.role === 'agent')?.content as string | undefined) ?? null

  it('空输出 + 非飞书 run：chatMessages 存原始空串，不写飞书兜底文案', async () => {
    mockDbGet.mockReturnValueOnce({ input: { context: { channel: { channel_type: 'api' } } } })
    await finishRunSuccess(baseParams, {
      success: true,
      output: '',
      chatId: undefined,
      durationMs: 0,
    })

    expect(agentChatContent()).toBe('')
  })

  it('空输出 + 飞书 run（channel_type=feishu）：chatMessages 存兜底文案（含 run_id）', async () => {
    mockDbGet.mockReturnValueOnce({ input: { context: { channel: { channel_type: 'feishu' } } } })
    await finishRunSuccess(baseParams, {
      success: true,
      output: '   ',
      chatId: undefined,
      durationMs: 0,
    })

    const content = agentChatContent()
    expect(content).toContain('未返回有效内容')
    expect(content).toContain(`run_id=${runId}`)
  })

  it('空输出 + 携带 receive_id 的 run：同样写兜底文案', async () => {
    mockDbGet.mockReturnValueOnce({
      input: { context: { receive_id_type: 'chat_id', receive_id: 'oc_x' } },
    })
    await finishRunSuccess(baseParams, {
      success: true,
      output: '',
      chatId: undefined,
      durationMs: 0,
    })

    expect(agentChatContent()).toContain('未返回有效内容')
  })

  it('有输出时始终存原始输出，不受渠道影响', async () => {
    mockDbGet.mockReturnValueOnce({ input: { context: { channel: { channel_type: 'feishu' } } } })
    await finishRunSuccess(baseParams, {
      success: true,
      output: 'real',
      chatId: undefined,
      durationMs: 0,
    })

    expect(agentChatContent()).toBe('real')
  })

  it('delivers successful Slack output through the persisted channel context', async () => {
    const channel = {
      channel_type: 'slack',
      channel_info: {
        app_id: 'A123',
        team_id: 'T123',
        channel_id: 'C123',
        chat_type: 'channel',
        message_ts: '1710000000.000001',
        sender_user_id: 'U123',
      },
      user_info: null,
    }
    mockDbGet.mockReturnValueOnce({ input: { context: { channel } } })

    await finishRunSuccess(baseParams, {
      success: true,
      output: 'Slack answer',
      chatId: 'chat_1',
      durationMs: 0,
    })

    await vi.waitFor(() => {
      expect(mockSendSlackResultByContext).toHaveBeenCalledWith(
        agentId,
        channel,
        'Slack answer',
        [],
      )
    })
  })

  it('delivers an empty Discord result as a non-sensitive fallback', async () => {
    const channel = {
      channel_type: 'discord',
      channel_info: {
        application_id: 'APP',
        channel_id: 'C123',
        chat_type: 'dm',
        message_id: 'M123',
        sender_user_id: 'U123',
      },
      user_info: null,
    }
    mockDbGet.mockReturnValueOnce({ input: { context: { channel } } })

    await finishRunSuccess(baseParams, {
      success: true,
      output: '',
      chatId: undefined,
      durationMs: 0,
    })

    expect(agentChatContent()).toContain(`run_id=${runId}`)
    await vi.waitFor(() => {
      expect(mockSendDiscordResultByContext).toHaveBeenCalledWith(
        agentId,
        channel,
        expect.stringContaining(`run_id=${runId}`),
        [],
      )
    })
  })

  it('delivers registered artifacts only after the artifact scan finishes', async () => {
    const channel = {
      channel_type: 'slack',
      channel_info: {
        app_id: 'A123',
        team_id: 'T123',
        channel_id: 'C123',
        chat_type: 'channel',
        message_ts: '1710000000.000001',
        sender_user_id: 'U123',
      },
      user_info: null,
    }
    const artifact = {
      id: 'art_1',
      filename: 'report.pdf',
      storagePath: '/tmp/report.pdf',
      kind: 'file' as const,
      mimeType: 'application/pdf',
      agentId,
    }
    let resolveScan: ((artifacts: (typeof artifact)[]) => void) | undefined
    mockScanAndRegisterArtifacts.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveScan = resolve
      }),
    )
    mockDbGet
      .mockReturnValueOnce({ input: { context: { channel } } })
      .mockReturnValueOnce({ artifactPolicy: null })

    const finishing = finishRunSuccess(
      { ...baseParams, workDir: '/tmp/a2wave-workdir' },
      { success: true, output: 'Done', chatId: undefined, durationMs: 0 },
    )
    await Promise.resolve()
    expect(mockSendSlackResultByContext).not.toHaveBeenCalled()

    resolveScan?.([artifact])
    await finishing
    await vi.waitFor(() => {
      expect(mockSendSlackResultByContext).toHaveBeenCalledWith(
        agentId,
        channel,
        expect.stringContaining('Done'),
        [artifact],
      )
    })
  })

  it('claims terminal ownership only from running status', async () => {
    await finishRunSuccess(baseParams, {
      success: true,
      output: 'ok',
      chatId: undefined,
      durationMs: 0,
    })

    expect(whereCalls).toHaveLength(2)
    expect(whereCalls[0]).toEqual(and(eq(runs.id, runId), eq(runs.status, 'running')))
    expect(whereCalls[1]).toEqual(and(eq(runSteps.id, stepId), eq(runSteps.status, 'running')))
    // Both claims commit inside exactly one transaction.
    expect(sqliteExec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
  })

  it('still releases the slot when a post-success side effect throws', async () => {
    mockDbInsertRun.mockImplementationOnce(() => {
      throw new Error('chat insert failed')
    })

    await finishRunSuccess(baseParams, {
      success: true,
      output: 'ok',
      chatId: undefined,
      durationMs: 0,
    })

    expect(mockCompleteExecutionLease).toHaveBeenCalledWith(runId)
    expect(vi.mocked(scheduleNext)).toHaveBeenCalledOnce()
  })

  it('releases the slot when the run CAS succeeds but the step CAS fails', async () => {
    mockDbRun.mockReturnValueOnce({ changes: 1 }).mockReturnValueOnce({ changes: 0 })

    await expect(
      finishRunSuccess(baseParams, {
        success: true,
        output: 'late output',
        chatId: undefined,
        durationMs: 0,
      }),
    ).resolves.toEqual([])

    expect(insertCalls).toHaveLength(0)
    expect(setCalls.at(-1)).toEqual(
      expect.objectContaining({
        status: 'failed',
        result: { error: `Run step "${stepId}" lost terminal-state ownership` },
      }),
    )
    expect(mockCompleteExecutionLease).toHaveBeenCalledWith(runId)
    expect(vi.mocked(scheduleNext)).toHaveBeenCalledOnce()
  })

  it('skips success side effects when terminal-state CAS loses to cancellation', async () => {
    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    mockCreateScmSource.mockReturnValue({ wsRoot: '/ws', removeWorkspace })
    mockDbRun.mockReturnValueOnce({ changes: 0 })
    mockDbGet
      .mockReturnValueOnce({ status: 'cancelled' })
      .mockReturnValueOnce({
        workDir: '/ws/fix',
        worktreeConfig: { name: 'fix', cleanup: 'ephemeral' },
      })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ scmSourceId: 'scm_1' })
      .mockReturnValueOnce({ id: 'scm_1' })

    await finishRunSuccess(
      { ...baseParams, workDir: '/tmp/a2wave-workdir' },
      { success: true, output: 'late output', chatId: undefined, durationMs: 0 },
    )

    expect(insertCalls).toHaveLength(0)
    expect(mockScanAndRegisterArtifacts).not.toHaveBeenCalled()
    expect(vi.mocked(scheduleNext)).not.toHaveBeenCalled()
    expect(mockCompleteExecutionLease).toHaveBeenCalledWith(runId)
    expect(removeWorkspace).toHaveBeenCalledWith('fix')
  })

  it.each(['completed', 'failed'])(
    'skips success side effects when run is already %s',
    async (status) => {
      mockDbRun.mockReturnValueOnce({ changes: 0 })
      mockDbGet.mockReturnValueOnce({ status })

      await finishRunSuccess(
        { ...baseParams, workDir: '/tmp/a2wave-workdir' },
        { success: true, output: 'late output', chatId: undefined, durationMs: 0 },
      )

      expect(insertCalls).toHaveLength(0)
      expect(mockScanAndRegisterArtifacts).not.toHaveBeenCalled()
      expect(mockCreateScmSource).not.toHaveBeenCalled()
      expect(mockCompleteExecutionLease).not.toHaveBeenCalled()
      expect(vi.mocked(scheduleNext)).not.toHaveBeenCalled()
    },
  )

  it.each(['completed', 'failed'])(
    'does not count usage when terminal ownership was already claimed by %s',
    async (status) => {
      mockDbRun.mockReturnValueOnce({ changes: 0 })
      mockDbGet.mockReturnValueOnce({ status })

      await finishRunSuccess(baseParams, {
        success: true,
        output: 'late output',
        chatId: undefined,
        durationMs: 0,
        usage: { inputTokens: 17, outputTokens: 3 },
      })

      expect(setCalls.some((call) => 'inputTokens' in (call as object))).toBe(false)
      expect(setCalls.some((call) => 'outputTokens' in (call as object))).toBe(false)
    },
  )

  it('counts a cancelled late settlement exactly once across duplicate callbacks', async () => {
    let usageGuardCalls = 0
    mockDbRun.mockImplementation((write: Record<string, unknown> | undefined) => {
      if (write?.status === 'completed' && 'updatedAt' in write) {
        return { changes: 0 }
      }
      if (write && Object.keys(write).length === 1 && 'output' in write) {
        usageGuardCalls += 1
        return { changes: usageGuardCalls === 1 ? 1 : 0 }
      }
      return { changes: 1 }
    })
    mockDbGet
      .mockReturnValueOnce({ status: 'cancelled' })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ status: 'cancelled' })
      .mockReturnValueOnce(undefined)

    const result = {
      success: true,
      output: 'late output',
      chatId: undefined,
      durationMs: 0,
      usage: { inputTokens: 19, outputTokens: 4 },
    }
    await finishRunSuccess(baseParams, result)
    await finishRunSuccess(baseParams, result)

    const totalWrites = setCalls.filter((call) => 'inputTokens' in (call as object))
    expect(totalWrites).toHaveLength(1)
    expect(
      sqlFragmentSummary((totalWrites[0] as { inputTokens: unknown }).inputTokens).values,
    ).toEqual([19])
  })

  it('still cleans up after usage persistence fails on a completed run', async () => {
    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    mockCreateScmSource.mockReturnValue({ wsRoot: '/ws', removeWorkspace })
    mockDbGet
      .mockReturnValueOnce({ input: { context: {} } })
      .mockReturnValueOnce({ artifactPolicy: null })
      .mockReturnValueOnce({
        workDir: '/ws/fix',
        worktreeConfig: { name: 'fix', cleanup: 'ephemeral' },
      })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ scmSourceId: 'scm_1' })
      .mockReturnValueOnce({ id: 'scm_1' })
    mockDbRun.mockImplementation((write: Record<string, unknown> | undefined) => {
      if (write && Object.keys(write).length === 1 && 'output' in write) {
        throw new Error('usage storage unavailable')
      }
      return { changes: 1 }
    })

    await expect(
      finishRunSuccess(
        { ...baseParams, workDir: '/ws/fix' },
        {
          success: true,
          output: 'ok',
          chatId: undefined,
          durationMs: 0,
          usage: { inputTokens: 23 },
        },
      ),
    ).resolves.toEqual([])

    expect(mockCompleteExecutionLease).toHaveBeenCalledWith(runId)
    expect(vi.mocked(scheduleNext)).toHaveBeenCalledOnce()
    expect(removeWorkspace).toHaveBeenCalledWith('fix')
  })

  it('success=false: step output 包含 error 字段', async () => {
    await finishRunSuccess(baseParams, {
      success: false,
      output: '',
      error: 'agent failed',
      chatId: undefined,
      durationMs: 0,
    })

    const stepSetCall = setCalls.find(
      (c) => (c as any).status === 'failed' && (c as any).output,
    ) as any
    expect(stepSetCall?.output?.error).toBe('agent failed')
  })

  it('success=false 且无 error 字段时: step output 不含 error', async () => {
    await finishRunSuccess(baseParams, {
      success: false,
      output: '',
      chatId: undefined,
      durationMs: 0,
    })

    const stepSetCall = setCalls.find((c) => (c as any).status === 'failed') as any
    expect(stepSetCall?.output?.error).toBeUndefined()
  })

  it('passes startTime to artifact registration to avoid stale files from previous runs', async () => {
    await finishRunSuccess(
      { ...baseParams, workDir: '/tmp/a2wave-workdir', userId: 'usr_1' },
      { success: true, output: 'ok', chatId: undefined, durationMs: 0 },
    )

    expect(mockScanAndRegisterArtifacts).toHaveBeenCalledWith(
      runId,
      agentId,
      'usr_1',
      '/tmp/a2wave-workdir',
      { registeredAfterMs: baseParams.startTime },
    )
  })

  it('awaits scanAndRegisterArtifacts BEFORE cleanupWorktreeIfEphemeral (no race on workDir)', async () => {
    // 回归 MR!89 review #2：cleanupWorktreeIfEphemeral 会 removeWorkspace 删目录，
    // 若与 scanAndRegisterArtifacts 并行，扫描可能读到半删目录或完全丢失产物。
    // 必须先 await 扫描，再 await cleanup。
    let scanResolved = false
    let deferResolve: (v: { id: string; filename: string }[]) => void = () => {}
    mockScanAndRegisterArtifacts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deferResolve = (v) => {
            scanResolved = true
            resolve(v)
          }
        }),
    )
    // 让 cleanup 路径在 removeWorkspace 之前触发（workDir + ephemeral + 同路径 scm）
    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    mockCreateScmSource.mockReturnValue({ wsRoot: '/ws', removeWorkspace })
    mockDbGet
      .mockReturnValueOnce({ input: { context: {} } }) // runSteps select in finishRunSuccess
      .mockReturnValueOnce({ artifactPolicy: null }) // agents select for artifactPolicy
      .mockReturnValueOnce({
        workDir: '/ws/fix',
        worktreeConfig: { name: 'fix', cleanup: 'ephemeral' },
      }) // cleanup: runs lookup
      .mockReturnValueOnce(undefined) // cleanup: occupied check
      .mockReturnValueOnce({ scmSourceId: 'scm_1' }) // cleanup: agents lookup
      .mockReturnValueOnce({ id: 'scm_1' }) // cleanup: scmSources lookup

    const p = finishRunSuccess(
      { ...baseParams, workDir: '/ws/fix', userId: 'usr_1' },
      { success: true, output: 'ok', chatId: undefined, durationMs: 0 },
    )

    // 让调度和扫描的同步部分执行完，但扫描 promise 仍未 resolve。
    // Reaching the scan now spans several awaited DB reads, so drain the microtask
    // queue until it is actually invoked instead of assuming a fixed number of turns.
    for (let i = 0; i < 50 && mockScanAndRegisterArtifacts.mock.calls.length === 0; i++) {
      await Promise.resolve()
    }
    expect(mockScanAndRegisterArtifacts).toHaveBeenCalled()

    // 扫描未 resolve 时，cleanup 的 removeWorkspace 绝不能被调用
    expect(scanResolved).toBe(false)
    expect(removeWorkspace).not.toHaveBeenCalled()

    deferResolve([])
    await p

    // 扫描完成后，cleanup 才执行
    expect(scanResolved).toBe(true)
    expect(removeWorkspace).toHaveBeenCalledWith('fix')
  })

  it('artifact links in chat message use getArtifactDownloadUrl', async () => {
    mockScanAndRegisterArtifacts.mockResolvedValueOnce([{ id: 'art_abc', filename: 'report.md' }])
    mockGetArtifactDownloadUrl.mockImplementation(
      (id: string) => `https://a2wave.example.com/api/artifacts/${id}/download`,
    )

    await finishRunSuccess(
      { ...baseParams, workDir: '/tmp/workdir', userId: 'usr_1' },
      { success: true, output: 'Done', chatId: undefined, durationMs: 0 },
    )

    const chatMsgSet = setCalls.find((c) => (c as any).content?.includes('产物下载')) as any
    expect(chatMsgSet).toBeDefined()
    expect(chatMsgSet.content).toContain(
      'https://a2wave.example.com/api/artifacts/art_abc/download',
    )
  })

  it('persists step usage and accumulates run token columns', async () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 9,
      cacheReadTokens: 500,
    }
    await finishRunSuccess(baseParams, {
      success: true,
      output: 'ok',
      chatId: 'chat_1',
      durationMs: 1200,
      usage,
    })

    // The primary step update does not inline usage into its output object.
    const mainStepCall = setCalls.find(
      (c) => 'status' in (c as any) && 'durationMs' in (c as any),
    ) as any
    expect(mainStepCall.output).not.toHaveProperty('usage')

    // The usage transaction writes the step JSON path separately through json_set.
    const stepUsageCall = setCalls.find((c) => {
      const keys = Object.keys(c as any)
      return keys.length === 1 && keys[0] === 'output'
    }) as any
    expect(stepUsageCall).toBeDefined()
    expect(sqlFragmentSummary(stepUsageCall.output).text).toContain('json_set')

    // The same transaction accumulates each provided run column independently.
    const tokenSetCall = setCalls.find((c) => 'inputTokens' in (c as any)) as any
    expect(tokenSetCall).toBeDefined()

    const inputTokensFrag = sqlFragmentSummary(tokenSetCall.inputTokens)
    expect(inputTokensFrag.text).toContain('COALESCE(')
    expect(inputTokensFrag.text).toContain('input_tokens')
    expect(inputTokensFrag.values).toEqual([100])

    const outputTokensFrag = sqlFragmentSummary(tokenSetCall.outputTokens)
    expect(outputTokensFrag.text).toContain('COALESCE(')
    expect(outputTokensFrag.text).toContain('output_tokens')
    expect(outputTokensFrag.values).toEqual([40])

    const reasoningTokensFrag = sqlFragmentSummary(tokenSetCall.reasoningTokens)
    expect(reasoningTokensFrag.text).toContain('COALESCE(')
    expect(reasoningTokensFrag.text).toContain('reasoning_tokens')
    expect(reasoningTokensFrag.values).toEqual([9])

    const cacheReadTokensFrag = sqlFragmentSummary(tokenSetCall.cacheReadTokens)
    expect(cacheReadTokensFrag.text).toContain('COALESCE(')
    expect(cacheReadTokensFrag.text).toContain('cache_read_tokens')
    expect(cacheReadTokensFrag.values).toEqual([500])

    // An omitted cacheWriteTokens field remains the untracked NULL sentinel.
    expect(tokenSetCall).not.toHaveProperty('cacheWriteTokens')

    // The status update does not carry token columns.
    const statusSetCall = setCalls.find((c) => 'updatedAt' in (c as any)) as any
    expect(statusSetCall).not.toHaveProperty('inputTokens')
  })

  it('accumulates usage for an unsuccessful result while preserving failure state', async () => {
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 }
    await finishRunSuccess(baseParams, {
      success: false,
      output: '',
      error: 'boom',
      durationMs: 1,
      usage,
    })

    const runsSetCall = setCalls.find((c) => 'updatedAt' in (c as any)) as any
    // Existing failure semantics remain unchanged.
    expect(runsSetCall.status).toBe('failed')
    expect(runsSetCall.result).toEqual({ error: 'boom' })

    // Token accumulation applies to both successful and failed results.
    const tokenSetCall = setCalls.find((c) => 'inputTokens' in (c as any)) as any
    expect(sqlFragmentSummary(tokenSetCall.inputTokens).values).toEqual([10])
    expect(sqlFragmentSummary(tokenSetCall.outputTokens).values).toEqual([5])
    expect(sqlFragmentSummary(tokenSetCall.cacheReadTokens).values).toEqual([20])
    expect(tokenSetCall).not.toHaveProperty('cacheWriteTokens')
  })

  it('does not update token columns when usage is absent', async () => {
    await finishRunSuccess(baseParams, {
      success: true,
      output: 'ok',
      chatId: undefined,
      durationMs: 1,
    })

    const stepSetCall = setCalls.find((c) => 'output' in (c as any)) as any
    expect(stepSetCall.output).not.toHaveProperty('usage')

    for (const call of setCalls) {
      expect(call).not.toHaveProperty('inputTokens')
      expect(call).not.toHaveProperty('outputTokens')
      expect(call).not.toHaveProperty('cacheReadTokens')
      expect(call).not.toHaveProperty('cacheWriteTokens')
    }
  })

  it('records consumed tokens after an owned transition with a step-level guard', async () => {
    await finishRunSuccess(baseParams, {
      success: true,
      output: 'ok',
      chatId: 'chat_1',
      durationMs: 1,
      usage: { inputTokens: 7 },
    })

    // Status writes claim terminal ownership, then the usage transaction claims
    // the step before incrementing the run aggregate.
    expect(whereCalls).toHaveLength(4)
    expect(whereCalls[0]).toEqual(and(eq(runs.id, runId), eq(runs.status, 'running')))
    expect(whereCalls[1]).toEqual(and(eq(runSteps.id, stepId), eq(runSteps.status, 'running')))
    expect(whereCalls[2]).toBeDefined()
    expect(whereCalls[3]).toEqual(eq(runs.id, runId))
  })
})

describe('finishRunError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbRun.mockReturnValue({ changes: 1 })
    mockDbInsertRun.mockReset()
    whereCalls.length = 0
    setCalls.length = 0
    sqliteExec.mockClear()
    sqliteState.inTransaction = false
  })

  it('claims failure ownership only from running status', async () => {
    await finishRunError(baseParams, new Error('worker error'))

    expect(whereCalls).toHaveLength(2)
    expect(whereCalls[0]).toEqual(and(eq(runs.id, runId), eq(runs.status, 'running')))
    expect(whereCalls[1]).toEqual(and(eq(runSteps.id, stepId), eq(runSteps.status, 'running')))
    // Both claims commit inside exactly one transaction.
    expect(sqliteExec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
  })

  it('step output 包含真实 errorMsg', async () => {
    await finishRunError(baseParams, new Error('cursor-agent exited with SIGSEGV'))

    const stepSetCall = setCalls.find(
      (c) => (c as any).status === 'failed' && (c as any).output,
    ) as any
    expect(stepSetCall?.output?.error).toBe('cursor-agent exited with SIGSEGV')
  })

  it('run result 包含真实 errorMsg 而非通用消息', async () => {
    await finishRunError(baseParams, new Error('disk quota exceeded'))

    const runSetCall = setCalls.find((c) => (c as any).result) as any
    expect(runSetCall?.result?.error).toBe('disk quota exceeded')
    expect(runSetCall?.result?.error).not.toContain('Check server logs')
  })

  it('有 logs 时: step output 同时包含 logs 和 error', async () => {
    const logs = [{ type: 'assistant' as const, text: 'stdout output', ts: 0 }]
    await finishRunError({ ...baseParams, logs }, new Error('timeout after 15m'))

    const stepSetCall = setCalls.find(
      (c) => (c as any).status === 'failed' && (c as any).output,
    ) as any
    expect(stepSetCall?.output?.error).toBe('timeout after 15m')
    expect(stepSetCall?.output?.logs).toEqual(logs)
  })

  it('有 retries 时: step output 包含 retries', async () => {
    const retries = [{ attempt: 1, error: 'timeout', durationMs: 60000 }]
    await finishRunError({ ...baseParams, retries }, new Error('final failure'))

    const stepSetCall = setCalls.find(
      (c) => (c as any).status === 'failed' && (c as any).output,
    ) as any
    expect(stepSetCall?.output?.retries).toEqual(retries)
  })

  it('notifies Discord with a safe fallback when execution fails', async () => {
    const channel = {
      channel_type: 'discord',
      channel_info: {
        application_id: 'APP',
        channel_id: 'C123',
        chat_type: 'guild',
        message_id: 'M123',
        sender_user_id: 'U123',
      },
      user_info: null,
    }
    mockDbGet
      .mockReturnValueOnce({ input: { context: { channel } } })
      .mockReturnValueOnce({ name: 'Test Agent' })

    await finishRunError(baseParams, new Error('secret provider failure'))

    await vi.waitFor(() => {
      expect(mockSendDiscordResultByContext).toHaveBeenCalledWith(
        agentId,
        channel,
        expect.stringContaining(`run_id=${runId}`),
        [],
      )
    })
    expect(mockSendDiscordResultByContext.mock.calls[0]?.[2]).not.toContain(
      'secret provider failure',
    )
  })

  // ── L1: double-finalize guard ──
  // mockReturnValueOnce (not mockReturnValue) so the status only affects the
  // guard's single SELECT and does not leak into later tests' default get.
  it.each(['completed', 'failed', 'cancelled'])(
    '已是终态(%s)的 run 再次进入时跳过：不写库、不重复调度',
    async (status) => {
      mockDbRun.mockReturnValueOnce({ changes: 0 })
      mockDbGet.mockReturnValueOnce({ status })
      const msg = await finishRunError(baseParams, new Error('post-success feishu send failed'))

      // Caller still gets the public message…
      expect(msg).toContain('Check server logs')
      // …but the run record is untouched and the queue is not re-popped.
      expect(setCalls).toHaveLength(status === 'cancelled' ? 2 : 1)
      expect(whereCalls).toHaveLength(status === 'cancelled' ? 2 : 1)
      if (status === 'cancelled') {
        expect(setCalls[1]).toEqual({ status: 'cancelled' })
        expect(mockCompleteExecutionLease).toHaveBeenCalledWith(runId)
      } else {
        expect(mockCompleteExecutionLease).not.toHaveBeenCalled()
      }
      expect(vi.mocked(scheduleNext)).not.toHaveBeenCalled()
    },
  )

  it('counts a cancelled failed settlement exactly once across duplicate callbacks', async () => {
    let usageGuardCalls = 0
    mockDbRun.mockImplementation((write: Record<string, unknown> | undefined) => {
      if (write?.status === 'failed' && 'updatedAt' in write) {
        return { changes: 0 }
      }
      if (write && Object.keys(write).length === 1 && 'output' in write) {
        usageGuardCalls += 1
        return { changes: usageGuardCalls === 1 ? 1 : 0 }
      }
      return { changes: 1 }
    })
    mockDbGet
      .mockReturnValueOnce({ status: 'cancelled' })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ status: 'cancelled' })
      .mockReturnValueOnce(undefined)

    const usage = { inputTokens: 29, outputTokens: 2 }
    await finishRunError(baseParams, new Error('cancelled execution'), usage)
    await finishRunError(baseParams, new Error('cancelled execution'), usage)

    const totalWrites = setCalls.filter((call) => 'inputTokens' in (call as object))
    expect(totalWrites).toHaveLength(1)
    expect(
      sqlFragmentSummary((totalWrites[0] as { inputTokens: unknown }).inputTokens).values,
    ).toEqual([29])
  })

  it('running 状态的 run 正常 finalize 为 failed', async () => {
    mockDbGet.mockReturnValueOnce({ status: 'running' })
    await finishRunError(baseParams, new Error('worker error'))

    expect(setCalls.some((c) => (c as any).status === 'failed')).toBe(true)
    expect(vi.mocked(scheduleNext)).toHaveBeenCalled()
  })

  it('converges the run to failed and releases the slot when the step CAS fails', async () => {
    mockDbRun.mockReturnValueOnce({ changes: 1 }).mockReturnValueOnce({ changes: 0 })

    await expect(finishRunError(baseParams, new Error('worker error'))).resolves.toContain(
      'Check server logs',
    )

    expect(setCalls.at(-1)).toEqual(
      expect.objectContaining({ status: 'failed', result: { error: 'worker error' } }),
    )
    expect(mockCompleteExecutionLease).toHaveBeenCalledWith(runId)
    expect(vi.mocked(scheduleNext)).toHaveBeenCalledOnce()
  })
})

describe('finishRunAborted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbRun.mockReturnValue({ changes: 1 })
    mockDbInsertRun.mockReset()
    whereCalls.length = 0
    setCalls.length = 0
  })

  it('claims abort ownership only from running status', async () => {
    await finishRunAborted(baseParams, 'blocked before run')

    expect(whereCalls).toHaveLength(2)
    expect(whereCalls[0]).toEqual(and(eq(runs.id, runId), eq(runs.status, 'running')))
    expect(whereCalls[1]).toEqual(and(eq(runSteps.id, stepId), eq(runSteps.status, 'running')))
  })

  it('does not send the run error webhook notification', async () => {
    await finishRunAborted(baseParams, 'blocked before run')

    expect(mockNotifyRunError).not.toHaveBeenCalled()
  })

  it('persists the abort reason in step output and run result', async () => {
    await finishRunAborted(baseParams, 'blocked before run')

    const stepSetCall = setCalls.find(
      (c) => (c as any).status === 'failed' && (c as any).output,
    ) as any
    const runSetCall = setCalls.find((c) => (c as any).result) as any
    expect(stepSetCall?.output?.error).toBe('blocked before run')
    expect(runSetCall?.result?.error).toBe('blocked before run')
  })
})

describe('finishRunSuccess with retries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbRun.mockReturnValue({ changes: 1 })
    whereCalls.length = 0
    setCalls.length = 0
  })

  it('有 retries 时: step output 包含 retries', async () => {
    const retries = [
      { attempt: 1, error: 'timeout', durationMs: 60000 },
      { attempt: 2, error: 'network error', durationMs: 5000 },
    ]
    await finishRunSuccess(
      { ...baseParams, retries },
      { success: true, output: 'done', chatId: undefined, durationMs: 0 },
    )

    const stepSetCall = setCalls.find(
      (c) => (c as any).status === 'completed' && (c as any).output,
    ) as any
    expect(stepSetCall?.output?.retries).toEqual(retries)
  })
})

describe('cleanupWorktreeIfEphemeral', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbGet.mockReset()
  })

  it('no-op when run has no worktreeConfig', async () => {
    mockDbGet.mockReturnValueOnce({ workDir: '/ws', worktreeConfig: null })
    await cleanupWorktreeIfEphemeral('run_1', 'agt_1')
    expect(mockCreateScmSource).not.toHaveBeenCalled()
  })

  it('no-op when cleanup policy is not ephemeral', async () => {
    mockDbGet.mockReturnValueOnce({
      workDir: '/ws/fix',
      worktreeConfig: { name: 'fix', cleanup: 'ttl' },
    })
    await cleanupWorktreeIfEphemeral('run_1', 'agt_1')
    expect(mockCreateScmSource).not.toHaveBeenCalled()
  })

  it('no-op when cleanup policy is persistent', async () => {
    mockDbGet.mockReturnValueOnce({
      workDir: '/ws/keep',
      worktreeConfig: { name: 'keep', cleanup: 'persistent' },
    })
    await cleanupWorktreeIfEphemeral('run_1', 'agt_1')
    expect(mockCreateScmSource).not.toHaveBeenCalled()
  })

  it('skips cleanup when worktree is still occupied by another run', async () => {
    mockDbGet
      .mockReturnValueOnce({
        workDir: '/ws/fix',
        worktreeConfig: { name: 'fix', cleanup: 'ephemeral' },
      })
      .mockReturnValueOnce({ id: 'run_other' })

    await cleanupWorktreeIfEphemeral('run_1', 'agt_1')
    expect(mockCreateScmSource).not.toHaveBeenCalled()
  })

  it('no-op when agent has no scmSourceId', async () => {
    mockDbGet
      .mockReturnValueOnce({
        workDir: '/ws/fix',
        worktreeConfig: { name: 'fix', cleanup: 'ephemeral' },
      })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ id: 'agt_1', scmSourceId: null })

    await cleanupWorktreeIfEphemeral('run_1', 'agt_1')
    expect(mockCreateScmSource).not.toHaveBeenCalled()
  })

  it('no-op when source is missing', async () => {
    mockDbGet
      .mockReturnValueOnce({
        workDir: '/ws/fix',
        worktreeConfig: { name: 'fix', cleanup: 'ephemeral' },
      })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ id: 'agt_1', scmSourceId: 'scm_1' })
      .mockReturnValueOnce(undefined)

    await cleanupWorktreeIfEphemeral('run_1', 'agt_1')
    expect(mockCreateScmSource).not.toHaveBeenCalled()
  })

  it('no-op when scm type does not support workspaces', async () => {
    const source = { id: 'scm_1', type: 'p4' }
    mockDbGet
      .mockReturnValueOnce({
        workDir: '/ws/fix',
        worktreeConfig: { name: 'fix', cleanup: 'ephemeral' },
      })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ id: 'agt_1', scmSourceId: 'scm_1' })
      .mockReturnValueOnce(source)
    mockCreateScmSource.mockReturnValueOnce(null)

    await cleanupWorktreeIfEphemeral('run_1', 'agt_1')
    expect(mockCreateScmSource).toHaveBeenCalled()
  })

  it('calls removeWorkspace when ephemeral and not occupied', async () => {
    const source = { id: 'scm_1', type: 'git' }
    mockDbGet
      .mockReturnValueOnce({
        workDir: '/ws/fix',
        worktreeConfig: { name: 'fix', cleanup: 'ephemeral' },
      })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ id: 'agt_1', scmSourceId: 'scm_1' })
      .mockReturnValueOnce(source)

    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    mockCreateScmSource.mockReturnValueOnce({ removeWorkspace, wsRoot: '/ws' })

    await cleanupWorktreeIfEphemeral('run_1', 'agt_1')
    expect(removeWorkspace).toHaveBeenCalledWith('fix')
  })

  it('never removes the per-agent worktree, even with a legacy ephemeral config', async () => {
    // A worktreeConfig persisted before the reserved-prefix rule can name the
    // Agent's own long-lived workspace with cleanup: 'ephemeral'. Run-end
    // cleanup must skip it entirely — keeping the branch is not enough, the
    // directory holds uncommitted work.
    mockDbGet.mockReturnValueOnce({
      workDir: '/ws/agent-abc123def456ghi7',
      worktreeConfig: { name: 'agent-abc123def456ghi7', cleanup: 'ephemeral' },
    })
    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    mockCreateScmSource.mockReturnValue({ removeWorkspace, wsRoot: '/ws' })

    await cleanupWorktreeIfEphemeral('run_1', 'agt_abc123def456ghi7')
    expect(removeWorkspace).not.toHaveBeenCalled()
  })

  it("never removes another agent's per-agent worktree either", async () => {
    // The guard is on the workspace shape, not on "is it mine": a config
    // pointing at a different Agent's worktree would otherwise delete that
    // Agent's directory and `git branch -D` its unmerged commits.
    mockDbGet.mockReturnValueOnce({
      workDir: '/ws/agent-zzz999yyy888xxx7',
      worktreeConfig: { name: 'agent-zzz999yyy888xxx7', cleanup: 'ephemeral' },
    })
    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    mockCreateScmSource.mockReturnValue({ removeWorkspace, wsRoot: '/ws' })

    await cleanupWorktreeIfEphemeral('run_1', 'agt_abc123def456ghi7')
    expect(removeWorkspace).not.toHaveBeenCalled()
  })

  it('skips removeWorkspace when resolved path differs from run.workDir (scmSourceId rebind)', async () => {
    // 回归 #2：run 启动时 agent 用的是 S1，workDir=/old/ws/fix；
    // 期间管理员把 agent 切到 S2（wsRoot=/new/ws），cleanup 若按当前 scmSourceId
    // 直接调用 removeWorkspace('fix')，会误删 /new/ws/fix 上别的 agent 的 worktree。
    // 修复后：检测 join(scm.wsRoot, name) !== run.workDir 则拒绝删除。
    const source = { id: 'scm_2', type: 'git' }
    mockDbGet
      .mockReturnValueOnce({
        workDir: '/old/ws/fix',
        worktreeConfig: { name: 'fix', cleanup: 'ephemeral' },
      })
      .mockReturnValueOnce(undefined) // not occupied
      .mockReturnValueOnce({ id: 'agt_1', scmSourceId: 'scm_2' }) // agent now on S2
      .mockReturnValueOnce(source)

    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    mockCreateScmSource.mockReturnValueOnce({ removeWorkspace, wsRoot: '/new/ws' })

    await cleanupWorktreeIfEphemeral('run_1', 'agt_1')
    expect(removeWorkspace).not.toHaveBeenCalled()
  })

  it('removes via matching path when wsRoot+name equals run.workDir', async () => {
    const source = { id: 'scm_1', type: 'git' }
    mockDbGet
      .mockReturnValueOnce({
        workDir: '/ws/fix',
        worktreeConfig: { name: 'fix', cleanup: 'ephemeral' },
      })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ id: 'agt_1', scmSourceId: 'scm_1' })
      .mockReturnValueOnce(source)

    const removeWorkspace = vi.fn().mockResolvedValue(undefined)
    mockCreateScmSource.mockReturnValueOnce({ removeWorkspace, wsRoot: '/ws' })

    await cleanupWorktreeIfEphemeral('run_1', 'agt_1')
    expect(removeWorkspace).toHaveBeenCalledWith('fix')
  })
})
