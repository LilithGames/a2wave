import { describe, expect, it, vi } from 'vitest'
import { createHeartbeatTracker } from '../heartbeat.js'
import { createKimiStreamParser } from '../kimi-stream-parser.js'
import type { StreamLogEntry } from '../types.js'

function setup(options?: { initialSessionId?: string }) {
  const entries: StreamLogEntry[] = []
  const updates: string[] = []
  const heartbeat = createHeartbeatTracker({ intervalMs: 60_000, emit: () => {} })
  const parser = createKimiStreamParser({
    onUpdate: (text) => updates.push(text),
    onLogEntry: (entry) => entries.push(entry),
    heartbeat,
    ...(options?.initialSessionId ? { initialSessionId: options.initialSessionId } : {}),
  })
  return { parser, entries, updates, heartbeat }
}

describe('createKimiStreamParser', () => {
  it('joins distinct assistant messages with a newline', async () => {
    // Each assistant row is a COMPLETE message (PromptJsonWriter flushes one
    // buffered message per row), never a token delta — so rows must keep
    // their message boundary instead of being concatenated bare.
    const { parser, updates, entries } = setup()

    parser.parseLine(JSON.stringify({ role: 'assistant', content: 'Let me check.' }))
    parser.parseLine(JSON.stringify({ role: 'assistant', content: 'Done.' }))

    expect(parser.state.outputBuffer).toBe('Let me check.\nDone.')
    expect(updates).toEqual(['Let me check.', 'Let me check.\nDone.'])
    expect(entries.filter((e) => e.type === 'assistant')).toHaveLength(2)
  })

  it('keeps the boundary between pre-tool prose and the final answer', async () => {
    // Regression: a run with a tool call emits an assistant row before the
    // call and another after it; bare concatenation fused them into
    // "Let me check.Found ..." with no boundary.
    const { parser } = setup()

    parser.parseLine(
      JSON.stringify({
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{ type: 'function', id: 't9', function: { name: 'Bash', arguments: '{}' } }],
      }),
    )
    parser.parseLine(JSON.stringify({ role: 'tool', tool_call_id: 't9', content: 'ok' }))
    parser.parseLine(JSON.stringify({ role: 'assistant', content: 'Found 3 files.' }))

    expect(parser.state.outputBuffer).toBe('Let me check.\nFound 3 files.')
  })

  it('emits started then completed for a tool call round trip', async () => {
    const { parser, entries } = setup()

    parser.parseLine(
      JSON.stringify({
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'tool_abc',
            function: { name: 'Bash', arguments: '{"command":"ls -la"}' },
          },
        ],
      }),
    )
    parser.parseLine(
      JSON.stringify({ role: 'tool', tool_call_id: 'tool_abc', content: 'total 8\n' }),
    )

    const toolEntries = entries.filter((e) => e.type === 'tool_call')
    expect(toolEntries).toEqual([
      expect.objectContaining({
        subtype: 'started',
        callId: 'tool_abc',
        toolName: 'Bash',
        input: { command: 'ls -la' },
      }),
      expect.objectContaining({ subtype: 'completed', callId: 'tool_abc', toolName: 'Bash' }),
    ])
  })

  it('parses stringified tool arguments and tolerates malformed JSON', async () => {
    const { parser, entries } = setup()

    parser.parseLine(
      JSON.stringify({
        role: 'assistant',
        tool_calls: [
          { type: 'function', id: 't1', function: { name: 'Read', arguments: 'not-json' } },
        ],
      }),
    )

    const started = entries.find((e) => e.type === 'tool_call')
    expect(started).toMatchObject({ subtype: 'started', toolName: 'Read' })
    // Unparseable arguments must not crash, and must not fabricate an input object.
    expect((started as { input?: unknown }).input).toBeUndefined()
  })

  it('captures the session id from the resume hint meta row', async () => {
    const { parser } = setup()

    parser.parseLine(
      JSON.stringify({
        role: 'meta',
        type: 'session.resume_hint',
        session_id: 'session_119fce0e',
        command: 'kimi -r session_119fce0e',
        content: 'To resume this session: kimi -r session_119fce0e',
      }),
    )

    expect(parser.state.sessionId).toBe('session_119fce0e')
    // The resume hint is bookkeeping, not assistant prose.
    expect(parser.state.outputBuffer).toBe('')
  })

  it('ignores meta rows that carry no session id (version banner, retry notice)', async () => {
    // 0.42.0 opens every stream-json run with a `system.version` meta row and
    // may emit `turn.step.retrying` mid-run; neither is prose or a session hint.
    const { parser, entries } = setup({ initialSessionId: 'session_prev' })

    parser.parseLine('{"role":"meta","type":"system.version","version":"0.42.0"}')
    parser.parseLine(
      JSON.stringify({
        role: 'meta',
        type: 'turn.step.retrying',
        failed_attempt: 1,
        next_attempt: 2,
        max_attempts: 3,
        delay_ms: 1000,
        error_name: 'APIConnectionError',
        error_message: 'socket hang up',
      }),
    )

    expect(parser.state.sessionId).toBe('session_prev')
    expect(parser.state.outputBuffer).toBe('')
    expect(parser.state.resultIsError).toBe(false)
    expect(entries).toEqual([])
  })

  it('keeps the initial session id when the stream carries no hint', async () => {
    const { parser } = setup({ initialSessionId: 'session_prev' })

    parser.parseLine(JSON.stringify({ role: 'assistant', content: 'hi' }))

    expect(parser.state.sessionId).toBe('session_prev')
  })

  it('maps an `is_error` tool result to failed (forward-compat guard)', async () => {
    // NOTE: the real 0.30.0 protocol NEVER emits `is_error` — writeToolResult
    // only writes {role, tool_call_id, content}, so actual tool failures
    // settle as `completed` and surface via stderr + exit code instead. This
    // test covers the defensive branch in case upstream grows the marker;
    // it is not a claim about today's failure mapping.
    const { parser, entries } = setup()

    parser.parseLine(
      JSON.stringify({
        role: 'assistant',
        tool_calls: [{ type: 'function', id: 't2', function: { name: 'Bash', arguments: '{}' } }],
      }),
    )
    parser.parseLine(
      JSON.stringify({
        role: 'tool',
        tool_call_id: 't2',
        is_error: true,
        content: 'command not found',
      }),
    )

    expect(entries.filter((e) => e.type === 'tool_call').at(-1)).toMatchObject({
      subtype: 'failed',
      callId: 't2',
      error: 'command not found',
    })
  })

  it('settles a tool result without an error marker as completed', async () => {
    // Documents the real-protocol behaviour: a tool that failed (e.g. non-zero
    // exit inside the CLI) arrives with the exact same shape as a success, so
    // the log entry is `completed` — the run-level failure surfaces via the
    // engine's exit-code verdict, not per-tool entries.
    const { parser, entries } = setup()

    parser.parseLine(
      JSON.stringify({
        role: 'assistant',
        tool_calls: [{ type: 'function', id: 't8', function: { name: 'Bash', arguments: '{}' } }],
      }),
    )
    parser.parseLine(
      JSON.stringify({ role: 'tool', tool_call_id: 't8', content: 'command not found' }),
    )

    expect(entries.filter((e) => e.type === 'tool_call').at(-1)).toMatchObject({
      subtype: 'completed',
      callId: 't8',
    })
  })

  it('ignores a tool result row with a missing or empty tool_call_id', async () => {
    const { parser, entries } = setup()

    parser.parseLine(JSON.stringify({ role: 'tool', content: 'orphan' }))
    parser.parseLine(JSON.stringify({ role: 'tool', tool_call_id: '', content: 'orphan' }))

    expect(entries.filter((e) => e.type === 'tool_call')).toHaveLength(0)
  })

  it('settles a result that arrives before its started row with an empty tool name', async () => {
    // NDJSON truncation or a dropped assistant row can produce a result with
    // no matching tool_calls entry; the call must still settle (heartbeat
    // cleared) rather than linger.
    const heartbeatCalls: string[] = []
    const heartbeat = {
      onStarted: (callId: string) => heartbeatCalls.push(`start:${callId}`),
      onSettled: (callId: string) => heartbeatCalls.push(`settle:${callId}`),
      stop: vi.fn(),
    }
    const entries: StreamLogEntry[] = []
    const parser = createKimiStreamParser({
      heartbeat,
      onLogEntry: (entry) => entries.push(entry),
    })

    parser.parseLine(JSON.stringify({ role: 'tool', tool_call_id: 't_orphan', content: 'ok' }))

    expect(heartbeatCalls).toEqual(['settle:t_orphan'])
    expect(entries.filter((e) => e.type === 'tool_call')).toEqual([
      expect.objectContaining({ subtype: 'completed', callId: 't_orphan', toolName: '' }),
    ])
  })

  it('ignores blank lines and non-JSON noise', async () => {
    const { parser, entries } = setup()

    parser.parseLine('')
    parser.parseLine('   ')
    parser.parseLine('not json at all')
    parser.parseLine('[1,2,3]')

    expect(entries).toHaveLength(0)
    expect(parser.state.outputBuffer).toBe('')
  })

  it('records an error row as a fatal error', async () => {
    const { parser, entries } = setup()

    parser.parseLine(JSON.stringify({ role: 'error', content: 'model overloaded' }))

    expect(parser.state.resultIsError).toBe(true)
    expect(parser.state.resultErrorText).toBe('model overloaded')
    expect(entries).toEqual([
      expect.objectContaining({ type: 'error', message: 'model overloaded' }),
    ])
  })

  it('treats array-shaped assistant content blocks as text', async () => {
    const { parser } = setup()

    parser.parseLine(
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
      }),
    )

    expect(parser.state.outputBuffer).toBe('part one part two')
  })

  it('ignores non-text blocks so reasoning cannot leak into the answer', async () => {
    // Kimi is OpenAI-chat shaped, where a content array may legitimately carry
    // `reasoning` / `refusal` blocks alongside `text`. Collecting every block
    // with a `.text` field would splice internal reasoning into run output,
    // chat replies and A2A responses. cc-stream-parser gates on
    // `type === 'text'` for the same reason.
    const { parser } = setup()

    parser.parseLine(
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'SECRET internal deliberation' },
          { type: 'text', text: 'the answer' },
          { type: 'refusal', text: 'SECRET refusal detail' },
        ],
      }),
    )

    expect(parser.state.outputBuffer).toBe('the answer')
  })

  it('settles the heartbeat when a tool result arrives', async () => {
    const heartbeatCalls: string[] = []
    const heartbeat = {
      onStarted: (callId: string) => heartbeatCalls.push(`start:${callId}`),
      onSettled: (callId: string) => heartbeatCalls.push(`settle:${callId}`),
      stop: vi.fn(),
    }
    const parser = createKimiStreamParser({ heartbeat })

    parser.parseLine(
      JSON.stringify({
        role: 'assistant',
        tool_calls: [{ type: 'function', id: 't3', function: { name: 'Grep', arguments: '{}' } }],
      }),
    )
    parser.parseLine(JSON.stringify({ role: 'tool', tool_call_id: 't3', content: 'ok' }))

    expect(heartbeatCalls).toEqual(['start:t3', 'settle:t3'])
  })

  it('replays a full captured transcript end to end', async () => {
    const { parser, entries } = setup()
    const transcript = [
      '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_EUs7","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls -la\\"}"}}]}',
      '{"role":"tool","tool_call_id":"tool_EUs7","content":"total 8\\n"}',
      '{"role":"assistant","content":"Files in the current directory:\\n\\nDONE"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"session_119fce0e","command":"kimi -r session_119fce0e"}',
    ]

    for (const line of transcript) parser.parseLine(line)

    expect(parser.state.outputBuffer).toBe('Files in the current directory:\n\nDONE')
    expect(parser.state.sessionId).toBe('session_119fce0e')
    expect(parser.state.resultIsError).toBe(false)
    expect(entries.filter((e) => e.type === 'tool_call').map((e) => e.subtype)).toEqual([
      'started',
      'completed',
    ])
  })
})
