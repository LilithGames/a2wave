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
  'authorization',
  'cookie',
  // Header and body field names are matched literally by pino, so every casing
  // and snake_case spelling an HTTP client may use needs its own entry. axios
  // (used by the Feishu SDK) writes `Authorization`, not `authorization`.
  'Authorization',
  'Cookie',
  'set-cookie',
  'Set-Cookie',
  'x-api-key',
  'X-Api-Key',
  'app_secret',
  'client_secret',
  'api_key',
  'access_token',
  'refresh_token',
  'app_access_token',
  'tenant_access_token',
  'user_access_token',
] as const

/** pino/fast-redact needs bracket notation for keys that are not identifiers. */
function isPlainIdentifier(key: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(key)
}

/**
 * Expand each base key into the pino redact paths that catch it at the log
 * root and up to three levels deep — deep enough for the nested config objects
 * we log ({ config: { pat } }, { agentConfig: { env: { apiKey } } }) and for
 * axios-shaped errors ({ err: { config: { headers: { Authorization } } } })
 * without paying for unbounded-depth wildcard scanning.
 */
export function buildRedactPaths(baseKeys: readonly string[]): string[] {
  return baseKeys.flatMap((key) => {
    if (isPlainIdentifier(key)) {
      return [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]
    }
    const segment = `[${JSON.stringify(key)}]`
    return [segment, `*${segment}`, `*.*${segment}`, `*.*.*${segment}`]
  })
}

export const REDACT_PATHS = buildRedactPaths(REDACT_BASE_KEYS)

/**
 * Fields an axios-style error carries that replay the outbound request (and
 * therefore its credentials) verbatim: `config.data` holds the
 * `{"app_id","app_secret"}` token-request body, `config.headers.Authorization`
 * and `request._header` hold the `Bearer t-…` tenant access token, and
 * `response.headers` can hold `set-cookie`. Redaction alone cannot save us here
 * because `config.data` is a *string* — the secret is inside a JSON blob no
 * path can address — so the whole subtree is dropped.
 */
const ERROR_REQUEST_FIELDS = new Set(['config', 'request', 'response'])

/** Guards against a cyclic `cause` chain turning serialization into a hang. */
const MAX_ERROR_CAUSE_DEPTH = 3

/**
 * pino's default `err` serializer copies every enumerable own property, which
 * for the AxiosErrors the Feishu SDK rethrows means printing the app secret and
 * the tenant access token in the clear. Keep what makes an error diagnosable —
 * message, name, stack, error code, HTTP status — and drop the request replay.
 */
export function serializeErrorForLog(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const sanitized: Record<string, unknown> = {}
  const typeName = Object.getPrototypeOf(source)?.constructor?.name
  if (typeof typeName === 'string') sanitized.type = typeName
  // message/stack are non-enumerable on Error, so they need copying by name.
  if (typeof source.message === 'string') sanitized.message = source.message
  if (typeof source.stack === 'string') sanitized.stack = source.stack
  for (const key of Object.keys(source)) {
    if (ERROR_REQUEST_FIELDS.has(key) || key === 'cause') continue
    sanitized[key] = source[key]
  }
  const response = source.response as { status?: unknown } | undefined
  if (response && typeof response === 'object' && response.status !== undefined) {
    sanitized.status = response.status
  }
  if (source.cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) {
    sanitized.cause = serializeErrorForLog(source.cause, depth + 1)
  }
  return sanitized
}

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
  // Both keys are in use across the codebase (`{ err }` and `{ error }`), and
  // either can receive a raw SDK error, so both are sanitized.
  serializers: { err: serializeErrorForLog, error: serializeErrorForLog },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
})
