import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, promises as fs, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { FeishuConfig } from '@a2wave/shared'
import * as lark from '@larksuiteoapi/node-sdk'
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm'
import WebSocket from 'ws'
import { db } from '../db/client.js'
import { agents, feishuCardCallbacks, feishuPendingMessages, runSteps, runs } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { resolveAgentRuntimeTmpDir } from '../engine/runtime-context.js'
import { buildTaskId } from '../engine/task-id.js'
import { tryAcquireSlot } from '../engine/task-queue.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { env } from '../env.js'
import type { WorkerTaskPayload } from '../worker/index.js'
import { buildAgentConfig, resolveEngineType, resolveWorkDir } from './agent-helpers.js'
import { buildFeishuArtifactSection } from './artifact-links.js'
import {
  getDirectorySourceSize,
  MAX_ZIP_SOURCE_BYTES,
  type RegisteredArtifact,
  zipDirectoryToBuffer,
} from './artifact-storage.js'
import { ProviderConfigurationError } from './errors.js'
import { FeishuStreamingCard } from './feishu-card-streaming.js'
import { type NormalizedFeishuConfig, normalizeFeishuConfig } from './feishu-config.js'
import {
  buildInteractiveCardJson,
  buildPlainCardJson,
  buildResolvedCardJson,
  type CardCallbackValue,
  type CardStyle,
  decideCardAction,
  INTERACTIVE_CARD_PROMPT,
  type InteractiveCardSpec,
  parseInteractiveCardSpec,
  summarizeCardAction,
} from './feishu-interactive-card.js'
import { buildTriggerSessionId, quoteAnchorId } from './feishu-message-context.js'
import {
  type FeishuEventPayload,
  type FeishuMessagePayload,
  type FeishuSenderPayload,
  persistPendingMessage,
  removePendingMessage,
} from './feishu-pending-store.js'
import { textToPostContent } from './feishu-post-content.js'
import {
  resolveFeishuFailureReplyMentionOpenId,
  resolveFeishuMentionRootId,
  supportsFeishuReplyMention,
  warnFeishuTopicCreatorUnavailable,
} from './feishu-reply-mention.js'
import {
  buildFeishuFileHint,
  mergeFeishuTopicRootText,
  resolveFeishuReplyMentionOpenId,
  resolveFeishuTopicRootId,
} from './feishu-topic-root.js'
import { createId } from './id.js'
import { logger } from './logger.js'
import { registerPendingJob } from './pending-job-registry.js'
import { buildDefaultPlugins, emit } from './pipeline/index.js'
import type {
  AuthenticatedCtx,
  LifecyclePlugin,
  MatchedCtx,
  PipelineError,
  ReplyCtx,
  RunCtx,
} from './pipeline/types.js'
import { buildFeishuChannel } from './run-channel.js'
import { FAILURE_REASONS } from './run-failure-reasons.js'
import { runWithLifecycle } from './run-launcher.js'
import { finishRunAborted, finishRunError } from './run-lifecycle.js'
import { persistRunTurn, recoverRunStartup } from './run-startup.js'
import {
  registerStreamingCard,
  touchStreamingCard,
  unregisterStreamingCard,
} from './streaming-card-registry.js'

export { normalizeFeishuConfig } from './feishu-config.js'
export { buildTriggerSessionId, quoteAnchorId } from './feishu-message-context.js'
export type { FeishuConfig, FeishuMessagePayload, FeishuSenderPayload }

/** The `im.message.receive_v1` event body delivered over the long connection. */
interface FeishuMessageEvent {
  message: FeishuMessagePayload
  sender?: FeishuSenderPayload
}

/** Chat lifecycle events that drive the welcome message (P2P entered / bot added). */
interface FeishuChatEvent {
  chat_id?: string
  event_id?: string
  uuid?: string
  last_message_create_time?: string
  operator_id?: { open_id?: string }
  [key: string]: unknown
}

/** The `card.action.trigger` callback body. */
interface FeishuCardActionEvent {
  action?: {
    value?: unknown
    tag?: string
    option?: string
    form_value?: Record<string, unknown>
    [key: string]: unknown
  }
  context?: { open_message_id?: string; open_chat_id?: string; [key: string]: unknown }
  operator?: { open_id?: string; union_id?: string; user_id?: string }
  [key: string]: unknown
}

/** 飞书长连接轮询间隔（与 SDK 建连时序解耦，用于 UI 与诊断） */
const FEISHU_WS_POLL_MS = 2000
const FEISHU_WS_DISCONNECT_WINDOW_MS = 60_000
const FEISHU_WS_DISCONNECT_THRESHOLD = 5

/**
 * 根据 replyContentType 构建飞书回复的 msg_type 和 content。
 * 供 handleMessage 与 sendFeishuMessageByContext 复用。
 * streaming_card 在 API 触发场景无流式过程，回退为 post。
 */
export function buildFeishuReplyContent(
  content: string,
  replyContentType: 'text' | 'post' | 'interactive' | 'interactive_card' | 'streaming_card',
  cardTemplateId?: string,
  cardStyle?: CardStyle,
): { msgType: string; replyContent: string } {
  // streaming_card 在无流式场景回退为 post。
  const effectiveType = replyContentType === 'streaming_card' ? 'post' : replyContentType
  if (effectiveType === 'interactive') {
    return {
      msgType: 'interactive',
      replyContent: JSON.stringify({
        type: 'template',
        data: {
          template_id: cardTemplateId ?? '',
          template_variable: { content },
        },
      }),
    }
  }
  // interactive_card：始终是卡片。走到这里说明 Agent 本轮没声明 a2wave-card 交互块（或发卡失败
  // 降级），把整段回复包成一张纯文本卡片 JSON 2.0——交互组件由上层 buildInteractiveCardJson 负责。
  if (effectiveType === 'interactive_card') {
    return {
      msgType: 'interactive',
      replyContent: JSON.stringify(buildPlainCardJson(content, cardStyle)),
    }
  }
  if (effectiveType === 'post') {
    return { msgType: 'post', replyContent: textToPostContent(content) }
  }
  return { msgType: 'text', replyContent: JSON.stringify({ text: content }) }
}

// Re-export from feishu-fallback.ts (dependency-free module) so both this file
// and run-lifecycle.ts can use it without forming a cycle.
import { buildFeishuFallbackText, buildFeishuProviderConfigErrorText } from './feishu-fallback.js'

export { buildFeishuFallbackText }

// ── Pure helpers (exported for testing) ──────────────────────────

/**
 * 判断消息是否满足触发条件。
 *
 * 话题群识别假设：群聊消息中 `thread_id` 存在即视为话题群消息。
 * - 新话题：有 thread_id，无 root_id
 * - 话题内评论/回复：有 thread_id，且有 root_id
 * 该行为依赖飞书 im.message.receive_v1 事件 payload 的实际字段；
 * 若飞书在特殊场景下对普通群消息也携带 thread_id，可能误走话题逻辑。
 *
 * NOTE: 旧版 DB 行可能缺失部分字段（zod default 不会在读取时补齐），
 * 调用方应先经过 normalizeFeishuConfig() 填充默认值后再传入。
 */
export function shouldTrigger(
  config: Pick<
    NormalizedFeishuConfig,
    | 'groupTriggerOnAt'
    | 'groupTriggerOnNewMessage'
    | 'topicTriggerOnAt'
    | 'topicTriggerOnNewTopic'
    | 'topicTriggerOnNewComment'
  >,
  message: {
    chat_type?: string
    thread_id?: string
    root_id?: string
    mentions?: Array<{ key: string; id?: { open_id?: string } }>
  },
  botOpenId?: string,
): boolean {
  if (message.chat_type === 'p2p') return true

  const isMentioned = botOpenId
    ? (message.mentions ?? []).some((m) => m.id?.open_id === botOpenId)
    : (message.mentions ?? []).some((m) => m.key === '@_user_1')

  // 话题群：群聊消息携带 thread_id（参见上方 JSDoc 中的假设说明）
  if (message.thread_id) {
    const isNewTopic = !message.root_id
    const isComment = !!message.root_id
    return (
      (config.topicTriggerOnAt && isMentioned) ||
      (config.topicTriggerOnNewTopic && isNewTopic) ||
      (config.topicTriggerOnNewComment && isComment)
    )
  }

  // 普通群
  return (config.groupTriggerOnAt && isMentioned) || config.groupTriggerOnNewMessage
}

/**
 * 根据消息上下文返回实际的回复模式。
 * P2P 使用 p2pReplyMode，话题群使用 topicReplyMode，普通群使用 groupReplyMode。
 * topic_reply 在 API 层等价于 quote（调用 message.reply()），飞书自动将回复放入话题线程。
 */
export function getEffectiveReplyMode(
  config: Pick<NormalizedFeishuConfig, 'groupReplyMode' | 'topicReplyMode' | 'p2pReplyMode'>,
  message: { chat_type?: string; thread_id?: string },
): 'quote' | 'new' | 'none' {
  // P2P 单聊：独立配置，避免被 groupReplyMode='none' 静默
  if (message.chat_type === 'p2p') return config.p2pReplyMode
  // 话题群：群聊消息带有 thread_id
  if (message.thread_id) {
    return config.topicReplyMode === 'topic_reply' ? 'quote' : 'none'
  }
  return config.groupReplyMode
}

/**
 * 从二维元素数组中提取指定 tag 的值。
 * 适用于 mixed (elements) 和 post (zh_cn.content) 两种格式。
 */
function extractFromElements(rows: unknown[][], tag: string | string[], field: string): string[] {
  const tags = Array.isArray(tag) ? tag : [tag]
  const results: string[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    for (const el of row) {
      if (
        el &&
        typeof el === 'object' &&
        tags.includes((el as Record<string, unknown>).tag as string)
      ) {
        const v = (el as Record<string, unknown>)[field] as string | undefined
        if (v) results.push(v)
      }
    }
  }
  return results
}

/** 尝试从 post 格式中获取 content 二维数组。
 *  飞书接收到的 post 消息为扁平格式: { title, content: [[...]] }
 *  飞书发送用的 post 格式为 locale 包装: { zh_cn: { title, content: [[...]] } }
 */
function getPostContentRows(parsed: Record<string, unknown>): unknown[][] | null {
  // 扁平格式（接收消息）
  if (Array.isArray(parsed.content)) return parsed.content as unknown[][]
  // locale 包装格式（发送消息 / textToPostContent 生成）
  for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
    const loc = parsed[locale] as Record<string, unknown> | undefined
    if (loc && Array.isArray(loc.content)) return loc.content as unknown[][]
  }
  return null
}

/**
 * 从 post 消息的二维节点数组中提取纯文本。
 * - 行内节点直接拼接（无分隔符）
 * - 行间用 \n 分隔，保留段落结构
 * - 支持 text、a（超链接）节点；其余节点（img 等）忽略
 */
/** 飞书 mention key 正则（@_ 开头），用于从文本中去除 bot mention 占位符 */
const FEISHU_MENTION_KEY_RE = /@_\S+/g

function extractPostRowsText(rows: unknown[][]): string {
  return rows
    .map((row) => {
      if (!Array.isArray(row)) return ''
      return row
        .map((node) => {
          if (!node || typeof node !== 'object') return ''
          const n = node as Record<string, unknown>
          if (n.tag === 'a')
            return (n.text as string | undefined) ?? (n.href as string | undefined) ?? ''
          return (n.text as string | undefined) ?? ''
        })
        .join('')
    })
    .join('\n')
    .replace(FEISHU_MENTION_KEY_RE, '')
    .trim()
}

export function extractText(rawContent: string, richPost = false, messageType?: string): string {
  try {
    const parsed = JSON.parse(rawContent)
    // interactive 卡片：content 为 { title, elements: [[...]], user_dsl, ... }
    // 按 post 语义提取 text + a 节点，并把 title 作为首行拼接，保留卡片最关键的上下文（如缺陷标题）
    if (messageType === 'interactive') {
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
      const rows = Array.isArray(parsed.elements) ? (parsed.elements as unknown[][]) : []
      const body = extractFromElements(rows, ['text', 'a'], 'text')
        .join('')
        .replace(FEISHU_MENTION_KEY_RE, '')
        .trim()
      return [title, body].filter(Boolean).join('\n').trim()
    }
    // text 类型消息
    if (parsed.text) return (parsed.text as string).replace(FEISHU_MENTION_KEY_RE, '').trim()
    // mixed 类型消息：从 elements 中提取 text tag
    if (Array.isArray(parsed.elements)) {
      return extractFromElements(parsed.elements, 'text', 'text')
        .join('')
        .replace(FEISHU_MENTION_KEY_RE, '')
        .trim()
    }
    // post 类型消息
    const postRows = getPostContentRows(parsed)
    if (postRows) {
      // richPost=true：保留段落换行、支持链接节点（用于需要完整结构的场景）
      if (richPost) return extractPostRowsText(postRows)
      return extractFromElements(postRows, ['text', 'a'], 'text')
        .join('')
        .replace(FEISHU_MENTION_KEY_RE, '')
        .trim()
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 飞书消息资源（入站文件/图片下载与出站文件）统一大小上限，与 sendArtifactFiles 一致。
 */
export const FEISHU_MESSAGE_RESOURCE_MAX_BYTES = 30 * 1024 * 1024 // 30 MB

export function extractFileMeta(rawContent: string): { fileKey: string; fileName: string } | null {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>
    const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key.trim() : ''
    if (!fileKey) return null
    const fileName = typeof parsed.file_name === 'string' ? parsed.file_name.trim() : ''
    return { fileKey, fileName }
  } catch {
    return null
  }
}

/** 飞书 file_name 落盘用：防路径穿越与非法字符（单消息单目录下保证可区分） */
export function feishuSafeFileNameForDisk(rawName: string | undefined, fileKey: string): string {
  const base = rawName ? basename(rawName) : ''
  let name = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '')
  if (!name) name = 'attachment'
  if (!name.includes('.')) {
    name = `${name}_${fileKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-16)}`
  }
  return name
}

function safeFeishuRuntimePathSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '_') || 'default'
}

function buildFeishuFileDownloadRootDir(agentId: string, runId: string): string {
  return join(
    resolveAgentRuntimeTmpDir(agentId),
    'feishu-files',
    safeFeishuRuntimePathSegment(runId),
  )
}

function buildFeishuImageDownloadRootDir(agentId: string, runId: string): string {
  return join(
    resolveAgentRuntimeTmpDir(agentId),
    'feishu-images',
    safeFeishuRuntimePathSegment(runId),
  )
}

function buildFeishuMessageResourceDownloadDir(rootDir: string): string {
  return join(rootDir, randomUUID())
}

export async function cleanupFeishuMessageResourceDownloadRoot(rootDir: string): Promise<void> {
  await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {})
  await fs.rmdir(dirname(rootDir)).catch(() => {})
}

function feishuImageHintForPrompt(imagePaths: string[]): string {
  return imagePaths
    .map((imagePath, index) => {
      const label = imagePaths.length > 1 ? `[图片 ${index + 1}]` : '[图片]'
      return `${label}\n图片路径：${imagePath}`
    })
    .join('\n\n')
}

export function extractImageKeys(rawContent: string, messageType: string): string[] {
  try {
    const parsed = JSON.parse(rawContent)
    if (messageType === 'image') {
      const key = parsed.image_key as string | undefined
      return key ? [key] : []
    }
    if (messageType === 'mixed') {
      const elements = parsed.elements as unknown[][] | undefined
      return Array.isArray(elements) ? extractFromElements(elements, 'img', 'image_key') : []
    }
    if (messageType === 'post') {
      const postRows = getPostContentRows(parsed)
      return postRows ? extractFromElements(postRows, 'img', 'image_key') : []
    }
    return []
  } catch {
    return []
  }
}

/**
 * The SDK only declares the streaming shape (writeFile / getReadableStream), but some
 * versions hand back a Buffer or `{ data: Buffer }`. `data` is absent from the declared
 * type, so probe it structurally at runtime and keep the existing fallback branch.
 */
function responseDataBuffer(resp: unknown): Buffer | null {
  if (!resp || typeof resp !== 'object') return null
  const data = (resp as { data?: unknown }).data
  return Buffer.isBuffer(data) ? data : null
}

async function downloadFeishuImages(
  client: lark.Client,
  messageId: string,
  imageKeys: string[],
  targetDir?: string,
): Promise<{ dir: string; paths: string[] }> {
  const dir = targetDir ?? join(tmpdir(), `a2wave-img-${randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  const paths: string[] = []
  for (const key of imageKeys) {
    const filePath = join(dir, `${key}.jpg`)
    try {
      const resp = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: key },
        params: { type: 'image' },
      })
      const respDataBuffer = responseDataBuffer(resp)
      if (resp && typeof resp.writeFile === 'function') {
        await resp.writeFile(filePath)
      } else if (resp && typeof resp.getReadableStream === 'function') {
        const stream = resp.getReadableStream() as AsyncIterable<Buffer | Uint8Array>
        const chunks: Buffer[] = []
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        await fs.writeFile(filePath, Buffer.concat(chunks))
      } else if (resp instanceof Buffer) {
        await fs.writeFile(filePath, resp)
      } else if (respDataBuffer) {
        await fs.writeFile(filePath, respDataBuffer)
      } else {
        logger.warn(
          { messageId, key },
          'Unexpected response type from messageResource.get, skipping image',
        )
        continue
      }
      paths.push(filePath)
    } catch (err) {
      logger.warn({ err, messageId, key }, 'Failed to download Feishu image, skipping')
    }
  }
  return { dir, paths }
}

async function downloadFeishuFile(
  client: lark.Client,
  messageId: string,
  fileKey: string,
  safeFileName: string,
  maxBytes: number,
  targetDir?: string,
): Promise<
  { ok: true; path: string; dir: string } | { ok: false; reason: 'too_large' | 'download_failed' }
> {
  const dir = targetDir ?? join(tmpdir(), `a2wave-file-${randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  const filePath = join(dir, safeFileName)

  async function cleanupDir(): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  try {
    const resp = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: 'file' },
    })

    if (resp && typeof resp.getReadableStream === 'function') {
      const stream = resp.getReadableStream() as AsyncIterable<Buffer | Uint8Array>
      const ws = createWriteStream(filePath)
      let total = 0
      try {
        for await (const chunk of stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          if (total + buf.length > maxBytes) {
            ws.destroy()
            await cleanupDir()
            return { ok: false, reason: 'too_large' }
          }
          total += buf.length
          const canContinue = ws.write(buf)
          if (!canContinue) await once(ws, 'drain')
        }
        ws.end()
        await finished(ws)
      } catch (streamErr) {
        ws.destroy()
        await cleanupDir()
        logger.warn({ err: streamErr, messageId, fileKey }, 'Feishu file stream download failed')
        return { ok: false, reason: 'download_failed' }
      }
      return { ok: true, path: filePath, dir }
    }

    if (resp && typeof resp.writeFile === 'function') {
      await resp.writeFile(filePath)
      const st = statSync(filePath)
      if (st.size > maxBytes) {
        await cleanupDir()
        return { ok: false, reason: 'too_large' }
      }
      return { ok: true, path: filePath, dir }
    }

    if (resp instanceof Buffer) {
      if (resp.length > maxBytes) {
        await cleanupDir()
        return { ok: false, reason: 'too_large' }
      }
      await fs.writeFile(filePath, resp)
      return { ok: true, path: filePath, dir }
    }
    const respDataBuffer = responseDataBuffer(resp)
    if (respDataBuffer) {
      if (respDataBuffer.length > maxBytes) {
        await cleanupDir()
        return { ok: false, reason: 'too_large' }
      }
      await fs.writeFile(filePath, respDataBuffer)
      return { ok: true, path: filePath, dir }
    }

    logger.warn(
      { messageId, fileKey },
      'Unexpected response type from messageResource.get (file), skipping',
    )
    await cleanupDir()
    return { ok: false, reason: 'download_failed' }
  } catch (err) {
    logger.warn({ err, messageId, fileKey }, 'Failed to download Feishu file')
    await cleanupDir()
    return { ok: false, reason: 'download_failed' }
  }
}

/**
 * 向用户发送 run 失败通知（C15）。
 *
 * 与 sendFeishuUserNotification 区别：
 * - 尊重 replyMode='none'（用户显式选了不回）→ 静默 return
 * - 用 config.replyContentType 对齐 run 配置（text/post/interactive 都覆盖，
 *   streaming_card 由调用方走 card.updateContent 路径，不进此函数）
 *
 * bodyText 由调用方拼好并原样发送 — 失败/空输出统一走 buildFeishuFallbackText(runId)，
 * 只给用户可理解的提示 + run_id，绝不暴露原始引擎错误 / stack / 内部 ID。
 */
async function sendFeishuFailureReply(
  client: lark.Client,
  dataSender: FeishuSenderPayload | undefined,
  message: FeishuMessagePayload,
  config: NormalizedFeishuConfig,
  bodyText: string,
  mentionOpenIdOverride?: string | null,
): Promise<void> {
  const replyMode = getEffectiveReplyMode(config, message)
  if (replyMode === 'none') return

  const body = bodyText
  const replyContentType = config.replyContentType ?? 'text'
  // streaming_card 走 card.updateContent，不应进入此函数；保险起见把它降为 post
  const effectiveType = replyContentType === 'streaming_card' ? 'post' : replyContentType
  let { msgType, replyContent } = buildFeishuReplyContent(
    body,
    effectiveType,
    config.cardTemplateId,
  )
  const senderOpenId = supportsFeishuReplyMention(effectiveType)
    ? mentionOpenIdOverride === undefined
      ? await resolveFeishuFailureReplyMentionOpenId(client, dataSender, message, config)
      : (mentionOpenIdOverride ?? undefined)
    : undefined
  // 卡片类（interactive/interactive_card）不支持文本前缀 @，跳过。
  if (message.chat_type !== 'p2p' && senderOpenId) {
    replyContent = prependAtMention(msgType, replyContent, senderOpenId)
  }
  try {
    if (replyMode === 'quote') {
      await client.im.message.reply({
        path: { message_id: quoteAnchorId(message) },
        data: { content: replyContent, msg_type: msgType },
      })
    } else {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: message.chat_id, content: replyContent, msg_type: msgType },
      })
    }
  } catch (err) {
    logger.warn({ err }, 'Feishu: failure reply send failed')
  }
}

/** 交互卡片回调记录的存活时间：超时后回调一律忽略（卡片随会话过期）。 */
const CARD_CALLBACK_TTL_MS = 24 * 60 * 60 * 1000

/** 回调记录清理节流：随发卡活动触发，最多每小时清一次已用/过期行，防止表无限增长。 */
const CARD_CALLBACK_SWEEP_INTERVAL_MS = 60 * 60 * 1000
let lastCardCallbackSweep = 0

async function sweepExpiredCardCallbacks(): Promise<void> {
  const now = Date.now()
  if (now - lastCardCallbackSweep < CARD_CALLBACK_SWEEP_INTERVAL_MS) return
  lastCardCallbackSweep = now
  try {
    await db
      .delete(feishuCardCallbacks)
      .where(
        or(
          eq(feishuCardCallbacks.status, 'used'),
          lt(feishuCardCallbacks.expiresAt, new Date(now)),
        ),
      )
  } catch (err) {
    logger.warn({ err }, 'Feishu: card callback sweep failed')
  }
}

/**
 * 发送一张交互卡片（卡片 JSON 2.0）作为回复，并落一条 feishu_card_callbacks 记录用于回调关联。
 * 返回是否发送成功。失败不抛错（调用方据返回值决定是否回退普通回复）。
 */
async function sendInteractiveCardReply(opts: {
  client: lark.Client
  agentId: string
  config: NormalizedFeishuConfig
  message: FeishuMessagePayload
  triggerSessionId: string | null | undefined
  /** 触发者 open_id（卡片接收者）；回调时据此限制仅本人可点击。 */
  triggerOpenId: string | null | undefined
  /**
   * 本轮 Agent 产出卡片所用的引擎会话 id（= 本轮 run 的 result.chatId）。
   * 续跑时作为 payload.chatId 续接「刚才提问」的那轮会话——必须用执行后的
   * result.chatId，而非执行前查到的上一轮 chatId（否则首次发卡点击会新开会话）。
   */
  resumeChatId: string | null | undefined
  spec: InteractiveCardSpec
  bodyFallback?: string
  replyMode: 'quote' | 'new' | 'none'
  /** 机器人名，作为卡片默认标题栏文字（Agent 自带 spec.title 时优先用 spec.title）。 */
  agentName?: string
  /** 调试信息文本后缀（按运营勾选）；渲染到卡片底部，并持久化供就地更新卡片复用。 */
  debugSuffix?: string
}): Promise<boolean> {
  const { client, agentId, message, spec, bodyFallback, replyMode, agentName, debugSuffix } = opts
  if (replyMode === 'none') return false

  sweepExpiredCardCallbacks()
  const cbId = createId('fcb')
  // 持久化时补上 body：Agent 常按提示把正文写在卡片块外、不设 spec.body（此时初始卡片用 bodyFallback）。
  // 点击后就地更新卡片只能从持久化的 spec 重建，若不补 body 会丢失原始问题正文（只剩结果行）。
  const persistedSpec = spec.body || !bodyFallback ? spec : { ...spec, body: bodyFallback }
  try {
    await db.insert(feishuCardCallbacks).values({
      id: cbId,
      agentId,
      triggerSessionId: opts.triggerSessionId ?? '',
      previousChatId: opts.resumeChatId ?? null,
      chatId: message.chat_id,
      chatType: message.chat_type ?? null,
      threadId: message.thread_id ?? null,
      // 最初提问消息 id：续跑回复永远 quote 这条而非中间卡片。链式发卡时
      // quoteAnchorId 已是上一轮透传来的原始问题 id，逐轮透传保持锚点不变。
      originalMessageId: quoteAnchorId(message),
      triggerOpenId: opts.triggerOpenId ?? null,
      spec: JSON.stringify(persistedSpec),
      debugSuffix: debugSuffix || null,
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + CARD_CALLBACK_TTL_MS),
    })
  } catch (err) {
    logger.warn({ err, agentId }, 'Feishu: persist card callback failed')
    return false
  }

  const card = buildInteractiveCardJson(spec, cbId, bodyFallback, { title: agentName }, debugSuffix)
  const content = JSON.stringify(card)
  try {
    let resp: { message_id?: string; data?: { message_id?: string } } | undefined
    if (replyMode === 'quote') {
      resp = await client.im.message.reply({
        path: { message_id: quoteAnchorId(message) },
        data: { content, msg_type: 'interactive' },
      })
    } else {
      resp = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: message.chat_id, content, msg_type: 'interactive' },
      })
    }
    const sentMessageId = resp?.data?.message_id ?? resp?.message_id ?? null
    if (sentMessageId) {
      await db
        .update(feishuCardCallbacks)
        .set({ messageId: sentMessageId })
        .where(eq(feishuCardCallbacks.id, cbId))
    }
    return true
  } catch (err) {
    logger.warn({ err, agentId, cbId }, 'Feishu: send interactive card failed')
    // 卡片没发出去，删掉刚落的回调记录，避免留下永远不会被触发的孤儿行。
    try {
      await db.delete(feishuCardCallbacks).where(eq(feishuCardCallbacks.id, cbId))
    } catch {
      /* best-effort */
    }
    return false
  }
}

/**
 * 调试信息文本后缀：把运营勾选的运行信息（会话 id / provider / 模型）拼成一段 markdown，
 * 追加到正常回复正文末尾（而非独立小卡片）。任一勾选才输出，全不勾选 → 空串。
 * 纯函数，导出供测试。
 */
export function buildDebugInfoSuffix(opts: {
  showSessionId: boolean
  showProvider: boolean
  showModel: boolean
  sessionId?: string | null
  providerName?: string | null
  model?: string | null
}): string {
  const lines: string[] = []
  if (opts.showSessionId) lines.push(`- 会话 ID：${opts.sessionId || '—'}`)
  if (opts.showProvider) lines.push(`- Provider：${opts.providerName || '—'}`)
  if (opts.showModel) lines.push(`- 模型：${opts.model || '—'}`)
  if (lines.length === 0) return ''
  return `\n\n---\n**🐞 调试信息**\n${lines.join('\n')}`
}

/**
 * 向用户发送纯文本提示（超限/解析失败等）。忽略 replyMode=none，仍发消息以免用户无感知。
 */
async function sendFeishuUserNotification(
  client: lark.Client,
  dataSender: FeishuSenderPayload | undefined,
  message: FeishuMessagePayload,
  config: NormalizedFeishuConfig,
  bodyText: string,
): Promise<void> {
  let { msgType, replyContent } = buildFeishuReplyContent(bodyText, 'text')
  const senderOpenId = dataSender?.sender_id?.open_id
  if (message.chat_type !== 'p2p' && senderOpenId) {
    replyContent = prependAtMention(msgType, replyContent, senderOpenId)
  }
  const rawMode = getEffectiveReplyMode(config, message)
  const effectiveMode = rawMode === 'none' ? 'new' : rawMode
  try {
    if (effectiveMode === 'quote') {
      await client.im.message.reply({
        path: { message_id: quoteAnchorId(message) },
        data: { content: replyContent, msg_type: msgType },
      })
    } else {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.chat_id,
          content: replyContent,
          msg_type: msgType,
        },
      })
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to send Feishu user notification')
  }
}

// Re-exported so this module's public surface is unchanged by the split.
export { textToPostContent } from './feishu-post-content.js'

export function prependAtMention(msgType: string, content: string, senderOpenId: string): string {
  try {
    if (msgType === 'text') {
      const parsed = JSON.parse(content)
      parsed.text = `<at user_id="${senderOpenId}"></at> ${parsed.text}`
      return JSON.stringify(parsed)
    }
    if (msgType === 'post') {
      const parsed = JSON.parse(content)
      const body = parsed.zh_cn ?? parsed.en_us ?? parsed.ja_jp
      const key = parsed.zh_cn ? 'zh_cn' : parsed.en_us ? 'en_us' : 'ja_jp'
      if (body?.content && Array.isArray(body.content)) {
        const atNode = { tag: 'at', user_id: senderOpenId }
        if (body.content.length > 0) {
          body.content[0] = [atNode, { tag: 'text', text: ' ' }, ...body.content[0]]
        } else {
          body.content.unshift([atNode])
        }
        parsed[key] = body
      }
      return JSON.stringify(parsed)
    }
  } catch {
    /* malformed content, return as-is */
  }
  return content
}

// P2P 会话超时：2 小时内无交互则开启新会话；话题/回复链会话永不超时。
const P2P_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000

/**
 * 查找同一会话中最近一次已完成 run 的 chatId，用于向 LLM 引擎传递历史上下文以恢复对话。
 * - 每次 run 完成后，引擎将 LLM 返回的 chatId 写入 runs.result.chatId
 * - 下次同 triggerSessionId 的消息到来时，取出该 chatId 传给引擎，实现多轮对话连续
 * - sessionTimeoutMs 控制超时：超时后返回 null，引擎会开启全新会话
 *   - 话题/回复链（有 thread_id 或 root_id）：调用方传入 Infinity，永不超时
 *   - P2P / 群聊独立 @：使用 P2P_SESSION_TIMEOUT_MS（2 小时）
 */
export async function lookupPreviousChatId(
  agentId: string,
  triggerSessionId: string,
  sessionTimeoutMs = P2P_SESSION_TIMEOUT_MS,
): Promise<string | null> {
  const row = (
    await db
      .select({ result: runs.result, updatedAt: runs.updatedAt })
      .from(runs)
      .where(
        and(
          eq(runs.initiatorAgentId, agentId),
          eq(runs.triggerSessionId, triggerSessionId),
          eq(runs.status, 'completed'),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(1)
  )[0]

  if (!row || !row.updatedAt) return null

  const elapsed = Date.now() - row.updatedAt.getTime()
  if (elapsed > sessionTimeoutMs) return null

  const result = row.result as Record<string, unknown> | undefined
  const chatId = result?.chatId
  return typeof chatId === 'string' ? chatId : null
}

/**
 * Build the per-step context object for a Feishu-triggered run.
 *
 * Returns the unified channel context (`context.channel`) AND a back-compat
 * flat shim (`sender_type`, `sender_id`, `message_id`, `chat_id`, `thread_id`,
 * `chat_type`, `sender_user`) that mirrors the pre-MR !84 shape byte-for-byte.
 *
 * The shim exists to give user-authored Agent prompts / MCP tools that
 * reference `{{context.chat_id}}`, `{{context.sender_user}}`, etc. one release
 * cycle to migrate to the new `context.channel.channel_info.*` fields without
 * silently breaking in production.
 *
 * DEPRECATED: the flat fields are scheduled for removal in a2wave vNext.
 * New consumers MUST read from `context.channel.channel_info.*` (or
 * `context.channel.user_info`). See `docs/agent/run-channel-context.md` for
 * the full migration guide.
 */
export function buildFeishuContext(
  sender: FeishuSenderPayload | undefined,
  message: FeishuMessagePayload,
  userInfo?: Record<string, unknown> | null,
  appId?: string,
): { context: Record<string, unknown>; displayName: string | null } {
  if (!appId) {
    // Production call sites always pass config.appId; missing here would mean
    // the caller forgot to thread it through. Fail fast — schema .min(1) would
    // catch this on the next runChannelContextSchema.parse() call anyway.
    throw new Error('buildFeishuContext: appId is required')
  }
  const channelResult = buildFeishuChannel({
    appId,
    sender: {
      sender_type: sender?.sender_type,
      sender_id: sender?.sender_id,
    },
    message: {
      message_id: message.message_id,
      chat_id: message.chat_id,
      // The channel schema requires a non-empty chat_type; every non-p2p chat is
      // treated as a group elsewhere, so use that when the event omits it.
      chat_type: message.chat_type ?? 'group',
      thread_id: message.thread_id,
    },
    fetchedUserInfo:
      (userInfo as Parameters<typeof buildFeishuChannel>[0]['fetchedUserInfo']) ?? null,
  })

  const legacyShim: Record<string, unknown> = {
    sender_type: sender?.sender_type,
    sender_id: sender?.sender_id?.open_id,
    message_id: message.message_id,
    chat_id: message.chat_id,
    thread_id: message.thread_id,
    chat_type: message.chat_type,
  }
  if (userInfo) {
    legacyShim.sender_user = userInfo
  }

  return {
    context: { channel: channelResult.ctx, ...legacyShim },
    displayName: channelResult.displayName,
  }
}

// ── User info cache: keyed by "appId:open_id", TTL 10 minutes ──
const USER_INFO_CACHE_MAX = 500
const USER_INFO_CACHE_TTL_MS = 10 * 60 * 1000

type CachedUserInfo = { data: Record<string, unknown>; fetchedAt: number }
const userInfoCache = new Map<string, CachedUserInfo>()

function getCachedUserInfo(cacheKey: string): Record<string, unknown> | null {
  const entry = userInfoCache.get(cacheKey)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > USER_INFO_CACHE_TTL_MS) {
    userInfoCache.delete(cacheKey)
    return null
  }
  return entry.data
}

function setCachedUserInfo(cacheKey: string, data: Record<string, unknown>): void {
  if (userInfoCache.size >= USER_INFO_CACHE_MAX) {
    const toDelete = [...userInfoCache.keys()].slice(0, Math.floor(USER_INFO_CACHE_MAX / 2))
    for (const key of toDelete) userInfoCache.delete(key)
  }
  userInfoCache.set(cacheKey, { data, fetchedAt: Date.now() })
}

/**
 * 把飞书/axios 错误压成可记日志的精简对象。
 * axios error 自带 request/response/socket 的循环引用，直接喂给 logger 会序列化出几千行。
 * 这里只取排障真正需要的字段：飞书业务码 code/msg、HTTP status、log_id（用于飞书侧排障）、网络层 code。
 */
function summarizeFeishuError(err: unknown): Record<string, unknown> {
  const e = err as {
    code?: string
    message?: string
    response?: {
      status?: number
      headers?: Record<string, string>
      data?: { code?: number; msg?: string; error?: { log_id?: string } }
    }
  }
  const resp = e?.response
  const body = resp?.data
  const summary: Record<string, unknown> = {}
  if (e?.code) summary.netCode = e.code // 网络层，如 ECONNRESET / ERR_BAD_REQUEST
  if (resp?.status) summary.status = resp.status
  if (body?.code != null) summary.feishuCode = body.code // 飞书业务码，如 41050
  if (body?.msg) summary.feishuMsg = body.msg
  const logId = body?.error?.log_id ?? resp?.headers?.['x-tt-logid']
  if (logId) summary.logId = logId
  if (!Object.keys(summary).length) summary.message = e?.message ?? String(err)
  return summary
}

/**
 * 通过飞书通讯录 API 获取用户信息（bot 身份 / tenant_access_token）。
 *
 * 飞书通讯录权限分两层（两层都适用于 tenant_access_token，不是 OAuth 专属）：
 *   - base  权限：`contact:contact.base:readonly`（最小）等 `contact:contact.*` —— 决定能不能调本接口
 *   - field 权限：`contact:user.base:readonly`（name 等）、`contact:user.email:readonly`（email）
 *                 等 `contact:user.*` —— 决定 response 里返回哪些字段
 *
 * 因此 base 缺了直接 403；field 缺了接口能调通但响应里对应字段是空。
 *
 * 失败时返回 null，不阻塞 Agent 执行。
 */
export async function fetchFeishuUserInfo(
  client: lark.Client,
  openId: string,
  appId: string,
): Promise<Record<string, unknown> | null> {
  const cacheKey = `${appId}:${openId}`
  const cached = getCachedUserInfo(cacheKey)
  if (cached) return cached

  try {
    const res = await client.request({
      method: 'GET',
      url: `/open-apis/contact/v3/users/${openId}`,
      params: { user_id_type: 'open_id' },
    })
    const user = res?.data?.user
    if (!user) {
      logger.error(
        { openId, res: res?.data },
        'Feishu fetchUserInfo: API returned no user — check app visibility scope',
      )
      return null
    }
    const info: Record<string, unknown> = {
      name: user.name,
      en_name: user.en_name,
      email: user.email,
      open_id: user.open_id,
      user_id: user.user_id,
      union_id: user.union_id,
    }
    if (!user.name && !user.email) {
      logger.error(
        { openId, appId, returnedFields: Object.keys(user).filter((k) => user[k] != null) },
        'Feishu fetchUserInfo: name and email are both empty — the app likely has the base scope (contact:contact.base:readonly) but is missing field-level scopes contact:user.base:readonly (name) and/or contact:user.email:readonly (email)',
      )
    }
    setCachedUserInfo(cacheKey, info)
    return info
  } catch (err) {
    logger.error(
      { err: summarizeFeishuError(err), openId, appId },
      'Feishu fetchUserInfo: API call failed — check app permissions and network',
    )
    return null
  }
}

type WSClientEntry = {
  wsClient: lark.WSClient
  client: lark.Client
  config: NormalizedFeishuConfig
  botOpenId?: string
  /** 最近一次轮询得到的底层 ws.readyState === OPEN */
  socketOpen: boolean
  lastWsError?: string
  lastStateChangeAt?: number
  pollTimer?: ReturnType<typeof setInterval>
}

// Per-process dedup cache keyed by `agentId:messageId`.
// Feishu delivers the same message_id to every bot App in a group; using a
// bare messageId would cause the first Agent to poison the cache for all
// subsequent Agents that legitimately need to handle the same message.
const MAX_DEDUP_CACHE = 2000
const processedMessageIds = new Set<string>()

function isDuplicate(agentId: string, messageId: string): boolean {
  const key = `${agentId}:${messageId}`
  if (processedMessageIds.has(key)) return true
  if (processedMessageIds.size >= MAX_DEDUP_CACHE) {
    // Evict oldest ~half when the cache is full
    const toDelete = [...processedMessageIds].slice(0, MAX_DEDUP_CACHE / 2)
    for (const id of toDelete) processedMessageIds.delete(id)
  }
  processedMessageIds.add(key)
  return false
}

/** 撤销 isDuplicate 登记（用于「先记后发」失败时回滚，使飞书 WS 重投能补发）。 */
function forgetDuplicate(agentId: string, messageId: string): void {
  processedMessageIds.delete(`${agentId}:${messageId}`)
}

export async function sendArtifactFiles(
  client: lark.Client,
  artifacts: { id: string; filename: string; storagePath: string; kind?: 'file' | 'directory' }[],
  chatId: string,
): Promise<void> {
  for (const artifact of artifacts) {
    try {
      let fileBuffer: Buffer
      let sendName = artifact.filename

      if (artifact.kind === 'directory') {
        // 源大小预检：避免把超大目录整个打进内存 zip 后才拒绝（对齐下载路由）
        const sourceSize = getDirectorySourceSize(artifact.storagePath)
        if (sourceSize > MAX_ZIP_SOURCE_BYTES) {
          logger.warn(
            { filename: artifact.filename, sourceSize },
            'Directory artifact source too large to zip, skipping Feishu file send',
          )
          continue
        }
        // 目录产物先打包为 zip 再发送（大小限制按 zip 后的体积判断）
        fileBuffer = zipDirectoryToBuffer(artifact.storagePath, artifact.filename)
        sendName = `${artifact.filename}.zip`
        if (fileBuffer.length > FEISHU_MESSAGE_RESOURCE_MAX_BYTES) {
          logger.warn(
            { filename: sendName, size: fileBuffer.length },
            'Zipped directory artifact exceeds 30MB, skipping Feishu file send',
          )
          continue
        }
      } else {
        const fileStat = statSync(artifact.storagePath)
        if (fileStat.size > FEISHU_MESSAGE_RESOURCE_MAX_BYTES) {
          logger.warn(
            { filename: artifact.filename, size: fileStat.size },
            'Artifact exceeds 30MB, skipping Feishu file send',
          )
          continue
        }
        fileBuffer = readFileSync(artifact.storagePath)
      }

      const uploadRes = await client.im.file.create({
        data: { file_type: 'stream', file: fileBuffer, file_name: sendName },
      })
      const fileKey = uploadRes?.file_key
      if (!fileKey) {
        logger.warn({ filename: artifact.filename }, 'Feishu file upload returned no file_key')
        continue
      }

      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ file_key: fileKey }),
          msg_type: 'file',
        },
      })
      logger.info({ filename: artifact.filename, fileKey }, 'Artifact sent as Feishu file')
    } catch (err) {
      logger.error({ err, filename: artifact.filename }, 'Failed to send artifact as Feishu file')
    }
  }
}

/**
 * 根据 context 向飞书发送私聊消息。
 * 当 context 包含 receive_id_type、receive_id 时，使用 agent 的 feishuConfig 创建客户端并发送。
 * 回复格式遵循 feishuConfig.replyContentType 和 cardTemplateId，与飞书 WebSocket 渠道一致。
 * 用于 API 触发场景（如 Gateway invoke），调用方手工拼写 context 指定回复目标。
 *
 * KNOWN LIMITATION: thread-scoped replies are not supported. Even if context
 * carries a thread_id (e.g. from a rerun of a topic-thread message), the
 * reply lands at the chat root. Tracked alongside the rerun thread_id TODO
 * in `routes/runs.ts:enrichRerunContext`.
 *
 * @returns true 若成功发送，false 若 context 不满足条件或发送失败
 */
/** The call context comes from outside (API / gateway / rerun), so validate
 * receive_id_type against the values the SDK accepts before passing it through. */
const RECEIVE_ID_TYPES = ['open_id', 'user_id', 'union_id', 'email', 'chat_id'] as const

function parseReceiveIdType(value: unknown): (typeof RECEIVE_ID_TYPES)[number] | undefined {
  return RECEIVE_ID_TYPES.find((t) => t === value)
}

export async function sendFeishuMessageByContext(
  agentId: string,
  context: Record<string, unknown>,
  content: string,
): Promise<boolean> {
  const receiveIdType = parseReceiveIdType(context.receive_id_type)
  const receiveId = context.receive_id as string | undefined
  if (!receiveIdType || !receiveId) {
    return false
  }

  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
  if (!agent) return false

  const channels = agent.publishChannels ?? []
  if (!channels.includes('feishu')) return false

  const rawFeishuConfig = agent.feishuConfig as Record<string, unknown> | null
  if (!rawFeishuConfig?.appId || !rawFeishuConfig?.appSecret) return false
  const feishuConfig = normalizeFeishuConfig(rawFeishuConfig)

  const replyContentType = feishuConfig.replyContentType ?? 'text'
  // interactive_card：此路径（API/网关/rerun 异步回复）不接续交互（无 WS 回调通道），
  // 但必须剥离 ```a2wave-card``` 声明块，避免把原始 JSON 当 markdown 暴露给用户（WS 路径已剥离）。
  const safeContent =
    replyContentType === 'interactive_card' ? parseInteractiveCardSpec(content).text : content
  const { msgType, replyContent } = buildFeishuReplyContent(
    safeContent,
    replyContentType,
    feishuConfig.cardTemplateId,
    { title: agent.name },
  )

  try {
    const client = new lark.Client({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
      loggerLevel: lark.LoggerLevel.error,
    })

    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: replyContent,
        msg_type: msgType,
      },
    })
    logger.info({ agentId, receiveIdType, receiveId, msgType }, 'Feishu message sent by context')
    return true
  } catch (err) {
    logger.error(
      { err, agentId, receiveIdType, receiveId },
      'Failed to send Feishu message by context',
    )
    return false
  }
}

class FeishuConnectionManager {
  private connections = new Map<string, WSClientEntry>()
  /** 同一飞书 appId 在本进程内同时仅允许一条 WS；value 为占用该槽位的 agentId */
  private appIdHolder = new Map<string, string>()
  /** 用于检测短时间反复断线，避免仅打 warn 难以发现 */
  private disconnectTimestamps = new Map<string, number[]>()

  /** 诊断用：当前进程内该 appId（trim 后）长连接槽位由谁占用，未占用则 undefined */
  getExclusiveSlotHolder(normalizedAppId: string): string | undefined {
    return this.appIdHolder.get(normalizedAppId.trim())
  }

  /** 获取 agent 的 REST API client（用于排队后执行时取新鲜引用） */
  getClient(agentId: string): lark.Client | undefined {
    return this.connections.get(agentId)?.client
  }

  private readUnderlyingReadyState(wsClient: lark.WSClient): number | undefined {
    try {
      const inst = (
        wsClient as unknown as {
          wsConfig?: { getWSInstance?: () => { readyState?: number } | null | undefined }
        }
      ).wsConfig?.getWSInstance?.()
      return inst?.readyState
    } catch {
      return undefined
    }
  }

  private pollWsState(agentId: string): void {
    const entry = this.connections.get(agentId)
    if (!entry) return
    const rs = this.readUnderlyingReadyState(entry.wsClient)
    const open = rs === WebSocket.OPEN
    if (open === entry.socketOpen) return

    entry.socketOpen = open
    entry.lastStateChangeAt = Date.now()
    const { appId } = entry.config

    if (open) {
      entry.lastWsError = undefined
      logger.info({ agentId, appId, feishuWsEvent: 'open' }, 'Feishu WS socket open')
      return
    }

    entry.lastWsError = rs === undefined ? 'no_underlying_socket' : `readyState_${rs}`
    logger.warn(
      { agentId, appId, feishuWsEvent: 'close', readyState: rs },
      'Feishu WS socket not open',
    )

    const now = Date.now()
    const recent = (this.disconnectTimestamps.get(agentId) ?? []).filter(
      (t) => now - t < FEISHU_WS_DISCONNECT_WINDOW_MS,
    )
    recent.push(now)
    this.disconnectTimestamps.set(agentId, recent)
    if (recent.length >= FEISHU_WS_DISCONNECT_THRESHOLD) {
      logger.error(
        { agentId, appId, feishuWsEvent: 'unstable', disconnectsInWindow: recent.length },
        'Feishu WS repeatedly lost connection',
      )
    }
  }

  private beginWsPolling(agentId: string): void {
    const entry = this.connections.get(agentId)
    if (!entry) return
    if (entry.pollTimer) clearInterval(entry.pollTimer)
    this.pollWsState(agentId)
    entry.pollTimer = setInterval(() => this.pollWsState(agentId), FEISHU_WS_POLL_MS)
  }

  private clearWsPolling(agentId: string): void {
    const entry = this.connections.get(agentId)
    if (entry?.pollTimer) {
      clearInterval(entry.pollTimer)
      entry.pollTimer = undefined
    }
    this.disconnectTimestamps.delete(agentId)
  }

  async start(agentId: string, rawConfig: FeishuConfig): Promise<void> {
    this.stop(agentId)
    const config = normalizeFeishuConfig(rawConfig as Record<string, unknown>)

    const { appId, appSecret } = config
    if (!appId || !appSecret) {
      logger.warn({ agentId }, 'Feishu config missing appId or appSecret, skipping connection')
      return
    }

    const appIdKey = appId.trim()
    const slotOwner = this.appIdHolder.get(appIdKey)
    if (slotOwner && slotOwner !== agentId) {
      logger.error(
        { agentId, appId: appIdKey, holderAgentId: slotOwner },
        'Feishu WS start rejected: same appId already held by another agent in this process',
      )
      return
    }

    // 在首个 await 之前占位，避免并发 start 竞态
    this.appIdHolder.set(appIdKey, agentId)

    try {
      const client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.error })

      // Fetch the bot's own open_id for accurate @mention detection.
      // Without this, we'd have to use the sequential key '@_user_1' which matches the first
      // @mention in any message — not necessarily the bot — causing false positive triggers.
      let botOpenId: string | undefined
      try {
        const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
        botOpenId = res?.bot?.open_id
        if (botOpenId) {
          logger.info({ agentId }, 'Feishu bot open_id fetched for mention detection')
        }
      } catch (err) {
        logger.warn(
          { err, agentId },
          'Failed to fetch Feishu bot open_id; @mention detection may have false positives when other users are mentioned first',
        )
      }

      const dispatcher = new lark.EventDispatcher({}).register({
        // Must NOT await handleMessage here — the SDK sends the ACK to Feishu only after
        // this handler returns. If we await the full LLM execution (which can take 30s+),
        // Feishu will time out and retry the event, causing duplicate runs.
        'im.message.receive_v1': (data: FeishuMessageEvent) => {
          this.handleMessage(agentId, client, config, data, botOpenId).catch((err) =>
            logger.error({ err, agentId }, 'Feishu message handler error'),
          )
        },
        // 机器人添加/收到表情反应时会投递；无处理器时 SDK 会 warn「no im.message.reaction.created_v1 handle」
        'im.message.reaction.created_v1': () => {},
        // 用户进入与机器人的 P2P 单聊（每次进入都触发，靠 last_message_create_time 做空闲判定）
        'im.chat.access_event.bot_p2p_chat_entered_v1': (data: FeishuChatEvent) => {
          this.handleP2pEntered(agentId, client, config, data).catch((err) =>
            logger.error({ err, agentId }, 'Feishu P2P entered handler error'),
          )
        },
        // 机器人被加入群聊（仅在加入瞬间触发一次，无需去重）
        'im.chat.member.bot.added_v1': (data: FeishuChatEvent) => {
          this.handleBotAddedToChat(agentId, client, config, data).catch((err) =>
            logger.error({ err, agentId }, 'Feishu bot-added handler error'),
          )
        },
        // 交互卡片回传（card.action.trigger，回调订阅走同一条长连接）。
        // 与上面的消息 handler 不同：这里必须 await 并 return —— 返回值会被 SDK 经 WS 回传给飞书，
        // 用于「就地更新卡片 + toast」（须 3 秒内）。resume 的 run 在 handleCardAction 内异步拉起，不在此 await。
        'card.action.trigger': (data: FeishuCardActionEvent) =>
          this.handleCardAction(agentId, client, config, data).catch((err) => {
            logger.error({ err, agentId }, 'Feishu card action handler error')
            return undefined
          }),
      })

      const wsClient = new lark.WSClient({
        appId,
        appSecret,
        autoReconnect: true,
        loggerLevel: lark.LoggerLevel.error,
      })

      const entry: WSClientEntry = {
        wsClient,
        client,
        config,
        botOpenId,
        socketOpen: false,
      }
      this.connections.set(agentId, entry)

      wsClient.start({ eventDispatcher: dispatcher })
      this.beginWsPolling(agentId)
      logger.info({ agentId, appId }, 'Feishu WS connection started')
    } catch (err) {
      if (this.appIdHolder.get(appIdKey) === agentId) {
        this.appIdHolder.delete(appIdKey)
      }
      const ent = this.connections.get(agentId)
      if (ent) {
        try {
          ;(ent.wsClient as { close?: (params?: { force?: boolean }) => void }).close?.({
            force: true,
          })
        } catch {
          /* ignore */
        }
        this.connections.delete(agentId)
      }
      logger.error({ err, agentId, appId: appIdKey }, 'Feishu WS start failed')
      throw err
    }
  }

  /**
   * 本 API 进程内的飞书长连接状态（多副本部署时仅代表当前实例）。
   */
  getFeishuConnectionStatuses(): Array<{ agentId: string; socketOpen: boolean }> {
    return [...this.connections.entries()].map(([agentId, e]) => ({
      agentId,
      socketOpen: e.socketOpen,
    }))
  }

  isRegistered(agentId: string): boolean {
    return this.connections.has(agentId)
  }

  isSocketOpen(agentId: string): boolean {
    return this.connections.get(agentId)?.socketOpen ?? false
  }

  stop(agentId: string): void {
    const entry = this.connections.get(agentId)
    if (!entry) return
    const appIdKey = entry.config.appId?.trim()
    this.clearWsPolling(agentId)
    try {
      ;(entry.wsClient as { close?: (params?: { force?: boolean }) => void }).close?.({
        force: true,
      })
    } catch (err) {
      logger.warn({ err, agentId }, 'Error stopping Feishu WS client')
    }
    this.connections.delete(agentId)
    if (appIdKey && this.appIdHolder.get(appIdKey) === agentId) {
      this.appIdHolder.delete(appIdKey)
    }
    logger.info({ agentId }, 'Feishu WS connection stopped')
  }

  stopAll(): void {
    for (const agentId of this.connections.keys()) {
      this.stop(agentId)
    }
  }

  async restoreConnections(): Promise<void> {
    const publishedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.publishStatus, 'published'))

    const feishuCandidates = publishedAgents.filter((agent) => {
      const channels = agent.publishChannels ?? []
      if (!channels.includes('feishu')) return false
      return Boolean(agent.feishuConfig)
    })
    feishuCandidates.sort((a, b) => a.id.localeCompare(b.id))

    for (const agent of feishuCandidates) {
      // feishuConfig is non-null here — guarded by the filter above
      const feishuConfig = agent.feishuConfig as FeishuConfig
      await this.start(agent.id, feishuConfig).catch((err) =>
        logger.error({ err, agentId: agent.id }, 'Failed to restore Feishu connection'),
      )
    }
    logger.info(`Feishu connections restored: ${this.connections.size} active`)
  }

  /**
   * 处理交互卡片回传（card.action.trigger，经长连接下发）。
   * 返回值会被 SDK 经 WS 回传给飞书，用于「就地更新卡片 + toast」（须 3 秒内返回）。
   * 因此此处只做快速操作（DB 核销 + 构建结果卡片），resume 的 run 异步拉起、不在此 await。
   */
  private async handleCardAction(
    agentId: string,
    client: lark.Client,
    config: NormalizedFeishuConfig,
    data: FeishuCardActionEvent,
  ): Promise<unknown> {
    const action = data?.action ?? {}
    // action.value 多数为 object；个别版本可能下发字符串，做一次兜底解析。
    let value = action?.value as CardCallbackValue | string | undefined
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as CardCallbackValue
      } catch {
        value = undefined
      }
    }
    const cbId = value && typeof value === 'object' ? value.cb : undefined
    const rawAction = value && typeof value === 'object' ? value.action : undefined
    if (!cbId) {
      logger.warn({ agentId }, 'Feishu card action: missing cb id in value')
      return undefined
    }

    const row = (
      await db.select().from(feishuCardCallbacks).where(eq(feishuCardCallbacks.id, cbId)).limit(1)
    )[0]
    const operatorOpenId = data?.operator?.open_id as string | undefined
    // 核销前的全部同步判定（动作合法性 / 归属 / 仅发起人 / 已处理 / 过期）抽成纯函数 decideCardAction，
    // 便于单测覆盖防伪/防重放/防越权点击；副作用（过期置 used、原子核销、resume）仍留在本方法。
    const gate = decideCardAction({ agentId, rawAction, operatorOpenId, row, now: Date.now() })
    switch (gate.kind) {
      case 'invalid-action':
        // 未知/缺失动作不默认成 confirm（否则会误触发 resume 续跑）。
        logger.warn({ agentId, cbId, rawAction }, 'Feishu card action: invalid action')
        return { toast: { type: 'error', content: '卡片操作无效' } }
      case 'invalid-card':
        return { toast: { type: 'error', content: '卡片已失效' } }
      case 'not-owner':
        // 仅卡片接收者可点；他人误点既不核销也不续跑，触发者仍可正常操作。
        return { toast: { type: 'error', content: '只有发起人可以操作此卡片' } }
      case 'already-used':
        return { toast: { type: 'info', content: '该卡片已处理' } }
      case 'expired':
        await db
          .update(feishuCardCallbacks)
          .set({ status: 'used' })
          .where(eq(feishuCardCallbacks.id, cbId))
        return { toast: { type: 'error', content: '卡片已过期' } }
    }
    // gate.kind === 'proceed' 时 decideCardAction 已确保 row 存在且归属本 agent；
    // 这里再做一次显式收窄，让 TS 把 row 当作非空（运行时不会触发）。
    if (!row) return { toast: { type: 'error', content: '卡片已失效' } }
    const actionType: CardCallbackValue['action'] = gate.action

    // 原子核销：仅当仍为 pending 才置 used，并据受影响行数判断是否「抢到」。
    // 挡住重复点击 / 事件重投 / 多处理者竞态——select 后再无条件 update 存在 TOCTOU。
    const claim = await db
      .update(feishuCardCallbacks)
      .set({ status: 'used' })
      .where(and(eq(feishuCardCallbacks.id, cbId), eq(feishuCardCallbacks.status, 'pending')))
      .returning({ id: feishuCardCallbacks.id })
    if (claim.length !== 1) {
      return { toast: { type: 'info', content: '该卡片已处理' } }
    }

    let spec: InteractiveCardSpec
    try {
      spec = JSON.parse(row.spec) as InteractiveCardSpec
    } catch {
      return { toast: { type: 'error', content: '卡片数据异常' } }
    }

    const formValue = action?.form_value as Record<string, unknown> | undefined
    const summary = summarizeCardAction(spec, actionType, formValue)

    // 异步拉起 resume run（不 await，保证 3s 内返回卡片更新）。取消不续跑。
    if (gate.resume) {
      const openMessageId = (data?.context?.open_message_id as string | undefined) ?? row.messageId
      this.resumeFromCardAction({
        agentId,
        client,
        config,
        row,
        feedbackText: summary.feedbackText,
        operatorOpenId,
        openMessageId: openMessageId ?? undefined,
      }).catch((err) => logger.error({ err, agentId, cbId }, 'Feishu card resume failed'))
    }

    // 就地更新：toast + 去掉交互组件、追加结果行（防二次点击）。
    // 标题栏与发卡时保持一致（spec.title 优先，否则用机器人名）。
    const agentRow = (
      await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1)
    )[0]
    return {
      toast: { type: actionType === 'cancel' ? 'info' : 'success', content: summary.toast },
      card: {
        type: 'raw',
        // 调试信息后缀发卡时已持久化（row.debugSuffix），就地更新卡片时原样复用，保持底部一致。
        data: buildResolvedCardJson(
          spec,
          summary.resultLine,
          { title: agentRow?.name },
          row.debugSuffix ?? undefined,
        ),
      },
    }
  }

  /**
   * 用一条合成「用户消息」喂回 handleMessage，复用执行/回复/再次发卡链路，
   * 并用快照的 triggerSessionId / previousChatId 续接到发卡时的同一会话。
   */
  private async resumeFromCardAction(opts: {
    agentId: string
    client: lark.Client
    config: NormalizedFeishuConfig
    row: typeof feishuCardCallbacks.$inferSelect
    feedbackText: string
    operatorOpenId?: string
    openMessageId?: string
  }): Promise<void> {
    const { agentId, client, config, row, feedbackText, operatorOpenId, openMessageId } = opts
    const syntheticData = {
      message: {
        // message_id 用卡片消息 id：去重 / 贴回执表情都锚在用户点击的卡片上，且与首轮提问 id 不同
        // 不会被误判为重复消息。
        message_id: openMessageId ?? `cardcb-${row.id}`,
        // quote_message_id 指向最初提问：续跑的回复永远挂在初始问题下，而非中间卡片，
        // 避免群里回复链层层套娃。无原始 id（历史记录）时回退到卡片消息 id。
        quote_message_id: row.originalMessageId ?? openMessageId ?? undefined,
        chat_id: row.chatId,
        chat_type: row.chatType ?? undefined,
        thread_id: row.threadId ?? undefined,
        message_type: 'text',
        content: JSON.stringify({ text: feedbackText }),
      },
      sender: operatorOpenId
        ? { sender_type: 'user', sender_id: { open_id: operatorOpenId } }
        : undefined,
    }
    await this.handleMessage(agentId, client, config, syntheticData, undefined, {
      cardResume: {
        sessionId: row.triggerSessionId,
        previousChatId: row.previousChatId,
        // 有真实卡片消息 id 时才在其上贴回执表情；合成兜底 id（无消息可贴）则跳过。
        hasCardMessage: !!openMessageId,
      },
    })
  }

  private async handleMessage(
    agentId: string,
    client: lark.Client,
    config: NormalizedFeishuConfig,
    data: FeishuMessageEvent,
    botOpenId?: string,
    options: {
      replay?: boolean
      extraPlugins?: readonly LifecyclePlugin[]
      clientOverride?: lark.Client
      /**
       * 交互卡片回调触发的 session 续跑：跳过 shouldTrigger（回执表情仍会贴到卡片消息上），
       * 并用快照覆盖 triggerSessionId / previousChatId，保证续接到同一会话。
       * hasCardMessage：是否有真实卡片消息 id 可贴回执表情（无则 message_id 为合成兜底值）。
       */
      cardResume?: { sessionId: string; previousChatId: string | null; hasCardMessage: boolean }
    } = {},
  ): Promise<void> {
    // ── Pre-queue: lightweight validation & text extraction (zero network IO) ──
    const { message } = data
    if (!message) {
      logger.warn(
        { agentId, dataKeys: Object.keys(data ?? {}) },
        'Feishu: message field missing from handler data – possible SDK event wrapping issue',
      )
      return
    }
    // Real events always carry both; the payload type keeps them optional so partial
    // objects stay constructible, so pin them once here instead of at every read.
    const messageType = message.message_type ?? 'text'
    const messageContent = message.content ?? ''

    // text / image / post / mixed / file / interactive（飞书项目/自定义卡片等卡片推送消息）
    if (!['text', 'image', 'post', 'mixed', 'file', 'interactive'].includes(messageType)) {
      logger.info(
        { agentId, messageType, messageId: message.message_id },
        'Feishu: unsupported message_type, skipping',
      )
      return
    }

    logger.info(
      {
        agentId,
        messageId: message.message_id,
        messageType: message.message_type,
        content: message.content,
      },
      'Feishu: raw message received',
    )

    // Dedup: skip messages already processed in this process lifetime
    // (Feishu replays unACKed events on WS reconnection)
    if (isDuplicate(agentId, message.message_id)) {
      logger.warn(
        { agentId, messageId: message.message_id },
        'Feishu duplicate message_id, skipping',
      )
      return
    }

    if (!options.cardResume && !shouldTrigger(config, message, botOpenId)) {
      logger.info(
        {
          agentId,
          messageId: message.message_id,
          chatType: message.chat_type,
          mentions: message.mentions,
          botOpenId,
          groupTriggerOnAt: config.groupTriggerOnAt,
          groupTriggerOnNewMessage: config.groupTriggerOnNewMessage,
          topicTriggerOnAt: config.topicTriggerOnAt,
          topicTriggerOnNewTopic: config.topicTriggerOnNewTopic,
          topicTriggerOnNewComment: config.topicTriggerOnNewComment,
        },
        'Feishu: shouldTrigger=false, skipping',
      )
      return
    }

    let replyText = extractText(messageContent, false, messageType)
    const imageKeys = extractImageKeys(messageContent, messageType)
    logger.info(
      {
        agentId,
        messageId: message.message_id,
        extractedText: replyText,
        imageKeys,
        imageKeyCount: imageKeys.length,
      },
      'Feishu: extracted text and image keys',
    )

    // Agent 早加载：router 需要 engineType 做 capability 校验
    const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
    if (!agent || agent.publishStatus !== 'published') return

    // Provider 配置不可用（链全禁用 / 指向已删除 Provider / 超长）时，buildAgentConfig
    // 抛错。这里必须捕获并回执：异常若冒泡到 dispatcher 只会被 logger.error 吞掉，
    // 用户既收不到任何回复也没有 Run 记录，表现为「机器人已读不回」。
    let agentConfig: Awaited<ReturnType<typeof buildAgentConfig>>
    try {
      agentConfig = await buildAgentConfig(agent)
    } catch (err) {
      if (err instanceof ProviderConfigurationError) {
        logger.error(
          { agentId, code: err.code, error: err.message },
          'Feishu: agent provider configuration unusable; replying with a failure notice',
        )
        await sendFeishuFailureReply(
          client,
          data.sender,
          message,
          config,
          buildFeishuProviderConfigErrorText(),
        )
        return
      }
      throw err
    }
    // 交互卡片：仅当回复格式为 interactive_card 时注入规范提示词（不动通用 buildAgentConfig）。
    // 走独立字段而非拼接 systemPrompt，prompt-builder 会渲染为独立 <interactive_card> 标签
    // （与 <available_agents> 同构，不混入 <instructions>）。
    if (config.replyContentType === 'interactive_card') {
      agentConfig.interactiveCardPrompt = INTERACTIVE_CARD_PROMPT
    }
    const agentEngineType = resolveEngineType(agentConfig, agent.type as string)

    // 飞书指令通道：core:command-dispatch 在 onAuthenticated 匹配前缀，
    // 命中后 matchedCommand / strippedText / pendingCommandPlugin 写在 authCtx 上；
    // chatIdOverride / preAck 由对应 CommandPlugin.onBeforeRun 在 executeJob 内填入。
    const plugins = [
      ...buildDefaultPlugins(),
      ...(env.NODE_ENV !== 'production' ? (options.extraPlugins ?? []) : []),
    ]
    // 派生 messageContext：commandsPlugin 用 allowedContexts 过滤命令时读取。
    // isThreadReply：飞书的 root_id 指向回复链根；root_id !== message_id 即非顶层。
    const isThreadReply = !!(message.root_id && message.root_id !== message.message_id)
    const authCtx: AuthenticatedCtx & Partial<MatchedCtx> = {
      channelId: 'feishu',
      rawEvent: data,
      rawText: replyText,
      sender: {
        userId: data.sender?.sender_id?.user_id ?? '',
        openId: data.sender?.sender_id?.open_id,
      },
      messageKey: message.message_id,
      meta: {},
      channelConfig: config,
      messageContext: {
        chatType: message.chat_type === 'p2p' ? 'p2p' : 'group',
        isThreadReply,
      },
      agent: agent as never,
      agentConfig,
      engineType: agentEngineType,
    }
    await emit('onAuthenticated', authCtx as AuthenticatedCtx, plugins)
    if (authCtx.aborted) {
      const reason = authCtx.abortReason?.message ?? '命令执行出错，请稍后重试'
      logger.info(
        {
          agentId,
          messageId: message.message_id,
          code: authCtx.abortReason?.code,
          reason,
        },
        'Feishu: pipeline aborted in onAuthenticated',
      )
      await sendFeishuUserNotification(client, data.sender, message, config, reason)
      return
    }
    const mctx = authCtx as AuthenticatedCtx & MatchedCtx
    replyText = mctx.strippedText
    const matchedCommand = mctx.matchedCommand
    // keepPrefix（/compact 旧逃逸口）已删除——没有命令再需要 native prompt 路径。
    const keepNativePrompt = false
    const pluginCtx: AuthenticatedCtx & MatchedCtx & Partial<RunCtx> = mctx

    // 简化 intent：仅用当前消息文本；话题根消息不再额外拉取并拼入 prompt。
    // 话题回复中用户可能只 @bot 不附加文字，此时 replyText 为空但 root_id 存在
    const hasRootMessage = message.root_id && message.root_id !== message.message_id
    const intent =
      replyText ||
      (imageKeys.length > 0 ? '[图片]' : '') ||
      (message.message_type === 'file' ? '[文件]' : '') ||
      (hasRootMessage ? '[话题回复]' : '')
    if (!intent) {
      logger.info(
        { agentId, messageId: message.message_id, matchedCommand },
        'Feishu: empty intent after extraction, skipping',
      )
      return
    }
    // 立即回执：在消息上添加 emoji，告知「已收到、处理中」。
    // 卡片续跑同样回执——目标为卡片消息（点击提交后 Agent 要重新生成回复、可能耗时，需要反馈）；
    // 仅当续跑没有真实卡片消息可贴（hasCardMessage=false，message_id 为合成兜底值）时才跳过。
    const reactionMessageId =
      options.cardResume && !options.cardResume.hasCardMessage ? null : message.message_id
    if (reactionMessageId) {
      client.im.messageReaction
        .create({
          path: { message_id: reactionMessageId },
          data: { reaction_type: { emoji_type: 'Get' } },
        })
        .catch((err: unknown) => logger.warn({ err }, 'Failed to add Feishu reaction'))
    }

    logger.info(
      {
        agentId,
        chatType: message.chat_type,
        messageId: message.message_id,
        intent,
        matchedCommand,
      },
      'Feishu message received, intent resolved',
    )

    // 卡片续跑用快照覆盖会话标识与上一次引擎 chatId，保证续接到发卡时的同一会话；
    // 普通消息按 message 推导 triggerSessionId，再查上一次 chatId 实现多轮续接。
    const triggerSessionId = options.cardResume
      ? options.cardResume.sessionId
      : buildTriggerSessionId(message)
    const previousChatId: string | null | undefined = options.cardResume
      ? // 优先用发卡时快照的 chatId；缺失（极端：发卡那轮无 chatId）再按 sessionId 兜底查最近一轮，
        // 避免续跑时新开一个引擎会话、丢掉发卡那轮上下文。
        (options.cardResume.previousChatId ??
        (triggerSessionId
          ? await lookupPreviousChatId(agentId, triggerSessionId, Number.POSITIVE_INFINITY)
          : undefined))
      : triggerSessionId
        ? await lookupPreviousChatId(
            agentId,
            triggerSessionId,
            message.thread_id || message.root_id
              ? Number.POSITIVE_INFINITY
              : P2P_SESSION_TIMEOUT_MS,
          )
        : undefined
    // chatIdOverride 和 preAck 由 commandsPlugin.onBeforeRun 在 runCtx 上设置；
    // 必须在 executeJob 内 emit('onBeforeRun') 之后再 apply，因为 runId/taskId/payload
    // 此时尚未构建。

    logger.info(
      {
        agentId,
        messageId: message.message_id,
        chatType: message.chat_type,
        triggerSessionId,
        resumeWithChatId: !!previousChatId,
        previousChatIdPrefix: previousChatId ? previousChatId.slice(0, 12) : undefined,
      },
      'Feishu session resolved',
    )

    // ── DB-backed pending event persistence (restart recovery) ──
    // Persist the raw event BEFORE inserting the run, so even if we crash
    // mid-insert we still have enough to replay on restart.
    const pendingPayload: FeishuEventPayload = {
      message,
      sender: data.sender ?? {},
    }
    // Awaited: the reservation transaction below reads this very row back
    // (`feishu_pending_messages` by message_id) and skips the message when it is
    // missing, so an unawaited insert loses the event outright — and a crash
    // between here and the run insert would leave nothing to replay.
    await persistPendingMessage(message.message_id, agentId, pendingPayload)

    /** Remove the persisted pending row — always safe to call. */
    const removePending = async () => {
      try {
        // Awaited inside the try: the delete is async, so a bare call rejects
        // after this frame has returned and the catch below can never see it.
        await removePendingMessage(message.message_id, agentId)
      } catch (err) {
        logger.warn({ err, messageId: message.message_id }, 'Feishu: removePendingMessage failed')
      }
    }

    const reservation = await withTransaction(async (tx) => {
      const newRunId = createId('run')
      const existingPendingRow = (
        await tx
          .select({ runId: feishuPendingMessages.runId })
          .from(feishuPendingMessages)
          // Scoped to this Agent: the same message_id is delivered to every bot
          // in the chat, so an unscoped read picks up the *other* Agent's row
          // and skips this message as a duplicate of a run that is not ours.
          .where(
            and(
              eq(feishuPendingMessages.messageId, message.message_id),
              eq(feishuPendingMessages.agentId, agentId),
            ),
          )
          .limit(1)
      )[0]

      if (!existingPendingRow) {
        logger.warn(
          { agentId, messageId: message.message_id },
          'Feishu pending row disappeared before run reservation',
        )
        return { status: 'skip' as const, reason: 'missing-pending-row' }
      }

      const existingRunId = existingPendingRow.runId
      if (existingRunId) {
        const priorRun = (
          await tx
            .select({ id: runs.id, status: runs.status })
            .from(runs)
            .where(eq(runs.id, existingRunId))
            .limit(1)
        )[0]

        if (priorRun?.status === 'pending' || priorRun?.status === 'queued') {
          if (!options.replay) {
            return { status: 'skip' as const, reason: 'duplicate-active-run', runId: priorRun.id }
          }
          const error = FAILURE_REASONS.REPLACED_BY_REPLAY
          await tx
            .update(runSteps)
            .set({ status: 'cancelled', output: { error } })
            .where(eq(runSteps.runId, priorRun.id))
          await tx
            .update(runs)
            .set({ status: 'cancelled', result: { error }, updatedAt: new Date() })
            .where(eq(runs.id, priorRun.id))
          logger.info(
            { agentId, messageId: message.message_id, priorRunId: priorRun.id },
            'Feishu replay cancelled prior orphaned run',
          )
        } else if (priorRun?.status === 'running') {
          return { status: 'skip' as const, reason: 'prior-run-running', runId: priorRun.id }
        } else if (priorRun?.status === 'completed' || !options.replay) {
          return {
            status: 'skip' as const,
            reason: priorRun ? 'terminal-run-already-recorded' : 'stale-run-reference',
            runId: existingRunId,
          }
        }

        const replaced = await tx
          .update(feishuPendingMessages)
          .set({ runId: newRunId })
          .where(
            and(
              eq(feishuPendingMessages.messageId, message.message_id),
              eq(feishuPendingMessages.agentId, agentId),
              eq(feishuPendingMessages.runId, existingRunId),
            ),
          )
          .returning({ messageId: feishuPendingMessages.messageId })
        if (replaced.length === 0) {
          return { status: 'skip' as const, reason: 'pending-row-claimed' }
        }
      } else {
        const claimed = await tx
          .update(feishuPendingMessages)
          .set({ runId: newRunId })
          .where(
            and(
              eq(feishuPendingMessages.messageId, message.message_id),
              eq(feishuPendingMessages.agentId, agentId),
              isNull(feishuPendingMessages.runId),
            ),
          )
          .returning({ messageId: feishuPendingMessages.messageId })
        if (claimed.length === 0) {
          return { status: 'skip' as const, reason: 'pending-row-claimed' }
        }
      }

      await tx.insert(runs).values({
        id: newRunId,
        intent,
        initiatorAgentId: agentId,
        status: 'pending',
        triggerSource: 'feishu',
        triggerSessionId: triggerSessionId ?? null,
      })

      return { status: 'reserved' as const, runId: newRunId }
    })

    if (reservation.status !== 'reserved') {
      logger.warn(
        { agentId, messageId: message.message_id, reservation },
        'Feishu message skipped during run reservation',
      )
      if (reservation.reason === 'terminal-run-already-recorded') await removePending()
      return
    }

    const runId = reservation.runId

    const slotResult = await tryAcquireSlot(taskQueueDb, agentId, runId, agent.maxConcurrency ?? 1)
    if (slotResult === 'queue_full') {
      await db.delete(runs).where(eq(runs.id, runId))
      await removePending()
      logger.warn({ agentId }, 'Feishu: agent queue full, dropping message')
      return
    }

    /** Fail the run and release the concurrency slot so queued runs can proceed. */
    const failRunAndReleaseSlot = async (error: string) => {
      await recoverRunStartup({
        runId,
        agentId,
        settleRun: () =>
          db
            .update(runs)
            .set({ status: 'failed', result: { error }, updatedAt: new Date() })
            .where(eq(runs.id, runId)),
      })
    }

    // ── Streaming card: create before queue decision so queued jobs show "排队中..." ──
    const replyContentType = config.replyContentType ?? 'text'
    const replyMode = getEffectiveReplyMode(config, message)
    let card: FeishuStreamingCard | undefined
    if (replyContentType === 'streaming_card' && replyMode !== 'none') {
      try {
        card = await FeishuStreamingCard.create(client)
        await card.send(
          message.chat_id,
          replyMode === 'quote' ? quoteAnchorId(message) : undefined,
          replyMode,
        )
        if (slotResult === 'queued') {
          card.updateContent('⏳ 排队中...')
        }
      } catch (err) {
        logger.error({ err, agentId, runId }, 'Failed to create/send streaming card')
        card = undefined
        const errMsg = err instanceof Error ? err.message : String(err)
        const hint = '流式卡片创建失败，请检查飞书应用是否已开通 cardkit:card:write 权限。'
        const errContent = JSON.stringify({
          zh_cn: {
            title: '⚠️ 流式卡片错误',
            content: [[{ tag: 'text', text: `${hint}\n\n错误详情: ${errMsg}` }]],
          },
        })
        try {
          if (replyMode === 'quote') {
            await client.im.message.reply({
              path: { message_id: quoteAnchorId(message) },
              data: { content: errContent, msg_type: 'post' },
            })
          } else {
            await client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: { receive_id: message.chat_id, content: errContent, msg_type: 'post' },
            })
          }
        } catch (replyErr) {
          logger.error(
            { err: replyErr, agentId, runId },
            'Failed to send streaming card error notification',
          )
        }
        await failRunAndReleaseSlot('Streaming card creation failed')
        await removePending()
        return
      }
    }

    // ── Snapshot values for closure (lightweight, immutable) ──
    const showLocalChildOutput = agent.showLocalChildOutput ?? true
    const showRemoteChildOutput = agent.showRemoteChildOutput ?? true
    const sender = data.sender
    const wantSendFiles = config.sendArtifactsAsFile !== false

    // ── Execute job: all heavy IO (downloads, CC execution) ──
    const executeJob = async () => {
      let imageTempDir: string | undefined
      let fileTempDir: string | undefined
      let rootTempDir: string | undefined
      let lifecycleParams:
        | {
            taskId: string
            runId: string
            stepId: string
            agentId: string
            startTime: number
            workDir: string
          }
        | undefined
      let runFinalized = false
      const triggerSenderOpenId = sender?.sender_id?.open_id
      // Ungated on replyContentType by design — see resolveFeishuMentionRootId's contract.
      let replyMentionOpenId = resolveFeishuReplyMentionOpenId(
        config.topicReplyMentionTarget,
        message,
        triggerSenderOpenId,
      )
      try {
        const freshClient = options.clientOverride ?? feishuConnectionManager.getClient(agentId)
        if (!freshClient) {
          logger.error({ agentId, runId }, 'Feishu client not available for executeJob')
          await failRunAndReleaseSlot('Feishu client disconnected')
          if (card) {
            card.updateContent('⚠️ 飞书连接已断开')
            await card.finish()
          }
          return
        }

        let rootText = ''
        let rootImagePaths: string[] = []
        let rootFilePaths: string[] = []
        const contentRootId = resolveFeishuTopicRootId(
          config.topicInjectRootMessage,
          keepNativePrompt,
          message,
        )
        const mentionRootId = resolveFeishuMentionRootId(
          config.topicReplyMentionTarget,
          replyContentType,
          message,
        )
        // The content injection and mention lookup share one Feishu request when both are enabled.
        const rootId = contentRootId ?? mentionRootId
        if (rootId) {
          try {
            const resp = await freshClient.im.message.get({
              path: { message_id: rootId },
            })
            const rootMsg = resp?.data?.items?.[0]
            replyMentionOpenId = resolveFeishuReplyMentionOpenId(
              config.topicReplyMentionTarget,
              message,
              triggerSenderOpenId,
              rootMsg?.sender,
            )
            if (mentionRootId && !replyMentionOpenId)
              warnFeishuTopicCreatorUnavailable({ agentId, rootId })
            if (contentRootId && rootMsg?.body?.content) {
              const rootMsgType = rootMsg.msg_type || 'text'
              rootText = extractText(rootMsg.body.content, true, rootMsgType)
              const rootImageKeys = extractImageKeys(rootMsg.body.content, rootMsgType)
              if (rootImageKeys.length > 0) {
                logger.info(
                  { agentId, rootId, rootImageKeys },
                  'Feishu: extracting images from topic root message',
                )
                const rootDownloadRootDir = buildFeishuImageDownloadRootDir(agentId, runId)
                rootTempDir = rootDownloadRootDir
                const rootDownloadDir = buildFeishuMessageResourceDownloadDir(rootDownloadRootDir)
                const downloaded = await downloadFeishuImages(
                  freshClient,
                  rootId,
                  rootImageKeys,
                  rootDownloadDir,
                )
                rootImagePaths = downloaded.paths
              }
              if (rootMsgType === 'file') {
                const rootMeta = extractFileMeta(rootMsg.body.content)
                if (rootMeta) {
                  const safeRootName = feishuSafeFileNameForDisk(
                    rootMeta.fileName,
                    rootMeta.fileKey,
                  )
                  const rootDownloadRootDir = buildFeishuFileDownloadRootDir(agentId, runId)
                  rootTempDir = rootDownloadRootDir
                  const rootDownloadDir = buildFeishuMessageResourceDownloadDir(rootDownloadRootDir)
                  const rootDl = await downloadFeishuFile(
                    freshClient,
                    rootId,
                    rootMeta.fileKey,
                    safeRootName,
                    FEISHU_MESSAGE_RESOURCE_MAX_BYTES,
                    rootDownloadDir,
                  )
                  if (rootDl.ok) {
                    rootFilePaths = [rootDl.path]
                    const rootFileHint = buildFeishuFileHint(rootMeta.fileName, rootDl.path)
                    rootText = mergeFeishuTopicRootText(rootText, rootFileHint)
                  } else if (rootDl.reason === 'too_large') {
                    await sendFeishuUserNotification(
                      freshClient,
                      sender,
                      message,
                      config,
                      '话题根文件超过平台允许大小（最大 30MB），请压缩或拆分后重新发送。',
                    )
                    await failRunAndReleaseSlot('Root file too large')
                    if (card) {
                      card.updateContent('⚠️ 话题根文件过大')
                      await card.finish()
                    }
                    return
                  }
                }
              }
            }
            logger.info(
              {
                agentId,
                rootId,
                rootText: rootText.slice(0, 100),
                rootImageCount: rootImagePaths.length,
                rootFileCount: rootFilePaths.length,
              },
              'Fetched topic root message',
            )
          } catch (err) {
            logger.warn({ err, agentId, rootId }, 'Failed to fetch topic root message')
            if (mentionRootId) warnFeishuTopicCreatorUnavailable({ agentId, rootId })
          }
        }

        // ── Download current message files ──
        let mainText = mergeFeishuTopicRootText(rootText, replyText)

        let currentFilePaths: string[] = []
        if (messageType === 'file') {
          const meta = extractFileMeta(messageContent)
          if (!meta) {
            await sendFeishuUserNotification(
              freshClient,
              sender,
              message,
              config,
              '无法识别消息中的文件，请重新发送。',
            )
            await failRunAndReleaseSlot('Cannot parse file metadata')
            if (card) {
              card.updateContent('⚠️ 无法识别文件')
              await card.finish()
            }
            return
          }
          const safeName = feishuSafeFileNameForDisk(meta.fileName, meta.fileKey)
          const downloadRootDir = buildFeishuFileDownloadRootDir(agentId, runId)
          fileTempDir = downloadRootDir
          const downloadDir = buildFeishuMessageResourceDownloadDir(downloadRootDir)
          const dl = await downloadFeishuFile(
            freshClient,
            message.message_id,
            meta.fileKey,
            safeName,
            FEISHU_MESSAGE_RESOURCE_MAX_BYTES,
            downloadDir,
          )
          if (!dl.ok) {
            const tip =
              dl.reason === 'too_large'
                ? '文件超过平台允许大小（最大 30MB），请压缩或拆分后重新发送。'
                : '文件下载失败，请稍后重试或检查应用权限（消息资源下载）。'
            await sendFeishuUserNotification(freshClient, sender, message, config, tip)
            await failRunAndReleaseSlot(tip)
            if (card) {
              card.updateContent('⚠️ 文件下载失败')
              await card.finish()
            }
            return
          }
          currentFilePaths = [dl.path]
          const fileHint = buildFeishuFileHint(meta.fileName, dl.path)
          mainText = mainText ? `${mainText}\n\n---\n${fileHint}` : fileHint
        }

        // ── Download current message images ──
        let imagePaths: string[] = [...rootImagePaths]
        if (imageKeys.length > 0) {
          logger.info(
            { agentId, messageId: message.message_id, imageKeys },
            'Feishu: downloading images',
          )
          const downloadRootDir = buildFeishuImageDownloadRootDir(agentId, runId)
          imageTempDir = downloadRootDir
          const downloadDir = buildFeishuMessageResourceDownloadDir(downloadRootDir)
          const downloaded = await downloadFeishuImages(
            freshClient,
            message.message_id,
            imageKeys,
            downloadDir,
          )
          imagePaths = [...imagePaths, ...downloaded.paths]
          const tempDir = downloaded.dir
          logger.info(
            { agentId, messageId: message.message_id, imagePaths, tempDir },
            'Feishu: images downloaded',
          )
        }
        const imageHint = imagePaths.length > 0 ? feishuImageHintForPrompt(imagePaths) : ''
        if (imageHint) {
          mainText = mainText ? `${mainText}\n\n---\n${imageHint}` : imageHint
        }

        const fullPrompt = keepNativePrompt
          ? replyText
          : mainText || (imagePaths.length > 0 ? '[图片]' : '') || intent

        // ── Fetch sender user info (if enabled) ──
        let senderUserInfo: Record<string, unknown> | null = null
        if (config.fetchUserInfo) {
          const senderOpenId = sender?.sender_id?.open_id
          if (senderOpenId) {
            senderUserInfo = await fetchFeishuUserInfo(freshClient, senderOpenId, config.appId)
          }
        }

        // ── Build context, step, payload ──
        const { context: feishuContext, displayName: feishuDisplayName } = buildFeishuContext(
          sender,
          message,
          senderUserInfo,
          config.appId,
        )
        if (imagePaths.length > 0) {
          feishuContext.images = imagePaths
        }
        const allFilePaths = [...rootFilePaths, ...currentFilePaths]
        if (allFilePaths.length > 0) {
          feishuContext.files = allFilePaths
        }
        logger.info(
          { agentId, messageId: message.message_id, feishuContext },
          'Feishu: context built',
        )

        // Strategy Z: feishu runs were reserved earlier (line ~1454) before user
        // info was fetched. Backfill triggerUserName here, post-fetch, so the
        // runs list can show the sender's name without a JOIN. Idempotent —
        // re-applying the same value is harmless; failure is non-fatal (the run
        // still executes, just shows only the channel tag).
        if (feishuDisplayName) {
          await db
            .update(runs)
            .set({ triggerUserName: feishuDisplayName })
            .where(eq(runs.id, runId))
        }

        let resolvedWorkDir: string
        try {
          resolvedWorkDir = await resolveWorkDir(agent, undefined, runId, agentConfig.agentEnv)
        } catch (err) {
          await failRunAndReleaseSlot(err instanceof Error ? err.message : String(err))
          return
        }

        const stepId = createId('rst')
        await persistRunTurn({
          step: {
            id: stepId,
            runId,
            agentId,
            order: 1,
            input: { message: fullPrompt, context: feishuContext },
            status: 'running',
          },
          message: { id: createId('msg'), runId, role: 'user', content: fullPrompt },
        })

        // 不在此创建 collector：runWithLifecycle 内部已 createPersistingLogCollector +
        // registerLogCollector，Web UI 通过该 collector 看到流式日志；feishu 本地无需另起一份。

        const taskId = buildTaskId('feishu/', runId, stepId)
        const payload: WorkerTaskPayload = {
          taskId,
          prompt: fullPrompt,
          context: feishuContext,
          model: agentConfig.model || undefined,
          workDir: resolvedWorkDir,
          chatId: previousChatId ?? undefined,
          agentConfig,
        }

        const lifecycleStartTime = Date.now()
        lifecycleParams = {
          taskId,
          runId,
          stepId,
          agentId,
          startTime: lifecycleStartTime,
          workDir: resolvedWorkDir,
        }
        let artifacts: RegisteredArtifact[] = []

        // emit onBeforeRun: commandsPlugin applies applySession (→ chatIdOverride) /
        // runConfigPatch / longRunningAck (→ preAck) onto the runCtx. Aborts here
        // send a notification + release slot.
        const runCtx = pluginCtx as RunCtx
        runCtx.runId = runId
        runCtx.taskId = taskId
        runCtx.payload = payload
        await emit('onBeforeRun', runCtx, plugins)
        if (runCtx.aborted) {
          const reason = runCtx.abortReason?.message ?? '命令执行出错，请稍后重试'
          logger.info(
            { agentId, runId, code: runCtx.abortReason?.code, reason },
            'Feishu: pipeline aborted in onBeforeRun',
          )
          await finishRunAborted(lifecycleParams, reason)
          runFinalized = true
          const abortOutcome: PipelineError = {
            success: false,
            error: reason,
            durationMs: Date.now() - lifecycleStartTime,
          }
          const abortCtx = runCtx as RunCtx & { outcome?: PipelineError | Record<string, unknown> }
          abortCtx.outcome = abortOutcome
          await emit('onAfterRun', abortCtx, plugins, abortOutcome)
          const finalAbortOutcome = {
            ...abortOutcome,
            ...(abortCtx.outcome ?? {}),
            success: false,
          } as PipelineError
          void emit('onRunFailed', abortCtx, plugins, finalAbortOutcome)
          await sendFeishuUserNotification(
            freshClient,
            sender,
            message,
            config,
            finalAbortOutcome.error,
          ).catch((err) =>
            logger.warn({ err, agentId, runId }, 'Feishu: abort notification send failed'),
          )
          if (card) {
            try {
              card.updateContent(`⚠️ ${finalAbortOutcome.error}`)
              await card.finish()
            } catch {
              /* ignore */
            }
          }
          return
        }
        if (runCtx.chatIdOverride === null) {
          payload.chatId = undefined
        } else if (typeof runCtx.chatIdOverride === 'string') {
          payload.chatId = runCtx.chatIdOverride
        }
        if (runCtx.runConfigPatch) {
          const { model: patchedModel, ...configPatch } = runCtx.runConfigPatch
          payload.agentConfig = { ...payload.agentConfig, ...configPatch }
          if (typeof patchedModel === 'string' && patchedModel.trim().length > 0) {
            payload.model = patchedModel
            payload.agentConfig = { ...payload.agentConfig, model: patchedModel }
          }
        }
        if (runCtx.preAck && replyContentType !== 'streaming_card' && replyMode !== 'none') {
          void sendFeishuUserNotification(
            freshClient,
            sender,
            message,
            config,
            runCtx.preAck,
          ).catch((err) =>
            logger.warn(
              { err, agentId, runId, command: runCtx.matchedCommand },
              'Feishu: pre-ack send failed (non-blocking)',
            ),
          )
        }

        // 调试信息后缀：按运营勾选生成，provider/model 取本轮（含 runConfigPatch 后的）有效值；
        // 会话 id 用各分支拿到的本轮 result.chatId。两个回复分支共用此闭包，避免重复构造参数。
        const debugSuffixFor = (sessionId: string | undefined): string =>
          buildDebugInfoSuffix({
            showSessionId: config.debugShowSessionId,
            showProvider: config.debugShowProvider,
            showModel: config.debugShowModel,
            sessionId,
            providerName: payload.agentConfig.providerName,
            model: payload.model || payload.agentConfig.model,
          })

        // ── Streaming card mode ──────────────────────────────────
        if (replyContentType === 'streaming_card' && replyMode !== 'none') {
          const cardId = card?.getCardId()
          if (card && cardId) {
            registerStreamingCard(cardId, card, { showLocalChildOutput, showRemoteChildOutput })
            payload.agentConfig = {
              ...payload.agentConfig,
              agentEnv: {
                ...((payload.agentConfig.agentEnv as Record<string, string>) ?? {}),
                A2WAVE_STREAMING_CARD_ID: cardId,
              },
            }
          }

          try {
            // 排队后开始执行时，将卡片从"排队中..."更新为"思考中..."
            if (card && slotResult === 'queued') card.updateContent('思考中...')

            // runWithLifecycle owns collector + finishRunSuccess + onAfterRun /
            // onRunSucceeded / onRunFailed emit. Feishu just adapts the result.
            const launched = await runWithLifecycle(taskId, payload, lifecycleParams, {
              plugins,
              pluginCtx: runCtx,
              onUpdate: card
                ? (content) => {
                    if (cardId) touchStreamingCard(cardId)
                    card?.updateContent(content)
                  }
                : undefined,
              onLogEntry: cardId ? () => touchStreamingCard(cardId) : undefined,
            })
            runFinalized = true
            const result = {
              success: launched.success,
              output: launched.output ?? '',
              error: launched.error,
              chatId: launched.chatId,
            }
            artifacts = launched.artifacts ?? []

            if (card) {
              if (result.success) {
                const artifactSection = await buildFeishuArtifactSection(artifacts, wantSendFiles)
                const baseContent = artifactSection
                  ? `${result.output}\n\n---\n${artifactSection}`
                  : result.output
                // 调试信息后缀：仅在有正文时追加，避免空输出被兜底文案替换前混入调试信息。
                const finalContent = baseContent.trim()
                  ? baseContent + debugSuffixFor(result.chatId)
                  : baseContent
                const replyCtx = runCtx as ReplyCtx
                replyCtx.outcome = {
                  success: true,
                  output: result.output,
                  chatId: result.chatId,
                  durationMs: launched.durationMs,
                  artifacts,
                }
                replyCtx.content = {
                  text: finalContent,
                  replyContentType,
                }
                await emit('onBeforeReply', replyCtx, plugins)
                // trim()：纯空白输出（"   "）也视为空，不能当成有效回复发出。
                if (replyCtx.content?.text?.trim()) {
                  card.updateContent(replyCtx.content.text)
                } else {
                  // Empty output: show the run_id fallback (not a bare "未产生输出")
                  // so the user/ops can locate the run in the A2Wave backend.
                  card.updateContent(buildFeishuFallbackText(runId))
                }
              } else if (!result.success) {
                // Failure: surface the run_id fallback instead of the raw engine
                // error — keeps internal details out of the chat.
                card.updateContent(buildFeishuFallbackText(runId))
              }
              await card.finish()
              if (result.success) {
                void emit('onAfterReply', runCtx as ReplyCtx, plugins)
              }
            }

            if (wantSendFiles && artifacts.length > 0) {
              await sendArtifactFiles(freshClient, artifacts, message.chat_id)
            }
          } finally {
            if (cardId) unregisterStreamingCard(cardId)
          }
        } else {
          // ── Standard text/post/interactive/none mode ──────────
          const launched = await runWithLifecycle(taskId, payload, lifecycleParams, {
            plugins,
            pluginCtx: runCtx,
          })
          runFinalized = true
          const result = {
            success: launched.success,
            output: launched.output ?? '',
            error: launched.error,
            chatId: launched.chatId,
          }
          artifacts = launched.artifacts ?? []

          if (!result.success) {
            logger.warn({ agentId, runId }, 'Feishu agent execution failed')
            // 失败必须发声（text/post/interactive 模式），避免用户以为卡死。
            // 用 run_id 兜底文案而非原始 result.error — 不向群里暴露引擎内部错误。
            await sendFeishuFailureReply(
              freshClient,
              sender,
              message,
              config,
              buildFeishuFallbackText(runId),
              replyMentionOpenId ?? null,
            )
            return
          }

          if (replyMode === 'none') return

          const artifactSection = await buildFeishuArtifactSection(artifacts, wantSendFiles)
          const outputWithArtifacts = artifactSection
            ? `${result.output}\n\n---\n${artifactSection}`
            : result.output

          const replyCtx = runCtx as ReplyCtx
          replyCtx.outcome = {
            success: true,
            output: result.output,
            chatId: result.chatId,
            durationMs: launched.durationMs,
            artifacts,
          }
          replyCtx.content = {
            text: outputWithArtifacts,
            replyContentType,
          }
          await emit('onBeforeReply', replyCtx, plugins)

          // trim()：纯空白输出（"   "）也视为空，避免发出空白回复。
          if (!replyCtx.content?.text?.trim()) {
            logger.warn({ agentId, runId }, 'Feishu agent execution succeeded with empty output')
            await sendFeishuFailureReply(
              freshClient,
              sender,
              message,
              config,
              buildFeishuFallbackText(runId),
              replyMentionOpenId ?? null,
            )
            return
          }

          // 调试信息：按运营勾选生成文本后缀，适用于所有回复类型。
          // 交互卡片（声明了 a2wave-card）走卡片底部独立元素渲染（见下）；其余形式统一文本追加。
          const debugSuffix = debugSuffixFor(result.chatId)

          // 交互卡片：回复格式为 interactive_card 且 Agent 声明了 a2wave-card 块 → 发带交互组件的卡片
          // （卡片 JSON 2.0），剥离后的可视文本作为卡片说明，调试信息渲染到卡片底部独立元素。
          // 未声明组件 / 解析失败 / 发卡失败时，落到下方 buildFeishuReplyContent，按文本后缀追加调试信息。
          if (config.replyContentType === 'interactive_card') {
            const parsedCard = parseInteractiveCardSpec(replyCtx.content.text)
            if (parsedCard.spec) {
              const sent = await sendInteractiveCardReply({
                client: freshClient,
                agentId,
                config,
                message,
                triggerSessionId,
                // 卡片接收者 = 本轮触发者；回调仅允许其本人点击。
                triggerOpenId: sender?.sender_id?.open_id ?? null,
                // 用本轮执行后的 chatId 续接「刚才提问」那轮会话（见 sendInteractiveCardReply 注释）。
                resumeChatId: result.chatId ?? previousChatId,
                spec: parsedCard.spec,
                bodyFallback: parsedCard.text,
                replyMode,
                agentName: agent.name,
                debugSuffix,
              })
              if (sent) {
                if (wantSendFiles && artifacts.length > 0) {
                  await sendArtifactFiles(freshClient, artifacts, message.chat_id)
                }
                void emit('onAfterReply', replyCtx, plugins)
                return
              }
              // 发卡失败：降级为普通文本回复，但用剥离后的正文，
              // 绝不把 ```a2wave-card``` 原始 JSON 块暴露给用户。
              replyCtx.content.text = parsedCard.text?.trim() || buildFeishuFallbackText(runId)
            }
          }

          // 文本后缀形式追加调试信息（text / post / 模板卡片 / 纯文本交互卡片 / 发卡失败兜底）。
          replyCtx.content.text += debugSuffix

          let { msgType, replyContent } = buildFeishuReplyContent(
            replyCtx.content.text,
            replyContentType,
            config.cardTemplateId,
            { title: agent.name },
          )

          // 群聊按配置 @当前触发者或话题发起人；卡片类不支持此前缀格式。
          if (
            replyMentionOpenId &&
            replyContentType !== 'interactive' &&
            replyContentType !== 'interactive_card'
          ) {
            replyContent = prependAtMention(msgType, replyContent, replyMentionOpenId)
          }

          if (replyMode === 'quote') {
            await freshClient.im.message.reply({
              path: { message_id: quoteAnchorId(message) },
              data: { content: replyContent, msg_type: msgType },
            })
          } else {
            await freshClient.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: message.chat_id,
                content: replyContent,
                msg_type: msgType,
              },
            })
          }
          if (wantSendFiles && artifacts.length > 0) {
            await sendArtifactFiles(freshClient, artifacts, message.chat_id)
          }
          void emit('onAfterReply', replyCtx, plugins)
        }
      } catch (err) {
        if (runFinalized) {
          logger.warn(
            { err, agentId, runId },
            'Feishu post-run response phase failed; run status preserved',
          )
          return
        }
        if (lifecycleParams) {
          // runWithLifecycle owns collector + finishRun*. If we have not reached
          // it yet, this catch is still responsible for closing the run as failed.
          await finishRunError({ ...lifecycleParams, logs: [] }, err)
        } else {
          await failRunAndReleaseSlot(err instanceof Error ? err.message : String(err))
        }
        logger.error({ err, agentId, runId }, 'Feishu executeJob error')
        if (card) {
          try {
            // Surface run_id even on outer-catch path — this is exactly when ops
            // needs to correlate the user-visible error to the run. Aligned with
            // the post-finishRunSuccess empty-output fallback at L1856.
            card.updateContent(buildFeishuFallbackText(runId))
            await card.finish()
          } catch {
            /* ignore */
          }
        } else {
          // text/post/interactive 模式失败必须发声（streaming_card 已由 card 反馈）
          // 用外层 client（freshClient 仅在 try 块内可见）
          //
          // 用 run_id 兜底文案：不把 err.message 透传给用户（该 catch 覆盖
          // pre-runWithLifecycle 阶段——文件下载、DB op、库内部，err.message
          // 可能含文件系统路径、stack 片段、库内部细节）。完整 err 已在上面 logger.error
          // 入服务端日志便于排查；用户只看到带 run_id 的通用提示。
          await sendFeishuFailureReply(
            client,
            sender,
            message,
            config,
            buildFeishuFallbackText(runId),
            replyMentionOpenId ?? null,
          ).catch((replyErr) =>
            logger.warn({ err: replyErr, agentId, runId }, 'Feishu: failure reply send error'),
          )
        }
      } finally {
        if (imageTempDir) cleanupFeishuMessageResourceDownloadRoot(imageTempDir)
        if (fileTempDir) cleanupFeishuMessageResourceDownloadRoot(fileTempDir)
        if (rootTempDir) cleanupFeishuMessageResourceDownloadRoot(rootTempDir)
        // Event has reached a terminal state (success or failure) — the DB
        // tombstone is no longer needed for restart recovery.
        await removePending()
      }
    }

    // ── Dispatch: queue or execute immediately ──
    if (slotResult === 'queued') {
      logger.info({ agentId, runId }, 'Feishu: message queued, deferring execution')
      registerPendingJob(runId, executeJob)
      return
    }

    await executeJob()
  }

  /**
   * 开场白发送的共同前置：校验 welcomeMessage 与 chat_id，并按 event_id 去重
   * （飞书在 WS 重连后会重投未 ACK 的事件，去重避免重复发卡片）。
   * 命中则返回 { chatId, text }，否则返回 null。
   */
  private resolveWelcomeTarget(
    agentId: string,
    config: FeishuConfig,
    data: FeishuChatEvent,
  ): { chatId: string; text: string; dedupKey?: string } | null {
    const text = config.welcomeMessage?.trim()
    if (!text) return null
    const chatId = data?.chat_id
    if (!chatId) return null
    const eventId = data?.event_id ?? data?.uuid
    const dedupKey = eventId ? `welcome:${eventId}` : undefined
    // 记录前置：防并发 WS 重投在 send 完成前双发；发送失败时由调用方回滚该 key 以允许重投补发。
    if (dedupKey && isDuplicate(agentId, dedupKey)) {
      logger.info({ agentId, chatId, eventId }, 'Feishu welcome: duplicate event, skip')
      return null
    }
    return { chatId, text, dedupKey }
  }

  /**
   * 用户进入与机器人的 P2P 单聊事件。
   * 飞书在每次进入聊天页时都投递，依靠事件 payload 里的 last_message_create_time
   * （毫秒时间戳）做"会话空闲"判定，避免每次切回都重发。idleDays=0 表示每次进入都发。
   */
  private async handleP2pEntered(
    agentId: string,
    client: lark.Client,
    config: FeishuConfig,
    data: FeishuChatEvent,
  ): Promise<void> {
    if (!config.welcomeOnP2pEnabled) return

    // 空闲判定放在去重之前：先决定"该不该发"，避免无谓地把 event_id 记入去重缓存
    const idleDays = config.welcomeP2pIdleDays ?? 7
    const lastTsRaw = data?.last_message_create_time
    if (idleDays > 0 && lastTsRaw) {
      const lastTsMs = Number(lastTsRaw) // 飞书 IM 时间戳即毫秒，勿再 * 1000
      if (Number.isFinite(lastTsMs) && Date.now() - lastTsMs < idleDays * 86_400_000) {
        logger.info(
          { agentId, chatId: data?.chat_id, idleDays, lastTsMs },
          'Feishu welcome (P2P): within idle threshold, skip',
        )
        return
      }
    }

    const target = this.resolveWelcomeTarget(agentId, config, data)
    if (!target) return

    logger.info({ agentId, chatId: target.chatId }, 'Feishu welcome (P2P): sending')
    await this.sendWelcome(client, target.chatId, target.text).catch((err) => {
      // 发送失败回滚去重标记，让飞书 WS 重投能补发（避免瞬时失败导致开场白永久跳过）
      if (target.dedupKey) forgetDuplicate(agentId, target.dedupKey)
      logger.warn({ err, agentId, chatId: target.chatId }, 'Feishu welcome (P2P): send failed')
    })
  }

  /**
   * 机器人被加入群聊事件。飞书仅在拉入瞬间投递一次；按 event_id 去重以防 WS 重连重投。
   * 后续是否常驻见群里靠管理员手动置顶。
   */
  private async handleBotAddedToChat(
    agentId: string,
    client: lark.Client,
    config: FeishuConfig,
    data: FeishuChatEvent,
  ): Promise<void> {
    if (!config.welcomeOnGroupAddedEnabled) return
    const target = this.resolveWelcomeTarget(agentId, config, data)
    if (!target) return

    logger.info({ agentId, chatId: target.chatId }, 'Feishu welcome (group): sending')
    await this.sendWelcome(client, target.chatId, target.text).catch((err) => {
      // 发送失败回滚去重标记，让飞书 WS 重投能补发（避免瞬时失败导致开场白永久跳过）
      if (target.dedupKey) forgetDuplicate(agentId, target.dedupKey)
      logger.warn({ err, agentId, chatId: target.chatId }, 'Feishu welcome (group): send failed')
    })
  }

  /**
   * 以 interactive 卡片（CardKit）形式发送一段 Markdown 到指定会话。
   * 不走 post：飞书 post 内嵌的 md 渲染器会把段间空行（loose list）压扁，
   * 段落连在一起没空隙；CardKit 的 markdown 元素遵循 CommonMark，
   * 段间空行、bullets 之间的空行都能正确渲染。
   */
  private async sendWelcome(client: lark.Client, chatId: string, markdown: string): Promise<void> {
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: markdown,
          },
        ],
      },
    }
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
  }

  /**
   * Re-invoke handleMessage for a persisted Feishu event after a server
   * restart. Reuses the still-live WS connection (restored earlier) to fetch
   * the client/config/botOpenId. If the connection for this agent is not yet
   * restored, this replay is a no-op and the caller should retry later.
   */
  async replayPendingEvent(
    agentId: string,
    payload: FeishuEventPayload,
  ): Promise<'ok' | 'no-connection'> {
    const entry = this.connections.get(agentId)
    if (!entry) return 'no-connection'
    await this.handleMessage(agentId, entry.client, entry.config, payload, entry.botOpenId, {
      replay: true,
    })
    return 'ok'
  }

  async injectE2eMessage(
    agentId: string,
    client: lark.Client,
    config: FeishuConfig,
    payload: FeishuEventPayload,
    options: { botOpenId?: string; extraPlugins?: readonly LifecyclePlugin[] } = {},
  ): Promise<void> {
    if (env.NODE_ENV === 'production') {
      throw new Error('E2E Feishu injection is disabled in production')
    }
    await this.handleMessage(
      agentId,
      client,
      normalizeFeishuConfig(config),
      payload,
      options.botOpenId,
      {
        clientOverride: client,
        extraPlugins: options.extraPlugins,
      },
    )
  }
}

export const feishuConnectionManager = new FeishuConnectionManager()
