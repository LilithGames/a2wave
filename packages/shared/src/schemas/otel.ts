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

export const OTEL_MAX_RESOURCE_ATTRIBUTES = 20
export const OTEL_MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH = 256
const RESOURCE_ATTRIBUTE_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/
/** Managed by a2wave (`serviceName` has its own setting); not overridable from here. */
const RESERVED_RESOURCE_ATTRIBUTES = new Set([
  'service.name',
  'service.version',
  'service.instance.id',
])

/**
 * Parses extra resource attributes in the standard `OTEL_RESOURCE_ATTRIBUTES` format
 * (`key=value,key=value`). Backends route on these — a project, a tenant, an environment — so they
 * are generic rather than tied to any one collector. `''` → `{}`; anything malformed → `null`.
 */
export function parseOtelResourceAttributes(raw: string): Record<string, string> | null {
  const attributes: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    if (!pair.trim()) continue
    const separator = pair.indexOf('=')
    if (separator <= 0) return null
    const key = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!RESOURCE_ATTRIBUTE_KEY_RE.test(key) || RESERVED_RESOURCE_ATTRIBUTES.has(key)) return null
    if (!value || value.length > OTEL_MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH) return null
    if (!hasNoControlCharacters(value) || key in attributes) return null
    attributes[key] = value
  }
  return Object.keys(attributes).length > OTEL_MAX_RESOURCE_ATTRIBUTES ? null : attributes
}

/** GET /api/settings/otel/status — never carries header values. */
export interface OtelStatus {
  enabled: boolean
  endpoint: string
  /** Resolved traces URL; empty when no endpoint is configured. */
  tracesUrl: string
  serviceName: string
  /** Raw `key=value,key=value` string, as stored. */
  resourceAttributes: string
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

/**
 * Header value meaning "keep the value that is already stored under this name". Stored header
 * values are never returned, so the editor lists saved headers by NAME and submits this marker
 * for every saved header the admin did not retype. A name sent with this marker but without a
 * stored value is a validation error, never an empty header.
 */
export const OTEL_KEEP_HEADER_VALUE = '********'

/**
 * Unsaved form state for "test connection". Same string shapes as the `otel` section of
 * PATCH /api/settings (`headers` is a JSON object string and may carry OTEL_KEEP_HEADER_VALUE).
 * Omitted keys fall back to the saved setting. Nothing in a draft is ever persisted.
 */
export interface OtelTestDraft {
  endpoint?: string
  serviceName?: string
  resourceAttributes?: string
  headers?: string
}

export type OtelTestFailureReason =
  | 'OTEL_NOT_CONFIGURED'
  /** The draft failed the same validation a save would run; `error` says which rule. */
  | 'INVALID_CONFIG'
  /**
   * Connection refused on a loopback address. In a container deployment loopback is the a2wave
   * container itself, not the host running the collector.
   */
  | 'LOOPBACK_REFUSED'
  | 'EXPORT_FAILED'
  | 'TIMEOUT'

/** POST /api/settings/otel/test — always 200; `ok` carries the verdict. */
export interface OtelTestResult {
  ok: boolean
  reason?: OtelTestFailureReason
  error?: string
  /** The traces URL the test trace was actually sent to; absent when no request was made. */
  testedUrl?: string
  /**
   * Trace id (32 lowercase hex) of the test trace the collector accepted, so the admin can look it
   * up in the backend. Present only when `ok` is true.
   */
  traceId?: string
}

const LOOPBACK_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i

/** True when the endpoint's host is a loopback name or address. Malformed input → false. */
export function isLoopbackOtelEndpoint(endpoint: string): boolean {
  try {
    return LOOPBACK_HOST_RE.test(new URL(endpoint).hostname)
  } catch {
    return false
  }
}
