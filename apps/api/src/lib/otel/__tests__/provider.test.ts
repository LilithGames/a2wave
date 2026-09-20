import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OtelConfig } from '../config.js'

let config: OtelConfig | null = null
let fingerprint = 'fp-0'
vi.mock('../config.js', () => ({
  readOtelConfig: () => config,
  otelConfigFingerprint: () => fingerprint,
}))

vi.mock('../../version.js', () => ({ getVersion: () => '9.9.9' }))
vi.mock('../../process-instance.js', () => ({ processInstanceId: 'instance-1' }))

const mockWarn = vi.fn()
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

type ExportCallback = (result: { code: number; error?: Error }) => void
interface FakeExporter {
  options: Record<string, unknown>
  exported: unknown[][]
  shutdown: ReturnType<typeof vi.fn>
}
const exporters: FakeExporter[] = []
let nextExportResult: { code: number; error?: Error } = { code: 0 }
let exportHangs = false
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: class {
    exported: unknown[][] = []
    shutdown = vi.fn(async () => {})
    constructor(public options: Record<string, unknown>) {
      exporters.push(this as unknown as FakeExporter)
    }
    export(spans: unknown[], cb: ExportCallback) {
      this.exported.push(spans)
      if (!exportHangs) cb(nextExportResult)
    }
    async forceFlush() {}
  },
}))

import {
  getOtelExportStats,
  getOtelRuntime,
  resetOtelForTests,
  sendOtelTestSpan,
  shutdownOtel,
} from '../provider.js'

const enabled: OtelConfig = {
  endpoint: 'http://collector:4318',
  tracesUrl: 'http://collector:4318/v1/traces',
  headers: { Authorization: 'Bearer t' },
  captureContent: true,
  serviceName: 'a2wave',
}

beforeEach(async () => {
  await resetOtelForTests()
  exporters.length = 0
  config = null
  fingerprint = 'fp-0'
  nextExportResult = { code: 0 }
  exportHangs = false
  mockWarn.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getOtelRuntime', () => {
  it('returns null and builds nothing when export is disabled', () => {
    expect(getOtelRuntime()).toBeNull()
    expect(exporters).toHaveLength(0)
  })

  it('builds the exporter from settings only, with explicit url and headers', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://from-env:4318'
    try {
      config = enabled
      const runtime = getOtelRuntime()
      expect(runtime?.captureContent).toBe(true)
      expect(exporters).toHaveLength(1)
      expect(exporters[0].options).toMatchObject({
        url: 'http://collector:4318/v1/traces',
        headers: { Authorization: 'Bearer t' },
        compression: 'gzip',
      })
    } finally {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    }
  })

  it('reuses the runtime while the settings fingerprint is unchanged', () => {
    config = enabled
    expect(getOtelRuntime()).toBe(getOtelRuntime())
    expect(exporters).toHaveLength(1)
  })

  it('rebuilds on a settings change and shuts the idle old runtime down', async () => {
    config = enabled
    const first = getOtelRuntime()
    fingerprint = 'fp-1'
    config = { ...enabled, captureContent: false }
    const second = getOtelRuntime()
    expect(second).not.toBe(first)
    expect(second?.captureContent).toBe(false)
    await vi.waitFor(() => expect(exporters[0].shutdown).toHaveBeenCalled())
  })

  it('keeps a retired runtime alive until its in-flight runs release it', async () => {
    config = enabled
    const first = getOtelRuntime()
    first?.acquire()
    fingerprint = 'fp-1'
    getOtelRuntime()
    await Promise.resolve()
    expect(exporters[0].shutdown).not.toHaveBeenCalled()
    first?.release()
    await vi.waitFor(() => expect(exporters[0].shutdown).toHaveBeenCalled())
  })

  it('tears the runtime down when export gets disabled', async () => {
    config = enabled
    getOtelRuntime()
    fingerprint = 'fp-off'
    config = null
    expect(getOtelRuntime()).toBeNull()
    await vi.waitFor(() => expect(exporters[0].shutdown).toHaveBeenCalled())
  })
})

describe('export tracking', () => {
  it('records a successful export', async () => {
    config = enabled
    const runtime = getOtelRuntime()
    runtime?.tracer.startSpan('s').end()
    await runtime?.forceFlush()
    const stats = getOtelExportStats()
    expect(stats.active).toBe(true)
    expect(stats.lastExportAt).not.toBeNull()
    expect(stats.lastError).toBeNull()
    expect(stats.droppedSpans).toBe(0)
  })

  it('counts dropped spans and warns (rate-limited) on a failed export', async () => {
    config = enabled
    nextExportResult = { code: 1, error: new Error('Unauthorized') }
    const runtime = getOtelRuntime()
    runtime?.tracer.startSpan('a').end()
    await runtime?.forceFlush()
    runtime?.tracer.startSpan('b').end()
    await runtime?.forceFlush()
    const stats = getOtelExportStats()
    expect(stats.droppedSpans).toBe(2)
    expect(stats.lastError).toBe('Unauthorized')
    expect(mockWarn).toHaveBeenCalledTimes(1)
  })

  it('reports inactive when there is no runtime', () => {
    expect(getOtelExportStats()).toEqual({
      active: false,
      lastExportAt: null,
      lastError: null,
      droppedSpans: 0,
    })
  })
})

describe('shutdownOtel', () => {
  it('flushes and shuts the exporter down', async () => {
    config = enabled
    getOtelRuntime()
    await shutdownOtel()
    expect(exporters[0].shutdown).toHaveBeenCalled()
    expect(getOtelExportStats().active).toBe(false)
  })

  it('gives up after the timeout instead of hanging shutdown', async () => {
    vi.useFakeTimers()
    config = enabled
    exportHangs = true
    const runtime = getOtelRuntime()
    runtime?.tracer.startSpan('stuck').end()
    const done = shutdownOtel(2000)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(done).resolves.toBeUndefined()
  })

  it('is a no-op without a runtime', async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined()
  })
})

describe('sendOtelTestSpan', () => {
  it('reports OTEL_NOT_CONFIGURED without a usable config', async () => {
    expect(await sendOtelTestSpan(null)).toEqual({ ok: false, reason: 'OTEL_NOT_CONFIGURED' })
  })

  it('exports one span through a throwaway exporter', async () => {
    expect(await sendOtelTestSpan(enabled)).toEqual({ ok: true })
    expect(exporters).toHaveLength(1)
    expect(exporters[0].exported).toHaveLength(1)
    expect(exporters[0].shutdown).toHaveBeenCalled()
  })

  it('reports EXPORT_FAILED with the exporter error', async () => {
    nextExportResult = { code: 1, error: new Error('connect ECONNREFUSED') }
    expect(await sendOtelTestSpan(enabled)).toEqual({
      ok: false,
      reason: 'EXPORT_FAILED',
      error: 'connect ECONNREFUSED',
    })
  })

  it('reports TIMEOUT when the collector never answers', async () => {
    vi.useFakeTimers()
    exportHangs = true
    const pending = sendOtelTestSpan(enabled, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toEqual({ ok: false, reason: 'TIMEOUT' })
  })
})
