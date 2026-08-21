import { type RunChannelContextSlack, type SlackConfig, slackConfigSchema } from '@a2wave/shared'
import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { buildArtifactLinkLinesSync } from './artifact-links.js'
import type { RegisteredArtifact } from './artifact-storage.js'
import { logger } from './logger.js'
import { prepareNativeArtifactUpload } from './native-chat-artifacts.js'
import type {
  NativeChatAttachment,
  PersistedNativeChatAttachment,
} from './native-chat-attachments.js'
import { reserveNativeChatRun } from './native-chat-runner.js'
import { appendNativeArtifactDownloadSection, prepareNativeChatText } from './native-chat-text.js'
import { buildSlackChannel } from './run-channel.js'

type NormalizedSlackConfig = ReturnType<typeof slackConfigSchema.parse>

export interface SlackMessageEvent {
  type: string
  channel: string
  channel_type?: string
  user?: string
  text?: string
  ts?: string
  thread_ts?: string
  subtype?: string
  bot_id?: string
  files?: SlackFileEvent[]
}

export interface SlackFileEvent {
  id?: string
  name?: string
  title?: string
  mimetype?: string
  size?: number
  url_private?: string
  url_private_download?: string
}

interface SlackEventEnvelope {
  ack: () => Promise<void>
  body?: { event_id?: string; team_id?: string }
  event?: SlackMessageEvent
}

interface SlackConnection {
  config: NormalizedSlackConfig
  socket: SocketModeClient
  web: WebClient
  botUserId: string
  teamId: string
  socketOpen: boolean
}

export function shouldTriggerSlackEvent(
  config: Pick<NormalizedSlackConfig, 'groupTriggerOnAt' | 'groupTriggerOnNewMessage'>,
  event: SlackMessageEvent,
  botUserId?: string,
): boolean {
  if (
    !event.user ||
    !event.channel ||
    !event.ts ||
    event.bot_id ||
    (event.subtype && event.subtype !== 'file_share')
  ) {
    return false
  }
  const isDirectMessage = event.channel_type === 'im' || event.channel.startsWith('D')
  if (isDirectMessage) return true
  const isMentioned = botUserId ? (event.text ?? '').includes(`<@${botUserId}>`) : false
  return (config.groupTriggerOnAt && isMentioned) || config.groupTriggerOnNewMessage
}

/**
 * Key the run reservation by message identity, never by `event_id`.
 *
 * A single @-mention in a channel that subscribes both `app_mention` and
 * `message.channels` is delivered as two envelopes carrying two *different*
 * `event_id`s. Keying on the envelope therefore reserved two runs for one
 * message, and the agent answered twice at twice the token cost. Team + channel
 * + `ts` names the message itself, so every duplicate delivery collapses onto
 * the `runs_native_chat_event_unique` index.
 *
 * Slack redeliveries of the *same* envelope already collapse here too, so this
 * key strictly widens the existing dedup guarantee rather than trading one
 * class of duplicate for another.
 */
export function buildSlackDedupKey(teamId: string, channel: string, ts?: string): string {
  return `slack:${teamId}:${channel}:${ts ?? 'unknown'}`
}

export function extractSlackNativeAttachments(
  event: Pick<SlackMessageEvent, 'files'>,
): Extract<NativeChatAttachment, { source: 'slack' }>[] {
  return (event.files ?? []).flatMap((file) => {
    if (!file.id) return []
    return [
      {
        source: 'slack' as const,
        remoteId: file.id,
        name: file.name ?? file.title ?? `slack-file-${file.id}`,
        ...(file.mimetype ? { mimeType: file.mimetype } : {}),
        ...(file.size != null ? { size: file.size } : {}),
      },
    ]
  })
}

export function stripSlackBotMention(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, '').replace(/\s+/g, ' ').trim()
}

export function buildSlackConversationId(
  teamId: string,
  event: Pick<SlackMessageEvent, 'channel' | 'channel_type' | 'ts' | 'thread_ts'>,
): string {
  const isDirectMessage = event.channel_type === 'im' || event.channel.startsWith('D')
  if (isDirectMessage) return `${teamId}:${event.channel}`
  return `${teamId}:${event.channel}:${event.thread_ts ?? event.ts}`
}

const SLACK_MARKDOWN_BLOCK_LIMIT = 12_000
const SLACK_MARKDOWN_CHUNK_LIMIT = 11_500

function chunkSlackText(text: string): string[] {
  if (text.length <= SLACK_MARKDOWN_BLOCK_LIMIT) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > SLACK_MARKDOWN_BLOCK_LIMIT) {
    let splitAt = remaining.lastIndexOf('\n\n', SLACK_MARKDOWN_CHUNK_LIMIT)
    if (splitAt < SLACK_MARKDOWN_CHUNK_LIMIT / 2) {
      splitAt = remaining.lastIndexOf('\n', SLACK_MARKDOWN_CHUNK_LIMIT)
    }
    if (splitAt < SLACK_MARKDOWN_CHUNK_LIMIT / 2) splitAt = SLACK_MARKDOWN_CHUNK_LIMIT
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function buildSlackPlainTextFallback(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(```)[^\n]*$/gm, '')
    .replace(/^[ \t]*\|?[ \t:|-]+\|?[ \t]*$/gm, '')
    .replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1: $2')
    .replaceAll('**', '')
    .replaceAll('__', '')
    .replaceAll('~~', '')
    .replace(/^---+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Slack treats angle-bracket control sequences as broadcast, user, or user-group
 * mentions. Insert an invisible separator so untrusted Agent output is rendered
 * as text instead of notifying workspace members.
 */
export function neutralizeSlackMentions(text: string): string {
  return text.replace(/<(?=[!@])/g, '<\u200b')
}

/**
 * How long an `app_mention` waits for the richer `message` twin to arrive.
 *
 * Both envelopes describe the same message, but only `message` carries
 * `files` and `channel_type`. Slack emits them together, so a short wait lets
 * the better payload win the dedup race deterministically instead of by
 * arrival order. Workspaces that subscribe `app_mention` alone simply see the
 * timer elapse and proceed unchanged.
 */
const SLACK_APP_MENTION_GRACE_MS = 1_500

export class SlackConnectionManager {
  private readonly connections = new Map<string, SlackConnection>()
  private readonly appHolders = new Map<string, string>()
  private readonly pendingMentions = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; ack: () => Promise<void> }
  >()

  async start(agentId: string, rawConfig: SlackConfig | Record<string, unknown>): Promise<void> {
    const config = slackConfigSchema.parse(rawConfig)
    const holder = this.appHolders.get(config.appId)
    if (holder && holder !== agentId) {
      throw new Error(`Slack app ${config.appId} is already connected by Agent ${holder}`)
    }

    const previous = this.connections.get(agentId)
    if (previous) {
      this.connections.delete(agentId)
      if (this.appHolders.get(previous.config.appId) === agentId) {
        this.appHolders.delete(previous.config.appId)
      }
      previous.socketOpen = false
      // The replaced connection's deferred mentions close over its stale socket
      // and config, so they must not survive it.
      this.clearPendingMentions(agentId)
    }
    // Reserve synchronously before the first await so concurrent starters cannot both pass.
    this.appHolders.set(config.appId, agentId)

    try {
      if (previous) {
        await previous.socket
          .disconnect()
          .catch((error) =>
            logger.warn({ error, agentId }, 'Failed to replace the prior Slack connection cleanly'),
          )
      }
      const web = new WebClient(config.botToken)
      const auth = await web.auth.test()
      const botUserId = typeof auth.user_id === 'string' ? auth.user_id : ''
      const teamId = typeof auth.team_id === 'string' ? auth.team_id : ''
      if (!botUserId || !teamId)
        throw new Error('Slack auth.test did not return bot user or team id')

      const socket = new SocketModeClient({ appToken: config.appToken })
      const connection: SlackConnection = {
        config,
        socket,
        web,
        botUserId,
        teamId,
        socketOpen: false,
      }
      this.connections.set(agentId, connection)

      socket.on('connected', () => {
        connection.socketOpen = true
      })
      socket.on('disconnecting', () => {
        connection.socketOpen = false
      })
      socket.on('disconnected', (error?: unknown) => {
        connection.socketOpen = false
        if (error) logger.warn({ error, agentId }, 'Slack Socket Mode disconnected')
      })
      socket.on('error', (error: unknown) => {
        logger.error({ error, agentId }, 'Slack Socket Mode error')
      })

      const handleEvent = (envelope: SlackEventEnvelope) => {
        void this.handleEnvelope(agentId, connection, envelope).catch((error) =>
          logger.error({ error, agentId }, 'Slack event handler failed unexpectedly'),
        )
      }
      socket.on('message', handleEvent)
      socket.on('app_mention', handleEvent)
      await socket.start()
    } catch (error) {
      this.connections.delete(agentId)
      if (this.appHolders.get(config.appId) === agentId) this.appHolders.delete(config.appId)
      // Listeners are attached before `socket.start()`, so a failed startup can
      // still have deferred a mention against the connection being discarded.
      this.clearPendingMentions(agentId)
      throw error
    }
  }

  private async handleEnvelope(
    agentId: string,
    connection: SlackConnection,
    envelope: SlackEventEnvelope,
  ): Promise<void> {
    const event = envelope.event
    if (!event || !shouldTriggerSlackEvent(connection.config, event, connection.botUserId)) {
      await envelope.ack()
      return
    }

    const nativeAttachments = extractSlackNativeAttachments(event)
    const textIntent = stripSlackBotMention(event.text ?? '', connection.botUserId)
    if (!textIntent && nativeAttachments.length === 0) {
      await envelope.ack()
      return
    }
    const intent = textIntent || 'Please review the attached files.'

    const isDirectMessage = event.channel_type === 'im' || event.channel.startsWith('D')
    const { ctx, displayName } = buildSlackChannel({
      appId: connection.config.appId,
      teamId: envelope.body?.team_id ?? connection.teamId,
      channelId: event.channel,
      messageTs: event.ts ?? '',
      ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
      senderUserId: event.user ?? '',
      chatType: isDirectMessage ? 'p2p' : 'channel',
    })
    const eventId = buildSlackDedupKey(
      envelope.body?.team_id ?? connection.teamId,
      event.channel,
      event.ts,
    )

    // A `message` envelope supersedes any deferred `app_mention` for the same
    // message: it carries the attachments the mention payload lacks. Scope the
    // key by Agent so two Agents in one workspace never cancel each other.
    const pendingKey = `${agentId} ${eventId}`
    const deferred = this.pendingMentions.get(pendingKey)
    if (deferred) {
      clearTimeout(deferred.timer)
      this.pendingMentions.delete(pendingKey)
      // The superseding envelope owns this message now, so acknowledge the
      // mention we are dropping instead of leaving it for redelivery.
      await deferred
        .ack()
        .catch((error) =>
          logger.warn({ error, agentId, eventId }, 'Failed to ack a superseded Slack mention'),
        )
    }
    if (event.type === 'app_mention') {
      // Register before the first await: `stop()` sweeps this map, and a timer
      // armed after that sweep would outlive the connection it belongs to.
      const timer = setTimeout(() => {
        this.pendingMentions.delete(pendingKey)
        void this.reserve(agentId, eventId, {
          connection,
          event,
          intent,
          ctx: ctx as RunChannelContextSlack,
          displayName,
          nativeAttachments,
        })
          // Acknowledge only once the reservation has committed, exactly as the
          // immediate path does: a transient failure must leave the envelope
          // un-acked so Slack redelivers rather than dropping the mention.
          .then(() => envelope.ack())
          .catch((error) =>
            logger.error({ error, agentId, eventId }, 'Failed to reserve deferred Slack mention'),
          )
      }, SLACK_APP_MENTION_GRACE_MS)
      // Never hold the process open for a pending mention.
      timer.unref?.()
      this.pendingMentions.set(pendingKey, { timer, ack: envelope.ack })
      return
    }

    try {
      await this.reserve(agentId, eventId, {
        connection,
        event,
        intent,
        ctx: ctx as RunChannelContextSlack,
        displayName,
        nativeAttachments,
      })
      // Acknowledge only after the unique event reservation has committed.
      await envelope.ack()
    } catch (error) {
      // No acknowledgement on persistence failure: Slack will redeliver the event.
      logger.error({ error, agentId, eventId }, 'Failed to reserve Slack event')
    }
  }

  private async reserve(
    agentId: string,
    eventId: string,
    input: {
      connection: SlackConnection
      event: SlackMessageEvent
      intent: string
      ctx: RunChannelContextSlack
      displayName?: string | null
      nativeAttachments: PersistedNativeChatAttachment[]
    },
  ): Promise<void> {
    const { connection, event, intent, ctx, displayName, nativeAttachments } = input
    const result = await reserveNativeChatRun({
      agentId,
      source: 'slack',
      eventId,
      conversationId: buildSlackConversationId(connection.teamId, event),
      intent,
      channel: ctx,
      displayName,
      nativeAttachments,
    })
    if (result.status === 'queue_full') {
      await this.sendMessageByContext(agentId, ctx, 'Agent queue is full.')
    } else if (result.status === 'scheduling_failed') {
      await this.sendMessageByContext(agentId, ctx, 'Agent could not schedule this message.')
    }
  }

  async sendMessageByContext(
    agentId: string,
    context: RunChannelContextSlack,
    text: string,
  ): Promise<void> {
    await this.sendRunResultByContext(agentId, context, text, [])
  }

  async sendRunResultByContext(
    agentId: string,
    context: RunChannelContextSlack,
    text: string,
    artifacts: RegisteredArtifact[],
  ): Promise<void> {
    const info = context.channel_info
    const activeConnection = this.connections.get(agentId)
    let replyConnection: Pick<SlackConnection, 'config' | 'web'>
    if (activeConnection) {
      replyConnection = activeConnection
    } else {
      const agent = (
        await db
          .select({ slackConfig: agents.slackConfig })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1)
      )[0]
      if (!agent?.slackConfig) throw new Error('Slack configuration is unavailable')
      const config = slackConfigSchema.parse(agent.slackConfig)
      replyConnection = {
        config,
        web: new WebClient(config.botToken),
      }
    }

    const replyMode =
      info.chat_type === 'p2p'
        ? replyConnection.config.p2pReplyMode
        : replyConnection.config.groupReplyMode
    if (replyMode === 'none') return
    const threadTs = replyMode === 'thread' ? (info.thread_ts ?? info.message_ts) : undefined
    const postMarkdown = async (markdown: string): Promise<void> => {
      const neutralizedMarkdown = neutralizeSlackMentions(markdown)
      for (const chunk of chunkSlackText(neutralizedMarkdown)) {
        await replyConnection.web.chat.postMessage({
          channel: info.channel_id,
          text: buildSlackPlainTextFallback(chunk),
          blocks: [{ type: 'markdown', text: chunk }],
          ...(threadTs ? { thread_ts: threadTs } : {}),
        })
      }
    }
    const uploadArtifacts = replyConnection.config.sendArtifactsAsFile && artifacts.length > 0
    const preparedText = prepareNativeChatText(text, uploadArtifacts)
    if (preparedText) await postMarkdown(preparedText)
    if (!replyConnection.config.sendArtifactsAsFile) return

    const failedArtifacts: RegisteredArtifact[] = []
    for (const artifact of artifacts) {
      try {
        const upload = prepareNativeArtifactUpload(artifact)
        if (!upload) {
          failedArtifacts.push(artifact)
          continue
        }
        const uploadArgs = {
          channel_id: info.channel_id,
          file: upload.data,
          filename: upload.filename,
          title: upload.filename,
        }
        if (threadTs) {
          await replyConnection.web.filesUploadV2({ ...uploadArgs, thread_ts: threadTs })
        } else {
          await replyConnection.web.filesUploadV2(uploadArgs)
        }
      } catch (error) {
        failedArtifacts.push(artifact)
        logger.warn(
          { error, agentId, artifactId: artifact.id, filename: artifact.filename },
          'Failed to upload artifact to Slack',
        )
      }
    }
    if (failedArtifacts.length > 0) {
      await postMarkdown(
        appendNativeArtifactDownloadSection(
          '⚠️ Some artifacts could not be uploaded.',
          await buildArtifactLinkLinesSync(failedArtifacts),
        ),
      )
    }
  }

  async stop(agentId: string): Promise<void> {
    const connection = this.connections.get(agentId)
    if (!connection) return
    this.connections.delete(agentId)
    if (this.appHolders.get(connection.config.appId) === agentId) {
      this.appHolders.delete(connection.config.appId)
    }
    connection.socketOpen = false
    // Drop deferred mentions: a stopped Agent must not start a run afterwards.
    this.clearPendingMentions(agentId)
    await connection.socket
      .disconnect()
      .catch((error) =>
        logger.warn({ error, agentId }, 'Failed to disconnect Slack Socket Mode cleanly'),
      )
  }

  private clearPendingMentions(agentId: string): void {
    for (const [key, pending] of this.pendingMentions) {
      if (key.startsWith(`${agentId} `)) {
        clearTimeout(pending.timer)
        this.pendingMentions.delete(key)
        // Leave the envelope un-acked: the Agent is going away, so let Slack
        // redeliver to whatever connection takes over.
      }
    }
  }

  stopAll(): void {
    for (const agentId of this.connections.keys()) void this.stop(agentId)
  }

  isRegistered(agentId: string): boolean {
    return this.connections.has(agentId)
  }

  isSocketOpen(agentId: string): boolean {
    return this.connections.get(agentId)?.socketOpen ?? false
  }

  getConnectionStatuses(): Array<{ agentId: string; socketOpen: boolean }> {
    return [...this.connections.entries()].map(([agentId, value]) => ({
      agentId,
      socketOpen: value.socketOpen,
    }))
  }

  async restoreConnections(): Promise<void> {
    const published = await (
      await db.select().from(agents).where(eq(agents.publishStatus, 'published'))
    ).filter((agent) => (agent.publishChannels ?? []).includes('slack') && agent.slackConfig)
    for (const agent of published) {
      try {
        await this.start(agent.id, agent.slackConfig as SlackConfig)
      } catch (error) {
        logger.error({ error, agentId: agent.id }, 'Failed to restore Slack connection')
      }
    }
  }
}

export const slackConnectionManager = new SlackConnectionManager()
