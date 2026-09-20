import type { SpanContext } from '@opentelemetry/api'

/**
 * W3C Trace Context `traceparent` parsing/formatting.
 *
 * Hand-rolled on purpose: the tracer provider is private (never registered globally), so there is
 * no global propagator to lean on, and the agent-router MCP subprocess forwards the raw header
 * without taking an OpenTelemetry dependency.
 */
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const ZERO_RE = /^0+$/

/** Returns null for anything that is not a well-formed version-00 traceparent. */
export function parseTraceparent(raw: string | null | undefined): SpanContext | null {
  if (!raw) return null
  const match = TRACEPARENT_RE.exec(raw.trim().toLowerCase())
  if (!match) return null
  const [, traceId, spanId, flags] = match
  if (ZERO_RE.test(traceId) || ZERO_RE.test(spanId)) return null
  return { traceId, spanId, traceFlags: Number.parseInt(flags, 16), isRemote: true }
}

export function formatTraceparent(
  spanContext: Pick<SpanContext, 'traceId' | 'spanId' | 'traceFlags'>,
): string {
  const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0')
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`
}

/**
 * Validates an inbound `traceparent` header for persistence in `runs.executionMetadata`.
 * Anything malformed is dropped rather than rejected: a bad tracing header must never fail an
 * otherwise valid invocation.
 */
export function normalizeTraceparent(raw: string | null | undefined): string | undefined {
  const parsed = parseTraceparent(raw)
  return parsed ? formatTraceparent(parsed) : undefined
}
