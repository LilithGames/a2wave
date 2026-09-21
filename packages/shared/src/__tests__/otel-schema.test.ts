import { describe, expect, it } from 'vitest'
import {
  isLoopbackOtelEndpoint,
  normalizeOtelEndpoint,
  OTEL_KEEP_HEADER_VALUE,
  otelHeadersSchema,
  parseOtelResourceAttributes,
  resolveOtelTracesUrl,
  SETTINGS_DEFAULTS,
} from '../index.js'

describe('SETTINGS_DEFAULTS.otel', () => {
  it('ships disabled with content capture off', () => {
    expect(SETTINGS_DEFAULTS.otel).toEqual({
      enabled: 'false',
      endpoint: '',
      headersEnc: '',
      captureContent: 'false',
      serviceName: '',
      resourceAttributes: '',
    })
  })
})

describe('normalizeOtelEndpoint', () => {
  it('returns an empty string as-is (unconfigured)', () => {
    expect(normalizeOtelEndpoint('  ')).toBe('')
  })

  it('accepts http(s) collectors, including loopback and private addresses', () => {
    expect(normalizeOtelEndpoint('http://localhost:4318')).toBe('http://localhost:4318')
    expect(normalizeOtelEndpoint(' http://10.0.0.8:4318/ ')).toBe('http://10.0.0.8:4318')
    expect(normalizeOtelEndpoint('https://OTLP.example.com/otlp/')).toBe(
      'https://otlp.example.com/otlp',
    )
  })

  it('keeps an explicit signal path', () => {
    expect(normalizeOtelEndpoint('https://apm.example.com/adapt_x/api/otlp/traces')).toBe(
      'https://apm.example.com/adapt_x/api/otlp/traces',
    )
  })

  it('rejects non-http schemes, credentials, query and fragment', () => {
    expect(normalizeOtelEndpoint('grpc://collector:4317')).toBeNull()
    expect(normalizeOtelEndpoint('not a url')).toBeNull()
    expect(normalizeOtelEndpoint('https://user:pw@collector:4318')).toBeNull()
    expect(normalizeOtelEndpoint('https://collector:4318?token=x')).toBeNull()
    expect(normalizeOtelEndpoint('https://collector:4318#frag')).toBeNull()
  })
})

describe('resolveOtelTracesUrl', () => {
  it('appends /v1/traces to a base URL', () => {
    expect(resolveOtelTracesUrl('http://localhost:4318')).toBe('http://localhost:4318/v1/traces')
    expect(resolveOtelTracesUrl('https://otlp.example.com/otlp')).toBe(
      'https://otlp.example.com/otlp/v1/traces',
    )
  })

  it('leaves a URL that already names the traces signal untouched', () => {
    expect(resolveOtelTracesUrl('http://localhost:4318/v1/traces')).toBe(
      'http://localhost:4318/v1/traces',
    )
    expect(resolveOtelTracesUrl('https://apm.example.com/api/otlp/traces')).toBe(
      'https://apm.example.com/api/otlp/traces',
    )
  })
})

describe('otelHeadersSchema', () => {
  it('accepts token-named headers with non-empty values', () => {
    const parsed = otelHeadersSchema.safeParse({ Authorization: 'Bearer abc', 'x-scope': 'a2wave' })
    expect(parsed.success).toBe(true)
  })

  it('rejects invalid names, empty values and oversized maps', () => {
    expect(otelHeadersSchema.safeParse({ 'bad name': 'v' }).success).toBe(false)
    expect(otelHeadersSchema.safeParse({ 'x-a': '' }).success).toBe(false)
    expect(otelHeadersSchema.safeParse({ 'x-a': 'line\nbreak' }).success).toBe(false)
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x-h${i}`, 'v']))
    expect(otelHeadersSchema.safeParse(many).success).toBe(false)
    expect(otelHeadersSchema.safeParse({ 'x-a': 'v'.repeat(4097) }).success).toBe(false)
  })
})

describe('parseOtelResourceAttributes', () => {
  it('parses the OTEL_RESOURCE_ATTRIBUTES format', () => {
    expect(
      parseOtelResourceAttributes(
        ' openinference.project.name=a2wave , deployment.environment=prod ',
      ),
    ).toEqual({ 'openinference.project.name': 'a2wave', 'deployment.environment': 'prod' })
  })

  it('treats an empty string as no attributes', () => {
    expect(parseOtelResourceAttributes('  ')).toEqual({})
  })

  it('keeps "=" inside a value', () => {
    expect(parseOtelResourceAttributes('team=a=b')).toEqual({ team: 'a=b' })
  })

  it('rejects malformed pairs, bad keys, empty or oversized values', () => {
    for (const raw of ['novalue', 'k=', '=v', 'bad key=v', `k=${'v'.repeat(257)}`, 'a=1,a=2']) {
      expect(parseOtelResourceAttributes(raw)).toBeNull()
    }
    const many = Array.from({ length: 21 }, (_, i) => `k${i}=v`).join(',')
    expect(parseOtelResourceAttributes(many)).toBeNull()
  })

  it('refuses the attributes a2wave manages itself', () => {
    for (const key of ['service.name', 'service.version', 'service.instance.id']) {
      expect(parseOtelResourceAttributes(`${key}=x`)).toBeNull()
    }
  })
})

describe('isLoopbackOtelEndpoint', () => {
  it.each([
    'http://127.0.0.1:6006',
    'http://127.8.9.1:4318/v1/traces',
    'http://localhost:4318',
    'http://LOCALHOST:4318',
    'http://[::1]:4318',
  ])('treats %s as loopback', (endpoint) => {
    expect(isLoopbackOtelEndpoint(endpoint)).toBe(true)
  })

  it.each([
    'http://host.docker.internal:6006',
    'http://otel-collector:4318',
    'http://10.0.0.5:4318',
    'https://127.example.com',
    'not a url',
    '',
  ])('does not treat %s as loopback', (endpoint) => {
    expect(isLoopbackOtelEndpoint(endpoint)).toBe(false)
  })
})

describe('OTEL_KEEP_HEADER_VALUE', () => {
  it('is a legal header value, so a keep-marker map passes the same schema as real headers', () => {
    expect(otelHeadersSchema.safeParse({ Authorization: OTEL_KEEP_HEADER_VALUE }).success).toBe(
      true,
    )
  })
})
