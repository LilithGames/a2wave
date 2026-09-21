import { OTEL_KEEP_HEADER_VALUE, type OtelStatus } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import {
  buildOtelPatch,
  buildOtelTestDraft,
  EMPTY_OTEL_FORM,
  markOtelHeadersSaved,
  otelFormFromStatus,
} from '../otel-config-form'

const status: OtelStatus = {
  enabled: true,
  endpoint: 'http://localhost:4318',
  tracesUrl: 'http://localhost:4318/v1/traces',
  serviceName: 'agents',
  resourceAttributes: 'openinference.project.name=a2wave',
  captureContent: true,
  headersSet: true,
  headerNames: ['Authorization'],
  active: true,
  lastExportAt: null,
  lastError: null,
  droppedSpans: 0,
  scope: 'this-instance',
}

describe('otelFormFromStatus', () => {
  it('prefills the non-secret fields and lists saved headers as value-less rows', () => {
    expect(otelFormFromStatus(status)).toEqual({
      enabled: true,
      endpoint: 'http://localhost:4318',
      serviceName: 'agents',
      resourceAttributes: 'openinference.project.name=a2wave',
      captureContent: true,
      headers: [{ name: 'Authorization', value: '', saved: true }],
    })
  })
})

describe('buildOtelPatch', () => {
  it('stringifies switches and normalizes the endpoint', () => {
    const result = buildOtelPatch({
      ...EMPTY_OTEL_FORM,
      enabled: true,
      endpoint: ' http://localhost:4318/ ',
      serviceName: ' agents ',
    })
    expect(result).toEqual({
      ok: true,
      value: {
        enabled: 'true',
        endpoint: 'http://localhost:4318',
        serviceName: 'agents',
        resourceAttributes: '',
        captureContent: 'false',
      },
    })
  })

  it('omits headers when the editor is empty, so the stored secret is kept', () => {
    const result = buildOtelPatch({ ...EMPTY_OTEL_FORM, endpoint: 'http://c:4318' })
    expect(result.ok && 'headers' in result.value).toBe(false)
  })

  it('submits edited headers as a JSON map, ignoring blank rows', () => {
    const result = buildOtelPatch({
      ...EMPTY_OTEL_FORM,
      endpoint: 'http://c:4318',
      headers: [
        { name: ' Authorization ', value: 'Bearer abc', saved: false },
        { name: '', value: '', saved: false },
      ],
    })
    expect(result.ok && result.value.headers).toBe('{"Authorization":"Bearer abc"}')
  })

  it('rejects an invalid endpoint', () => {
    expect(buildOtelPatch({ ...EMPTY_OTEL_FORM, endpoint: 'grpc://c:4317' })).toEqual({
      ok: false,
      error: 'settings.otel.errors.endpointInvalid',
    })
  })

  it('submits resource attributes and rejects a malformed list', () => {
    const form = { ...EMPTY_OTEL_FORM, endpoint: 'http://c:4318' }
    const ok = buildOtelPatch({ ...form, resourceAttributes: ' deployment.environment=prod ' })
    expect(ok.ok && ok.value.resourceAttributes).toBe('deployment.environment=prod')
    expect(buildOtelPatch({ ...form, resourceAttributes: 'service.name=x' })).toEqual({
      ok: false,
      error: 'settings.otel.errors.resourceAttributesInvalid',
    })
  })

  it('requires an endpoint to enable export', () => {
    expect(buildOtelPatch({ ...EMPTY_OTEL_FORM, enabled: true })).toEqual({
      ok: false,
      error: 'settings.otel.errors.endpointRequired',
    })
  })

  it('rejects a half-filled or invalid header row', () => {
    for (const headers of [
      [{ name: 'Authorization', value: '', saved: false }],
      [{ name: '', value: 'Bearer abc', saved: false }],
      [{ name: 'bad name', value: 'v', saved: false }],
    ]) {
      expect(buildOtelPatch({ ...EMPTY_OTEL_FORM, endpoint: 'http://c:4318', headers })).toEqual({
        ok: false,
        error: 'settings.otel.errors.headersInvalid',
      })
    }
  })

  it('rejects duplicate header names', () => {
    expect(
      buildOtelPatch({
        ...EMPTY_OTEL_FORM,
        endpoint: 'http://c:4318',
        headers: [
          { name: 'x-a', value: '1', saved: false },
          { name: 'X-A', value: '2', saved: false },
        ],
      }),
    ).toEqual({ ok: false, error: 'settings.otel.errors.headersInvalid' })
  })

  describe('saved headers', () => {
    const saved = ['Authorization', 'x-tenant']
    const form = {
      ...EMPTY_OTEL_FORM,
      endpoint: 'http://c:4318',
      headers: saved.map((name) => ({ name, value: '', saved: true })),
    }
    const headersOf = (result: ReturnType<typeof buildOtelPatch>) =>
      result.ok && result.value.headers !== undefined ? JSON.parse(result.value.headers) : undefined

    it('omits headers when the rows are exactly the saved set with nothing typed', () => {
      const result = buildOtelPatch(form, saved)
      expect(result.ok && 'headers' in result.value).toBe(false)
    })

    it('merges a newly typed header with keep markers for the saved ones', () => {
      const result = buildOtelPatch(
        { ...form, headers: [...form.headers, { name: 'x-api-key', value: 'k1', saved: false }] },
        saved,
      )
      expect(headersOf(result)).toEqual({
        Authorization: OTEL_KEEP_HEADER_VALUE,
        'x-tenant': OTEL_KEEP_HEADER_VALUE,
        'x-api-key': 'k1',
      })
    })

    it('sends a retyped saved value as typed', () => {
      const headers = [{ ...form.headers[0], value: 'Bearer new' }, form.headers[1]]
      expect(headersOf(buildOtelPatch({ ...form, headers }, saved))).toEqual({
        Authorization: 'Bearer new',
        'x-tenant': OTEL_KEEP_HEADER_VALUE,
      })
    })

    it('omits a removed saved header from the map', () => {
      const result = buildOtelPatch({ ...form, headers: [form.headers[1]] }, saved)
      expect(headersOf(result)).toEqual({ 'x-tenant': OTEL_KEEP_HEADER_VALUE })
    })

    it('clears everything when all saved rows were removed', () => {
      const result = buildOtelPatch({ ...form, headers: [] }, saved)
      expect(result.ok && result.value.headers).toBe('')
    })

    it('rejects a new row that has a name but no value', () => {
      const headers = [...form.headers, { name: 'x-api-key', value: '', saved: false }]
      expect(buildOtelPatch({ ...form, headers }, saved)).toEqual({
        ok: false,
        error: 'settings.otel.errors.headersInvalid',
      })
    })
  })
})

describe('buildOtelTestDraft', () => {
  it('carries the draft fields a save would send, minus the switches', () => {
    const result = buildOtelTestDraft(
      {
        ...EMPTY_OTEL_FORM,
        enabled: true,
        endpoint: ' http://c:4318/ ',
        serviceName: 'agents',
        headers: [
          { name: 'Authorization', value: '', saved: true },
          { name: 'x-api-key', value: 'k1', saved: false },
        ],
      },
      ['Authorization'],
    )
    expect(result).toEqual({
      ok: true,
      value: {
        endpoint: 'http://c:4318',
        serviceName: 'agents',
        resourceAttributes: '',
        headers: JSON.stringify({ Authorization: OTEL_KEEP_HEADER_VALUE, 'x-api-key': 'k1' }),
      },
    })
  })

  it('omits headers when they are unchanged, so the server uses the saved ones', () => {
    const result = buildOtelTestDraft(
      {
        ...EMPTY_OTEL_FORM,
        endpoint: 'http://c:4318',
        headers: [{ name: 'Authorization', value: '', saved: true }],
      },
      ['Authorization'],
    )
    expect(result.ok && 'headers' in result.value).toBe(false)
  })

  it('does not require an endpoint just because export is enabled', () => {
    expect(buildOtelTestDraft({ ...EMPTY_OTEL_FORM, enabled: true }, []).ok).toBe(true)
  })

  it('reports the same validation errors as a save', () => {
    expect(buildOtelTestDraft({ ...EMPTY_OTEL_FORM, endpoint: 'grpc://c:4317' }, [])).toEqual({
      ok: false,
      error: 'settings.otel.errors.endpointInvalid',
    })
  })
})

describe('markOtelHeadersSaved', () => {
  it('turns the submitted rows into the saved set and forgets typed values', () => {
    expect(
      markOtelHeadersSaved([
        { name: 'Authorization', value: '', saved: true },
        { name: ' x-api-key ', value: 'k1', saved: false },
        { name: '', value: '', saved: false },
      ]),
    ).toEqual([
      { name: 'Authorization', value: '', saved: true },
      { name: 'x-api-key', value: '', saved: true },
    ])
  })
})
