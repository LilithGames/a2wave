import { SpanStatusCode } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerTaskPayload } from '../../../worker/types.js'
import type { OtelRuntime } from '../provider.js'

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

let runtime: (OtelRuntime & { acquired: number; released: number }) | null = null
vi.mock('../provider.js', () => ({ getOtelRuntime: () => runtime }))

import { parseTraceparent } from '../propagation.js'
import { startRunTrace } from '../run-tracer.js'

const exporter = new InMemorySpanExporter()

function makeRuntime(captureContent: boolean) {
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  const state = {
    tracer: provider.getTracer('test'),
    captureContent,
    acquired: 0,
    released: 0,
    acquire: () => {
      state.acquired++
    },
    release: () => {
      state.released++
    },
    forceFlush: async () => {},
  }
  return state
}

const PROMPT = 'PROMPT-TEXT summarize the quarterly numbers'
const OUTPUT = 'OUTPUT-TEXT here is the summary'
const TOOL_INPUT = { command: 'TOOL-INPUT cat secrets.txt' }
const TOOL_ERROR = 'TOOL-ERROR permission denied'
const RUN_ERROR = 'RUN-ERROR provider exploded'
const PARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

function payload(overrides: Partial<WorkerTaskPayload> = {}): WorkerTaskPayload {
  return {
    taskId: 'chat/run_1/rst_1',
    prompt: PROMPT,
    model: 'model-a',
    agentConfig: {
      agentId: 'agt_1',
      agentName: 'Reporter',
      engineType: 'claude-code',
      providerApiKey: 'provider-key-123456',
    },
    context: { channel: { channel_type: 'api', user_info: { email: 'pii@example.com' } } },
    ...overrides,
  } as WorkerTaskPayload
}

const attempt = (n: number, extra: Record<string, unknown> = {}) => ({
  attempt: n,
  providerIndex: 0,
  model: 'model-a',
  engineType: 'claude-code',
  resetChat: false,
  ...extra,
})

const ok = { success: true, output: OUTPUT, durationMs: 10, chatId: 'sess-1' }
const failed = { success: false, output: '', durationMs: 10, error: RUN_ERROR }

const spans = () => exporter.getFinishedSpans()
const byName = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix))
const root = (): ReadableSpan => byName('invoke_agent')[0]

beforeEach(() => {
  exporter.reset()
  runtime = makeRuntime(false)
})

describe('disabled', () => {
  it('returns an inert trace and creates no spans', () => {
    runtime = null
    const trace = startRunTrace('t', payload())
    expect(trace.enabled).toBe(false)
    const at = trace.startAttempt(attempt(1))
    expect(at.traceparent()).toBeUndefined()
    trace.onLogEntry({ type: 'assistant', text: 'x', ts: 1 })
    at.end(ok)
    trace.finish({ result: ok, retries: 0 })
    expect(spans()).toHaveLength(0)
  })
})

describe('span hierarchy', () => {
  it('emits invoke_agent → attempt → execute_tool with GenAI attributes', () => {
    const trace = startRunTrace('chat/run_1/rst_1', payload(), { runId: 'run_1' })
    const at = trace.startAttempt(
      attempt(1, { binding: { providerId: 'prv_1', providerName: 'Main' } }),
    )
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'started',
      callId: 'c1',
      toolName: 'Bash',
      ts: 1000,
    })
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'completed',
      callId: 'c1',
      toolName: 'Bash',
      ts: 1500,
    })
    at.end({ ...ok, usage: { inputTokens: 5 } })
    trace.finish({ result: { ...ok, usage: { inputTokens: 5, outputTokens: 7 } }, retries: 0 })

    const rootSpan = root()
    const attemptSpan = byName('attempt')[0]
    const toolSpan = byName('execute_tool')[0]
    expect(rootSpan.name).toBe('invoke_agent Reporter')
    expect(attemptSpan.parentSpanContext?.spanId).toBe(rootSpan.spanContext().spanId)
    expect(toolSpan.name).toBe('execute_tool Bash')
    expect(toolSpan.parentSpanContext?.spanId).toBe(attemptSpan.spanContext().spanId)

    expect(rootSpan.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'claude-code',
      'gen_ai.agent.id': 'agt_1',
      'gen_ai.agent.name': 'Reporter',
      'gen_ai.request.model': 'model-a',
      'gen_ai.conversation.id': 'sess-1',
      'gen_ai.usage.input_tokens': 5,
      'gen_ai.usage.output_tokens': 7,
      'a2wave.run.id': 'run_1',
      'a2wave.task.id': 'chat/run_1/rst_1',
      'a2wave.trigger.source': 'api',
      'a2wave.attempt.count': 1,
      'a2wave.retry.count': 0,
      'a2wave.run.outcome': 'success',
    })
    expect(rootSpan.status.code).toBe(SpanStatusCode.OK)
    expect(attemptSpan.attributes).toMatchObject({
      'a2wave.attempt.number': 1,
      'a2wave.provider.id': 'prv_1',
      'a2wave.provider.name': 'Main',
      'gen_ai.usage.input_tokens': 5,
    })
    expect(toolSpan.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'Bash',
      'gen_ai.tool.call.id': 'c1',
    })
    expect(toolSpan.status.code).toBe(SpanStatusCode.OK)
  })

  it('uses the tool event timestamps for the span interval', () => {
    const trace = startRunTrace('t', payload())
    const at = trace.startAttempt(attempt(1))
    const start = Date.now()
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'started',
      callId: 'c1',
      toolName: 'Bash',
      ts: start,
    })
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'completed',
      callId: 'c1',
      toolName: 'Bash',
      ts: start + 2500,
    })
    at.end(ok)
    trace.finish({ result: ok, retries: 0 })
    const [seconds, nanos] = byName('execute_tool')[0].duration
    expect(seconds * 1000 + nanos / 1e6).toBeCloseTo(2500, 0)
  })

  it('joins the caller trace when the payload carries a traceparent', () => {
    const trace = startRunTrace('t', payload({ traceParent: PARENT }))
    trace.finish({ result: ok, retries: 0 })
    expect(root().spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(root().parentSpanContext?.spanId).toBe('00f067aa0ba902b7')
  })

  it('starts a fresh trace when the traceparent is malformed', () => {
    const trace = startRunTrace('t', payload({ traceParent: 'garbage' }))
    trace.finish({ result: ok, retries: 0 })
    expect(root().parentSpanContext).toBeUndefined()
  })

  it('exposes the attempt span as the traceparent to propagate', () => {
    const trace = startRunTrace('t', payload())
    const at = trace.startAttempt(attempt(1))
    const propagated = parseTraceparent(at.traceparent())
    at.end(ok)
    trace.finish({ result: ok, retries: 0 })
    expect(propagated?.spanId).toBe(byName('attempt')[0].spanContext().spanId)
    expect(propagated?.traceId).toBe(root().spanContext().traceId)
  })

  it('falls back to the agent id, then "unknown", for the span name', () => {
    const noName = payload()
    noName.agentConfig = { ...noName.agentConfig, agentName: undefined }
    startRunTrace('t', noName).finish({ result: ok, retries: 0 })
    expect(root().name).toBe('invoke_agent agt_1')
  })

  it('holds the runtime for the lifetime of the run', () => {
    const trace = startRunTrace('t', payload())
    expect(runtime?.acquired).toBe(1)
    trace.finish({ result: ok, retries: 0 })
    trace.finish({ result: ok, retries: 0 })
    expect(runtime?.released).toBe(1)
    expect(byName('invoke_agent')).toHaveLength(1)
  })
})

describe('attempts, retries and fallback', () => {
  it('records one attempt span per attempt and events on the root', () => {
    const trace = startRunTrace('t', payload())
    const first = trace.startAttempt(attempt(1))
    first.end(failed)
    trace.onLogEntry({ type: 'retry', attempt: 1, nextAttemptIn: 2000, ts: 1 })
    trace.onLogEntry({
      type: 'system',
      subtype: 'provider_fallback',
      providerName: 'Main',
      nextProviderName: 'Backup',
      ts: 2,
    })
    const second = trace.startAttempt(
      attempt(1, { providerIndex: 1, model: 'model-b', resetChat: true }),
    )
    second.end(ok)
    trace.finish({ result: ok, retries: 1 })

    const attempts = byName('attempt')
    expect(attempts).toHaveLength(2)
    expect(attempts[0].status.code).toBe(SpanStatusCode.ERROR)
    expect(attempts[0].attributes['error.type']).toBe('_OTHER')
    expect(attempts[1].attributes).toMatchObject({
      'a2wave.provider.index': 1,
      'a2wave.chat.reset': true,
      'gen_ai.request.model': 'model-b',
    })
    expect(root().attributes).toMatchObject({
      'a2wave.attempt.count': 2,
      'a2wave.retry.count': 1,
      'gen_ai.request.model': 'model-b',
    })
    expect(root().events.map((e) => e.name)).toEqual(['retry', 'provider_fallback'])
    expect(root().events[0].attributes).toEqual({ attempt: 1, backoff_ms: 2000 })
    expect(root().events[1].attributes).toEqual({ from: 'Main', to: 'Backup' })
  })

  it('records a2a task lifecycle events with primitive metadata only', () => {
    const trace = startRunTrace('t', payload())
    trace.onLogEntry({
      type: 'system',
      subtype: 'a2a.task.state',
      metadata: { taskId: 'task-1', state: 'working', nested: { drop: 'me' } },
      ts: 5,
    })
    trace.onLogEntry({ type: 'system', subtype: 'init', ts: 6 })
    trace.finish({ result: ok, retries: 0 })
    expect(root().events).toHaveLength(1)
    expect(root().events[0].name).toBe('a2a.task.state')
    expect(root().events[0].attributes).toEqual({ taskId: 'task-1', state: 'working' })
  })
})

describe('outcome and status', () => {
  it('marks a failed run ERROR with a classified error.type', () => {
    const trace = startRunTrace('t', payload(), {
      classifiers: { isHardQuota: (e) => e === RUN_ERROR },
    })
    trace.startAttempt(attempt(1)).end(failed)
    trace.finish({ result: failed, retries: 0 })
    expect(root().status.code).toBe(SpanStatusCode.ERROR)
    expect(root().attributes).toMatchObject({
      'error.type': 'quota',
      'a2wave.run.outcome': 'failed',
    })
  })

  it('reports a timeout outcome', () => {
    const trace = startRunTrace('t', payload())
    const timedOut = { ...failed, error: 'Execution timeout after 15 minutes' }
    trace.finish({ result: timedOut, retries: 0 })
    expect(root().attributes).toMatchObject({
      'error.type': 'timeout',
      'a2wave.run.outcome': 'timeout',
    })
  })

  it('leaves a cancelled run UNSET — a user stop is not an error', () => {
    const trace = startRunTrace('t', payload())
    trace.finish({ result: failed, retries: 0, cancelled: true })
    expect(root().status.code).toBe(SpanStatusCode.UNSET)
    expect(root().attributes['a2wave.run.outcome']).toBe('cancelled')
    expect(root().attributes['error.type']).toBeUndefined()
  })

  it('marks a thrown execution ERROR with the exception name', () => {
    const trace = startRunTrace('t', payload())
    trace.finish({ thrown: new TypeError(RUN_ERROR), retries: 0 })
    expect(root().status.code).toBe(SpanStatusCode.ERROR)
    expect(root().attributes).toMatchObject({
      'error.type': 'TypeError',
      'a2wave.run.outcome': 'failed',
    })
  })

  it('omits usage attributes when the provider reported none', () => {
    const trace = startRunTrace('t', payload())
    trace.finish({ result: ok, retries: 0 })
    expect(Object.keys(root().attributes).filter((k) => k.includes('usage'))).toEqual([])
  })
})

describe('tool pairing', () => {
  function run(entries: Parameters<ReturnType<typeof startRunTrace>['onLogEntry']>[0][]) {
    const trace = startRunTrace('t', payload())
    const at = trace.startAttempt(attempt(1))
    for (const entry of entries) trace.onLogEntry(entry)
    at.end(ok)
    trace.finish({ result: ok, retries: 0 })
    return byName('execute_tool')
  }

  it('marks a failed tool ERROR', () => {
    const [tool] = run([
      { type: 'tool_call', subtype: 'started', callId: 'c1', toolName: 'Bash', ts: 1 },
      {
        type: 'tool_call',
        subtype: 'failed',
        callId: 'c1',
        toolName: 'Bash',
        error: TOOL_ERROR,
        ts: 2,
      },
    ])
    expect(tool.status.code).toBe(SpanStatusCode.ERROR)
    expect(tool.attributes['error.type']).toBe('tool_error')
  })

  it('pairs empty call ids FIFO per tool name', () => {
    const tools = run([
      { type: 'tool_call', subtype: 'started', callId: '', toolName: 'Read', ts: 100 },
      { type: 'tool_call', subtype: 'started', callId: '', toolName: 'Read', ts: 200 },
      { type: 'tool_call', subtype: 'completed', callId: '', toolName: 'Read', ts: 300 },
      { type: 'tool_call', subtype: 'completed', callId: '', toolName: 'Read', ts: 400 },
    ])
    expect(tools).toHaveLength(2)
    expect(tools.every((t) => t.attributes['gen_ai.tool.call.id'] === undefined)).toBe(true)
    expect(tools.every((t) => t.attributes['a2wave.tool.incomplete'] === undefined)).toBe(true)
  })

  it('ignores a duplicate start for the same call id', () => {
    expect(
      run([
        { type: 'tool_call', subtype: 'started', callId: 'c1', toolName: 'Bash', ts: 1 },
        { type: 'tool_call', subtype: 'started', callId: 'c1', toolName: 'Bash', ts: 2 },
        { type: 'tool_call', subtype: 'completed', callId: 'c1', toolName: 'Bash', ts: 3 },
      ]),
    ).toHaveLength(1)
  })

  it('turns a terminal event without a start into a zero-length unpaired span', () => {
    const [tool] = run([
      { type: 'tool_call', subtype: 'completed', callId: 'c9', toolName: 'webfetch', ts: 50 },
    ])
    expect(tool.attributes['a2wave.tool.unpaired']).toBe(true)
    expect(tool.duration).toEqual([0, 0])
  })

  it('closes tools still open at attempt end as incomplete', () => {
    const [tool] = run([
      { type: 'tool_call', subtype: 'started', callId: 'c1', toolName: 'Bash', ts: 1 },
    ])
    expect(tool.attributes['a2wave.tool.incomplete']).toBe(true)
    expect(tool.status.code).toBe(SpanStatusCode.UNSET)
  })

  it('names a tool without a name "unknown" and clamps a backwards end time', () => {
    const [tool] = run([
      { type: 'tool_call', subtype: 'started', callId: 'c1', toolName: '', ts: 500 },
      { type: 'tool_call', subtype: 'completed', callId: 'c1', toolName: '', ts: 100 },
    ])
    expect(tool.name).toBe('execute_tool unknown')
    expect(tool.duration).toEqual([0, 0])
  })

  it('drops tool events that arrive outside an attempt', () => {
    const trace = startRunTrace('t', payload())
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'started',
      callId: 'c1',
      toolName: 'Bash',
      ts: 1,
    })
    const at = trace.startAttempt(attempt(1))
    at.end(ok)
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'completed',
      callId: 'c1',
      toolName: 'Bash',
      ts: 2,
    })
    trace.finish({ result: ok, retries: 0 })
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'started',
      callId: 'c2',
      toolName: 'Bash',
      ts: 3,
    })
    expect(byName('execute_tool')).toHaveLength(0)
  })

  it('caps the number of simultaneously open tool spans', () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({
      type: 'tool_call' as const,
      subtype: 'started' as const,
      callId: `c${i}`,
      toolName: 'Bash',
      ts: i,
    }))
    expect(run(entries)).toHaveLength(256)
  })
})

describe('content capture', () => {
  function fullRun() {
    const trace = startRunTrace('t', payload())
    const at = trace.startAttempt(attempt(1))
    trace.onLogEntry({ type: 'assistant', text: OUTPUT, ts: 1 })
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'started',
      callId: 'c1',
      toolName: 'Bash',
      input: TOOL_INPUT,
      ts: 2,
    })
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'failed',
      callId: 'c1',
      toolName: 'Bash',
      error: TOOL_ERROR,
      ts: 3,
    })
    trace.onLogEntry({ type: 'error', message: RUN_ERROR, ts: 4 })
    at.end(failed)
    const second = trace.startAttempt(attempt(2))
    second.end(ok)
    trace.finish({ result: ok, retries: 1 })
  }

  it('off: no prompt, output, tool input, error text or channel PII leaves the process', () => {
    fullRun()
    const dump = JSON.stringify(
      spans().map((s) => ({ n: s.name, a: s.attributes, e: s.events, s: s.status })),
    )
    for (const needle of [
      'PROMPT-TEXT',
      'OUTPUT-TEXT',
      'TOOL-INPUT',
      'TOOL-ERROR',
      'RUN-ERROR',
      'pii@example.com',
      'provider-key',
    ]) {
      expect(dump).not.toContain(needle)
    }
  })

  it('on: captures messages, tool arguments and error text, masked', () => {
    runtime = makeRuntime(true)
    const trace = startRunTrace('t', payload({ prompt: `${PROMPT} provider-key-123456` }))
    const at = trace.startAttempt(attempt(1))
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'started',
      callId: 'c1',
      toolName: 'Bash',
      input: TOOL_INPUT,
      ts: 2,
    })
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'failed',
      callId: 'c1',
      toolName: 'Bash',
      error: TOOL_ERROR,
      ts: 3,
    })
    at.end(failed)
    trace.finish({ result: failed, retries: 0 })

    const input = JSON.parse(String(root().attributes['gen_ai.input.messages']))
    expect(input).toEqual([
      { role: 'user', parts: [{ type: 'text', content: `${PROMPT} [REDACTED]` }] },
    ])
    expect(root().status.message).toBe(RUN_ERROR)
    const tool = byName('execute_tool')[0]
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBe(JSON.stringify(TOOL_INPUT))
    expect(tool.status.message).toBe(TOOL_ERROR)
  })

  it('on: captures the output message of a successful run', () => {
    runtime = makeRuntime(true)
    const trace = startRunTrace('t', payload())
    trace.finish({ result: ok, retries: 0 })
    expect(JSON.parse(String(root().attributes['gen_ai.output.messages']))).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: OUTPUT }], finish_reason: 'stop' },
    ])
  })
})

describe('OpenInference mirror', () => {
  // Phoenix / Arize / Langfuse read these keys for their input, output and kind columns; they
  // translate gen_ai.* into llm.* themselves but never derive input.value / output.value.
  it('tags every span with an OpenInference kind, with or without content capture', () => {
    const trace = startRunTrace('t', payload())
    const at = trace.startAttempt(attempt(1))
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'started',
      callId: 'c1',
      toolName: 'Bash',
      ts: 1,
    })
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'completed',
      callId: 'c1',
      toolName: 'Bash',
      ts: 2,
    })
    at.end(ok)
    trace.finish({ result: ok, retries: 0 })
    expect(root().attributes['openinference.span.kind']).toBe('AGENT')
    // LLM, not CHAIN: the attempt is where model and token usage are measured, and OpenInference
    // backends total tokens and cost over LLM spans only (AGENT spans are not double-counted).
    expect(byName('attempt')[0].attributes['openinference.span.kind']).toBe('LLM')
    expect(byName('execute_tool')[0].attributes['openinference.span.kind']).toBe('TOOL')
  })

  it('uses the run id as the session: stable across turns and known before execution', () => {
    // Not the provider session id: that one changes on provider fallback and, for a new
    // conversation, only exists after the run — too late to hand to a downstream Agent.
    startRunTrace('t', payload(), { runId: 'run_1' }).finish({ result: ok, retries: 0 })
    expect(root().attributes['session.id']).toBe('run_1')
  })

  it('inherits the caller session so an Agent-to-Agent trace stays one session', () => {
    startRunTrace('t', payload({ traceParent: PARENT, traceSession: 'run_caller' }), {
      runId: 'run_child',
    }).finish({ result: ok, retries: 0 })
    expect(root().attributes['session.id']).toBe('run_caller')
  })

  it('exposes the session as W3C baggage for the downstream hop', () => {
    const trace = startRunTrace('t', payload(), { runId: 'run_1' })
    expect(trace.baggage()).toBe('session.id=run_1')
    trace.finish({ result: ok, retries: 0 })
    runtime = null
    expect(startRunTrace('t', payload(), { runId: 'run_1' }).baggage()).toBeUndefined()
  })

  it('omits the session when there is no run row (evaluation, memory)', () => {
    startRunTrace('t', payload()).finish({ result: ok, retries: 0 })
    expect(root().attributes['session.id']).toBeUndefined()
  })

  it('on: mirrors the prompt, the reply and tool arguments as plain values, masked', () => {
    runtime = makeRuntime(true)
    const trace = startRunTrace('t', payload({ prompt: `${PROMPT} provider-key-123456` }))
    const at = trace.startAttempt(attempt(1))
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'started',
      callId: 'c1',
      toolName: 'Bash',
      input: TOOL_INPUT,
      ts: 1,
    })
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'completed',
      callId: 'c1',
      toolName: 'Bash',
      ts: 2,
    })
    at.end(ok)
    trace.finish({ result: ok, retries: 0 })

    expect(root().attributes).toMatchObject({
      'input.value': `${PROMPT} [REDACTED]`,
      'input.mime_type': 'text/plain',
      'output.value': OUTPUT,
      'output.mime_type': 'text/plain',
    })
    expect(byName('execute_tool')[0].attributes).toMatchObject({
      'input.value': JSON.stringify(TOOL_INPUT),
      'input.mime_type': 'application/json',
    })
  })

  it('off: writes no input or output value at all', () => {
    const trace = startRunTrace('t', payload())
    const at = trace.startAttempt(attempt(1))
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'started',
      callId: 'c1',
      toolName: 'Bash',
      input: TOOL_INPUT,
      ts: 1,
    })
    at.end(ok)
    trace.finish({ result: ok, retries: 0 })
    for (const span of spans()) {
      expect(Object.keys(span.attributes).filter((k) => /^(input|output)\./.test(k))).toEqual([])
    }
  })
})

describe('fail-open', () => {
  it('never throws into the run path when the tracer blows up', () => {
    const broken = makeRuntime(false)
    broken.tracer = {
      startSpan: () => {
        throw new Error('sdk exploded')
      },
    } as never
    runtime = broken
    const trace = startRunTrace('t', payload())
    expect(trace.enabled).toBe(false)
    expect(() => {
      const at = trace.startAttempt(attempt(1))
      trace.onLogEntry({ type: 'tool_call', subtype: 'started', callId: 'c', toolName: 'x', ts: 1 })
      at.end(ok)
      trace.finish({ result: ok, retries: 0 })
    }).not.toThrow()
    expect(broken.released).toBe(broken.acquired)
  })

  it('survives a span that throws mid-run', () => {
    const trace = startRunTrace('t', payload())
    const at = trace.startAttempt(attempt(1))
    expect(() =>
      trace.onLogEntry({
        type: 'tool_call',
        subtype: 'started',
        callId: 'c',
        toolName: 'x',
        ts: Number.NaN,
      }),
    ).not.toThrow()
    at.end(ok)
    expect(() => trace.finish({ result: ok, retries: 0 })).not.toThrow()
  })
})

describe('trace enrichment', () => {
  const startedTool = (callId: string, ts: number) =>
    ({
      type: 'tool_call',
      subtype: 'started',
      callId,
      toolName: 'shell',
      input: TOOL_INPUT,
      ts,
    }) as const

  it('puts the session id on every span, so a run shows up in a Sessions view while it runs', () => {
    // The root span is exported last. With the id on the root only, a backend had no session for
    // the trace until the run ended — minutes for a long review.
    const trace = startRunTrace('chat/run_1/rst_1', payload(), { runId: 'run_1' })
    const at = trace.startAttempt(attempt(1))
    trace.onLogEntry(startedTool('c1', 1000))
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'completed',
      callId: 'c1',
      toolName: 'shell',
      ts: 1200,
    })
    at.end(ok)
    trace.finish({ result: ok, retries: 0 })

    for (const span of [root(), byName('attempt')[0], byName('execute_tool')[0]]) {
      expect(span.attributes['session.id']).toBe('run_1')
    }
  })

  it('mirrors the prompt and the reply onto the attempt span only when content capture is on', () => {
    runtime = makeRuntime(true)
    const trace = startRunTrace('chat/run_1/rst_1', payload(), { runId: 'run_1' })
    trace.startAttempt(attempt(1)).end(ok)
    trace.finish({ result: ok, retries: 0 })
    const captured = byName('attempt')[0]
    expect(captured.attributes['input.value']).toBe(PROMPT)
    expect(captured.attributes['output.value']).toBe(OUTPUT)

    exporter.reset()
    runtime = makeRuntime(false)
    const quiet = startRunTrace('chat/run_1/rst_1', payload(), { runId: 'run_1' })
    quiet.startAttempt(attempt(1)).end(ok)
    quiet.finish({ result: ok, retries: 0 })
    expect(byName('attempt')[0].attributes['input.value']).toBeUndefined()
    expect(byName('attempt')[0].attributes['output.value']).toBeUndefined()
  })

  it('exports a pseudonymous user id and never the email, name or mobile next to it', () => {
    const withUser = (channel: Record<string, unknown>) => {
      exporter.reset()
      const trace = startRunTrace('t', payload({ context: { channel } } as never), { runId: 'r' })
      trace.finish({ result: ok, retries: 0 })
      return root().attributes
    }
    const pii = { email: 'pii@example.com', name: 'Real Name', mobile: '13800000000' }

    // The a2wave user who triggered it wins: it is the id the platform's own audit trail uses.
    expect(
      withUser({
        channel_type: 'debug',
        channel_info: { triggered_by_user_id: 'usr_7' },
        user_info: { ...pii, source_id: 'ou_feishu' },
      })['user.id'],
    ).toBe('usr_7')
    // Otherwise the identity provider's opaque subject.
    expect(
      withUser({ channel_type: 'feishu', user_info: { ...pii, source_id: 'ou_feishu' } })[
        'user.id'
      ],
    ).toBe('ou_feishu')
    // No stable id: nothing is exported, and an email is never promoted into one.
    const none = withUser({ channel_type: 'api', user_info: pii })
    expect(none['user.id']).toBeUndefined()
    expect(JSON.stringify(none)).not.toContain('pii@example.com')
    expect(JSON.stringify(none)).not.toContain('Real Name')
    expect(JSON.stringify(none)).not.toContain('13800000000')
  })

  it("records a failed tool's exit code even with content capture off", () => {
    // "ERROR" with no reason is useless for debugging an Agent. The exit code is not content.
    const trace = startRunTrace('chat/run_1/rst_1', payload(), { runId: 'run_1' })
    const at = trace.startAttempt(attempt(1))
    trace.onLogEntry(startedTool('c1', 1000))
    trace.onLogEntry({
      type: 'tool_call',
      subtype: 'failed',
      callId: 'c1',
      toolName: 'shell',
      error: TOOL_ERROR,
      metadata: { exit_code: 2, stderr: 'must-not-leak' },
      ts: 1300,
    })
    at.end(ok)
    trace.finish({ result: ok, retries: 0 })

    const tool = byName('execute_tool')[0]
    expect(tool.attributes['a2wave.tool.exit_code']).toBe(2)
    expect(tool.status).toEqual({ code: SpanStatusCode.ERROR, message: 'exit code 2' })
    expect(JSON.stringify(tool.attributes)).not.toContain('must-not-leak')
    expect(JSON.stringify(tool.attributes)).not.toContain(TOOL_ERROR)
  })

  it('exports tool output only with content capture on, masked against injected credentials', () => {
    const run = (capture: boolean) => {
      exporter.reset()
      runtime = makeRuntime(capture)
      const trace = startRunTrace('chat/run_1/rst_1', payload(), { runId: 'run_1' })
      const at = trace.startAttempt(attempt(1))
      trace.onLogEntry(startedTool('c1', 1000))
      trace.onLogEntry({
        type: 'tool_call',
        subtype: 'completed',
        callId: 'c1',
        toolName: 'shell',
        output: 'TOOL-OUTPUT ANTHROPIC_API_KEY=provider-key-123456 done',
        ts: 1200,
      })
      at.end(ok)
      trace.finish({ result: ok, retries: 0 })
      return byName('execute_tool')[0].attributes
    }

    const captured = run(true)
    expect(captured['output.value']).toContain('TOOL-OUTPUT')
    expect(captured['output.mime_type']).toBe('text/plain')
    expect(captured['gen_ai.tool.call.result']).toBe(captured['output.value'])
    // The Agent's own provider key must not leave in a tool's output.
    expect(JSON.stringify(captured)).not.toContain('provider-key-123456')

    const quiet = run(false)
    expect(quiet['output.value']).toBeUndefined()
    expect(quiet['gen_ai.tool.call.result']).toBeUndefined()
    expect(JSON.stringify(quiet)).not.toContain('TOOL-OUTPUT')
  })

  it('describes the Agent environment on the root span', () => {
    const trace = startRunTrace(
      'chat/run_1/rst_1',
      payload({
        agentConfig: {
          agentId: 'agt_1',
          agentName: 'Reporter',
          engineType: 'claude-code',
          workspaceType: 'scm',
          resolvedSkills: [
            { name: 'security-best-practices', content: 'SKILL-BODY' },
            { name: 'tdd', content: null },
          ],
          resolvedMcpServers: [{ name: 'lark-cli' }],
        },
      } as never),
      { runId: 'run_1' },
    )
    trace.startAttempt(attempt(1)).end(failed)
    trace.startAttempt(attempt(2, { providerIndex: 1 })).end(ok)
    trace.finish({ result: ok, retries: 1 })

    const attrs = root().attributes
    expect(attrs['a2wave.workspace.type']).toBe('scm')
    expect(attrs['a2wave.agent.skills']).toEqual(['security-best-practices', 'tdd'])
    expect(attrs['a2wave.agent.mcp_servers']).toEqual(['lark-cli'])
    expect(attrs['a2wave.provider.fallback']).toBe(true)
    expect(JSON.stringify(attrs)).not.toContain('SKILL-BODY')
  })

  it('does not claim a provider fallback when every attempt used the primary provider', () => {
    const trace = startRunTrace('chat/run_1/rst_1', payload(), { runId: 'run_1' })
    trace.startAttempt(attempt(1)).end(ok)
    trace.finish({ result: ok, retries: 0 })
    expect(root().attributes['a2wave.provider.fallback']).toBe(false)
  })
})
