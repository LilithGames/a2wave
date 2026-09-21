/**
 * Decrypt side of `otel.headersEnc`. Its own module so both the read side (config.ts, which pulls
 * in the settings cache) and the write side (settings-patch.ts, which the env bridge loads at boot)
 * can use it without importing each other.
 */
import { type OtelHeaders, otelHeadersSchema } from '@a2wave/shared'
import { logger } from '../logger.js'
import { decryptSecret } from '../secret-box.js'

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
