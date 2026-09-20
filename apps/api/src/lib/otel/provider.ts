/**
 * Private OpenTelemetry tracer runtime for Agent run traces.
 *
 * The provider is never registered globally and no context manager is installed: parent/child
 * relations are passed explicitly, so this cannot interfere with (or be hijacked by) any other
 * OpenTelemetry user in the process. Telemetry is export-only — spans live in an in-memory batch
 * queue and are dropped with a warning when the collector is unreachable.
 */
import type { OtelTestResult } from '@a2wave/shared'
import type { Tracer } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { logger } from '../logger.js'
import { processInstanceId } from '../process-instance.js'
import { getVersion } from '../version.js'
import { type OtelConfig, otelConfigFingerprint, readOtelConfig } from './config.js'

const TRACER_NAME = 'a2wave.agent-run'
/** Well under the 10 s graceful-shutdown hard budget (lib/graceful-shutdown.ts). */
const EXPORT_TIMEOUT_MS = 5000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000
const DEFAULT_TEST_TIMEOUT_MS = 6000
const WARN_INTERVAL_MS = 60_000
const ERROR_MESSAGE_MAX_LENGTH = 200
const EXPORT_SUCCESS = 0

type ExportResultCallback = Parameters<SpanExporter['export']>[1]
type OtlpExporterConfig = NonNullable<ConstructorParameters<typeof OTLPTraceExporter>[0]>
/** The enum lives in otlp-exporter-base, which is not a direct dependency; its value is 'gzip'. */
const GZIP = 'gzip' as OtlpExporterConfig['compression']

export interface OtelRuntime {
  readonly tracer: Tracer
  readonly captureContent: boolean
  /** A run holds the runtime from start to finish so a settings change cannot cut it off. */
  acquire(): void
  release(): void
  forceFlush(): Promise<void>
}

interface ExportStats {
  lastExportAt: string | null
  lastError: string | null
  droppedSpans: number
}

export interface OtelExportStats extends ExportStats {
  active: boolean
}

const emptyStats = (): ExportStats => ({ lastExportAt: null, lastError: null, droppedSpans: 0 })

/** Records the verdict of every export; the SDK itself only reports failures to a global hook. */
class TrackingExporter implements SpanExporter {
  private lastWarnAt = 0

  constructor(
    private readonly inner: SpanExporter,
    private readonly stats: ExportStats,
    private readonly warn: boolean,
  ) {}

  export(spans: ReadableSpan[], resultCallback: ExportResultCallback): void {
    this.inner.export(spans, (result) => {
      if (result.code === EXPORT_SUCCESS) {
        this.stats.lastExportAt = new Date().toISOString()
        this.stats.lastError = null
      } else {
        this.stats.droppedSpans += spans.length
        this.stats.lastError = (result.error?.message || 'export failed').slice(
          0,
          ERROR_MESSAGE_MAX_LENGTH,
        )
        this.warnRateLimited(spans.length)
      }
      resultCallback(result)
    })
  }

  private warnRateLimited(dropped: number): void {
    const now = Date.now()
    if (!this.warn || now - this.lastWarnAt < WARN_INTERVAL_MS) return
    this.lastWarnAt = now
    logger.warn(
      { error: this.stats.lastError, dropped, droppedTotal: this.stats.droppedSpans },
      'otel: trace export failed — spans dropped',
    )
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }

  async forceFlush(): Promise<void> {
    await this.inner.forceFlush?.()
  }
}

function createExporter(config: OtelConfig, stats: ExportStats, warn: boolean): SpanExporter {
  // url + headers are always explicit so OTEL_EXPORTER_OTLP_* in the API's own environment can
  // never redirect or re-authenticate the export behind the admin's back.
  const otlp = new OTLPTraceExporter({
    url: config.tracesUrl,
    headers: { ...config.headers },
    compression: GZIP,
    timeoutMillis: EXPORT_TIMEOUT_MS,
  })
  return new TrackingExporter(otlp, stats, warn)
}

function createProvider(config: OtelConfig, processor: SpanProcessor): BasicTracerProvider {
  return new BasicTracerProvider({
    resource: resourceFromAttributes({
      ...config.resourceAttributes,
      'service.name': config.serviceName,
      'service.version': getVersion(),
      'service.instance.id': processInstanceId,
    }),
    sampler: new AlwaysOnSampler(),
    spanProcessors: [processor],
  })
}

class Runtime implements OtelRuntime {
  readonly tracer: Tracer
  readonly captureContent: boolean
  readonly stats = emptyStats()
  private readonly provider: BasicTracerProvider
  private activeRuns = 0
  private retired = false
  private shutdownPromise: Promise<void> | null = null

  constructor(config: OtelConfig) {
    this.captureContent = config.captureContent
    this.provider = createProvider(
      config,
      new BatchSpanProcessor(createExporter(config, this.stats, true), {
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
      }),
    )
    this.tracer = this.provider.getTracer(TRACER_NAME)
  }

  acquire(): void {
    this.activeRuns++
  }

  release(): void {
    this.activeRuns = Math.max(0, this.activeRuns - 1)
    if (this.retired && this.activeRuns === 0) void this.shutdown()
  }

  /** The processor rejects when an export fails; the verdict is already in `stats`. */
  forceFlush(): Promise<void> {
    return this.provider.forceFlush().catch(() => {})
  }

  /** Superseded by a settings change: shut down once the last in-flight run lets go. */
  retire(): void {
    this.retired = true
    if (this.activeRuns === 0) void this.shutdown()
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.provider
      .shutdown()
      .catch((err) =>
        logger.warn({ err: (err as Error).message }, 'otel: provider shutdown failed'),
      )
      .finally(() => liveRuntimes.delete(this))
    return this.shutdownPromise
  }
}

const liveRuntimes = new Set<Runtime>()
let current: { fingerprint: string; runtime: Runtime | null } | null = null

/**
 * The runtime for the current `otel` settings, or null when export is off. Built lazily and keyed
 * by the settings fingerprint, so it self-heals after boot, a PATCH, or the env bridge without any
 * caller having to remember to rebuild it. Never throws.
 */
export function getOtelRuntime(): OtelRuntime | null {
  try {
    const fingerprint = otelConfigFingerprint()
    if (current?.fingerprint === fingerprint) return current.runtime
    current?.runtime?.retire()
    const config = readOtelConfig()
    const runtime = config ? new Runtime(config) : null
    if (runtime) liveRuntimes.add(runtime)
    current = { fingerprint, runtime }
    return runtime
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'otel: failed to build the tracer runtime')
    return null
  }
}

export function getOtelExportStats(): OtelExportStats {
  const runtime = current?.runtime
  return runtime ? { active: true, ...runtime.stats } : { active: false, ...emptyStats() }
}

function withTimeout(work: Promise<unknown>, timeoutMs: number): Promise<'done' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  return Promise.race([work.then(() => 'done' as const), timeout]).finally(() =>
    clearTimeout(timer),
  )
}

/** Graceful-shutdown hook: flush what is queued, bounded, never rejects. */
export async function shutdownOtel(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
  const runtimes = [...liveRuntimes]
  current = null
  if (runtimes.length === 0) return
  const outcome = await withTimeout(Promise.all(runtimes.map((r) => r.shutdown())), timeoutMs)
  if (outcome === 'timeout') logger.warn('otel: shutdown flush timed out — queued spans dropped')
}

/** "Test connection": one span through a throwaway exporter, verdict instead of an exception. */
export async function sendOtelTestSpan(
  config: OtelConfig | null,
  timeoutMs = DEFAULT_TEST_TIMEOUT_MS,
): Promise<OtelTestResult> {
  if (!config) return { ok: false, reason: 'OTEL_NOT_CONFIGURED' }
  const stats = emptyStats()
  const provider = createProvider(
    config,
    new SimpleSpanProcessor(createExporter(config, stats, false)),
  )
  try {
    provider.getTracer(TRACER_NAME).startSpan('a2wave.otel.test').end()
    // forceFlush rejects on a failed export; the tracked verdict is the single source of truth.
    const outcome = await withTimeout(
      provider.forceFlush().catch(() => {}),
      timeoutMs,
    )
    if (outcome === 'timeout') return { ok: false, reason: 'TIMEOUT' }
    if (stats.lastExportAt) return { ok: true }
    return { ok: false, reason: 'EXPORT_FAILED', error: stats.lastError ?? 'export failed' }
  } catch (err) {
    return {
      ok: false,
      reason: 'EXPORT_FAILED',
      error: (err as Error).message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
    }
  } finally {
    void provider.shutdown().catch(() => {})
  }
}

export async function resetOtelForTests(): Promise<void> {
  await shutdownOtel(100)
  liveRuntimes.clear()
}
