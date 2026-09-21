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

const SESSION_BAGGAGE_KEY = 'session.id'
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

export interface InboundTraceContext {
  traceParent?: string
  traceSession?: string
}

function readSessionFromBaggage(baggage: string | null | undefined): string | undefined {
  for (const member of (baggage ?? '').split(',')) {
    // `key=value;property=…` — properties are irrelevant here.
    const [pair] = member.split(';')
    const separator = pair.indexOf('=')
    if (separator <= 0 || pair.slice(0, separator).trim() !== SESSION_BAGGAGE_KEY) continue
    try {
      const value = decodeURIComponent(pair.slice(separator + 1).trim())
      return SESSION_ID_RE.test(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Trace context of an inbound invocation: the W3C `traceparent`, plus the caller's session id
 * carried as W3C `baggage` (`session.id=…`) so an Agent-to-Agent trace is one session in the
 * tracing backend. The session is only honoured inside a valid trace. Malformed values are
 * dropped, never rejected. `getHeader` is optional because some A2A contexts carry no request.
 */
export function readInboundTraceContext(
  getHeader: ((name: string) => string | undefined) | undefined,
): InboundTraceContext {
  const traceParent = normalizeTraceparent(getHeader?.('traceparent'))
  if (!traceParent) return {}
  const traceSession = readSessionFromBaggage(getHeader?.('baggage'))
  return traceSession ? { traceParent, traceSession } : { traceParent }
}

export function formatSessionBaggage(sessionId: string): string {
  return `${SESSION_BAGGAGE_KEY}=${encodeURIComponent(sessionId)}`
}
