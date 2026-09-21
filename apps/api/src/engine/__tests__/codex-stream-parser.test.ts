import { describe, expect, it } from 'vitest'
import {
  composeCodexAssistantOutput,
  type ParsedCodexEvent,
  parseCodexStreamLine,
  statKeyFor,
} from '../codex-stream-parser.js'

const events = (line: string): ParsedCodexEvent[] => parseCodexStreamLine(line).events

describe('parseCodexStreamLine — events', () => {
  it('returns non_json for invalid JSON', async () => {
    expect(events('not json')).toEqual([{ kind: 'non_json' }])
    expect(events('')).toEqual([{ kind: 'non_json' }])
  })

  it('emits session event from thread.started', async () => {
    const evs = events(JSON.stringify({ type: 'thread.started', thread_id: 'th_abc' }))
    expect(evs).toEqual([{ kind: 'session', chatId: 'th_abc' }])
  })

  it('thread.started without thread_id emits no event', async () => {
    const evs = events(JSON.stringify({ type: 'thread.started' }))
    expect(evs).toEqual([])
  })

  it('parses turn.started', async () => {
    expect(events(JSON.stringify({ type: 'turn.started' }))).toEqual([{ kind: 'turn_started' }])
  })

  it('parses turn.completed with usage', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 },
        }),
      ),
    ).toEqual([
      {
        kind: 'turn_completed',
        usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 },
      },
    ])
  })

  it('parses turn.completed without usage', async () => {
    expect(events(JSON.stringify({ type: 'turn.completed' }))).toEqual([{ kind: 'turn_completed' }])
  })

  it('parses turn.failed with string error', async () => {
    expect(events(JSON.stringify({ type: 'turn.failed', error: 'boom' }))).toEqual([
      { kind: 'result_other', subtype: 'error', error: 'boom' },
    ])
  })

  it('parses turn.failed with object error { message }', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'turn.failed',
          error: { message: 'model not available for your tier', code: 'model_not_found' },
        }),
      ),
    ).toEqual([
      {
        kind: 'result_other',
        subtype: 'error',
        error: 'model not available for your tier',
      },
    ])
  })

  it('parses thread.error with string', async () => {
    expect(events(JSON.stringify({ type: 'thread.error', error: 'auth failed' }))).toEqual([
      { kind: 'error', message: 'auth failed' },
    ])
  })

  it('parses thread.error with object { message }', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'thread.error',
          error: { message: 'rate limit exceeded' },
        }),
      ),
    ).toEqual([{ kind: 'error', message: 'rate limit exceeded' }])
  })

  it('parses item.completed agent_message as assistant_text', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'item_1', type: 'agent_message', text: 'Hello' },
        }),
      ),
    ).toEqual([{ kind: 'assistant_text', text: 'Hello' }])
  })

  it('skips item.started/updated for agent_message (only completed has authoritative text)', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'item.started',
          item: { id: 'item_1', type: 'agent_message' },
        }),
      ),
    ).toEqual([])
    expect(
      events(
        JSON.stringify({
          type: 'item.updated',
          item: { id: 'item_1', type: 'agent_message', text: 'partial' },
        }),
      ),
    ).toEqual([])
  })

  it('parses command_execution item.started as tool_call started', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'item.started',
          item: {
            id: 'item_2',
            type: 'command_execution',
            command: 'ls -la',
            status: 'in_progress',
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'tool_call',
        toolName: 'shell',
        callId: 'item_2',
        input: { command: 'ls -la' },
        subtype: 'started',
      },
    ])
  })

  it('parses command_execution item.completed as tool_call completed', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'item_2',
            type: 'command_execution',
            command: 'ls -la',
            status: 'completed',
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'tool_call',
        toolName: 'shell',
        callId: 'item_2',
        input: { command: 'ls -la' },
        subtype: 'completed',
      },
    ])
  })

  it('parses command_execution failed status as tool_call failed with error', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'item_3',
            type: 'command_execution',
            command: 'false',
            status: 'failed',
            error: 'exit 1',
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'tool_call',
        toolName: 'shell',
        callId: 'item_3',
        input: { command: 'false' },
        subtype: 'failed',
        error: 'exit 1',
      },
    ])
  })

  it("carries a command's exit code as metadata, and nothing else from the item", async () => {
    // The exit code is what makes a failed tool span explainable; aggregated_output is content
    // and must not ride along in metadata, which is exported even with content capture off.
    const [event] = events(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_4',
          type: 'command_execution',
          command: 'grep -q needle haystack',
          aggregated_output: 'SECRET-LOOKING-OUTPUT',
          exit_code: 1,
          status: 'failed',
        },
      }),
    )
    expect(event).toMatchObject({
      kind: 'tool_call',
      subtype: 'failed',
      callId: 'item_4',
      metadata: { exit_code: 1 },
    })
    expect(JSON.stringify(event)).not.toContain('SECRET-LOOKING-OUTPUT')
  })

  it('reports exit code 0 on success and omits metadata when Codex sent no exit code', async () => {
    const completed = (item: Record<string, unknown>) =>
      events(JSON.stringify({ type: 'item.completed', item }))[0] as { metadata?: unknown }
    expect(
      completed({
        id: 'i',
        type: 'command_execution',
        command: 'true',
        exit_code: 0,
        status: 'completed',
      }).metadata,
    ).toEqual({ exit_code: 0 })
    expect(
      completed({ id: 'i', type: 'command_execution', command: 'true', status: 'completed' })
        .metadata,
    ).toBeUndefined()
  })

  it('parses mcp_tool_call item as tool_call with tool name', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'item.started',
          item: {
            id: 'item_4',
            type: 'mcp_tool_call',
            tool: 'search',
            arguments: { q: 'foo' },
          },
        }),
      ),
    ).toEqual([
      {
        kind: 'tool_call',
        toolName: 'search',
        callId: 'item_4',
        input: { tool: 'search', arguments: { q: 'foo' } },
        subtype: 'started',
      },
    ])
  })

  it('skips reasoning items (no observable effect)', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'r1', type: 'reasoning', text: 'thinking…' },
        }),
      ),
    ).toEqual([])
  })

  it('maps file_change / plan_update / web_search to generic tool_call', async () => {
    expect(
      events(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'f1', type: 'file_change' },
        }),
      ),
    ).toEqual([{ kind: 'tool_call', toolName: 'file_change', callId: 'f1', subtype: 'completed' }])
    expect(
      events(
        JSON.stringify({
          type: 'item.started',
          item: { id: 'p1', type: 'plan_update' },
        }),
      ),
    ).toEqual([{ kind: 'tool_call', toolName: 'plan_update', callId: 'p1', subtype: 'started' }])
  })

  it('emits unknown for unrecognized item types', async () => {
    const evs = events(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'x', type: 'exotic_future_type' },
      }),
    )
    expect(evs).toEqual([{ kind: 'unknown', msgType: 'item', subtype: 'exotic_future_type' }])
  })

  it('emits unknown for unrecognized top-level types', async () => {
    expect(events(JSON.stringify({ type: 'something.else' }))).toEqual([
      { kind: 'unknown', msgType: 'something.else', subtype: undefined },
    ])
  })
})

describe('parseCodexStreamLine — raw metadata', () => {
  it('exposes msgType for stat counting', async () => {
    const parsed = parseCodexStreamLine(
      JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 1 } }),
    )
    expect(parsed.msgType).toBe('turn.completed')
    expect(parsed.subtype).toBeUndefined()
  })

  it('exposes item.type as subtype for item.* lines', async () => {
    const parsed = parseCodexStreamLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'a1', type: 'agent_message', text: 'ok' },
      }),
    )
    expect(parsed.msgType).toBe('item.completed')
    expect(parsed.subtype).toBe('agent_message')
  })
})

describe('statKeyFor', () => {
  it('joins msgType + subtype when subtype given', async () => {
    expect(statKeyFor('item.completed', 'agent_message')).toBe('item.completed:agent_message')
  })
  it('returns msgType alone when no subtype', async () => {
    expect(statKeyFor('turn.completed')).toBe('turn.completed')
  })
})

describe('composeCodexAssistantOutput', () => {
  it('keeps legacy concatenation when cleanResult is disabled', async () => {
    expect(composeCodexAssistantOutput(['step 1', 'final answer'], false)).toBe(
      'step 1\nfinal answer',
    )
  })

  it('returns only the last assistant message when cleanResult is enabled', async () => {
    expect(
      composeCodexAssistantOutput(
        [
          '我会先查询 MCP。',
          '我已经查到中间结果，继续验证。',
          '最终结论：配置在 mall_info.id=49。',
        ],
        true,
      ),
    ).toBe('最终结论：配置在 mall_info.id=49。')
  })

  it('falls back to the last non-empty entry when codex emits a trailing whitespace frame', async () => {
    // codex occasionally pushes an empty/whitespace assistant_text frame at end-of-turn;
    // taking texts[len-1].trim() would clobber the real answer with ''.
    expect(
      composeCodexAssistantOutput(['思考中…', '最终结论：mall_info.id=49。', '\n  '], true),
    ).toBe('最终结论：mall_info.id=49。')
  })

  it('returns empty string when cleanResult is enabled and every entry is whitespace', async () => {
    expect(composeCodexAssistantOutput(['', '   ', '\n\t'], true)).toBe('')
  })
})
