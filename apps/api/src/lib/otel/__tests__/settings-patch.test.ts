import { describe, expect, it, vi } from 'vitest'

vi.mock('../../secret-box.js', () => ({ encryptSecret: (plain: string) => `enc(${plain})` }))

import { encryptOtelHeaders, prepareOtelSettingsPatch } from '../settings-patch.js'

const current = {
  enabled: 'false',
  endpoint: '',
  headersEnc: '',
  captureContent: 'false',
  serviceName: '',
}

describe('prepareOtelSettingsPatch', () => {
  it('encrypts the plaintext headers pseudo-key and never stores it', () => {
    const result = prepareOtelSettingsPatch({ headers: '{"Authorization":"Bearer abc"}' }, current)
    expect(result).toEqual({
      ok: true,
      patch: { headersEnc: 'enc({"Authorization":"Bearer abc"})' },
    })
  })

  it('clears the stored headers on an empty string', () => {
    expect(prepareOtelSettingsPatch({ headers: ' ' }, current)).toEqual({
      ok: true,
      patch: { headersEnc: '' },
    })
  })

  it('leaves the stored headers alone when the pseudo-key is absent', () => {
    const result = prepareOtelSettingsPatch({ captureContent: 'true' }, current)
    expect(result).toEqual({ ok: true, patch: { captureContent: 'true' } })
  })

  it('rejects malformed or invalid header maps', () => {
    for (const headers of ['not json', '[]', '{"bad name":"v"}', '{"x-a":""}']) {
      expect(prepareOtelSettingsPatch({ headers }, current)).toMatchObject({
        ok: false,
        error: 'INVALID_OTEL_HEADERS',
      })
    }
  })

  it('refuses a client-supplied ciphertext key', () => {
    expect(prepareOtelSettingsPatch({ headersEnc: 'forged' }, current)).toMatchObject({
      ok: false,
      error: 'INVALID_OTEL_HEADERS',
    })
  })

  it('normalizes the endpoint', () => {
    expect(prepareOtelSettingsPatch({ endpoint: ' http://10.0.0.8:4318/ ' }, current)).toEqual({
      ok: true,
      patch: { endpoint: 'http://10.0.0.8:4318' },
    })
  })

  it('rejects an invalid endpoint', () => {
    expect(prepareOtelSettingsPatch({ endpoint: 'grpc://c:4317' }, current)).toMatchObject({
      ok: false,
      error: 'INVALID_OTEL_ENDPOINT',
    })
  })

  it('blocks cloud metadata endpoints but allows loopback and private collectors', () => {
    for (const endpoint of ['http://169.254.169.254', 'http://metadata.google.internal/x']) {
      expect(prepareOtelSettingsPatch({ endpoint }, current)).toMatchObject({
        ok: false,
        error: 'OTEL_ENDPOINT_BLOCKED',
      })
    }
    expect(prepareOtelSettingsPatch({ endpoint: 'http://localhost:4318' }, current).ok).toBe(true)
  })

  it('requires an endpoint to enable export — from the patch or already stored', () => {
    expect(prepareOtelSettingsPatch({ enabled: 'true' }, current)).toMatchObject({
      ok: false,
      error: 'OTEL_ENDPOINT_REQUIRED',
    })
    expect(
      prepareOtelSettingsPatch({ enabled: 'true' }, { ...current, endpoint: 'http://c:4318' }).ok,
    ).toBe(true)
    expect(
      prepareOtelSettingsPatch({ enabled: 'true', endpoint: 'http://c:4318' }, current).ok,
    ).toBe(true)
  })

  it('refuses to clear the endpoint while export stays enabled', () => {
    expect(
      prepareOtelSettingsPatch(
        { endpoint: '' },
        { ...current, enabled: 'true', endpoint: 'http://c:4318' },
      ),
    ).toMatchObject({ ok: false, error: 'OTEL_ENDPOINT_REQUIRED' })
  })

  it('accepts only boolean strings for the switches', () => {
    expect(prepareOtelSettingsPatch({ captureContent: 'yes' }, current)).toMatchObject({
      ok: false,
      error: 'INVALID_OTEL_SETTING',
    })
  })

  it('trims the service name and caps its length', () => {
    expect(prepareOtelSettingsPatch({ serviceName: ' agents ' }, current)).toEqual({
      ok: true,
      patch: { serviceName: 'agents' },
    })
    expect(prepareOtelSettingsPatch({ serviceName: 'x'.repeat(129) }, current)).toMatchObject({
      ok: false,
      error: 'INVALID_OTEL_SETTING',
    })
  })

  it('rejects unknown keys', () => {
    expect(prepareOtelSettingsPatch({ sampler: 'always' }, current)).toMatchObject({
      ok: false,
      error: 'INVALID_OTEL_SETTING',
    })
  })
})

describe('encryptOtelHeaders', () => {
  it('returns null for an invalid map', () => {
    expect(encryptOtelHeaders('nope')).toBeNull()
  })
})
