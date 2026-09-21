/**
 * "Test connection" against unsaved form state. The draft goes through the same
 * `prepareOtelSettingsPatch` a save uses — endpoint normalization, the cloud-metadata block, the
 * header keep marker — and is then layered over the saved settings in memory. Nothing here writes
 * a setting or an audit entry, and no header value ever reaches an error message.
 */
import { getCategorySettings } from '../settings.js'
import { type OtelConfig, otelConfigFromRaw } from './config.js'
import { prepareOtelSettingsPatch } from './settings-patch.js'

export type OtelTestConfigResult =
  | { ok: true; config: OtelConfig | null }
  | { ok: false; error: string }

/** The test works while export is off and never captures real content; a draft cannot say otherwise. */
const IGNORED_KEYS = new Set(['enabled', 'captureContent'])

function parseDraft(body: string): Record<string, string> | string {
  if (!body.trim()) return {}
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return 'the request body is not valid JSON'
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return 'the request body must be a JSON object'
  }
  const draft: Record<string, string> = {}
  for (const [key, value] of Object.entries(json)) {
    if (IGNORED_KEYS.has(key)) continue
    if (typeof value !== 'string') return `${key} must be a string`
    draft[key] = value
  }
  return draft
}

/**
 * Resolves the config a test should use from the raw request body: empty or `{}` → the saved
 * settings; otherwise the draft's keys override the saved ones. `config: null` means there is no
 * usable endpoint (OTEL_NOT_CONFIGURED).
 */
export function resolveOtelTestConfig(body: string): OtelTestConfigResult {
  const draft = parseDraft(body)
  if (typeof draft === 'string') return { ok: false, error: draft }
  // `enabled` is irrelevant to a test, so the "endpoint required while enabled" save rule must not
  // turn an empty draft endpoint into a validation error: that case is OTEL_NOT_CONFIGURED.
  const saved = { ...getCategorySettings('otel'), enabled: 'false' }
  const prepared = prepareOtelSettingsPatch(draft, saved)
  if (!prepared.ok) return { ok: false, error: prepared.message }
  return {
    ok: true,
    config: otelConfigFromRaw({ ...saved, ...prepared.patch }, { ignoreEnabled: true }),
  }
}
