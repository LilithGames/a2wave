/**
 * Answer a responder command (`/status`) on the A2A transport.
 *
 * Wraps `executeFn` rather than intercepting at the protocol layer, so the
 * calling Agent sees an ordinary completed task with the report as its output.
 * Diverging from the task lifecycle instead — answering out of band, or with a
 * JSON-RPC error — would make a status query the one A2A call whose shape a
 * client cannot predict.
 *
 * `chatType: 'p2p'`: an A2A call is one caller addressing one Agent, with no
 * bystanders, which is what the context flag distinguishes.
 */
import type { agents } from '../db/schema.js'
import { interceptNativeChatCommand } from '../lib/native-chat-command.js'
import type { ExecuteFn } from './executor.js'

type AgentRow = typeof agents.$inferSelect

export function withA2ACommandResponder(agent: AgentRow, executeFn: ExecuteFn): ExecuteFn {
  return async (taskId, payload, options) => {
    const startedAt = Date.now()
    const command = await interceptNativeChatCommand({
      agentId: agent.id,
      text: payload.prompt,
      chatType: 'p2p',
    })
    if (command.handled) {
      return { success: true, output: command.reply, durationMs: Date.now() - startedAt }
    }
    return executeFn(taskId, payload, options)
  }
}
