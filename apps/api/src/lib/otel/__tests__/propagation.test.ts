import { TraceFlags } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'
import { formatTraceparent, normalizeTraceparent, parseTraceparent } from '../propagation.js'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN_ID = '00f067aa0ba902b7'

describe('parseTraceparent', () => {
  it('parses a valid W3C traceparent into a remote span context', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    })
  })

  it('tolerates surrounding whitespace and upper-case hex', () => {
    expect(parseTraceparent(`  00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-00 `)?.traceId).toBe(
      TRACE_ID,
    )
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['garbage', 'not-a-traceparent'],
    ['unknown version', `01-${TRACE_ID}-${SPAN_ID}-01`],
    ['short trace id', `00-${TRACE_ID.slice(1)}-${SPAN_ID}-01`],
    ['all-zero trace id', `00-${'0'.repeat(32)}-${SPAN_ID}-01`],
    ['all-zero span id', `00-${TRACE_ID}-${'0'.repeat(16)}-01`],
    ['trailing fields', `00-${TRACE_ID}-${SPAN_ID}-01-extra`],
  ])('rejects %s', (_label, raw) => {
    expect(parseTraceparent(raw)).toBeNull()
  })
})

describe('formatTraceparent', () => {
  it('round-trips with parseTraceparent', () => {
    const header = `00-${TRACE_ID}-${SPAN_ID}-01`
    const parsed = parseTraceparent(header)
    expect(parsed).not.toBeNull()
    if (parsed) expect(formatTraceparent(parsed)).toBe(header)
  })

  it('pads the flags byte', () => {
    expect(formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 0 })).toBe(
      `00-${TRACE_ID}-${SPAN_ID}-00`,
    )
  })
})

describe('normalizeTraceparent', () => {
  it('returns the canonical header for a valid inbound value', () => {
    expect(normalizeTraceparent(` 00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01 `)).toBe(
      `00-${TRACE_ID}-${SPAN_ID}-01`,
    )
  })

  it('returns undefined for a missing or malformed value', () => {
    expect(normalizeTraceparent(undefined)).toBeUndefined()
    expect(normalizeTraceparent('garbage')).toBeUndefined()
  })
})
