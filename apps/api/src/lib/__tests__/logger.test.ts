import { describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: {
    NODE_ENV: 'production',
    LOG_ROTATE_ENABLED: false,
    LOG_FILE_PATH: '/tmp/a2wave.log',
  },
}))

import { buildRedactPaths, REDACT_PATHS } from '../logger.js'

describe('logger redaction', () => {
  it('covers the known secret-bearing keys at top level', async () => {
    for (const key of [
      'apiKey',
      'providerApiKey',
      'embeddingApiKey',
      'endpointApiKey',
      'oauthToken',
      'token',
      'pat',
      'p4passwd',
      'password',
      'secret',
      'appSecret',
      'privateKeyEnc',
      'A2WAVE_GATEWAY_TOKEN',
      'A2WAVE_CHANNEL_B64',
    ]) {
      expect(REDACT_PATHS).toContain(key)
    }
  })

  it('covers each secret key one and two levels deep (nested config objects)', async () => {
    // A credential nested under e.g. { config: { pat } } or { agentConfig: { env: { apiKey } } }
    // must still be caught, so every key gets *.<key> and *.*.<key> variants.
    expect(REDACT_PATHS).toContain('*.pat')
    expect(REDACT_PATHS).toContain('*.*.pat')
    expect(REDACT_PATHS).toContain('*.p4passwd')
    expect(REDACT_PATHS).toContain('*.*.apiKey')
  })

  it('redacts common credential-bearing HTTP headers', async () => {
    expect(REDACT_PATHS).toContain('*.authorization')
    expect(REDACT_PATHS).toContain('*.cookie')
  })

  it('buildRedactPaths produces the depth variants for every base key', async () => {
    const paths = buildRedactPaths(['fooSecret'])
    expect(paths).toEqual(expect.arrayContaining(['fooSecret', '*.fooSecret', '*.*.fooSecret']))
  })

  it('produces no duplicate paths (pino rejects duplicates)', async () => {
    expect(new Set(REDACT_PATHS).size).toBe(REDACT_PATHS.length)
  })

  it('actually scrubs a nested credential from real log output', async () => {
    const pino = (await import('pino')).default
    const lines: string[] = []
    const testLogger = pino(
      { redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      { write: (s: string) => lines.push(s) },
    )

    testLogger.info(
      { agentConfig: { env: { apiKey: 'sk-super-secret' } }, config: { pat: 'ghp_leak' } },
      'run start',
    )

    const out = lines.join('')
    expect(out).not.toContain('sk-super-secret')
    expect(out).not.toContain('ghp_leak')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts case variants and snake_case credential headers/fields', () => {
    for (const path of [
      '*.*.Authorization',
      '*.*.*.Authorization',
      '*.*.app_secret',
      '*.*.tenant_access_token',
      '*.*["set-cookie"]',
      '*.*["x-api-key"]',
    ]) {
      expect(REDACT_PATHS).toContain(path)
    }
  })
})

describe('axios error sanitisation', () => {
  /** The AxiosError shape the Feishu SDK rethrows verbatim to its callers. */
  function buildAxiosError(): Error {
    return Object.assign(new Error('Request failed with status code 400'), {
      name: 'AxiosError',
      code: 'ERR_BAD_REQUEST',
      isAxiosError: true,
      config: {
        url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        method: 'post',
        data: '{"app_id":"cli_a1b2","app_secret":"SUPER_SECRET_APP_SECRET"}',
        headers: { Authorization: 'Bearer t-LEAKED_TENANT_TOKEN', 'User-Agent': 'oapi-node-sdk' },
      },
      request: { _header: 'Authorization: Bearer t-LEAKED_TENANT_TOKEN\r\n' },
      response: {
        status: 400,
        headers: { 'set-cookie': ['session=LEAKED_COOKIE'] },
        data: { code: 10003, msg: 'invalid param' },
      },
    })
  }

  it('keeps the diagnosable fields and drops the request/response payloads', async () => {
    const { serializeErrorForLog } = await import('../logger.js')
    const serialized = serializeErrorForLog(buildAxiosError()) as Record<string, unknown>

    expect(serialized.message).toBe('Request failed with status code 400')
    expect(serialized.code).toBe('ERR_BAD_REQUEST')
    expect(serialized.status).toBe(400)
    expect(typeof serialized.stack).toBe('string')
    expect(serialized.config).toBeUndefined()
    expect(serialized.request).toBeUndefined()
    expect(serialized.response).toBeUndefined()
  })

  it('passes non-object values through untouched', async () => {
    const { serializeErrorForLog } = await import('../logger.js')
    expect(serializeErrorForLog('boom')).toBe('boom')
    expect(serializeErrorForLog(null)).toBe(null)
  })

  it('sanitises a nested cause without recursing forever', async () => {
    const { serializeErrorForLog } = await import('../logger.js')
    const outer = new Error('wrapper', { cause: buildAxiosError() })
    const serialized = serializeErrorForLog(outer) as { cause?: Record<string, unknown> }
    expect(serialized.cause?.config).toBeUndefined()
    expect(serialized.cause?.message).toBe('Request failed with status code 400')
  })

  it('never writes the Feishu app_secret or tenant_access_token to a log line', async () => {
    const pino = (await import('pino')).default
    const { serializeErrorForLog } = await import('../logger.js')
    const lines: string[] = []
    const testLogger = pino(
      {
        serializers: { err: serializeErrorForLog, error: serializeErrorForLog },
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      },
      { write: (s: string) => lines.push(s) },
    )

    testLogger.warn({ err: buildAxiosError(), agentId: 'agt_1' }, 'Failed to send Feishu message')
    testLogger.error({ error: buildAxiosError() }, 'Feishu call failed')

    const out = lines.join('')
    expect(out).not.toContain('SUPER_SECRET_APP_SECRET')
    expect(out).not.toContain('t-LEAKED_TENANT_TOKEN')
    expect(out).not.toContain('LEAKED_COOKIE')
    expect(out).toContain('ERR_BAD_REQUEST')
  })
})
