import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ProviderOauthAccount, ProviderOauthLoginStatus } from '@a2wave/shared'
import { logBackgroundAudit } from './audit.js'
import { createId } from './id.js'
import { withKeyedLock } from './keyed-mutex.js'
import {
  buildProviderOauthAuthorization,
  exchangeProviderOauthCode,
  type ProviderOauthAuthorization,
  ProviderOauthError,
  refreshProviderOauthTokens,
  revokeProviderOauthTokens,
  validateProviderOauthRedirectUri,
} from './provider-oauth-protocol.js'
import {
  claimOauthRefresh,
  commitOauthLogin,
  finishOauthRefresh,
  getOauthAccount,
  getOauthHostId,
  getOauthLogin,
  getOauthLoginUser,
  insertOauthLogin,
  type ProviderOauthAccountRow,
  type ProviderOauthLoginRow,
  transitionOauthLogin,
} from './provider-oauth-store.js'
import { decryptSecret, encryptSecret } from './secret-box.js'

const LOGIN_TTL_MS = 15 * 60_000
const REFRESH_LEASE_MS = 5 * 60_000
const REFRESH_WAIT_MS = 90_000
type Actor = { userId: string; isAdmin: boolean }
type StoredTokens = { accessToken: string; refreshToken: string; idToken: string; scopes: string[] }

export { ProviderOauthError } from './provider-oauth-protocol.js'

export function toProviderOauthAccountDto(
  row: ProviderOauthAccountRow,
  actor: Actor,
): ProviderOauthAccount {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    email: row.email,
    subject: row.subject,
    clientId: row.clientId,
    createdByUserId: row.createdByUserId,
    canManage: actor.isAdmin || row.createdByUserId === actor.userId,
    status: row.reauthRequired
      ? 'reauth_required'
      : row.expiresAt.getTime() <= Date.now()
        ? 'expired'
        : 'ready',
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function validateProviderOauthAccountBinding(
  accountId: string,
  providerId?: string,
): Promise<ProviderOauthAccountRow> {
  const row = await getOauthAccount(accountId)
  if (!row || (providerId && row.providerId !== providerId))
    throw new ProviderOauthError(
      'PROVIDER_OAUTH_ACCOUNT_NOT_FOUND',
      'The selected ChatGPT account is unavailable',
      404,
    )
  if (row.refreshLeaseId?.startsWith('delete_'))
    throw new ProviderOauthError(
      'PROVIDER_OAUTH_ACCOUNT_DELETING',
      'The selected ChatGPT account is being disconnected',
      409,
    )
  if (row.reauthRequired)
    throw new ProviderOauthError(
      'PROVIDER_OAUTH_REAUTH_REQUIRED',
      'Reconnect the selected ChatGPT account',
      409,
    )
  return row
}

function tokensOf(row: ProviderOauthAccountRow): StoredTokens {
  try {
    return JSON.parse(decryptSecret(row.tokensEnc)) as StoredTokens
  } catch {
    throw new ProviderOauthError(
      'PROVIDER_OAUTH_CREDENTIALS_UNAVAILABLE',
      'Stored ChatGPT credentials could not be opened; reconnect the account',
      503,
    )
  }
}

export async function resolveProviderOauthAccountCredentials(
  accountId: string,
  providerId?: string,
  options: { minimumValidityMs?: number; forceRefresh?: boolean } = {},
) {
  return withKeyedLock(`provider-oauth-refresh:${accountId}`, async () => {
    const deadline = Date.now() + REFRESH_WAIT_MS
    while (true) {
      const row = await validateProviderOauthAccountBinding(accountId, providerId)
      const tokens = tokensOf(row)
      const refreshDue =
        options.forceRefresh ||
        row.expiresAt.getTime() <= Date.now() + (options.minimumValidityMs ?? 60_000)
      if (
        !refreshDue ||
        (!options.forceRefresh &&
          row.earliestRefreshAt &&
          row.earliestRefreshAt.getTime() > Date.now() &&
          row.expiresAt.getTime() > Date.now())
      ) {
        return {
          accessToken: tokens.accessToken,
          accountId: row.id,
          clientId: row.clientId,
          subject: row.subject,
          expiresAt: row.expiresAt,
        }
      }
      const leaseId = createId('prl')
      if (
        !(await claimOauthRefresh(
          row.id,
          leaseId,
          new Date(Date.now() + REFRESH_LEASE_MS),
          row.revision,
        ))
      ) {
        if (Date.now() >= deadline)
          throw new ProviderOauthError(
            'PROVIDER_OAUTH_REFRESH_BUSY',
            'ChatGPT credentials are refreshing; retry shortly',
            503,
          )
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      try {
        const fresh = await refreshProviderOauthTokens({
          clientId: row.clientId,
          refreshToken: tokens.refreshToken,
          subject: row.subject,
          email: row.email,
          idToken: tokens.idToken,
        })
        const patch = {
          tokensEnc: encryptSecret(
            JSON.stringify({
              accessToken: fresh.accessToken,
              refreshToken: fresh.refreshToken,
              idToken: fresh.idToken,
              scopes: fresh.scopes,
            }),
          ),
          expiresAt: fresh.expiresAt,
          earliestRefreshAt: fresh.earliestRefreshAt,
          email: fresh.email,
          reauthRequired: false,
        }
        if (!(await finishOauthRefresh(row.id, leaseId, row.revision, patch)))
          throw new ProviderOauthError(
            'PROVIDER_OAUTH_ACCOUNT_CHANGED',
            'The account changed during token refresh; retry the request',
            409,
          )
        await logBackgroundAudit({
          action: 'provider_oauth_account.refresh',
          resource: 'provider_oauth_account',
          resourceId: row.id,
          userId: row.createdByUserId ?? undefined,
        })
        return {
          accessToken: fresh.accessToken,
          accountId: row.id,
          clientId: row.clientId,
          subject: row.subject,
          expiresAt: fresh.expiresAt,
        }
      } catch (error) {
        const permanent =
          error instanceof ProviderOauthError &&
          ['provider_oauth_reauth_required', 'missing_plan_scope', 'account_mismatch'].includes(
            error.code,
          )
        const changed = await finishOauthRefresh(
          row.id,
          leaseId,
          row.revision,
          permanent ? { reauthRequired: true } : {},
        )
        if (changed)
          await logBackgroundAudit({
            action: 'provider_oauth_account.refresh_failed',
            resource: 'provider_oauth_account',
            resourceId: row.id,
            userId: row.createdByUserId ?? undefined,
            details: { reauthRequired: permanent },
          })
        throw error
      }
    }
  })
}

export async function createProviderOauthLogin(
  providerId: string,
  actor: Actor,
  input: { accountId?: string; label?: string },
) {
  const user = await getOauthLoginUser(actor.userId)
  if (!user?.isActive)
    throw new ProviderOauthError(
      'login_user_inactive',
      'The account creating this authorization is no longer active',
      401,
    )
  if (input.accountId) {
    const account = await getOauthAccount(input.accountId)
    if (!account || account.providerId !== providerId)
      throw new ProviderOauthError('account_not_found', 'ChatGPT account not found', 404)
    if (!actor.isAdmin && account.createdByUserId !== actor.userId)
      throw new ProviderOauthError(
        'forbidden',
        'Only the creator or an administrator may reconnect an account',
        403,
      )
  }
  const loginId = createId('pol')
  const loginToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + LOGIN_TTL_MS)
  await insertOauthLogin({
    id: loginId,
    providerId,
    accountId: input.accountId ?? null,
    createdByUserId: actor.userId,
    userTokenVersion: user.tokenVersion,
    label: input.label ?? null,
    tokenHash: hashToken(loginToken),
    expiresAt,
  })
  return { loginId, loginToken, expiresAt: expiresAt.toISOString() }
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}
async function authenticateLogin(
  id: string,
  token: string,
  status: 'pending' | 'started',
): Promise<ProviderOauthLoginRow> {
  const login = await getOauthLogin(id)
  const supplied = Buffer.from(hashToken(token))
  const expected = Buffer.from(login?.tokenHash ?? '')
  if (!login || expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    throw new ProviderOauthError(
      'invalid_login_token',
      'Invalid or consumed authorization token',
      401,
    )
  if (login.expiresAt.getTime() <= Date.now())
    throw new ProviderOauthError('login_expired', 'This authorization attempt has expired', 409)
  if (login.status !== status)
    throw new ProviderOauthError(
      'login_consumed',
      'This authorization step has already been used',
      409,
    )
  const user = await getOauthLoginUser(login.createdByUserId)
  if (!user?.isActive || user.tokenVersion !== login.userTokenVersion)
    throw new ProviderOauthError(
      'login_user_inactive',
      'The session creating this authorization was revoked; start again',
      401,
    )
  return login
}

export async function startProviderOauthLogin(id: string, token: string, redirectUri: string) {
  const login = await authenticateLogin(id, token, 'pending')
  validateProviderOauthRedirectUri(redirectUri)
  const account = login.accountId ? await getOauthAccount(login.accountId) : undefined
  if (login.accountId && !account)
    throw new ProviderOauthError(
      'account_not_found',
      'The selected ChatGPT account was removed',
      404,
    )
  const pending: ProviderOauthAuthorization = {
    clientId: account?.clientId ?? null,
    hostId: account?.hostId ?? (await getOauthHostId()),
    redirectUri,
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    verifier: randomBytes(48).toString('base64url'),
  }
  if (account) {
    pending.loginHint = account.email ?? undefined
  }
  if (
    !(await transitionOauthLogin(id, 'pending', {
      status: 'started',
      pendingEnc: encryptSecret(JSON.stringify(pending)),
    }))
  )
    throw new ProviderOauthError(
      'login_consumed',
      'This authorization attempt has already started',
      409,
    )
  await logBackgroundAudit({
    action: 'provider_oauth_account.login_start',
    resource: 'provider_oauth_account',
    resourceId: login.accountId ?? login.id,
    userId: login.createdByUserId,
  })
  return { authorizationUrl: buildProviderOauthAuthorization(pending) }
}

export async function completeProviderOauthLogin(
  id: string,
  token: string,
  callback: { code?: string; state: string; clientId?: string; error?: string },
) {
  const login = await authenticateLogin(id, token, 'started')
  if (!(await transitionOauthLogin(id, 'started', { status: 'exchanging', tokenHash: '' })))
    throw new ProviderOauthError(
      'login_consumed',
      'This authorization attempt has already been completed',
      409,
    )
  try {
    const pending = JSON.parse(decryptSecret(login.pendingEnc ?? '')) as ProviderOauthAuthorization
    if (callback.state !== pending.state)
      throw new ProviderOauthError('invalid_state', 'Authorization state did not match')
    if (callback.error)
      throw new ProviderOauthError(
        'authorization_denied',
        'ChatGPT authorization was not completed',
      )
    const clientId = pending.clientId ?? callback.clientId
    if (
      !clientId ||
      clientId === 'dynamic_agent_client' ||
      (pending.clientId && callback.clientId && callback.clientId !== pending.clientId)
    )
      throw new ProviderOauthError(
        'invalid_client_id',
        'ChatGPT registration ID did not match the selected account',
      )
    if (!callback.code)
      throw new ProviderOauthError('missing_code', 'ChatGPT did not return an authorization code')
    const selected = login.accountId ? await getOauthAccount(login.accountId) : undefined
    if (login.accountId && !selected)
      throw new ProviderOauthError('account_not_found', 'The selected account was removed', 404)
    const fresh = await exchangeProviderOauthCode({ ...pending, clientId, code: callback.code })
    const currentUser = await getOauthLoginUser(login.createdByUserId)
    if (!currentUser?.isActive || currentUser.tokenVersion !== login.userTokenVersion)
      throw new ProviderOauthError(
        'login_user_inactive',
        'The session creating this authorization was revoked; start again',
        401,
      )
    if (selected && (fresh.subject !== selected.subject || clientId !== selected.clientId))
      throw new ProviderOauthError(
        'account_mismatch',
        'ChatGPT account identity did not match the selected account',
        409,
      )
    const accountId = selected?.id ?? createId('poa')
    await commitOauthLogin(
      id,
      {
        id: accountId,
        providerId: login.providerId,
        label: selected?.label ?? login.label ?? fresh.email ?? 'ChatGPT account',
        email: fresh.email,
        subject: fresh.subject,
        clientId,
        hostId: pending.hostId,
        createdByUserId: selected?.createdByUserId ?? login.createdByUserId,
        tokensEnc: encryptSecret(
          JSON.stringify({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            idToken: fresh.idToken,
            scopes: fresh.scopes,
          }),
        ),
        expiresAt: fresh.expiresAt,
        earliestRefreshAt: fresh.earliestRefreshAt,
      },
      !!selected,
    )
    await logBackgroundAudit({
      action: 'provider_oauth_account.connect',
      resource: 'provider_oauth_account',
      resourceId: accountId,
      userId: login.createdByUserId,
    })
    return { accountId }
  } catch (error) {
    const safe =
      error instanceof ProviderOauthError
        ? error
        : new ProviderOauthError(
            'authorization_failed',
            'Could not complete ChatGPT authorization',
            502,
          )
    await transitionOauthLogin(id, 'exchanging', {
      status: 'failed',
      error: safe.message,
      pendingEnc: null,
      tokenHash: '',
    })
    await logBackgroundAudit({
      action: 'provider_oauth_account.login_failed',
      resource: 'provider_oauth_account',
      resourceId: login.accountId ?? id,
      userId: login.createdByUserId,
      details: { code: safe.code },
    })
    throw safe
  }
}

export async function getProviderOauthLoginStatus(
  id: string,
  providerId: string,
  actor: Actor,
): Promise<ProviderOauthLoginStatus> {
  const login = await getOauthLogin(id)
  if (!login || login.providerId !== providerId)
    throw new ProviderOauthError('login_not_found', 'Authorization attempt not found', 404)
  if (!actor.isAdmin && login.createdByUserId !== actor.userId)
    throw new ProviderOauthError(
      'forbidden',
      'This authorization attempt belongs to another user',
      403,
    )
  if (!['completed', 'failed'].includes(login.status) && login.expiresAt.getTime() <= Date.now())
    return { status: 'expired' }
  return {
    status: login.status === 'exchanging' ? 'started' : login.status,
    ...(login.status === 'completed' && login.accountId ? { accountId: login.accountId } : {}),
    ...(login.error ? { error: login.error } : {}),
  }
}

/** Uses the same durable lease as refresh so revocation cannot race token rotation. */
export async function disconnectProviderOauthAccount(
  accountId: string,
  userId: string,
): Promise<void> {
  await withKeyedLock(`provider-oauth-refresh:${accountId}`, async () => {
    const row = await getOauthAccount(accountId)
    if (!row) throw new ProviderOauthError('account_not_found', 'ChatGPT account not found', 404)
    const leaseId = createId('delete')
    if (
      !(await claimOauthRefresh(
        row.id,
        leaseId,
        new Date(Date.now() + REFRESH_LEASE_MS),
        row.revision,
      ))
    )
      throw new ProviderOauthError('account_busy', 'This account is refreshing; retry shortly', 409)
    try {
      await revokeProviderOauthTokens(row.clientId, tokensOf(row).refreshToken)
      if (
        !(await finishOauthRefresh(row.id, leaseId, row.revision, { reauthRequired: true }, true))
      )
        throw new ProviderOauthError(
          'account_changed',
          'The account changed during revocation; retry the operation',
          409,
        )
      await logBackgroundAudit({
        action: 'provider_oauth_account.disconnect',
        resource: 'provider_oauth_account',
        resourceId: row.id,
        userId,
      })
    } catch (error) {
      await finishOauthRefresh(row.id, leaseId, row.revision, {})
      await logBackgroundAudit({
        action: 'provider_oauth_account.disconnect_failed',
        resource: 'provider_oauth_account',
        resourceId: row.id,
        userId,
        details: {
          code: error instanceof ProviderOauthError ? error.code : 'revocation_unconfirmed',
        },
      })
      throw error
    }
  })
}
