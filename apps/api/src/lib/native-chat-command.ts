/**
 * Command interception for the native chat channels (Slack / Discord /
 * Telegram / QQ Official).
 *
 * Feishu runs the full lifecycle pipeline because its hooks patch the run it is
 * about to start. These channels reserve their run through
 * `reserveNativeChatRun`, which already accepts `resetSession`, so they need the
 * arbitration rather than the pipeline. Reusing `matchByLongestPrefix` and the
 * same registered plugins is what keeps a command from meaning one thing on
 * Feishu and another on Slack; a second hand-rolled matcher is exactly how QQ's
 * copy drifted (it ignored allowedContexts and never matched in group scenes).
 *
 * Two outcomes, matching the two kinds of command:
 *   - responder (`/status`) — answered here; no run, no queue slot
 *   - session (`/new`)      — prefix stripped and the caller told to reset the
 *                             session; the message still reaches the Agent
 *
 * Called after the channel's own trigger gate and before the run is reserved.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { logger } from './logger.js'
import { newCommandPlugin } from './pipeline/commands/defs/new.js'
import { statusCommandPlugin } from './pipeline/commands/defs/status.js'
import { matchByLongestPrefix } from './pipeline/commands/prefix-matcher.js'
import type { CommandPlugin } from './pipeline/commands/types.js'

/** Mirrors the pipeline registry in `pipeline/index.ts`; keep the two in step. */
const NATIVE_CHAT_COMMANDS: readonly CommandPlugin[] = [newCommandPlugin, statusCommandPlugin]

const COMMAND_FAILED_MESSAGE = 'Command failed, please try again later.'

export interface NativeChatCommandInput {
  agentId: string
  text: string
  chatType: 'p2p' | 'group'
}

export type NativeChatCommandResult =
  /** Answered from platform state. Reply and stop; no run is reserved. */
  | { handled: true; reply: string }
  /** Continue to the run. `intent` / `resetSession` are set only on a match. */
  | { handled: false; intent?: string; resetSession?: boolean }

export async function interceptNativeChatCommand(
  input: NativeChatCommandInput,
): Promise<NativeChatCommandResult> {
  const match = matchByLongestPrefix(input.text, NATIVE_CHAT_COMMANDS)
  if (!match) return { handled: false }

  const { plugin, rest } = match
  // A disallowed context counts as no match: the prefix stays in the text and
  // the whole message reaches the Agent unchanged.
  if (plugin.allowedContexts && !plugin.allowedContexts.includes(input.chatType)) {
    return { handled: false }
  }

  const strippedText =
    rest === '' && plugin.emptyTextFallback !== undefined ? plugin.emptyTextFallback : rest

  if (!plugin.respond) {
    // A session command. `applySession` is a pipeline hook needing a RunCtx that
    // does not exist yet here, so its one effect -- clearing the previous chat
    // id -- is expressed through the field reserveNativeChatRun already takes.
    return { handled: false, intent: strippedText, resetSession: true }
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1)
  // The caller already resolved this Agent to get here, so a miss means it was
  // deleted mid-flight. Fall through rather than answer -- the run path reports
  // that far better than a command reply can.
  if (!agent) return { handled: false }

  try {
    const answer = await plugin.respond({
      commandName: plugin.commandName,
      agentEngineType: agent.type,
      rawText: input.text,
      strippedText,
      agent: agent as never,
    })
    return answer === null ? { handled: false } : { handled: true, reply: answer }
  } catch (error) {
    logger.warn(
      { error, agentId: input.agentId, command: plugin.commandName },
      'Native chat command responder failed',
    )
    return { handled: true, reply: COMMAND_FAILED_MESSAGE }
  }
}
