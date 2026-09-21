import { describe, expect, it } from 'vitest'
import {
  capToolOutput,
  stripToolOutput,
  TOOL_OUTPUT_MAX_CHARS,
  toolResultText,
} from '../tool-output.js'
import type { StreamLogEntry } from '../types.js'

describe('toolResultText', () => {
  it('reads a plain string', () => {
    expect(toolResultText('total 0')).toBe('total 0')
  })

  it('joins the text blocks of a Claude-style content array and ignores the rest', () => {
    expect(
      toolResultText([
        { type: 'text', text: 'line 1' },
        { type: 'image', source: { data: 'BASE64' } },
        null,
        { type: 'text', text: 'line 2' },
      ]),
    ).toBe('line 1\nline 2')
  })

  it('returns undefined for nothing usable, never an empty string', () => {
    expect(toolResultText('')).toBeUndefined()
    expect(toolResultText([])).toBeUndefined()
    expect(toolResultText([{ type: 'image' }])).toBeUndefined()
    expect(toolResultText(undefined)).toBeUndefined()
    expect(toolResultText(42)).toBeUndefined()
  })
})

describe('capToolOutput', () => {
  it('leaves short output alone and bounds long output at the source', () => {
    expect(capToolOutput('ok')).toBe('ok')
    const capped = capToolOutput('x'.repeat(TOOL_OUTPUT_MAX_CHARS + 500))
    expect(capped.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS + 32)
    expect(capped.startsWith('x'.repeat(100))).toBe(true)
    expect(capped).toMatch(/truncated/)
  })
})

describe('stripToolOutput', () => {
  const entry: StreamLogEntry = {
    type: 'tool_call',
    subtype: 'completed',
    callId: 'c1',
    toolName: 'shell',
    output: 'TOOL-OUTPUT',
    metadata: { exit_code: 0 },
    ts: 1,
  }

  it('drops only the output, so persisted logs and UI streams never carry it', () => {
    const stripped = stripToolOutput(entry)
    expect(stripped).toEqual({
      type: 'tool_call',
      subtype: 'completed',
      callId: 'c1',
      toolName: 'shell',
      metadata: { exit_code: 0 },
      ts: 1,
    })
    expect(JSON.stringify(stripped)).not.toContain('TOOL-OUTPUT')
    // The original is untouched: the tracer still receives it.
    expect(entry.output).toBe('TOOL-OUTPUT')
  })

  it('returns entries without output, and non-tool entries, as they are', () => {
    const plain: StreamLogEntry = { type: 'assistant', text: 'hi', ts: 1 }
    expect(stripToolOutput(plain)).toBe(plain)
    const noOutput: StreamLogEntry = {
      type: 'tool_call',
      subtype: 'started',
      callId: 'c1',
      toolName: 'shell',
      ts: 1,
    }
    expect(stripToolOutput(noOutput)).toBe(noOutput)
  })
})
