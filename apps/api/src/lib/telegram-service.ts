import {
  type RunChannelContextTelegram,
  type TelegramConfig,
  telegramConfigSchema,
} from '@a2wave/shared'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { buildArtifactLinkLinesSync } from './artifact-links.js'
import type { RegisteredArtifact } from './artifact-storage.js'
import { logger } from './logger.js'
import { prepareNativeArtifactUpload } from './native-chat-artifacts.js'
import type { NativeChatAttachment } from './native-chat-attachments.js'
import { TELEGRAM_DEFAULT_API_BASE } from './native-chat-attachments.js'
import { reserveNativeChatRun } from './native-chat-runner.js'
import { appendNativeArtifactDownloadSection, prepareNativeChatText } from './native-chat-text.js'
import { buildTelegramChannel } from './run-channel.js'

type NormalizedTelegramConfig = ReturnType<typeof telegramConfigSchema.parse>

/** Telegram rejects `sendMessage` bodies over 4096 UTF-16 code units. */
const TELEGRAM_TEXT_LIMIT = 4_000
/** Long-poll window. Telegram holds the request open until an update or timeout. */
const TELEGRAM_POLL_TIMEOUT_SECONDS = 30
const TELEGRAM_POLL_ERROR_BACKOFF_MS = 3_000

export interface TelegramUserSnapshot {
  id: number
  is_bot?: boolean
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramDocumentSnapshot {
  file_id: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramMessageSnapshot {
  message_id: number
  message_thread_id?: number
  from?: TelegramUserSnapshot
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
  date?: number
  text?: string
  caption?: string
  entities?: { type: string; offset: number; length: number }[]
  caption_entities?: { type: string; offset: number; length: number }[]
  reply_to_message?: { message_id: number; from?: TelegramUserSnapshot }
  document?: TelegramDocumentSnapshot
  photo?: TelegramDocumentSnapshot[]
  video?: TelegramDocumentSnapshot & { file_name?: string }
  audio?: TelegramDocumentSnapshot & { file_name?: string }
  voice?: TelegramDocumentSnapshot
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessageSnapshot
  channel_post?: TelegramMessageSnapshot
}

interface TelegramConnection {
  config: NormalizedTelegramConfig
  botId: string
  botUsername?: string
  abort: AbortController
  polling: boolean
  offset: number
}

/**
 * The numeric prefix of `<bot_id>:<secret>` is the bot's own user id. Deriving it
 * from the token means a config save needs no extra `getMe` round trip to know
 * which bot it is addressing, and it gives the channel a stable identity key.
 */
export function parseTelegramBotId(botToken: string): string {
  const botId = botToken.split(':')[0]?.trim()
  if (!botId || !/^\d+$/.test(botId)) {
    throw new Error('Telegram bot token must start with a numeric bot id')
  }
  return botId
}

export function telegramApiBase(config: Pick<NormalizedTelegramConfig, 'apiBaseUrl'>): string {
  return (config.apiBaseUrl ?? TELEGRAM_DEFAULT_API_BASE).replace(/\/+$/, '')
}

function canReuseTelegramConnection(
  current: Pick<NormalizedTelegramConfig, 'botToken' | 'apiBaseUrl'>,
  next: Pick<NormalizedTelegramConfig, 'botToken' | 'apiBaseUrl'>,
  isPolling: boolean,
): boolean {
  return isPolling && current.botToken === next.botToken && current.apiBaseUrl === next.apiBaseUrl
}

export function extractTelegramMessage(
  update: TelegramUpdate,
): TelegramMessageSnapshot | undefined {
  return update.message ?? update.channel_post
}

/**
 * Telegram spreads the user-authored text across `text` (plain messages) and
 * `caption` (messages carrying media), so a caption-only upload still reads as
 * an intent rather than an empty prompt.
 */
export function telegramMessageText(message: TelegramMessageSnapshot): string {
  return (message.text ?? message.caption ?? '').trim()
}

/**
 * Photos arrive as an ascending ladder of the same image; the last entry is the
 * highest resolution, which is the one worth handing to the Agent.
 */
export function extractTelegramNativeAttachments(
  message: TelegramMessageSnapshot,
): Extract<NativeChatAttachment, { source: 'telegram' }>[] {
  const attachments: Extract<NativeChatAttachment, { source: 'telegram' }>[] = []
  const push = (file: TelegramDocumentSnapshot | undefined, fallbackName: string): void => {
    if (!file?.file_id) return
    attachments.push({
      source: 'telegram' as const,
      remoteId: file.file_id,
      name: file.file_name ?? fallbackName,
      ...(file.mime_type ? { mimeType: file.mime_type } : {}),
      ...(file.file_size != null ? { size: file.file_size } : {}),
    })
  }
  push(message.document, `document-${message.message_id}`)
  const largestPhoto = message.photo?.[message.photo.length - 1]
  push(largestPhoto, `photo-${message.message_id}.jpg`)
  push(message.video, `video-${message.message_id}.mp4`)
  push(message.audio, `audio-${message.message_id}.mp3`)
  push(message.voice, `voice-${message.message_id}.ogg`)
  return attachments
}

/**
 * A group trigger fires on an explicit address to the bot: an `@username`
 * mention, or a reply to one of the bot's own messages. Private chats are always
 * addressed to the bot, so they need no mention.
 */
export function shouldTriggerTelegramMessage(
  config: Pick<NormalizedTelegramConfig, 'groupTriggerOnMention' | 'groupTriggerOnNewMessage'>,
  message: TelegramMessageSnapshot,
  botId: string,
  botUsername?: string,
): boolean {
  if (message.from?.is_bot) return false
  if (message.from && String(message.from.id) === botId) return false
  if (message.chat.type === 'private') return true

  const text = message.text ?? message.caption ?? ''
  const entities = message.entities ?? message.caption_entities ?? []
  const isMentioned = botUsername
    ? entities.some(
        (entity) =>
          entity.type === 'mention' &&
          text.slice(entity.offset, entity.offset + entity.length).toLowerCase() ===
            `@${botUsername.toLowerCase()}`,
      )
    : false
  const isReplyToBot = String(message.reply_to_message?.from?.id ?? '') === botId
  return (
    (config.groupTriggerOnMention && (isMentioned || isReplyToBot)) ||
    config.groupTriggerOnNewMessage
  )
}

export function stripTelegramBotMention(text: string, botUsername?: string): string {
  if (!botUsername) return text.trim()
  return text
    .replace(new RegExp(`@${escapeRegExp(botUsername)}\\b`, 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Private chats key on the chat itself; groups key on chat + sender so two
 * colleagues talking to the same bot in one group keep separate sessions, which
 * matches how the Discord channel scopes a guild conversation.
 */
export function buildTelegramConversationId(
  botId: string,
  message: Pick<TelegramMessageSnapshot, 'chat' | 'from' | 'message_thread_id'>,
): string {
  if (message.chat.type === 'private') return `${botId}:${message.chat.id}`
  const thread = message.message_thread_id != null ? `:${message.message_thread_id}` : ''
  return `${message.chat.id}${thread}:${message.from?.id ?? 'unknown'}`
}

export function telegramSenderName(from?: TelegramUserSnapshot): string | undefined {
  if (!from) return undefined
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
  return full || from.username || undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function chunkTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return [text]
  const chunks: string[] = []
  for (let offset = 0; offset < text.length; offset += TELEGRAM_TEXT_LIMIT) {
    chunks.push(text.slice(offset, offset + TELEGRAM_TEXT_LIMIT))
  }
  return chunks
}

export class TelegramConnectionManager {
  private readonly connections = new Map<string, TelegramConnection>()
  private readonly botHolders = new Map<string, string>()

  private async callApi<T>(
    connection: Pick<TelegramConnection, 'config'>,
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${telegramApiBase(connection.config)}/bot${connection.config.botToken}/${method}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean
      result?: T
      description?: string
    } | null
    if (!response.ok || !payload?.ok) {
      throw new Error(
        `Telegram ${method} failed: HTTP ${response.status}${
          payload?.description ? ` ${payload.description}` : ''
        }`,
      )
    }
    return payload.result as T
  }

  async start(agentId: string, rawConfig: TelegramConfig | Record<string, unknown>): Promise<void> {
    const config = telegramConfigSchema.parse(rawConfig)
    const botId = parseTelegramBotId(config.botToken)
    const holder = this.botHolders.get(botId)
    if (holder && holder !== agentId) {
      throw new Error(`Telegram bot ${botId} is already connected by Agent ${holder}`)
    }

    const previous = this.connections.get(agentId)
    if (previous && canReuseTelegramConnection(previous.config, config, previous.polling)) {
      previous.config = config
      this.botHolders.set(botId, agentId)
      return
    }
    if (previous) this.teardown(agentId, previous)
    // Reserve synchronously before the first await so concurrent starters cannot both pass.
    this.botHolders.set(botId, agentId)

    const connection: TelegramConnection = {
      config,
      botId,
      abort: new AbortController(),
      polling: false,
      offset: 0,
    }
    this.connections.set(agentId, connection)

    try {
      const me = await this.callApi<{ id: number; username?: string }>(connection, 'getMe', {})
      if (String(me.id) !== botId) {
        throw new Error('Telegram bot token does not match the derived bot id')
      }
      connection.botUsername = me.username
      // getUpdates and a registered webhook are mutually exclusive; drop any stale
      // webhook so a bot previously wired elsewhere can be polled here.
      await this.callApi(connection, 'deleteWebhook', { drop_pending_updates: false }).catch(
        (error) => logger.warn({ error, agentId }, 'Telegram deleteWebhook failed'),
      )
      connection.polling = true
      void this.pollLoop(agentId, connection)
    } catch (error) {
      this.teardown(agentId, connection)
      throw error
    }
  }

  private teardown(agentId: string, connection: TelegramConnection): void {
    connection.polling = false
    connection.abort.abort()
    this.connections.delete(agentId)
    if (this.botHolders.get(connection.botId) === agentId) this.botHolders.delete(connection.botId)
  }

  private async pollLoop(agentId: string, connection: TelegramConnection): Promise<void> {
    while (connection.polling && this.connections.get(agentId) === connection) {
      try {
        const updates = await this.callApi<TelegramUpdate[]>(
          connection,
          'getUpdates',
          {
            offset: connection.offset,
            timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
            allowed_updates: ['message', 'channel_post'],
          },
          connection.abort.signal,
        )
        for (const update of updates) {
          // Advance past the update before handling it: acknowledging first keeps a
          // message that throws from being redelivered forever and wedging the loop.
          connection.offset = Math.max(connection.offset, update.update_id + 1)
          await this.handleUpdate(agentId, connection, update).catch((error) =>
            logger.error(
              { error, agentId, updateId: update.update_id },
              'Telegram update handler failed unexpectedly',
            ),
          )
        }
      } catch (error) {
        if (!connection.polling || connection.abort.signal.aborted) return
        logger.error({ error, agentId }, 'Telegram long poll failed')
        await new Promise((resolve) => setTimeout(resolve, TELEGRAM_POLL_ERROR_BACKOFF_MS))
      }
    }
  }

  private async handleUpdate(
    agentId: string,
    connection: TelegramConnection,
    update: TelegramUpdate,
  ): Promise<void> {
    const message = extractTelegramMessage(update)
    if (!message) return
    if (
      !shouldTriggerTelegramMessage(
        connection.config,
        message,
        connection.botId,
        connection.botUsername,
      )
    ) {
      return
    }

    const nativeAttachments = extractTelegramNativeAttachments(message)
    const textIntent = stripTelegramBotMention(telegramMessageText(message), connection.botUsername)
    if (!textIntent && nativeAttachments.length === 0) return
    const intent = textIntent || 'Please review the attached files.'
    const { ctx, displayName } = buildTelegramChannel({
      botId: connection.botId,
      chatId: String(message.chat.id),
      chatType: message.chat.type,
      messageId: String(message.message_id),
      ...(message.message_thread_id != null
        ? { messageThreadId: String(message.message_thread_id) }
        : {}),
      senderUserId: String(message.from?.id ?? message.chat.id),
      ...(telegramSenderName(message.from)
        ? { senderName: telegramSenderName(message.from) as string }
        : {}),
    })
    const result = await reserveNativeChatRun({
      agentId,
      source: 'telegram',
      eventId: `telegram:${connection.botId}:${message.chat.id}:${message.message_id}`,
      conversationId: buildTelegramConversationId(connection.botId, message),
      intent,
      channel: ctx as RunChannelContextTelegram,
      displayName,
      nativeAttachments,
    })
    if (result.status === 'queue_full') {
      await this.replyPlainText(connection, message, 'Agent queue is full.').catch((error) =>
        logger.warn({ error, agentId }, 'Failed to send Telegram queue reply'),
      )
    } else if (result.status === 'scheduling_failed') {
      await this.replyPlainText(
        connection,
        message,
        'Agent could not schedule this message.',
      ).catch((error) =>
        logger.warn({ error, agentId }, 'Failed to send Telegram scheduling failure reply'),
      )
    }
  }

  private async replyPlainText(
    connection: TelegramConnection,
    message: TelegramMessageSnapshot,
    text: string,
  ): Promise<void> {
    await this.callApi(connection, 'sendMessage', {
      chat_id: message.chat.id,
      text,
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      ...(message.message_thread_id != null
        ? { message_thread_id: message.message_thread_id }
        : {}),
    })
  }

  async sendMessageByContext(
    agentId: string,
    context: RunChannelContextTelegram,
    text: string,
  ): Promise<void> {
    await this.sendRunResultByContext(agentId, context, text, [])
  }

  async sendRunResultByContext(
    agentId: string,
    context: RunChannelContextTelegram,
    text: string,
    artifacts: RegisteredArtifact[],
  ): Promise<void> {
    const connection = this.connections.get(agentId)
    if (!connection) throw new Error('Telegram connection is unavailable')
    const info = context.channel_info
    const replyMode =
      info.chat_type === 'private'
        ? connection.config.privateReplyMode
        : connection.config.groupReplyMode
    if (replyMode === 'none') return

    const threadFields: Record<string, number> =
      info.message_thread_id != null ? { message_thread_id: Number(info.message_thread_id) } : {}
    const replyFields =
      replyMode === 'reply'
        ? {
            reply_parameters: {
              message_id: Number(info.message_id),
              allow_sending_without_reply: true,
            },
          }
        : {}

    const sendText = async (chunk: string): Promise<void> => {
      await this.callApi(connection, 'sendMessage', {
        chat_id: info.chat_id,
        text: chunk,
        ...threadFields,
        ...replyFields,
      })
    }

    const uploadArtifacts = connection.config.sendArtifactsAsFile && artifacts.length > 0
    const preparedText = prepareNativeChatText(text, uploadArtifacts)
    if (preparedText) {
      for (const chunk of chunkTelegramText(preparedText)) await sendText(chunk)
    }
    if (!connection.config.sendArtifactsAsFile) return

    const failedArtifacts: RegisteredArtifact[] = []
    for (const artifact of artifacts) {
      try {
        const upload = prepareNativeArtifactUpload(artifact)
        if (!upload) {
          failedArtifacts.push(artifact)
          continue
        }
        await this.sendDocument(connection, info, upload, threadFields)
      } catch (error) {
        failedArtifacts.push(artifact)
        logger.warn(
          { error, agentId, artifactId: artifact.id, filename: artifact.filename },
          'Failed to upload artifact to Telegram',
        )
      }
    }
    if (failedArtifacts.length > 0) {
      const fallback = appendNativeArtifactDownloadSection(
        '⚠️ Some artifacts could not be uploaded.',
        await buildArtifactLinkLinesSync(failedArtifacts),
      )
      for (const chunk of chunkTelegramText(fallback)) await sendText(chunk)
    }
  }

  private async sendDocument(
    connection: TelegramConnection,
    info: RunChannelContextTelegram['channel_info'],
    upload: { filename: string; data: string | Buffer },
    threadFields: Record<string, number>,
  ): Promise<void> {
    const { readFile } = await import('node:fs/promises')
    const bytes = typeof upload.data === 'string' ? await readFile(upload.data) : upload.data
    const form = new FormData()
    form.append('chat_id', info.chat_id)
    for (const [key, value] of Object.entries(threadFields)) form.append(key, String(value))
    form.append('document', new Blob([new Uint8Array(bytes)]), upload.filename)

    const url = `${telegramApiBase(connection.config)}/bot${connection.config.botToken}/sendDocument`
    const response = await fetch(url, { method: 'POST', body: form })
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean
      description?: string
    } | null
    if (!response.ok || !payload?.ok) {
      throw new Error(
        `Telegram sendDocument failed: HTTP ${response.status}${
          payload?.description ? ` ${payload.description}` : ''
        }`,
      )
    }
  }

  async stop(agentId: string): Promise<void> {
    const connection = this.connections.get(agentId)
    if (!connection) return
    this.teardown(agentId, connection)
  }

  stopAll(): void {
    for (const agentId of [...this.connections.keys()]) void this.stop(agentId)
  }

  isRegistered(agentId: string): boolean {
    return this.connections.has(agentId)
  }

  isSocketOpen(agentId: string): boolean {
    return this.connections.get(agentId)?.polling ?? false
  }

  getConnectionStatuses(): Array<{ agentId: string; socketOpen: boolean }> {
    return [...this.connections.entries()].map(([agentId, value]) => ({
      agentId,
      socketOpen: value.polling,
    }))
  }

  async restoreConnections(): Promise<void> {
    const published = (
      await db.select().from(agents).where(eq(agents.publishStatus, 'published'))
    ).filter((agent) => (agent.publishChannels ?? []).includes('telegram') && agent.telegramConfig)
    for (const agent of published) {
      try {
        await this.start(agent.id, agent.telegramConfig as TelegramConfig)
      } catch (error) {
        logger.error({ error, agentId: agent.id }, 'Failed to restore Telegram connection')
      }
    }
  }
}

export const telegramConnectionManager = new TelegramConnectionManager()
