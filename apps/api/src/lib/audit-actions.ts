/**
 * Centralized audit action constants — wherever a new audit event is added,
 * the string lives here so search/filter dashboards stay accurate.
 */
export const AUDIT_ACTIONS = {
  // Admin recovery scripts (apps/api/src/scripts) — run outside a request, so
  // no Hono context / actor IP is available; see logBackgroundAudit.
  ADMIN_PASSWORD_RESET: 'admin.password_reset',

  // Auth — password
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_CHANGE_PASSWORD: 'auth.change-password',
  AUTH_SETUP_COMPLETED: 'auth.setup.completed',
  AUTH_PASSWORD_LOGIN_DISABLED_ATTEMPT: 'auth.password.login_disabled_attempted',

  // Auth — OAuth (external IdP)
  AUTH_OAUTH_LOGIN: 'auth.oauth.login',
  AUTH_OAUTH_USER_PROVISIONED: 'auth.oauth.user_provisioned',
  AUTH_OAUTH_USER_LINKED: 'auth.oauth.user_linked',
  /** Legacy SSO row stamped with the protocol that established its binding. */
  AUTH_OAUTH_PROTOCOL_BACKFILLED: 'auth.oauth.protocol_backfilled',
  AUTH_OAUTH_EXCHANGE_FAILED: 'auth.oauth.exchange_failed',
  // Auth — device grant (RFC 8628): headless `a2wave login` approved from a browser.
  // Requested/claimed are written by the unauthenticated CLI endpoints; approved/denied
  // by the browser session that decided. All four matter: they are the only record that
  // a token was issued to a machine that never held a credential of its own.
  AUTH_DEVICE_REQUESTED: 'auth.device.requested',
  AUTH_DEVICE_APPROVED: 'auth.device.approved',
  AUTH_DEVICE_DENIED: 'auth.device.denied',
  AUTH_DEVICE_CLAIMED: 'auth.device.claimed',

  // CLI tokens — long-lived credentials a user mints for automation. Creation and
  // revocation are the whole lifecycle; use is not audited (it would write an entry
  // per API call), which is what lastUsedAt exists for instead.
  CLI_TOKEN_CREATED: 'cli_token.created',
  CLI_TOKEN_REVOKED: 'cli_token.revoked',

  // Auth — 「SSO 验证即可看」分享访客（不建 a2wave 账号）
  AUTH_SHARE_ACCESS_GRANTED: 'auth.share.access_granted',
  AUTH_SHARE_ACCESS_DENIED: 'auth.share.access_denied',

  // Settings
  SETTINGS_UPDATE: 'settings.update',
  /** A write was rejected because a key changed since the caller read it. */
  SETTINGS_UPDATE_CONFLICT: 'settings.update_conflict',
  SETTINGS_AUTH_UPDATED: 'settings.auth.updated',
  SETTINGS_SSO_UPDATED: 'settings.sso.updated',

  // Users
  USER_ROLE_UPDATED: 'user.role.updated',
  USER_STATUS_UPDATED: 'user.status.updated',

  // User invitations — an admin issues a link, the invitee creates their own account.
  // The accept entry is written by an unauthenticated request, so it is attributed to
  // the account it just created rather than to a caller identity.
  USER_INVITATION_CREATED: 'user_invitation.created',
  USER_INVITATION_REVOKED: 'user_invitation.revoked',
  USER_INVITATION_ACCEPTED: 'user_invitation.accepted',
  /** Accept was refused (expired / revoked / already used / conflicting username or email). */
  USER_INVITATION_ACCEPT_FAILED: 'user_invitation.accept_failed',

  // Provider CLIs (runtime install; the image ships none)
  PROVIDER_CLI_INSTALL: 'provider_cli.install',
  PROVIDER_CLI_UNINSTALL: 'provider_cli.uninstall',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]
