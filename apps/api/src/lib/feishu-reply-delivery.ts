import type { FeishuConfig } from '@a2wave/shared'
import type { Client } from '@larksuiteoapi/node-sdk'
import { quoteAnchorId } from './feishu-message-context.js'

export type FeishuReplyMode = NonNullable<FeishuConfig['groupReplyMode']>

/** All reply formats use the same Feishu endpoint and message anchor. */
export function deliverFeishuReply(
  client: Client,
  message: { chat_id: string; message_id?: string; quote_message_id?: string },
  mode: Exclude<FeishuReplyMode, 'none'>,
  data: { content: string; msg_type: string },
) {
  const anchorId = quoteAnchorId(message)
  if (mode === 'thread' && !anchorId)
    throw new Error('A Feishu topic reply requires a message anchor')
  if (mode !== 'new' && anchorId) {
    return client.im.message.reply({
      path: { message_id: anchorId },
      data: mode === 'thread' ? { ...data, reply_in_thread: true } : data,
    })
  }
  return client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { ...data, receive_id: message.chat_id },
  })
}
