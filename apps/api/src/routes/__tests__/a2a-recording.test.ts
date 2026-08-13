import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeCallerAgentNameHeader } from '../../a2a/caller.js'

const mockTables = vi.hoisted(() => ({
  agents: {},
  runs: {},
  runSteps: {},
  chatMessages: {},
}))
const mockDbGet = vi.hoisted(() => vi.fn())
const mockInsertRun = vi.hoisted(() => vi.fn())
const mockInsertStep = vi.hoisted(() => vi.fn())
const mockInsertMessage = vi.hoisted(() => vi.fn())
const mockHandleA2ARequest = vi.hoisted(() => vi.fn())
const mockExecuteWithRetry = vi.hoisted(() => vi.fn())
const mockFinishRunSuccess = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockFinishRunError = vi.hoisted(() =>
  vi.fn(() => 'Execution failed. Check server logs for details.'),
)
const mockResolveWorkDir = vi.hoisted(() => vi.fn().mockResolvedValue('/fresh/scm/checkout'))
const mockTryAcquireSlot = vi.hoisted(() => vi.fn().mockReturnValue('acquired'))
const mockCreateId = vi.hoisted(() => vi.fn((prefix: string) => `${prefix}_test`))
const mockValidateGatewayAuth = vi.hoisted(() => vi.fn())

vi.mock('drizzle-orm', () => ({
  eq: vi.fn().mockReturnValue({}),
  and: vi.fn().mockReturnValue({}),
  desc: vi.fn().mockReturnValue({}),
}))
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          asyncQuery({
            get: mockDbGet,
            orderBy: () => ({
              limit: () => asyncQuery({ get: () => undefined }),
            }),
          }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (payload: unknown) => {
        if (table === mockTables.runs) mockInsertRun(payload)
        if (table === mockTables.runSteps) mockInsertStep(payload)
        if (table === mockTables.chatMessages) mockInsertMessage(payload)
        return { run: vi.fn() }
      },
    }),
    delete: () => ({
      where: () => asyncQuery({ run: vi.fn() }),
    }),
  },
}))
vi.mock('../../db/schema.js', () => mockTables)
vi.mock('../../a2a/agent-card.js', () => ({
  buildAgentCard: vi.fn(),
  serializeAgentCard: (card: unknown) => card,
}))
vi.mock('../../a2a/handle-request.js', () => ({ handleA2ARequest: mockHandleA2ARequest }))
vi.mock('../../lib/execute-with-retry.js', () => ({ executeWithRetry: mockExecuteWithRetry }))
vi.mock('../../lib/agent-helpers.js', () => ({ resolveWorkDir: mockResolveWorkDir }))
vi.mock('../../lib/run-lifecycle.js', () => ({
  finishRunSuccess: mockFinishRunSuccess,
  finishRunError: mockFinishRunError,
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../lib/id.js', () => ({ createId: mockCreateId }))
vi.mock('../../middleware/gateway-auth.js', () => ({
  validateGatewayAuth: mockValidateGatewayAuth,
  normalizeAuthType: (v: string | null | undefined) =>
    v === 'none' || v === 'oauth' ? v : 'api_key',
}))
vi.mock('../../a2a/sqlite-task-store.js', () => ({
  SqliteTaskStore: class {
    async cleanup() {}
  },
}))
vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: mockTryAcquireSlot,
}))
vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

import app from '../a2a.js'

import { asyncQuery } from '../../test/async-query.js'

describe('public A2A run recording', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveWorkDir.mockReset().mockResolvedValue('/fresh/scm/checkout')
    mockTryAcquireSlot.mockReset().mockReturnValue('acquired')
    mockValidateGatewayAuth.mockResolvedValue({})
    mockDbGet.mockReturnValue({
      id: 'agt_test',
      name: 'Target Agent',
      userId: 'usr_owner',
      publishStatus: 'published',
      publishChannels: ['a2a'],
      publishAuthType: 'none',
      publishIpWhitelist: [],
      endpointApiKey: null,
    })
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'done', durationMs: 10 },
      retries: [],
    })
    mockHandleA2ARequest.mockImplementation(async (c, _agent, _taskStore, executeFn) => {
      const result = await executeFn(
        'task_test',
        { taskId: 'task_test', prompt: 'hello', workDir: '/tmp/worker', agentConfig: {} },
        {},
      )
      return c.json(result)
    })
  })

  it('creates a visible run record with caller agent info', async () => {
    const res = await app.request('/agt_test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2WAVE-Caller-Agent-Id': 'agt_gateway',
        'X-A2WAVE-Caller-Agent-Name-B64': encodeCallerAgentNameHeader('网关测试Agent'),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'message/stream', id: '1' }),
    })

    expect(res.status).toBe(200)
    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'run_test',
        intent: 'hello',
        initiatorAgentId: 'agt_test',
        status: 'pending',
        triggerSource: 'a2a',
        userId: 'usr_owner',
      }),
    )
    expect(mockInsertStep).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'rst_test',
        runId: 'run_test',
        agentId: 'agt_test',
        status: 'running',
        input: expect.objectContaining({
          message: 'hello',
          context: expect.objectContaining({
            channel: expect.objectContaining({
              channel_type: 'a2a',
              channel_info: expect.objectContaining({
                caller_agent: {
                  agent_id: 'agt_gateway',
                  agent_name: '网关测试Agent',
                },
              }),
            }),
          }),
        }),
      }),
    )
    expect(mockInsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg_test',
        runId: 'run_test',
        role: 'user',
        content: 'hello',
      }),
    )
    expect(mockFinishRunSuccess).toHaveBeenCalledTimes(1)
    expect(mockResolveWorkDir).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agt_test' }),
      undefined,
      'run_test',
    )
    expect(mockResolveWorkDir.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockTryAcquireSlot.mock.invocationCallOrder[0],
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      'task_test',
      expect.objectContaining({ workDir: '/fresh/scm/checkout' }),
      expect.objectContaining({ runId: 'run_test' }),
    )
  })

  it('uses the TCP peer for A2A IP authorization when X-Forwarded-For is untrusted', async () => {
    const res = await app.request(
      '/agt_test',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.99',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'message/stream', id: '2' }),
      },
      { incoming: { socket: { remoteAddress: '198.51.100.42' } } },
    )

    expect(res.status).toBe(200)
    expect(mockValidateGatewayAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientIp: '198.51.100.42' }),
    )
  })

  it('fails the admitted run when the current workspace cannot be resolved', async () => {
    mockResolveWorkDir.mockRejectedValueOnce(new Error('workspace changed'))

    const res = await app.request('/agt_test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'message/stream', id: 'workspace-error' }),
    })

    expect(res.status).toBe(200)
    expect(mockFinishRunError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_test', workDir: '' }),
      expect.objectContaining({ message: 'workspace changed' }),
    )
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('rate-limits A2A requests at the same 60 per minute boundary as other gateways', async () => {
    const remote = { incoming: { socket: { remoteAddress: '198.51.100.250' } } }
    let lastResponse: Response | undefined
    for (let i = 0; i < 61; i++) {
      lastResponse = await app.request(
        '/missing-agent',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        remote,
      )
    }

    expect(lastResponse?.status).toBe(429)
    expect(lastResponse?.headers.get('X-RateLimit-Limit')).toBe('60')
  })
})
