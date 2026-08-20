import {
  type DiscordConfig,
  discordConfigSchema,
  type RunChannelContextDiscord,
} from '@a2wave/shared'
import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type MessageCreateOptions,
  Partials,
} from 'discord.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { buildArtifactLinkLinesSync } from './artifact-links.js'
import type { RegisteredArtifact } from './artifact-storage.js'
import { logger } from './logger.js'
import { prepareNativeArtifactUpload } from './native-chat-artifacts.js'
import type { NativeChatAttachment } from './native-chat-attachments.js'
import { reserveNativeChatRun } from './native-chat-runner.js'
import { appendNativeArtifactDownloadSection, prepareNativeChatText } from './native-chat-text.js'
import { buildDiscordChannel } from './run-channel.js'

type NormalizedDiscordConfig = ReturnType<typeof discordConfigSchema.parse>

export interface DiscordMessageSnapshot {
  authorId: string
  authorIsBot: boolean
  guildId?: string
  channelId: string
  messageId: string
  content: string
  mentionedUserIds?: string[]
  attachments?: DiscordAttachmentSnapshot[]
}

export interface DiscordAttachmentSnapshot {
  id: string
  name: string
  contentType?: string | null
  size?: number
  url?: string
}

interface DiscordConnection {
  config: NormalizedDiscordConfig
  client: Client
}

function canReuseDiscordGatewayConnection(
  current: Pick<NormalizedDiscordConfig, 'applicationId' | 'botToken'>,
  next: Pick<NormalizedDiscordConfig, 'applicationId' | 'botToken'>,
  isReady: boolean,
): boolean {
  return (
    isReady && current.applicationId === next.applicationId && current.botToken === next.botToken
  )
}

export function extractDiscordNativeAttachments(
  message: DiscordMessageSnapshot,
): Extract<NativeChatAttachment, { source: 'discord' }>[] {
  return (message.attachments ?? []).map((attachment) => ({
    source: 'discord' as const,
    remoteId: attachment.id,
    channelId: message.channelId,
    messageId: message.messageId,
    name: attachment.name,
    ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
    ...(attachment.size != null ? { size: attachment.size } : {}),
  }))
}

export function shouldTriggerDiscordMessage(
  config: Pick<NormalizedDiscordConfig, 'guildTriggerOnMention' | 'guildTriggerOnNewMessage'>,
  message: DiscordMessageSnapshot,
  botUserId?: string,
): boolean {
  if (message.authorIsBot || (botUserId && message.authorId === botUserId)) return false
  if (!message.guildId) return true
  const isMentioned = botUserId ? (message.mentionedUserIds ?? []).includes(botUserId) : false
  return (config.guildTriggerOnMention && isMentioned) || config.guildTriggerOnNewMessage
}

export function stripDiscordBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildDiscordConversationId(
  applicationId: string,
  message: Pick<DiscordMessageSnapshot, 'authorId' | 'guildId' | 'channelId' | 'messageId'>,
): string {
  if (!message.guildId) return `${applicationId}:${message.channelId}`
  return `${message.guildId}:${message.channelId}:${message.authorId}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function chunkDiscordText(text: string): string[] {
  if (text.length <= 1_900) return [text]
  const chunks: string[] = []
  for (let offset = 0; offset < text.length; offset += 1_900) {
    chunks.push(text.slice(offset, offset + 1_900))
  }
  return chunks
}

export class DiscordConnectionManager {
  private readonly connections = new Map<string, DiscordConnection>()
  private readonly applicationHolders = new Map<string, string>()

  private async waitForReadyConnection(
    agentId: string,
    timeoutMs = 10_000,
  ): Promise<DiscordConnection | null> {
    const deadline = Date.now() + timeoutMs
    do {
      const connection = this.connections.get(agentId)
      if (connection?.client.isReady()) return connection
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    return null
  }

  async start(agentId: string, rawConfig: DiscordConfig | Record<string, unknown>): Promise<void> {
    const config = discordConfigSchema.parse(rawConfig)
    const holder = this.applicationHolders.get(config.applicationId)
    if (holder && holder !== agentId) {
      throw new Error(
        `Discord application ${config.applicationId} is already connected by Agent ${holder}`,
      )
    }

    const previous = this.connections.get(agentId)
    if (
      previous &&
      canReuseDiscordGatewayConnection(previous.config, config, previous.client.isReady())
    ) {
      previous.config = config
      this.applicationHolders.set(config.applicationId, agentId)
      return
    }
    if (previous) {
      this.connections.delete(agentId)
      if (this.applicationHolders.get(previous.config.applicationId) === agentId) {
        this.applicationHolders.delete(previous.config.applicationId)
      }
    }
    // Reserve synchronously before the first await so concurrent starters cannot both pass.
    this.applicationHolders.set(config.applicationId, agentId)

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    })
    const connection = { config, client }
    this.connections.set(agentId, connection)
    client.on(Events.Error, (error) => {
      logger.error({ error, agentId }, 'Discord gateway error')
    })
    client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(agentId, connection, message).catch((error) =>
        logger.error(
          { error, agentId, messageId: message.id },
          'Discord message handler failed unexpectedly',
        ),
      )
    })

    try {
      if (previous) await previous.client.destroy()
      const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()))
      await client.login(config.botToken)
      await ready
      if (client.application?.id && client.application.id !== config.applicationId) {
        throw new Error('Discord bot token does not belong to the configured application id')
      }
    } catch (error) {
      this.connections.delete(agentId)
      if (this.applicationHolders.get(config.applicationId) === agentId) {
        this.applicationHolders.delete(config.applicationId)
      }
      await client.destroy().catch(() => {})
      throw error
    }
  }

  private async handleMessage(
    agentId: string,
    connection: DiscordConnection,
    message: Message,
  ): Promise<void> {
    const botUserId = connection.client.user?.id
    const snapshot: DiscordMessageSnapshot = {
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      ...(message.guildId ? { guildId: message.guildId } : {}),
      channelId: message.channelId,
      messageId: message.id,
      content: message.content,
      mentionedUserIds: [...message.mentions.users.keys()],
      attachments: [...message.attachments.values()].map((attachment) => ({
        id: attachment.id,
        name: attachment.title ?? attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        url: attachment.url,
      })),
    }
    if (!shouldTriggerDiscordMessage(connection.config, snapshot, botUserId)) return

    const nativeAttachments = extractDiscordNativeAttachments(snapshot)
    const textIntent = botUserId
      ? stripDiscordBotMention(message.content, botUserId)
      : message.content.trim()
    if (!textIntent && nativeAttachments.length === 0) return
    const intent = textIntent || 'Please review the attached files.'
    const isGuild = Boolean(message.guildId)
    const { ctx, displayName } = buildDiscordChannel({
      applicationId: connection.config.applicationId,
      ...(message.guildId ? { guildId: message.guildId } : {}),
      channelId: message.channelId,
      messageId: message.id,
      ...(message.channel.isThread() ? { threadId: message.channel.id } : {}),
      senderUserId: message.author.id,
      senderName: message.author.globalName ?? message.author.username,
      chatType: isGuild ? 'guild' : 'dm',
    })
    const result = await reserveNativeChatRun({
      agentId,
      source: 'discord',
      eventId: `discord:${message.id}`,
      conversationId: buildDiscordConversationId(connection.config.applicationId, snapshot),
      intent,
      channel: ctx as RunChannelContextDiscord,
      displayName,
      nativeAttachments,
    })
    if (result.status === 'queue_full') {
      await message
        .reply('Agent queue is full.')
        .catch((error) =>
          logger.warn(
            { error, agentId, messageId: message.id },
            'Failed to send Discord queue reply',
          ),
        )
    } else if (result.status === 'scheduling_failed') {
      await message
        .reply('Agent could not schedule this message.')
        .catch((error) =>
          logger.warn(
            { error, agentId, messageId: message.id },
            'Failed to send Discord scheduling failure reply',
          ),
        )
    }
  }

  async sendMessageByContext(
    agentId: string,
    context: RunChannelContextDiscord,
    text: string,
  ): Promise<void> {
    await this.sendRunResultByContext(agentId, context, text, [])
  }

  async sendRunResultByContext(
    agentId: string,
    context: RunChannelContextDiscord,
    text: string,
    artifacts: RegisteredArtifact[],
  ): Promise<void> {
    // Startup queue recovery can finish a short run while Gateway restoration is
    // still logging in. Give the persisted connection a bounded window to become
    // ready so restart-safe inputs do not produce a lost text/artifact response.
    const connection = await this.waitForReadyConnection(agentId)
    if (!connection) throw new Error('Discord connection is unavailable')
    const info = context.channel_info
    const replyMode =
      info.chat_type === 'dm' ? connection.config.dmReplyMode : connection.config.guildReplyMode
    if (replyMode === 'none') return

    const channel = await connection.client.channels.fetch(info.channel_id)
    if (!channel?.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel ${info.channel_id} is not text based`)
    }
    const original =
      replyMode === 'reply' && 'messages' in channel
        ? await channel.messages.fetch(info.message_id).catch(() => null)
        : null
    const send = async (options: MessageCreateOptions): Promise<void> => {
      if (original) {
        await original.reply({
          ...options,
          allowedMentions: { parse: [], repliedUser: false },
        })
        return
      }
      await (channel as { send(options: MessageCreateOptions): Promise<unknown> }).send({
        ...options,
        allowedMentions: { parse: [] },
      })
    }

    const uploadArtifacts = connection.config.sendArtifactsAsFile && artifacts.length > 0
    const preparedText = prepareNativeChatText(text, uploadArtifacts)
    if (preparedText) {
      for (const chunk of chunkDiscordText(preparedText)) {
        await send({ content: chunk })
      }
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
        await send({
          files: [{ attachment: upload.data, name: upload.filename }],
        })
      } catch (error) {
        failedArtifacts.push(artifact)
        logger.warn(
          { error, agentId, artifactId: artifact.id, filename: artifact.filename },
          'Failed to upload artifact to Discord',
        )
      }
    }
    if (failedArtifacts.length > 0) {
      const fallback = appendNativeArtifactDownloadSection(
        '⚠️ Some artifacts could not be uploaded.',
        await buildArtifactLinkLinesSync(failedArtifacts),
      )
      for (const chunk of chunkDiscordText(fallback)) {
        await send({ content: chunk })
      }
    }
  }

  async stop(agentId: string): Promise<void> {
    const connection = this.connections.get(agentId)
    if (!connection) return
    this.connections.delete(agentId)
    if (this.applicationHolders.get(connection.config.applicationId) === agentId) {
      this.applicationHolders.delete(connection.config.applicationId)
    }
    await connection.client.destroy()
  }

  stopAll(): void {
    for (const agentId of this.connections.keys()) void this.stop(agentId)
  }

  isRegistered(agentId: string): boolean {
    return this.connections.has(agentId)
  }

  isSocketOpen(agentId: string): boolean {
    return this.connections.get(agentId)?.client.isReady() ?? false
  }

  getConnectionStatuses(): Array<{ agentId: string; socketOpen: boolean }> {
    return [...this.connections.entries()].map(([agentId, value]) => ({
      agentId,
      socketOpen: value.client.isReady(),
    }))
  }

  async restoreConnections(): Promise<void> {
    const published = await (
      await db.select().from(agents).where(eq(agents.publishStatus, 'published'))
    ).filter((agent) => (agent.publishChannels ?? []).includes('discord') && agent.discordConfig)
    for (const agent of published) {
      try {
        await this.start(agent.id, agent.discordConfig as DiscordConfig)
      } catch (error) {
        logger.error({ error, agentId: agent.id }, 'Failed to restore Discord connection')
      }
    }
  }
}

export const discordConnectionManager = new DiscordConnectionManager()
