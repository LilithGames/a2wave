/**
 * Write side of the `otel` settings category, shared by PATCH /api/settings and the env bridge.
 *
 * Secret convention (same as `sso.oidcClientSecret`): auth headers arrive as the plaintext
 * pseudo-key `headers` (a JSON object string), are encrypted here, and only `headersEnc` is ever
 * stored. The plaintext exists in the request body and nowhere else.
 */
import {
  normalizeOtelEndpoint,
  otelHeadersSchema,
  parseOtelResourceAttributes,
} from '@a2wave/shared'
import { encryptSecret } from '../secret-box.js'
import { isCloudMetadataAddress, isCloudMetadataHostname } from '../url-safety-core.js'

export type OtelSettingsPatchError =
  | 'INVALID_OTEL_HEADERS'
  | 'INVALID_OTEL_ENDPOINT'
  | 'OTEL_ENDPOINT_BLOCKED'
  | 'OTEL_ENDPOINT_REQUIRED'
  | 'INVALID_OTEL_RESOURCE_ATTRIBUTES'
  | 'INVALID_OTEL_SETTING'

export type OtelSettingsPatchResult =
  | { ok: true; patch: Record<string, string> }
  | { ok: false; error: OtelSettingsPatchError; message: string }

const BOOLEAN_KEYS = ['enabled', 'captureContent'] as const
const KNOWN_KEYS = new Set([
  'enabled',
  'endpoint',
  'headers',
  'captureContent',
  'serviceName',
  'resourceAttributes',
])
const SERVICE_NAME_MAX_LENGTH = 128

const fail = (error: OtelSettingsPatchError, message: string): OtelSettingsPatchResult => ({
  ok: false,
  error,
  message,
})

/** Validates a JSON header map and returns its ciphertext; null when the input is not valid. */
export function encryptOtelHeaders(rawJson: string): string | null {
  let json: unknown
  try {
    json = JSON.parse(rawJson)
  } catch {
    return null
  }
  const parsed = otelHeadersSchema.safeParse(json)
  return parsed.success ? encryptSecret(JSON.stringify(parsed.data)) : null
}

/**
 * The collector normally lives on loopback or a private address (sidecar / intranet), so the
 * public-URL SSRF guard does not apply — same stance as the admin-configured OIDC issuer. Only
 * cloud instance-metadata endpoints are refused: nothing legitimate listens there, the exporter
 * follows no redirects, and no response body is ever surfaced to the admin.
 */
function isBlockedCollectorHost(endpoint: string): boolean {
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
  return isCloudMetadataHostname(host) || isCloudMetadataAddress(host)
}

export function prepareOtelSettingsPatch(
  input: Record<string, string>,
  current: Record<string, string>,
): OtelSettingsPatchResult {
  if ('headersEnc' in input) {
    return fail('INVALID_OTEL_HEADERS', 'headersEnc is server-managed; submit otel.headers')
  }
  const unknown = Object.keys(input).find((key) => !KNOWN_KEYS.has(key))
  if (unknown) return fail('INVALID_OTEL_SETTING', `unknown key: ${unknown}`)

  const { headers, ...rest } = input
  const patch: Record<string, string> = { ...rest }

  if (headers !== undefined) {
    if (headers.trim() === '') patch.headersEnc = ''
    else {
      const encrypted = encryptOtelHeaders(headers)
      if (encrypted === null) {
        return fail('INVALID_OTEL_HEADERS', 'headers must be a JSON object of header name → value')
      }
      patch.headersEnc = encrypted
    }
  }

  for (const key of BOOLEAN_KEYS) {
    if (patch[key] !== undefined && patch[key] !== 'true' && patch[key] !== 'false') {
      return fail('INVALID_OTEL_SETTING', `${key} must be 'true' or 'false'`)
    }
  }

  if (patch.serviceName !== undefined) {
    patch.serviceName = patch.serviceName.trim()
    if (patch.serviceName.length > SERVICE_NAME_MAX_LENGTH) {
      return fail(
        'INVALID_OTEL_SETTING',
        `serviceName exceeds ${SERVICE_NAME_MAX_LENGTH} characters`,
      )
    }
  }

  if (patch.resourceAttributes !== undefined) {
    const attributes = parseOtelResourceAttributes(patch.resourceAttributes)
    if (attributes === null) {
      return fail(
        'INVALID_OTEL_RESOURCE_ATTRIBUTES',
        'resourceAttributes must be key=value pairs separated by commas; service.* is managed',
      )
    }
    patch.resourceAttributes = Object.entries(attributes)
      .map(([key, value]) => `${key}=${value}`)
      .join(',')
  }

  if (patch.endpoint !== undefined) {
    const endpoint = normalizeOtelEndpoint(patch.endpoint)
    if (endpoint === null) {
      return fail('INVALID_OTEL_ENDPOINT', 'endpoint must be an http(s) URL without credentials')
    }
    if (endpoint && isBlockedCollectorHost(endpoint)) {
      return fail('OTEL_ENDPOINT_BLOCKED', 'endpoint points at a cloud metadata address')
    }
    patch.endpoint = endpoint
  }

  const merged = { ...current, ...patch }
  if (merged.enabled === 'true' && !merged.endpoint) {
    return fail('OTEL_ENDPOINT_REQUIRED', 'an endpoint is required while export is enabled')
  }
  return { ok: true, patch }
}
