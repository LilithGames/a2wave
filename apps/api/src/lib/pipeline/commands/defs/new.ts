/**
 * /new — force a fresh LLM session.
 *
 * applySession returns override:null, so the caller clears previousChatId.
 * Passes on every engine (no provider restriction). Instantaneous, so no longRunningAck.
 *
 * emptyTextFallback: a bare `/new` (no trailing text) still runs the whole pipeline, so
 * the engine produces one completed run with a new chatId and the next
 * lookupPreviousChatId stops resolving the old session.
 *
 * allowedContexts: ['p2p'] — a group chat has its own native ways to start over (post a
 * new top-level message, or start a new topic outside the current reply chain), so the
 * command is unnecessary there and "/new ..." stays ordinary text: the dispatcher does
 * not activate the command and does not strip the prefix. A direct message has no such
 * escape, quoted reply included — deriveCurrentContext keeps every P2P message in the
 * 'p2p' context precisely so a quote cannot swallow the command.
 */
import { createCommandPlugin } from '../factory.js'

export const newCommandPlugin = createCommandPlugin({
  commandName: 'new',
  prefixes: ['/new'],
  allowedContexts: ['p2p'],
  emptyTextFallback: '新会话已开始',
  applySession: () => ({ override: null }),
})
