import type { ReferencedPromptContext } from '../engine/types.js'

export const FEISHU_REFERENCED_MESSAGE_MAX_CHARS = 12_000

export interface FeishuReferencedMessageIdentity {
  chat_type?: string
  thread_id?: string
  message_id?: string
  parent_id?: string
  root_id?: string
}

export interface FeishuReferencedMessage {
  messageId: string
  messageType: string
  senderType?: string
  text: string
  truncated: boolean
}

type FeishuMessageClient = {
  im: {
    message: {
      get: (request: {
        params: { card_msg_content_type: string }
        path: { message_id: string }
      }) => Promise<unknown>
    }
  }
}

type FeishuMessageTextExtractor = (
  rawContent: string,
  richPost?: boolean,
  messageType?: string,
) => string

/** Resolve the message directly quoted by an ordinary group reply. */
export function resolveFeishuReferencedMessageId(
  enabled: boolean,
  message: FeishuReferencedMessageIdentity,
): string | undefined {
  if (!enabled || message.chat_type !== 'group' || message.thread_id) return undefined
  const referencedId = message.parent_id?.trim() || message.root_id?.trim()
  if (!referencedId || referencedId === message.message_id) return undefined
  return referencedId
}

/** Fetch and parse one quoted message while keeping transport details out of the connection manager. */
export async function fetchFeishuReferencedMessage(
  client: FeishuMessageClient,
  messageId: string,
  extractText: FeishuMessageTextExtractor,
): Promise<FeishuReferencedMessage | null> {
  const response = await client.im.message.get({
    params: { card_msg_content_type: 'user_card_content' },
    path: { message_id: messageId },
  })
  const item = (response as { data?: { items?: unknown[] } })?.data?.items?.[0]
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as {
    msg_type?: unknown
    sender?: { sender_type?: unknown }
    body?: { content?: unknown }
  }
  const messageType = typeof record.msg_type === 'string' ? record.msg_type : 'unknown'
  const rawContent = typeof record.body?.content === 'string' ? record.body.content : ''
  const text =
    messageType === 'interactive'
      ? extractFeishuCardText(rawContent)
      : extractText(rawContent, true, messageType)
  const normalized = normalizeFeishuReferencedText(text)
  if (!normalized.text) return null
  return {
    messageId,
    messageType,
    ...(typeof record.sender?.sender_type === 'string'
      ? { senderType: record.sender.sender_type }
      : {}),
    ...normalized,
  }
}

/** Resolve, fetch, and fail closed for a quoted message lookup. */
export async function resolveFeishuReferencedMessage(
  enabled: boolean,
  message: FeishuReferencedMessageIdentity,
  client: FeishuMessageClient,
  extractText: FeishuMessageTextExtractor,
  onError?: (error: unknown, messageId: string) => void,
): Promise<FeishuReferencedMessage | null> {
  const messageId = resolveFeishuReferencedMessageId(enabled, message)
  if (!messageId) return null
  try {
    return await fetchFeishuReferencedMessage(client, messageId, extractText)
  } catch (error) {
    onError?.(error, messageId)
    return null
  }
}

/** Map a fetched message to the snake_case shape persisted in run context. */
export function toFeishuReferencedMessageContext(
  referenced: FeishuReferencedMessage,
): Record<string, unknown> {
  return {
    message_id: referenced.messageId,
    message_type: referenced.messageType,
    ...(referenced.senderType ? { sender_type: referenced.senderType } : {}),
    truncated: referenced.truncated,
    text: referenced.text,
  }
}

/** Replace quoted body text with length metadata before writing a context log. */
export function summarizeFeishuContextForLog(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const referenced = context.referenced_message
  if (!referenced || typeof referenced !== 'object' || Array.isArray(referenced)) return context
  const metadata = referenced as Record<string, unknown>
  return {
    ...context,
    referenced_message: {
      ...metadata,
      text: undefined,
      textLength: typeof metadata.text === 'string' ? metadata.text.length : 0,
    },
  }
}

const ACTION_TAGS = new Set([
  'action',
  'button',
  'date_picker',
  'input',
  'multi_select_static',
  'overflow',
  'select_static',
])

function collectCardText(node: unknown, output: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectCardText(child, output)
    return
  }
  if (!node || typeof node !== 'object') return

  const record = node as Record<string, unknown>
  const tag = typeof record.tag === 'string' ? record.tag : ''
  if (ACTION_TAGS.has(tag)) return

  const value =
    tag === 'markdown' || tag === 'plain_text' || tag === 'lark_md'
      ? record.content
      : tag === 'text' || tag === 'a'
        ? record.text
        : undefined
  if (typeof value === 'string' && value.trim()) output.push(value.trim())

  for (const key of ['text', 'elements', 'columns', 'fields']) {
    collectCardText(record[key], output)
  }
}

/**
 * Template variables do not identify which values are rendered and which are
 * hidden action payloads. Only accept the exact contract emitted by a2wave's
 * own template-card sender; unknown template layouts fail closed.
 */
function extractPlatformTemplateText(node: unknown): string {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return ''
  const variables = node as Record<string, unknown>
  const keys = Object.keys(variables)
  if (keys.length !== 1 || keys[0] !== 'content') return ''
  return typeof variables.content === 'string' ? variables.content.trim() : ''
}

/** Extract readable text from inline, legacy, and platform-contract template cards. */
export function extractFeishuCardText(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>
    const output: string[] = []

    // CardKit message bodies contain only a card_id reference. The card entity has
    // no readable body here, so leave it unsupported and let the caller skip it.
    if (parsed.type === 'card') return ''

    if (parsed.type === 'template') {
      const data = parsed.data as Record<string, unknown> | undefined
      const text = extractPlatformTemplateText(data?.template_variable)
      if (text) output.push(text)
    } else if (parsed.schema === '2.0') {
      const header = parsed.header as Record<string, unknown> | undefined
      collectCardText(header?.title, output)
      collectCardText(header?.subtitle, output)
      collectCardText(header?.text_tag_list, output)
      const body = parsed.body as Record<string, unknown> | undefined
      collectCardText(body?.elements, output)
    } else {
      const header = parsed.header as Record<string, unknown> | undefined
      collectCardText(header?.title, output)
      collectCardText(header?.subtitle, output)
      if (typeof parsed.title === 'string' && parsed.title.trim()) output.push(parsed.title.trim())
      else collectCardText(parsed.title, output)
      collectCardText(parsed.elements, output)
    }

    return output.join('\n').trim()
  } catch {
    return ''
  }
}

export function normalizeFeishuReferencedText(text: string): {
  text: string
  truncated: boolean
} {
  const normalized = text.trim()
  if (normalized.length <= FEISHU_REFERENCED_MESSAGE_MAX_CHARS) {
    return { text: normalized, truncated: false }
  }
  return {
    text: normalized.slice(0, FEISHU_REFERENCED_MESSAGE_MAX_CHARS),
    truncated: true,
  }
}

export function toFeishuReferencedPromptContext(
  referenced: FeishuReferencedMessage | null | undefined,
): ReferencedPromptContext | undefined {
  if (!referenced) return undefined
  return {
    source: 'feishu',
    messageId: referenced.messageId,
    messageType: referenced.messageType,
    ...(referenced.senderType ? { senderType: referenced.senderType } : {}),
    text: referenced.text,
    truncated: referenced.truncated,
  }
}

/** Rebuild the prompt-only reference from the complete context persisted on a run step. */
export function getFeishuReferencedPromptContext(
  context: Record<string, unknown> | undefined,
): ReferencedPromptContext | undefined {
  return getPersistedReferencedPromptContext(context, 'feishu')
}

/** Restore bounded quoted material persisted by Feishu or an A2A hop. */
export function getPersistedReferencedPromptContext(
  context: Record<string, unknown> | undefined,
  fallbackSource: string,
): ReferencedPromptContext | undefined {
  const raw = context?.referenced_message
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined

  const message = raw as Record<string, unknown>
  if (typeof message.text !== 'string') return undefined
  const normalized = normalizeFeishuReferencedText(message.text)
  if (!normalized.text) return undefined

  const source =
    typeof message.source === 'string' && message.source.trim()
      ? message.source.trim()
      : fallbackSource
  return {
    source,
    ...(typeof message.message_id === 'string' ? { messageId: message.message_id } : {}),
    ...(typeof message.message_type === 'string' ? { messageType: message.message_type } : {}),
    ...(typeof message.sender_type === 'string' ? { senderType: message.sender_type } : {}),
    text: normalized.text,
    truncated: message.truncated === true || normalized.truncated,
  }
}
