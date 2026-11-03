import { createHash } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import { AppError } from './errors.js'

export const PROVIDER_OAUTH_ISSUER = 'https://auth.openai.com'
export const PROVIDER_OAUTH_RESOURCE = 'https://api.openai.com/v1'
export const PROVIDER_OAUTH_SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const PROVIDER_OAUTH_TIMEOUT_MS = 90_000
const TOKEN_ENDPOINT = `${PROVIDER_OAUTH_ISSUER}/api/accounts/oauth/token`

export class ProviderOauthError extends AppError {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 502 | 503 = 400,
  ) {
    super(status, message, code)
    this.name = 'ProviderOauthError'
  }
}

export interface ProviderOauthTokens {
  accessToken: string
  refreshToken: string
  idToken: string
  subject: string
  email: string | null
  scopes: string[]
  expiresAt: Date
  earliestRefreshAt: Date | null
}

export interface ProviderOauthAuthorization {
  clientId: string | null
  hostId: string
  redirectUri: string
  state: string
  nonce: string
  verifier: string
  loginHint?: string
}

export function validateProviderOauthRedirectUri(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ProviderOauthError('invalid_redirect_uri', 'A loopback callback URI is required')
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/auth/callback' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ProviderOauthError(
      'invalid_redirect_uri',
      'Use http://127.0.0.1:<port>/auth/callback',
    )
  }
}

export function buildProviderOauthAuthorization(input: ProviderOauthAuthorization): string {
  validateProviderOauthRedirectUri(input.redirectUri)
  const url = new URL(`${PROVIDER_OAUTH_ISSUER}/api/accounts/authorize`)
  const params: Record<string, string> = {
    client_id: input.clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: input.hostId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: PROVIDER_OAUTH_SCOPES,
    resource: PROVIDER_OAUTH_RESOURCE,
    state: input.state,
    nonce: input.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(input.verifier).digest('base64url'),
  }
  if (!input.clientId) params.agent_name_hint = 'a2wave'
  if (input.clientId && input.loginHint) params.login_hint = input.loginHint
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  token_type: z.string().refine((v) => v.toLowerCase() === 'bearer'),
  expires_in: z.number().positive(),
  scope: z.string(),
  earliest_refresh_at: z.union([z.number(), z.string()]).optional(),
})

async function requestTokens(body: URLSearchParams) {
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(PROVIDER_OAUTH_TIMEOUT_MS),
      redirect: 'error',
    })
  } catch {
    throw new ProviderOauthError(
      'provider_oauth_unavailable',
      'ChatGPT authorization service is unavailable; retry later',
      502,
    )
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string }
    const code =
      error.error === 'invalid_grant'
        ? 'provider_oauth_reauth_required'
        : 'provider_oauth_unavailable'
    throw new ProviderOauthError(
      code,
      code === 'provider_oauth_reauth_required'
        ? 'Reconnect this ChatGPT account'
        : 'ChatGPT authorization service rejected the request',
      502,
    )
  }
  const parsed = tokenSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success)
    throw new ProviderOauthError(
      'invalid_token_response',
      'ChatGPT returned an incomplete token response',
      502,
    )
  const scopes = parsed.data.scope.split(/\s+/)
  if (
    !scopes.includes('chatgpt.tokens.use.direct') ||
    !scopes.includes('resource.invoke') ||
    !scopes.includes('offline_access')
  ) {
    throw new ProviderOauthError(
      'missing_plan_scope',
      'Required ChatGPT plan usage scopes were not granted',
    )
  }
  return { ...parsed.data, scopes }
}

async function verifyIdentity(idToken: string, clientId: string, nonce?: string) {
  try {
    const response = await fetch(`${PROVIDER_OAUTH_ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(PROVIDER_OAUTH_TIMEOUT_MS),
      redirect: 'error',
    })
    if (!response.ok) throw new Error('discovery unavailable')
    const discovery = (await response.json()) as { issuer?: string; jwks_uri?: string }
    const jwksUrl = new URL(discovery.jwks_uri ?? '')
    if (discovery.issuer !== PROVIDER_OAUTH_ISSUER || jwksUrl.origin !== PROVIDER_OAUTH_ISSUER)
      throw new Error('unexpected issuer')
    const { payload } = await jwtVerify(
      idToken,
      createRemoteJWKSet(jwksUrl, { timeoutDuration: PROVIDER_OAUTH_TIMEOUT_MS }),
      { issuer: PROVIDER_OAUTH_ISSUER, audience: clientId, requiredClaims: ['exp', 'sub'] },
    )
    if (nonce && payload.nonce !== nonce)
      throw new ProviderOauthError('invalid_nonce', 'ChatGPT ID token nonce did not match')
    if (!payload.sub) throw new Error('missing subject')
    return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : null }
  } catch (error) {
    if (error instanceof ProviderOauthError) throw error
    throw new ProviderOauthError(
      'invalid_id_token',
      'ChatGPT identity token could not be verified',
      502,
    )
  }
}

function expiry(token: z.infer<typeof tokenSchema>) {
  const refreshValue = token.earliest_refresh_at
  const earliestRefreshAt =
    typeof refreshValue === 'number'
      ? new Date(refreshValue * 1000)
      : typeof refreshValue === 'string'
        ? new Date(refreshValue)
        : null
  return {
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
    earliestRefreshAt:
      earliestRefreshAt && Number.isFinite(earliestRefreshAt.getTime()) ? earliestRefreshAt : null,
  }
}

export async function exchangeProviderOauthCode(
  input: ProviderOauthAuthorization & { clientId: string; code: string },
): Promise<ProviderOauthTokens> {
  const token = await requestTokens(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      resource: PROVIDER_OAUTH_RESOURCE,
    }),
  )
  if (!token.id_token)
    throw new ProviderOauthError(
      'invalid_id_token',
      'ChatGPT did not return an identity token',
      502,
    )
  const identity = await verifyIdentity(token.id_token, input.clientId, input.nonce)
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    idToken: token.id_token,
    scopes: token.scopes,
    ...identity,
    ...expiry(token),
  }
}

export async function refreshProviderOauthTokens(input: {
  clientId: string
  refreshToken: string
  subject: string
  email?: string | null
  idToken?: string
}): Promise<ProviderOauthTokens> {
  const token = await requestTokens(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      resource: PROVIDER_OAUTH_RESOURCE,
    }),
  )
  const identity = token.id_token
    ? await verifyIdentity(token.id_token, input.clientId)
    : { subject: input.subject, email: input.email ?? null }
  if (identity.subject !== input.subject)
    throw new ProviderOauthError(
      'account_mismatch',
      'ChatGPT account identity changed; reconnect the selected account',
      409,
    )
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    idToken: token.id_token ?? input.idToken ?? '',
    scopes: token.scopes,
    ...identity,
    ...expiry(token),
  }
}

export async function revokeProviderOauthTokens(
  clientId: string,
  refreshToken: string,
): Promise<void> {
  try {
    const discovery = await fetch(`${PROVIDER_OAUTH_ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(PROVIDER_OAUTH_TIMEOUT_MS),
      redirect: 'error',
    })
    if (!discovery.ok) throw new Error('discovery failed')
    const metadata = (await discovery.json()) as { issuer?: string; revocation_endpoint?: string }
    const endpoint = new URL(metadata.revocation_endpoint ?? '')
    if (metadata.issuer !== PROVIDER_OAUTH_ISSUER || endpoint.origin !== PROVIDER_OAUTH_ISSUER)
      throw new Error('unexpected revocation endpoint')
    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: clientId,
      }),
      signal: AbortSignal.timeout(PROVIDER_OAUTH_TIMEOUT_MS),
      redirect: 'error',
    })
    if (response.status !== 200) throw new Error('revocation not confirmed')
  } catch {
    throw new ProviderOauthError(
      'revocation_unconfirmed',
      'ChatGPT session revocation was not confirmed; the account was kept so you can retry or disconnect it in ChatGPT Settings',
      502,
    )
  }
}
