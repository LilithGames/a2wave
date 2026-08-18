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
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
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

// ── shouldTrigger ────────────────────────────────────────────────

const OFF_ALL = {
  groupTriggerOnAt: false,
  groupTriggerOnNewMessage: false,
  topicTriggerOnAt: false,
  topicTriggerOnNewTopic: false,
  topicTriggerOnNewComment: false,
}

// Split out of feishu-service.test.ts, which crossed its frozen 3756-line baseline once
// the async DB rewrite expanded its mocks. The welcome-handler dispatcher tests are the
// last cohesive block and reuse only the mock preamble above.

describe('welcome handlers via dispatcher', () => {
  const WELCOME_CONFIG = {
    ...BASE_CONFIG,
    welcomeMessage: '👋 hi, I am the bot',
    welcomeOnP2pEnabled: true,
    welcomeP2pIdleDays: 14,
    welcomeOnGroupAddedEnabled: true,
  }

  beforeEach(async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockImMessageCreate.mockResolvedValue({})
    await feishuConnectionManager.start('agt_w', WELCOME_CONFIG)
  })

  async function fireP2pEntered(data: Record<string, any>) {
    const h = capturedDispatchers['im.chat.access_event.bot_p2p_chat_entered_v1']
    if (!h) throw new Error('P2P entered handler not captured')
    await h(data)
  }

  async function fireBotAdded(data: Record<string, any>) {
    const h = capturedDispatchers['im.chat.member.bot.added_v1']
    if (!h) throw new Error('bot.added handler not captured')
    await h(data)
  }

  it('P2P entered with no prior message → 发送 interactive 卡片开场白', async () => {
    await fireP2pEntered({ chat_id: 'oc_p2p_1' })
    expect(mockImMessageCreate).toHaveBeenCalledOnce()
    const args = mockImMessageCreate.mock.calls[0]?.[0]
    expect(args).toMatchObject({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_p2p_1', msg_type: 'interactive' },
    })
  })

  it('P2P entered within idle threshold → 跳过', async () => {
    // 3 天前的消息（毫秒时间戳），阈值 14 天 → 不重发
    const threeDaysAgoMs = Date.now() - 3 * 86_400_000
    await fireP2pEntered({
      chat_id: 'oc_p2p_1',
      last_message_create_time: String(threeDaysAgoMs),
    })
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('P2P entered beyond idle threshold → 重发', async () => {
    // 30 天前（毫秒时间戳）> 14 天阈值
    const longAgoMs = Date.now() - 30 * 86_400_000
    await fireP2pEntered({
      chat_id: 'oc_p2p_1',
      last_message_create_time: String(longAgoMs),
    })
    expect(mockImMessageCreate).toHaveBeenCalledOnce()
  })

  it('P2P entered 恰好到达阈值（边界）→ 发送（严格 < 才跳过）', async () => {
    // 恰好 14 天前：到 handler 执行时已 ≥ 阈值 → 不命中「< 阈值」→ 发送
    const exactlyThresholdMs = Date.now() - 14 * 86_400_000
    await fireP2pEntered({
      chat_id: 'oc_p2p_boundary',
      last_message_create_time: String(exactlyThresholdMs),
    })
    expect(mockImMessageCreate).toHaveBeenCalledOnce()
  })

  it('P2P entered last_message_create_time 非法（NaN）→ fail-open 发送', async () => {
    await fireP2pEntered({
      chat_id: 'oc_p2p_nan',
      last_message_create_time: 'not-a-number',
    })
    expect(mockImMessageCreate).toHaveBeenCalledOnce()
  })

  it('P2P entered with idleDays=0 → 每次都发', async () => {
    feishuConnectionManager.stop('agt_w')
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockImMessageCreate.mockResolvedValue({})
    await feishuConnectionManager.start('agt_w', { ...WELCOME_CONFIG, welcomeP2pIdleDays: 0 })

    const yesterdayMs = Date.now() - 1 * 86_400_000
    await fireP2pEntered({
      chat_id: 'oc_p2p_1',
      last_message_create_time: String(yesterdayMs),
    })
    expect(mockImMessageCreate).toHaveBeenCalledOnce()
  })

  it('welcomeOnP2pEnabled=false → 不发', async () => {
    feishuConnectionManager.stop('agt_w')
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    await feishuConnectionManager.start('agt_w', {
      ...WELCOME_CONFIG,
      welcomeOnP2pEnabled: false,
    })
    await fireP2pEntered({ chat_id: 'oc_p2p_1' })
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('welcomeMessage 为空 → 不发（即使开关打开）', async () => {
    feishuConnectionManager.stop('agt_w')
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    await feishuConnectionManager.start('agt_w', {
      ...WELCOME_CONFIG,
      welcomeMessage: '   ',
    })
    await fireP2pEntered({ chat_id: 'oc_p2p_1' })
    await fireBotAdded({ chat_id: 'oc_grp_1' })
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('机器人被加入群聊 → 发送 interactive 卡片开场白', async () => {
    await fireBotAdded({ chat_id: 'oc_grp_1' })
    expect(mockImMessageCreate).toHaveBeenCalledOnce()
    const args = mockImMessageCreate.mock.calls[0]?.[0]
    expect(args).toMatchObject({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_grp_1', msg_type: 'interactive' },
    })
  })

  it('同一 event_id 重投（WS 重连）→ 仅发一次', async () => {
    // 飞书在重连后会重投未 ACK 的事件，按 event_id 去重避免重复发卡片
    const evt = { chat_id: 'oc_grp_dedup', event_id: 'evt_dedup_1' }
    await fireBotAdded(evt)
    await fireBotAdded(evt)
    expect(mockImMessageCreate).toHaveBeenCalledOnce()
  })

  it('发送失败 → 回滚去重，同一 event_id 重投可补发', async () => {
    // 「先记后发」：首次发送失败时回滚 event_id，使 WS 重投能再次尝试（而非永久跳过）
    mockImMessageCreate.mockRejectedValueOnce(new Error('feishu transient'))
    const evt = { chat_id: 'oc_grp_rollback', event_id: 'evt_rollback_1' }
    await fireBotAdded(evt) // 第一次：失败 → 回滚
    await fireBotAdded(evt) // 第二次：未被去重拦截 → 重新发送
    expect(mockImMessageCreate).toHaveBeenCalledTimes(2)
  })

  it('welcomeOnGroupAddedEnabled=false → 加群不发', async () => {
    feishuConnectionManager.stop('agt_w')
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    await feishuConnectionManager.start('agt_w', {
      ...WELCOME_CONFIG,
      welcomeOnGroupAddedEnabled: false,
    })
    await fireBotAdded({ chat_id: 'oc_grp_1' })
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('chat_id 缺失 → 静默跳过，不抛出', async () => {
    await expect(fireP2pEntered({})).resolves.not.toThrow()
    await expect(fireBotAdded({})).resolves.not.toThrow()
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('飞书 create 失败 → 不向外抛出（已 catch 并记日志）', async () => {
    mockImMessageCreate.mockRejectedValueOnce(new Error('feishu down'))
    await expect(fireBotAdded({ chat_id: 'oc_grp_1' })).resolves.not.toThrow()
  })
})
