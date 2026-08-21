/**
 * The `error` strings `validateGatewayAuth` can return.
 *
 * These are a **contract**, not prose: `classifyOAuthAuthError` switch-matches them to derive
 * the OAuth gateway's error code, message and remediation. When both sides held plain
 * literals, renaming one in the middleware silently fell through the classifier's `default:`
 * branch — a caller whose token lacked an email claim was told to "ask the agent owner to
 * review the access policy" rather than that its token was missing a required claim. Sharing
 * the constants turns that class of drift into a compile error.
 *
 * They live in this leaf module rather than beside the middleware because consumers routinely
 * `vi.mock` the middleware; importing the constants from there would resolve to `undefined`
 * inside a mocked test and silently break every `case`.
 */
/**
 * Coalesce a persisted `oauth_access_mode` to a mode that still exists.
 *
 * The column's DEFAULT is still the retired `'feishu_scope'` (changing it would need an unsafe
 * table rebuild — see db/schema.ts), so the type includes it even though migration 0100 leaves
 * no row holding it.
 *
 * **Do not assume the value is unreachable.** Drizzle binds the TS-side `.default()` into every
 * INSERT, so any insert that omits this column writes `'feishu_scope'` rather than deferring to
 * the database. The clone route did exactly that and produced rows on the retired value; it now
 * passes the mode explicitly. Any new insert path must do the same.
 *
 * Resolving here — in one place, and to the **open** mode — is a read-side normalization, not a
 * security decision: it must never be the thing that decides an Agent's access tier. Write paths
 * choose the tier, and they choose the restricted one when it is unclear (migration 0100, agent
 * import, clone). If this function is ever the only guard for a row, that row's write path is
 * the bug.
 */
export function normalizeOauthAccessMode(
  mode: 'all_idaas_users' | 'specified_users' | 'feishu_scope' | null | undefined,
): 'all_idaas_users' | 'specified_users' {
  return mode === 'specified_users' ? 'specified_users' : 'all_idaas_users'
}

export const GatewayAuthErrors = {
  IP_NOT_ALLOWED: 'IP not allowed',
  MISSING_AUTH_HEADER: 'Missing Authorization header',
  INVALID_TOKEN: 'Invalid token',
  /**
   * Distinct from INVALID_TOKEN on purpose: an expired key is an operational
   * problem the integrator can fix by rotating, whereas a generic failure sends
   * them hunting for a credential bug that is not there. Revoked keys stay
   * INVALID_TOKEN — revoked must be indistinguishable from never-existed.
   */
  API_KEY_EXPIRED: 'API key expired',
  /** Verification could not reach the IdP; the caller's credentials are not implicated. */
  IDP_UNAVAILABLE: 'Identity provider unavailable',
  /** No address at all — revocation cannot match the caller against a disabled local row. */
  MISSING_EMAIL_CLAIM: 'Token missing email claim',
  /** An address exists but is unverified, so it cannot decide membership of an allowlist. */
  MISSING_VERIFIED_EMAIL: 'Token missing verified email claim',
  ACCOUNT_DISABLED: 'Account is disabled',
  /** The caller's address is absent from the Agent's `specified_users` allowlist. */
  NOT_IN_ALLOWED_USERS: 'User not in the allowed user list',
  OAUTH_NOT_CONFIGURED: 'OAuth not configured',
} as const

export type GatewayAuthErrorMessage = (typeof GatewayAuthErrors)[keyof typeof GatewayAuthErrors]
