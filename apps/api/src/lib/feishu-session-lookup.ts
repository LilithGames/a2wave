import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import type { NormalizedFeishuConfig } from './feishu-config.js'
import {
  buildTriggerSessionId,
  FEISHU_GROUP_TOPIC_PREFIX,
  type FeishuMessageContext,
  isFeishuGroupTopicSession,
} from './feishu-message-context.js'
import { jsonExtractText } from './json-sql.js'
import { logger } from './logger.js'

/**
 * How many rows the newest-second tie-break reads. `created_at` is second-granular, so
 * runs started in the same second tie and either database may return them in any order;
 * the tie set is however many messages the same session could start within one second,
 * which in practice is two.
 */
const SESSION_TIE_BREAK_SCAN = 4

/**
 * Feishu assigns a thread id after we open a topic under an ordinary
 * message. Its comments carry the opener's message id as their root_id.
 * A distinct key keeps a quoted opener independent of its old reply chain
 * and lets existing native topics keep their original thread-id sessions.
 */
export async function resolveFeishuTriggerSessionId(
  agentId: string,
  message: FeishuMessageContext,
  groupReplyMode: NormalizedFeishuConfig['groupReplyMode'],
): Promise<string | null> {
  if (message.chat_type === 'group') {
    if (!message.thread_id && groupReplyMode === 'thread' && message.message_id) {
      return `${FEISHU_GROUP_TOPIC_PREFIX}${message.message_id}`
    }
    if (message.thread_id && message.root_id) {
      const openerKey = `${FEISHU_GROUP_TOPIC_PREFIX}${message.root_id}`
      const [opener] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.initiatorAgentId, agentId),
            eq(runs.triggerSource, 'feishu'),
            eq(runs.triggerSessionId, openerKey),
          ),
        )
        .limit(1)
      if (opener) return openerKey
    }
  }
  return buildTriggerSessionId(message)
}

/**
 * Resolve the chatId of the session's most recent completed run, so the engine can be
 * handed the prior context and continue the conversation.
 * - After every run the engine writes the chatId the LLM returned into runs.result.chatId
 * - The next message with the same triggerSessionId passes that chatId back to the engine
 * - sessionTimeoutMs bounds it: past the timeout this returns null and the engine opens a
 *   fresh session. Callers derive the value with resolveSessionTimeoutMs.
 */
export interface PreviousFeishuSession {
  runId: string
  chatId: string
  conversationId: string
}

/**
 * Return the same completed row used for provider-session resumption together
 * with its durable UI conversation. A stale row or one without a provider
 * chat id cannot be resumed and therefore cannot belong to the next session.
 */
export async function lookupPreviousFeishuSession(
  agentId: string,
  triggerSessionId: string,
  sessionTimeoutMs: number,
  opts: { chatId?: string } = {},
): Promise<PreviousFeishuSession | null> {
  // An ordinary-group topic executes one turn at a time, so the last
  // completion has the current chat id even if admission reordered arrivals.
  // Other sessions keep the index-backed created_at scan and tie-break below.
  const groupTopic = isFeishuGroupTopicSession(triggerSessionId)
  const order = groupTopic ? [desc(runs.updatedAt), desc(runs.createdAt)] : [desc(runs.createdAt)]
  const rows = await db
    .select({
      id: runs.id,
      result: runs.result,
      conversationId: runs.conversationId,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
    })
    .from(runs)
    .where(
      and(
        eq(runs.initiatorAgentId, agentId),
        eq(runs.triggerSource, 'feishu'),
        eq(runs.triggerSessionId, triggerSessionId),
        eq(runs.status, 'completed'),
        opts.chatId ? eq(jsonExtractText(runs.result, ['chatId']), opts.chatId) : undefined,
      ),
    )
    .orderBy(...order)
    .limit(groupTopic ? 1 : SESSION_TIE_BREAK_SCAN)

  const newest = rows[0]
  if (!newest?.createdAt) return null

  // Among the runs tied for the newest second, resume the one that actually finished last.
  const newestSecond = newest.createdAt.getTime()
  const tied = rows.filter((r) => r.createdAt?.getTime() === newestSecond)
  if (tied.length === SESSION_TIE_BREAK_SCAN) {
    logger.warn(
      { agentId, triggerSessionId, scanned: tied.length },
      'Feishu: more completed runs share the newest second than the tie-break scans; the resumed session may not be the one that finished last',
    )
  }
  let row = tied[0]
  for (const candidate of tied) {
    if ((candidate.updatedAt?.getTime() ?? -1) > (row.updatedAt?.getTime() ?? -1)) row = candidate
  }

  if (!row.updatedAt) return null

  const elapsed = Date.now() - row.updatedAt.getTime()
  if (elapsed > sessionTimeoutMs) return null

  const result = row.result as Record<string, unknown> | undefined
  const chatId = result?.chatId
  if (typeof chatId !== 'string') return null
  return {
    runId: row.id,
    chatId,
    conversationId: row.conversationId ?? row.id,
  }
}

/** Preserve the established chat-id-only API for existing callers. */
export async function lookupPreviousChatId(
  agentId: string,
  triggerSessionId: string,
  sessionTimeoutMs: number,
): Promise<string | null> {
  return (
    (await lookupPreviousFeishuSession(agentId, triggerSessionId, sessionTimeoutMs))?.chatId ?? null
  )
}

/** The `/new` command starts a generation even when an old one is resumable. */
export function resolveFeishuConversationId(input: {
  runId: string
  matchedCommand?: string
  previous: PreviousFeishuSession | null
}): string {
  if (input.matchedCommand === 'new') return input.runId
  return input.previous?.conversationId ?? input.runId
}
