/**
 * /status — the Agent's own metadata, health and queue depth, answered by the
 * platform rather than the Agent.
 *
 * The first responder command: it aborts the pipeline instead of reaching the
 * engine. That is the point — asking "are you stuck?" must not itself join the
 * queue it is asking about, and an Agent whose provider CLI is missing is
 * exactly the one that cannot answer for itself.
 *
 * No allowedContexts: unlike /new, the question is equally meaningful in a
 * shared channel, where a queue that is not draining is what prompts it.
 * No emptyTextFallback / applySession either — a status query must leave the
 * conversation the user is having untouched.
 */
import type { CommandReplyLanguage } from '@a2wave/shared'
import type { agents } from '../../../../db/schema.js'
import { buildAgentSelfReport, formatAgentSelfReport } from '../../../agent-self-report.js'
import { resolveCommandReplyLanguage } from '../../../command-reply-language.js'
import { createCommandPlugin } from '../factory.js'

export const statusCommandPlugin = createCommandPlugin({
  commandName: 'status',
  prefixes: ['/status', '/状态'],
  respond: async (ctx) => {
    const agent = ctx.agent as unknown as typeof agents.$inferSelect
    const language = resolveCommandReplyLanguage(
      agent.commandReplyLanguage as CommandReplyLanguage | null | undefined,
      { text: ctx.rawText },
    )
    return formatAgentSelfReport(await buildAgentSelfReport(agent), language)
  },
})
