import { beforeEach, describe, expect, it, vi } from 'vitest'

let otelSettings: Record<string, string> = {}
vi.mock('../../settings.js', () => ({
  getCategorySettings: (category: string) => (category === 'otel' ? otelSettings : {}),
}))

const mockDecrypt = vi.fn((enc: string) => enc.replace(/^enc\(|\)$/g, ''))
vi.mock('../../secret-box.js', () => ({
  decryptSecret: (enc: string) => mockDecrypt(enc),
}))

const mockWarn = vi.fn()
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { otelConfigFingerprint, readOtelConfig, readOtelHeaders } from '../config.js'

const base = {
  enabled: 'true',
  endpoint: 'http://localhost:4318',
  headersEnc: '',
  captureContent: 'false',
  serviceName: '',
}

beforeEach(() => {
  otelSettings = { ...base }
  mockDecrypt.mockClear()
  mockWarn.mockClear()
})

describe('readOtelConfig', () => {
  it('returns null when disabled', () => {
    otelSettings.enabled = 'false'
    expect(readOtelConfig()).toBeNull()
  })

  it('returns null when the endpoint is empty or invalid', () => {
    otelSettings.endpoint = ''
    expect(readOtelConfig()).toBeNull()
    otelSettings.endpoint = 'grpc://collector:4317'
    expect(readOtelConfig()).toBeNull()
  })

  it('resolves the traces URL and the default service name', () => {
    expect(readOtelConfig()).toEqual({
      endpoint: 'http://localhost:4318',
      tracesUrl: 'http://localhost:4318/v1/traces',
      headers: {},
      captureContent: false,
      serviceName: 'a2wave',
    })
  })

  it('reads the capture flag, service name and decrypted headers', () => {
    otelSettings.captureContent = 'true'
    otelSettings.serviceName = ' agents-prod '
    otelSettings.headersEnc = 'enc({"Authorization":"Bearer t0ken-t0ken"})'
    expect(readOtelConfig()).toMatchObject({
      captureContent: true,
      serviceName: 'agents-prod',
      headers: { Authorization: 'Bearer t0ken-t0ken' },
    })
  })
})

describe('readOtelHeaders', () => {
  it('treats a decrypt failure as no headers and warns', () => {
    mockDecrypt.mockImplementationOnce(() => {
      throw new Error('bad key')
    })
    expect(readOtelHeaders('enc(x)')).toEqual({})
    expect(mockWarn).toHaveBeenCalledTimes(1)
  })

  it('treats a malformed header map as no headers', () => {
    expect(readOtelHeaders('enc(not json)')).toEqual({})
    expect(readOtelHeaders('enc({"bad name":"v"})')).toEqual({})
  })
})

describe('otelConfigFingerprint', () => {
  it('changes when any otel setting changes', () => {
    const before = otelConfigFingerprint()
    otelSettings.captureContent = 'true'
    expect(otelConfigFingerprint()).not.toBe(before)
  })

  it('is stable for unchanged settings', () => {
    expect(otelConfigFingerprint()).toBe(otelConfigFingerprint())
  })
})
