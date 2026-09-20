/**
 * Read side of the `otel` settings category. Synchronous (settings cache only): it runs on the
 * Agent execution path, once per run.
 */
import {
  normalizeOtelEndpoint,
  type OtelHeaders,
  type OtelStatus,
  otelHeadersSchema,
  resolveOtelTracesUrl,
} from '@a2wave/shared'
import { logger } from '../logger.js'
import { decryptSecret } from '../secret-box.js'
import { getCategorySettings } from '../settings.js'

export const DEFAULT_OTEL_SERVICE_NAME = 'a2wave'

export interface OtelConfig {
  endpoint: string
  tracesUrl: string
  headers: OtelHeaders
  captureContent: boolean
  serviceName: string
}

/**
 * Decrypts `otel.headersEnc`. A decrypt failure (AUTH_SECRET rotated) or a malformed map is
 * treated as "no headers" with a warning — the collector then answers 401, which surfaces in the
 * export status; telemetry config must never take the platform down.
 */
export function readOtelHeaders(headersEnc: string): OtelHeaders {
  const enc = headersEnc.trim()
  if (!enc) return {}
  try {
    const parsed = otelHeadersSchema.safeParse(JSON.parse(decryptSecret(enc)))
    if (parsed.success) return parsed.data
    logger.warn('settings.otel.headersEnc failed schema validation — exporting without headers')
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'failed to read settings.otel.headersEnc (AUTH_SECRET changed?) — exporting without headers',
    )
  }
  return {}
}

/**
 * Returns null when export is disabled or no usable endpoint is configured. `ignoreEnabled` is for
 * "test connection", which must work before the admin flips the switch.
 */
export function readOtelConfig(options: { ignoreEnabled?: boolean } = {}): OtelConfig | null {
  const raw = getCategorySettings('otel')
  if (raw.enabled !== 'true' && !options.ignoreEnabled) return null
  const endpoint = normalizeOtelEndpoint(raw.endpoint ?? '')
  if (!endpoint) return null
  return {
    endpoint,
    tracesUrl: resolveOtelTracesUrl(endpoint),
    headers: readOtelHeaders(raw.headersEnc ?? ''),
    captureContent: raw.captureContent === 'true',
    serviceName: (raw.serviceName ?? '').trim() || DEFAULT_OTEL_SERVICE_NAME,
  }
}

/** Non-sensitive view for the status endpoint: header names, never header values. */
export function readOtelSettingsView(): Pick<
  OtelStatus,
  | 'enabled'
  | 'endpoint'
  | 'tracesUrl'
  | 'serviceName'
  | 'captureContent'
  | 'headersSet'
  | 'headerNames'
> {
  const raw = getCategorySettings('otel')
  const endpoint = normalizeOtelEndpoint(raw.endpoint ?? '') ?? ''
  const headersEnc = (raw.headersEnc ?? '').trim()
  return {
    enabled: raw.enabled === 'true',
    endpoint,
    tracesUrl: endpoint ? resolveOtelTracesUrl(endpoint) : '',
    serviceName: (raw.serviceName ?? '').trim(),
    captureContent: raw.captureContent === 'true',
    headersSet: headersEnc !== '',
    headerNames: Object.keys(readOtelHeaders(headersEnc)),
  }
}

/** Identity of the raw settings; the exporter runtime is rebuilt when it changes. */
export function otelConfigFingerprint(): string {
  const raw = getCategorySettings('otel')
  return JSON.stringify([
    raw.enabled,
    raw.endpoint,
    raw.headersEnc,
    raw.captureContent,
    raw.serviceName,
  ])
}
