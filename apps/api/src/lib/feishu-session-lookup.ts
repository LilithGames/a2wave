import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runs } from '../db/schema.js'
import { logger } from './logger.js'

/**
 * How many rows the newest-second tie-break reads. `created_at` is second-granular, so
 * runs started in the same second tie and either database may return them in any order;
 * the tie set is however many messages the same session could start within one second,
 * which in practice is two.
 */
const SESSION_TIE_BREAK_SCAN = 4

/**
 * Resolve the chatId of the session's most recent completed run, so the engine can be
 * handed the prior context and continue the conversation.
 * - After every run the engine writes the chatId the LLM returned into runs.result.chatId
 * - The next message with the same triggerSessionId passes that chatId back to the engine
 * - sessionTimeoutMs bounds it: past the timeout this returns null and the engine opens a
 *   fresh session. Callers derive the value with resolveSessionTimeoutMs.
 */
export async function lookupPreviousChatId(
  agentId: string,
  triggerSessionId: string,
  sessionTimeoutMs: number,
): Promise<string | null> {
  // Ordering on created_at alone keeps the entire ORDER BY servable by
  // (initiator_agent_id, trigger_session_id, status, created_at), so the scan stops after
  // a few rows. Adding updatedAt as a second sort key would forfeit that: PostgreSQL only
  // gained incremental sort in 13 and the supported floor is 9.6, where the planner would
  // instead sort every completed run of the session on every incoming message.
  const rows = await db
    .select({ result: runs.result, createdAt: runs.createdAt, updatedAt: runs.updatedAt })
    .from(runs)
    .where(
      and(
        eq(runs.initiatorAgentId, agentId),
        eq(runs.triggerSessionId, triggerSessionId),
        eq(runs.status, 'completed'),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(SESSION_TIE_BREAK_SCAN)

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
  return typeof chatId === 'string' ? chatId : null
}
