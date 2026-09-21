import { SpanStatusCode } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OtelConfig } from '../config.js'
import type { OtelRuntime } from '../provider.js'

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type Emit = (runtime: OtelRuntime) => string | undefined
const mockProbe = vi.fn(async (_config: OtelConfig, _emit: Emit, _timeoutMs?: number) => ({
  ok: true,
}))
vi.mock('../provider.js', () => ({
  getOtelRuntime: () => null,
  exportOtelProbe: (config: OtelConfig, emit: Emit, timeoutMs?: number) =>
    mockProbe(config, emit, timeoutMs),
}))

import { emitOtelTestTrace, sendOtelTestSpan } from '../test-trace.js'

const config: OtelConfig = {
  endpoint: 'http://collector:4318',
  tracesUrl: 'http://collector:4318/v1/traces',
  headers: {},
  captureContent: false,
  serviceName: 'a2wave',
  resourceAttributes: {},
}

const exporter = new InMemorySpanExporter()
function makeRuntime(): OtelRuntime {
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  return {
    tracer: provider.getTracer('test'),
    captureContent: true,
    acquire: () => {},
    release: () => {},
    forceFlush: async () => {},
  }
}

beforeEach(() => {
  exporter.reset()
  mockProbe.mockClear()
})

describe('sendOtelTestSpan', () => {
  it('reports OTEL_NOT_CONFIGURED without a usable config', async () => {
    expect(await sendOtelTestSpan(null)).toEqual({ ok: false, reason: 'OTEL_NOT_CONFIGURED' })
    expect(mockProbe).not.toHaveBeenCalled()
  })

  it('probes the config with the synthetic test trace', async () => {
    expect(await sendOtelTestSpan(config, 1234)).toEqual({ ok: true })
    expect(mockProbe).toHaveBeenCalledWith(config, emitOtelTestTrace, 1234)
  })
})

describe('emitOtelTestTrace', () => {
  it('emits an Agent run root with one LLM child, in the real span conventions', () => {
    const traceId = emitOtelTestTrace(makeRuntime())
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(2)
    const root = spans.find((span) => span.name === 'invoke_agent a2wave connection test')
    const child = spans.find((span) => span.name === 'attempt')
    expect(root).toBeDefined()
    expect(child).toBeDefined()

    expect(traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(root?.spanContext().traceId).toBe(traceId)
    expect(child?.spanContext().traceId).toBe(traceId)
    expect(root?.parentSpanContext).toBeUndefined()
    expect(child?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId)

    expect(root?.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'a2wave connection test',
      'openinference.span.kind': 'AGENT',
      'input.value': 'ping',
      'output.value': 'pong',
      'gen_ai.usage.input_tokens': 1,
      'gen_ai.usage.output_tokens': 1,
      'a2wave.run.outcome': 'success',
    })
    expect(root?.attributes['gen_ai.input.messages']).toContain('ping')
    expect(root?.attributes['gen_ai.output.messages']).toContain('pong')
    expect(root?.attributes['session.id']).toBeTruthy()
    expect(child?.attributes).toMatchObject({
      'openinference.span.kind': 'LLM',
      'gen_ai.request.model': 'a2wave-connection-test',
      'gen_ai.usage.input_tokens': 1,
      'gen_ai.usage.output_tokens': 1,
    })
    expect(root?.status.code).toBe(SpanStatusCode.OK)
    expect(child?.status.code).toBe(SpanStatusCode.OK)
  })

  it('uses a fresh trace on every call', () => {
    const runtime = makeRuntime()
    expect(emitOtelTestTrace(runtime)).not.toBe(emitOtelTestTrace(runtime))
  })
})
