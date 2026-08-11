import { beforeEach, describe, expect, it, vi } from 'vitest'

const existingRunResult: { value: { id: string; status: string; result: unknown } | undefined } = {
  value: undefined,
}

vi.mock('../../db/client.js', () => ({
  db: {
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    // Chained select for the new A2A idempotency lookup:
    // db.select(...).from(...).where(...).orderBy(...).limit(...).get()
    select: vi.fn(() =>
      asyncQuery({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() =>
                asyncQuery({
                  get: vi.fn(() => existingRunResult.value),
                }),
              ),
            })),
          })),
        })),
      }),
    ),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: Symbol('agents'),
  runs: Symbol('runs'),
  runSteps: Symbol('runSteps'),
  chatMessages: Symbol('chatMessages'),
}))

vi.mock('../../lib/execute-with-retry.js', () => ({
  executeWithRetry: vi.fn(),
}))

vi.mock('../../lib/run-lifecycle.js', () => ({
  finishRunSuccess: vi.fn(),
  finishRunError: vi.fn().mockReturnValue('error message'),
}))

const claimRunCancellationMock = vi.hoisted(() => vi.fn().mockReturnValue(true))
const cancelRunningTasksMock = vi.hoisted(() => vi.fn())
const stopLogCollectorMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const logAuditMock = vi.hoisted(() => vi.fn())

vi.mock('../../lib/run-cancellation.js', () => ({
  claimRunCancellation: claimRunCancellationMock,
  cancelRunningTasksInBackground: cancelRunningTasksMock,
}))

vi.mock('../../lib/run-log-registry.js', () => ({
  stopLogCollector: stopLogCollectorMock,
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: logAuditMock }))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

let idCounter = 0
vi.mock('../../lib/id.js', () => ({
  createId: (prefix: string) => `${prefix}_test_${++idCounter}`,
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: vi.fn(),
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

vi.mock('../caller.js', () => ({
  extractCallerAgentFromHeaders: vi
    .fn()
    .mockReturnValue({ agentId: 'agt_caller', agentName: 'Caller' }),
  X_A2WAVE_CHANNEL_B64_HEADER: 'X-A2WAVE-Channel-B64',
}))

// run-channel pulls in jose via gateway-auth → oidc; we mock at the
// builder seam so this test stays focused on the recording path.
vi.mock('../../lib/run-channel.js', () => ({
  buildGatewayChannel: vi.fn((_c: unknown, opts: Record<string, unknown>) => {
    const callerAgent = opts.callerAgent as { agentId?: string; agentName?: string } | undefined
    const assertedCallerAgent = opts.assertedCallerAgent as
      | { agentId?: string; agentName?: string }
      | undefined
    const assertedDisplayName = opts.assertedDisplayName as string | undefined
    const oauthCaller = opts.oauthCaller as
      | { userInfo?: { username?: string; email?: string } }
      | undefined
    const effectiveCallerAgent = assertedCallerAgent ?? (oauthCaller ? undefined : callerAgent)
    const displayName = oauthCaller?.userInfo?.username ?? assertedDisplayName ?? null
    return {
      ctx: {
        channel_type: 'a2a',
        channel_info: {
          auth: oauthCaller ? 'oauth' : 'none',
          ...(effectiveCallerAgent
            ? {
                caller_agent: {
                  ...(effectiveCallerAgent.agentId
                    ? { agent_id: effectiveCallerAgent.agentId }
                    : {}),
                  ...(effectiveCallerAgent.agentName
                    ? { agent_name: effectiveCallerAgent.agentName }
                    : {}),
                },
              }
            : {}),
        },
        user_info: oauthCaller?.userInfo?.email
          ? { email: oauthCaller.userInfo.email, name: displayName, source: 'idaas' }
          : null,
        ...(displayName ? { display_name: displayName } : {}),
      },
      displayName,
    }
  }),
}))

vi.mock('../../middleware/gateway-auth.js', () => ({
  normalizeAuthType: vi.fn().mockReturnValue('none'),
  validateGatewayAuth: vi.fn(),
  // 与真实实现一致的纯函数（gateway-auth 单点定义，防格式漂移）。
  oauthUploaderId: (caller: { userInfo: { issuer: string; sub: string } }) =>
    `oauth:${caller.userInfo.issuer}:${caller.userInfo.sub}`,
}))

// Attachment settings for the FilePart materialization path.
vi.mock('../../lib/settings.js', () => ({
  getAttachmentSettings: () => ({
    stagingPath: './data/attachments',
    stagingTtlHours: 24,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFilesPerRequest: 10,
    allowedExtensions: new Set(['png', 'pdf']),
  }),
}))

// Passthrough spy：记录 materializeForRun 的入参（consumerId 断言用），行为走真实实现，
// 既有 FilePart 落盘测试不受影响。
const { materializeSpy } = vi.hoisted(() => ({ materializeSpy: vi.fn() }))
vi.mock('../../lib/attachment-materializer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/attachment-materializer.js')>()
  return {
    ...actual,
    materializeForRun: (...args: Parameters<typeof actual.materializeForRun>) => {
      const override = materializeSpy(...args)
      if (override !== undefined) return override
      return actual.materializeForRun(...args)
    },
  }
})

import { db } from '../../db/client.js'
import { tryAcquireSlot } from '../../engine/task-queue.js'
import { executeWithRetry } from '../../lib/execute-with-retry.js'
import { buildGatewayChannel } from '../../lib/run-channel.js'
import { finishRunError, finishRunSuccess } from '../../lib/run-lifecycle.js'
import { createRecordedA2ACancelFn, createRecordedA2AExecuteFn } from '../run-recording.js'

import { asyncQuery } from '../../test/async-query.js'

const mockDb = db as unknown as {
  insert: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
}

/** Build a chainable db.select() stub that supports both the caller-verification
 * shape (.from().where().get() → getResult) and the A2A idempotency lookup
 * (.from().where().orderBy().limit().get() → existingRunResult.value). */
const DYNAMIC_EXISTING_RESULT = Symbol('dynamic-existing-result')
function mockSelectChain(getResult: unknown, orderedResult: unknown = DYNAMIC_EXISTING_RESULT) {
  const useDynamicExistingResult = orderedResult === DYNAMIC_EXISTING_RESULT
  // Every node is built fresh per call: an awaited asyncQuery node memoises its
  // resolved rows, so reusing one instance would serve the FIRST idempotency
  // lookup's answer to the post-conflict re-read as well.
  return {
    from: vi.fn(() =>
      asyncQuery({
        where: vi.fn(() =>
          asyncQuery({
            get: vi.fn(() => getResult),
            orderBy: vi.fn(() => ({
              limit: vi.fn(() =>
                asyncQuery({
                  get: vi.fn(() =>
                    useDynamicExistingResult ? existingRunResult.value : orderedResult,
                  ),
                }),
              ),
            })),
          }),
        ),
      }),
    ),
  }
}
const mockTryAcquireSlot = tryAcquireSlot as unknown as ReturnType<typeof vi.fn>
const mockExecuteWithRetry = executeWithRetry as unknown as ReturnType<typeof vi.fn>
const mockFinishRunSuccess = finishRunSuccess as unknown as ReturnType<typeof vi.fn>
const mockFinishRunError = finishRunError as unknown as ReturnType<typeof vi.fn>

function mockDbChain() {
  return { values: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }
}

function mockDeleteChain() {
  return { where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }
}

const fakeAgent = {
  id: 'agt_test',
  maxConcurrency: 2,
  userId: 'usr_owner',
} as any

const fakeContext = {} as any

const defaultPayload = {
  taskId: 'task_1',
  prompt: 'hello',
  workDir: '/tmp',
  agentConfig: {},
}

describe('createRecordedA2AExecuteFn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    idCounter = 0
    existingRunResult.value = undefined
    mockDb.insert.mockReturnValue(mockDbChain())
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }),
    })
    mockDb.delete.mockReturnValue(mockDeleteChain())
    // Default: registry lookup succeeds AND caller shares the same owner as the target.
    mockDb.select.mockReturnValue(mockSelectChain({ id: 'agt_caller', userId: 'usr_owner' }))
  })

  it('当 tryAcquireSlot 返回 acquired 时正常执行并记录 run', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'done', durationMs: 100 },
      retries: [],
    })

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    const result = await executeFn('task_1', defaultPayload)

    expect(result.success).toBe(true)
    expect(mockTryAcquireSlot).toHaveBeenCalledWith({}, 'agt_test', 'run_test_1', 2)
    expect(mockDb.insert).toHaveBeenCalledTimes(3)
    // The run row records the pre-resolved workspace at insert time — the
    // workspace-delete occupancy check reads runs.workDir to spot in-flight
    // runs, and A2A has no later point where a runId could be threaded in.
    const runInsertValues = mockDb.insert.mock.results[0].value.values.mock.calls[0][0]
    expect(runInsertValues.workDir).toBe('/tmp')
    expect(mockFinishRunSuccess).toHaveBeenCalledOnce()
  })

  it('当 tryAcquireSlot 返回 queue_full 时拒绝请求并清理 run', async () => {
    mockTryAcquireSlot.mockReturnValue('queue_full')

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    const result = await executeFn('task_1', defaultPayload)

    expect(result.success).toBe(false)
    expect(result.error).toContain('queue is full')
    expect(mockDb.insert).toHaveBeenCalledTimes(1)
    expect(mockDb.delete).toHaveBeenCalledTimes(1)
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('当 tryAcquireSlot 返回 queued 时拒绝请求（A2A 不支持等待）', async () => {
    mockTryAcquireSlot.mockReturnValue('queued')

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    const result = await executeFn('task_1', defaultPayload)

    expect(result.success).toBe(false)
    expect(result.error).toContain('busy')
    expect(mockDb.insert).toHaveBeenCalledTimes(1)
    expect(mockDb.delete).toHaveBeenCalledTimes(1)
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('插入 run 时状态为 pending 而非 running', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'done', durationMs: 100 },
      retries: [],
    })

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    await executeFn('task_1', defaultPayload)

    const insertResult = mockDb.insert.mock.results[0].value
    const valuesCall = insertResult.values.mock.calls[0][0]
    expect(valuesCall.status).toBe('pending')
  })

  it('执行异常时调用 finishRunError', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockRejectedValue(new Error('engine crash'))

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    const result = await executeFn('task_1', defaultPayload)

    expect(result.success).toBe(false)
    expect(mockFinishRunError).toHaveBeenCalledOnce()
  })

  it('routes materialization failures through lifecycle cleanup after acquiring a slot', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')
    materializeSpy.mockRejectedValueOnce(new Error('attachment disk failure'))

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    const result = await executeFn('task_1', defaultPayload)

    expect(result.success).toBe(false)
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(mockFinishRunError).toHaveBeenCalledOnce()
    expect(mockFinishRunError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_test_1', stepId: 'rst_test_2' }),
      expect.objectContaining({ message: 'attachment disk failure' }),
    )
  })

  it('forwards channel into payload.context so the executor can read identity', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'done', durationMs: 100 },
      retries: [],
    })

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    await executeFn('task_1', defaultPayload)

    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1] as { context?: Record<string, unknown> }
    expect(payload.context).toBeDefined()
    const channel = payload.context!.channel as {
      channel_type: string
      channel_info: { caller_agent?: { agent_id?: string } }
    }
    expect(channel.channel_type).toBe('a2a')
    expect(channel.channel_info.caller_agent?.agent_id).toBe('agt_caller')
  })

  it('records cross-instance message provenance without promoting it to user_info', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'done', durationMs: 100 },
      retries: [],
    })

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    await executeFn('task_remote', defaultPayload, {
      provenance: {
        userName: '张鑫',
        callerAgent: { id: 'agt_foreign_instance', name: 'Remote Router' },
      },
    })

    const builderCalls = (buildGatewayChannel as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(builderCalls.at(-1)?.[1]).toMatchObject({
      assertedDisplayName: '张鑫',
      assertedCallerAgent: {
        agentId: 'agt_foreign_instance',
        agentName: 'Remote Router',
      },
    })

    const runValues = mockDb.insert.mock.results[0].value.values.mock.calls[0][0]
    expect(runValues).toMatchObject({
      triggerUserName: '张鑫',
      triggerAgentName: 'Remote Router',
    })

    const payload = mockExecuteWithRetry.mock.calls[0][1] as {
      context: {
        channel: {
          user_info: unknown
          display_name?: string
          channel_info: { caller_agent?: { agent_id?: string; agent_name?: string } }
        }
      }
    }
    expect(payload.context.channel).toMatchObject({
      user_info: null,
      display_name: '张鑫',
      channel_info: {
        caller_agent: { agent_id: 'agt_foreign_instance', agent_name: 'Remote Router' },
      },
    })
  })

  it('combines the authenticated OAuth user with extension-asserted caller Agent provenance', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'done', durationMs: 100 },
      retries: [],
    })
    const oauthContext = {
      get: (key: string) =>
        key === 'oauthCaller'
          ? {
              kind: 'idaas_user',
              userInfo: {
                issuer: 'https://idaas.example',
                sub: 'sub-42',
                username: 'Authenticated Alice',
                email: 'alice@example.com',
              },
            }
          : undefined,
    } as unknown as Parameters<typeof createRecordedA2AExecuteFn>[0]

    const executeFn = await createRecordedA2AExecuteFn(oauthContext, fakeAgent)
    await executeFn('task_oauth_provenance', defaultPayload, {
      provenance: {
        userName: 'Untrusted Alice',
        callerAgent: { id: 'agt_foreign_instance', name: 'Remote Router' },
      },
    })

    const builderCalls = (buildGatewayChannel as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(builderCalls.at(-1)?.[1]).toMatchObject({
      assertedCallerAgent: {
        agentId: 'agt_foreign_instance',
        agentName: 'Remote Router',
      },
    })
    expect(builderCalls.at(-1)?.[1]).not.toHaveProperty('assertedDisplayName')

    const runValues = mockDb.insert.mock.results[0].value.values.mock.calls[0][0]
    expect(runValues).toMatchObject({
      triggerUserName: 'Authenticated Alice',
      triggerAgentName: 'Remote Router',
    })
  })

  it('preserves any pre-existing payload.context fields when merging channel', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'done', durationMs: 100 },
      retries: [],
    })

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    await executeFn('task_1', { ...defaultPayload, context: { existing: 'value' } } as never)

    const payload = mockExecuteWithRetry.mock.calls[0][1] as { context: Record<string, unknown> }
    expect(payload.context.existing).toBe('value')
    expect(payload.context.channel).toBeDefined()
  })

  it('A2A 幂等：同 taskId 已 completed 时直接返回缓存 output，不再创建 run', async () => {
    existingRunResult.value = {
      id: 'run_old',
      status: 'completed',
      result: { output: 'cached answer' },
    }

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    const result = await executeFn('task_1', defaultPayload)

    expect(result.success).toBe(true)
    expect(result.output).toBe('cached answer')
    // No INSERT / slot acquisition / execution on cache hit
    expect(mockDb.insert).not.toHaveBeenCalled()
    expect(mockTryAcquireSlot).not.toHaveBeenCalled()
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('A2A 幂等：同 taskId 正在 running 时返回 inProgress 非终态信号，不重复执行', async () => {
    existingRunResult.value = { id: 'run_busy', status: 'running', result: null }

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    const result = await executeFn('task_1', defaultPayload)

    expect(result.success).toBe(false)
    // inProgress flag tells the A2A executor NOT to publish a terminal failed
    // event — the still-running original run will emit the final state itself.
    expect(result.inProgress).toBe(true)
    expect(result.error).toContain('in progress')
    expect(mockDb.insert).not.toHaveBeenCalled()
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('A2A 幂等：并发插入撞唯一索引时回读已有 run', async () => {
    // The INSERT is awaited at `values()`, so that is where the unique-index
    // violation surfaces.
    mockDb.insert.mockReturnValueOnce({
      values: vi.fn(() => {
        existingRunResult.value = { id: 'run_raced', status: 'running', result: null }
        throw new Error(
          'UNIQUE constraint failed: runs.initiator_agent_id, runs.trigger_source, runs.trigger_session_id',
        )
      }),
    })

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    const result = await executeFn('task_1', defaultPayload)

    expect(result.success).toBe(false)
    expect(result.inProgress).toBe(true)
    expect(mockTryAcquireSlot).not.toHaveBeenCalled()
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('A2A 幂等：同 taskId 已 failed 时允许重新执行（可安全重试语义）', async () => {
    existingRunResult.value = { id: 'run_failed', status: 'failed', result: { error: 'oops' } }
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'retried ok', durationMs: 10 },
      retries: [],
    })

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    const result = await executeFn('task_1', defaultPayload)

    expect(result.success).toBe(true)
    expect(mockDb.insert).toHaveBeenCalled()
    expect(mockTryAcquireSlot).toHaveBeenCalled()
  })

  it('INSERT runs 时带上 triggerSessionId = taskId', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'done', durationMs: 1 },
      retries: [],
    })

    const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
    await executeFn('task_abc', defaultPayload)

    const insertResult = mockDb.insert.mock.results[0].value
    const valuesCall = insertResult.values.mock.calls[0][0]
    expect(valuesCall.triggerSessionId).toBe('task_abc')
    expect(valuesCall.triggerSource).toBe('a2a')
  })

  it('使用 agent 的 maxConcurrency 默认值 1 当未设置时', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'done', durationMs: 100 },
      retries: [],
    })

    const agentNoMax = { ...fakeAgent, maxConcurrency: undefined } as any
    const executeFn = await createRecordedA2AExecuteFn(fakeContext, agentNoMax)
    await executeFn('task_1', defaultPayload)

    expect(mockTryAcquireSlot).toHaveBeenCalledWith({}, 'agt_test', expect.any(String), 1)
  })

  describe('caller_agent registry verification', () => {
    it('passes callerAgent through when agent_id exists in registry', async () => {
      mockTryAcquireSlot.mockReturnValue('acquired')
      // default mockDb.select returns { id: 'agt_caller' } — it exists
      await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
      const call = (buildGatewayChannel as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      const opts = call[1] as { callerAgent?: { agentId?: string } }
      expect(opts.callerAgent?.agentId).toBe('agt_caller')
    })

    it('drops callerAgent when claimed agent_id is not in registry', async () => {
      mockTryAcquireSlot.mockReturnValue('acquired')
      // Override select to return undefined — claimed agent does not exist
      mockDb.select.mockReturnValue(mockSelectChain(undefined))

      await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
      const call = (buildGatewayChannel as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      const opts = call[1] as { callerAgent?: unknown }
      expect(opts.callerAgent).toBeUndefined()
    })

    it('drops callerAgent when claimed agent belongs to a different owner', async () => {
      mockTryAcquireSlot.mockReturnValue('acquired')
      // Caller exists but in a DIFFERENT owner's workspace than the target.
      mockDb.select.mockReturnValue(
        mockSelectChain({ id: 'agt_caller', userId: 'usr_other_owner' }),
      )

      await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
      const call = (buildGatewayChannel as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      const opts = call[1] as { callerAgent?: unknown }
      expect(opts.callerAgent).toBeUndefined()
    })
  })

  describe('FilePart 附件', () => {
    it('inline bytes 附件被 materialize 并注入 prompt 路径提示', async () => {
      mockTryAcquireSlot.mockReturnValue('acquired')
      mockExecuteWithRetry.mockResolvedValue({
        result: { success: true, output: 'ok', durationMs: 1 },
        retries: [],
      })

      const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
      await executeFn('task_att', {
        ...defaultPayload,
        attachments: [
          {
            kind: 'bytes',
            bytes: Buffer.from('img').toString('base64'),
            name: 'p.png',
            mimeType: 'image/png',
          },
        ],
      })

      // executeWithRetry sees the merged prompt (hint injected), not the raw text.
      const [, enrichedPayload] = mockExecuteWithRetry.mock.calls[0]
      expect((enrichedPayload as { prompt: string }).prompt).toContain('图片路径：')
      expect(
        (enrichedPayload as { prompt: string }).prompt.startsWith('hello\n\n---\n[图片]'),
      ).toBe(true)
    })

    it('OAuth 鉴权的 A2A：materialize consumerId 用 oauth:<issuer>:<sub>（review [P1]）', async () => {
      // OAuth 用户经 /api/oauth/:agentId/attachments 上传的 token，uploaderId=oauth:<iss>:<sub>；
      // A2A 消费端若硬编码 agent:<id>，消费鉴权必然拒绝——OAuth-A2A 的 token 附件全部静默丢失。
      mockTryAcquireSlot.mockReturnValue('acquired')
      mockExecuteWithRetry.mockResolvedValue({
        result: { success: true, output: 'ok', durationMs: 1 },
        retries: [],
      })
      const oauthContext = {
        get: (k: string) =>
          k === 'oauthCaller'
            ? { kind: 'idaas_user', userInfo: { issuer: 'https://idaas.example', sub: 'sub-42' } }
            : undefined,
      } as unknown as Parameters<typeof createRecordedA2AExecuteFn>[0]

      const executeFn = await createRecordedA2AExecuteFn(oauthContext, fakeAgent)
      await executeFn('task_oauth_att', {
        ...defaultPayload,
        attachments: [{ kind: 'token', token: 'att_x', name: 'p.png', mimeType: 'image/png' }],
      })

      expect(materializeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ consumerId: 'oauth:https://idaas.example:sub-42' }),
      )
    })

    it('api_key/none 鉴权的 A2A：materialize consumerId 保持 agent:<id>', async () => {
      // 无 oauthCaller（api_key/none，含多跳转发场景——upstream oauth 元数据只进审计链，
      // 当前 hop 附件经 gateway 上传端点 uploaderId=agent:<id>）。
      mockTryAcquireSlot.mockReturnValue('acquired')
      mockExecuteWithRetry.mockResolvedValue({
        result: { success: true, output: 'ok', durationMs: 1 },
        retries: [],
      })

      const executeFn = await createRecordedA2AExecuteFn(fakeContext, fakeAgent)
      await executeFn('task_apikey_att', {
        ...defaultPayload,
        attachments: [{ kind: 'token', token: 'att_y', name: 'p.png', mimeType: 'image/png' }],
      })

      expect(materializeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ consumerId: 'agent:agt_test' }),
      )
    })
  })
})

describe('createRecordedA2ACancelFn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    existingRunResult.value = { id: 'run_cancel', status: 'running', result: null }
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }),
    })
    claimRunCancellationMock.mockReturnValue(true)
  })

  it('cancels the recorded run and its active CLI task before returning success', async () => {
    mockDb.select
      .mockReturnValueOnce(mockSelectChain(undefined))
      .mockReturnValueOnce(mockSelectChain({ status: 'running' }))
      .mockReturnValueOnce(mockSelectChain(undefined, { id: 'rst_cancel', order: 1 }))

    const cancelFn = createRecordedA2ACancelFn(fakeContext, fakeAgent)

    await expect(cancelFn('task_cancel')).resolves.toBe('cancelled')
    expect(stopLogCollectorMock).toHaveBeenCalledWith('run_cancel')
    expect(claimRunCancellationMock).toHaveBeenCalledWith('run_cancel', 'running')
    expect(cancelRunningTasksMock).toHaveBeenCalledWith({
      runId: 'run_cancel',
      agentId: 'agt_test',
      taskIds: [
        'task_cancel',
        'run_cancel/rst_cancel',
        'chat/run_cancel/rst_cancel',
        'feishu/run_cancel/rst_cancel',
        'invoke/run_cancel/rst_cancel',
      ],
    })
    expect(logAuditMock).toHaveBeenCalledWith(
      fakeContext,
      expect.objectContaining({
        action: 'run.cancel',
        resourceId: 'run_cancel',
        userId: 'usr_owner',
      }),
    )
  })

  it('does not publish a false cancellation when the run loses the terminal-state race', async () => {
    claimRunCancellationMock.mockReturnValue(false)
    mockDb.select
      .mockReturnValueOnce(mockSelectChain(undefined))
      .mockReturnValueOnce(mockSelectChain({ status: 'running' }))

    const cancelFn = createRecordedA2ACancelFn(fakeContext, fakeAgent)

    await expect(cancelFn('task_cancel')).resolves.toBe('not_cancellable')
    expect(cancelRunningTasksMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})
