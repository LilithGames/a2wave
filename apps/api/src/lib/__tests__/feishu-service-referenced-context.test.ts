import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ────────────────────────────────────────────────

const mockWsClientStart = vi.hoisted(() => vi.fn())
const mockWsClientClose = vi.hoisted(() => vi.fn())
const mockImMessageReply = vi.hoisted(() => vi.fn())
const mockImMessageCreate = vi.hoisted(() => vi.fn())
const mockImMessageGet = vi.hoisted(() => vi.fn())
const mockImMessageReactionCreate = vi.hoisted(() => vi.fn())
const mockImMessageResourceGet = vi.hoisted(() => vi.fn())
const mockImFileCreate = vi.hoisted(() => vi.fn())
const mockClientRequest = vi.hoisted(() => vi.fn())
// capturedDispatchers must be hoisted so the vi.mock factory can reference it
const capturedDispatchers = vi.hoisted(() => ({}) as Record<string, (data: any) => Promise<void>>)

const mockDbGet = vi.hoisted(() => vi.fn())
const mockDbDeleteRun = vi.hoisted(() => vi.fn())
const mockDbWriteRun = vi.hoisted(() => vi.fn().mockReturnValue({ changes: 1 }))
const mockExecuteInWorker = vi.hoisted(() => vi.fn())
const mockExecuteWithRetry = vi.hoisted(() => vi.fn())
const mockTryAcquireSlot = vi.hoisted(() => vi.fn())
const mockFinishRunSuccess = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockFinishRunError = vi.hoisted(() => vi.fn())
const mockFinishRunAborted = vi.hoisted(() => vi.fn())
const mockCleanupWorktreeIfEphemeral = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockBuildAgentConfig = vi.hoisted(() => vi.fn())
const mockResolveWorkDir = vi.hoisted(() => vi.fn())
const mockStreamingCardSend = vi.hoisted(() => vi.fn())
const mockStreamingCardUpdateContent = vi.hoisted(() => vi.fn())
const mockStreamingCardFinish = vi.hoisted(() => vi.fn())
const mockStreamingCardGetMessageId = vi.hoisted(() => vi.fn().mockReturnValue('om_card_test'))
const mockStreamingCardGetCardId = vi.hoisted(() => vi.fn().mockReturnValue('card_test_id'))
const mockRegisterStreamingCard = vi.hoisted(() => vi.fn())
const mockUnregisterStreamingCard = vi.hoisted(() => vi.fn())
const mockTouchStreamingCard = vi.hoisted(() => vi.fn())
const mockLoggerInfo = vi.hoisted(() => vi.fn())

vi.mock('@larksuiteoapi/node-sdk', () => {
  type FakeHandler = (...args: any[]) => any
  class FakeEventDispatcher {
    _handlers: Record<string, FakeHandler> = {}
    register(handlers: Record<string, FakeHandler>) {
      Object.assign(this._handlers, handlers)
      return this
    }
  }

  class FakeWSClient {
    /** 与 `ws` 包一致：OPEN = 1，供 FeishuConnectionManager 轮询 */
    wsConfig = {
      getWSInstance: () => ({ readyState: 1 }),
    }
    start(params: { eventDispatcher: any }) {
      const handlers = params.eventDispatcher?._handlers ?? {}
      for (const key of Object.keys(handlers)) {
        capturedDispatchers[key] = handlers[key] as any
      }
      return mockWsClientStart()
    }
    close(_params?: { force?: boolean }) {
      return mockWsClientClose()
    }
  }

  class FakeClient {
    request = (...args: any[]) => mockClientRequest(...args)
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
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () =>
        asyncQuery({
          where: () =>
            asyncQuery({
              get: mockDbGet,
              all: () => [],
              orderBy: () => ({
                limit: () => asyncQuery({ get: mockDbGet }),
              }),
            }),
        }),
    }),
    insert: () => ({ values: () => asyncQuery({ run: vi.fn() }) }),
    update: () => ({ set: () => asyncQuery({ where: () => asyncQuery({ run: mockDbWriteRun }) }) }),
    delete: () => ({ where: () => asyncQuery({ run: mockDbDeleteRun }) }),
    transaction: (fn: (tx: any) => unknown) =>
      fn({
        select: () => ({
          from: () =>
            asyncQuery({
              where: () =>
                asyncQuery({
                  get: mockDbGet,
                  all: () => [],
                  orderBy: () => ({
                    limit: () => asyncQuery({ get: mockDbGet }),
                  }),
                }),
            }),
        }),
        insert: () => ({ values: () => asyncQuery({ run: vi.fn() }) }),
        update: () => ({
          set: () => asyncQuery({ where: () => asyncQuery({ run: mockDbWriteRun }) }),
        }),
        delete: () => ({ where: () => asyncQuery({ run: mockDbDeleteRun }) }),
      }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: { id: {}, publishStatus: {} },
  runs: {},
  runSteps: {},
  chatMessages: {},
  feishuPendingMessages: { messageId: {}, agentId: {}, runId: {}, payload: {}, createdAt: {} },
}))

vi.mock('../feishu-pending-store.js', () => ({
  persistPendingMessage: vi.fn(),
  removePendingMessage: vi.fn(),
  listPendingMessages: vi.fn().mockReturnValue([]),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn().mockReturnValue({}),
  desc: vi.fn().mockReturnValue({}),
  and: vi.fn().mockReturnValue({}),
  isNull: vi.fn().mockReturnValue({}),
}))

vi.mock('../id.js', () => ({
  createId: (prefix: string) => `${prefix}_test`,
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: mockLoggerInfo },
}))

vi.mock('../agent-helpers.js', () => ({
  buildAgentConfig: mockBuildAgentConfig,
  resolveWorkDir: mockResolveWorkDir,
  resolveEngineType: vi.fn(
    (config: { engineType?: string } | undefined, agentType?: string) =>
      config?.engineType || agentType || 'cursor',
  ),
}))

vi.mock('../run-lifecycle.js', () => ({
  finishRunSuccess: mockFinishRunSuccess,
  finishRunError: mockFinishRunError,
  finishRunAborted: mockFinishRunAborted,
  cleanupWorktreeIfEphemeral: mockCleanupWorktreeIfEphemeral,
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

vi.mock('../../worker/index.js', () => ({
  executeInWorker: mockExecuteInWorker,
}))

vi.mock('../execute-with-retry.js', () => ({
  executeWithRetry: mockExecuteWithRetry,
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: mockTryAcquireSlot,
  scheduleNext: vi.fn(),
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

vi.mock('node:fs', () => {
  const { Writable } = require('node:stream') as typeof import('node:stream')
  return {
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      rmdir: vi.fn().mockResolvedValue(undefined),
    },
    existsSync: vi.fn().mockReturnValue(false), // env.ts uses this to find .env files
    readFileSync: vi.fn().mockReturnValue(Buffer.from('file-content')),
    statSync: vi.fn().mockReturnValue({ size: 1024 }),
    createWriteStream: vi.fn(
      () =>
        new Writable({
          write(_chunk: unknown, _enc: unknown, cb: () => void) {
            cb()
          },
        }),
    ),
  }
})

vi.mock('node:os', () => ({
  tmpdir: () => '/tmp',
}))

vi.mock('node:crypto', () => ({
  randomUUID: () => 'test-uuid',
}))

const mockGetArtifactDownloadUrl = vi.hoisted(() =>
  vi.fn((id: string) => `http://localhost:3502/api/artifacts/${id}/download`),
)
vi.mock('../server-url.js', () => ({
  getArtifactDownloadUrl: mockGetArtifactDownloadUrl,
  getShareUrl: vi.fn((id: string) => `http://localhost:3502/s/${id}`),
}))

vi.mock('../artifact-links.js', () => ({
  buildFeishuArtifactSection: vi.fn(
    (artifacts: Array<{ id: string; filename: string }>, wantSendFiles: boolean) => {
      if (artifacts.length === 0) return null
      if (wantSendFiles) return null
      const lines = artifacts
        .map((a) => `- [${a.filename}](${mockGetArtifactDownloadUrl(a.id)})`)
        .join('\n')
      return `**产物下载**\n${lines}`
    },
  ),
}))

vi.mock('../feishu-card-streaming.js', () => ({
  FeishuStreamingCard: {
    create: vi.fn().mockResolvedValue({
      send: mockStreamingCardSend,
      updateContent: mockStreamingCardUpdateContent,
      finish: mockStreamingCardFinish,
      getMessageId: mockStreamingCardGetMessageId,
      getCardId: mockStreamingCardGetCardId,
    }),
  },
}))

vi.mock('../streaming-card-registry.js', () => ({
  registerStreamingCard: mockRegisterStreamingCard,
  touchStreamingCard: mockTouchStreamingCard,
  unregisterStreamingCard: mockUnregisterStreamingCard,
}))

// ── Import after mocks ───────────────────────────────────────────

import { asyncQuery } from '../../test/async-query.js'
import { P2P_SESSION_TIMEOUT_MS } from '../feishu-message-context.js'
import {
  buildDebugInfoSuffix,
  buildFeishuContext,
  buildFeishuFallbackText,
  buildFeishuReplyContent,
  buildTriggerSessionId,
  extractFileMeta,
  extractImageKeys,
  extractText,
  FEISHU_MESSAGE_RESOURCE_MAX_BYTES,
  type FeishuConfig,
  feishuConnectionManager,
  feishuSafeFileNameForDisk,
  fetchFeishuUserInfo,
  getEffectiveReplyMode,
  normalizeFeishuConfig,
  prependAtMention,
  quoteAnchorId,
  sendArtifactFiles,
  sendFeishuMessageByContext,
  shouldTrigger,
  textToPostContent,
} from '../feishu-service.js'
import type { LifecyclePlugin } from '../pipeline/types.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

// ── Fixtures ─────────────────────────────────────────────────────

const BASE_CONFIG = {
  appId: 'cli_test',
  appSecret: 'secret_test',
  groupTriggerOnAt: true,
  groupTriggerOnNewMessage: false,
  groupReplyMode: 'quote' as const,
  topicTriggerOnAt: true,
  topicTriggerOnNewTopic: false,
  topicTriggerOnNewComment: false,
  topicReplyMode: 'topic_reply' as const,
  p2pReplyMode: 'quote' as const,
}

function makeMessage(overrides: Record<string, any> = {}) {
  return {
    message_type: 'text',
    message_id: 'om_msg001',
    chat_id: 'oc_chat001',
    chat_type: 'group',
    thread_id: 'thread_001',
    content: JSON.stringify({ text: 'hello world' }),
    mentions: [] as Array<{ key: string; id?: { open_id?: string } }>,
    ...overrides,
  }
}

function makeData(
  msgOverrides: Record<string, any> = {},
  senderOverrides: Record<string, any> = {},
) {
  return {
    message: makeMessage(msgOverrides),
    sender: {
      sender_type: 'user',
      sender_id: { open_id: 'ou_user001' },
      ...senderOverrides,
    },
  }
}

function makeAgent(overrides: Record<string, any> = {}) {
  return {
    id: 'agt_001',
    publishStatus: 'published',
    maxConcurrency: 1,
    feishuConfig: BASE_CONFIG,
    ...overrides,
  }
}

describe('Feishu referenced-message dispatch', () => {
  beforeEach(async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    vi.stubEnv('A2WAVE_AGENT_HOMES_DIR', '/agent-homes')
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o' })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'Agent reply' },
      retries: [],
    })
    mockFinishRunSuccess.mockResolvedValue([])
    mockGetArtifactDownloadUrl.mockImplementation(
      (id: string) => `http://localhost:3502/api/artifacts/${id}/download`,
    )
    mockImMessageReply.mockResolvedValue({})
    mockImMessageCreate.mockResolvedValue({})
    mockImMessageReactionCreate.mockResolvedValue({})
    await feishuConnectionManager.start('agt_001', BASE_CONFIG)
  })

  async function dispatch(
    data: any,
    options: { extraPlugins?: readonly LifecyclePlugin[]; config?: FeishuConfig } = {},
  ) {
    const config = options.config ?? BASE_CONFIG
    const sdk = await import('@larksuiteoapi/node-sdk')
    const client = new sdk.Client({ appId: config.appId, appSecret: config.appSecret })
    await feishuConnectionManager.injectE2eMessage('agt_001', client, config, data, {
      botOpenId: 'ou_bot_test',
      extraPlugins: options.extraPlugins ?? [],
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  it('injects a readable ordinary-group card reference into context and prompt metadata', async () => {
    const config = { ...BASE_CONFIG, groupInjectReferencedMessage: true }
    const cardContent = JSON.stringify({
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: 'Grafana alert analysis' } },
      body: {
        elements: [
          { tag: 'markdown', content: '**Conclusion**\nPayment dependency timed out.' },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Investigate' },
            value: { token: 'secret' },
          },
        ],
      },
    })
    mockDbGet.mockReturnValue(makeAgent({ feishuConfig: config }))
    mockImMessageGet.mockResolvedValue({
      data: {
        items: [
          {
            msg_type: 'interactive',
            sender: { sender_type: 'app' },
            body: { content: cardContent },
          },
        ],
      },
    })

    await dispatch(
      makeData({
        chat_type: 'group',
        thread_id: undefined,
        message_id: 'om_question',
        parent_id: 'om_alert_card',
        root_id: 'om_alert_card',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        content: JSON.stringify({ text: '@_user_1 Will this affect payments?' }),
      }),
      { config, extraPlugins: [{ name: 'test:referenced-message' }] },
    )

    expect(mockImMessageGet).toHaveBeenCalledWith({
      params: { card_msg_content_type: 'user_card_content' },
      path: { message_id: 'om_alert_card' },
    })
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.context.referenced_message).toMatchObject({
      message_id: 'om_alert_card',
      message_type: 'interactive',
      sender_type: 'app',
      text: expect.stringContaining('Payment dependency timed out.'),
      truncated: false,
    })
    expect(payload.referencedPromptContext.text).toContain('Payment dependency timed out.')
    expect(payload.prompt).toBe('Will this affect payments?')
    expect(payload.prompt).not.toContain('secret')
  })

  it('supports ordinary-group references without sender, type, or title restrictions', async () => {
    const config = { ...BASE_CONFIG, groupInjectReferencedMessage: true }
    mockDbGet.mockReturnValue(makeAgent({ feishuConfig: config }))
    mockImMessageGet.mockResolvedValue({
      data: {
        items: [
          {
            msg_type: 'text',
            sender: { sender_type: 'user' },
            body: { content: JSON.stringify({ text: 'A teammate supplied this context.' }) },
          },
        ],
      },
    })

    await dispatch(
      makeData({
        chat_type: 'group',
        thread_id: undefined,
        message_id: 'om_generic_question',
        parent_id: 'om_text_reference',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        content: JSON.stringify({ text: '@_user_1 Please explain.' }),
      }),
      { config, extraPlugins: [{ name: 'test:generic-reference' }] },
    )

    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.context.referenced_message).toMatchObject({
      message_id: 'om_text_reference',
      message_type: 'text',
      sender_type: 'user',
      text: 'A teammate supplied this context.',
    })
    expect(payload.prompt).toBe('Please explain.')
  })

  it('does not log the body of a platform template reference', async () => {
    const config = { ...BASE_CONFIG, groupInjectReferencedMessage: true }
    const sensitiveText = 'account=680211 internal-url=http://private.example'
    mockDbGet.mockReturnValue(makeAgent({ feishuConfig: config }))
    mockImMessageGet.mockResolvedValue({
      data: {
        items: [
          {
            msg_type: 'interactive',
            sender: { sender_type: 'app' },
            body: {
              content: JSON.stringify({
                type: 'template',
                data: { template_variable: { content: sensitiveText } },
              }),
            },
          },
        ],
      },
    })

    await dispatch(
      makeData({
        chat_type: 'group',
        thread_id: undefined,
        message_id: 'om_template_question',
        parent_id: 'om_template_alert',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        content: JSON.stringify({ text: '@_user_1 Explain this alert.' }),
      }),
      { config, extraPlugins: [{ name: 'test:template-reference' }] },
    )

    expect(mockExecuteWithRetry.mock.calls[0][1].context.referenced_message.text).toContain(
      sensitiveText,
    )
    expect(JSON.stringify(mockLoggerInfo.mock.calls.map((call) => call[0]))).not.toContain(
      sensitiveText,
    )
  })

  it('skips unsupported CardKit references and continues with the current question', async () => {
    const config = { ...BASE_CONFIG, groupInjectReferencedMessage: true }
    mockDbGet.mockReturnValue(makeAgent({ feishuConfig: config }))
    mockImMessageGet.mockResolvedValue({
      data: {
        items: [
          {
            msg_type: 'interactive',
            sender: { sender_type: 'app' },
            body: {
              content: JSON.stringify({ type: 'card', data: { card_id: 'card_external_1' } }),
            },
          },
        ],
      },
    })

    await dispatch(
      makeData({
        chat_type: 'group',
        thread_id: undefined,
        message_id: 'om_cardkit_question',
        parent_id: 'om_cardkit_alert',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        content: JSON.stringify({ text: '@_user_1 Continue without card content.' }),
      }),
      { config, extraPlugins: [{ name: 'test:unsupported-cardkit-reference' }] },
    )

    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.context.referenced_message).toBeUndefined()
    expect(payload.prompt).toBe('Continue without card content.')
  })

  it('continues with the current question when reference lookup fails', async () => {
    const config = { ...BASE_CONFIG, groupInjectReferencedMessage: true }
    mockDbGet.mockReturnValue(makeAgent({ feishuConfig: config }))
    mockImMessageGet.mockRejectedValue(new Error('missing permission'))

    await dispatch(
      makeData({
        chat_type: 'group',
        thread_id: undefined,
        message_id: 'om_lookup_failure',
        parent_id: 'om_unreadable_reference',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        content: JSON.stringify({ text: '@_user_1 Continue without the quote.' }),
      }),
      { config, extraPlugins: [{ name: 'test:reference-fallback' }] },
    )

    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    expect(mockExecuteWithRetry.mock.calls[0][1].context.referenced_message).toBeUndefined()
    expect(mockExecuteWithRetry.mock.calls[0][1].prompt).toBe('Continue without the quote.')
  })
})
