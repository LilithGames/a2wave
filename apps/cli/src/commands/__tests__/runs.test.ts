import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPostStream = vi.fn()
const mockGetRaw = vi.fn()
const mockResolveAgentId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    postStream: mockPostStream,
    getRaw: mockGetRaw,
    resolveAgentId: mockResolveAgentId,
  }),
}))

const { runsCommand, formatLog, handleSSELine, parsePage, parsePageSize, sortSteps, waitForRun } =
  await import('../runs.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }

function getSubCommand(name: string) {
  const subCommands = runsCommand.subCommands as Record<string, TestSubCommand>
  return subCommands[name]
}

describe('formatLog', () => {
  it('returns text for assistant type', () => {
    expect(formatLog({ type: 'assistant', text: 'Hello', ts: 0 })).toBe('Hello')
  })

  it('returns empty string for assistant with no text', () => {
    expect(formatLog({ type: 'assistant', ts: 0 })).toBe('')
  })

  it('formats tool_call entries', () => {
    expect(formatLog({ type: 'tool_call', toolName: 'Read', subtype: 'start', ts: 0 })).toBe(
      '[tool:Read] start',
    )
  })

  it('formats result entries with duration', () => {
    expect(formatLog({ type: 'result', subtype: 'success', durationMs: 1234, ts: 0 })).toBe(
      '[done] success (1234ms)',
    )
  })

  it('formats result entries without duration', () => {
    expect(formatLog({ type: 'result', subtype: 'success', ts: 0 })).toBe('[done] success')
  })

  it('formats error entries', () => {
    expect(formatLog({ type: 'error', message: 'timeout', ts: 0 })).toBe('[error] timeout')
  })

  it('formats retry entries', () => {
    expect(formatLog({ type: 'retry', attempt: 2, nextAttemptIn: 5000, ts: 0 })).toBe(
      '[retry] attempt 2, retrying in 5000ms',
    )
  })

  it('returns empty string for system type', () => {
    expect(formatLog({ type: 'system', ts: 0 })).toBe('')
  })

  it('reports the served fast-mode state on the result line', () => {
    expect(
      formatLog({
        type: 'result',
        subtype: 'success',
        durationMs: 1234,
        fastModeState: 'on',
        ts: 0,
      }),
    ).toBe('[done] success (1234ms) fastMode=on')
  })

  it('reports a denied fast-mode request instead of hiding it', () => {
    expect(formatLog({ type: 'result', subtype: 'success', fastModeState: 'denied', ts: 0 })).toBe(
      '[done] success fastMode=denied',
    )
  })

  it('leaves the result line alone when the engine reported no fast-mode state', () => {
    expect(formatLog({ type: 'result', subtype: 'success', durationMs: 5, ts: 0 })).toBe(
      '[done] success (5ms)',
    )
  })

  it('names the model on the init entry', () => {
    expect(formatLog({ type: 'system', subtype: 'init', model: 'gpt-5.6-sol', ts: 0 })).toBe(
      '[init] model=gpt-5.6-sol',
    )
  })

  it('stays silent for an init entry carrying no model', () => {
    expect(formatLog({ type: 'system', subtype: 'init', ts: 0 })).toBe('')
  })

  it('reports the reasoning effort and fast-mode request from exec_params', () => {
    expect(
      formatLog({
        type: 'exec_params',
        engine: 'codex',
        params: { cmd: 'codex', reasoningEffort: 'ultra', fastMode: true },
        ts: 0,
      }),
    ).toBe('[params] reasoningEffort=ultra fastMode=true')
  })

  it('reports the effort alone when fast mode was not requested', () => {
    expect(
      formatLog({
        type: 'exec_params',
        engine: 'claude-code',
        params: { cmd: 'claude', reasoningEffort: 'high' },
        ts: 0,
      }),
    ).toBe('[params] reasoningEffort=high')
  })

  it('reports fast mode alone when no effort was set', () => {
    expect(
      formatLog({
        type: 'exec_params',
        engine: 'claude-code',
        params: { cmd: 'claude', fastMode: true },
        ts: 0,
      }),
    ).toBe('[params] fastMode=true')
  })

  it('stays silent for exec_params carrying neither control', () => {
    expect(
      formatLog({ type: 'exec_params', engine: 'codex', params: { cmd: 'codex' }, ts: 0 }),
    ).toBe('')
  })
})

describe('handleSSELine', () => {
  let state: { currentEvent: string; lastContent: string }
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    state = { currentEvent: '', lastContent: '' }
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses event lines and updates state', () => {
    handleSSELine('event: update', state)
    expect(state.currentEvent).toBe('update')
  })

  it('ignores non-event non-data lines', () => {
    handleSSELine('', state)
    handleSSELine(': comment', state)
    handleSSELine('random text', state)
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('prints incremental content for update events', () => {
    state.currentEvent = 'update'
    handleSSELine('data: {"content":"Hello"}', state)
    expect(stdoutSpy).toHaveBeenCalledWith('Hello')
    expect(state.lastContent).toBe('Hello')

    // Second update with cumulative content
    handleSSELine('data: {"content":"Hello world"}', state)
    expect(stdoutSpy).toHaveBeenCalledWith(' world')
    expect(state.lastContent).toBe('Hello world')
  })

  it('skips update events with no new content', () => {
    state.currentEvent = 'update'
    state.lastContent = 'Hello'
    handleSSELine('data: {"content":"Hello"}', state)
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('handles log events', () => {
    state.currentEvent = 'log'
    handleSSELine('data: {"type":"tool_call","toolName":"Bash","subtype":"start","ts":0}', state)
    expect(consoleSpy).toHaveBeenCalledWith('  [tool:Bash] start')
  })

  it('skips assistant log entries (shown via update)', () => {
    state.currentEvent = 'log'
    handleSSELine('data: {"type":"assistant","text":"hi","ts":0}', state)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('handles done events', () => {
    state.currentEvent = 'done'
    handleSSELine('data: {"durationMs":5000}', state)
    expect(consoleSpy).toHaveBeenCalledWith('\n[execution complete]')
    expect(consoleSpy).toHaveBeenCalledWith('Duration: 5000ms')
  })

  it('handles error events', () => {
    state.currentEvent = 'error'
    expect(() => handleSSELine('data: {"error":"boom"}', state)).toThrow('[execution failed] boom')
  })

  it('skips malformed JSON data lines', () => {
    state.currentEvent = 'update'
    handleSSELine('data: not-json', state)
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('skips empty data lines', () => {
    state.currentEvent = 'update'
    handleSSELine('data: ', state)
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('handles done event without durationMs', () => {
    state.currentEvent = 'done'
    handleSSELine('data: {}', state)
    expect(consoleSpy).toHaveBeenCalledWith('\n[execution complete]')
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Duration'))
  })

  it('handles error event without error field', () => {
    state.currentEvent = 'error'
    expect(() => handleSSELine('data: {"code":"TIMEOUT"}', state)).toThrow('"code":"TIMEOUT"')
  })
})

describe('runsCommand list', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('prints run records', async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        { id: 'run_1', status: 'completed', agentName: 'Bot A', intent: 'hello' },
        { id: 'run_2', status: 'running', agentName: null, intent: 'world' },
      ],
    })

    await getSubCommand('list').run({ args: {} })

    expect(mockGet).toHaveBeenCalledWith('/api/runs?page=1&pageSize=20')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('run_1'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Bot A]'))
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('run_2'))
  })

  it('prints empty message when no runs', async () => {
    mockGet.mockResolvedValueOnce({ data: [] })

    await getSubCommand('list').run({ args: {} })

    expect(consoleSpy).toHaveBeenCalledWith('No run records')
  })

  it('filters by agent name', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({ data: [] })

    await getSubCommand('list').run({ args: { agent: 'Bot A' } })

    expect(mockResolveAgentId).toHaveBeenCalledWith('Bot A')
    expect(mockGet).toHaveBeenCalledWith('/api/runs?page=1&pageSize=20&agentId=agt_1')
  })

  it('truncates long intents at 50 chars', async () => {
    const longIntent = 'a'.repeat(60)
    mockGet.mockResolvedValueOnce({
      data: [{ id: 'run_1', status: 'completed', agentName: null, intent: longIntent }],
    })

    await getSubCommand('list').run({ args: {} })

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(`${'a'.repeat(50)}...`))
  })
})

describe('runsCommand get', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('prints run details', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'run_1',
        status: 'completed',
        intent: 'test intent',
        createdAt: '2025-01-01',
        result: null,
        steps: [],
      },
    })

    await getSubCommand('get').run({ args: { id: 'run_1' } })

    expect(mockGet).toHaveBeenCalledWith('/api/runs/run_1')
    expect(consoleSpy).toHaveBeenCalledWith('ID:       run_1')
    expect(consoleSpy).toHaveBeenCalledWith('Status:   completed')
    expect(consoleSpy).toHaveBeenCalledWith('Intent:   test intent')
    expect(consoleSpy).toHaveBeenCalledWith('Created:  2025-01-01')
  })

  it('prints duration and error when present', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'run_1',
        status: 'failed',
        intent: 'test',
        createdAt: '2025-01-01',
        result: { durationMs: 3000, error: 'timeout' },
        steps: [],
      },
    })

    await getSubCommand('get').run({ args: { id: 'run_1' } })

    expect(consoleSpy).toHaveBeenCalledWith('Duration: 3000ms')
    expect(consoleSpy).toHaveBeenCalledWith('Error:    timeout')
  })

  it('prints logs from steps', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'run_1',
        status: 'completed',
        intent: 'test',
        createdAt: '2025-01-01',
        result: null,
        steps: [
          {
            output: {
              logs: [{ type: 'tool_call', toolName: 'Bash', subtype: 'start', ts: 0 }],
              result: 'Final output',
            },
          },
        ],
      },
    })

    await getSubCommand('get').run({ args: { id: 'run_1' } })

    expect(consoleSpy).toHaveBeenCalledWith('\n--- Execution logs ---')
    expect(consoleSpy).toHaveBeenCalledWith('[tool:Bash] start')
    expect(consoleSpy).toHaveBeenCalledWith('\n--- Execution result ---')
    expect(consoleSpy).toHaveBeenCalledWith('Final output')
  })

  // A long run's logs are the single largest thing this CLI prints, and an
  // agent calling `runs get` usually wants the status, not 4000 tool calls.
  describe('log bounding', () => {
    function runWithLogs(count: number) {
      return {
        data: {
          id: 'run_1',
          status: 'completed',
          intent: 'test',
          createdAt: '2025-01-01',
          result: null,
          steps: [
            {
              output: {
                logs: Array.from({ length: count }, (_, i) => ({
                  type: 'tool_call',
                  toolName: `Tool${i}`,
                  subtype: 'start',
                  ts: i,
                })),
              },
            },
          ],
        },
      }
    }

    it('caps the printed log entries and says what it hid', async () => {
      mockGet.mockResolvedValueOnce(runWithLogs(500))

      await getSubCommand('get').run({ args: { id: 'run_1' } })

      const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      // The tail is kept, not the head: the end of a log is where the failure is.
      expect(out).toContain('Tool499')
      expect(out).not.toContain('Tool0]')
      // Truncation is never silent, and the notice names the way to get it all.
      expect(out).toMatch(/\d+ earlier entries hidden/)
      expect(out).toContain('a2wave runs logs run_1')
    })

    it('prints everything with --full', async () => {
      mockGet.mockResolvedValueOnce(runWithLogs(500))

      await getSubCommand('get').run({ args: { id: 'run_1', full: true } })

      const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(out).toContain('Tool0')
      expect(out).toContain('Tool499')
      expect(out).not.toMatch(/entries hidden/)
    })

    it('honours an explicit --max-log-lines', async () => {
      mockGet.mockResolvedValueOnce(runWithLogs(500))

      await getSubCommand('get').run({ args: { id: 'run_1', 'max-log-lines': '10' } })

      const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(out).toContain('Tool499')
      expect(out).toContain('Tool490')
      expect(out).not.toContain('Tool489')
    })

    it('does not add a notice when the log fits', async () => {
      mockGet.mockResolvedValueOnce(runWithLogs(3))

      await getSubCommand('get').run({ args: { id: 'run_1' } })

      const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(out).toContain('Tool0')
      expect(out).not.toMatch(/entries hidden/)
    })

    it('leaves --json untouched, since a parser is not a terminal', async () => {
      // Truncation is a human/context-window affordance. Silently dropping
      // entries from a machine payload would corrupt it with no error.
      const payload = runWithLogs(500)
      mockGet.mockResolvedValueOnce(payload)

      await getSubCommand('get').run({ args: { id: 'run_1', json: true } })

      const parsed = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))
      expect(parsed.data.steps[0].output.logs).toHaveLength(500)
    })
  })
})

describe('runsCommand trigger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('creates run and consumes SSE stream', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'run_1' } })

    // Create a readable stream that emits SSE data
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: done\ndata: {"durationMs":1000}\n\n'))
        controller.close()
      },
    })
    mockPostStream.mockResolvedValueOnce(new Response(stream))

    await getSubCommand('trigger').run({ args: { agent: 'Bot A', intent: 'hello' } })

    expect(mockResolveAgentId).toHaveBeenCalledWith('Bot A')
    expect(mockPost).toHaveBeenCalledWith('/api/runs', {
      intent: 'hello',
      initiatorAgentId: 'agt_1',
    })
    expect(mockPostStream).toHaveBeenCalledWith('/api/runs/run_1/execute', { stream: true })
    expect(consoleSpy).toHaveBeenCalledWith('Triggering Agent: agt_1')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Run ID: run_1'))
  })
})

describe('parsePage / parsePageSize', () => {
  it('defaults when omitted, accepts valid input', () => {
    expect(parsePage(undefined)).toBe(1)
    expect(parsePage('')).toBe(1)
    expect(parsePage('4')).toBe(4)
    expect(parsePageSize(undefined)).toBe(20)
    expect(parsePageSize('50')).toBe(50)
  })

  it('rejects junk instead of silently coercing it', () => {
    // `--limit abc` quietly becoming 20 hides a typo behind results that look
    // right — the user gets a page they did not ask for and no indication why.
    expect(() => parsePage('abc')).toThrow(/must be an integer/)
    expect(() => parsePageSize('abc')).toThrow(/must be an integer/)
  })

  it('rejects an out-of-range page, which has no sensible clamp', () => {
    expect(() => parsePage('0')).toThrow(/at least 1/)
    expect(() => parsePage('-3')).toThrow(/at least 1/)
  })

  it('clamps an out-of-range limit rather than breaking existing scripts', () => {
    // `--limit 1000` as shorthand for "everything" predates this helper; the
    // API clamps to 100 regardless, so failing hard would break callers for no
    // safety gain. Only junk input errors.
    expect(parsePageSize('500')).toBe(100)
    expect(parsePageSize('0')).toBe(1)
    expect(parsePageSize('-5')).toBe(1)
  })
})

describe('sortSteps', () => {
  it('orders steps by `order` without mutating the input', () => {
    const steps = [{ order: 2 }, { order: 0 }, { order: 1 }]
    expect(sortSteps(steps).map((s) => s.order)).toEqual([0, 1, 2])
    expect(steps.map((s) => s.order)).toEqual([2, 0, 1])
  })
})

describe('waitForRun', () => {
  it('polls until the run reaches a terminal status', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: 'run_1', status: 'queued' } })
      .mockResolvedValueOnce({ data: { id: 'run_1', status: 'running' } })
      .mockResolvedValueOnce({ data: { id: 'run_1', status: 'completed' } })

    const final = await waitForRun({ get }, 'run_1', { sleep: async () => {} })

    expect(final.status).toBe('completed')
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('throws once the timeout elapses', async () => {
    const get = vi.fn().mockResolvedValue({ data: { id: 'run_1', status: 'running' } })
    await expect(
      waitForRun({ get }, 'run_1', { timeoutMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/Timed out/)
  })
})

describe('runsCommand get (multi-step)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('prints every step of a multi-turn run, in order', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'run_1',
        status: 'completed',
        intent: 'test',
        createdAt: '2025-01-01',
        result: null,
        steps: [
          { order: 1, output: { result: 'second turn' } },
          { order: 0, output: { result: 'first turn' } },
        ],
      },
    })

    await getSubCommand('get').run({ args: { id: 'run_1' } })

    const printed = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(printed).toContain('first turn')
    expect(printed).toContain('second turn')
    expect(printed.indexOf('first turn')).toBeLessThan(printed.indexOf('second turn'))
    expect(printed.some((l: string) => l.includes('step 1/2'))).toBe(true)
  })

  it('emits raw JSON with --json', async () => {
    const payload = { data: { id: 'run_1', status: 'completed', intent: 'x', createdAt: 'y' } }
    mockGet.mockResolvedValueOnce(payload)

    await getSubCommand('get').run({ args: { id: 'run_1', json: true } })

    // Parsed, not string-compared: the JSON layout belongs to emit().
    expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual(payload)
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Status:'))
  })
})

describe('runsCommand cancel', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  // Without this the `console.log` spy stays installed past the block, so the
  // next test's own spy stacks on top of it and inherits its recorded calls —
  // `handleSSELine > ignores non-event non-data lines` then sees a stray
  // "Cancelled ✓ run_1" and fails for a reason unrelated to itself.
  afterEach(() => vi.restoreAllMocks())

  it('posts to the cancel endpoint and reports the new status', async () => {
    mockPost.mockResolvedValueOnce({ data: { runId: 'run_1', status: 'cancelled' } })

    await getSubCommand('cancel').run({ args: { id: 'run_1' } })

    expect(mockPost).toHaveBeenCalledWith('/api/runs/run_1/cancel', {})
    expect(consoleSpy).toHaveBeenCalledWith('Cancelled ✓  run_1 (cancelled)')
  })
})

describe('runsCommand rerun', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('never re-executes the run the server already started', async () => {
    mockPost.mockResolvedValueOnce({ data: { id: 'run_2', status: 'running' } })

    await getSubCommand('rerun').run({ args: { id: 'run_1' } })

    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(mockPost).toHaveBeenCalledWith('/api/runs/run_1/rerun', {})
    expect(mockPostStream).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith('Rerun created ✓  run_2 (running)')
  })

  it('polls to completion with --wait and exits non-zero on failure', async () => {
    const prevExitCode = process.exitCode
    mockPost.mockResolvedValueOnce({ data: { id: 'run_2', status: 'running' } })
    mockGet.mockResolvedValueOnce({
      data: { id: 'run_2', status: 'failed', result: { error: 'boom' } },
    })

    await getSubCommand('rerun').run({ args: { id: 'run_1', wait: true } })

    expect(consoleSpy).toHaveBeenCalledWith('Rerun run_2 → failed')
    expect(process.exitCode).toBe(1)
    process.exitCode = prevExitCode
  })
})

describe('runsCommand logs', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let tmpDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    tmpDir = mkdtempSync(join(tmpdir(), 'runlogs-'))
  })

  afterEach(() => vi.restoreAllMocks())

  /** A real streaming Response, so the command's pipeline path is exercised. */
  function streamResponse(text: string): Response {
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text))
          controller.close()
        },
      }),
    )
  }

  it('streams the untruncated NDJSON to stdout by default', async () => {
    const chunks: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c))
      return true
    })
    mockGetRaw.mockResolvedValueOnce(streamResponse('{"a":1}\n{"a":2}\n'))

    await getSubCommand('logs').run({ args: { id: 'run_1' } })

    expect(mockGetRaw).toHaveBeenCalledWith('/api/runs/run_1/logs/download')
    expect(chunks.join('')).toContain('{"a":1}')
    stdoutSpy.mockRestore()
  })

  it('writes to the given path with -o', async () => {
    const { join } = await import('node:path')
    const { readFileSync } = await import('node:fs')
    const out = join(tmpDir, 'out.ndjson')
    mockGetRaw.mockResolvedValueOnce(streamResponse('{"a":1}\n'))

    await getSubCommand('logs').run({ args: { id: 'run_1', output: out } })

    expect(readFileSync(out, 'utf-8')).toBe('{"a":1}\n')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('out.ndjson'))
  })

  it('never buffers the whole body in memory', async () => {
    // Guard against a regression to `await res.text()`: the sidecar log is the
    // untruncated copy and can be hundreds of MiB.
    const { join } = await import('node:path')
    const res = streamResponse('{"a":1}\n')
    const textSpy = vi.spyOn(res, 'text')
    mockGetRaw.mockResolvedValueOnce(res)

    await getSubCommand('logs').run({ args: { id: 'run_1', output: join(tmpDir, 'x.ndjson') } })

    expect(textSpy).not.toHaveBeenCalled()
  })
})

describe('runsCommand list --status', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('rejects an unknown status before calling the API', async () => {
    await expect(getSubCommand('list').run({ args: { status: 'bogus' } })).rejects.toThrow(
      /Invalid --status/,
    )
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('filters the page and says the filter is page-scoped', async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        { id: 'run_1', status: 'failed', agentName: null, intent: 'a' },
        { id: 'run_2', status: 'completed', agentName: null, intent: 'b' },
      ],
    })

    await getSubCommand('list').run({ args: { status: 'failed' } })

    const printed = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('run_1')
    expect(printed).not.toContain('run_2')
    expect(printed).toContain('this page only')
  })
})

describe('runsCommand rerun --wait --json exit codes', () => {
  let prevExitCode: string | number | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    prevExitCode = process.exitCode ?? undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    process.exitCode = prevExitCode
    vi.restoreAllMocks()
  })

  it('still exits non-zero when --json is combined with --wait', async () => {
    mockPost.mockResolvedValueOnce({ data: { id: 'run_2', status: 'running' } })
    mockGet.mockResolvedValueOnce({ data: { id: 'run_2', status: 'failed' } })

    await getSubCommand('rerun').run({ args: { id: 'run_1', wait: true, json: true } })

    expect(process.exitCode).toBe(1)
  })

  it('treats a cancelled replay as a failure for CI', async () => {
    mockPost.mockResolvedValueOnce({ data: { id: 'run_2', status: 'running' } })
    mockGet.mockResolvedValueOnce({ data: { id: 'run_2', status: 'cancelled' } })

    await getSubCommand('rerun').run({ args: { id: 'run_1', wait: true } })

    expect(process.exitCode).toBe(1)
  })
})

describe('runsCommand logs — durability', () => {
  let tmpDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    tmpDir = mkdtempSync(join(tmpdir(), 'runlogs-dur-'))
  })

  afterEach(() => vi.restoreAllMocks())

  it('keeps the previous file when the download fails mid-stream', async () => {
    const { writeFileSync, readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const target = join(tmpDir, 'existing.ndjson')
    writeFileSync(target, 'PREVIOUS GOOD LOG\n')

    // A stream that dies partway, as a dropped connection would.
    mockGetRaw.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'))
            controller.error(new Error('network dropped'))
          },
        }),
      ),
    )

    await expect(
      getSubCommand('logs').run({ args: { id: 'run_1', output: target } }),
    ).rejects.toThrow()

    // createWriteStream(target) would have truncated it to empty on open.
    expect(readFileSync(target, 'utf-8')).toBe('PREVIOUS GOOD LOG\n')
    // And the temp file must not be left behind.
    expect(readdirSync(tmpDir).filter((f) => f.includes('.part-'))).toEqual([])
  })
})

describe('parseIntFlag coercion (via --page / --limit)', () => {
  it('rejects hex, binary and exponent forms instead of reinterpreting them', () => {
    // `Number()` accepts all of these and they pass Number.isInteger, so
    // `--page 0x10` used to quietly fetch page 16 with nothing to explain why —
    // the same silent-coercion class this change set out to remove.
    expect(() => parsePage('0x10')).toThrow(/must be an integer/)
    expect(() => parsePage('1e3')).toThrow(/must be an integer/)
    expect(() => parsePage('0b11')).toThrow(/must be an integer/)
    expect(() => parsePageSize('1e3')).toThrow(/must be an integer/)
  })

  it('accepts plain decimals, including whitespace-padded and signed', () => {
    expect(parsePage(' 7 ')).toBe(7)
    expect(parsePage('+3')).toBe(3)
    expect(parsePageSize('50')).toBe(50)
  })

  it('names the offending value in the message', () => {
    expect(() => parsePage('0x10')).toThrow(/0x10/)
  })
})

describe('waitForRun cadence propagation', () => {
  it('hands its own cadence to the helper and forwards opts unmerged', async () => {
    // Asserted on the ARGUMENTS `waitForRun` passes down, not on the observable
    // poll behaviour, because for this wrapper no behavioural test can exist.
    // Its cadence (2000ms / 30min) is byte-identical to the generic defaults the
    // pre-!206 helper fell back to (`opts.intervalMs ?? 2000`,
    // `opts.timeoutMs ?? 30 * 60_000` — see 0ec471e3). Enumerating every shape
    // of `opts` shows `??` and `{...cadence, ...opts}` produce the SAME interval
    // and timeout for all of them, so `expect(sleep).toHaveBeenCalledWith(2000)`
    // is true under the bug as well and guards nothing. `waitForTask` is
    // testable through behaviour only because its 5000ms / 60min cadence
    // differs from those defaults.
    //
    // What remains observable — and what the bug actually destroyed — is the
    // call shape: the cadence must arrive as its own argument and `opts` must
    // be forwarded untouched, so an explicit `undefined` is resolved by the
    // helper's `??` rather than pre-merged away by the caller.
    const pollSpy = vi.fn().mockResolvedValue({ id: 'run_1', status: 'completed' })
    vi.doMock('../../lib/poll.js', () => ({ pollUntilTerminal: pollSpy }))
    vi.resetModules()
    const { waitForRun: subject } = await import('../runs.js')

    try {
      const get = vi.fn()
      const opts = { timeoutMs: undefined, intervalMs: undefined }
      await subject({ get }, 'run_1', opts)

      const [, path, , , cadence, forwarded] = pollSpy.mock.calls[0]
      expect(path).toBe('/api/runs/run_1')
      expect(cadence).toEqual({ intervalMs: 2000, timeoutMs: 30 * 60_000 })
      // The same object, not a merge of cadence and opts. `toBe` is the whole
      // point: `{...cadence, ...opts}` would satisfy `toEqual` on the keys it
      // copied while having already blanked the caller's values.
      expect(forwarded).toBe(opts)
    } finally {
      vi.doUnmock('../../lib/poll.js')
      vi.resetModules()
    }
  })
})

describe('parseIntFlag safe-integer bound', () => {
  it('rejects a value beyond the safe integer range', () => {
    // Distinct branch and distinct message from "must be an integer" —
    // 2^53 converts cleanly but cannot round-trip.
    expect(() => parsePage('9007199254740993')).toThrow(/safe integer range/)
  })
})
