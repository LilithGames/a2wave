import { readFile, stat } from 'node:fs/promises'
import type {
  AttachmentRef,
  QQOfficialChannelInfo,
  QQOfficialConfig,
  RunChannelContextQQOfficial,
} from '@a2wave/shared'
import { qqOfficialConfigSchema } from '@a2wave/shared'
import { eq } from 'drizzle-orm'
import WebSocket from 'ws'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { buildArtifactLinkLinesSync } from './artifact-links.js'
import { getDirectorySourceSize, type RegisteredArtifact } from './artifact-storage.js'
import { deleteStagedAttachment } from './attachment-storage.js'
import { logger } from './logger.js'
import { prepareNativeArtifactUpload } from './native-chat-artifacts.js'
import {
  type NativeChatAttachment,
  resolveNativeChatAttachments,
} from './native-chat-attachments.js'
import {
  isNativeChatRunReservedError,
  preflightNativeChatRun,
  reserveNativeChatRun,
} from './native-chat-runner.js'
import { appendNativeArtifactDownloadSection, prepareNativeChatText } from './native-chat-text.js'
import { newCommandPlugin } from './pipeline/commands/defs/new.js'
import { matchByLongestPrefix } from './pipeline/commands/prefix-matcher.js'
import { buildQQOfficialChannel } from './run-channel.js'

const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const QQ_API_ORIGIN = 'https://api.sgroup.qq.com'
const DEFAULT_HEARTBEAT_MS = 30_000
const CONNECT_TIMEOUT_MS = 15_000
const RECONNECT_DELAY_MS = 1_000
const SESSION_START_WINDOW_MS = 5_000
const TEXT_CHUNK_LENGTH = 1_800
export const QQ_MAX_ARTIFACT_UPLOAD_BYTES = 20 * 1024 * 1024

const QQ_GROUP_AND_C2C_INTENT = 1 << 25

type NormalizedQQOfficialConfig = ReturnType<typeof qqOfficialConfigSchema.parse>
type QQScene = 'group' | 'c2c'

async function cleanupQQAttachmentRefs(
  agentId: string,
  messageId: string,
  attachments: AttachmentRef[],
): Promise<void> {
  const results = await Promise.allSettled(
    attachments.map((attachment) => deleteStagedAttachment(attachment.token)),
  )
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn(
        { error: result.reason, agentId, messageId },
        'Failed to clean up unreserved QQ attachment',
      )
    }
  }
}

export function buildQQOfficialIntents(): number {
  return QQ_GROUP_AND_C2C_INTENT
}

export function classifyQQGatewayClose(code: number): {
  clearSession: boolean
  invalidateToken: boolean
} {
  return {
    clearSession: code === 4004 || code === 4006 || code === 4007 || code === 9001 || code === 9005,
    invalidateToken: code === 4004,
  }
}

export function planQQShardStarts(
  shardCount: number,
  limit?: { remaining?: number; max_concurrency?: number },
): number[][] {
  const reportedRemaining = limit?.remaining
  const remaining =
    typeof reportedRemaining === 'number' && Number.isFinite(reportedRemaining)
      ? Math.max(0, reportedRemaining)
      : shardCount
  if (remaining < shardCount) {
    throw new Error(
      `QQ Gateway session start limit has ${remaining} remaining, but ${shardCount} shards are required`,
    )
  }
  const reportedConcurrency = limit?.max_concurrency
  const maxConcurrency =
    typeof reportedConcurrency === 'number' && Number.isFinite(reportedConcurrency)
      ? Math.max(1, reportedConcurrency)
      : shardCount
  const shardIds = Array.from({ length: shardCount }, (_, id) => id)
  const batches: number[][] = []
  for (let offset = 0; offset < shardIds.length; offset += maxConcurrency) {
    batches.push(shardIds.slice(offset, offset + maxConcurrency))
  }
  return batches
}

/** Apply QQ's session-start window to every Identify, including reconnects. */
export class QQIdentifyLimiter {
  private gate = Promise.resolve()
  private windowStartedAt: number | undefined
  private startsInWindow = 0

  constructor(
    private readonly maxConcurrency: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  acquire(): Promise<void> {
    const acquired = this.gate.then(async () => {
      let current = this.now()
      if (
        this.windowStartedAt == null ||
        current - this.windowStartedAt >= SESSION_START_WINDOW_MS
      ) {
        this.windowStartedAt = current
        this.startsInWindow = 0
      }
      if (this.startsInWindow >= Math.max(1, this.maxConcurrency)) {
        await this.sleep(Math.max(0, this.windowStartedAt + SESSION_START_WINDOW_MS - current))
        current = this.now()
        this.windowStartedAt = current
        this.startsInWindow = 0
      }
      this.startsInWindow += 1
    })
    this.gate = acquired.catch(() => undefined)
    return acquired
  }
}

export interface QQOfficialAttachmentSnapshot {
  url: string
  filename: string
  contentType?: string
  size?: number
}

export interface QQOfficialMessageSnapshot {
  eventType: string
  id: string
  scene: QQScene
  senderOpenId: string
  senderName?: string
  content: string
  groupOpenId?: string
  attachments: QQOfficialAttachmentSnapshot[]
  mentionedBot: boolean
}

interface QQGatewayEnvelope {
  op: number
  d?: unknown
  s?: number
  t?: string
}

interface QQGatewayInfo {
  url: string
  shards?: number
  session_start_limit?: {
    remaining?: number
    max_concurrency?: number
  }
}

interface QQToken {
  value: string
  expiresAt: number
}

class QQApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message)
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function qqFileType(mimeType: string): number {
  if (mimeType.startsWith('image/')) return 1
  if (mimeType.startsWith('video/')) return 2
  if (mimeType.startsWith('audio/')) return 3
  return 4
}

function normalizeAttachments(value: unknown): QQOfficialAttachmentSnapshot[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const attachment = recordValue(item)
    const url = stringValue(attachment.url)
    if (!url) return []
    const filename =
      stringValue(attachment.filename) || stringValue(attachment.name) || 'attachment.bin'
    return [
      {
        url,
        filename,
        ...(stringValue(attachment.content_type)
          ? { contentType: stringValue(attachment.content_type) }
          : {}),
        ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
      },
    ]
  })
}

/** Normalize the QQ group and C2C message dispatches supported by the MVP. */
export function normalizeQQOfficialMessage(
  eventType: string,
  raw: unknown,
): QQOfficialMessageSnapshot | null {
  const data = recordValue(raw)
  const author = recordValue(data.author)
  const id = stringValue(data.id)
  if (!id) return null

  let scene: QQScene
  let senderOpenId = ''
  const details: Pick<QQOfficialMessageSnapshot, 'groupOpenId'> = {}
  if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
    scene = 'group'
    senderOpenId = stringValue(author.member_openid)
    details.groupOpenId = stringValue(data.group_openid)
    if (!details.groupOpenId) return null
  } else if (eventType === 'C2C_MESSAGE_CREATE') {
    scene = 'c2c'
    senderOpenId = stringValue(author.user_openid)
  } else {
    return null
  }
  if (!senderOpenId) return null

  const mentionedBot = eventType === 'GROUP_AT_MESSAGE_CREATE'
  const content = stringValue(data.content)
    .replace(/^<@!?[^>]+>\s*/, '')
    .trim()
  return {
    eventType,
    id,
    scene,
    senderOpenId,
    ...(stringValue(author.username) ? { senderName: stringValue(author.username) } : {}),
    content,
    ...details,
    attachments: normalizeAttachments(data.attachments),
    mentionedBot,
  }
}

export function shouldTriggerQQOfficialMessage(
  config: NormalizedQQOfficialConfig,
  message: QQOfficialMessageSnapshot,
): boolean {
  if (message.scene === 'group') {
    return config.groupTriggerOnAt && message.mentionedBot
  }
  return true
}

function resolveQQOfficialIntent(message: QQOfficialMessageSnapshot): {
  intent: string
  resetSession: boolean
} {
  const fallback = message.content || 'Please review the attached files.'
  if (message.scene === 'group') {
    const sender = JSON.stringify({
      member_openid: message.senderOpenId,
      username: message.senderName ?? null,
    })
    return {
      intent: `[QQ group sender metadata]\n${sender}\n\n${fallback}`,
      resetSession: false,
    }
  }

  const match = matchByLongestPrefix(message.content, [newCommandPlugin])
  if (!match) return { intent: fallback, resetSession: false }
  return {
    intent: match.rest || newCommandPlugin.emptyTextFallback || fallback,
    resetSession: true,
  }
}

export function buildQQOfficialConversationId(
  appId: string,
  message: QQOfficialMessageSnapshot,
): string {
  if (message.scene === 'group') {
    return `${appId}:group:${message.groupOpenId}`
  }
  return `${appId}:c2c:${message.senderOpenId}`
}

function chunkText(text: string): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < text.length; offset += TEXT_CHUNK_LENGTH) {
    chunks.push(text.slice(offset, offset + TEXT_CHUNK_LENGTH))
  }
  return chunks
}

export class QQOfficialApiClient {
  private token: QQToken | null = null

  constructor(private readonly config: NormalizedQQOfficialConfig) {}

  invalidateToken(): void {
    this.token = null
  }

  async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value
    const response = await fetch(QQ_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.appSecret }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new QQApiError('QQ app access token request failed', response.status)
    const body = (await response.json()) as { access_token?: string; expires_in?: number | string }
    const value = stringValue(body.access_token)
    if (!value) throw new Error('QQ app access token response is missing access_token')
    const expiresIn = Math.max(60, Number(body.expires_in) || 7200)
    this.token = { value, expiresAt: Date.now() + expiresIn * 1000 }
    return value
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    retry = true,
  ): Promise<T> {
    const token = await this.getToken()
    const response = await fetch(`${QQ_API_ORIGIN}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'X-Union-Appid': this.config.appId,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401 && retry) {
      this.invalidateToken()
      return this.request(method, path, body, false)
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      let errorCode: number | undefined
      try {
        const parsed = JSON.parse(errorText) as { code?: unknown }
        if (typeof parsed.code === 'number') errorCode = parsed.code
      } catch {
        // Some QQ endpoints return plain text for transport-level failures.
      }
      throw new QQApiError(
        `QQ API ${path} returned HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`,
        response.status,
        errorCode,
      )
    }
    return (await response.json()) as T
  }

  async validateBot(): Promise<void> {
    await this.request('GET', '/users/@me')
  }

  async getGateway(): Promise<QQGatewayInfo> {
    const gateway = await this.request<QQGatewayInfo>('GET', '/gateway/bot')
    if (!stringValue(gateway.url)) throw new Error('QQ Gateway response is missing url')
    return gateway
  }

  private target(info: QQOfficialChannelInfo): string {
    if (info.scene === 'group') return `/v2/groups/${encodeURIComponent(info.group_open_id)}`
    return `/v2/users/${encodeURIComponent(info.sender_open_id)}`
  }

  private async sendWithReplyFallback(
    path: string,
    body: Record<string, unknown>,
    reply: boolean,
  ): Promise<void> {
    try {
      await this.request('POST', path, body)
    } catch (error) {
      // QQ passive replies have a short validity window. Match AstrBot's fallback:
      // retry as a new message when the reply anchor has expired.
      if (!reply || !(error instanceof QQApiError) || error.code !== 304026) throw error
      const { msg_id: _expiredReplyAnchor, ...newMessageBody } = body
      await this.request('POST', path, newMessageBody)
    }
  }

  async sendText(
    info: QQOfficialChannelInfo,
    content: string,
    reply: boolean,
    seq: number,
  ): Promise<void> {
    const path = `${this.target(info)}/messages`
    const body: Record<string, unknown> =
      info.scene === 'group' || info.scene === 'c2c'
        ? { content, msg_type: 0, msg_seq: seq }
        : { content }
    if (reply) body.msg_id = info.message_id
    await this.sendWithReplyFallback(path, body, reply)
  }

  async sendArtifact(
    info: Extract<QQOfficialChannelInfo, { scene: 'group' | 'c2c' }>,
    artifact: RegisteredArtifact,
    reply: boolean,
    seq: number,
  ): Promise<void> {
    const sourceSize =
      artifact.kind === 'file'
        ? (await stat(artifact.storagePath)).size
        : getDirectorySourceSize(artifact.storagePath)
    if (sourceSize > QQ_MAX_ARTIFACT_UPLOAD_BYTES) {
      throw new Error(`Artifact exceeds QQ's ${QQ_MAX_ARTIFACT_UPLOAD_BYTES}-byte upload limit`)
    }
    const upload = prepareNativeArtifactUpload(artifact)
    if (!upload) throw new Error('Artifact cannot be prepared for QQ upload')
    const mime = artifact.mimeType ?? 'application/octet-stream'
    const fileData =
      typeof upload.data === 'string' ? await readFile(upload.data) : Buffer.from(upload.data)
    if (fileData.length > QQ_MAX_ARTIFACT_UPLOAD_BYTES) {
      throw new Error(`Artifact exceeds QQ's ${QQ_MAX_ARTIFACT_UPLOAD_BYTES}-byte upload limit`)
    }
    const fileType = qqFileType(mime)
    const uploaded = await this.request<{ file_info?: string }>(
      'POST',
      `${this.target(info)}/files`,
      {
        file_type: fileType,
        file_data: fileData.toString('base64'),
        srv_send_msg: false,
        ...(fileType === 4 ? { file_name: upload.filename } : {}),
      },
    )
    if (!uploaded.file_info) throw new Error('QQ media upload response is missing file_info')
    const body: Record<string, unknown> = {
      msg_type: 7,
      media: { file_info: uploaded.file_info },
      msg_seq: seq,
      ...(reply ? { msg_id: info.message_id } : {}),
    }
    await this.sendWithReplyFallback(`${this.target(info)}/messages`, body, reply)
  }
}

interface QQShardState {
  id: number
  socket?: WebSocket
  sessionId?: string
  sequence: number | null
  heartbeat?: ReturnType<typeof setInterval>
  reconnect?: ReturnType<typeof setTimeout>
  ready: boolean
}

interface QQConnection {
  generation: number
  config: NormalizedQQOfficialConfig
  client: QQOfficialApiClient
  gatewayUrl: string
  shardCount: number
  identifyLimiter: QQIdentifyLimiter
  readyTimeoutMs: number
  shards: Map<number, QQShardState>
  stopping: boolean
}

interface QQPendingStart {
  generation: number
  appId: string
}

class QQStartCancelledError extends Error {
  constructor() {
    super('QQ Official connection start was cancelled')
  }
}

export class QQOfficialConnectionManager {
  private readonly connections = new Map<string, QQConnection>()
  private readonly applicationHolders = new Map<string, string>()
  private readonly pendingStarts = new Map<string, QQPendingStart>()
  private readonly generations = new Map<string, number>()

  constructor(
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  private nextGeneration(agentId: string): number {
    const generation = (this.generations.get(agentId) ?? 0) + 1
    this.generations.set(agentId, generation)
    return generation
  }

  private assertStartCurrent(agentId: string, generation: number): void {
    if (this.pendingStarts.get(agentId)?.generation !== generation) {
      throw new QQStartCancelledError()
    }
  }

  private closeConnection(agentId: string, connection: QQConnection): void {
    connection.stopping = true
    if (this.connections.get(agentId) === connection) this.connections.delete(agentId)
    for (const shard of connection.shards.values()) {
      if (shard.heartbeat) clearInterval(shard.heartbeat)
      if (shard.reconnect) clearTimeout(shard.reconnect)
      shard.socket?.close()
    }
  }

  async start(
    agentId: string,
    rawConfig: QQOfficialConfig | Record<string, unknown>,
  ): Promise<void> {
    const config = qqOfficialConfigSchema.parse(rawConfig)
    const holder = this.applicationHolders.get(config.appId)
    if (holder && holder !== agentId) {
      throw new Error(`QQ application ${config.appId} is already connected by Agent ${holder}`)
    }
    const previous = this.connections.get(agentId)
    if (
      previous &&
      JSON.stringify(previous.config) === JSON.stringify(config) &&
      this.isSocketOpen(agentId)
    ) {
      return
    }
    const generation = this.nextGeneration(agentId)
    const previousPending = this.pendingStarts.get(agentId)
    if (
      previousPending &&
      this.applicationHolders.get(previousPending.appId) === agentId &&
      previousPending.appId !== previous?.config.appId
    ) {
      this.applicationHolders.delete(previousPending.appId)
    }
    this.pendingStarts.set(agentId, { generation, appId: config.appId })
    if (previous) {
      this.closeConnection(agentId, previous)
      if (
        previous.config.appId !== config.appId &&
        this.applicationHolders.get(previous.config.appId) === agentId
      ) {
        this.applicationHolders.delete(previous.config.appId)
      }
    }
    this.applicationHolders.set(config.appId, agentId)
    const client = new QQOfficialApiClient(config)
    let connection: QQConnection | undefined
    try {
      await client.validateBot()
      this.assertStartCurrent(agentId, generation)
      const gateway = await client.getGateway()
      this.assertStartCurrent(agentId, generation)
      const shardCount = Math.max(1, Number(gateway.shards) || 1)
      const shardBatches = planQQShardStarts(shardCount, gateway.session_start_limit)
      const maxConcurrency = Math.max(
        1,
        Number(gateway.session_start_limit?.max_concurrency) || shardCount,
      )
      connection = {
        generation,
        config,
        client,
        gatewayUrl: gateway.url,
        shardCount,
        identifyLimiter: new QQIdentifyLimiter(maxConcurrency),
        readyTimeoutMs:
          CONNECT_TIMEOUT_MS + Math.max(0, shardBatches.length - 1) * SESSION_START_WINDOW_MS,
        shards: new Map(),
        stopping: false,
      }
      this.connections.set(agentId, connection)
      this.pendingStarts.delete(agentId)
      for (const shardIds of shardBatches) {
        for (const id of shardIds) {
          if (this.connections.get(agentId) !== connection) throw new QQStartCancelledError()
          const shard: QQShardState = { id, sequence: null, ready: false }
          connection.shards.set(id, shard)
          this.connectShard(agentId, connection, shard)
        }
      }
      await this.waitForReady(agentId, connection)
    } catch (error) {
      if (connection) this.closeConnection(agentId, connection)
      if (this.pendingStarts.get(agentId)?.generation === generation) {
        this.pendingStarts.delete(agentId)
      }
      const current = this.connections.get(agentId)
      const pending = this.pendingStarts.get(agentId)
      if (
        this.applicationHolders.get(config.appId) === agentId &&
        current?.config.appId !== config.appId &&
        pending?.appId !== config.appId
      ) {
        this.applicationHolders.delete(config.appId)
      }
      throw error
    }
  }

  private connectShard(agentId: string, connection: QQConnection, shard: QQShardState): void {
    if (connection.stopping || this.connections.get(agentId) !== connection) return
    const socket = this.createSocket(connection.gatewayUrl)
    let acceptPayloads = true
    let payloadQueue = Promise.resolve()
    shard.socket = socket
    shard.ready = false
    socket.on('message', (data) => {
      payloadQueue = payloadQueue
        .then(async () => {
          if (!acceptPayloads || shard.socket !== socket) return
          await this.handleGatewayPayload(agentId, connection, shard, data.toString())
        })
        .catch((error) => {
          acceptPayloads = false
          logger.error({ error, agentId, shardId: shard.id }, 'QQ Gateway payload handler failed')
          // Resume from the last durably handled sequence. Do not let a later
          // dispatch overtake and acknowledge the failed event.
          if (shard.socket === socket) socket.close()
        })
    })
    socket.on('error', (error) =>
      logger.warn({ error, agentId, shardId: shard.id }, 'QQ Gateway socket error'),
    )
    socket.on('close', (code) => {
      if (shard.socket !== socket) return
      acceptPayloads = false
      shard.ready = false
      if (shard.heartbeat) clearInterval(shard.heartbeat)
      shard.heartbeat = undefined
      const action = classifyQQGatewayClose(code)
      if (action.invalidateToken) connection.client.invalidateToken()
      if (action.clearSession) {
        shard.sessionId = undefined
        shard.sequence = null
      }
      if (!connection.stopping && this.connections.get(agentId) === connection) {
        shard.reconnect = setTimeout(
          () => this.connectShard(agentId, connection, shard),
          RECONNECT_DELAY_MS,
        )
      }
    })
  }

  private async handleGatewayPayload(
    agentId: string,
    connection: QQConnection,
    shard: QQShardState,
    raw: string,
  ): Promise<void> {
    const payload = JSON.parse(raw) as QQGatewayEnvelope
    if (payload.op === 10) {
      const hello = recordValue(payload.d)
      const heartbeatMs = Math.max(1_000, Number(hello.heartbeat_interval) || DEFAULT_HEARTBEAT_MS)
      if (shard.heartbeat) clearInterval(shard.heartbeat)
      shard.heartbeat = setInterval(() => {
        if (shard.socket?.readyState === WebSocket.OPEN) {
          shard.socket.send(JSON.stringify({ op: 1, d: shard.sequence }))
        }
      }, heartbeatMs)
      const socket = shard.socket
      const shouldResume = Boolean(shard.sessionId)
      if (!shouldResume) await connection.identifyLimiter.acquire()
      if (
        connection.stopping ||
        this.connections.get(agentId) !== connection ||
        shard.socket !== socket ||
        socket?.readyState !== WebSocket.OPEN
      ) {
        return
      }
      const token = `QQBot ${await connection.client.getToken()}`
      const identify = shouldResume
        ? { op: 6, d: { token, session_id: shard.sessionId, seq: shard.sequence } }
        : {
            op: 2,
            d: {
              token,
              intents: buildQQOfficialIntents(),
              shard: [shard.id, connection.shardCount],
            },
          }
      if (shard.socket === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(identify))
      }
      return
    }
    if (payload.op === 7) {
      shard.socket?.close()
      return
    }
    if (payload.op === 9) {
      shard.sessionId = undefined
      shard.sequence = null
      shard.socket?.close()
      return
    }
    if (payload.op !== 0) return
    if (payload.t === 'READY') {
      shard.sessionId = stringValue(recordValue(payload.d).session_id)
      shard.ready = true
      if (typeof payload.s === 'number') shard.sequence = payload.s
      return
    }
    if (payload.t === 'RESUMED') {
      shard.ready = true
      if (typeof payload.s === 'number') shard.sequence = payload.s
      return
    }
    if (payload.t) await this.handleDispatch(agentId, connection, payload.t, payload.d)
    // Heartbeat and Resume must only expose a sequence whose dispatch has
    // completed its durable reserve (or has been deliberately ignored).
    if (typeof payload.s === 'number') shard.sequence = payload.s
  }

  private async handleDispatch(
    agentId: string,
    connection: QQConnection,
    eventType: string,
    data: unknown,
  ): Promise<void> {
    const message = normalizeQQOfficialMessage(eventType, data)
    if (!message || !shouldTriggerQQOfficialMessage(connection.config, message)) return
    const eventId = `qq_official:${message.id}`
    const preflight = await preflightNativeChatRun({
      agentId,
      source: 'qq_official',
      eventId,
    })
    if (preflight.status !== 'ready') return
    const attachments: NativeChatAttachment[] = message.attachments.map((attachment) => ({
      source: 'qq_official',
      remoteUrl: attachment.url,
      name: attachment.filename,
      ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
      ...(attachment.size != null ? { size: attachment.size } : {}),
    }))
    const attachmentRefs = await resolveNativeChatAttachments(agentId, attachments)
    if (!message.content && attachmentRefs.length === 0) return
    const { intent, resetSession } = resolveQQOfficialIntent(message)
    const common = {
      appId: connection.config.appId,
      messageId: message.id,
      senderOpenId: message.senderOpenId,
      ...(message.senderName ? { senderName: message.senderName } : {}),
    }
    const built =
      message.scene === 'group'
        ? buildQQOfficialChannel({
            ...common,
            scene: 'group',
            groupOpenId: message.groupOpenId as string,
          })
        : buildQQOfficialChannel({ ...common, scene: 'c2c' })
    let result: Awaited<ReturnType<typeof reserveNativeChatRun>>
    try {
      result = await reserveNativeChatRun({
        agentId,
        source: 'qq_official',
        eventId,
        conversationId: buildQQOfficialConversationId(connection.config.appId, message),
        intent,
        ...(resetSession ? { resetSession: true } : {}),
        channel: built.ctx as RunChannelContextQQOfficial,
        displayName: built.displayName,
        attachments: attachmentRefs,
        attachmentConsumerId: `agent:${agentId}`,
      })
    } catch (error) {
      if (!isNativeChatRunReservedError(error)) {
        await cleanupQQAttachmentRefs(agentId, message.id, attachmentRefs)
      }
      throw error
    }
    if (result.status === 'duplicate' || result.status === 'ignored') {
      await cleanupQQAttachmentRefs(agentId, message.id, attachmentRefs)
      return
    }
    if (result.status === 'queue_full') {
      await this.sendMessageByContext(
        agentId,
        built.ctx as RunChannelContextQQOfficial,
        'Agent queue is full.',
      ).catch((error) =>
        logger.warn({ error, agentId, messageId: message.id }, 'Failed to send QQ queue reply'),
      )
    } else if (result.status === 'scheduling_failed') {
      await this.sendMessageByContext(
        agentId,
        built.ctx as RunChannelContextQQOfficial,
        'Agent could not schedule this message.',
      ).catch((error) =>
        logger.warn(
          { error, agentId, messageId: message.id },
          'Failed to send QQ scheduling failure reply',
        ),
      )
    }
  }

  private async waitForReady(
    agentId: string,
    expectedConnection?: QQConnection,
  ): Promise<QQConnection> {
    const deadline = Date.now() + (expectedConnection?.readyTimeoutMs ?? CONNECT_TIMEOUT_MS)
    while (Date.now() < deadline) {
      const connection = this.connections.get(agentId)
      if (expectedConnection && connection !== expectedConnection) throw new QQStartCancelledError()
      if (
        connection &&
        connection.shards.size === connection.shardCount &&
        [...connection.shards.values()].every((shard) => shard.ready)
      ) {
        return connection
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('QQ Gateway connection timed out')
  }

  async sendMessageByContext(
    agentId: string,
    context: RunChannelContextQQOfficial,
    text: string,
  ): Promise<void> {
    await this.sendRunResultByContext(agentId, context, text, [])
  }

  async sendRunResultByContext(
    agentId: string,
    context: RunChannelContextQQOfficial,
    text: string,
    artifacts: RegisteredArtifact[],
  ): Promise<void> {
    const connection = await this.waitForReady(agentId)
    const info = context.channel_info
    const replyMode =
      info.scene === 'group' ? connection.config.groupReplyMode : connection.config.c2cReplyMode
    if (replyMode === 'none') return
    const reply = replyMode === 'reply'
    const canUpload = connection.config.sendArtifactsAsFile
    let preparedText = prepareNativeChatText(text, canUpload && artifacts.length > 0)
    if (artifacts.length > 0 && !canUpload) {
      preparedText = appendNativeArtifactDownloadSection(
        preparedText,
        await buildArtifactLinkLinesSync(artifacts),
      )
    }
    let sequence = Math.floor(Date.now() % 1_000_000)
    for (const chunk of chunkText(preparedText)) {
      await connection.client.sendText(info, chunk, reply, sequence++)
    }
    if (!canUpload) return

    const failed: RegisteredArtifact[] = []
    for (const artifact of artifacts) {
      try {
        await connection.client.sendArtifact(info, artifact, reply, sequence++)
      } catch (error) {
        failed.push(artifact)
        logger.warn(
          { error, agentId, artifactId: artifact.id },
          'Failed to upload artifact to QQ Official',
        )
      }
    }
    if (failed.length > 0) {
      const fallback = appendNativeArtifactDownloadSection(
        'Some artifacts could not be uploaded.',
        await buildArtifactLinkLinesSync(failed),
      )
      for (const chunk of chunkText(fallback)) {
        await connection.client.sendText(info, chunk, false, sequence++)
      }
    }
  }

  async stop(agentId: string): Promise<void> {
    this.nextGeneration(agentId)
    const pending = this.pendingStarts.get(agentId)
    if (pending) {
      this.pendingStarts.delete(agentId)
      if (this.applicationHolders.get(pending.appId) === agentId) {
        this.applicationHolders.delete(pending.appId)
      }
    }
    const connection = this.connections.get(agentId)
    if (!connection) return
    this.closeConnection(agentId, connection)
    if (this.applicationHolders.get(connection.config.appId) === agentId) {
      this.applicationHolders.delete(connection.config.appId)
    }
  }

  stopAll(): void {
    const agentIds = new Set([...this.connections.keys(), ...this.pendingStarts.keys()])
    for (const agentId of agentIds) void this.stop(agentId)
  }

  isRegistered(agentId: string): boolean {
    return this.connections.has(agentId)
  }

  isSocketOpen(agentId: string): boolean {
    const connection = this.connections.get(agentId)
    return Boolean(
      connection &&
        connection.shards.size === connection.shardCount &&
        [...connection.shards.values()].every(
          (shard) => shard.ready && shard.socket?.readyState === WebSocket.OPEN,
        ),
    )
  }

  getConnectionStatuses(): Array<{ agentId: string; socketOpen: boolean }> {
    return [...this.connections.keys()].map((agentId) => ({
      agentId,
      socketOpen: this.isSocketOpen(agentId),
    }))
  }

  async restoreConnections(): Promise<void> {
    const published = await db.select().from(agents).where(eq(agents.publishStatus, 'published'))
    for (const agent of published) {
      if (!(agent.publishChannels ?? []).includes('qq_official') || !agent.qqOfficialConfig)
        continue
      try {
        await this.start(agent.id, agent.qqOfficialConfig as QQOfficialConfig)
      } catch (error) {
        logger.error({ error, agentId: agent.id }, 'Failed to restore QQ Official connection')
      }
    }
  }
}

export const qqOfficialConnectionManager = new QQOfficialConnectionManager()
