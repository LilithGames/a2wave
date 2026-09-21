/**
 * OpenTelemetry export form ⇄ PATCH /api/settings body and the "test connection" draft (pure
 * functions, used by OtelExportCard).
 *
 * Backend contract: settings.otel values are strings; auth headers travel as the plaintext
 * pseudo-key `otel.headers` (a JSON map) and are encrypted server-side. The server never returns
 * header values, so saved headers are edited by NAME: the submitted map is the complete new set,
 * and OTEL_KEEP_HEADER_VALUE stands in for every saved value the admin did not retype.
 * Validation reuses the shared schema/normalizer — the same implementation the API runs.
 */
import {
  normalizeOtelEndpoint,
  OTEL_KEEP_HEADER_VALUE,
  type OtelStatus,
  type OtelTestDraft,
  otelHeadersSchema,
  parseOtelResourceAttributes,
} from '@a2wave/shared'
import type { BuildResult } from './sso-config-form'

export interface OtelHeaderRow {
  name: string
  /** Always empty for a saved row until the admin retypes it. */
  value: string
  /** The server already stores a value under this name. */
  saved: boolean
}

export interface OtelFormValues {
  enabled: boolean
  endpoint: string
  serviceName: string
  /** `key=value,key=value`, the OTEL_RESOURCE_ATTRIBUTES format. */
  resourceAttributes: string
  captureContent: boolean
  /** The complete header set: saved rows plus newly added ones. */
  headers: OtelHeaderRow[]
}

export const EMPTY_OTEL_FORM: OtelFormValues = {
  enabled: false,
  endpoint: '',
  serviceName: '',
  resourceAttributes: '',
  captureContent: false,
  headers: [],
}

export function otelFormFromStatus(status: OtelStatus): OtelFormValues {
  return {
    enabled: status.enabled,
    endpoint: status.endpoint,
    serviceName: status.serviceName,
    resourceAttributes: status.resourceAttributes,
    captureContent: status.captureContent,
    headers: status.headerNames.map((name) => ({ name, value: '', saved: true })),
  }
}

/** The rows as they stand once a save succeeded: everything named is stored, no value is kept. */
export function markOtelHeadersSaved(rows: OtelHeaderRow[]): OtelHeaderRow[] {
  return rows
    .map((row) => row.name.trim())
    .filter(Boolean)
    .map((name) => ({ name, value: '', saved: true }))
}

const HEADERS_INVALID = 'settings.otel.errors.headersInvalid'

/**
 * The `headers` payload for the rows: `undefined` when nothing changed against `savedNames`,
 * `''` to clear every stored header, otherwise the complete JSON map.
 */
function buildOtelHeaders(
  formRows: OtelHeaderRow[],
  savedNames: readonly string[],
): BuildResult<string | undefined> {
  const rows = formRows
    .map((row) => ({ ...row, name: row.name.trim(), value: row.value.trim() }))
    .filter((row) => row.name || row.value)

  const untouched =
    rows.length === savedNames.length &&
    rows.every((row) => row.saved && !row.value && savedNames.includes(row.name))
  if (untouched) return { ok: true, value: undefined }
  if (rows.length === 0) return { ok: true, value: '' }

  const names = new Set(rows.map((row) => row.name.toLowerCase()))
  const map = Object.fromEntries(
    rows.map((row) => [row.name, row.saved && !row.value ? OTEL_KEEP_HEADER_VALUE : row.value]),
  )
  if (names.size !== rows.length || !otelHeadersSchema.safeParse(map).success) {
    return { ok: false, error: HEADERS_INVALID }
  }
  return { ok: true, value: JSON.stringify(map) }
}

/** The fields shared by a save and a connection test. */
function buildOtelDraft(
  form: OtelFormValues,
  savedNames: readonly string[],
): BuildResult<OtelTestDraft & { endpoint: string }> {
  const endpoint = normalizeOtelEndpoint(form.endpoint)
  if (endpoint === null) return { ok: false, error: 'settings.otel.errors.endpointInvalid' }
  if (parseOtelResourceAttributes(form.resourceAttributes) === null) {
    return { ok: false, error: 'settings.otel.errors.resourceAttributesInvalid' }
  }
  const headers = buildOtelHeaders(form.headers, savedNames)
  if (!headers.ok) return headers

  return {
    ok: true,
    value: {
      endpoint,
      serviceName: form.serviceName.trim(),
      resourceAttributes: form.resourceAttributes.trim(),
      ...(headers.value === undefined ? {} : { headers: headers.value }),
    },
  }
}

/**
 * Returns the `otel` section of the PATCH body, or an i18n key describing what is wrong.
 * `savedNames` are the header names the server currently stores (`OtelStatus.headerNames`).
 */
export function buildOtelPatch(
  form: OtelFormValues,
  savedNames: readonly string[] = [],
): BuildResult<Record<string, string>> {
  const draft = buildOtelDraft(form, savedNames)
  if (!draft.ok) return draft
  if (form.enabled && !draft.value.endpoint) {
    return { ok: false, error: 'settings.otel.errors.endpointRequired' }
  }
  return {
    ok: true,
    value: {
      enabled: String(form.enabled),
      captureContent: String(form.captureContent),
      ...draft.value,
    },
  }
}

/** Body of POST /api/settings/otel/test: what a save would send, without persisting anything. */
export function buildOtelTestDraft(
  form: OtelFormValues,
  savedNames: readonly string[],
): BuildResult<OtelTestDraft> {
  return buildOtelDraft(form, savedNames)
}
