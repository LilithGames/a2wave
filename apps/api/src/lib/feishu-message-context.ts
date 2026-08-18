type FeishuMessageContext = {
  chat_type?: string
  chat_id?: string
  thread_id?: string
  root_id?: string
  message_id?: string
  quote_message_id?: string
}

/**
 * Build the stable session key used to continue a Feishu conversation.
 * Topics use thread_id, direct messages use chat_id, and ordinary group reply
 * chains fall back through root_id to the current message_id.
 */
export function buildTriggerSessionId(message: FeishuMessageContext): string | null {
  if (message.thread_id) return message.thread_id
  if (message.chat_type === 'p2p') return message.chat_id ?? null
  if (message.root_id) return message.root_id
  if (message.message_id) return message.message_id
  return null
}

/** A direct-message session goes stale after two idle hours; the next message starts a new one. */
export const P2P_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000

/**
 * How long the previous session of this message stays resumable.
 *
 * A topic never expires, and neither does a group reply chain: `root_id` is
 * that chain's session key above, so each chain gets an independent line.
 *
 * Direct messages are the exception. Their session key is `chat_id`, and
 * `root_id` never reaches the lookup — so honouring it there splits nothing
 * off, it only removes the expiry from the one line the chat has. That is how
 * a quoted reply used to resurrect a days-old conversation.
 */
export function resolveSessionTimeoutMs(message: FeishuMessageContext): number {
  if (message.thread_id) return Number.POSITIVE_INFINITY
  if (message.chat_type !== 'p2p' && message.root_id) return Number.POSITIVE_INFINITY
  return P2P_SESSION_TIMEOUT_MS
}

/** Keep chained replies anchored to the original question when one is available. */
export function quoteAnchorId(message: FeishuMessageContext): string {
  return (message.quote_message_id ?? message.message_id) as string
}
