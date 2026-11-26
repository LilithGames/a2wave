import type { Client } from '@larksuiteoapi/node-sdk'
import { summarizeFeishuError } from './feishu-error-log.js'
import { logger } from './logger.js'

const CHAT_NAME_TTL_MS = 10 * 60_000
const MAX_CACHED_CHATS = 500
const chatNames = new Map<string, { name: string; expiresAt: number }>()

type ChatInfoResponse = Awaited<ReturnType<Client['im']['chat']['get']>>

export async function fetchFeishuChatName(
  client: Pick<Client, 'request'>,
  chatId: string,
  appId: string,
): Promise<string | undefined> {
  const key = `${appId}:${chatId}`
  const cached = chatNames.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.name

  try {
    const result = await client.request<ChatInfoResponse>({
      method: 'GET',
      url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      timeout: 3000,
    })
    const name = result.data?.name
    if (result.code || !name?.trim()) {
      logger.warn({ appId, chatId, feishuCode: result.code }, 'Feishu group name unavailable')
      return undefined
    }
    chatNames.delete(key)
    chatNames.set(key, { name, expiresAt: Date.now() + CHAT_NAME_TTL_MS })
    if (chatNames.size > MAX_CACHED_CHATS) {
      const oldest = chatNames.keys().next()
      if (!oldest.done) chatNames.delete(oldest.value)
    }
    return name
  } catch (err) {
    logger.warn(
      { appId, chatId, err: summarizeFeishuError(err) },
      'Failed to fetch Feishu group name',
    )
    return undefined
  }
}
