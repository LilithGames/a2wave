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
      'A2WAVE_REFERENCED_CONTEXT_B64',
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
})
