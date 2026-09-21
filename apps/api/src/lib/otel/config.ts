/**
 * Read side of the `otel` settings category. Synchronous (settings cache only): it runs on the
 * Agent execution path, once per run.
 */
import {
  normalizeOtelEndpoint,
  type OtelHeaders,
  type OtelStatus,
  parseOtelResourceAttributes,
  resolveOtelTracesUrl,
} from '@a2wave/shared'
import { logger } from '../logger.js'
import { getCategorySettings } from '../settings.js'
import { readOtelHeaders } from './headers.js'

export { readOtelHeaders }

export const DEFAULT_OTEL_SERVICE_NAME = 'a2wave'

export interface OtelConfig {
  endpoint: string
  tracesUrl: string
  headers: OtelHeaders
  captureContent: boolean
  serviceName: string
  /** Extra resource attributes; the managed service.* ones always win. */
  resourceAttributes: Record<string, string>
}

/** A malformed value (only reachable via the env bridge) is dropped, not fatal. */
function readResourceAttributes(raw: string): Record<string, string> {
  const parsed = parseOtelResourceAttributes(raw)
  if (parsed) return parsed
  logger.warn('settings.otel.resourceAttributes is malformed — exporting without them')
  return {}
}

export interface OtelConfigOptions {
  /** For "test connection", which must work before the admin flips the switch. */
  ignoreEnabled?: boolean
}

/**
 * Pure: the effective config for a raw `otel` settings record, or null when export is disabled or
 * no usable endpoint is configured. Shared by the saved-settings read and the draft "test
 * connection" path, so a draft is interpreted exactly like the settings it would become.
 */
export function otelConfigFromRaw(
  raw: Record<string, string | undefined>,
  options: OtelConfigOptions = {},
): OtelConfig | null {
  if (raw.enabled !== 'true' && !options.ignoreEnabled) return null
  const endpoint = normalizeOtelEndpoint(raw.endpoint ?? '')
  if (!endpoint) return null
  return {
    endpoint,
    tracesUrl: resolveOtelTracesUrl(endpoint),
    headers: readOtelHeaders(raw.headersEnc ?? ''),
    captureContent: raw.captureContent === 'true',
    serviceName: (raw.serviceName ?? '').trim() || DEFAULT_OTEL_SERVICE_NAME,
    resourceAttributes: readResourceAttributes(raw.resourceAttributes ?? ''),
  }
}

/** The config for the SAVED settings. Synchronous: settings cache only. */
export function readOtelConfig(options: OtelConfigOptions = {}): OtelConfig | null {
  return otelConfigFromRaw(getCategorySettings('otel'), options)
}

/** Non-sensitive view for the status endpoint: header names, never header values. */
export function readOtelSettingsView(): Pick<
  OtelStatus,
  | 'enabled'
  | 'endpoint'
  | 'tracesUrl'
  | 'serviceName'
  | 'resourceAttributes'
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
    resourceAttributes: (raw.resourceAttributes ?? '').trim(),
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
    raw.resourceAttributes,
  ])
}
