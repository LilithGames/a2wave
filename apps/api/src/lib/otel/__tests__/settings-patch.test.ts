import { describe, expect, it, vi } from 'vitest'

vi.mock('../../secret-box.js', () => ({
  encryptSecret: (plain: string) => `enc(${plain})`,
  decryptSecret: (enc: string) => enc.replace(/^enc\(|\)$/g, ''),
}))
vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OTEL_KEEP_HEADER_VALUE } from '@a2wave/shared'

import { encryptOtelHeaders, prepareOtelSettingsPatch } from '../settings-patch.js'

const current = {
  enabled: 'false',
  endpoint: '',
  headersEnc: '',
  captureContent: 'false',
  serviceName: '',
  resourceAttributes: '',
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

  describe('keep marker', () => {
    const stored = {
      ...current,
      headersEnc: 'enc({"Authorization":"Bearer stored-token","x-tenant":"acme"})',
    }

    it('takes the stored value for a header submitted with the keep marker', () => {
      const result = prepareOtelSettingsPatch(
        { headers: JSON.stringify({ Authorization: OTEL_KEEP_HEADER_VALUE, 'x-new': 'added' }) },
        stored,
      )
      expect(result).toEqual({
        ok: true,
        patch: { headersEnc: 'enc({"Authorization":"Bearer stored-token","x-new":"added"})' },
      })
    })

    it('drops a stored header whose name is absent from the submitted map', () => {
      const result = prepareOtelSettingsPatch(
        { headers: JSON.stringify({ 'x-tenant': OTEL_KEEP_HEADER_VALUE }) },
        stored,
      )
      expect(result).toEqual({ ok: true, patch: { headersEnc: 'enc({"x-tenant":"acme"})' } })
    })

    it('lets a retyped value replace the stored one', () => {
      const result = prepareOtelSettingsPatch(
        { headers: JSON.stringify({ Authorization: 'Bearer rotated' }) },
        stored,
      )
      expect(result).toEqual({
        ok: true,
        patch: { headersEnc: 'enc({"Authorization":"Bearer rotated"})' },
      })
    })

    it('fails, naming the header, when the keep marker has no stored value', () => {
      for (const from of [current, stored]) {
        const result = prepareOtelSettingsPatch(
          { headers: JSON.stringify({ 'x-missing': OTEL_KEEP_HEADER_VALUE }) },
          from,
        )
        expect(result).toMatchObject({ ok: false, error: 'INVALID_OTEL_HEADERS' })
        expect((result as { message: string }).message).toContain('x-missing')
        expect(JSON.stringify(result)).not.toContain('stored-token')
      }
    })

    it('matches header names exactly, case-sensitively', () => {
      expect(
        prepareOtelSettingsPatch(
          { headers: JSON.stringify({ authorization: OTEL_KEEP_HEADER_VALUE }) },
          stored,
        ),
      ).toMatchObject({ ok: false, error: 'INVALID_OTEL_HEADERS' })
    })

    it('still clears every stored header on an empty string', () => {
      expect(prepareOtelSettingsPatch({ headers: '' }, stored)).toEqual({
        ok: true,
        patch: { headersEnc: '' },
      })
    })
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

  it('normalizes resource attributes and rejects malformed or reserved ones', () => {
    expect(
      prepareOtelSettingsPatch(
        { resourceAttributes: ' openinference.project.name = a2wave ' },
        current,
      ),
    ).toEqual({ ok: true, patch: { resourceAttributes: 'openinference.project.name=a2wave' } })
    expect(prepareOtelSettingsPatch({ resourceAttributes: '' }, current)).toEqual({
      ok: true,
      patch: { resourceAttributes: '' },
    })
    for (const resourceAttributes of ['nope', 'service.name=x']) {
      expect(prepareOtelSettingsPatch({ resourceAttributes }, current)).toMatchObject({
        ok: false,
        error: 'INVALID_OTEL_RESOURCE_ATTRIBUTES',
      })
    }
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
