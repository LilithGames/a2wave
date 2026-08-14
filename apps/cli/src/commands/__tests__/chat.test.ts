import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPostStream = vi.fn()
const mockResolveAgentId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    postStream: mockPostStream,
    resolveAgentId: mockResolveAgentId,
  }),
}))

const { chatCommand, chatSendCommand, createChatStreamState, handleChatSSELine } = await import(
  '../chat.js'
)

type TestCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }

function getSubCommand(name: string) {
  const subCommands = chatCommand.subCommands as Record<string, TestCommand>
  return subCommands[name]
}

describe('handleChatSSELine', () => {
  let state: ReturnType<typeof createChatStreamState>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  const realIsTTY = process.stdout.isTTY

  beforeEach(() => {
    state = createChatStreamState()
    // Streaming writes are TTY-only now: on a pipe the text is held back so a
    // later replacement cannot leave two answers in the consumer's output.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: realIsTTY, configurable: true })
    vi.restoreAllMocks()
  })

  it('tracks the current event name', () => {
    handleChatSSELine('event: update', state)
    expect(state.currentEvent).toBe('update')
  })

  it('prints only the newly appended part of cumulative content', () => {
    state.currentEvent = 'update'
    handleChatSSELine('data: {"content":"Hel"}', state)
    handleChatSSELine('data: {"content":"Hello"}', state)

    expect(stdoutSpy).toHaveBeenNthCalledWith(1, 'Hel')
    expect(stdoutSpy).toHaveBeenNthCalledWith(2, 'lo')
    expect(state.lastContent).toBe('Hello')
  })

  it('captures chatId and runId from the done event', () => {
    state.currentEvent = 'done'
    handleChatSSELine('data: {"chatId":"chat_1","runId":"run_1","reply":"hi"}', state)

    expect(state.done).toBe(true)
    expect(state.chatId).toBe('chat_1')
    expect(state.runId).toBe('run_1')
  })

  it('falls back to the done reply when no update events streamed', () => {
    state.currentEvent = 'done'
    handleChatSSELine('data: {"reply":"full answer"}', state)

    expect(state.lastContent).toBe('full answer')
    expect(stdoutSpy).toHaveBeenCalledWith('full answer')
  })

  it('does not overwrite streamed content with the done reply', () => {
    state.currentEvent = 'update'
    handleChatSSELine('data: {"content":"streamed"}', state)
    state.currentEvent = 'done'
    handleChatSSELine('data: {"reply":"streamed"}', state)

    expect(state.lastContent).toBe('streamed')
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
  })

  it('records errors instead of throwing, so the session can continue', () => {
    state.currentEvent = 'error'
    expect(() => handleChatSSELine('data: {"error":"boom"}', state)).not.toThrow()
    expect(state.error).toBe('boom')
    expect(state.done).toBe(true)
  })

  it('ignores heartbeats and malformed payloads', () => {
    state.currentEvent = 'heartbeat'
    handleChatSSELine('data: ', state)
    state.currentEvent = 'update'
    handleChatSSELine('data: not-json', state)
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('suppresses all writes in quiet mode (used by --json)', () => {
    state.currentEvent = 'update'
    handleChatSSELine('data: {"content":"hi"}', state, true)
    expect(stdoutSpy).not.toHaveBeenCalled()
    // still tracked, just not printed
    expect(state.lastContent).toBe('hi')
  })
})

describe('chat one-shot', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => vi.restoreAllMocks())

  it('uses the sync endpoint with --no-stream and passes chatId through', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { reply: 'pong', chatId: 'chat_9' } })

    await (chatSendCommand as unknown as TestCommand).run({
      args: { agent: 'Bot', message: 'ping', 'chat-id': 'chat_9', stream: false },
    })

    expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/chat', {
      message: 'ping',
      stream: false,
      chatId: 'chat_9',
    })
    expect(consoleSpy).toHaveBeenCalledWith('pong')
  })

  it('emits a single JSON object with --json and never streams tokens', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { reply: 'pong', chatId: 'chat_9' } })

    await (chatSendCommand as unknown as TestCommand).run({
      args: { agent: 'Bot', message: 'ping', json: true },
    })

    // --json forces stream:false so stdout carries exactly one JSON document
    expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/chat', {
      message: 'ping',
      stream: false,
    })
    // Parsed, not string-compared: the layout belongs to emit() (compact by
    // default, indented under --json-pretty) and is asserted there.
    expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual({
      data: { reply: 'pong', chatId: 'chat_9' },
    })
  })

  it('rejects --json without a message (an interactive session has no single payload)', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')

    await expect(
      (chatSendCommand as unknown as TestCommand).run({ args: { agent: 'Bot', json: true } }),
    ).rejects.toThrow(/--json requires -m/)
  })
})

describe('chat list / messages', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('lists sessions', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({
      data: [{ id: 'run_1', status: 'completed', intent: 'hello' }],
    })

    await getSubCommand('list').run({ args: { agent: 'Bot' } })

    expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_1/chats')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('run_1'))
  })

  it('prints session messages from the nested data.messages shape', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    // This route nests rows under data.messages alongside the run — unlike the
    // flat {data:[...]} every other list endpoint returns.
    mockGet.mockResolvedValueOnce({
      data: { run: { id: 'run_1' }, messages: [{ id: 'msg_1', role: 'user', content: 'hi' }] },
    })

    await getSubCommand('messages').run({ args: { agent: 'Bot', run: 'run_1' } })

    expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_1/chats/run_1/messages')
    expect(consoleSpy).toHaveBeenCalledWith('hi')
  })

  it('reports no messages when the session is empty', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({ data: { run: { id: 'run_1' }, messages: [] } })

    await getSubCommand('messages').run({ args: { agent: 'Bot', run: 'run_1' } })

    expect(consoleSpy).toHaveBeenCalledWith('No messages')
  })

  it('reports an empty session list', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({ data: [] })

    await getSubCommand('list').run({ args: { agent: 'Bot' } })

    expect(consoleSpy).toHaveBeenCalledWith('No chat sessions')
  })
})

describe('chat interactive session', () => {
  const realIsTTY = process.stdin.isTTY

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true })
    vi.restoreAllMocks()
  })

  it('refuses to start without a TTY, before any network call', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

    await expect(
      (chatSendCommand as unknown as TestCommand).run({ args: { agent: 'Bot' } }),
    ).rejects.toThrow(/needs a TTY/)
    // The flag check must run before resolving the agent, so a misuse costs no request.
    expect(mockResolveAgentId).not.toHaveBeenCalled()
  })

  it('rejects --json without -m before any network call', async () => {
    await expect(
      (chatSendCommand as unknown as TestCommand).run({ args: { agent: 'Bot', json: true } }),
    ).rejects.toThrow(/--json requires -m/)
    expect(mockResolveAgentId).not.toHaveBeenCalled()
  })

  it('exits the loop on EOF instead of hanging (Ctrl-D)', async () => {
    // readline's question() never settles on EOF, so the command must race it
    // against the 'close' event. An empty stream reproduces exactly that.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const emptyStdin = Readable.from([]) as unknown as NodeJS.ReadStream
    emptyStdin.isTTY = true
    const stdinSpy = vi
      .spyOn(process, 'stdin', 'get')
      .mockReturnValue(emptyStdin as NodeJS.ReadStream & { fd: 0 })

    mockResolveAgentId.mockResolvedValueOnce('agt_1')

    const finished = await Promise.race([
      (chatSendCommand as unknown as TestCommand)
        .run({ args: { agent: 'Bot' } })
        .then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ])

    expect(finished).toBe('returned')
    stdinSpy.mockRestore()
  })
})

describe('chat command routing (through citty, not .run() directly)', () => {
  // These tests exist because every other test in this file calls `.run()`
  // directly, bypassing citty's router — which hid a P0: a parent command that
  // owns BOTH a positional and subCommands makes `chat <agent>` parse as an
  // unknown subcommand name. Routing must be exercised, not assumed.
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => vi.restoreAllMocks())

  it('never mixes a positional with subCommands on the same node', () => {
    // The structural invariant behind the P0. citty resolves the first non-flag
    // arg against subCommands, so a positional on the same node is unreachable.
    const walk = (cmd: Record<string, unknown>, path: string[]) => {
      const subs = cmd.subCommands as Record<string, Record<string, unknown>> | undefined
      const args = (cmd.args ?? {}) as Record<string, { type?: string }>
      const positionals = Object.entries(args)
        .filter(([, v]) => v?.type === 'positional')
        .map(([k]) => k)

      if (subs && Object.keys(subs).length > 0) {
        expect(
          positionals,
          `"${path.join(' ') || 'chat'}" has subCommands AND positionals ${JSON.stringify(
            positionals,
          )} — citty cannot route this`,
        ).toEqual([])
        for (const [name, sub] of Object.entries(subs)) walk(sub, [...path, name])
      }
    }
    walk(chatCommand as unknown as Record<string, unknown>, [])
  })

  it('routes `chat send <agent> -m ...` to the send command', async () => {
    const { runCommand } = await import('citty')
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { reply: 'pong', chatId: 'chat_1' } })

    await runCommand(chatCommand, { rawArgs: ['send', 'my-agent', '-m', 'ping', '--no-stream'] })

    expect(mockResolveAgentId).toHaveBeenCalledWith('my-agent')
    expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/chat', {
      message: 'ping',
      stream: false,
    })
  })

  it('routes `chat list <agent>` to the list command', async () => {
    const { runCommand } = await import('citty')
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({ data: [] })

    await runCommand(chatCommand, { rawArgs: ['list', 'my-agent'] })

    expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_1/chats')
    // The parent must not also fire and re-resolve a bogus agent named "list".
    expect(mockResolveAgentId).toHaveBeenCalledTimes(1)
    expect(mockResolveAgentId).toHaveBeenCalledWith('my-agent')
  })
})

describe('chat send — full concurrency queue (202)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => vi.restoreAllMocks())

  it('reports a queued run instead of crashing on the bare 202 body', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    // 202 has NO `data` wrapper — reading res.data.reply used to TypeError.
    mockPost.mockResolvedValueOnce({ status: 'queued', runId: 'run_9' })

    await (chatSendCommand as unknown as TestCommand).run({
      args: { agent: 'Bot', message: 'ping', stream: false },
    })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('queued')
    expect(out).toContain('run_9')
  })

  it('reports a queued stream instead of claiming the connection broke', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    // The queued stream carries one `queued` event and closes — never `done`.
    const encoder = new TextEncoder()
    mockPostStream.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('event: queued\ndata: {"type":"queued","runId":"run_9"}\n\n'),
            )
            controller.close()
          },
        }),
      ),
    )

    await (chatSendCommand as unknown as TestCommand).run({
      args: { agent: 'Bot', message: 'ping' },
    })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('run_9')
    expect(out).not.toContain('stream ended')
  })

  it('still errors on a genuinely malformed body', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ unexpected: true })

    await expect(
      (chatSendCommand as unknown as TestCommand).run({
        args: { agent: 'Bot', message: 'ping', stream: false },
      }),
    ).rejects.toThrow(/Unexpected chat response/)
  })
})

describe('chat list surfaces the resumable chat-id', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('prints result.chatId, not just the run id', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({
      data: [{ id: 'run_1', status: 'completed', intent: 'hi', result: { chatId: 'sess_abc' } }],
    })

    await getSubCommand('list').run({ args: { agent: 'Bot' } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    // --chat-id matches result.chatId; passing run_1 silently starts a NEW
    // conversation instead of resuming, with no error from the server.
    expect(out).toContain('sess_abc')
    expect(out).toContain('run_1')
  })

  it('says so when a session has no resumable id', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({
      data: [{ id: 'run_1', status: 'failed', intent: 'hi', result: null }],
    })

    await getSubCommand('list').run({ args: { agent: 'Bot' } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('cannot be resumed')
  })
})

describe('chat interactive --no-stream prints replies', () => {
  const realIsTTY = process.stdin.isTTY
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true })
    vi.restoreAllMocks()
  })

  it('renders each turn instead of two blank lines', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    // A PassThrough stays open between writes, so readline actually prompts —
    // Readable.from([...]) ends immediately and the loop exits at EOF first.
    const { PassThrough } = await import('node:stream')
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    stdin.isTTY = true
    const stdinSpy = vi
      .spyOn(process, 'stdin', 'get')
      .mockReturnValue(stdin as NodeJS.ReadStream & { fd: 0 })

    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { reply: '4', chatId: 'sess_1' } })

    const done = (chatSendCommand as unknown as TestCommand).run({
      args: { agent: 'Bot', stream: false },
    })

    // Drive one turn, then end the session.
    await new Promise((r) => setTimeout(r, 10))
    stdin.push('what is 2+2?\n')
    await new Promise((r) => setTimeout(r, 10))
    stdin.push('exit\n')
    await done

    // Before the fix the loop only wrote "\n\n", so a real reply vanished.
    expect(consoleSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('4')
    stdinSpy.mockRestore()
  })
})

describe('chat streaming — non-monotonic buffers', () => {
  let state: ReturnType<typeof createChatStreamState>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  const realIsTTY = process.stdout.isTTY

  beforeEach(() => {
    state = createChatStreamState()
    // Streaming writes are TTY-only; the piped case is covered separately.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: realIsTTY, configurable: true })
    vi.restoreAllMocks()
  })

  it('erases the abandoned attempt on a TTY when the buffer is replaced', () => {
    // codex's cleanResult / a provider fallback REPLACES the cumulative buffer.
    // Printing the new text alone leaves the dead attempt above it, so the
    // reader sees two answers with no clue which is live.
    const prev = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    state.currentEvent = 'update'
    handleChatSSELine('data: {"content":"first attempt output"}', state)
    handleChatSSELine('data: {"content":"short"}', state)

    const written = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    expect(written).toContain('\x1b[2K') // erase sequence emitted
    expect(written).not.toContain('\x1b[1A') // single row only — never walks up
    expect(written.endsWith('short')).toBe(true)
    expect(state.lastContent).toBe('short')
    Object.defineProperty(process.stdout, 'isTTY', { value: prev, configurable: true })
  })

  it('labels the replacement when stdout is piped (bytes cannot be taken back)', () => {
    const prev = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    state.currentEvent = 'update'
    handleChatSSELine('data: {"content":"first attempt output"}', state)
    handleChatSSELine('data: {"content":"short"}', state)

    // On a pipe nothing is streamed at all, so neither answer reaches stdout
    // here — the caller prints the final reply exactly once.
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(state.lastContent).toBe('short')
    Object.defineProperty(process.stdout, 'isTTY', { value: prev, configurable: true })
  })

  it('still appends when the buffer genuinely extends', () => {
    state.currentEvent = 'update'
    handleChatSSELine('data: {"content":"Hel"}', state)
    handleChatSSELine('data: {"content":"Hello"}', state)

    expect(stdoutSpy).toHaveBeenNthCalledWith(2, 'lo')
  })

  it('records queued state without printing (the caller prints it)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    state.currentEvent = 'queued'
    handleChatSSELine('data: {"type":"queued","runId":"run_9"}', state)

    expect(logSpy).not.toHaveBeenCalled()
    expect(state.queued).toBe(true)
    expect(state.runId).toBe('run_9')
  })
})

describe('chat send — queued notice is printed exactly once', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => vi.restoreAllMocks())

  it('reports a queued streaming turn once, end to end', async () => {
    // The isolated handler test cannot catch a double print, because the two
    // notices come from DIFFERENT layers (SSE handler + command body). Only a
    // full run through sendTurn exercises both at once.
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    const encoder = new TextEncoder()
    mockPostStream.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('event: queued\ndata: {"type":"queued","runId":"run_9"}\n\n'),
            )
            controller.close()
          },
        }),
      ),
    )

    await (chatSendCommand as unknown as TestCommand).run({
      args: { agent: 'Bot', message: 'ping' },
    })

    const queuedLines = consoleSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.toLowerCase().includes('queued'))
    expect(queuedLines).toHaveLength(1)
  })
})

describe('chat send — done-only engines do not double-print on a pipe', () => {
  const realIsTTY = process.stdout.isTTY
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    // Piped, NOT a TTY — the case the streaming suites force to true and so
    // never exercised.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: realIsTTY, configurable: true })
    vi.restoreAllMocks()
  })

  it('prints the reply exactly once when the engine emits done without update', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    const encoder = new TextEncoder()
    mockPostStream.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            // No `update` frames at all — the reply arrives only on `done`.
            controller.enqueue(
              encoder.encode(
                'event: done\ndata: {"type":"done","reply":"HELLO_REPLY","chatId":"c1"}\n\n',
              ),
            )
            controller.close()
          },
        }),
      ),
    )

    await (chatSendCommand as unknown as TestCommand).run({
      args: { agent: 'Bot', message: 'ping' },
    })

    const emitted = [
      ...consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])),
      ...stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])),
    ].join('')
    // Was `HELLO_REPLYHELLO_REPLY` with no separator.
    expect(emitted.split('HELLO_REPLY').length - 1).toBe(1)
  })
})
