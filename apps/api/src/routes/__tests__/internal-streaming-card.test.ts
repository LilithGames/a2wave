import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeCallerAgentNameHeader } from '../../a2a/caller.js'

const mockAddChildSection = vi.fn().mockResolvedValue(undefined)
const mockUpdateChildContent = vi.fn()
const mockGetStreamingCard = vi.hoisted(() => vi.fn())
const mockShouldShowRemoteChildOutput = vi.hoisted(() => vi.fn().mockReturnValue(true))
const mockTouchStreamingCard = vi.hoisted(() => vi.fn())
const mockDbGet = vi.hoisted(() => vi.fn())
const mockDbAll = vi.hoisted(() => vi.fn().mockReturnValue([]))
const mockInsertRun = vi.hoisted(() => vi.fn())
const mockInsertStep = vi.hoisted(() => vi.fn())
const mockInsertMessage = vi.hoisted(() => vi.fn())
const mockHandleA2ARequest = vi.hoisted(() => vi.fn())
const mockExecuteWithRetry = vi.hoisted(() => vi.fn())
const mockFinishRunSuccess = vi.hoisted(() => vi.fn())
const mockFinishRunError = vi.hoisted(() =>
  vi.fn(() => 'Execution failed. Check server logs for details.'),
)
const mockCreateId = vi.hoisted(() => vi.fn((prefix: string) => `${prefix}_test`))
const mockTables = vi.hoisted(() => ({ agents: {}, runs: {}, runSteps: {}, chatMessages: {} }))

vi.mock('../../lib/streaming-card-registry.js', () => ({
  getStreamingCard: mockGetStreamingCard,
  shouldShowRemoteChildOutput: mockShouldShowRemoteChildOutput,
  touchStreamingCard: mockTouchStreamingCard,
}))

// Mock all other imports that internal.ts needs
vi.mock('drizzle-orm', () => ({
  eq: vi.fn().mockReturnValue({}),
  and: vi.fn().mockReturnValue({}),
  desc: vi.fn().mockReturnValue({}),
}))
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () =>
        asyncQuery({
          all: mockDbAll,
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
vi.mock('../../lib/run-lifecycle.js', () => ({
  finishRunSuccess: mockFinishRunSuccess,
  finishRunError: mockFinishRunError,
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../lib/id.js', () => ({ createId: mockCreateId }))
vi.mock('../../a2a/sqlite-task-store.js', () => ({
  SqliteTaskStore: class {
    async cleanup() {}
  },
}))
vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: vi.fn().mockReturnValue('acquired'),
}))
vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

import { getInternalToken, INTERNAL_TOKEN_HEADER } from '../../lib/internal-admin-auth.js'
import { asyncQuery } from '../../test/async-query.js'
import app from '../internal.js'

function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    // Loopback alone no longer authenticates: every in-process caller carries the
    // process-scoped internal token.
    headers: { 'Content-Type': 'application/json', [INTERNAL_TOKEN_HEADER]: getInternalToken() },
  }
  if (body) init.body = JSON.stringify(body)
  // Pass the (fail-closed) localhost guard: supply a loopback remoteAddress the
  // way the node-server adapter does for the platform-admin MCP's 127.0.0.1 call.
  return app.request(path, init, {
    incoming: { socket: { remoteAddress: '127.0.0.1' } },
  })
}

describe('internal streaming card endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetStreamingCard.mockReturnValue(undefined)
    mockShouldShowRemoteChildOutput.mockReturnValue(true)
    mockDbGet.mockReturnValue({
      id: 'agt_test',
      name: 'Internal Target',
      userId: 'usr_owner',
      publishStatus: 'published',
      publishChannels: ['a2a'],
    })
    mockHandleA2ARequest.mockImplementation(async (c, _agent, _taskStore, executeFn) => {
      const result = await executeFn(
        'task_test',
        { taskId: 'task_test', prompt: 'hello', workDir: '/tmp', agentConfig: {} },
        {},
      )
      return c.json(result)
    })
  })

  describe('POST /streaming-card/:cardId/child', () => {
    it('returns 404 when card not in registry', async () => {
      const res = await request('POST', '/streaming-card/card_999/child', { childId: 'c1' })
      expect(res.status).toBe(404)
    })

    it('creates child section when card exists', async () => {
      const fakeCard = { addChildSection: mockAddChildSection }
      mockGetStreamingCard.mockReturnValue(fakeCard)

      const res = await request('POST', '/streaming-card/card_1/child', {
        childId: 'c1',
        label: 'Test',
      })
      expect(res.status).toBe(200)
      expect(mockTouchStreamingCard).toHaveBeenCalledWith('card_1')
      expect(mockAddChildSection).toHaveBeenCalledWith('c1', 'Test')
    })

    it('returns 400 when childId missing', async () => {
      mockGetStreamingCard.mockReturnValue({ addChildSection: mockAddChildSection })

      const res = await request('POST', '/streaming-card/card_1/child', {})
      expect(res.status).toBe(400)
    })

    it('skips when showRemoteChildOutput is false', async () => {
      mockGetStreamingCard.mockReturnValue({ addChildSection: mockAddChildSection })
      mockShouldShowRemoteChildOutput.mockReturnValue(false)

      const res = await request('POST', '/streaming-card/card_1/child', { childId: 'c1' })
      const body = (await res.json()) as any
      expect(res.status).toBe(200)
      expect(body.skipped).toBe(true)
      expect(mockAddChildSection).not.toHaveBeenCalled()
    })
  })

  describe('PUT /streaming-card/:cardId/child/:childId', () => {
    it('returns 404 when card not in registry', async () => {
      const res = await request('PUT', '/streaming-card/card_999/child/c1', { content: 'hello' })
      expect(res.status).toBe(404)
    })

    it('updates child content when card exists', async () => {
      const fakeCard = { updateChildContent: mockUpdateChildContent }
      mockGetStreamingCard.mockReturnValue(fakeCard)

      const res = await request('PUT', '/streaming-card/card_1/child/c1', {
        content: 'hello world',
      })
      expect(res.status).toBe(200)
      expect(mockTouchStreamingCard).toHaveBeenCalledWith('card_1')
      expect(mockUpdateChildContent).toHaveBeenCalledWith('c1', 'hello world')
    })

    it('skips when showRemoteChildOutput is false', async () => {
      mockGetStreamingCard.mockReturnValue({ updateChildContent: mockUpdateChildContent })
      mockShouldShowRemoteChildOutput.mockReturnValue(false)

      const res = await request('PUT', '/streaming-card/card_1/child/c1', { content: 'hello' })
      const body = (await res.json()) as any
      expect(res.status).toBe(200)
      expect(body.skipped).toBe(true)
      expect(mockUpdateChildContent).not.toHaveBeenCalled()
    })
  })

  describe('POST /a2a/:agentId', () => {
    it('records user ownership and caller info for internal invocations', async () => {
      mockExecuteWithRetry.mockResolvedValueOnce({
        result: { success: true, output: 'ok', durationMs: 12 },
        retries: [],
      })

      const res = await app.request(
        '/a2a/agt_test',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [INTERNAL_TOKEN_HEADER]: getInternalToken(),
            'X-A2WAVE-Caller-Agent-Id': 'agt_gateway',
            'X-A2WAVE-Caller-Agent-Name-B64': encodeCallerAgentNameHeader('网关测试Agent'),
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'message/send' }),
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      )
      const body = (await res.json()) as any

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(mockInsertRun).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'run_test',
          intent: 'hello',
          initiatorAgentId: 'agt_test',
          triggerSource: 'a2a',
          userId: 'usr_owner',
        }),
      )
      expect(mockInsertStep).toHaveBeenCalledWith(
        expect.objectContaining({
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
    })

    it('calls finishRunError when executeWithRetry throws', async () => {
      mockExecuteWithRetry.mockRejectedValueOnce(new Error('worker boom'))

      const res = await request('POST', '/a2a/agt_test', { jsonrpc: '2.0', method: 'message/send' })
      const body = (await res.json()) as any

      expect(res.status).toBe(200)
      expect(body.success).toBe(false)
      expect(body.error).toBe('Execution failed. Check server logs for details.')
      expect(mockFinishRunError).toHaveBeenCalledTimes(1)
      expect(mockFinishRunSuccess).not.toHaveBeenCalled()
    })
  })
})
