import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { toStringArray } from '../lib/args.js'
import { emit, jsonArg, wantsJson } from '../lib/output.js'
import { forEachSSELine } from '../lib/sse.js'

/**
 * Hard ceiling on attachments per turn, mirroring `attachmentsInputSchema`'s
 * `.max(10)`. Checked BEFORE any upload: staging eleven files and then having
 * the send rejected leaves eleven blobs on the server for the whole TTL and
 * costs the caller the upload time for nothing.
 */
const MAX_ATTACHMENTS = 10

/** A reference to a staged upload, exactly as the chat body's schema expects. */
interface AttachmentRef {
  token: string
  name: string
  mimeType: string
  size?: number
}

interface ChatSession {
  /** The RUN id (`run_xxx`) — NOT what `--chat-id` accepts. */
  id: string
  intent?: string | null
  status?: string
  /** The resumable engine session id lives here, as `result.chatId`. */
  result?: { chatId?: string | null } | null
  messageCount?: number
  createdAt?: string
  updatedAt?: string
}

interface ChatMessage {
  id: string
  role: string
  content: string
  createdAt?: string
}

/**
 * Whether the already-written text can be erased from a TTY safely.
 *
 * Erasing means walking cursor-up over the rows it occupied, which is only
 * reliable in a narrow case:
 *
 *  - it must fit on ONE row. `\x1b[1A` clamps at the top margin instead of
 *    scrolling, so a reply taller than the viewport erases the visible screen
 *    (earlier turns, the header) while its scrolled-off part survives.
 *  - it must be plain ASCII. Row arithmetic from `.length` treats a full-width
 *    CJK char as one cell when it occupies two, and an emoji or embedded ANSI
 *    sequence skews it the other way — either way the count is wrong, which is
 *    exactly the two-answers-on-screen symptom this is meant to remove.
 *  - nothing else may have written since. `case 'log'` prints tool calls to the
 *    same stream between updates, so rows derived from the reply alone would
 *    erase the tool line and leave the abandoned reply.
 *
 * Anything outside that: fall back to the labelled reprint, which is always
 * correct if less tidy.
 */
function canEraseInPlace(written: string, wroteSinceTurnStart: boolean): boolean {
  if (wroteSinceTurnStart) return false
  if (written.includes('\n')) return false
  // Any non-printable byte (ANSI escapes included) means we cannot safely erase in place.
  if (/[^\x20-\x7e]/.test(written)) return false
  return written.length < (process.stdout.columns || 80)
}

/** Erase a single already-written row. Only valid when canEraseInPlace passed. */
function clearWrittenLine(): void {
  // \r → column 0, \x1b[2K → clear the row.
  process.stdout.write('\r\x1b[2K')
}

/** Terminal state carried across SSE events of a single chat turn. */
export interface ChatStreamState {
  currentEvent: string
  lastContent: string
  /** The server assigns/echoes chatId on `done`; the caller reuses it next turn. */
  chatId?: string
  runId?: string
  error?: string
  /** True once a `done` event arrived, so callers can tell success from a dropped stream. */
  done: boolean
  /** True when the server replied `queued`: accepted, but no reply on this stream. */
  queued?: boolean
  /**
   * Set when something OTHER than the reply wrote to stdout this turn (a
   * tool-call log). In-place erase derives rows from the reply alone, so it is
   * unsafe once anything else is interleaved.
   */
  wroteOther?: boolean
}

export function createChatStreamState(): ChatStreamState {
  return { currentEvent: '', lastContent: '', done: false }
}

/**
 * Consume one SSE line of a chat turn.
 *
 * Chat reuses the run stream's `update`/`log`/`done`/`error` events, plus
 * `queued` (accepted but not yet started) and `heartbeat` (keepalive, ignored).
 * Unlike the runs stream this does NOT throw on `error` — a chat session should
 * report the failed turn and stay open for the next one.
 */
export function handleChatSSELine(line: string, state: ChatStreamState, quiet = false): void {
  if (line.startsWith('event:')) {
    state.currentEvent = line.slice('event:'.length).trim()
    return
  }
  if (!line.startsWith('data:')) return
  const data = line.slice('data:'.length).trim()
  if (!data) return

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(data)
  } catch {
    return // non-JSON keepalive padding
  }

  switch (state.currentEvent) {
    case 'update': {
      // The buffer is USUALLY cumulative, so print only the appended tail. But a
      // retry, a provider fallback, or codex's `cleanResult` can REPLACE it with
      // a shorter or unrelated string. Slicing blindly then prints a fragment
      // starting mid-word, or nothing at all, while leaving the failed attempt's
      // text on screen. Only treat it as an append when it genuinely extends the
      // previous value; otherwise restart the line.
      const content = typeof parsed.content === 'string' ? parsed.content : ''
      if (content && content !== state.lastContent) {
        const isAppend = content.startsWith(state.lastContent)
        // On a pipe nothing can be un-written, so streaming a buffer that may
        // later be replaced would put BOTH answers in the consumer's file. Hold
        // the text back and let the caller print the final reply once.
        if (!quiet && !process.stdout.isTTY) {
          state.lastContent = content
          break
        }
        if (!quiet) {
          if (isAppend) {
            process.stdout.write(content.slice(state.lastContent.length))
          } else {
            // The buffer was REPLACED, not extended (retry / provider fallback /
            // codex cleanResult). Printing the new text alone would leave the
            // abandoned attempt above it, so the reader sees two answers with no
            // indication which one is live. Erase what we already emitted for
            // this turn, then reprint. Falls back to a labelled newline when
            // stdout is not a TTY (a pipe cannot take back bytes already sent).
            if (process.stdout.isTTY && canEraseInPlace(state.lastContent, !!state.wroteOther)) {
              clearWrittenLine()
              process.stdout.write(content)
            } else {
              // Bytes already sent cannot be taken back on a pipe, and a
              // multi-row / non-ASCII / interleaved case cannot be erased
              // reliably — label the supersession instead of guessing.
              process.stdout.write(`\n[response replaced]\n${content}`)
            }
          }
        }
        state.lastContent = content
      }
      break
    }
    case 'log': {
      if (quiet) break
      const type = parsed.type
      if (type === 'tool_call') {
        console.log(`\n  [tool:${parsed.toolName}] ${parsed.subtype ?? ''}`)
        // Rows can no longer be derived from the reply alone.
        state.wroteOther = true
      }
      break
    }
    case 'queued':
      // The server sends this alone and closes the stream — no `done` follows.
      // Do NOT print here: sendTurn turns this into a queuedTurn() whose reply
      // the caller prints, so logging in both places double-reports one event.
      state.queued = true
      if (typeof parsed.runId === 'string') state.runId = parsed.runId
      break
    case 'done':
      state.done = true
      if (typeof parsed.chatId === 'string') state.chatId = parsed.chatId
      if (typeof parsed.runId === 'string') state.runId = parsed.runId
      // A non-streaming reply (no prior `update` events) only arrives here.
      // Same TTY gate as the `update` branch: on a pipe nothing is streamed and
      // the caller prints the reply once. Writing here too put it in the
      // consumer's file twice, back to back with no separator — and only for
      // engines that emit `done` without any `update`, so the streaming tests
      // (which force isTTY) never saw it.
      if (!state.lastContent && typeof parsed.reply === 'string') {
        state.lastContent = parsed.reply
        if (!quiet && process.stdout.isTTY) process.stdout.write(parsed.reply)
      }
      break
    case 'error':
      state.done = true
      state.error = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed)
      break
  }
}

async function consumeChatSSE(response: Response, quiet: boolean): Promise<ChatStreamState> {
  const state = createChatStreamState()
  await forEachSSELine(response, (line) => handleChatSSELine(line, state, quiet))
  return state
}

/**
 * Sentinel distinguishing "stdin closed" from a real answer in the prompt race.
 *
 * `as const` makes it a unique symbol type, so `answer === EOF` narrows the
 * union to `string` in the else branch instead of leaving `string | symbol`.
 */
const EOF: unique symbol = Symbol('eof')

interface TurnResult {
  reply: string
  chatId?: string
  runId?: string
  /** True when the agent's slots were full: accepted, but no reply this call. */
  queued?: boolean
}

/**
 * Message a queued turn consistently across both transports.
 *
 * A full queue is a normal outcome, not a failure: the run is accepted and will
 * execute, there is simply no reply to wait for on this connection. Both paths
 * surface the runId so the caller can follow it with `a2wave runs get`.
 */
function queuedTurn(runId: string | undefined): TurnResult {
  const where = runId ? ` Follow it with: a2wave runs get ${runId}` : ''
  return {
    reply: `[queued] The agent's concurrency slots are full; the run was accepted.${where}`,
    runId,
    queued: true,
  }
}

/**
 * Two-step upload: stage each file, then hand the returned refs to the chat
 * call, which is what consumes the token.
 *
 * Sequential on purpose. The server enforces a per-file size limit and an
 * extension allowlist, so a rejection is normal input validation rather than a
 * fault — uploading in parallel would report whichever file happened to fail
 * first while the others were already staged, and the caller could not tell
 * which of its arguments was wrong.
 */
async function stageAttachments(
  client: ReturnType<typeof createClient>,
  paths: string[],
): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = []
  for (const path of paths) {
    let bytes: Buffer
    try {
      bytes = readFileSync(path)
    } catch (err) {
      throw new CliError(`Cannot read --attach ${path}: ${(err as Error).message}`, {
        type: 'validation',
        subtype: 'unreadable_attachment',
      })
    }
    const form = new FormData()
    form.append('file', new Blob([bytes]), basename(path))
    const { data } = await client.postFormData<{ data: AttachmentRef }>('/api/attachments', form)
    refs.push(data)
  }
  return refs
}

/** Send one message. Streams by default; falls back to the sync JSON shape with --no-stream. */
async function sendTurn(
  client: ReturnType<typeof createClient>,
  agentId: string,
  message: string,
  chatId: string | undefined,
  opts: { stream: boolean; quiet: boolean; attachments?: AttachmentRef[] },
): Promise<TurnResult> {
  const body: Record<string, unknown> = { message, stream: opts.stream }
  if (chatId) body.chatId = chatId
  if (opts.attachments?.length) body.attachments = opts.attachments

  if (!opts.stream) {
    // A full queue answers 202 with a BARE `{status, runId}` — no `data`
    // wrapper — so reading `res.data.reply` blindly threw a TypeError on a
    // perfectly healthy request. Detect that shape before unwrapping.
    const res = await client.post<{
      status?: string
      runId?: string
      data?: { reply: string; chatId?: string; runId?: string }
    }>(`/api/agents/${agentId}/chat`, body)

    if (!res.data) {
      if (res.status === 'queued') return queuedTurn(res.runId)
      throw new CliError(`Unexpected chat response: ${JSON.stringify(res)}`)
    }
    return { reply: res.data.reply, chatId: res.data.chatId, runId: res.data.runId }
  }

  const res = await client.postStream(`/api/agents/${agentId}/chat`, body)
  const state = await consumeChatSSE(res, opts.quiet)
  if (state.error) throw new CliError(`Chat failed: ${state.error}`)
  // The queued stream carries a single `queued` event and closes — no `done`.
  // Without this it fell through to "stream ended before the reply completed",
  // reporting a broken connection for a request the server had accepted.
  if (state.queued) return queuedTurn(state.runId)
  if (!state.done) throw new CliError('Chat stream ended before the reply completed')
  return { reply: state.lastContent, chatId: state.chatId, runId: state.runId }
}

/**
 * The one-shot / interactive session command.
 *
 * This lives under `chat send` rather than on the `chat` parent because citty
 * routes on the first non-flag argument: a parent that owns BOTH a positional
 * and subCommands makes `chat my-agent` look like an unknown subcommand name,
 * and citty rejects it with "Unknown command". A parent with subCommands must
 * therefore take no positional of its own.
 */
export const chatSendCommand = defineCommand({
  meta: {
    name: 'send',
    description: 'Send a message to an Agent, or open an interactive session',
    agentMeta: { risk: 'write' },
  },
  args: {
    agent: { type: 'positional', description: 'Agent ID or name', required: true },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Send one message and exit. Omit to open an interactive session',
    },
    'chat-id': {
      type: 'string',
      description: 'Continue an existing session (from a previous reply)',
    },
    // Declared as `stream` (default true), NOT `no-stream`: citty treats a
    // `--no-X` flag as negation of `X`, so `--no-stream` sets `args.stream =
    // false` and never populates an arg literally named `no-stream`. Declaring
    // it the other way round makes `--no-stream` silently do nothing.
    stream: {
      type: 'boolean',
      default: true,
      description: 'Stream tokens as they arrive. Use --no-stream to wait for the full reply',
    },
    attach: {
      type: 'string',
      description: `Attach a local file to this turn (repeatable, max ${MAX_ATTACHMENTS})`,
    },
    ...jsonArg,
    ...urlArg,
  },
  run: async ({ args }) => {
    const json = wantsJson(args)
    // JSON mode must emit one clean object, so never stream tokens to stdout.
    const stream = args.stream !== false && !json

    // Validate the flag combination before any network call, so a misuse fails
    // instantly instead of after resolving the agent.
    if (json && !args.message) {
      throw new CliError(
        '--json requires -m/--message (interactive sessions have no single payload)',
      )
    }
    if (!args.message && !process.stdin.isTTY) {
      throw new CliError('Interactive chat needs a TTY. Use -m "message" for scripted use.')
    }

    const attachPaths = toStringArray(args.attach)
    // An interactive session sends many turns; there is no single one the files
    // would belong to, and silently attaching them to the first would be worse
    // than refusing.
    if (attachPaths.length > 0 && !args.message) {
      throw new CliError('--attach requires -m/--message (it applies to one turn)', {
        type: 'validation',
        subtype: 'missing_argument',
      })
    }
    if (attachPaths.length > MAX_ATTACHMENTS) {
      throw new CliError(
        `--attach accepts at most ${MAX_ATTACHMENTS} files (got ${attachPaths.length})`,
        { type: 'validation', subtype: 'too_many_attachments' },
      )
    }

    // `--chat-id` matches `json_extract(runs.result,'$.chatId')` — the ENGINE
    // session id. A run id finds nothing and the server silently starts a fresh
    // run instead of erroring, so the follow-up is answered with none of the
    // conversation it referenced. Catch the confusion here, where we can name
    // the right command, rather than let it fail invisibly.
    const requestedChatId = args['chat-id'] as string | undefined
    if (requestedChatId?.startsWith('run_')) {
      throw new CliError(
        `--chat-id expects an engine session id, not a run id ("${requestedChatId}").\n` +
          `Run \`a2wave chat list ${args.agent}\` — it prints the chat-id for each session.`,
      )
    }

    const client = createClient({ url: args.url as string | undefined })
    const agentId = await client.resolveAgentId(args.agent as string)

    if (args.message) {
      const attachments = attachPaths.length > 0 ? await stageAttachments(client, attachPaths) : []
      const turn = await sendTurn(client, agentId, args.message as string, requestedChatId, {
        stream,
        quiet: json,
        attachments,
      })
      if (emit(args, { data: turn })) return
      // Print the reply unless the streaming path already wrote it to a TTY.
      // A queued turn streams nothing, and on a pipe the stream is held back so
      // a later replacement cannot leave two answers in the consumer's file —
      // both cases need the reply printed here exactly once.
      const alreadyStreamed = stream && process.stdout.isTTY && !turn.queued
      if (!alreadyStreamed) console.log(turn.reply)
      else process.stdout.write('\n')
      if (turn.chatId)
        console.log(`\n[chatId: ${turn.chatId}] — continue with --chat-id ${turn.chatId}`)
      return
    }

    console.log(`Chatting with ${args.agent} (${agentId}). Type "exit" or Ctrl-D to quit.\n`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // On EOF (Ctrl-D) `rl.question()` neither resolves nor rejects — it just
    // hangs forever. The `close` event is the only reliable EOF signal, so race
    // the two; otherwise Ctrl-D would wedge the session instead of ending it.
    const closed = new Promise<typeof EOF>((resolve) => rl.once('close', () => resolve(EOF)))
    let chatId = requestedChatId

    try {
      while (true) {
        // `question()` hangs forever on EOF, so race it against `close`. It can
        // also REJECT with "readline was closed" when the stream ends while a
        // prompt is pending — both are the same ordinary end-of-input, so fold
        // them into one EOF outcome rather than surfacing an error.
        const answer: string | typeof EOF = await Promise.race([
          rl.question('> ').catch((): typeof EOF => EOF),
          closed,
        ])
        if (answer === EOF) break

        const message = answer.trim()
        if (!message) continue
        if (message === 'exit' || message === 'quit') break

        try {
          const turn = await sendTurn(client, agentId, message, chatId, { stream, quiet: false })
          chatId = turn.chatId ?? chatId
          // Only a TTY stream has already written the reply. Without this,
          // `--no-stream` (and a queued turn) rendered every turn as two blank
          // lines while the run had actually executed.
          if (!(stream && process.stdout.isTTY) || turn.queued) console.log(turn.reply)
          process.stdout.write('\n\n')
          if (turn.queued) {
            // A queued turn returns no chatId, so this turn is not yet part of
            // the session: asking a follow-up now would fork a SEPARATE
            // conversation while the queued one is still pending. Stop here.
            // `chatId` may still hold an id from an EARLIER completed turn —
            // that one is genuinely resumable, so say so precisely rather than
            // claiming nothing can continue while the footer prints an id.
            console.log(
              chatId
                ? 'This turn is queued and not part of the session yet — ending here so a follow-up cannot fork it.'
                : 'This turn is queued, so there is no session to continue yet.',
            )
            // No follow-up hint here: queuedTurn()'s reply, printed just above,
            // already carries `a2wave runs get <runId>`.
            break
          }
        } catch (err) {
          // Keep the session open: one failed turn shouldn't end the conversation.
          console.error(`${(err as Error).message}\n`)
        }
      }
    } finally {
      rl.close()
    }

    if (chatId) console.log(`\nSession: ${chatId}`)
  },
})

export const chatCommand = defineCommand({
  meta: { name: 'chat', description: 'Chat with an Agent (send / list sessions / read messages)' },
  subCommands: {
    send: chatSendCommand,

    list: defineCommand({
      meta: {
        name: 'list',
        description: 'List chat sessions for an Agent',
        agentMeta: { risk: 'read' },
      },
      args: {
        agent: { type: 'positional', description: 'Agent ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.agent as string)
        const result = await client.get<{ data: ChatSession[] }>(`/api/agents/${agentId}/chats`)
        if (emit(args, result)) return

        if (result.data.length === 0) {
          console.log('No chat sessions')
          return
        }
        // Print BOTH ids: `--chat-id` matches `result.chatId` (the engine
        // session), while `chat messages` takes the run id. Showing only the run
        // id made every `--chat-id run_xxx` silently start a brand-new
        // conversation instead of resuming — the server matches on
        // json_extract(result,'$.chatId') and quietly falls through on a miss.
        for (const s of result.data) {
          const intent = s.intent ?? ''
          const preview = intent.length > 50 ? `${intent.slice(0, 50)}...` : intent
          const resumable = s.result?.chatId
          console.log(`${s.id}  ${(s.status ?? '').padEnd(10)}  ${preview}`)
          // `result.chatId` is only written once a run SUCCEEDS, so a queued or
          // running session has none YET — calling that "cannot be resumed"
          // would be wrong, it simply is not ready.
          const pending = s.status === 'queued' || s.status === 'running' || s.status === 'pending'
          console.log(
            resumable
              ? `  chat-id: ${resumable}`
              : pending
                ? '  chat-id: (not assigned yet — the run has not finished)'
                : '  chat-id: (none — this session cannot be resumed)',
          )
        }
      },
    }),

    messages: defineCommand({
      meta: {
        name: 'messages',
        description: 'Show the messages of one chat session',
        agentMeta: { risk: 'read' },
      },
      args: {
        agent: { type: 'positional', description: 'Agent ID or name', required: true },
        run: { type: 'positional', description: 'Run ID of the session (run_xxx)', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.agent as string)
        // This endpoint nests the rows under `data.messages` alongside the run —
        // unlike the flat `{data: [...]}` every other list route returns.
        const result = await client.get<{ data: { run?: unknown; messages: ChatMessage[] } }>(
          `/api/agents/${agentId}/chats/${args.run}/messages`,
        )
        if (emit(args, result)) return

        const messages = result.data.messages ?? []
        if (messages.length === 0) {
          console.log('No messages')
          return
        }
        for (const m of messages) {
          console.log(`\n[${m.role}]${m.createdAt ? ` ${m.createdAt}` : ''}`)
          console.log(m.content)
        }
      },
    }),
  },
})
