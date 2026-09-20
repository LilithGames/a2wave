import { z } from 'zod'

/**
 * OpenTelemetry trace export settings (settings table, `otel` category).
 *
 * a2wave exports Agent run traces to exactly one OTLP/HTTP endpoint; fan-out to several backends
 * is the job of the operator's own OpenTelemetry Collector.
 *
 * Sensitive-field convention (same as `sso.oidcClientSecret`): auth headers are submitted as the
 * pseudo-key `otel.headers` (a JSON object string) via PATCH /api/settings, encrypted by the
 * server and stored as `otel.headersEnc`; read endpoints return header **names** only.
 */

/** RFC 7230 `token` — the only characters legal in an HTTP header name. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** Header values must not carry control characters (CR/LF would allow header injection). */
function hasNoControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

export const OTEL_MAX_HEADERS = 20
export const OTEL_MAX_HEADER_VALUE_LENGTH = 4096

export const otelHeadersSchema = z
  .record(
    z.string().regex(HEADER_NAME_RE, 'Invalid header name'),
    z
      .string()
      .min(1)
      .max(OTEL_MAX_HEADER_VALUE_LENGTH)
      .refine(hasNoControlCharacters, 'Invalid header value'),
  )
  .refine((headers) => Object.keys(headers).length <= OTEL_MAX_HEADERS, {
    message: `At most ${OTEL_MAX_HEADERS} headers`,
  })

export type OtelHeaders = z.infer<typeof otelHeadersSchema>

/**
 * Normalizes an OTLP endpoint: `''` (unconfigured) is returned as-is; a valid value returns the
 * URL without a trailing slash; otherwise `null`.
 *
 * Shared by the API (persistence + runtime) and the web form so validation cannot diverge — see
 * normalizeSsoCallbackOrigin for the incident that motivates a single `URL`-based standard.
 * Loopback and private addresses are accepted on purpose: a sidecar or intranet collector is the
 * normal deployment. Credentials belong in headers, never in the URL.
 */
export function normalizeOtelEndpoint(raw: string): string | null {
  const s = raw.trim()
  if (!s) return ''
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password || u.search || u.hash) return null
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/**
 * Resolves the traces signal URL from a normalized endpoint: a base URL gets the OTLP default
 * `/v1/traces` appended; a URL whose path already ends in `/traces` (vendor-specific ingest paths)
 * is used verbatim.
 */
export function resolveOtelTracesUrl(endpoint: string): string {
  return /\/traces$/.test(endpoint) ? endpoint : `${endpoint}/v1/traces`
}

/** GET /api/settings/otel/status — never carries header values. */
export interface OtelStatus {
  enabled: boolean
  endpoint: string
  /** Resolved traces URL; empty when no endpoint is configured. */
  tracesUrl: string
  serviceName: string
  captureContent: boolean
  headersSet: boolean
  headerNames: string[]
  /** Whether this API instance currently has a live exporter. */
  active: boolean
  lastExportAt: string | null
  lastError: string | null
  droppedSpans: number
  /** The settings cache and the exporter are per-process; other replicas may differ. */
  scope: 'this-instance'
}

export type OtelTestFailureReason = 'OTEL_NOT_CONFIGURED' | 'EXPORT_FAILED' | 'TIMEOUT'

/** POST /api/settings/otel/test — always 200; `ok` carries the verdict. */
export interface OtelTestResult {
  ok: boolean
  reason?: OtelTestFailureReason
  error?: string
}
