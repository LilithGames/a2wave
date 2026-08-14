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

import {
  FEISHU_MESSAGE_RESOURCE_MAX_BYTES,
  type FeishuConfig,
  buildDebugInfoSuffix,
  buildFeishuContext,
  buildFeishuFallbackText,
  buildFeishuReplyContent,
  buildTriggerSessionId,
  extractFileMeta,
  extractImageKeys,
  extractText,
  feishuConnectionManager,
  feishuSafeFileNameForDisk,
  fetchFeishuUserInfo,
  getEffectiveReplyMode,
  lookupPreviousChatId,
  normalizeFeishuConfig,
  prependAtMention,
  quoteAnchorId,
  sendArtifactFiles,
  sendFeishuMessageByContext,
  shouldTrigger,
  textToPostContent,
} from '../feishu-service.js'
import type { LifecyclePlugin } from '../pipeline/types.js'

import { asyncQuery } from '../../test/async-query.js'

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

describe('shouldTrigger', () => {
  // ── P2P ──
  it('P2P 消息始终触发，无视其他配置', () => {
    expect(shouldTrigger(OFF_ALL, { chat_type: 'p2p', mentions: [] })).toBe(true)
  })

  // ── 普通群 ──
  it('普通群 + groupTriggerOnAt=true + @机器人 → 触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, groupTriggerOnAt: true },
        { chat_type: 'group', mentions: [{ key: '@_user_1' }] },
      ),
    ).toBe(true)
  })

  it('普通群 + groupTriggerOnAt=true + 无 @mention → 不触发', () => {
    expect(
      shouldTrigger({ ...OFF_ALL, groupTriggerOnAt: true }, { chat_type: 'group', mentions: [] }),
    ).toBe(false)
  })

  it('普通群 + groupTriggerOnAt=false + @机器人 → 不触发', () => {
    expect(shouldTrigger(OFF_ALL, { chat_type: 'group', mentions: [{ key: '@_user_1' }] })).toBe(
      false,
    )
  })

  it('普通群 + groupTriggerOnNewMessage=true → 任何消息均触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, groupTriggerOnNewMessage: true },
        { chat_type: 'group', mentions: [] },
      ),
    ).toBe(true)
  })

  it('普通群 mentions 为 undefined 时按空数组处理', () => {
    expect(shouldTrigger({ ...OFF_ALL, groupTriggerOnAt: true }, { chat_type: 'group' })).toBe(
      false,
    )
  })

  it('@mention key 不是 @_user_1 时不匹配', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, groupTriggerOnAt: true },
        { chat_type: 'group', mentions: [{ key: '@someone_else' }] },
      ),
    ).toBe(false)
  })

  it('groupTriggerOnAt 与 groupTriggerOnNewMessage 同时为 true，无 @mention 也触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, groupTriggerOnAt: true, groupTriggerOnNewMessage: true },
        { chat_type: 'group', mentions: [] },
      ),
    ).toBe(true)
  })

  // ── botOpenId 精确匹配 ──
  it('提供 botOpenId 时，@机器人 open_id 匹配 → 触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, groupTriggerOnAt: true },
        { chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] },
        'ou_bot',
      ),
    ).toBe(true)
  })

  it('提供 botOpenId 时，@了其他用户（非机器人）→ 不触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, groupTriggerOnAt: true },
        { chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'ou_other_user' } }] },
        'ou_bot',
      ),
    ).toBe(false)
  })

  it('提供 botOpenId 时，消息中包含多个 @mention，机器人不是第一个 → 仍能正确触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, groupTriggerOnAt: true },
        {
          chat_type: 'group',
          mentions: [
            { key: '@_user_1', id: { open_id: 'ou_alice' } },
            { key: '@_user_2', id: { open_id: 'ou_bot' } },
          ],
        },
        'ou_bot',
      ),
    ).toBe(true)
  })

  // ── 话题群 ──
  it('话题群 + topicTriggerOnAt=true + @机器人 → 触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, topicTriggerOnAt: true },
        { chat_type: 'group', thread_id: 'th_001', mentions: [{ key: '@_user_1' }] },
      ),
    ).toBe(true)
  })

  it('话题群 + topicTriggerOnNewTopic=true + 新话题（有 thread_id 无 root_id）→ 触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, topicTriggerOnNewTopic: true },
        { chat_type: 'group', thread_id: 'th_001', mentions: [] },
      ),
    ).toBe(true)
  })

  it('话题群 + topicTriggerOnNewTopic=true + 话题回复（有 root_id）→ 不触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, topicTriggerOnNewTopic: true },
        { chat_type: 'group', thread_id: 'th_001', root_id: 'om_root', mentions: [] },
      ),
    ).toBe(false)
  })

  it('话题群 + topicTriggerOnNewComment=true + 话题回复 → 触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, topicTriggerOnNewComment: true },
        { chat_type: 'group', thread_id: 'th_001', root_id: 'om_root', mentions: [] },
      ),
    ).toBe(true)
  })

  it('话题群 + topicTriggerOnNewComment=true + 新话题（无 root_id）→ 不触发', () => {
    expect(
      shouldTrigger(
        { ...OFF_ALL, topicTriggerOnNewComment: true },
        { chat_type: 'group', thread_id: 'th_001', mentions: [] },
      ),
    ).toBe(false)
  })

  it('话题群全部关闭 → 不触发', () => {
    expect(shouldTrigger(OFF_ALL, { chat_type: 'group', thread_id: 'th_001', mentions: [] })).toBe(
      false,
    )
  })
})

// ── getEffectiveReplyMode ───────────────────────────────────────

describe('getEffectiveReplyMode', () => {
  it('普通群消息使用 groupReplyMode', () => {
    expect(
      getEffectiveReplyMode(
        { groupReplyMode: 'new', topicReplyMode: 'topic_reply', p2pReplyMode: 'quote' },
        {},
      ),
    ).toBe('new')
    expect(
      getEffectiveReplyMode(
        { groupReplyMode: 'none', topicReplyMode: 'topic_reply', p2pReplyMode: 'quote' },
        {},
      ),
    ).toBe('none')
  })

  it('话题群消息 topicReplyMode=topic_reply → 映射为 quote', () => {
    expect(
      getEffectiveReplyMode(
        { groupReplyMode: 'new', topicReplyMode: 'topic_reply', p2pReplyMode: 'quote' },
        { chat_type: 'group', thread_id: 'th_1' },
      ),
    ).toBe('quote')
  })

  it('话题群消息 topicReplyMode=none → none', () => {
    expect(
      getEffectiveReplyMode(
        { groupReplyMode: 'quote', topicReplyMode: 'none', p2pReplyMode: 'quote' },
        { chat_type: 'group', thread_id: 'th_1' },
      ),
    ).toBe('none')
  })

  it('P2P 消息使用 p2pReplyMode（独立于 groupReplyMode）', () => {
    expect(
      getEffectiveReplyMode(
        { groupReplyMode: 'none', topicReplyMode: 'none', p2pReplyMode: 'quote' },
        { chat_type: 'p2p' },
      ),
    ).toBe('quote')
    expect(
      getEffectiveReplyMode(
        { groupReplyMode: 'quote', topicReplyMode: 'topic_reply', p2pReplyMode: 'new' },
        { chat_type: 'p2p' },
      ),
    ).toBe('new')
  })

  it('P2P 消息即使携带 thread_id 也走 p2pReplyMode（不进入话题分支）', () => {
    expect(
      getEffectiveReplyMode(
        { groupReplyMode: 'new', topicReplyMode: 'none', p2pReplyMode: 'quote' },
        { chat_type: 'p2p', thread_id: 'th_1' },
      ),
    ).toBe('quote')
  })

  it('P2P + p2pReplyMode=none → none（保留极端场景：私聊静默）', () => {
    expect(
      getEffectiveReplyMode(
        { groupReplyMode: 'quote', topicReplyMode: 'topic_reply', p2pReplyMode: 'none' },
        { chat_type: 'p2p' },
      ),
    ).toBe('none')
  })
})

// ── normalizeFeishuConfig ────────────────────────────────────────

describe('normalizeFeishuConfig', () => {
  it('旧格式迁移：triggerOnAt / triggerOnNewMessage / replyMode → group* / topic*', () => {
    const legacy = {
      appId: 'cli_x',
      appSecret: 's',
      triggerOnAt: true,
      triggerOnNewMessage: true,
      replyMode: 'new',
      replyContentType: 'post',
      sendArtifactsAsFile: false,
    }
    const result = normalizeFeishuConfig(legacy)
    expect(result.groupTriggerOnAt).toBe(true)
    expect(result.groupTriggerOnNewMessage).toBe(true)
    expect(result.groupReplyMode).toBe('new')
    expect(result.topicTriggerOnAt).toBe(true)
    expect(result.topicTriggerOnNewTopic).toBe(false)
    expect(result.topicTriggerOnNewComment).toBe(false)
    expect(result.topicReplyMode).toBe('topic_reply')
    expect(result.p2pReplyMode).toBe('new') // legacy replyMode → p2pReplyMode
    expect(result.replyContentType).toBe('post')
    expect(result.sendArtifactsAsFile).toBe(false)
  })

  it('旧格式无 replyMode → p2pReplyMode 默认 quote', () => {
    const result = normalizeFeishuConfig({ appId: 'cli_x', appSecret: 's' })
    expect(result.p2pReplyMode).toBe('quote')
  })

  it('新格式显式 p2pReplyMode 不被 legacy 覆盖', () => {
    const result = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 's',
      replyMode: 'new', // legacy
      p2pReplyMode: 'none', // explicit
    })
    expect(result.p2pReplyMode).toBe('none')
  })

  it('新格式原样返回', () => {
    const config = { ...BASE_CONFIG }
    const result = normalizeFeishuConfig(config)
    expect(result).toMatchObject(config)
    expect(result.replyContentType).toBe('text')
    expect(result.sendArtifactsAsFile).toBe(true)
    expect(result.fetchUserInfo).toBe(false)
  })

  it('开场白字段归一化：负数/非数字 idleDays、非字符串 message、非布尔开关都被规整', () => {
    const result = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 's',
      welcomeMessage: 123 as unknown as string, // 非字符串 → undefined（防 .trim() 抛错）
      welcomeOnP2pEnabled: 'false' as unknown as boolean, // 字符串 truthy → 规整为 false
      welcomeP2pIdleDays: -5, // 负数 → 丢弃（避免关掉空闲门），由 handler 兜底默认
      welcomeOnGroupAddedEnabled: true,
    })
    expect(result.welcomeMessage).toBeUndefined()
    expect(result.welcomeOnP2pEnabled).toBe(false)
    expect(result.welcomeP2pIdleDays).toBeUndefined()
    expect(result.welcomeOnGroupAddedEnabled).toBe(true)
  })

  it('开场白字段：合法值原样保留，idleDays=0（每次都发）不被丢弃', () => {
    const result = normalizeFeishuConfig({
      appId: 'cli_x',
      appSecret: 's',
      welcomeMessage: 'hi',
      welcomeOnP2pEnabled: true,
      welcomeP2pIdleDays: 0,
      welcomeOnGroupAddedEnabled: false,
    })
    expect(result.welcomeMessage).toBe('hi')
    expect(result.welcomeOnP2pEnabled).toBe(true)
    expect(result.welcomeP2pIdleDays).toBe(0)
    expect(result.welcomeOnGroupAddedEnabled).toBe(false)
  })

  it('旧格式缺失字段使用默认值', () => {
    const minimal = { appId: 'cli_x', appSecret: 's' }
    const result = normalizeFeishuConfig(minimal)
    expect(result.groupTriggerOnAt).toBe(true)
    expect(result.groupTriggerOnNewMessage).toBe(false)
    expect(result.groupReplyMode).toBe('quote')
  })

  it('新格式不完整 payload 补齐默认值', () => {
    const partial = { appId: 'cli_x', appSecret: 's', groupTriggerOnAt: false }
    const result = normalizeFeishuConfig(partial)
    expect(result.groupTriggerOnAt).toBe(false)
    expect(result.groupTriggerOnNewMessage).toBe(false)
    expect(result.groupReplyMode).toBe('quote')
    expect(result.topicTriggerOnAt).toBe(true)
    expect(result.topicTriggerOnNewTopic).toBe(false)
    expect(result.topicTriggerOnNewComment).toBe(false)
    expect(result.topicReplyMode).toBe('topic_reply')
  })
})

// ── extractText ──────────────────────────────────────────────────

describe('extractText', () => {
  it('提取普通文本', () => {
    expect(extractText(JSON.stringify({ text: 'hello' }))).toBe('hello')
  })

  it('去除单个 @mention 并 trim', () => {
    expect(extractText(JSON.stringify({ text: '@_user_1 帮我查代码' }))).toBe('帮我查代码')
  })

  it('多个 @mention 均被去除', () => {
    expect(extractText(JSON.stringify({ text: '@_user_1 @_user_2 看下这个' }))).toBe('看下这个')
  })

  it('内容为纯 @mention 时返回空字符串', () => {
    expect(extractText(JSON.stringify({ text: '@_user_1 ' }))).toBe('')
  })

  it('@所有人 后跟正文不被误删（bug 回归）', () => {
    expect(extractText(JSON.stringify({ text: '@_user_1 @所有人的功能有开关吗' }))).toBe(
      '@所有人的功能有开关吗',
    )
  })

  it('text 字段不存在时返回空字符串', () => {
    expect(extractText(JSON.stringify({}))).toBe('')
  })

  it('JSON 解析失败时返回空字符串', () => {
    expect(extractText('not-json')).toBe('')
  })

  it('保留 @mention 以外的完整内容', () => {
    expect(extractText(JSON.stringify({ text: '@_user_1 查一下 P4 //depot/... 的最近提交' }))).toBe(
      '查一下 P4 //depot/... 的最近提交',
    )
  })

  it('mixed 消息从 elements 中提取 text tag 内容', () => {
    const content = JSON.stringify({
      elements: [[{ tag: 'text', text: '请看这张图' }], [{ tag: 'img', image_key: 'img_xxx' }]],
    })
    expect(extractText(content)).toBe('请看这张图')
  })

  it('mixed 消息多个 text 元素拼接', () => {
    const content = JSON.stringify({
      elements: [
        [
          { tag: 'text', text: '第一段' },
          { tag: 'text', text: '第二段' },
        ],
        [{ tag: 'img', image_key: 'img_xxx' }],
      ],
    })
    expect(extractText(content)).toBe('第一段第二段')
  })

  it('mixed 消息只有图片无文字时返回空字符串', () => {
    const content = JSON.stringify({
      elements: [[{ tag: 'img', image_key: 'img_xxx' }]],
    })
    expect(extractText(content)).toBe('')
  })

  it('mixed 消息中 @mention 被去除', () => {
    const content = JSON.stringify({
      elements: [[{ tag: 'text', text: '@_user_1 这是什么' }]],
    })
    expect(extractText(content)).toBe('这是什么')
  })

  it('post 消息（扁平格式）提取 text', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [{ tag: 'img', image_key: 'img_xxx', width: 498, height: 924 }],
        [{ tag: 'text', text: '这是什么？', style: [] }],
      ],
    })
    expect(extractText(content)).toBe('这是什么？')
  })

  it('post 消息（zh_cn 格式）提取 text', () => {
    const content = JSON.stringify({
      zh_cn: {
        title: '',
        content: [[{ tag: 'text', text: '请看图片' }], [{ tag: 'img', image_key: 'img_xxx' }]],
      },
    })
    expect(extractText(content)).toBe('请看图片')
  })

  it('post 消息多个 text 元素拼接', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [
          { tag: 'text', text: '第一行' },
          { tag: 'text', text: '第二行' },
        ],
      ],
    })
    expect(extractText(content)).toBe('第一行第二行')
  })

  it('post 消息只有图片时返回空字符串', () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'img', image_key: 'img_xxx' }]],
    })
    expect(extractText(content)).toBe('')
  })

  it('post 消息默认不保留行间换行（兼容旧行为）', () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'text', text: '第一段' }], [{ tag: 'text', text: '第二段' }]],
    })
    expect(extractText(content)).toBe('第一段第二段')
  })

  it('post 消息 richPost=true 时行间用换行符分隔', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [{ tag: 'text', text: '第一段' }],
        [{ tag: 'text', text: '第二段' }],
        [{ tag: 'text', text: '第三段' }],
      ],
    })
    expect(extractText(content, true)).toBe('第一段\n第二段\n第三段')
  })

  it('post 消息 richPost=true 时链接节点提取链接文字', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [
          { tag: 'text', text: '参考文档：' },
          { tag: 'a', text: '点这里', href: 'https://example.com' },
        ],
      ],
    })
    expect(extractText(content, true)).toBe('参考文档：点这里')
  })

  // ── interactive 卡片（飞书项目 / 自定义卡片推送） ──
  it('interactive 卡片：title 与 text+a 节点拼接', () => {
    const content = JSON.stringify({
      title: '🆕 缺陷创建提醒',
      elements: [
        [
          { tag: 'text', text: '产品与数据平台 · 缺陷 · #6975313316' },
          { tag: 'text', text: '\n' },
          {
            tag: 'a',
            href: 'https://project.feishu.cn/x/issue/6975313316',
            text: '【服务器】登录限制异常',
          },
          { tag: 'text', text: ' 创建成功' },
        ],
        [{ tag: 'button', text: '查看详情', type: 'default' }],
      ],
      user_dsl: '{}',
    })
    expect(extractText(content, false, 'interactive')).toBe(
      '🆕 缺陷创建提醒\n产品与数据平台 · 缺陷 · #6975313316\n【服务器】登录限制异常 创建成功',
    )
  })

  it('interactive 卡片：无 title 时仅返回 body', () => {
    const content = JSON.stringify({
      elements: [[{ tag: 'text', text: '提醒消息' }]],
    })
    expect(extractText(content, false, 'interactive')).toBe('提醒消息')
  })

  it('interactive 卡片：无 elements 且无 title 时返回空', () => {
    expect(extractText(JSON.stringify({}), false, 'interactive')).toBe('')
  })

  it('interactive 卡片：过滤 @mention 占位符', () => {
    const content = JSON.stringify({
      title: '',
      elements: [[{ tag: 'text', text: '@_user_1 请查看' }]],
    })
    expect(extractText(content, false, 'interactive')).toBe('请查看')
  })

  it('interactive 卡片：非数组 elements 安全忽略', () => {
    const content = JSON.stringify({ title: '仅标题', elements: 'not-array' })
    expect(extractText(content, false, 'interactive')).toBe('仅标题')
  })

  it('post 消息 richPost=true 时链接节点无文字回落到 href', () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'a', href: 'https://example.com' }]],
    })
    expect(extractText(content, true)).toBe('https://example.com')
  })
})

// ── extractImageKeys ─────────────────────────────────────────────

describe('extractImageKeys', () => {
  it('image 类型消息返回 image_key', () => {
    const content = JSON.stringify({ image_key: 'img_xxx' })
    expect(extractImageKeys(content, 'image')).toEqual(['img_xxx'])
  })

  it('image 类型消息缺少 image_key 返回空数组', () => {
    const content = JSON.stringify({})
    expect(extractImageKeys(content, 'image')).toEqual([])
  })

  it('mixed 类型消息返回 elements 中所有 img 的 image_key', () => {
    const content = JSON.stringify({
      elements: [
        [{ tag: 'img', image_key: 'img_001' }],
        [{ tag: 'text', text: 'hello' }],
        [{ tag: 'img', image_key: 'img_002' }],
      ],
    })
    expect(extractImageKeys(content, 'mixed')).toEqual(['img_001', 'img_002'])
  })

  it('mixed 类型消息无图片时返回空数组', () => {
    const content = JSON.stringify({
      elements: [[{ tag: 'text', text: 'hello' }]],
    })
    expect(extractImageKeys(content, 'mixed')).toEqual([])
  })

  it('post 类型消息（扁平格式）返回 image_key', () => {
    const content = JSON.stringify({
      title: '',
      content: [
        [{ tag: 'img', image_key: 'img_p01', width: 498, height: 924 }],
        [{ tag: 'text', text: 'hello' }],
        [{ tag: 'img', image_key: 'img_p02' }],
      ],
    })
    expect(extractImageKeys(content, 'post')).toEqual(['img_p01', 'img_p02'])
  })

  it('post 类型消息（zh_cn 格式）返回 image_key', () => {
    const content = JSON.stringify({
      zh_cn: {
        title: '',
        content: [[{ tag: 'img', image_key: 'img_p01' }]],
      },
    })
    expect(extractImageKeys(content, 'post')).toEqual(['img_p01'])
  })

  it('post 类型消息无图片时返回空数组', () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'text', text: 'hello' }]],
    })
    expect(extractImageKeys(content, 'post')).toEqual([])
  })

  it('text 类型消息始终返回空数组', () => {
    const content = JSON.stringify({ text: 'hello', image_key: 'img_xxx' })
    expect(extractImageKeys(content, 'text')).toEqual([])
  })

  it('JSON 解析失败返回空数组', () => {
    expect(extractImageKeys('not-json', 'image')).toEqual([])
  })
})

// ── extractFileMeta / feishuSafeFileNameForDisk ─────────────────

describe('extractFileMeta', () => {
  it('解析 file_key 与 file_name', () => {
    expect(extractFileMeta(JSON.stringify({ file_key: 'fk_abc', file_name: 'a.pdf' }))).toEqual({
      fileKey: 'fk_abc',
      fileName: 'a.pdf',
    })
  })

  it('缺少 file_key 返回 null', () => {
    expect(extractFileMeta(JSON.stringify({ file_name: 'a.pdf' }))).toBeNull()
  })

  it('非法 JSON 返回 null', () => {
    expect(extractFileMeta('x')).toBeNull()
  })
})

describe('feishuSafeFileNameForDisk', () => {
  it('保留合法文件名与扩展名', () => {
    expect(feishuSafeFileNameForDisk('report.pdf', 'fk1')).toBe('report.pdf')
  })

  it('去除路径成分并消毒', () => {
    expect(feishuSafeFileNameForDisk('../../etc/passwd', 'fk2')).toMatch(/^passwd_fk2/)
  })
})

// ── prependAtMention ─────────────────────────────────────────────

describe('prependAtMention', () => {
  it('text 消息在文本前插入 at 标签', () => {
    const input = JSON.stringify({ text: 'hello' })
    const result = JSON.parse(prependAtMention('text', input, 'ou_abc'))
    expect(result.text).toBe('<at user_id="ou_abc"></at> hello')
  })

  it('post 消息在第一行首位插入 at 节点', () => {
    const input = JSON.stringify({
      zh_cn: { title: '', content: [[{ tag: 'text', text: 'hello' }]] },
    })
    const result = JSON.parse(prependAtMention('post', input, 'ou_abc'))
    const firstLine = result.zh_cn.content[0]
    expect(firstLine[0]).toEqual({ tag: 'at', user_id: 'ou_abc' })
    expect(firstLine[1]).toEqual({ tag: 'text', text: ' ' })
    expect(firstLine[2]).toEqual({ tag: 'text', text: 'hello' })
  })

  it('interactive 类型原样返回', () => {
    const input = JSON.stringify({ type: 'template' })
    expect(prependAtMention('interactive', input, 'ou_abc')).toBe(input)
  })

  it('post 内容为空行时在首位插入', () => {
    const input = JSON.stringify({ zh_cn: { title: '', content: [] } })
    const result = JSON.parse(prependAtMention('post', input, 'ou_abc'))
    expect(result.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_abc' })
  })
})

// ── buildTriggerSessionId ────────────────────────────────────────

describe('buildTriggerSessionId', () => {
  it('thread_id 存在时优先返回 thread_id', () => {
    expect(
      buildTriggerSessionId({
        thread_id: 'th_001',
        chat_type: 'p2p',
        chat_id: 'oc_chat_001',
      }),
    ).toBe('th_001')
  })

  it('p2p 且无 thread_id 时返回 chat_id', () => {
    expect(
      buildTriggerSessionId({
        chat_type: 'p2p',
        chat_id: 'oc_chat_001',
      }),
    ).toBe('oc_chat_001')
  })

  it('群聊且无 thread_id 和 root_id 时返回 message_id（作为回复链的锚点）', () => {
    expect(
      buildTriggerSessionId({
        chat_type: 'group',
        chat_id: 'oc_group_001',
        message_id: 'om_msg_001',
      }),
    ).toBe('om_msg_001')
  })

  it('群聊有 root_id 时返回 root_id', () => {
    expect(
      buildTriggerSessionId({
        chat_type: 'group',
        chat_id: 'oc_group_001',
        root_id: 'om_root_001',
      }),
    ).toBe('om_root_001')
  })

  it('同时有 thread_id 和 root_id 时优先返回 thread_id', () => {
    expect(
      buildTriggerSessionId({
        chat_type: 'group',
        chat_id: 'oc_group_001',
        thread_id: 'th_001',
        root_id: 'om_root_001',
      }),
    ).toBe('th_001')
  })
})

// ── quoteAnchorId ────────────────────────────────────────────────

describe('quoteAnchorId', () => {
  it('普通消息回退到自身 message_id', () => {
    expect(quoteAnchorId({ message_id: 'om_msg_001' })).toBe('om_msg_001')
  })

  it('交互卡片续跑：有 quote_message_id 时锚定最初提问而非卡片消息', () => {
    expect(
      quoteAnchorId({
        message_id: 'om_card_msg_002', // 卡片消息（去重/回执锚点）
        quote_message_id: 'om_original_001', // 最初提问（回复锚点）
      }),
    ).toBe('om_original_001')
  })
})

// ── lookupPreviousChatId ─────────────────────────────────────────

describe('lookupPreviousChatId', () => {
  beforeEach(() => {
    mockDbGet.mockReset()
  })

  it('命中有效 chatId 时返回 chatId', async () => {
    mockDbGet.mockReturnValue({ result: { chatId: 'chat_123' }, updatedAt: new Date() })
    expect(await lookupPreviousChatId('agt_001', 'th_001')).toBe('chat_123')
  })

  it('超出超时时间时返回 null', async () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000) // 3 hours ago
    mockDbGet.mockReturnValue({ result: { chatId: 'chat_123' }, updatedAt: old })
    expect(await lookupPreviousChatId('agt_001', 'th_001')).toBeNull()
  })

  it('sessionTimeoutMs=Infinity 时永不超时', async () => {
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days ago
    mockDbGet.mockReturnValue({ result: { chatId: 'chat_123' }, updatedAt: old })
    expect(await lookupPreviousChatId('agt_001', 'th_001', Number.POSITIVE_INFINITY)).toBe(
      'chat_123',
    )
  })

  it('result 无 chatId 时返回 null', async () => {
    mockDbGet.mockReturnValue({ result: {}, updatedAt: new Date() })
    expect(await lookupPreviousChatId('agt_001', 'th_001')).toBeNull()
  })

  it('无匹配 run 时返回 null', async () => {
    mockDbGet.mockReturnValue(undefined)
    expect(await lookupPreviousChatId('agt_001', 'th_001')).toBeNull()
  })
})

// ── buildFeishuContext ───────────────────────────────────────────

describe('buildFeishuContext (returns { context: { channel: RunChannelContext }, displayName })', () => {
  type FeishuChannel = {
    channel_type: 'feishu'
    channel_info: {
      app_id: string
      chat_id: string
      chat_type: string
      message_id: string
      thread_id?: string
      sender_type: string
      sender_open_id: string
    }
    user_info: { email: string; name?: string; source: 'feishu'; source_id?: string } | null
  }

  it('maps all message + sender fields into channel.channel_info', () => {
    const out = buildFeishuContext(
      { sender_type: 'user', sender_id: { open_id: 'ou_abc' } },
      { message_id: 'om_1', chat_id: 'oc_2', thread_id: 'th_3', chat_type: 'group' },
      undefined,
      'cli_app1',
    )
    const channel = out.context.channel as FeishuChannel
    expect(channel.channel_type).toBe('feishu')
    expect(channel.channel_info).toMatchObject({
      app_id: 'cli_app1',
      chat_id: 'oc_2',
      chat_type: 'group',
      message_id: 'om_1',
      thread_id: 'th_3',
      sender_type: 'user',
      sender_open_id: 'ou_abc',
    })
    expect(channel.user_info).toBeNull()
    expect(out.displayName).toBeNull()
  })

  it('omits thread_id from channel_info when missing', () => {
    const channel = buildFeishuContext(
      { sender_type: 'user', sender_id: { open_id: 'ou_abc' } },
      { message_id: 'om_1', chat_id: 'oc_2', chat_type: 'p2p' },
      undefined,
      'cli_test',
    ).context.channel as FeishuChannel
    expect(channel.channel_info.thread_id).toBeUndefined()
  })

  it('falls back sender_type to "user" when undefined; omits sender_open_id', () => {
    const channel = buildFeishuContext(
      undefined,
      { message_id: 'om_1', chat_id: 'oc_2', chat_type: 'p2p' },
      undefined,
      'cli_test',
    ).context.channel as FeishuChannel
    expect(channel.channel_info.sender_type).toBe('user')
    // Empty open_id would violate schema .min(1); builder drops the key.
    expect(channel.channel_info.sender_open_id).toBeUndefined()
  })

  it('populates user_info when fetched user has email', () => {
    const userInfo = { name: 'Test User', email: 'test@example.com', open_id: 'ou_abc' }
    const out = buildFeishuContext(
      { sender_type: 'user', sender_id: { open_id: 'ou_abc' } },
      { message_id: 'om_1', chat_id: 'oc_2', chat_type: 'p2p' },
      userInfo,
      'cli_test',
    )
    const channel = out.context.channel as FeishuChannel
    expect(channel.user_info).toMatchObject({
      email: 'test@example.com',
      name: 'Test User',
      source: 'feishu',
      source_id: 'ou_abc',
    })
    expect(out.displayName).toBe('Test User')
  })

  it('surfaces displayName even when fetched user has NO email (Feishu app missing contact:contact:readonly scope)', () => {
    const userInfo = { name: '张三', en_name: 'Zhang San', open_id: 'ou_abc' }
    const out = buildFeishuContext(
      { sender_type: 'user', sender_id: { open_id: 'ou_abc' } },
      { message_id: 'om_1', chat_id: 'oc_2', chat_type: 'p2p' },
      userInfo,
      'cli_test',
    )
    // user_info still null (strict schema requires email)…
    expect((out.context.channel as FeishuChannel).user_info).toBeNull()
    // …but displayName falls through to user.name so the runs list still shows the sender.
    expect(out.displayName).toBe('张三')
  })

  it('user_info is null when fetched info is null (fetchUserInfo disabled / API failure)', () => {
    const out = buildFeishuContext(
      { sender_type: 'user', sender_id: { open_id: 'ou_abc' } },
      { message_id: 'om_1', chat_id: 'oc_2', chat_type: 'p2p' },
      null,
      'cli_test',
    )
    expect((out.context.channel as FeishuChannel).user_info).toBeNull()
    expect(out.displayName).toBeNull()
  })

  it('user_info is null when fetched info is omitted', () => {
    const channel = buildFeishuContext(
      { sender_type: 'user', sender_id: { open_id: 'ou_abc' } },
      { message_id: 'om_1', chat_id: 'oc_2', chat_type: 'p2p' },
      undefined,
      'cli_test',
    ).context.channel as FeishuChannel
    expect(channel.user_info).toBeNull()
  })

  it('throws when appId is missing (fail-fast to surface plumbing bugs)', () => {
    expect(() =>
      buildFeishuContext(
        { sender_type: 'user', sender_id: { open_id: 'ou_abc' } },
        { message_id: 'om_1', chat_id: 'oc_2', chat_type: 'p2p' },
      ),
    ).toThrow(/appId is required/)
  })
})

// ── fetchFeishuUserInfo ─────────────────────────────────────────────────────────

describe('fetchFeishuUserInfo', () => {
  let fakeClient: any

  beforeEach(async () => {
    const sdk = await import('@larksuiteoapi/node-sdk')
    fakeClient = new sdk.Client({ appId: 'a', appSecret: 'b' })
    mockClientRequest.mockReset()
  })

  it('API 返回完整 user 时提取 name/email/open_id 等字段', async () => {
    mockClientRequest.mockResolvedValue({
      data: {
        user: {
          name: '张三',
          en_name: 'Zhang San',
          email: 'zhang@example.com',
          open_id: 'ou_u1',
          user_id: 'uid1',
          union_id: 'union1',
        },
      },
    })
    const info = await fetchFeishuUserInfo(fakeClient, 'ou_u1', 'cli_test_a')
    expect(info).toEqual({
      name: '张三',
      en_name: 'Zhang San',
      email: 'zhang@example.com',
      open_id: 'ou_u1',
      user_id: 'uid1',
      union_id: 'union1',
    })
  })

  it('第二次调用命中缓存，不再发起 API 请求', async () => {
    mockClientRequest.mockResolvedValue({
      data: { user: { name: 'Cached', email: 'c@e.com', open_id: 'ou_cache1' } },
    })
    const appId = 'cli_cache_test'
    const openId = 'ou_cache1'
    await fetchFeishuUserInfo(fakeClient, openId, appId)
    mockClientRequest.mockClear()
    const cached = await fetchFeishuUserInfo(fakeClient, openId, appId)
    expect(cached?.name).toBe('Cached')
    expect(mockClientRequest).not.toHaveBeenCalled()
  })

  it('不同 appId 相同 openId 不共享缓存', async () => {
    mockClientRequest.mockResolvedValue({
      data: { user: { name: 'AppA', email: 'a@e.com', open_id: 'ou_shared' } },
    })
    await fetchFeishuUserInfo(fakeClient, 'ou_shared', 'cli_app_a')
    mockClientRequest.mockReset().mockResolvedValue({
      data: { user: { name: 'AppB', email: 'b@e.com', open_id: 'ou_shared' } },
    })
    const info = await fetchFeishuUserInfo(fakeClient, 'ou_shared', 'cli_app_b')
    expect(info?.name).toBe('AppB')
    expect(mockClientRequest).toHaveBeenCalledOnce()
  })

  it('API 返回无 user 时返回 null 并 error 日志', async () => {
    const { logger } = await import('../logger.js')
    mockClientRequest.mockResolvedValue({ data: {} })
    const result = await fetchFeishuUserInfo(fakeClient, 'ou_nouser', 'cli_nouser')
    expect(result).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ openId: 'ou_nouser' }),
      expect.stringContaining('API returned no user'),
    )
  })

  it('API 抛异常时返回 null 并 error 日志', async () => {
    const { logger } = await import('../logger.js')
    mockClientRequest.mockRejectedValue(new Error('network timeout'))
    const result = await fetchFeishuUserInfo(fakeClient, 'ou_err', 'cli_err')
    expect(result).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ openId: 'ou_err', appId: 'cli_err' }),
      expect.stringContaining('API call failed'),
    )
  })

  it('name 和 email 都为空时 error 日志提示权限不足', async () => {
    const { logger } = await import('../logger.js')
    mockClientRequest.mockResolvedValue({
      data: { user: { open_id: 'ou_noperm', user_id: 'uid_noperm' } },
    })
    const result = await fetchFeishuUserInfo(fakeClient, 'ou_noperm', 'cli_noperm')
    expect(result).not.toBeNull()
    expect(result?.open_id).toBe('ou_noperm')
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ openId: 'ou_noperm', appId: 'cli_noperm' }),
      expect.stringContaining('contact:contact.base:readonly'),
    )
  })
})

// ── sendFeishuMessageByContext ─────────────────────────────────────────────────

describe('sendFeishuMessageByContext', () => {
  beforeEach(() => {
    mockImMessageCreate.mockReset().mockResolvedValue({})
  })

  it('context 缺少 receive_id_type 时返回 false，不调用飞书 API', async () => {
    const result = await sendFeishuMessageByContext(
      'agt_001',
      { chat_type: 'p2p', receive_id: 'on_xxx' },
      'hello',
    )
    expect(result).toBe(false)
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('context 缺少 receive_id 时返回 false，不调用飞书 API', async () => {
    const result = await sendFeishuMessageByContext(
      'agt_001',
      { chat_type: 'p2p', receive_id_type: 'union_id' },
      'hello',
    )
    expect(result).toBe(false)
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('agent 不存在时返回 false', async () => {
    mockDbGet.mockReturnValue(undefined)
    const result = await sendFeishuMessageByContext(
      'agt_nonexistent',
      { chat_type: 'p2p', receive_id_type: 'union_id', receive_id: 'on_xxx' },
      'hello',
    )
    expect(result).toBe(false)
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('agent 的 publishChannels 不包含 feishu 时返回 false', async () => {
    mockDbGet.mockReturnValue(makeAgent({ publishChannels: ['api'] }))
    const result = await sendFeishuMessageByContext(
      'agt_001',
      { chat_type: 'p2p', receive_id_type: 'union_id', receive_id: 'on_xxx' },
      'hello',
    )
    expect(result).toBe(false)
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('agent 无 feishuConfig 时返回 false', async () => {
    mockDbGet.mockReturnValue(makeAgent({ feishuConfig: null, publishChannels: ['api', 'feishu'] }))
    const result = await sendFeishuMessageByContext(
      'agt_001',
      { chat_type: 'p2p', receive_id_type: 'union_id', receive_id: 'on_xxx' },
      'hello',
    )
    expect(result).toBe(false)
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('合法 context 时调用 im.message.create 并返回 true', async () => {
    mockDbGet.mockReturnValue(makeAgent({ publishChannels: ['api', 'feishu'] }))
    const result = await sendFeishuMessageByContext(
      'agt_001',
      { chat_type: 'p2p', receive_id_type: 'union_id', receive_id: 'on_xxx' },
      'hello',
    )
    expect(result).toBe(true)
    expect(mockImMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'union_id' },
      data: {
        receive_id: 'on_xxx',
        content: JSON.stringify({ text: 'hello' }),
        msg_type: 'text',
      },
    })
  })

  it('飞书 API 失败时返回 false', async () => {
    mockDbGet.mockReturnValue(makeAgent({ publishChannels: ['api', 'feishu'] }))
    mockImMessageCreate.mockRejectedValue(new Error('Feishu API error'))
    const result = await sendFeishuMessageByContext(
      'agt_001',
      { chat_type: 'p2p', receive_id_type: 'union_id', receive_id: 'on_xxx' },
      'hello',
    )
    expect(result).toBe(false)
  })

  it('replyContentType=post 时使用 post 格式', async () => {
    mockDbGet.mockReturnValue(
      makeAgent({
        publishChannels: ['api', 'feishu'],
        feishuConfig: { ...BASE_CONFIG, replyContentType: 'post' },
      }),
    )
    const result = await sendFeishuMessageByContext(
      'agt_001',
      { chat_type: 'p2p', receive_id_type: 'union_id', receive_id: 'on_xxx' },
      'hello',
    )
    expect(result).toBe(true)
    const call = mockImMessageCreate.mock.calls[0]
    expect(call[0].data.msg_type).toBe('post')
    expect(JSON.parse(call[0].data.content).zh_cn.content).toEqual([[{ tag: 'md', text: 'hello' }]])
  })

  it('replyContentType=interactive 时使用 interactive 格式', async () => {
    mockDbGet.mockReturnValue(
      makeAgent({
        publishChannels: ['api', 'feishu'],
        feishuConfig: {
          ...BASE_CONFIG,
          replyContentType: 'interactive',
          cardTemplateId: 'ctpl_123',
        },
      }),
    )
    const result = await sendFeishuMessageByContext(
      'agt_001',
      { chat_type: 'p2p', receive_id_type: 'union_id', receive_id: 'on_xxx' },
      'hello',
    )
    expect(result).toBe(true)
    const call = mockImMessageCreate.mock.calls[0]
    expect(call[0].data.msg_type).toBe('interactive')
    const content = JSON.parse(call[0].data.content)
    expect(content.type).toBe('template')
    expect(content.data.template_id).toBe('ctpl_123')
    expect(content.data.template_variable.content).toBe('hello')
  })

  it('replyContentType=streaming_card 时回退为 post', async () => {
    mockDbGet.mockReturnValue(
      makeAgent({
        publishChannels: ['api', 'feishu'],
        feishuConfig: { ...BASE_CONFIG, replyContentType: 'streaming_card' },
      }),
    )
    const result = await sendFeishuMessageByContext(
      'agt_001',
      { chat_type: 'p2p', receive_id_type: 'union_id', receive_id: 'on_xxx' },
      'hello',
    )
    expect(result).toBe(true)
    const call = mockImMessageCreate.mock.calls[0]
    expect(call[0].data.msg_type).toBe('post')
  })
})

// ── buildFeishuReplyContent ─────────────────────────────────────────────────

describe('buildFeishuReplyContent', () => {
  it('text 返回 text 格式', () => {
    const { msgType, replyContent } = buildFeishuReplyContent('hi', 'text')
    expect(msgType).toBe('text')
    expect(JSON.parse(replyContent).text).toBe('hi')
  })

  it('post 返回 post 格式', () => {
    const { msgType, replyContent } = buildFeishuReplyContent('hi', 'post')
    expect(msgType).toBe('post')
    expect(JSON.parse(replyContent).zh_cn.content).toEqual([[{ tag: 'md', text: 'hi' }]])
  })

  it('interactive 返回 template 结构', () => {
    const { msgType, replyContent } = buildFeishuReplyContent('hi', 'interactive', 'ctpl_1')
    expect(msgType).toBe('interactive')
    const c = JSON.parse(replyContent)
    expect(c.type).toBe('template')
    expect(c.data.template_id).toBe('ctpl_1')
    expect(c.data.template_variable.content).toBe('hi')
  })

  it('streaming_card 回退为 post', () => {
    const { msgType } = buildFeishuReplyContent('hi', 'streaming_card')
    expect(msgType).toBe('post')
  })

  it('interactive_card 把普通回复包成纯文本卡片 JSON 2.0', () => {
    const { msgType, replyContent } = buildFeishuReplyContent('你好呀', 'interactive_card')
    expect(msgType).toBe('interactive')
    const card = JSON.parse(replyContent)
    expect(card.schema).toBe('2.0')
    expect(card.body.elements[0]).toEqual({ tag: 'markdown', content: '你好呀' })
    // 无交互组件
    expect(replyContent).not.toContain('"tag":"button"')
    expect(replyContent).not.toContain('"tag":"form"')
  })

  it('interactive_card 带 cardStyle 时渲染彩色标题栏', () => {
    const { replyContent } = buildFeishuReplyContent('你好呀', 'interactive_card', undefined, {
      title: '栗子老师',
    })
    const card = JSON.parse(replyContent)
    expect(card.header.title.content).toBe('栗子老师')
    expect(card.header.template).toBe('blue')
  })
})

// ── buildDebugInfoSuffix ────────────────────────────────────────────────────

describe('buildDebugInfoSuffix', () => {
  it('returns empty string when nothing selected', () => {
    expect(
      buildDebugInfoSuffix({ showSessionId: false, showProvider: false, showModel: false }),
    ).toBe('')
  })

  it('appends only the selected fields as a markdown footer', () => {
    const suffix = buildDebugInfoSuffix({
      showSessionId: true,
      showProvider: false,
      showModel: true,
      sessionId: 'chat_123',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
    })
    expect(suffix.startsWith('\n\n---\n')).toBe(true)
    expect(suffix).toContain('🐞 调试信息')
    expect(suffix).toContain('- 会话 ID：chat_123')
    expect(suffix).toContain('- 模型：claude-opus-4-8')
    expect(suffix).not.toContain('Provider')
  })

  it('falls back to em dash when a selected value is missing', () => {
    const suffix = buildDebugInfoSuffix({
      showSessionId: true,
      showProvider: true,
      showModel: false,
      sessionId: undefined,
      providerName: null,
    })
    expect(suffix).toContain('- 会话 ID：—')
    expect(suffix).toContain('- Provider：—')
  })
})

// ── buildFeishuFallbackText ─────────────────────────────────────────────────

describe('buildFeishuFallbackText', () => {
  it('包含 run_id 以便运维定位，且不暴露原始错误', () => {
    const text = buildFeishuFallbackText('run_GmaVtZ')
    expect(text).toContain('run_id=run_GmaVtZ')
    expect(text).toContain('未返回有效内容')
  })
})

// ── textToPostContent ───────────────────────────────────────────

describe('textToPostContent', () => {
  it('非表格纯文本转为 md 节点，保留原始 Markdown 能力', () => {
    const result = JSON.parse(textToPostContent('hello\nworld'))
    expect(result.zh_cn.title).toBe('')
    expect(result.zh_cn.content).toEqual([[{ tag: 'md', text: 'hello\nworld' }]])
  })

  it('已有合法 post JSON 时直接透传', () => {
    const postJson = JSON.stringify({
      zh_cn: { title: '标题', content: [[{ tag: 'text', text: 'ok' }]] },
    })
    expect(textToPostContent(postJson)).toBe(postJson)
  })

  it('en_us 结构也直接透传', () => {
    const postJson = JSON.stringify({ en_us: { title: 'Title', content: [] } })
    expect(textToPostContent(postJson)).toBe(postJson)
  })

  it('JSON 但无 locale key 时仍做转换', () => {
    const input = JSON.stringify({ foo: 'bar' })
    const result = JSON.parse(textToPostContent(input))
    expect(result.zh_cn).toBeDefined()
    expect(result.zh_cn.content).toEqual([[{ tag: 'md', text: input }]])
  })

  it('普通段落中的行内 Markdown 会保留给 md 节点处理', () => {
    const markdown =
      '根据数据库查询，**demo 国内移动收银台**在 UAT 环境（`plutomall_uat`）的配置如下。'
    const result = JSON.parse(textToPostContent(markdown))

    expect(result.zh_cn.content).toEqual([[{ tag: 'md', text: markdown }]])
  })

  it('Markdown 表格会保留表头和数据行，不丢失单元格内容', () => {
    const markdown = [
      '## 配置详情',
      '',
      '| 字段 | 值 |',
      '|------|-----|',
      '| game_id | 10061 |',
      '| game_name | sdkdemo |',
    ].join('\n')

    const result = JSON.parse(textToPostContent(markdown))

    expect(result.zh_cn.content).toContainEqual([{ tag: 'md', text: '## 配置详情' }])
    expect(result.zh_cn.content).toContainEqual([
      { tag: 'text', text: '字段', style: ['bold'] },
      { tag: 'text', text: ' | ' },
      { tag: 'text', text: '值', style: ['bold'] },
    ])
    expect(result.zh_cn.content).toContainEqual([
      { tag: 'text', text: 'game_id' },
      { tag: 'text', text: ' | ' },
      { tag: 'text', text: '10061' },
    ])
    expect(result.zh_cn.content).toContainEqual([
      { tag: 'text', text: 'game_name' },
      { tag: 'text', text: ' | ' },
      { tag: 'text', text: 'sdkdemo' },
    ])
  })
})

// ── sendArtifactFiles ────────────────────────────────────────────

describe('sendArtifactFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbWriteRun.mockReturnValue({ changes: 1 })
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockImFileCreate.mockResolvedValue({ file_key: 'fk_test' })
    mockImMessageCreate.mockResolvedValue({})
  })

  it('uploads file and sends file message for each artifact', async () => {
    const client = new (await import('@larksuiteoapi/node-sdk')).Client({
      appId: 'a',
      appSecret: 'b',
    })
    const artifacts = [
      { id: 'art_1', filename: 'doc.pdf', storagePath: '/tmp/doc.pdf' },
      { id: 'art_2', filename: 'img.png', storagePath: '/tmp/img.png' },
    ]

    await sendArtifactFiles(client, artifacts, 'oc_chat_001')

    expect(mockImFileCreate).toHaveBeenCalledTimes(2)
    expect(mockImMessageCreate).toHaveBeenCalledTimes(2)
    for (const call of mockImMessageCreate.mock.calls) {
      expect(call[0].data.msg_type).toBe('file')
      expect(call[0].data.receive_id).toBe('oc_chat_001')
    }
  })

  it('skips file larger than 30MB', async () => {
    const { statSync } = await import('node:fs')
    ;(statSync as any).mockReturnValueOnce({ size: 31 * 1024 * 1024 })

    const client = new (await import('@larksuiteoapi/node-sdk')).Client({
      appId: 'a',
      appSecret: 'b',
    })
    await sendArtifactFiles(
      client,
      [{ id: 'art_big', filename: 'huge.zip', storagePath: '/tmp/huge.zip' }],
      'oc_chat',
    )

    expect(mockImFileCreate).not.toHaveBeenCalled()
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('continues to next artifact when one fails', async () => {
    mockImFileCreate
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValueOnce({ file_key: 'fk_ok' })

    const client = new (await import('@larksuiteoapi/node-sdk')).Client({
      appId: 'a',
      appSecret: 'b',
    })
    const artifacts = [
      { id: 'art_fail', filename: 'fail.pdf', storagePath: '/tmp/fail.pdf' },
      { id: 'art_ok', filename: 'ok.pdf', storagePath: '/tmp/ok.pdf' },
    ]

    await sendArtifactFiles(client, artifacts, 'oc_chat')

    expect(mockImFileCreate).toHaveBeenCalledTimes(2)
    expect(mockImMessageCreate).toHaveBeenCalledTimes(1)
  })
})

// ── FeishuConnectionManager lifecycle ───────────────────────────

describe('FeishuConnectionManager lifecycle', () => {
  beforeEach(() => {
    // stopAll BEFORE clearAllMocks，避免 stopAll 产生的 close 调用影响断言
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
  })

  it('start() 调用 WSClient.start()', async () => {
    await feishuConnectionManager.start('agt_001', BASE_CONFIG)
    expect(mockWsClientStart).toHaveBeenCalledOnce()
  })

  it('同一 agentId 重复 start() 时先 close 旧连接再建新连接', async () => {
    await feishuConnectionManager.start('agt_001', BASE_CONFIG)
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    await feishuConnectionManager.start('agt_001', BASE_CONFIG)
    expect(mockWsClientClose).toHaveBeenCalledOnce()
    expect(mockWsClientStart).toHaveBeenCalledOnce()
  })

  it('stop() 调用 wsClient.close()', async () => {
    await feishuConnectionManager.start('agt_001', BASE_CONFIG)
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    feishuConnectionManager.stop('agt_001')
    expect(mockWsClientClose).toHaveBeenCalledOnce()
  })

  it('stop() 对不存在的 agentId 为空操作', () => {
    expect(() => feishuConnectionManager.stop('nonexistent')).not.toThrow()
    expect(mockWsClientClose).not.toHaveBeenCalled()
  })

  it('stopAll() 关闭所有连接', async () => {
    await feishuConnectionManager.start('agt_001', BASE_CONFIG)
    await feishuConnectionManager.start('agt_002', { ...BASE_CONFIG, appId: 'cli_other_app' })
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    feishuConnectionManager.stopAll()
    expect(mockWsClientClose).toHaveBeenCalledTimes(2)
  })

  it('appId 为空时跳过连接', async () => {
    await feishuConnectionManager.start('agt_001', { ...BASE_CONFIG, appId: '' })
    expect(mockWsClientStart).not.toHaveBeenCalled()
  })

  it('appSecret 为空时跳过连接', async () => {
    await feishuConnectionManager.start('agt_001', { ...BASE_CONFIG, appSecret: '' })
    expect(mockWsClientStart).not.toHaveBeenCalled()
  })

  it('getFeishuConnectionStatuses 首轮轮询后反映底层 socket 已打开', async () => {
    await feishuConnectionManager.start('agt_001', BASE_CONFIG)
    const st = feishuConnectionManager.getFeishuConnectionStatuses()
    expect(st).toEqual([{ agentId: 'agt_001', socketOpen: true }])
  })

  it('同一 appId 不同 agent 时第二个 start 拒绝且不调用 WSClient.start', async () => {
    await feishuConnectionManager.start('agt_a', BASE_CONFIG)
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    await feishuConnectionManager.start('agt_b', BASE_CONFIG)
    expect(mockWsClientStart).not.toHaveBeenCalled()
    expect(feishuConnectionManager.isRegistered('agt_b')).toBe(false)
    expect(feishuConnectionManager.isRegistered('agt_a')).toBe(true)
  })

  it('先占者 stop 后另一 agent 可 start 同 appId', async () => {
    await feishuConnectionManager.start('agt_a', BASE_CONFIG)
    feishuConnectionManager.stop('agt_a')
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    await feishuConnectionManager.start('agt_b', BASE_CONFIG)
    expect(mockWsClientStart).toHaveBeenCalledOnce()
    expect(feishuConnectionManager.isRegistered('agt_b')).toBe(true)
  })

  it('占线时后启动的 agent 无法连上同一 appId', async () => {
    await feishuConnectionManager.start('agt_b', BASE_CONFIG)
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    await feishuConnectionManager.start('agt_a', BASE_CONFIG)
    expect(mockWsClientStart).not.toHaveBeenCalled()
    expect(feishuConnectionManager.isRegistered('agt_a')).toBe(false)
    expect(feishuConnectionManager.getExclusiveSlotHolder(BASE_CONFIG.appId)).toBe('agt_b')
  })
})

// ── handleMessage via captured dispatcher ────────────────────────

describe('handleMessage via dispatcher', () => {
  beforeEach(async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    vi.stubEnv('A2WAVE_AGENT_HOMES_DIR', '/agent-homes')
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o' })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'Agent 回复' },
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
    // After start(), capturedDispatchers['im.message.receive_v1'] is populated
  })

  async function dispatch(
    data: any,
    options: {
      extraPlugins?: readonly LifecyclePlugin[]
      config?: FeishuConfig
    } = {},
  ) {
    const extraPlugins = options.extraPlugins ?? []
    if (extraPlugins.length > 0) {
      const sdk = await import('@larksuiteoapi/node-sdk')
      const client = new sdk.Client({
        appId: options.config?.appId ?? BASE_CONFIG.appId,
        appSecret: options.config?.appSecret ?? BASE_CONFIG.appSecret,
      })
      await feishuConnectionManager.injectE2eMessage(
        'agt_001',
        client,
        options.config ?? BASE_CONFIG,
        data,
        { botOpenId: 'ou_bot_test', extraPlugins },
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      return
    }

    const handler = capturedDispatchers['im.message.receive_v1']
    if (!handler) throw new Error('Dispatcher handler not captured')
    handler(data)
    // handleMessage is fire-and-forget (returns void) in the real handler.
    // Yield repeatedly: every DB read inside it is awaited now, so the chain of
    // continuations is far longer than one macrotask turn. A single setImmediate
    // used to be enough and silently stopped being so, leaving assertions to run
    // before the handler had reached them.
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  // ── 触发过滤 ──────────────────────────────────────────────────

  it('file 消息缺少 file_key 时提示用户且不执行', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_type: 'file', content: '{}' }))
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(mockImMessageReply).toHaveBeenCalled()
    const tipCall = mockImMessageReply.mock.calls.find((c) => {
      const t = JSON.parse(c[0].data.content).text as string
      return t.includes('无法识别')
    })
    expect(tipCall).toBeDefined()
  })

  it('群聊无 @mention 且 groupTriggerOnAt=true 时不触发', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'group', mentions: [] }))
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('群聊 @机器人 且 groupTriggerOnAt=true → 触发 agent 执行', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(
      makeData({
        chat_type: 'group',
        message_id: 'om_at1',
        // FakeClient.request 返回 botOpenId='ou_bot_test'，需匹配 open_id
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        content: JSON.stringify({ text: '@_user_1 查代码' }),
      }),
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
  })

  it('groupTriggerOnNewMessage=true 时群聊任意消息均触发', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockExecuteWithRetry.mockResolvedValue({ result: { success: true, output: 'ok' }, retries: [] })
    mockImMessageReply.mockResolvedValue({})
    await feishuConnectionManager.start('agt_001', {
      ...BASE_CONFIG,
      groupTriggerOnNewMessage: true,
    })
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(
      makeData({
        chat_type: 'group',
        message_id: 'om_new_msg1',
        mentions: [],
        thread_id: undefined,
      }),
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
  })

  it('P2P 消息始终触发（无需 @mention）', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_p2p1', mentions: [] }))
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
  })

  it('消息触发后立即在用户消息上添加 Get reaction', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_react1' }))
    expect(mockImMessageReactionCreate).toHaveBeenCalledOnce()
    const call = mockImMessageReactionCreate.mock.calls[0][0]
    expect(call.path.message_id).toBe('om_react1')
    expect(call.data.reaction_type.emoji_type).toBe('Get')
  })

  it('@mention 去除后文本为空时不触发', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(
      makeData({
        chat_type: 'group',
        mentions: [{ key: '@_user_1' }],
        content: JSON.stringify({ text: '@_user_1 ' }),
      }),
    )
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  // ── 去重（dedup） ─────────────────────────────────────────────

  it('同一 agentId 收到相同 message_id 两次：第二次去重跳过', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_dedup1' }))
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_dedup1' }))
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
  })

  it('不同 agentId 收到相同 message_id：各自独立处理，不互相去重', async () => {
    // agt_001 已在 beforeEach 中 start。必须先保存它的 handler，
    // 再 start agt_002——因为 start() 会覆盖 capturedDispatchers。
    const handler1 = capturedDispatchers['im.message.receive_v1']
    if (!handler1) throw new Error('handler1 not captured')

    // 用不同 appId 避免 appId 独占冲突
    const config2 = { ...BASE_CONFIG, appId: 'cli_agent2' }
    await feishuConnectionManager.start('agt_002', config2)
    // 此时 capturedDispatchers 已被 agt_002 的 handler 覆盖
    const handler2 = capturedDispatchers['im.message.receive_v1']

    mockDbGet.mockReturnValue(makeAgent())

    // 同一条 message_id 分别投递给两个 agent 的 dispatcher
    handler1(makeData({ chat_type: 'p2p', message_id: 'om_cross_agent' }))
    handler2(makeData({ chat_type: 'p2p', message_id: 'om_cross_agent' }))
    await new Promise<void>((resolve) => setImmediate(resolve))

    // 两个 agent 各自去重隔离，应各执行一次，共 2 次
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2)
  })

  // ── agent 状态检查 ────────────────────────────────────────────

  it('agent 未发布（stopped）时不触发', async () => {
    mockDbGet.mockReturnValue(makeAgent({ publishStatus: 'stopped' }))
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_empty_output' }))
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  it('agent 不存在时不触发', async () => {
    mockDbGet.mockReturnValue(undefined)
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_empty_output' }))
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
  })

  // ── 队列满 ────────────────────────────────────────────────────

  it('队列满时删除 run 记录并放弃执行', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockTryAcquireSlot.mockReturnValue('queue_full')
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_qfull1' }))
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(mockResolveWorkDir).not.toHaveBeenCalled()
    expect(mockDbDeleteRun).toHaveBeenCalled()
  })

  it('标准回复路径执行抛错时会调用 finishRunError 收敛状态', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockExecuteWithRetry.mockRejectedValueOnce(new Error('worker boom'))

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_exec_err1' }))

    expect(mockFinishRunError).toHaveBeenCalledTimes(1)
    expect(mockFinishRunSuccess).not.toHaveBeenCalled()
  })

  // ── 回复方式 ─────────────────────────────────────────────────

  it('replyMode=quote 时调用 message.reply 并带正确参数', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_q1' }))
    expect(mockImMessageReply).toHaveBeenCalledOnce()
    expect(mockImMessageCreate).not.toHaveBeenCalled()
    const call = mockImMessageReply.mock.calls[0][0]
    expect(call.path.message_id).toBe('om_q1')
    expect(call.data.msg_type).toBe('text')
    expect(JSON.parse(call.data.content)).toEqual({ text: 'Agent 回复' })
  })

  it('replyMode=new 时调用 message.create 并带正确参数', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'Agent 回复' },
      retries: [],
    })
    mockImMessageCreate.mockResolvedValue({})
    await feishuConnectionManager.start('agt_001', { ...BASE_CONFIG, p2pReplyMode: 'new' })
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_new1', chat_id: 'oc_chat999' }))
    expect(mockImMessageCreate).toHaveBeenCalledOnce()
    expect(mockImMessageReply).not.toHaveBeenCalled()
    const call = mockImMessageCreate.mock.calls[0][0]
    expect(call.params.receive_id_type).toBe('chat_id')
    expect(call.data.receive_id).toBe('oc_chat999')
    expect(call.data.msg_type).toBe('text')
  })

  it('空输出时发送兜底回复（含 run_id）而非静默跳过', async () => {
    // The feishu-empty-reply bug: a completed run with empty output left the
    // group with no message at all. Now a fallback reply must be sent.
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: '' },
      retries: [],
    })
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_empty1' }))

    expect(mockImMessageReply).toHaveBeenCalledOnce()
    const call = mockImMessageReply.mock.calls[0][0]
    const content = JSON.parse(call.data.content)
    expect(content.text).toContain('未返回有效内容')
    expect(content.text).toContain('run_id')
  })

  it('纯空白输出也走兜底（trim 后为空），不发出空白回复', async () => {
    // M1: emptiness check must trim — "   " is not a usable reply.
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: '   \n  ' },
      retries: [],
    })
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_ws1' }))

    expect(mockImMessageReply).toHaveBeenCalledOnce()
    const content = JSON.parse(mockImMessageReply.mock.calls[0][0].data.content)
    expect(content.text).toContain('未返回有效内容')
    expect(content.text).not.toBe('   \n  ')
  })

  it('空输出且 replyMode=none 时不发送兜底回复', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o' })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockFinishRunSuccess.mockResolvedValue([])
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: '' },
      retries: [],
    })
    await feishuConnectionManager.start('agt_001', { ...BASE_CONFIG, p2pReplyMode: 'none' })
    mockDbGet.mockReturnValue(makeAgent({ feishuConfig: { ...BASE_CONFIG, p2pReplyMode: 'none' } }))
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_empty_none' }))

    expect(mockImMessageReply).not.toHaveBeenCalled()
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('空输出 + replyMode=none + 有产物：产物也不推送（不绕过 none 静默）', async () => {
    // Regression: the empty-output branch used to send artifact files even when
    // replyMode='none', leaking attachments past the silence gate. Must mirror
    // the success path which returns on 'none' before sending anything.
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o' })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({ result: { success: true, output: '' }, retries: [] })
    // Agent DID produce a downloadable artifact, and sendArtifactsAsFile is on.
    mockFinishRunSuccess.mockResolvedValue([
      { id: 'art_none', filename: 'leak.pdf', storagePath: '/tmp/leak.pdf' },
    ])
    const noneCfg = { ...BASE_CONFIG, p2pReplyMode: 'none' as const, sendArtifactsAsFile: true }
    await feishuConnectionManager.start('agt_001', noneCfg)
    mockDbGet.mockReturnValue(makeAgent({ feishuConfig: noneCfg }))
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_empty_none_art' }))

    expect(mockImMessageReply).not.toHaveBeenCalled()
    expect(mockImMessageCreate).not.toHaveBeenCalled()
    // The artifact file upload/send must NOT fire under replyMode='none'.
    expect(mockImFileCreate).not.toHaveBeenCalled()
  })

  // ── 产物链接使用 getArtifactDownloadUrl ───────────────────────────────────

  it('sendArtifactsAsFile=false 时产物以下载链接形式附在文本回复中', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'Agent 回复' },
      retries: [],
    })
    mockImMessageReply.mockResolvedValue({})
    await feishuConnectionManager.start('agt_001', { ...BASE_CONFIG, sendArtifactsAsFile: false })
    mockDbGet.mockReturnValue(makeAgent())
    mockFinishRunSuccess.mockResolvedValue([
      { id: 'art_feishu1', filename: 'report.pdf', storagePath: '/tmp/report.pdf' },
    ])
    mockGetArtifactDownloadUrl.mockImplementation(
      (id: string) => `https://feishu.example.com/api/artifacts/${id}/download`,
    )

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_art1' }))

    expect(mockImMessageReply).toHaveBeenCalledOnce()
    const call = mockImMessageReply.mock.calls[0][0]
    const content = JSON.parse(call.data.content)
    expect(content.text).toContain('https://feishu.example.com/api/artifacts/art_feishu1/download')
    expect(mockImFileCreate).not.toHaveBeenCalled()
  })

  it('sendArtifactsAsFile 默认开启时，文本回复不含下载链接，产物通过文件消息发送', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockFinishRunSuccess.mockResolvedValue([
      { id: 'art_f1', filename: 'result.xlsx', storagePath: '/tmp/result.xlsx' },
    ])
    mockImFileCreate.mockResolvedValue({ file_key: 'fk_001' })

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_art_file1' }))

    // Text reply should NOT contain download links
    expect(mockImMessageReply).toHaveBeenCalledOnce()
    const replyCall = mockImMessageReply.mock.calls[0][0]
    const textContent = JSON.parse(replyCall.data.content)
    expect(textContent.text).toBe('Agent 回复')
    expect(textContent.text).not.toContain('产物下载')

    // File should be uploaded and sent
    expect(mockImFileCreate).toHaveBeenCalledOnce()
    expect(mockImMessageCreate).toHaveBeenCalledOnce()
    const fileCall = mockImMessageCreate.mock.calls[0][0]
    expect(fileCall.data.msg_type).toBe('file')
    expect(JSON.parse(fileCall.data.content)).toEqual({ file_key: 'fk_001' })
  })

  // ── replyMode: none ───────────────────────────────────────────

  it('replyMode=none 时不调用 reply 也不调用 create', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'Agent 回复' },
      retries: [],
    })
    await feishuConnectionManager.start('agt_001', { ...BASE_CONFIG, groupReplyMode: 'none' })
    mockDbGet.mockReturnValue(
      makeAgent({ feishuConfig: { ...BASE_CONFIG, groupReplyMode: 'none' } }),
    )
    await dispatch(makeData({ chat_type: 'p2p' }))
    expect(mockImMessageReply).not.toHaveBeenCalled()
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  // ── replyContentType ─────────────────────────────────────────

  it('replyContentType=post 时，agent 输出合法 post JSON 则透传', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    const postOutput = JSON.stringify({ zh_cn: { title: '标题', content: [] } })
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: postOutput },
      retries: [],
    })
    mockImMessageReply.mockResolvedValue({})
    await feishuConnectionManager.start('agt_001', { ...BASE_CONFIG, replyContentType: 'post' })
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_post1' }))
    expect(mockImMessageReply).toHaveBeenCalledOnce()
    const call = mockImMessageReply.mock.calls[0][0]
    expect(call.data.msg_type).toBe('post')
    expect(call.data.content).toBe(postOutput)
  })

  it('replyContentType=post 时，agent 输出纯文本则自动转为 post JSON', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: '第一行\n第二行' },
      retries: [],
    })
    mockImMessageReply.mockResolvedValue({})
    await feishuConnectionManager.start('agt_001', { ...BASE_CONFIG, replyContentType: 'post' })
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_post_plain' }))
    expect(mockImMessageReply).toHaveBeenCalledOnce()
    const call = mockImMessageReply.mock.calls[0][0]
    expect(call.data.msg_type).toBe('post')
    const parsed = JSON.parse(call.data.content)
    expect(parsed.zh_cn.content).toEqual([[{ tag: 'md', text: '第一行\n第二行' }]])
  })

  it('replyContentType=interactive 时 msg_type 为 interactive，content 包含 template 结构', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'Agent 回复内容' },
      retries: [],
    })
    mockImMessageReply.mockResolvedValue({})
    await feishuConnectionManager.start('agt_001', {
      ...BASE_CONFIG,
      replyContentType: 'interactive',
      cardTemplateId: 'tpl_abc123',
    })
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_int1' }))
    expect(mockImMessageReply).toHaveBeenCalledOnce()
    const call = mockImMessageReply.mock.calls[0][0]
    expect(call.data.msg_type).toBe('interactive')
    const content = JSON.parse(call.data.content)
    expect(content.type).toBe('template')
    expect(content.data.template_id).toBe('tpl_abc123')
    expect(content.data.template_variable.content).toBe('Agent 回复内容')
  })

  it('replyMode=new + replyContentType=interactive 时调用 create', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: '回复' },
      retries: [],
    })
    mockImMessageCreate.mockResolvedValue({})
    await feishuConnectionManager.start('agt_001', {
      ...BASE_CONFIG,
      p2pReplyMode: 'new',
      replyContentType: 'interactive',
      cardTemplateId: 'tpl_xyz',
    })
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(makeData({ chat_type: 'p2p', chat_id: 'oc_chat_int', message_id: 'om_int2' }))
    expect(mockImMessageCreate).toHaveBeenCalledOnce()
    expect(mockImMessageReply).not.toHaveBeenCalled()
    const call = mockImMessageCreate.mock.calls[0][0]
    expect(call.data.msg_type).toBe('interactive')
    const content = JSON.parse(call.data.content)
    expect(content.data.template_id).toBe('tpl_xyz')
    expect(content.data.template_variable.content).toBe('回复')
  })

  // ── 执行结果 ─────────────────────────────────────────────────

  it('执行失败时发送 run_id 兜底回复，且不暴露原始引擎错误', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: false, error: 'timeout' },
      retries: [],
    })
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_execution_failure' }))
    expect(mockImMessageReply).toHaveBeenCalledOnce()
    expect(mockImMessageCreate).not.toHaveBeenCalled()
    const content = JSON.parse(mockImMessageReply.mock.calls[0][0].data.content)
    // 方案2：统一兜底文案 + run_id，不把原始 'timeout' 透传给群里。
    expect(content.text).toContain('未返回有效内容')
    expect(content.text).toContain('run_id')
    expect(content.text).not.toContain('timeout')
  })

  it('resolves the current SCM workspace only after the run acquires its execution slot', async () => {
    const currentAgent = makeAgent({ workspaceType: 'scm', scmSourceId: 'scm_current' })
    mockDbGet.mockReturnValue(currentAgent)

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_fresh_workspace' }))

    // The 4th argument is the agentEnv resolveWorkDir owns A2WAVE_WORKSPACE_BRANCH
    // in; buildAgentConfig is mocked here, so it arrives undefined.
    expect(mockResolveWorkDir).toHaveBeenCalledWith(currentAgent, undefined, 'run_test', undefined)
    expect(mockResolveWorkDir.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockTryAcquireSlot.mock.invocationCallOrder[0],
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      'feishu/run_test/rst_test',
      expect.objectContaining({ workDir: '/tmp/workdir' }),
      expect.anything(),
    )
  })

  it('output 为空且没有 onBeforeReply patch 时发送 run_id 兜底回复', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockExecuteWithRetry.mockResolvedValue({ result: { success: true, output: '' }, retries: [] })
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_empty_output_result' }))
    expect(mockImMessageReply).toHaveBeenCalledOnce()
    const content = JSON.parse(mockImMessageReply.mock.calls[0][0].data.content)
    expect(content.text).toContain('未返回有效内容')
    expect(content.text).toContain('run_id')
  })

  it('onBeforeReply patch 后，Feishu 实际发送 patched text 而不是原 output', async () => {
    const plugin: LifecyclePlugin = {
      name: 'obs:patch-reply',
      onBeforeReply: () => ({ patch: { text: 'patched reply' } }),
    }
    mockDbGet.mockReturnValue(makeAgent())
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'original reply' },
      retries: [],
    })

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_patch_reply' }), {
      extraPlugins: [plugin],
    })

    expect(mockImMessageReply).toHaveBeenCalledOnce()
    const content = JSON.parse(mockImMessageReply.mock.calls[0][0].data.content)
    expect(content.text).toBe('patched reply')
  })

  it('result.output 为空但 onBeforeReply patch 出文本时，不走失败回复', async () => {
    const plugin: LifecyclePlugin = {
      name: 'obs:patch-empty',
      onBeforeReply: () => ({ patch: { text: 'summary from stream' } }),
    }
    mockDbGet.mockReturnValue(makeAgent())
    mockExecuteWithRetry.mockResolvedValue({ result: { success: true, output: '' }, retries: [] })

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_patch_empty' }), {
      extraPlugins: [plugin],
    })

    expect(mockImMessageReply).toHaveBeenCalledOnce()
    const content = JSON.parse(mockImMessageReply.mock.calls[0][0].data.content)
    expect(content.text).toBe('summary from stream')
    expect(content.text).not.toContain('执行失败')
  })

  it('onAfterReply fires after a successful standard reply', async () => {
    const onAfterReply = vi.fn()
    const plugin: LifecyclePlugin = { name: 'obs:after-reply', onAfterReply }
    mockDbGet.mockReturnValue(makeAgent())

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_after_reply' }), {
      extraPlugins: [plugin],
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(mockImMessageReply).toHaveBeenCalledOnce()
    expect(onAfterReply).toHaveBeenCalledOnce()
  })

  it('onBeforeRun abort uses the abort finalizer and emits terminal hooks', async () => {
    const onAfterRun = vi.fn()
    const onRunFailed = vi.fn()
    const plugin: LifecyclePlugin = {
      name: 'obs:abort-before-run',
      onBeforeRun: () => ({ abort: { reason: 'blocked before run', code: 'blocked' } }),
      onAfterRun,
      onRunFailed,
    }
    mockDbGet.mockReturnValue(makeAgent())

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_abort_before_run' }), {
      extraPlugins: [plugin],
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(mockFinishRunError).not.toHaveBeenCalled()
    expect(mockFinishRunAborted).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agt_001',
        runId: 'run_test',
        stepId: 'rst_test',
        workDir: '/tmp/workdir',
      }),
      'blocked before run',
    )
    expect(onAfterRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_test', taskId: 'feishu/run_test/rst_test' }),
      expect.objectContaining({ success: false, error: 'blocked before run' }),
    )
    expect(onRunFailed).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_test', taskId: 'feishu/run_test/rst_test' }),
      expect.objectContaining({ success: false, error: 'blocked before run' }),
    )
    const userNotice = mockImMessageReply.mock.calls.find((c) => {
      try {
        const text = JSON.parse(c[0].data.content).text as string
        return text.includes('blocked before run')
      } catch {
        return false
      }
    })
    expect(userNotice).toBeDefined()
  })

  it('onBeforeRun abort notification failure does not re-enter finishRunError', async () => {
    const plugin: LifecyclePlugin = {
      name: 'obs:abort-notification-fails',
      onBeforeRun: () => ({ abort: { reason: 'blocked before run', code: 'blocked' } }),
    }
    mockDbGet.mockReturnValue(makeAgent())
    mockImMessageReply.mockRejectedValueOnce(new Error('notification boom'))

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_abort_notice_fail' }), {
      extraPlugins: [plugin],
    })

    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(mockFinishRunError).not.toHaveBeenCalled()
    expect(mockFinishRunAborted).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_001', runId: 'run_test', stepId: 'rst_test' }),
      'blocked before run',
    )
    expect(mockImMessageReply).toHaveBeenCalledOnce()
  })

  // ── context 注入 ─────────────────────────────────────────────

  it('executeInWorker 收到统一 channel 形态的飞书 context', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(
      makeData(
        { chat_type: 'p2p', message_id: 'om_x', chat_id: 'oc_y', thread_id: 'th_z' },
        { sender_type: 'user', sender_id: { open_id: 'ou_abc' } },
      ),
    )
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.context.channel.channel_type).toBe('feishu')
    expect(payload.context.channel.channel_info).toMatchObject({
      chat_id: 'oc_y',
      chat_type: 'p2p',
      message_id: 'om_x',
      thread_id: 'th_z',
      sender_type: 'user',
      sender_open_id: 'ou_abc',
    })
    expect(payload.context.channel.user_info).toBeNull()
  })

  it('context 保留扁平 shim（向后兼容；v2 会移除）', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(
      makeData(
        { chat_type: 'p2p', message_id: 'om_shim', chat_id: 'oc_shim', thread_id: 'th_shim' },
        { sender_type: 'user', sender_id: { open_id: 'ou_shim' } },
      ),
    )
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.context).toMatchObject({
      sender_type: 'user',
      sender_id: 'ou_shim',
      message_id: 'om_shim',
      chat_id: 'oc_shim',
      thread_id: 'th_shim',
      chat_type: 'p2p',
    })
  })

  // ── fetchUserInfo 集成 ───────────────────────────────────────

  it('fetchUserInfo=true 时 context 包含 sender_user', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockExecuteWithRetry.mockResolvedValue({ result: { success: true, output: 'ok' }, retries: [] })
    mockImMessageReply.mockResolvedValue({})
    mockImMessageReactionCreate.mockResolvedValue({})
    mockFinishRunSuccess.mockResolvedValue([])
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o' })
    mockResolveWorkDir.mockReturnValue('/tmp/workdir')
    await feishuConnectionManager.start('agt_001', { ...BASE_CONFIG, fetchUserInfo: true })
    // After start() consumed the bot/v3/info request, switch to contact API response for fetchUserInfo
    mockClientRequest.mockResolvedValue({
      data: { user: { name: '李四', email: 'lisi@co.com', open_id: 'ou_sender_ui' } },
    })
    mockDbGet.mockReturnValue(makeAgent({ feishuConfig: { ...BASE_CONFIG, fetchUserInfo: true } }))
    await dispatch(
      makeData(
        { chat_type: 'p2p', message_id: 'om_ui1' },
        { sender_type: 'user', sender_id: { open_id: 'ou_sender_ui' } },
      ),
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.context.channel.user_info).toMatchObject({
      email: 'lisi@co.com',
      name: '李四',
      source: 'feishu',
    })
  })

  it('fetchUserInfo=false（默认）时 channel.user_info 为 null', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(
      makeData(
        { chat_type: 'p2p', message_id: 'om_noui1' },
        { sender_type: 'user', sender_id: { open_id: 'ou_noui' } },
      ),
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.context.channel.user_info).toBeNull()
    expect(payload.context.channel.channel_info.sender_open_id).toBe('ou_noui')
  })

  // ── 图片消息 ─────────────────────────────────────────────────

  it('image 消息类型触发执行，prompt 含图片路径，图片路径在 context.images 中', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockImMessageResourceGet.mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined) })
    await dispatch(
      makeData({
        chat_type: 'p2p',
        message_type: 'image',
        message_id: 'om_img1',
        content: JSON.stringify({ image_key: 'img_abc' }),
      }),
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.prompt).toContain('[图片]')
    expect(payload.prompt).toContain(
      '图片路径：/agent-homes/agt_001/tmp/feishu-images/run_test/test-uuid/img_abc.jpg',
    )
    expect(payload.images).toBeUndefined()
    expect(payload.context.images).toEqual([
      '/agent-homes/agt_001/tmp/feishu-images/run_test/test-uuid/img_abc.jpg',
    ])
  })

  it('mixed 消息类型有文字和图片时，prompt 含文字和图片路径，图片路径在 context.images 中', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockImMessageResourceGet.mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined) })
    await dispatch(
      makeData({
        chat_type: 'p2p',
        message_type: 'mixed',
        message_id: 'om_mixed1',
        content: JSON.stringify({
          elements: [[{ tag: 'text', text: '这是什么' }], [{ tag: 'img', image_key: 'img_mix1' }]],
        }),
      }),
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.prompt).toContain('这是什么')
    expect(payload.prompt).toContain(
      '图片路径：/agent-homes/agt_001/tmp/feishu-images/run_test/test-uuid/img_mix1.jpg',
    )
    expect(payload.context.images).toEqual([
      '/agent-homes/agt_001/tmp/feishu-images/run_test/test-uuid/img_mix1.jpg',
    ])
  })

  it('mixed 消息只有图片无文字时，prompt 含图片路径', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockImMessageResourceGet.mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined) })
    await dispatch(
      makeData({
        chat_type: 'p2p',
        message_type: 'mixed',
        message_id: 'om_mixed2',
        content: JSON.stringify({
          elements: [[{ tag: 'img', image_key: 'img_mix2' }]],
        }),
      }),
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.prompt).toContain('[图片]')
    expect(payload.prompt).toContain(
      '图片路径：/agent-homes/agt_001/tmp/feishu-images/run_test/test-uuid/img_mix2.jpg',
    )
    expect(payload.context.images).toEqual([
      '/agent-homes/agt_001/tmp/feishu-images/run_test/test-uuid/img_mix2.jpg',
    ])
  })

  it('图片下载失败时仍继续执行，context 中无 images', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockImMessageResourceGet.mockRejectedValue(new Error('network error'))
    await dispatch(
      makeData({
        chat_type: 'p2p',
        message_type: 'image',
        message_id: 'om_img_fail',
        content: JSON.stringify({ image_key: 'img_fail' }),
      }),
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.context.images).toBeUndefined()
  })

  // ── 文件消息 ─────────────────────────────────────────────────

  it('file 消息类型触发执行，prompt 含 [文件]，路径在 context.files 中', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockImMessageResourceGet.mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined) })
    const { promises: fsPromises } = await import('node:fs')
    await dispatch(
      makeData({
        chat_type: 'p2p',
        message_type: 'file',
        message_id: 'om_f1',
        content: JSON.stringify({ file_key: 'fk_doc', file_name: 'readme.txt' }),
      }),
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.prompt).toContain('[文件]')
    expect(payload.prompt).toContain('readme.txt')
    expect(payload.prompt).toContain(
      '文件路径：/agent-homes/agt_001/tmp/feishu-files/run_test/test-uuid/readme.txt',
    )
    expect(payload.context.files).toEqual([
      '/agent-homes/agt_001/tmp/feishu-files/run_test/test-uuid/readme.txt',
    ])
    expect(fsPromises.rm).toHaveBeenCalledWith('/agent-homes/agt_001/tmp/feishu-files/run_test', {
      recursive: true,
      force: true,
    })
    expect(fsPromises.rmdir).toHaveBeenCalledWith('/agent-homes/agt_001/tmp/feishu-files')
  })

  it.each([
    ['PDF', 'report.pdf'],
    ['CSV', 'orders.csv'],
  ])('%s 文件消息触发执行时，prompt 含文件名和本地路径', async (_label, fileName) => {
    mockDbGet.mockReturnValue(makeAgent())
    mockImMessageResourceGet.mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined) })
    await dispatch(
      makeData({
        chat_type: 'p2p',
        message_type: 'file',
        message_id: `om_${fileName}`,
        content: JSON.stringify({ file_key: `fk_${fileName}`, file_name: fileName }),
      }),
    )
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    const expectedPath = `/agent-homes/agt_001/tmp/feishu-files/run_test/test-uuid/${fileName}`
    expect(payload.prompt).toContain(`[文件] ${fileName}`)
    expect(payload.prompt).toContain(`文件路径：${expectedPath}`)
    expect(payload.context.files).toEqual([expectedPath])
  })

  it('file 超过大小时提示用户且不创建执行', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockImMessageResourceGet.mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined) })
    const { promises: fsPromises, statSync } = await import('node:fs')
    vi.mocked(statSync).mockReturnValueOnce({ size: FEISHU_MESSAGE_RESOURCE_MAX_BYTES + 1 } as any)
    await dispatch(
      makeData({
        chat_type: 'p2p',
        message_type: 'file',
        message_id: 'om_f_big',
        content: JSON.stringify({ file_key: 'fk_big', file_name: 'huge.bin' }),
      }),
    )
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(mockImMessageReply).toHaveBeenCalled()
    const tip = mockImMessageReply.mock.calls.find((c) =>
      JSON.parse(c[0].data.content).text.includes('30MB'),
    )
    expect(tip).toBeDefined()
    expect(fsPromises.rm).toHaveBeenCalledWith('/agent-homes/agt_001/tmp/feishu-files/run_test', {
      recursive: true,
      force: true,
    })
  })

  it('replyMode=none 时文件超限仍发送提示（create）', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'Agent 回复' },
      retries: [],
    })
    mockImMessageCreate.mockResolvedValue({})
    mockImMessageReply.mockResolvedValue({})
    await feishuConnectionManager.start('agt_001', { ...BASE_CONFIG, p2pReplyMode: 'none' })
    mockDbGet.mockReturnValue(makeAgent({ feishuConfig: { ...BASE_CONFIG, p2pReplyMode: 'none' } }))
    mockImMessageResourceGet.mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined) })
    const { statSync } = await import('node:fs')
    vi.mocked(statSync).mockReturnValueOnce({ size: FEISHU_MESSAGE_RESOURCE_MAX_BYTES + 1 } as any)
    await dispatch(
      makeData({
        chat_type: 'p2p',
        message_type: 'file',
        message_id: 'om_f_none_big',
        content: JSON.stringify({ file_key: 'fk_x', file_name: 'x.bin' }),
      }),
    )
    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(mockImMessageCreate).toHaveBeenCalled()
    const text = JSON.parse(mockImMessageCreate.mock.calls[0][0].data.content).text as string
    expect(text).toContain('30MB')
  })

  // ── 话题（root_id）回复 ───────────────────────────────────────

  it('默认配置：话题回复不拉取根消息，空回复使用占位 intent', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(
      makeData({
        chat_type: 'group',
        message_id: 'om_reply1',
        root_id: 'om_root1',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        content: JSON.stringify({ text: '@_user_1 ' }),
      }),
    )
    expect(mockImMessageGet).not.toHaveBeenCalled()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.prompt).toBe('[话题回复]')
  })

  it('默认配置：话题回复且用户附加了额外文字时，prompt 只包含本次回复文字', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(
      makeData({
        chat_type: 'group',
        message_id: 'om_reply2',
        root_id: 'om_root2',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        content: JSON.stringify({ text: '@_user_1 请帮我处理' }),
      }),
    )
    expect(mockImMessageGet).not.toHaveBeenCalled()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.prompt).toBe('请帮我处理')
  })

  it('root_id 等于 message_id 时不拉取根消息（消息本身就是根消息）', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(
      makeData({
        chat_type: 'p2p',
        message_id: 'om_self',
        root_id: 'om_self',
        content: JSON.stringify({ text: '自身就是根消息' }),
      }),
    )
    expect(mockImMessageGet).not.toHaveBeenCalled()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.prompt).toBe('自身就是根消息')
  })

  it('默认配置：话题回复不因根消息拉取失败受影响', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    await dispatch(
      makeData({
        chat_type: 'group',
        message_id: 'om_reply3',
        root_id: 'om_root3',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        content: JSON.stringify({ text: '@_user_1 降级文字' }),
      }),
    )
    expect(mockImMessageGet).not.toHaveBeenCalled()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.prompt).toBe('降级文字')
  })

  // ── 回复消息中的图片识别 ────────────────────────────────────

  it('话题回复不再提取或下载根消息中的图片', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockImMessageResourceGet.mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined) })
    await dispatch(
      makeData({
        chat_type: 'group',
        message_id: 'om_reply_img1',
        root_id: 'om_root_img1',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        content: JSON.stringify({ text: '@_user_1 这张图是什么' }),
      }),
    )
    expect(mockImMessageGet).not.toHaveBeenCalled()
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.context.images).toBeUndefined()
  })

  it('回复消息和根消息都有图片时，仅当前回复图片出现在 context.images 中', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockImMessageResourceGet.mockResolvedValue({ writeFile: vi.fn().mockResolvedValue(undefined) })
    await dispatch(
      makeData({
        chat_type: 'p2p',
        message_id: 'om_reply_both1',
        root_id: 'om_root_both1',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_from_reply' }),
      }),
    )
    expect(mockImMessageGet).not.toHaveBeenCalled()
    expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
    const payload = mockExecuteWithRetry.mock.calls[0][1]
    expect(payload.prompt).toContain('[图片]')
    expect(payload.prompt).toContain(
      '图片路径：/agent-homes/agt_001/tmp/feishu-images/run_test/test-uuid/img_from_reply.jpg',
    )
    expect(payload.context.images).not.toContainEqual(
      '/agent-homes/agt_001/tmp/feishu-images/run_test/test-uuid/img_from_root.jpg',
    )
    expect(payload.context.images).toContainEqual(
      '/agent-homes/agt_001/tmp/feishu-images/run_test/test-uuid/img_from_reply.jpg',
    )
  })

  // ── streaming_card ─────────────────────────────────────────────

  it('replyContentType=streaming_card 时发送卡片、执行后关闭', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockStreamingCardSend.mockResolvedValue(undefined)
    mockStreamingCardFinish.mockResolvedValue(undefined)
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: '流式结果' },
      retries: [],
    })
    mockImMessageReply.mockResolvedValue({})
    mockImMessageReactionCreate.mockResolvedValue({})
    mockFinishRunSuccess.mockResolvedValue([])
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o', maxRetries: 0 })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    await feishuConnectionManager.start('agt_001', {
      ...BASE_CONFIG,
      replyContentType: 'streaming_card',
    })
    mockDbGet.mockReturnValue(
      makeAgent({
        feishuConfig: { ...BASE_CONFIG, replyContentType: 'streaming_card' },
      }),
    )
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_sc1' }))

    expect(mockStreamingCardSend).toHaveBeenCalledOnce()
    expect(mockStreamingCardUpdateContent).toHaveBeenCalled()
    expect(mockStreamingCardFinish).toHaveBeenCalledOnce()
    // 不应调用普通回复接口
    expect(mockImMessageReply).not.toHaveBeenCalled()
    expect(mockImMessageCreate).not.toHaveBeenCalled()
  })

  it('streaming_card 执行失败时卡片显示错误信息并关闭', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockStreamingCardSend.mockResolvedValue(undefined)
    mockStreamingCardFinish.mockResolvedValue(undefined)
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: false, error: 'timeout' },
      retries: [],
    })
    mockImMessageReactionCreate.mockResolvedValue({})
    mockFinishRunSuccess.mockResolvedValue([])
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o', maxRetries: 0 })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    await feishuConnectionManager.start('agt_001', {
      ...BASE_CONFIG,
      replyContentType: 'streaming_card',
    })
    mockDbGet.mockReturnValue(
      makeAgent({
        feishuConfig: { ...BASE_CONFIG, replyContentType: 'streaming_card' },
      }),
    )
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_sc2' }))

    const lastCall = mockStreamingCardUpdateContent.mock.calls.at(-1)
    // Card now shows the fallback (with a run_id) instead of a bare
    // "执行失败" so the user can locate the run in the backend.
    expect(lastCall?.[0]).toContain('未返回有效内容')
    expect(lastCall?.[0]).toContain('run_id')
    expect(mockStreamingCardFinish).toHaveBeenCalledOnce()
  })

  it('streaming_card 注册 card 到 registry 并在完成后注销', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockStreamingCardSend.mockResolvedValue(undefined)
    mockStreamingCardFinish.mockResolvedValue(undefined)
    mockStreamingCardGetCardId.mockReturnValue('card_reg_test')
    mockExecuteWithRetry.mockResolvedValue({ result: { success: true, output: 'ok' }, retries: [] })
    mockImMessageReactionCreate.mockResolvedValue({})
    mockFinishRunSuccess.mockResolvedValue([])
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o', maxRetries: 0 })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    await feishuConnectionManager.start('agt_001', {
      ...BASE_CONFIG,
      replyContentType: 'streaming_card',
    })
    mockDbGet.mockReturnValue(
      makeAgent({
        feishuConfig: { ...BASE_CONFIG, replyContentType: 'streaming_card' },
      }),
    )
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_sc_reg' }))

    expect(mockRegisterStreamingCard).toHaveBeenCalledWith('card_reg_test', expect.any(Object), {
      showLocalChildOutput: true,
      showRemoteChildOutput: true,
    })
    expect(mockUnregisterStreamingCard).toHaveBeenCalledWith('card_reg_test')
  })

  it('streaming_card 注入 A2WAVE_STREAMING_CARD_ID 到 agentEnv', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockStreamingCardSend.mockResolvedValue(undefined)
    mockStreamingCardFinish.mockResolvedValue(undefined)
    mockStreamingCardGetCardId.mockReturnValue('card_env_test')
    mockExecuteWithRetry.mockResolvedValue({ result: { success: true, output: 'ok' }, retries: [] })
    mockImMessageReactionCreate.mockResolvedValue({})
    mockFinishRunSuccess.mockResolvedValue([])
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o', maxRetries: 0 })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    await feishuConnectionManager.start('agt_001', {
      ...BASE_CONFIG,
      replyContentType: 'streaming_card',
    })
    mockDbGet.mockReturnValue(
      makeAgent({
        feishuConfig: { ...BASE_CONFIG, replyContentType: 'streaming_card' },
      }),
    )
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_sc_env' }))

    // Verify the payload passed to executeInWorker has the streaming card ID in agentConfig.agentEnv
    const call = mockExecuteWithRetry.mock.calls[0]
    const payload = call[1]
    expect(payload.agentConfig.agentEnv).toEqual(
      expect.objectContaining({ A2WAVE_STREAMING_CARD_ID: 'card_env_test' }),
    )
  })

  it('streaming_card 父 agent onUpdate 始终更新卡片', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockStreamingCardSend.mockResolvedValue(undefined)
    mockStreamingCardFinish.mockResolvedValue(undefined)
    mockStreamingCardGetCardId.mockReturnValue('card_guard_test')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: '最终结果' },
      retries: [],
    })
    mockImMessageReactionCreate.mockResolvedValue({})
    mockFinishRunSuccess.mockResolvedValue([])
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o', maxRetries: 0 })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    await feishuConnectionManager.start('agt_001', {
      ...BASE_CONFIG,
      replyContentType: 'streaming_card',
    })
    mockDbGet.mockReturnValue(
      makeAgent({
        feishuConfig: { ...BASE_CONFIG, replyContentType: 'streaming_card' },
      }),
    )
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_sc_guard' }))

    // onUpdate callback was passed to executeInWorker
    const call = mockExecuteWithRetry.mock.calls[0]
    const options = call[2]
    expect(options.onUpdate).toBeDefined()

    // Simulate parent agent text_delta — should always call card.updateContent
    mockStreamingCardUpdateContent.mockClear()
    options.onUpdate('parent text')
    expect(mockTouchStreamingCard).toHaveBeenCalledWith('card_guard_test')
    expect(mockStreamingCardUpdateContent).toHaveBeenCalledWith('parent text')

    mockTouchStreamingCard.mockClear()
    options.onLogEntry({ type: 'retry' })
    expect(mockTouchStreamingCard).toHaveBeenCalledWith('card_guard_test')

    // finish() should be called to close streaming mode
    expect(mockStreamingCardFinish).toHaveBeenCalledOnce()
  })

  it('streaming_card 完成前 emit onBeforeReply，并用 patched text 覆盖最后一次 update', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockStreamingCardSend.mockResolvedValue(undefined)
    mockStreamingCardFinish.mockResolvedValue(undefined)
    mockStreamingCardGetCardId.mockReturnValue('card_patch_test')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'stream original' },
      retries: [],
    })
    mockImMessageReactionCreate.mockResolvedValue({})
    mockFinishRunSuccess.mockResolvedValue([])
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o', maxRetries: 0 })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    const plugin: LifecyclePlugin = {
      name: 'obs:stream-patch',
      onBeforeReply: () => ({ patch: { text: 'stream patched' } }),
    }
    const config = {
      ...BASE_CONFIG,
      replyContentType: 'streaming_card',
    } as const
    await feishuConnectionManager.start('agt_001', config)
    mockDbGet.mockReturnValue(
      makeAgent({
        feishuConfig: { ...BASE_CONFIG, replyContentType: 'streaming_card' },
      }),
    )

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_sc_patch' }), {
      config,
      extraPlugins: [plugin],
    })

    expect(mockStreamingCardUpdateContent).toHaveBeenCalledWith('stream patched')
    expect(mockStreamingCardFinish).toHaveBeenCalledOnce()
  })

  it('streaming_card + replyMode=none 时不发送卡片', async () => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockExecuteWithRetry.mockResolvedValue({ result: { success: true, output: 'ok' }, retries: [] })
    mockImMessageReactionCreate.mockResolvedValue({})
    mockFinishRunSuccess.mockResolvedValue([])
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o', maxRetries: 0 })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    await feishuConnectionManager.start('agt_001', {
      ...BASE_CONFIG,
      p2pReplyMode: 'none',
      replyContentType: 'streaming_card',
    })
    mockDbGet.mockReturnValue(
      makeAgent({
        feishuConfig: {
          ...BASE_CONFIG,
          p2pReplyMode: 'none',
          replyContentType: 'streaming_card',
        },
      }),
    )
    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_sc3' }))

    expect(mockStreamingCardSend).not.toHaveBeenCalled()
  })

  // ── 异常安全 ─────────────────────────────────────────────────

  it('handler 内部异常不向外抛出', async () => {
    mockDbGet.mockImplementation(() => {
      throw new Error('db crash')
    })
    await expect(dispatch(makeData({ chat_type: 'p2p' }))).resolves.not.toThrow()
  })

  it('Agent 已完成后 Feishu 回复失败不再把 run 反写为 failed', async () => {
    mockDbGet.mockReturnValue(makeAgent())
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'Agent 回复' },
      retries: [],
    })
    mockImMessageReply.mockRejectedValueOnce(new Error('reply boom'))

    await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_reply_boom' }))

    expect(mockFinishRunSuccess).toHaveBeenCalledOnce()
    expect(mockFinishRunError).not.toHaveBeenCalled()
  })

  // ── L3 集成测：pipeline/commands router 切入 + C15 失败 reply ──

  describe('pipeline/commands router (PR-1)', () => {
    // 全套测试运行时上游遗留的 mock 实现/连接状态会让本组 dispatcher 拿不到正确的 mockDbGet。
    // 显式重启连接 + reset 所有相关 mock，确保 dispatcher 是新捕获的且 mocks 干净。
    beforeEach(async () => {
      feishuConnectionManager.stopAll()
      vi.clearAllMocks()
      mockDbGet.mockReset()
      mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
      mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o' })
      mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
      mockTryAcquireSlot.mockReturnValue('acquired')
      mockExecuteWithRetry.mockResolvedValue({
        result: { success: true, output: 'ok' },
        retries: [],
      })
      mockFinishRunSuccess.mockResolvedValue([])
      mockImMessageReply.mockResolvedValue({})
      mockImMessageCreate.mockResolvedValue({})
      mockImMessageReactionCreate.mockResolvedValue({})
      await feishuConnectionManager.start('agt_001', BASE_CONFIG)
    })

    it('I-H1: /new 命中 → executeWithRetry.prompt=剥前缀文本，chatId=undefined', async () => {
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_cmd_h1',
          content: JSON.stringify({ text: '/new 跑测试' }),
        }),
      )
      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.prompt).toBe('跑测试')
      expect(payload.chatId).toBeUndefined()
    })

    it('I-H1b: bare /new 命中 → prompt 注入 emptyTextFallback "新会话已开始"，chatId=undefined', async () => {
      // Bare /new used to silently skip (empty intent → return before onBeforeRun),
      // leaving the prior session uncleared because no new completed run was written.
      // Now: emptyTextFallback injects strippedText so pipeline runs end-to-end and
      // lookupPreviousChatId finds the fresh chatId on the next message.
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_cmd_h1b',
          content: JSON.stringify({ text: '/new' }),
        }),
      )
      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.prompt).toBe('新会话已开始')
      expect(payload.chatId).toBeUndefined()
    })

    it('I-H1b2: onBeforeRun runConfigPatch 合入 executeWithRetry payload.agentConfig', async () => {
      const plugin: LifecyclePlugin = {
        name: 'test:run-config-patch',
        priority: 25,
        onBeforeRun: async (ctx) => {
          if (ctx.matchedCommand === 'new') {
            ctx.runConfigPatch = {
              ...(ctx.runConfigPatch ?? {}),
              model: 'patched-model',
              timeoutMinutes: 7,
              extraEngineFlags: ['--compact-history'],
            }
          }
          return null
        },
      }
      mockBuildAgentConfig.mockReturnValue({
        engineType: 'cursor',
        model: 'gpt-4o',
        timeoutMinutes: 5,
      })
      mockDbGet.mockReturnValue(makeAgent())

      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_cmd_patch',
          content: JSON.stringify({ text: '/new 使用 patch' }),
        }),
        { extraPlugins: [plugin] },
      )

      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.model).toBe('patched-model')
      expect(payload.agentConfig).toMatchObject({
        engineType: 'cursor',
        model: 'patched-model',
        timeoutMinutes: 7,
        extraEngineFlags: ['--compact-history'],
      })
    })

    it('I-H1b3: runConfigPatch.model 为 undefined 时不清空原 payload model', async () => {
      const plugin: LifecyclePlugin = {
        name: 'test:run-config-patch-undefined-model',
        priority: 25,
        onBeforeRun: async (ctx) => {
          ctx.runConfigPatch = { model: undefined, timeoutMinutes: 7 }
          return null
        },
      }
      mockBuildAgentConfig.mockReturnValue({
        engineType: 'cursor',
        model: 'gpt-4o',
        timeoutMinutes: 5,
      })
      mockDbGet.mockReturnValue(makeAgent())

      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_cmd_patch_undefined_model',
          content: JSON.stringify({ text: '/new 使用 patch' }),
        }),
        { extraPlugins: [plugin] },
      )

      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.model).toBe('gpt-4o')
      expect(payload.agentConfig).toMatchObject({
        model: 'gpt-4o',
        timeoutMinutes: 7,
      })
    })

    it('I-H1b4: runConfigPatch.model 为空字符串时不清空原 payload model', async () => {
      const plugin: LifecyclePlugin = {
        name: 'test:run-config-patch-empty-model',
        priority: 25,
        onBeforeRun: async (ctx) => {
          ctx.runConfigPatch = { model: '', timeoutMinutes: 7 }
          return null
        },
      }
      mockBuildAgentConfig.mockReturnValue({
        engineType: 'cursor',
        model: 'gpt-4o',
        timeoutMinutes: 5,
      })
      mockDbGet.mockReturnValue(makeAgent())

      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_cmd_patch_empty_model',
          content: JSON.stringify({ text: '/new 使用 patch' }),
        }),
        { extraPlugins: [plugin] },
      )

      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.model).toBe('gpt-4o')
      expect(payload.agentConfig).toMatchObject({
        model: 'gpt-4o',
        timeoutMinutes: 7,
      })
    })

    it('I-H1b5: replyMode=none 时 long-running preAck 不发 Feishu 消息', async () => {
      feishuConnectionManager.stopAll()
      vi.clearAllMocks()
      mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
      mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o' })
      mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
      mockTryAcquireSlot.mockReturnValue('acquired')
      mockExecuteWithRetry.mockResolvedValue({
        result: { success: true, output: 'ok' },
        retries: [],
      })
      mockFinishRunSuccess.mockResolvedValue([])
      mockImMessageReply.mockResolvedValue({})
      mockImMessageCreate.mockResolvedValue({})
      const plugin: LifecyclePlugin = {
        name: 'test:pre-ack',
        priority: 25,
        onBeforeRun: async (ctx) => {
          ctx.preAck = '处理中'
          return null
        },
      }
      const config = {
        ...BASE_CONFIG,
        p2pReplyMode: 'none',
      } as const
      await feishuConnectionManager.start('agt_001', config)
      mockDbGet.mockReturnValue(
        makeAgent({ feishuConfig: { ...BASE_CONFIG, p2pReplyMode: 'none' } }),
      )

      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_cmd_pre_ack_none',
          content: JSON.stringify({ text: '/new 使用 patch' }),
        }),
        { config, extraPlugins: [plugin] },
      )

      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      expect(mockImMessageReply).not.toHaveBeenCalled()
      expect(mockImMessageCreate).not.toHaveBeenCalled()
    })

    it('I-H1c: /new 后跟空白 → 同样注入 emptyTextFallback', async () => {
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_cmd_h1c',
          content: JSON.stringify({ text: '/new   ' }),
        }),
      )
      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.prompt).toBe('新会话已开始')
      expect(payload.chatId).toBeUndefined()
    })

    it('I-H1e (word-boundary): /newer 不应命中 /new → prompt=原文，不剥前缀', async () => {
      // 老 startsWith 行为下 /newer 会命中 /new 并把 prompt 设为 "er"。
      // 修正后前缀之后必须跟空白或 EOS，所以 /newer 是普通文本，prompt 应为 '/newer'。
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_cmd_h1e',
          content: JSON.stringify({ text: '/newer please' }),
        }),
      )
      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.prompt).toBe('/newer please')
    })

    it('I-H1f: /new 在群聊里不作为命令处理 → prompt=原文，session 不重置', async () => {
      // /new 仅在 P2P 顶层重置 session。群聊里等同普通文本透传；
      // 同时不调 applySession → payload.chatId 沿用之前的会话。
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(
        makeData({
          chat_type: 'group',
          message_id: 'om_cmd_h1f',
          content: JSON.stringify({ text: '/new go' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        }),
      )
      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.prompt).toBe('/new go')
    })

    it('I-H1g: /new 在 P2P 话题回复里不作为命令处理 → prompt=原文', async () => {
      // root_id !== message_id ⇒ isThreadReply=true → disallowed context → 普通文本透传。
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_cmd_h1g',
          root_id: 'om_root_for_h1g',
          content: JSON.stringify({ text: '/new go' }),
        }),
      )
      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.prompt).toBe('/new go')
    })

    it('I-H1h: 群聊里 bare /new 不作为命令处理 → prompt=原文', async () => {
      // disallowed context + bare /new：普通文本透传，不注入 emptyTextFallback。
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(
        makeData({
          chat_type: 'group',
          message_id: 'om_cmd_h1h',
          content: JSON.stringify({ text: '/new' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
        }),
      )
      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.prompt).toBe('/new')
    })

    it('I-H1d (regression): 纯空文本无命令命中 → executeWithRetry 不调用 (skip path 保留)', async () => {
      // Negative path: empty message without any command match should still hit the
      // existing "empty intent → return" short-circuit. emptyTextFallback must NOT
      // accidentally widen this gate.
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_cmd_h1d',
          content: JSON.stringify({ text: '' }),
        }),
      )
      expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    })

    it('I-H4: 普通消息 — executeWithRetry.prompt=原文，无 router 干扰', async () => {
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_plain',
          content: JSON.stringify({ text: 'hi' }),
        }),
      )
      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.prompt).toBe('hi')
    })

    it('未注册前缀 /foobar 走普通 LLM 流程（不当命令）', async () => {
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(
        makeData({
          chat_type: 'p2p',
          message_id: 'om_foo',
          content: JSON.stringify({ text: '/foobar xxx' }),
        }),
      )
      expect(mockExecuteWithRetry).toHaveBeenCalledOnce()
      const payload = mockExecuteWithRetry.mock.calls[0][1]
      expect(payload.prompt).toBe('/foobar xxx')
    })

    // 注：legacy newSessionPrefixes / commands.new.enabled=false / commands.new.prefixes
    // 三类测试已删——对应渠道级 disable / prefix override / legacy 兼容整套
    // 已在 Command-as-Plugin 重构里清掉（YAGNI：/new 默认启用，无渠道级入口）。
  })

  describe('C15 run 失败必须发声', () => {
    beforeEach(async () => {
      feishuConnectionManager.stopAll()
      vi.clearAllMocks()
      mockDbGet.mockReset()
      mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
      mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o' })
      mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
      mockTryAcquireSlot.mockReturnValue('acquired')
      mockFinishRunSuccess.mockResolvedValue([])
      mockFinishRunError.mockReturnValue(undefined)
      mockImMessageReply.mockResolvedValue({})
      mockImMessageCreate.mockResolvedValue({})
      mockImMessageReactionCreate.mockResolvedValue({})
      await feishuConnectionManager.start('agt_001', BASE_CONFIG)
    })

    it('I-N4: text 模式 + 软失败（result.success=false）→ feishu reply 含 run_id 兜底', async () => {
      mockDbGet.mockReturnValue(makeAgent())
      mockExecuteWithRetry.mockResolvedValue({
        result: { success: false, output: '', error: 'CLI exit 1' },
        retries: [],
      })
      await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_fail1' }))
      // 方案2：失败发声改用 run_id 兜底文案（不暴露原始 'CLI exit 1'）
      const failReply = mockImMessageReply.mock.calls.find((c) => {
        try {
          const t = JSON.parse(c[0].data.content).text as string
          return t?.includes('未返回有效内容') && t?.includes('run_id')
        } catch {
          return false
        }
      })
      expect(failReply).toBeDefined()
      // 原始引擎错误不得出现在群里
      const exposesRawError = mockImMessageReply.mock.calls.some((c) => {
        try {
          return (JSON.parse(c[0].data.content).text as string)?.includes('CLI exit 1')
        } catch {
          return false
        }
      })
      expect(exposesRawError).toBe(false)
    })

    it('I-N4: text 模式 + executeWithRetry 抛错 → feishu reply 含 run_id 兜底', async () => {
      mockDbGet.mockReturnValue(makeAgent())
      mockExecuteWithRetry.mockRejectedValue(new Error('timeout after 60s'))
      // runWithLifecycle catches the throw + calls finishRunError. The inner error
      // ("timeout after 60s") is logged server-side, never surfaced in the reply.
      mockFinishRunError.mockReturnValue('Execution failed. Check server logs for details.')
      await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_fail2' }))
      const failReply = mockImMessageReply.mock.calls.find((c) => {
        try {
          const t = JSON.parse(c[0].data.content).text as string
          return t?.includes('未返回有效内容') && t?.includes('run_id')
        } catch {
          return false
        }
      })
      expect(failReply).toBeDefined()
    })

    it('I-N5: post 模式失败 → reply 用 post msg_type', async () => {
      feishuConnectionManager.stopAll()
      vi.clearAllMocks()
      mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
      mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor' })
      mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
      mockTryAcquireSlot.mockReturnValue('acquired')
      mockExecuteWithRetry.mockResolvedValue({
        result: { success: false, output: '', error: 'engine 卡死' },
        retries: [],
      })
      mockImMessageReply.mockResolvedValue({})
      await feishuConnectionManager.start('agt_001', {
        ...BASE_CONFIG,
        replyContentType: 'post',
      } as any)
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_fail_post' }))
      const postReply = mockImMessageReply.mock.calls.find((c) => c[0]?.data?.msg_type === 'post')
      expect(postReply).toBeDefined()
    })

    it('I-N12: replyMode=none 失败时静默（不发 reply）', async () => {
      feishuConnectionManager.stopAll()
      vi.clearAllMocks()
      mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
      mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor' })
      mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
      mockTryAcquireSlot.mockReturnValue('acquired')
      mockExecuteWithRetry.mockResolvedValue({
        result: { success: false, output: '', error: 'die' },
        retries: [],
      })
      mockImMessageReply.mockResolvedValue({})
      mockImMessageCreate.mockResolvedValue({})
      await feishuConnectionManager.start('agt_001', {
        ...BASE_CONFIG,
        p2pReplyMode: 'none',
      })
      mockDbGet.mockReturnValue(makeAgent())
      await dispatch(makeData({ chat_type: 'p2p', message_id: 'om_fail_none' }))
      // 不应有任何含"执行失败"的回复
      const allReplies = [...mockImMessageReply.mock.calls, ...mockImMessageCreate.mock.calls]
      const failReply = allReplies.find((c) => {
        try {
          const t = JSON.parse(c[0].data.content).text as string
          return t?.includes('执行失败') ?? false
        } catch {
          return false
        }
      })
      expect(failReply).toBeUndefined()
    })
  })
})

// ── Welcome message handlers ────────────────────────────────────
