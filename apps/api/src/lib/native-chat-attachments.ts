import { extname } from 'node:path'
import type { AttachmentRef, DiscordConfig, SlackConfig } from '@a2wave/shared'
import { discordConfigSchema, slackConfigSchema } from '@a2wave/shared'
import { WebClient } from '@slack/web-api'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { stageAttachment } from './attachment-storage.js'
import { logger } from './logger.js'
import { getAttachmentSettings } from './settings.js'
import { assertSafeStrictUrl, safeFetch } from './url-safety-core.js'

export type NativeChatAttachment =
  | {
      source: 'slack'
      remoteId: string
      name: string
      mimeType?: string
      size?: number
    }
  | {
      source: 'discord'
      remoteId: string
      channelId: string
      messageId: string
      name: string
      mimeType?: string
      size?: number
    }
  | {
      source: 'qq_official'
      remoteUrl: string
      name: string
      mimeType?: string
      size?: number
    }

export type PersistedNativeChatAttachment = Exclude<NativeChatAttachment, { source: 'qq_official' }>

const FETCH_TIMEOUT_MS = 15_000
const SLACK_FILE_HOSTS = new Set(['files.slack.com'])
const DISCORD_FILE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])

function isAllowedExtension(name: string, allowed: Set<string>): boolean {
  const extension = extname(name).replace(/^\./, '').toLowerCase()
  return extension.length > 0 && allowed.has(extension)
}

function hasDisallowedDeclaredExtension(name: string, allowed: Set<string>): boolean {
  return extname(name).length > 0 && !isAllowedExtension(name, allowed)
}

function assertVendorUrl(url: string, allowedHosts: Set<string>): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error('Attachment download URL is not an allowed vendor URL')
  }
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error('Attachment response has no body')
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('Attachment response exceeds the configured size limit')
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length
    if (total > maxBytes) throw new Error('Attachment response exceeds the configured size limit')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function fetchVendorBytes(
  url: string,
  allowedHosts: Set<string>,
  maxBytes: number,
  authorization?: string,
): Promise<{ bytes: Buffer; mimeType?: string }> {
  assertVendorUrl(url, allowedHosts)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await safeFetch(url, {
      signal: controller.signal,
      maxRedirects: 0,
      headers: authorization ? { Authorization: authorization } : undefined,
      validateHop: (hop) => assertVendorUrl(hop, allowedHosts),
    })
    if (!response.ok) throw new Error(`Attachment download returned HTTP ${response.status}`)
    return {
      bytes: await readBodyWithLimit(response, maxBytes),
      mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || undefined,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function resolveSlackAttachment(
  descriptor: Extract<NativeChatAttachment, { source: 'slack' }>,
  config: SlackConfig,
  maxBytes: number,
): Promise<{ bytes: Buffer; name: string; mimeType: string }> {
  const normalized = slackConfigSchema.parse(config)
  const response = await new WebClient(normalized.botToken).files.info({
    file: descriptor.remoteId,
  })
  const file = (
    response as {
      file?: {
        name?: string
        title?: string
        mimetype?: string
        size?: number
        url_private?: string
        url_private_download?: string
      }
    }
  ).file
  if (!file) throw new Error('Slack files.info returned no file')
  const size = file.size ?? descriptor.size
  if (size != null && size > maxBytes) throw new Error('Slack file exceeds configured size limit')
  const url = file.url_private_download ?? file.url_private
  if (!url) throw new Error('Slack file has no private download URL')
  const downloaded = await fetchVendorBytes(
    url,
    SLACK_FILE_HOSTS,
    maxBytes,
    `Bearer ${normalized.botToken}`,
  )
  return {
    bytes: downloaded.bytes,
    name: file.name ?? file.title ?? descriptor.name,
    mimeType:
      file.mimetype ?? descriptor.mimeType ?? downloaded.mimeType ?? 'application/octet-stream',
  }
}

async function resolveDiscordAttachment(
  descriptor: Extract<NativeChatAttachment, { source: 'discord' }>,
  config: DiscordConfig,
  maxBytes: number,
): Promise<{ bytes: Buffer; name: string; mimeType: string }> {
  const normalized = discordConfigSchema.parse(config)
  const messageUrl = `https://discord.com/api/v10/channels/${encodeURIComponent(
    descriptor.channelId,
  )}/messages/${encodeURIComponent(descriptor.messageId)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let attachment: {
    id: string
    filename?: string
    title?: string
    content_type?: string
    size?: number
    url?: string
  }
  try {
    const response = await safeFetch(messageUrl, {
      signal: controller.signal,
      maxRedirects: 0,
      headers: { Authorization: `Bot ${normalized.botToken}` },
      validateHop: (hop) => {
        const parsed = new URL(hop)
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'discord.com') {
          throw new Error('Discord API URL is not allowed')
        }
      },
    })
    if (!response.ok) throw new Error(`Discord message fetch returned HTTP ${response.status}`)
    const message = (await response.json()) as { attachments?: (typeof attachment)[] }
    const found = message.attachments?.find((item) => item.id === descriptor.remoteId)
    if (!found) throw new Error('Discord message no longer contains the attachment')
    attachment = found
  } finally {
    clearTimeout(timer)
  }

  const size = attachment.size ?? descriptor.size
  if (size != null && size > maxBytes)
    throw new Error('Discord attachment exceeds configured size limit')
  if (!attachment.url) throw new Error('Discord attachment has no CDN URL')
  const downloaded = await fetchVendorBytes(attachment.url, DISCORD_FILE_HOSTS, maxBytes)
  return {
    bytes: downloaded.bytes,
    name: attachment.title ?? attachment.filename ?? descriptor.name,
    mimeType:
      attachment.content_type ??
      descriptor.mimeType ??
      downloaded.mimeType ??
      'application/octet-stream',
  }
}

async function resolveQQOfficialAttachment(
  descriptor: Extract<NativeChatAttachment, { source: 'qq_official' }>,
  maxBytes: number,
): Promise<{ bytes: Buffer; name: string; mimeType: string }> {
  assertSafeQQOfficialAttachmentUrl(descriptor.remoteUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await safeFetch(descriptor.remoteUrl, {
      signal: controller.signal,
      maxRedirects: 0,
      validateHop: assertSafeQQOfficialAttachmentUrl,
    })
    if (!response.ok) throw new Error(`QQ attachment download returned HTTP ${response.status}`)
    return {
      bytes: await readBodyWithLimit(response, maxBytes),
      name: descriptor.name,
      mimeType:
        descriptor.mimeType ??
        response.headers.get('content-type')?.split(';')[0]?.trim() ??
        'application/octet-stream',
    }
  } finally {
    clearTimeout(timer)
  }
}

function assertSafeQQOfficialAttachmentUrl(url: string): void {
  const parsed = assertSafeStrictUrl(url)
  if (parsed.protocol !== 'https:') throw new Error('QQ attachment URL must use HTTPS')
}

/**
 * Resolve persisted native-chat attachment identifiers after event reservation.
 * Tokens and signed CDN URLs are deliberately not persisted. Each successful
 * download is staged under the stable Agent consumer identity so queued runs,
 * restart recovery, and rerun use the existing attachment materializer.
 */
export async function resolveNativeChatAttachments(
  agentId: string,
  descriptors: NativeChatAttachment[],
): Promise<AttachmentRef[]> {
  if (descriptors.length === 0) return []
  const settings = getAttachmentSettings()
  const capped = descriptors.slice(0, (await settings).maxFilesPerRequest)
  const agent = (
    await db
      .select({ slackConfig: agents.slackConfig, discordConfig: agents.discordConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
  )[0]
  if (!agent) return []

  const refs: AttachmentRef[] = []
  for (const descriptor of capped) {
    try {
      // Slack Connect may initially expose only a file id. Refresh metadata first
      // when the event-side placeholder has no extension, then enforce the policy.
      if (hasDisallowedDeclaredExtension(descriptor.name, (await settings).allowedExtensions)) {
        throw new Error('Attachment extension is not allowed')
      }
      if (descriptor.size != null && descriptor.size > (await settings).maxFileSizeBytes) {
        throw new Error('Attachment exceeds configured size limit')
      }
      const resolved =
        descriptor.source === 'slack'
          ? await resolveSlackAttachment(
              descriptor,
              agent.slackConfig as SlackConfig,
              (await settings).maxFileSizeBytes,
            )
          : descriptor.source === 'discord'
            ? await resolveDiscordAttachment(
                descriptor,
                agent.discordConfig as DiscordConfig,
                (await settings).maxFileSizeBytes,
              )
            : await resolveQQOfficialAttachment(descriptor, (await settings).maxFileSizeBytes)
      if (!isAllowedExtension(resolved.name, (await settings).allowedExtensions)) {
        throw new Error('Resolved attachment extension is not allowed')
      }
      const staged = await stageAttachment(
        resolved.bytes,
        resolved.name,
        resolved.mimeType,
        `agent:${agentId}`,
      )
      refs.push({
        token: staged.token,
        name: staged.meta.name,
        mimeType: staged.meta.mimeType,
        size: staged.meta.size,
      })
    } catch (error) {
      logger.warn(
        {
          agentId,
          source: descriptor.source,
          attachmentId: descriptor.source === 'qq_official' ? undefined : descriptor.remoteId,
          errorType: error instanceof Error ? error.name : 'unknown',
        },
        'Failed to resolve native chat attachment, skipping',
      )
    }
  }
  return refs
}
