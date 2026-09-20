/**
 * OpenTelemetry export form ⇄ PATCH /api/settings body (pure functions, used by OtelExportCard).
 *
 * Backend contract: settings.otel values are strings; auth headers travel as the plaintext
 * pseudo-key `otel.headers` (a JSON map) and are encrypted server-side. Omitting `headers` keeps
 * the stored secret; the server never returns header values, so the editor always starts empty.
 * Validation reuses the shared schema/normalizer — the same implementation the API runs.
 */
import { normalizeOtelEndpoint, type OtelStatus, otelHeadersSchema } from '@a2wave/shared'
import type { BuildResult } from './sso-config-form'

export interface OtelHeaderRow {
  name: string
  value: string
}

export interface OtelFormValues {
  enabled: boolean
  endpoint: string
  serviceName: string
  captureContent: boolean
  /** Replacement headers; empty = leave the stored ones untouched. */
  headers: OtelHeaderRow[]
}

export const EMPTY_OTEL_FORM: OtelFormValues = {
  enabled: false,
  endpoint: '',
  serviceName: '',
  captureContent: false,
  headers: [],
}

export function otelFormFromStatus(status: OtelStatus): OtelFormValues {
  return {
    enabled: status.enabled,
    endpoint: status.endpoint,
    serviceName: status.serviceName,
    captureContent: status.captureContent,
    headers: [],
  }
}

/** Returns the `otel` section of the PATCH body, or an i18n key describing what is wrong. */
export function buildOtelPatch(form: OtelFormValues): BuildResult<Record<string, string>> {
  const endpoint = normalizeOtelEndpoint(form.endpoint)
  if (endpoint === null) return { ok: false, error: 'settings.otel.errors.endpointInvalid' }
  if (form.enabled && !endpoint)
    return { ok: false, error: 'settings.otel.errors.endpointRequired' }

  const value: Record<string, string> = {
    enabled: String(form.enabled),
    endpoint,
    serviceName: form.serviceName.trim(),
    captureContent: String(form.captureContent),
  }

  const rows = form.headers
    .map((row) => ({ name: row.name.trim(), value: row.value.trim() }))
    .filter((row) => row.name || row.value)
  if (rows.length > 0) {
    const names = new Set(rows.map((row) => row.name.toLowerCase()))
    const map = Object.fromEntries(rows.map((row) => [row.name, row.value]))
    if (names.size !== rows.length || !otelHeadersSchema.safeParse(map).success) {
      return { ok: false, error: 'settings.otel.errors.headersInvalid' }
    }
    value.headers = JSON.stringify(map)
  }
  return { ok: true, value }
}
