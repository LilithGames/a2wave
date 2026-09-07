import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise delivery, persisted callback state, and the real card action handler together.

const mockImMessageReply = vi.hoisted(() => vi.fn())
const mockImMessageCreate = vi.hoisted(() => vi.fn())
const mockImMessageGet = vi.hoisted(() => vi.fn())
const mockImMessageReactionCreate = vi.hoisted(() => vi.fn())
const mockImMessageResourceGet = vi.hoisted(() => vi.fn())
const mockImFileCreate = vi.hoisted(() => vi.fn())
const mockClientRequest = vi.hoisted(() => vi.fn())
const capturedDispatchers = vi.hoisted(() => ({}) as Record<string, (data: unknown) => unknown>)

const mockDbGet = vi.hoisted(() => vi.fn())
const mockExecuteWithRetry = vi.hoisted(() => vi.fn())
const mockBuildAgentConfig = vi.hoisted(() => vi.fn())
const mockResolveWorkDir = vi.hoisted(() => vi.fn())
const mockTryAcquireSlot = vi.hoisted(() => vi.fn())
const mockLoggerWarn = vi.hoisted(() => vi.fn())
const mockStreamingCardUpdateContent = vi.hoisted(() => vi.fn())
const mockStreamingCardFinish = vi.hoisted(() => vi.fn())

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeEventDispatcher {
    _handlers: Record<string, (data: unknown) => unknown> = {}
    register(handlers: Record<string, (data: unknown) => unknown>) {
      Object.assign(this._handlers, handlers)
      return this
    }
  }
  class FakeWSClient {
    wsConfig = { getWSInstance: () => ({ readyState: 1 }) }
    start(params: { eventDispatcher?: { _handlers?: Record<string, (d: unknown) => unknown> } }) {
      const handlers = params.eventDispatcher?._handlers ?? {}
      for (const key of Object.keys(handlers)) capturedDispatchers[key] = handlers[key]
      return undefined
    }
    close() {
      return undefined
    }
  }
  class FakeClient {
    request = (...args: unknown[]) => mockClientRequest(...args)
    im = {
      message: {
        reply: mockImMessageReply,
        create: mockImMessageCreate,
        get: mockImMessageGet,
      },
      messageReaction: { create: mockImMessageReactionCreate },
      messageResource: { get: mockImMessageResourceGet },
      file: { create: mockImFileCreate },
    }
  }
  return {
    WSClient: FakeWSClient,
    EventDispatcher: FakeEventDispatcher,
    Client: FakeClient,
    LoggerLevel: { error: 'error', info: 'info' },
  }
})

type PersistedCallback = {
  id: string
  agentId: string
  spec: string
  debugSuffix: string | null
  status: string
  triggerOpenId: string | null
  expiresAt: Date
  messageId?: string
}

const mockCardTable = vi.hoisted(() => ({ id: {}, status: {}, expiresAt: {} }))
const callbackStore = vi.hoisted(() => ({ row: undefined as PersistedCallback | undefined }))

vi.mock('../../db/client.js', () => {
  const chain = {
    select: () => ({
      from: (table: unknown) =>
        asyncQuery({ get: () => (table === mockCardTable ? callbackStore.row : mockDbGet()) }),
    }),
    insert: (table: unknown) => ({
      values: (row: PersistedCallback) =>
        asyncQuery({
          run: () => {
            if (table === mockCardTable) callbackStore.row = { ...row }
          },
        }),
    }),
    update: (table: unknown) => ({
      set: (values: Partial<PersistedCallback>) =>
        asyncQuery({
          run: () => {
            if (table === mockCardTable && callbackStore.row) {
              Object.assign(callbackStore.row, values)
            }
            return { changes: 1 }
          },
        }),
    }),
    delete: () => ({ where: () => asyncQuery({ run: vi.fn() }) }),
  }
  return { db: { ...chain, transaction: (fn: (tx: typeof chain) => unknown) => fn(chain) } }
})

vi.mock('../../db/schema.js', () => ({
  agents: { id: {}, publishStatus: {} },
  runs: {},
  runSteps: {},
  chatMessages: {},
  artifacts: {},
  feishuCardCallbacks: mockCardTable,
  feishuPendingMessages: { messageId: {}, agentId: {}, runId: {}, payload: {}, createdAt: {} },
}))

vi.mock('../feishu-pending-store.js', () => ({
  persistPendingMessage: vi.fn(),
  removePendingMessage: vi.fn(),
  listPendingMessages: vi.fn().mockReturnValue([]),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn().mockReturnValue({}),
  and: vi.fn().mockReturnValue({}),
  or: vi.fn().mockReturnValue({}),
  lt: vi.fn().mockReturnValue({}),
  desc: vi.fn().mockReturnValue({}),
  isNull: vi.fn().mockReturnValue({}),
  sql: vi.fn().mockReturnValue({}),
}))

vi.mock('../id.js', () => ({ createId: (prefix: string) => `${prefix}_test` }))

vi.mock('../logger.js', () => ({
  logger: { warn: mockLoggerWarn, error: vi.fn(), info: vi.fn() },
}))

vi.mock('../agent-helpers.js', () => ({
  buildAgentConfig: mockBuildAgentConfig,
  resolveWorkDir: mockResolveWorkDir,
  resolveEngineType: vi.fn(() => 'cursor'),
}))

vi.mock('../run-lifecycle.js', () => ({
  finishRunSuccess: vi.fn().mockResolvedValue([]),
  finishRunError: vi.fn(),
  finishRunAborted: vi.fn(),
  cleanupWorktreeIfEphemeral: vi.fn().mockResolvedValue(undefined),
  createLogCollector: vi.fn(() => ({ logs: [], onLogEntry: vi.fn() })),
  createPersistingLogCollector: vi.fn(() => ({
    logs: [],
    onLogEntry: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
  sanitizeLogsForStorage: vi.fn((logs: unknown[]) => logs),
}))

vi.mock('../run-log-registry.js', () => ({
  registerLogCollector: vi.fn(),
  unregisterLogCollector: vi.fn(),
  stopLogCollector: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../worker/index.js', () => ({ executeInWorker: vi.fn() }))
vi.mock('../execute-with-retry.js', () => ({ executeWithRetry: mockExecuteWithRetry }))
vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: mockTryAcquireSlot,
  scheduleNext: vi.fn(),
}))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))

vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(Buffer.from('file-content')),
  statSync: vi.fn().mockReturnValue({ size: 1024 }),
}))

vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }))
vi.mock('node:crypto', () => ({ randomUUID: () => 'test-uuid' }))

vi.mock('../server-url.js', () => ({
  getArtifactDownloadUrl: vi.fn((id: string) => `http://localhost:3502/api/artifacts/${id}`),
  getShareUrl: vi.fn((id: string) => `http://localhost:3502/s/${id}`),
}))

vi.mock('../artifact-links.js', () => ({ buildFeishuArtifactSection: vi.fn(() => null) }))

vi.mock('../feishu-card-streaming.js', () => ({
  FeishuStreamingCard: {
    create: vi.fn().mockResolvedValue({
      send: vi.fn(),
      updateContent: mockStreamingCardUpdateContent,
      finish: mockStreamingCardFinish,
      getMessageId: vi.fn().mockReturnValue('om_card_test'),
      getCardId: vi.fn().mockReturnValue('card_test_id'),
    }),
  },
}))

vi.mock('../streaming-card-registry.js', () => ({
  registerStreamingCard: vi.fn(),
  touchStreamingCard: vi.fn(),
  unregisterStreamingCard: vi.fn(),
}))

import { asyncQuery } from '../../test/async-query.js'
import { type FeishuConfig, feishuConnectionManager } from '../feishu-service.js'

const AGENT_ID = 'agt_interactive'
const TRIGGER_OPEN_ID = 'ou_card_owner'
const LEADING_TEXT = 'The migration changes three services. Review the rollout below.'
const CARD_BODY = 'Should I proceed with the migration?'
const TRAILING_TEXT = '[Download the plan](https://example.test/plan.md)'
const SURROUNDING_TEXT = `${LEADING_TEXT}\n\n\n\n${TRAILING_TEXT}`
let messageSeq = 0

type Card = { body: { elements: Array<{ tag: string; content?: string }> } }
type CardActionResponse = { toast: { type: string }; card: { data: Card } }

function replyCalls() {
  return [...mockImMessageReply.mock.calls, ...mockImMessageCreate.mock.calls]
}

async function startAndDispatch(replyMode: 'quote' | 'new', body?: string) {
  const config: FeishuConfig = {
    appId: 'cli_card_test',
    appSecret: 'secret_test',
    p2pReplyMode: replyMode,
    replyContentType: 'interactive_card',
    debugShowSessionId: true,
  }
  const spec = { body, components: [{ type: 'confirm_cancel' }] }
  mockExecuteWithRetry.mockResolvedValue({
    result: {
      success: true,
      chatId: 'chat_card_session',
      output: `${LEADING_TEXT}\n\n\`\`\`a2wave-card\n${JSON.stringify(spec)}\n\`\`\`\n\n${TRAILING_TEXT}`,
    },
    retries: [],
  })
  await feishuConnectionManager.start(AGENT_ID, config)
  mockDbGet.mockReturnValue({
    id: AGENT_ID,
    name: 'Test Agent',
    publishStatus: 'published',
    maxConcurrency: 1,
    feishuConfig: config,
  })
  messageSeq += 1
  const messageId = `om_card_question_${messageSeq}`
  capturedDispatchers['im.message.receive_v1']({
    message: {
      message_type: 'text',
      message_id: messageId,
      chat_id: 'oc_card_chat',
      chat_type: 'p2p',
      content: JSON.stringify({ text: 'Review this migration' }),
      mentions: [],
    },
    sender: { sender_type: 'user', sender_id: { open_id: TRIGGER_OPEN_ID } },
  })
  // Message dispatch is deliberately fire-and-forget; wait for its delivery path.
  for (let tick = 0; tick < 50 && replyCalls().length === 0; tick++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(replyCalls()).toHaveLength(1)
  await new Promise<void>((resolve) => setImmediate(resolve))
  return messageId
}

describe('Feishu interactive card output delivery', () => {
  beforeEach(() => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    callbackStore.row = undefined
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockImMessageReply.mockResolvedValue({ data: { message_id: 'om_sent_card' } })
    mockImMessageCreate.mockResolvedValue({ data: { message_id: 'om_sent_card' } })
    mockImMessageReactionCreate.mockResolvedValue({})
    mockBuildAgentConfig.mockReturnValue({
      engineType: 'cursor',
      model: 'test-model',
      maxRetries: 0,
    })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    mockTryAcquireSlot.mockReturnValue('acquired')
  })

  afterEach(() => feishuConnectionManager.stopAll())

  it.each([
    { replyMode: 'quote' as const, body: CARD_BODY },
    { replyMode: 'new' as const, body: CARD_BODY },
    { replyMode: 'quote' as const, body: undefined },
    { replyMode: 'new' as const, body: '' },
    { replyMode: 'quote' as const, body: '   ' },
  ])(
    'preserves output through $replyMode delivery and cancel with body=$body',
    async ({ replyMode, body }) => {
      const messageId = await startAndDispatch(replyMode, body)
      const call = replyCalls()[0][0]
      expect(call.data.msg_type).toBe('interactive')
      if (replyMode === 'quote') {
        expect(mockImMessageReply).toHaveBeenCalledOnce()
        expect(call.path.message_id).toBe(messageId)
      } else {
        expect(mockImMessageCreate).toHaveBeenCalledOnce()
        expect(call.data.receive_id).toBe('oc_card_chat')
      }
      const expectedBody = body?.trim() ? `${SURROUNDING_TEXT}\n\n${body.trim()}` : SURROUNDING_TEXT
      const initialCard = JSON.parse(call.data.content) as Card
      expect.soft(initialCard.body.elements[0]).toEqual({ tag: 'markdown', content: expectedBody })
      const persisted = callbackStore.row
      if (!persisted) throw new Error('No card callback was persisted')
      const persistedSpec = JSON.parse(persisted.spec) as { body: string }
      expect.soft(persistedSpec.body).toBe(expectedBody)
      expect(persisted.messageId).toBe('om_sent_card')
      expect(persisted.debugSuffix).toContain('chat_card_session')
      expect(initialCard.body.elements.at(-1)?.content).toContain('chat_card_session')
      expect(
        initialCard.body.elements.filter((element) =>
          element.content?.includes('chat_card_session'),
        ),
      ).toHaveLength(1)

      const response = (await capturedDispatchers['card.action.trigger']({
        action: { value: { cb: persisted.id, action: 'cancel' } },
        operator: { open_id: TRIGGER_OPEN_ID },
      })) as CardActionResponse
      expect(response.toast.type).toBe('info')
      expect
        .soft(response.card.data.body.elements[0])
        .toEqual({ tag: 'markdown', content: expectedBody })
      expect(response.card.data.body.elements.at(-1)).toEqual(initialCard.body.elements.at(-1))
      expect(
        response.card.data.body.elements.filter((element) =>
          element.content?.includes('chat_card_session'),
        ),
      ).toHaveLength(1)
      expect(JSON.stringify(response.card.data)).not.toContain('"tag":"button"')
      expect(JSON.stringify(response.card.data)).not.toContain('"tag":"form"')
      expect(persisted.status).toBe('used')
      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    },
  )
})
