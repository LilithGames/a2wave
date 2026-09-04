import pino from 'pino'
import { env } from '../env.js'

/**
 * Base keys whose values must never reach the logs. The logger has no way to
 * know a given field is a secret, so redaction is a defence-in-depth backstop:
 * even a future `logger.info({ config })` / `logger.error({ agentConfig })`
 * that accidentally carries a credential is scrubbed rather than written out.
 *
 * Covers provider/gateway credentials, SCM secrets (p4passwd / pat), the signed
 * gateway token env vars, the channel PII blob, and credential-bearing HTTP
 * headers. Add to this list whenever a new secret-bearing field name appears.
 */
const REDACT_BASE_KEYS = [
  'apiKey',
  'providerApiKey',
  'providerOauthToken',
  'embeddingApiKey',
  'endpointApiKey',
  'oauthToken',
  'token',
  'accessToken',
  'refreshToken',
  'pat',
  'p4passwd',
  'password',
  'secret',
  'appSecret',
  'clientSecret',
  'privateKey',
  'privateKeyEnc',
  'oidcClientSecretEnc',
  'A2WAVE_GATEWAY_TOKEN',
  'A2WAVE_CHANNEL_B64',
  'A2WAVE_REFERENCED_CONTEXT_B64',
  'authorization',
  'cookie',
] as const

/**
 * Expand each base key into the pino redact paths that catch it at the log
 * root, one level deep, and two levels deep — deep enough for the nested config
 * objects we log ({ config: { pat } }, { agentConfig: { env: { apiKey } } })
 * without paying for unbounded-depth wildcard scanning.
 */
export function buildRedactPaths(baseKeys: readonly string[]): string[] {
  return baseKeys.flatMap((key) => [key, `*.${key}`, `*.*.${key}`])
}

export const REDACT_PATHS = buildRedactPaths(REDACT_BASE_KEYS)

function buildTransport() {
  if (env.NODE_ENV !== 'production') {
    return { target: 'pino-pretty', options: { colorize: true } }
  }
  if (env.LOG_ROTATE_ENABLED) {
    return {
      target: 'pino-roll',
      options: {
        file: env.LOG_FILE_PATH,
        size: '20M',
        limit: { count: 9 },
        mkdir: true,
      },
    }
  }
  return undefined
}

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: buildTransport(),
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
})
