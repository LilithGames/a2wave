import { timingSafeEqual } from 'node:crypto'
import { normalizeOauthAllowedEmail } from '@a2wave/shared'
import { GatewayAuthErrors } from '../lib/gateway-auth-errors.js'

export type { GatewayAuthErrorMessage } from '../lib/gateway-auth-errors.js'
export { GatewayAuthErrors } from '../lib/gateway-auth-errors.js'

import type { JwtUserInfo } from '../lib/jwt-auth.js'
import { logger } from '../lib/logger.js'
import {
  getOidcEnv,
  isIdpUnavailableError,
  isOauthChannelConfigured,
  verifyOauthChannelToken,
} from '../lib/oidc.js'
import { isSsoAccountDisabled } from '../lib/user-status.js'

export interface GatewayAuthAgent {
  publishIpWhitelist: string[] | null
  publishAuthType: string | null
  /**
   * Legacy single plaintext key. Consulted only when `verifyApiKey` is absent or
   * misses, and only for the dual-read window while `agent_api_keys` is backfilled.
   * Once the legacy columns are cleared this is always null.
   */
  endpointApiKey: string | null
  /**
   * Multi-key verification against `agent_api_keys`, injected by the route so this
   * module stays free of database access and directly unit-testable. The caller
   * supplies the channel-specific implementation, which is what keeps a REST key
   * from authenticating an A2A request.
   */
  verifyApiKey?: (plaintext: string) => Promise<ApiKeyVerification>
  oauthAccessMode?: 'all_idaas_users' | 'specified_users' | null
  /**
   * Email allowlist consulted only when `publishAuthType === 'oauth'` and
   * `oauthAccessMode === 'specified_users'`; ignored for every other combination.
   */
  oauthAllowedEmails?: string[] | null
}

export interface GatewayAuthRequest {
  clientIp: string
  authorizationHeader?: string
}

export interface GatewayAuthError {
  error: string
  status: 401 | 403 | 503
}

export type GatewayCaller = {
  kind: 'idaas_user'
  userInfo: JwtUserInfo
}

/**
 * OAuth 调用方的稳定用户级身份（issuer+sub）。用作附件 uploaderId/consumerId——上传端点
 * （oauth-gateway）与所有 OAuth 鉴权的消费端（oauth invoke / OAuth-A2A materialize）必须
 * 用**同一格式**，消费鉴权要求 uploaderId === consumerId（review [P1]：A2A 硬编码
 * agent:<id> 导致 OAuth 上传的 token 附件全部被拒）。单点定义防两边格式漂移。
 */
export function oauthUploaderId(caller: GatewayCaller): string {
  return `oauth:${caller.userInfo.issuer}:${caller.userInfo.sub}`
}

/** What an injected verifier answers. Mirrors lib/agent-api-key-verify.ts. */
export type ApiKeyVerification =
  | { ok: true; keyId: string; keyName: string }
  | { ok: false; reason: 'invalid' | 'expired' }

/** The key that authenticated the request, surfaced so the run can name its trigger. */
export interface AuthenticatingApiKey {
  id: string
  name: string
}

export interface GatewayAuthOk {
  error?: undefined
  caller?: GatewayCaller
  /** Absent for `none` auth, OAuth, and the legacy single-key fallback. */
  apiKey?: AuthenticatingApiKey
}

export interface GatewayAuthFail {
  error: GatewayAuthError
  caller?: undefined
  apiKey?: undefined
}

export type GatewayAuthResult = GatewayAuthOk | GatewayAuthFail

export type NormalizedAuthType = 'none' | 'api_key' | 'oauth'

/**
 * Normalize `publishAuthType` column to a known enum value.
 *
 * Legacy rows may have `null` or legacy values. For safety, anything not explicitly
 * `'none'` or `'oauth'` falls back to `'api_key'` (the pre-OAuth default that *requires*
 * authentication). Returning 'none' for unknown values would silently open an agent up.
 */
export function normalizeAuthType(value: string | null | undefined): NormalizedAuthType {
  if (value === 'none' || value === 'oauth') return value
  return 'api_key'
}

export function isIpInWhitelist(clientIp: string, entry: string): boolean {
  if (clientIp === 'unknown') return false
  const trimmed = entry.trim()
  if (!trimmed) return false
  if (trimmed.includes('/')) {
    const [network, prefixStr] = trimmed.split('/')
    const prefix = Number.parseInt(prefixStr, 10)
    if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false
    const ipToNum = (ip: string) =>
      ip.split('.').reduce((acc, oct) => (acc << 8) + Number.parseInt(oct, 10), 0) >>> 0
    const mask = prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1) >>> 0
    return (ipToNum(clientIp) & mask) === (ipToNum(network) & mask)
  }
  return clientIp === trimmed
}

function extractBearer(authHeader: string): string {
  // RFC 6750: auth-scheme is case-insensitive. Accept `Bearer`, `bearer`, `BEARER`,
  // and any whitespace (space/tab) between scheme and token.
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  return m ? m[1] : authHeader
}

export async function validateGatewayAuth(
  agent: GatewayAuthAgent,
  request: GatewayAuthRequest,
): Promise<GatewayAuthResult> {
  const ipWhitelist = agent.publishIpWhitelist || []
  if (ipWhitelist.length > 0) {
    const allowed = ipWhitelist.some((entry) => isIpInWhitelist(request.clientIp, entry))
    if (!allowed) {
      return { error: { error: GatewayAuthErrors.IP_NOT_ALLOWED, status: 403 } }
    }
  }

  const authType = normalizeAuthType(agent.publishAuthType)

  if (authType === 'none') {
    return {}
  }

  if (authType === 'oauth') {
    // Deliberately isOauthChannelConfigured(), not (await isOidcConfigured()): the latter also
    // requires the OIDC *login method* to be enabled, and an admin disabling login (to
    // force password-only sign-in, or after switching to SAML) must not 503 every
    // already-published OAuth Agent. See the note on isOauthChannelConfigured.
    if (!(await isOauthChannelConfigured())) {
      logger.warn(
        {
          clientIp: request.clientIp,
          reason: 'enterprise OIDC is not configured, or its channel audience allowlist is empty',
        },
        'OAuth request rejected: OAuth channel not configured',
      )
      return { error: { error: GatewayAuthErrors.OAUTH_NOT_CONFIGURED, status: 503 } }
    }
    const authHeader = request.authorizationHeader
    if (!authHeader) {
      logger.info({ clientIp: request.clientIp }, 'OAuth request rejected: no Authorization header')
      return { error: { error: GatewayAuthErrors.MISSING_AUTH_HEADER, status: 401 } }
    }
    const token = extractBearer(authHeader)
    let userInfo: JwtUserInfo
    try {
      userInfo = await verifyOauthChannelToken(token)
      logger.info(
        {
          sub: userInfo.sub,
          userId: userInfo.userId,
          email: userInfo.email,
          tenantId: userInfo.tenantId,
          issuer: userInfo.issuer,
        },
        'OAuth request authenticated',
      )
    } catch (err) {
      const reason = (err as Error).message
      // Verification now reaches the IdP (discovery + JWKS), so a failure here is not
      // necessarily the caller's fault. Reporting an IdP outage as 401 tells every
      // integrator their credentials broke — they rotate tokens that were fine while the
      // real problem is upstream and self-healing. Infrastructure faults get 503, which
      // also reads as retryable to a client; only claim/signature failures stay 401.
      const infrastructureFailure = isIdpUnavailableError(err)
      logger.warn(
        {
          clientIp: request.clientIp,
          tokenLength: token.length,
          expectedIssuer: (await getOidcEnv())?.issuer,
          reason,
          infrastructureFailure,
        },
        infrastructureFailure
          ? 'OAuth request rejected: IdP unreachable, cannot verify token'
          : 'OAuth request rejected: JWT validation failed',
      )
      return infrastructureFailure
        ? { error: { error: GatewayAuthErrors.IDP_UNAVAILABLE, status: 503 } }
        : { error: { error: GatewayAuthErrors.INVALID_TOKEN, status: 401 } }
    }

    // Some email address must be present on this channel, regardless of access mode.
    //
    // Not for the allowlist match (that gate lives further down, and only specified_users
    // needs it) but for **revocation**: isSsoAccountDisabled matches (issuer, sub) first, then
    // legacy issuer-NULL rows, then falls back to email — and that last hop is short-
    // circuited when no address is supplied. An account provisioned under a different issuer
    // value, or one whose row records only an email, is therefore unmatchable from an
    // address-less token: a disabled leaver would keep invoking the Agent in
    // all_idaas_users mode.
    //
    // An `email_verified: false` address counts here. It is deliberately excluded from
    // `userInfo.email` (that field is the account-merge key, and an unverified address is
    // user-selectable), but for revocation the direction of the error matters: using it can
    // only ever match *more* disabled rows, never authorize someone. Rejecting those callers
    // outright would break every deployment whose IdP marks service or non-federated
    // accounts unverified — the login path survives that by backfilling from the userinfo
    // endpoint, which this path has no access token to call.
    const revocationEmail = userInfo.email ?? userInfo.unverifiedEmail
    if (!revocationEmail) {
      logger.warn(
        { clientIp: request.clientIp, sub: userInfo.sub, issuer: userInfo.issuer },
        'OAuth request rejected: token has no email claim (identity cannot be revocation-checked)',
      )
      return { error: { error: GatewayAuthErrors.MISSING_EMAIL_CLAIM, status: 403 } }
    }

    // A verified IdP token is not enough: if the caller has a local a2wave account and an
    // admin disabled it, every path must close — otherwise disabling a leaver would still
    // leave the Agent invocation path open. Checked before the access-mode branch so it
    // covers both modes, and before the Feishu round-trip so it short-circuits cheaply.
    if (
      await isSsoAccountDisabled({
        issuer: userInfo.issuer,
        sub: userInfo.sub,
        email: revocationEmail,
      })
    ) {
      logger.info(
        { clientIp: request.clientIp, sub: userInfo.sub, issuer: userInfo.issuer },
        'OAuth request rejected: local account is disabled',
      )
      return { error: { error: GatewayAuthErrors.ACCOUNT_DISABLED, status: 403 } }
    }

    const oauthAccessMode = agent.oauthAccessMode ?? 'all_idaas_users'
    if (oauthAccessMode === 'all_idaas_users') {
      return { caller: { kind: 'idaas_user', userInfo } }
    }

    // specified_users: the caller's address must appear in the Agent's allowlist.
    //
    // This needs a **verified** address, a stricter bar than the revocation gate above. That
    // one accepts an `email_verified: false` claim because using it can only ever match more
    // disabled accounts, never authorize anyone. Here the address decides who gets in, so a
    // self-asserted one would let a caller simply claim a listed colleague's mailbox. Hence
    // userInfo.email, not revocationEmail.
    const email = userInfo.email
    if (!email) {
      logger.warn(
        {
          clientIp: request.clientIp,
          sub: userInfo.sub,
          hasUnverifiedEmail: !!userInfo.unverifiedEmail,
        },
        'OAuth request rejected: no verified email claim (cannot match the allowed user list)',
      )
      return { error: { error: GatewayAuthErrors.MISSING_VERIFIED_EMAIL, status: 403 } }
    }
    // An empty list denies everyone. That is the state a `feishu_scope` Agent is migrated
    // into, and treating it as "unrestricted" would turn an upgrade into a silent widening of
    // access on exactly the Agents whose owners had restricted them.
    const allowed = agent.oauthAllowedEmails ?? []
    const normalized = normalizeOauthAllowedEmail(email)
    if (!allowed.some((entry) => normalizeOauthAllowedEmail(entry) === normalized)) {
      logger.info(
        { clientIp: request.clientIp, email, sub: userInfo.sub, allowedCount: allowed.length },
        'OAuth request rejected: user not in the allowed user list',
      )
      return { error: { error: GatewayAuthErrors.NOT_IN_ALLOWED_USERS, status: 403 } }
    }
    return { caller: { kind: 'idaas_user', userInfo } }
  }

  // api_key
  const authHeader = request.authorizationHeader
  if (!authHeader) {
    return { error: { error: GatewayAuthErrors.MISSING_AUTH_HEADER, status: 401 } }
  }
  const token = extractBearer(authHeader)

  if (agent.verifyApiKey) {
    const verification = await agent.verifyApiKey(token)
    if (verification.ok) {
      return { apiKey: { id: verification.keyId, name: verification.keyName } }
    }
    // An expired key is reported as such and stops here. Falling through to the
    // legacy column would resurrect a credential its owner deliberately time-boxed,
    // in the one case where we know exactly which key was presented.
    if (verification.reason === 'expired') {
      return { error: { error: GatewayAuthErrors.API_KEY_EXPIRED, status: 403 } }
    }
  }

  // Dual-read fallback: rows whose plaintext key has not been migrated into
  // `agent_api_keys` yet must keep authenticating. Removed once the legacy columns
  // are cleared, at which point `endpointApiKey` is always null and this is a no-op.
  const legacy = agent.endpointApiKey ?? ''
  if (legacy) {
    const tokenBuf = Buffer.from(token)
    const keyBuf = Buffer.from(legacy)
    const matches = tokenBuf.length === keyBuf.length && timingSafeEqual(tokenBuf, keyBuf)
    if (matches) return {}
  }

  return { error: { error: GatewayAuthErrors.INVALID_TOKEN, status: 403 } }
}
