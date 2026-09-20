import type { OtelStatus } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import { buildOtelPatch, EMPTY_OTEL_FORM, otelFormFromStatus } from '../otel-config-form'

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
  it('prefills the non-secret fields and leaves the header editor empty', () => {
    expect(otelFormFromStatus(status)).toEqual({
      enabled: true,
      endpoint: 'http://localhost:4318',
      serviceName: 'agents',
      resourceAttributes: 'openinference.project.name=a2wave',
      captureContent: true,
      headers: [],
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
        { name: ' Authorization ', value: 'Bearer abc' },
        { name: '', value: '' },
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
      [{ name: 'Authorization', value: '' }],
      [{ name: '', value: 'Bearer abc' }],
      [{ name: 'bad name', value: 'v' }],
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
          { name: 'x-a', value: '1' },
          { name: 'X-A', value: '2' },
        ],
      }),
    ).toEqual({ ok: false, error: 'settings.otel.errors.headersInvalid' })
  })
})
