import type * as lark from '@larksuiteoapi/node-sdk'
import { deliverFeishuReply, type FeishuReplyMode } from './feishu-reply-delivery.js'
import { logger } from './logger.js'

const MAIN_ELEMENT_ID = 'main'
/** 关闭 streaming mode 后等待飞书完成状态转换再 patch 消息的时间（ms） */
const STREAMING_CLOSE_SETTLE_MS = 500

/**
 * 构建卡片 JSON 2.0 结构（用于 CardKit 流式卡片）
 */
function buildCardJson(streaming: boolean): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: streaming,
      summary: { content: '' },
    },
    body: {
      elements: [{ tag: 'markdown', content: '思考中...', element_id: MAIN_ELEMENT_ID }],
    },
  })
}

/**
 * 流式卡片会话 — 基于 CardKit API 实现真正的打字机效果。
 *
 * 需要 cardkit:card:write + im:message:send_as_bot 权限（应用身份 tenant_access_token）。
 *
 * 流程：
 * 1. create()    — 调用 cardkit.v1.card.create 创建卡片实体（streaming_mode=true）
 * 2. send()      — 通过 im.message.create/reply 发送卡片消息
 * 3. updateContent() — 调用 cardkit.v1.card.element.content 流式更新文本（内置节流）
 * 4. finish()    — 调用 cardkit.v1.card.settings 关闭流式模式
 */
export class FeishuStreamingCard {
  private cardId: string
  private messageId: string | null = null
  private client: lark.Client
  private sequence = 1
  private lastContent = ''
  private pendingContent: string | null = null
  private throttleTimer: ReturnType<typeof setTimeout> | null = null
  private childCounter = 0
  /** Maps external childId → short element_id suffix (e.g. "c1") */
  private childElementIds = new Map<string, string>()
  private childLabels = new Map<string, string>()
  private childCreated = new Set<string>()
  private childLastContent = new Map<string, string>()
  private childPendingContent = new Map<string, string>()
  private childThrottleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Serial queue for CardKit API calls to ensure sequence ordering */
  private opQueue: Promise<void> = Promise.resolve()

  private constructor(client: lark.Client, cardId: string) {
    this.client = client
    this.cardId = cardId
  }

  /** 串行执行 CardKit API 调用，确保 sequence 按顺序到达 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.opQueue.then(fn, fn) as Promise<T>
    this.opQueue = result.then(
      () => {},
      () => {},
    )
    return result
  }

  /** 创建流式卡片实体并返回实例 */
  static async create(client: lark.Client): Promise<FeishuStreamingCard> {
    const resp = await client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: buildCardJson(true),
      },
    })

    const cardId = resp?.data?.card_id
    if (!cardId) {
      throw new Error('Failed to create streaming card: no card_id in response')
    }
    return new FeishuStreamingCard(client, cardId)
  }

  /** 获取卡片实体 ID */
  getCardId(): string {
    return this.cardId
  }

  /** 获取消息 ID */
  getMessageId(): string | null {
    return this.messageId
  }

  /** 发送卡片消息到聊天 */
  async send(
    chatId: string,
    replyToMessageId?: string,
    replyMode: Exclude<FeishuReplyMode, 'none'> = 'new',
  ): Promise<void> {
    const content = JSON.stringify({ type: 'card', data: { card_id: this.cardId } })

    const resp: { message_id?: string; data?: { message_id?: string } } | undefined =
      await deliverFeishuReply(
        this.client,
        { chat_id: chatId, message_id: replyToMessageId },
        replyMode,
        { content, msg_type: 'interactive' },
      )

    this.messageId = resp?.data?.message_id ?? resp?.message_id ?? null
    if (!this.messageId) {
      throw new Error('Failed to send streaming card: no message_id in response')
    }
  }

  /** 流式更新父 Agent markdown 内容（内置 150ms 节流，CardKit 上限 10次/秒） */
  updateContent(content: string): void {
    this.pendingContent = content
    if (this.throttleTimer) return
    this.throttleTimer = setTimeout(() => this.flush(), 150)
  }

  /** 立即发送父 Agent 最新内容 */
  async flush(): Promise<void> {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer)
      this.throttleTimer = null
    }
    const content = this.pendingContent
    if (content === null || content === this.lastContent) return
    this.lastContent = content
    this.pendingContent = null

    await this.enqueue(async () => {
      try {
        await this.client.cardkit.v1.cardElement.content({
          path: { card_id: this.cardId, element_id: MAIN_ELEMENT_ID },
          data: { content, sequence: this.sequence++ },
        })
      } catch (err) {
        logger.warn({ err, cardId: this.cardId }, 'Failed to update streaming card content')
      }
    })
  }

  /** 动态追加子 Agent 输出区域（分隔线 + markdown 元素） */
  async addChildSection(childId: string, label?: string): Promise<void> {
    if (this.childElementIds.has(childId)) return

    // Use short, alphanumeric element_ids to avoid Feishu validation issues
    const idx = ++this.childCounter
    const contentId = `c${idx}`
    this.childElementIds.set(childId, contentId)
    if (label) this.childLabels.set(childId, label)

    const displayLabel = label || `子 Agent #${idx}`
    const initialContent = `> **🧩 ${displayLabel}**\n> \n> 思考中...`

    await this.enqueue(async () => {
      try {
        const resp = await this.client.cardkit.v1.cardElement.create({
          path: { card_id: this.cardId },
          data: {
            type: 'append',
            elements: JSON.stringify([
              { tag: 'hr' },
              { tag: 'markdown', content: initialContent, element_id: contentId },
            ]),
            sequence: this.sequence++,
          },
        })
        if (resp?.code && resp.code !== 0) {
          logger.warn(
            { cardId: this.cardId, childId, code: resp.code, msg: resp.msg },
            'CardKit element create returned error',
          )
          this.childElementIds.delete(childId)
          this.childLabels.delete(childId)
          return
        }
        this.childCreated.add(childId)
      } catch (err) {
        logger.warn(
          { err, cardId: this.cardId, childId },
          'Failed to add child section to streaming card',
        )
        this.childElementIds.delete(childId)
        this.childLabels.delete(childId)
      }
    })
  }

  /** 流式更新子 Agent 区域内容（独立节流） */
  updateChildContent(childId: string, content: string): void {
    if (!this.childCreated.has(childId)) return
    this.childPendingContent.set(childId, content)
    if (this.childThrottleTimers.has(childId)) return
    this.childThrottleTimers.set(
      childId,
      setTimeout(() => this.flushChild(childId), 150),
    )
  }

  /** 将内容包装为引用块格式，首行显示 Agent 名称 */
  private formatChildContent(childId: string, content: string): string {
    const label = this.childLabels.get(childId) || '子 Agent'
    const quotedBody = content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    return `> **🧩 ${label}**\n> \n${quotedBody}`
  }

  /** 立即发送子 Agent 最新内容 */
  private async flushChild(childId: string): Promise<void> {
    const timer = this.childThrottleTimers.get(childId)
    if (timer) {
      clearTimeout(timer)
      this.childThrottleTimers.delete(childId)
    }
    const content = this.childPendingContent.get(childId)
    if (content === undefined || content === this.childLastContent.get(childId)) return
    this.childLastContent.set(childId, content)
    this.childPendingContent.delete(childId)

    const elementId = this.childElementIds.get(childId)
    if (!elementId) return

    const formatted = this.formatChildContent(childId, content)
    await this.enqueue(async () => {
      try {
        await this.client.cardkit.v1.cardElement.content({
          path: { card_id: this.cardId, element_id: elementId },
          data: { content: formatted, sequence: this.sequence++ },
        })
      } catch (err) {
        logger.warn({ err, cardId: this.cardId, childId }, 'Failed to update child section content')
      }
    })
  }

  /** 关闭流式模式，并将子 Agent 区域替换为折叠面板 */
  async finish(): Promise<void> {
    await this.flush()
    // Flush all pending child sections
    for (const childId of this.childCreated) {
      await this.flushChild(childId)
    }

    let streamingClosed = false
    await this.enqueue(async () => {
      try {
        await this.client.cardkit.v1.card.settings({
          path: { card_id: this.cardId },
          data: {
            settings: JSON.stringify({ config: { streaming_mode: false } }),
            sequence: this.sequence++,
          },
        })
        streamingClosed = true
      } catch (err) {
        logger.warn({ err, cardId: this.cardId }, 'Failed to finalize streaming card')
      }
    })

    // Replace card with collapsible panels only after streaming mode is closed
    if (streamingClosed && this.childCreated.size > 0 && this.messageId) {
      await new Promise((resolve) => setTimeout(resolve, STREAMING_CLOSE_SETTLE_MS))
      await this.replaceWithCollapsiblePanels()
    }
  }

  /** 用含折叠面板的完整卡片替换消息，使子 Agent 输出默认折叠 */
  private async replaceWithCollapsiblePanels(): Promise<void> {
    const elements: Record<string, unknown>[] = [
      { tag: 'markdown', content: this.lastContent || '' },
    ]

    for (const childId of this.childCreated) {
      const label = this.childLabels.get(childId) || '子 Agent'
      const content = this.childLastContent.get(childId) || ''

      elements.push({ tag: 'hr' })
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: { tag: 'plain_text', content: `🧩 ${label}` },
        },
        elements: [{ tag: 'markdown', content }],
      })
    }

    const cardJson = JSON.stringify({
      schema: '2.0',
      config: { wide_screen_mode: true },
      body: { elements },
    })

    // Callers already gate on messageId; re-check so the type is narrowed here too.
    const messageId = this.messageId
    if (!messageId) return

    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: cardJson },
      })
    } catch (err) {
      logger.warn({ err, cardId: this.cardId }, 'Failed to replace card with collapsible panels')
    }
  }
}
