import { describe, expect, it, vi } from 'vitest'
import { createCcStreamParser } from '../cc-stream-parser.js'
import type { HeartbeatTracker } from '../heartbeat.js'
import type { StreamLogEntry } from '../types.js'

function makeHeartbeat(): HeartbeatTracker & { started: string[]; settled: string[] } {
  const started: string[] = []
  const settled: string[] = []
  return {
    started,
    settled,
    onStarted: (callId) => started.push(callId),
    onSettled: (callId) => settled.push(callId),
    stop: vi.fn(),
  }
}

function setup(initialSessionId?: string) {
  const entries: StreamLogEntry[] = []
  const updates: string[] = []
  const heartbeat = makeHeartbeat()
  const parser = createCcStreamParser({
    onUpdate: (content) => updates.push(content),
    onLogEntry: (entry) => entries.push(entry),
    heartbeat,
    initialSessionId,
  })
  return { parser, entries, updates, heartbeat }
}

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

describe('createCcStreamParser', () => {
  it('captures session_id and forwards the system init event', async () => {
    const { parser, entries } = setup()
    parser.parseLine(line({ type: 'system', subtype: 'init', session_id: 'ses_1', model: 'm1' }))
    expect(parser.state.sessionId).toBe('ses_1')
    expect(entries[0]).toMatchObject({ type: 'system', subtype: 'init', model: 'm1' })
  })

  it('keeps initialSessionId when the stream has no session_id (resume scenario)', async () => {
    const { parser } = setup('ses_prev')
    parser.parseLine(line({ type: 'system', subtype: 'init' }))
    expect(parser.state.sessionId).toBe('ses_prev')
  })

  it('drops noise system subtypes at the source', async () => {
    const { parser, entries } = setup()
    parser.parseLine(line({ type: 'system', subtype: 'thinking_tokens' }))
    expect(entries).toEqual([])
    expect(parser.state.sessionId).toBeUndefined()
  })

  it('accumulates assistant content text blocks into outputBuffer and triggers onUpdate', async () => {
    const { parser, entries, updates } = setup()
    parser.parseLine(
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }] } }),
    )
    parser.parseLine(
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } }),
    )
    expect(parser.state.outputBuffer).toBe('Hello world')
    expect(updates).toEqual(['Hello ', 'Hello world'])
    expect(entries.filter((e) => e.type === 'assistant')).toHaveLength(2)
  })

  it('accumulates text from stream_event text_delta as well', async () => {
    const { parser, updates } = setup()
    parser.parseLine(
      line({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'chunk' } } }),
    )
    expect(parser.state.outputBuffer).toBe('chunk')
    expect(updates).toEqual(['chunk'])
  })

  it('marks a streamed delta as partial and a whole text block as not, so consumers can stitch them', async () => {
    const { parser, entries } = setup()
    parser.parseLine(
      line({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'chu' } } }),
    )
    parser.parseLine(
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole message' }] } }),
    )
    expect(entries.filter((e) => e.type === 'assistant')).toMatchObject([
      { text: 'chu', partial: true },
      { text: 'whole message' },
    ])
    expect(
      (entries.filter((e) => e.type === 'assistant')[1] as { partial?: boolean }).partial,
    ).toBeUndefined()
  })

  it('pairs tool_use → tool_result: backfills toolName and drives the heartbeat', async () => {
    const { parser, entries, heartbeat } = setup()
    parser.parseLine(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } }],
        },
      }),
    )
    parser.parseLine(
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: false }] },
      }),
    )
    const toolEntries = entries.filter((e) => e.type === 'tool_call')
    expect(toolEntries[0]).toMatchObject({
      subtype: 'started',
      callId: 'call_1',
      toolName: 'Bash',
      input: { cmd: 'ls' },
    })
    expect(toolEntries[1]).toMatchObject({
      subtype: 'completed',
      callId: 'call_1',
      toolName: 'Bash',
    })
    expect(heartbeat.started).toEqual(['call_1'])
    expect(heartbeat.settled).toEqual(['call_1'])
  })

  it("carries a successful tool_result's text as tracer-only output (string and blocks carriers)", async () => {
    const { parser, entries } = setup()
    parser.parseLine(
      line({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'c1', is_error: false, content: 'total 0' },
            {
              type: 'tool_result',
              tool_use_id: 'c2',
              is_error: false,
              content: [
                { type: 'text', text: 'line 1' },
                { type: 'text', text: 'line 2' },
              ],
            },
            { type: 'tool_result', tool_use_id: 'c3', is_error: false },
          ],
        },
      }),
    )
    const outputs = entries
      .filter((e) => e.type === 'tool_call')
      .map((e) => (e as { output?: string }).output)
    expect(outputs).toEqual(['total 0', 'line 1\nline 2', undefined])
  })

  it('tool_result is_error=true → failed entry with error text extracted (string / blocks carriers)', async () => {
    const { parser, entries } = setup()
    parser.parseLine(
      line({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'boom' },
            {
              type: 'tool_result',
              tool_use_id: 'c2',
              is_error: true,
              content: [{ type: 'text', text: 'blocked' }],
            },
          ],
        },
      }),
    )
    const failed = entries.filter((e) => e.type === 'tool_call')
    expect(failed[0]).toMatchObject({ subtype: 'failed', callId: 'c1', error: 'boom' })
    expect(failed[1]).toMatchObject({ subtype: 'failed', callId: 'c2', error: 'blocked' })
  })

  it('successful result: the result string overrides outputBuffer', async () => {
    const { parser, entries } = setup()
    parser.parseLine(
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
    )
    parser.parseLine(
      line({ type: 'result', subtype: 'success', is_error: false, result: 'final answer' }),
    )
    expect(parser.state.resultReceived).toBe(true)
    expect(parser.state.resultIsError).toBe(false)
    expect(parser.state.outputBuffer).toBe('final answer')
    expect(entries.at(-1)).toMatchObject({ type: 'result', subtype: 'success' })
  })

  it('result event with usage: fills state.lastUsage and attaches usage to the result entry', async () => {
    const { parser, entries } = setup()
    parser.parseLine(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        usage: {
          input_tokens: 4,
          output_tokens: 20,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 7,
        },
      }),
    )
    const expected = { inputTokens: 4, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 7 }
    expect(parser.state.lastUsage).toEqual(expected)
    expect(entries.at(-1)).toMatchObject({ type: 'result', subtype: 'success', usage: expected })
  })

  it('keeps captured usage when a later result omits it', async () => {
    const { parser } = setup()
    parser.parseLine(
      line({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        usage: { input_tokens: 80, output_tokens: 8 },
      }),
    )
    parser.parseLine(line({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }))
    expect(parser.state.lastUsage).toEqual({ inputTokens: 80, outputTokens: 8 })
  })

  it('result event without usage keeps state.lastUsage undefined and the entry usage-free', async () => {
    const { parser, entries } = setup()
    parser.parseLine(line({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }))
    expect(parser.state.lastUsage).toBeUndefined()
    expect(entries.at(-1)).not.toHaveProperty('usage')
  })

  it('does not collect result usage when collectUsage is false', async () => {
    const entries: StreamLogEntry[] = []
    const heartbeat = makeHeartbeat()
    const parser = createCcStreamParser({
      onLogEntry: (entry) => entries.push(entry),
      heartbeat,
      collectUsage: false,
    })
    parser.parseLine(
      line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 56 },
      }),
    )
    expect(parser.state.lastUsage).toBeUndefined()
    expect(entries.at(-1)).not.toHaveProperty('usage')
  })

  it('failed result: error text supports result string / error field (trae) / errors array (qoder)', async () => {
    // trae shape: error field
    const trae = setup()
    trae.parser.parseLine(
      line({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        error: 'failed to create agent: Models is required',
      }),
    )
    expect(trae.parser.state.resultIsError).toBe(true)
    expect(trae.parser.state.resultErrorText).toContain('Models is required')

    // qoder shape: errors array
    const qoder = setup()
    qoder.parser.parseLine(
      line({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['Qoder API error: FORBIDDEN'],
      }),
    )
    expect(qoder.parser.state.resultErrorText).toContain('FORBIDDEN')

    // claude shape: result string
    const cc = setup()
    cc.parser.parseLine(line({ type: 'result', is_error: true, result: 'rate limited' }))
    expect(cc.parser.state.resultErrorText).toBe('rate limited')
  })

  it('flags a top-level error event as a failure (resultIsError) so exit-0 runs are not persisted as success', async () => {
    const { parser, entries } = setup()
    parser.parseLine(line({ type: 'error', message: 'stream broke' }))
    expect(parser.state.resultIsError).toBe(true)
    expect(parser.state.resultErrorText).toBe('stream broke')
    expect(entries[0]).toMatchObject({ type: 'error', message: 'stream broke' })
  })

  it('flags a top-level error event carried in the `error` field (trae) with a fallback message', async () => {
    const { parser } = setup()
    parser.parseLine(line({ type: 'error' }))
    expect(parser.state.resultIsError).toBe(true)
    expect(parser.state.resultErrorText).toBe('Unknown error')
  })

  it('a sticky error is NOT cleared by a later success result (error → success stays failed)', async () => {
    const { parser } = setup()
    parser.parseLine(line({ type: 'error', message: 'stream broke' }))
    // qoder/trae can emit a success result after an error yet still exit 0 —
    // the run must remain a failure and keep the original cause.
    parser.parseLine(
      line({ type: 'result', subtype: 'success', is_error: false, result: 'recovered' }),
    )
    expect(parser.state.resultReceived).toBe(true)
    expect(parser.state.resultIsError).toBe(true)
    expect(parser.state.resultErrorText).toBe('stream broke')
  })

  it('a success result still overrides outputBuffer text even when the run is flagged failed', async () => {
    const { parser } = setup()
    parser.parseLine(line({ type: 'error', message: 'boom' }))
    parser.parseLine(line({ type: 'result', is_error: false, result: 'final text' }))
    // The buffer reflects the last result text, but the error verdict is sticky.
    expect(parser.state.outputBuffer).toBe('final text')
    expect(parser.state.resultIsError).toBe(true)
  })

  it('safely ignores non-JSON / blank / array lines', async () => {
    const { parser, entries } = setup()
    parser.parseLine('')
    parser.parseLine('plain log text')
    parser.parseLine('[1,2,3]')
    expect(entries).toEqual([])
    expect(parser.state.outputBuffer).toBe('')
  })
})
