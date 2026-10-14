import { beforeEach, describe, expect, it, vi } from 'vitest'

const { jwtVerify } = vi.hoisted(() => ({ jwtVerify: vi.fn() }))
vi.mock('jose', () => ({ jwtVerify, createRemoteJWKSet: vi.fn(() => 'jwks') }))

import {
  buildProviderOauthAuthorization,
  exchangeProviderOauthCode,
  refreshProviderOauthTokens,
  revokeProviderOauthTokens,
  validateProviderOauthRedirectUri,
} from '../provider-oauth-protocol.js'

const fetchMock = vi.fn()
const pending = {
  clientId: 'oaiapp_example',
  hostId: 'urn:uuid:host',
  redirectUri: 'http://127.0.0.1:4567/auth/callback',
  state: 'state',
  nonce: 'nonce',
  verifier: 'a'.repeat(64),
}
const tokens = {
  access_token: 'access',
  refresh_token: 'refresh',
  id_token: 'id',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  jwtVerify.mockResolvedValue({
    payload: {
      sub: 'subject',
      iss: 'https://auth.openai.com',
      nonce: 'nonce',
      email: 'person@example.com',
    },
  })
  fetchMock.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('openid-configuration')
            ? {
                issuer: 'https://auth.openai.com',
                jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
              }
            : tokens,
        ),
        { status: 200 },
      ),
  )
})

describe('SIWC protocol', () => {
  it.each([
    'https://127.0.0.1:4567/auth/callback',
    'http://localhost:4567/auth/callback',
    'http://127.0.0.1:4567/callback',
    'http://127.0.0.1:4567/auth/callback?x=1',
  ])('rejects unsupported redirect %s', (uri) => {
    expect(() => validateProviderOauthRedirectUri(uri)).toThrow()
  })
  it('uses dynamic registration only for a new account and binds state/nonce/PKCE to loopback', () => {
    const url = new URL(buildProviderOauthAuthorization({ ...pending, clientId: null }))
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(url.searchParams.get('agent_name_hint')).toBe('a2wave')
    expect(url.searchParams.get('state')).toBe('state')
    expect(url.searchParams.get('nonce')).toBe('nonce')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).not.toBe(pending.verifier)
    expect(
      new URL(buildProviderOauthAuthorization(pending)).searchParams.has('agent_name_hint'),
    ).toBe(false)
  })
  it('keeps a retained identity token out of a reconnect authorization URL', () => {
    const legacyPending = {
      ...pending,
      idTokenHint: 'retained-id-token',
      loginHint: 'person@example.com',
    }
    const url = new URL(buildProviderOauthAuthorization(legacyPending))
    expect(url.searchParams.get('client_id')).toBe(pending.clientId)
    expect(url.searchParams.get('login_hint')).toBe('person@example.com')
    expect(url.searchParams.has('id_token_hint')).toBe(false)
    expect(url.toString()).not.toContain('retained-id-token')
  })
  it('exchanges only against the fixed issuer and verifies the issued audience and nonce', async () => {
    const result = await exchangeProviderOauthCode({ ...pending, code: 'code' })
    expect(result.subject).toBe('subject')
    expect(result.accessToken).toBe('access')
    expect(jwtVerify).toHaveBeenCalledWith(
      'id',
      'jwks',
      expect.objectContaining({ issuer: 'https://auth.openai.com', audience: pending.clientId }),
    )
    const request = fetchMock.mock.calls.find(([url]) => url.endsWith('/oauth/token'))
    expect(request?.[1].body.get('redirect_uri')).toBe(pending.redirectUri)
    expect(request?.[1].body.get('code_verifier')).toBe(pending.verifier)
  })
  it('rejects a wrong nonce even with a valid identity token', async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: 'subject', nonce: 'different' } })
    await expect(exchangeProviderOauthCode({ ...pending, code: 'code' })).rejects.toThrow(/nonce/i)
  })
  it('rejects identity-only grants without plan usage permission', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ...tokens, scope: 'openid profile email' })),
    )
    await expect(exchangeProviderOauthCode({ ...pending, code: 'code' })).rejects.toThrow(/scope/i)
  })
  it('retains scopes on refresh and returns rotating credentials together', async () => {
    const result = await refreshProviderOauthTokens({
      clientId: pending.clientId,
      refreshToken: 'old',
      subject: 'subject',
    })
    expect(result.refreshToken).toBe('refresh')
    const request = fetchMock.mock.calls.find(([url]) => url.endsWith('/oauth/token'))
    expect(request?.[1].body.get('grant_type')).toBe('refresh_token')
    expect(request?.[1].body.has('scope')).toBe(false)
  })
})

describe('ChatGPT session revocation', () => {
  it('posts the refresh credential to the issuer-discovered endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issuer: 'https://auth.openai.com',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        }),
      ),
    )
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }))
    await revokeProviderOauthTokens('client', 'refresh-secret')
    const [url, request] = fetchMock.mock.calls[1]
    expect(url).toBe('https://auth.openai.com/api/accounts/oauth/revoke')
    expect(Object.fromEntries(request.body)).toEqual({
      token: 'refresh-secret',
      token_type_hint: 'refresh_token',
      client_id: 'client',
    })
    expect(request.signal).toBeInstanceOf(AbortSignal)
  })
  it('does not claim a successful disconnect on a server failure', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issuer: 'https://auth.openai.com',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        }),
      ),
    )
    fetchMock.mockResolvedValueOnce(new Response('sensitive upstream details', { status: 503 }))
    await expect(revokeProviderOauthTokens('client', 'refresh-secret')).rejects.toThrow(
      /kept so you can retry/,
    )
  })
  it('never sends credentials to a different origin from discovery metadata', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issuer: 'https://auth.openai.com',
          revocation_endpoint: 'https://other.example/revoke',
        }),
      ),
    )
    await expect(revokeProviderOauthTokens('client', 'refresh-secret')).rejects.toThrow(
      /not confirmed/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
