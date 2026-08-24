/**
 * Resolution of the Feishu bot's own `open_id`, used for accurate @mention
 * detection.
 *
 * Without it, `shouldTrigger` falls back to the sequential key `@_user_1` — the
 * FIRST mention in a message, whoever it points at — so a colleague's "@Alice
 * can you review this?" triggers the Agent into answering an unrelated
 * conversation. That fallback is a deliberate false-positive-over-false-negative
 * trade (real mentions, the bot's own included, all carry an open_id, so
 * refusing identified mentions would stop the bot answering when it is genuinely
 * @-ed), but it is only meant to be transient.
 *
 * It used to be permanent: the probe ran exactly once at connect, and a blip
 * left `botOpenId` undefined for the whole process lifetime, recoverable only by
 * a restart. This resolver retries a failed probe on demand instead.
 */
import { logger } from './logger.js'

interface BotInfoClient {
  request(params: { method: string; url: string }): Promise<{ bot?: { open_id?: string } }>
}

export interface BotIdentityResolver {
  /** The identity known right now, without waiting on any probe. */
  current(): string | undefined
  /**
   * Resolve the open_id, retrying a previously failed probe. Concurrent callers
   * share one in-flight attempt, and a settled *failed* attempt is cleared so the
   * next call tries again rather than latching the miss.
   */
  resolve(): Promise<string | undefined>
}

export function createBotIdentityResolver(
  client: BotInfoClient,
  agentId: string,
  onResolved?: (openId: string) => void,
): BotIdentityResolver {
  let botOpenId: string | undefined
  let inFlight: Promise<void> | null = null

  const probe = async (): Promise<void> => {
    try {
      const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
      botOpenId = res?.bot?.open_id
      if (botOpenId) {
        onResolved?.(botOpenId)
        logger.info({ agentId }, 'Feishu bot open_id fetched for mention detection')
      }
    } catch (err) {
      logger.warn(
        { err, agentId },
        'Failed to fetch Feishu bot open_id; @mention detection may have false positives until the next attempt',
      )
    }
  }

  return {
    current: () => botOpenId,
    resolve: async () => {
      if (botOpenId) return botOpenId
      if (!inFlight) {
        inFlight = probe().finally(() => {
          if (!botOpenId) inFlight = null
        })
      }
      await inFlight
      return botOpenId
    },
  }
}
