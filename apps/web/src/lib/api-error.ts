/**
 * Maps a backend error code onto an i18n key.
 *
 * `api.ts` throws `new Error(code)` where `code` is the backend's
 * `c.json({ error: 'SOME_CODE' })` value, so an Error's `message` *is* the
 * code. Screens used to hand that message straight to a modal, which surfaced
 * raw identifiers like `CANNOT_DISABLE_SELF` to users; funnel error copy
 * through here instead so every code has translated text and anything
 * unrecognised degrades to a generic message rather than leaking internals.
 */

/**
 * Codes the API returns, plus the transport-level ones `api.ts` raises itself.
 *
 * Exported so a test can assert every entry resolves to real copy — listing a code
 * with no translation behind it makes i18next render the key itself, which is the
 * leak this module exists to stop.
 */
export const KNOWN_CODES = new Set([
  'ACCOUNT_DISABLED',
  'ADMIN_NOT_FOUND',
  'AUTH_LOCKDOWN_REFUSED',
  'CANNOT_CHANGE_OWN_ROLE',
  'CANNOT_DELETE_SELF',
  'CANNOT_DISABLE_SELF',
  'DEVICE_REQUEST_NOT_FOUND',
  'EMAIL_ALREADY_BOUND',
  'EMAIL_DOMAIN_NOT_ALLOWED',
  'EVALUATION_QUEUE_FULL',
  'EVALUATION_RESULT_NOT_REVIEWABLE',
  'EVALUATION_SET_EMPTY',
  'INVALID_SETTINGS_VERSIONS',
  'INVALID_USER_CODE',
  'PUBLIC_BASE_URL_NOT_SET',
  'SETTINGS_CONFLICT',
  'EVALUATION_TASK_NOT_RUNNING',
  'EVALUATION_TASK_RUNNING',
  'IDAAS_IDENTITY_ALREADY_BOUND',
  'IDAAS_SUB_ALREADY_BOUND',
  'IDAAS_TOKEN_MISSING_EMAIL',
  'EMAIL_ALREADY_REGISTERED',
  'INVALID_CREDENTIALS',
  'INVALID_IDAAS_TOKEN',
  'INVALID_SSO_CONFIG',
  'INVITATION_ALREADY_ACCEPTED',
  'INVITATION_EMAIL_MISMATCH',
  'INVITATION_EXPIRED',
  'INVITATION_NOT_FOUND',
  'INVITATION_REVOKED',
  'LAST_ADMIN_CANNOT_DEMOTE',
  'LAST_ADMIN_CANNOT_DISABLE',
  'NETWORK_ERROR',
  'OAUTH_DISABLED_BY_ADMIN',
  'OAUTH_NONCE_MISMATCH',
  'OAUTH_NONCE_REQUIRED',
  'OAUTH_NOT_CONFIGURED',
  'PASSWORD_LOGIN_DISABLED',
  'PASSWORD_MISMATCH',
  'PASSWORD_NEED_DIGIT',
  'PASSWORD_NEED_LOWER',
  'PASSWORD_NEED_UPPER',
  'PASSWORD_TOO_SHORT',
  'SAML_METADATA_FAILED',
  'SAML_NOT_CONFIGURED',
  'SCHEDULE_RUN_AS_OWNER_REQUIRES_BOUND_IDENTITY',
  'SCM_INITIAL_SYNC_REQUIRED',
  'SETUP_ALREADY_COMPLETED',
  'USERNAME_EXISTS',
  'USER_NOT_FOUND',
  'USER_NOT_PROVISIONED',
  'WEBHOOK_URL_BLOCKED',
  'WRONG_PASSWORD',
])

/**
 * `api.ts` synthesises `HTTP_<status>` when a failed response carries no `error`.
 * Only statuses with their own copy are listed: an unlisted one would resolve to a
 * missing key, which i18next renders as the key itself — the very leak this avoids.
 */
export const HTTP_CODES = new Set([
  'HTTP_400',
  'HTTP_401',
  'HTTP_403',
  'HTTP_404',
  'HTTP_409',
  'HTTP_413',
  'HTTP_429',
  'HTTP_500',
  'HTTP_501',
  'HTTP_502',
  'HTTP_503',
])

export const UNKNOWN_ERROR_KEY = 'apiError.UNKNOWN'

/**
 * Resolves an error (or raw code) to an i18n key under `apiError.*`.
 * Unrecognised input resolves to `apiError.UNKNOWN` so raw text never reaches the UI.
 */
export function apiErrorKey(error: unknown): string {
  const code = readMessage(error)

  if (KNOWN_CODES.has(code) || HTTP_CODES.has(code)) {
    return `apiError.${code}`
  }

  return UNKNOWN_ERROR_KEY
}

/** `SCREAMING_SNAKE` — the shape every backend error *code* takes. */
const CODE_SHAPED = /^[A-Z][A-Z0-9_]*$/

/**
 * Resolves an error to the text to show the user.
 *
 * Not every route answers with a code. `scm-sources.ts` returns prose for all of
 * its ~38 failures, and the skill/agent upload parsers forward their own message —
 * often carrying the detail that makes the error actionable ("Cannot delete:
 * referenced by agents: Alpha, Beta", or the path that collided). That text is
 * already user-facing, so it passes through unchanged; replacing it with generic
 * copy would throw away the only part the user can act on.
 *
 * Only *code-shaped* input is translated, and an unrecognised code becomes generic
 * copy rather than leaking the identifier.
 */
export function formatApiError(error: unknown, t: (key: string) => string): string {
  const message = readMessage(error)

  if (!message) return t(UNKNOWN_ERROR_KEY)
  if (KNOWN_CODES.has(message) || HTTP_CODES.has(message)) return t(`apiError.${message}`)
  // An unmapped identifier is internal vocabulary; prose is meant to be read.
  return CODE_SHAPED.test(message) ? t(UNKNOWN_ERROR_KEY) : message
}

/**
 * Reads the code/message out of whatever the caller passed.
 *
 * `.message` is read structurally rather than behind an `instanceof Error` check:
 * the value arriving here may be a plain `{ message }` (TanStack's error prop, or a
 * rejected value that crossed a realm boundary), and those must resolve like an Error.
 */
function readMessage(error: unknown): string {
  if (typeof error === 'string') return error
  const message = (error as { message?: unknown })?.message
  return typeof message === 'string' ? message : ''
}
