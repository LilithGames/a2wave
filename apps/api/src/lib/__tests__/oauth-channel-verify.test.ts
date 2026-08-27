/**
 * Tests for the **real** OAuth-channel verifier (no mock of lib/oidc.js).
 *
 * This path is the whole authentication boundary for `publishAuthType: 'oauth'`, and its
 * consumer's test file mocks it out — so without this file nothing asserts that the audience
 * allowlist is enforced, that an unconfigured channel fails closed, or that a token signed by
 * an unknown key is rejected. A regression in any of those ships green.
 *
 * `openid-client`'s `discovery` is mocked to return metadata pointing at a locally served
 * JWKS, so verification exercises the production jwtVerify/JWKS fetch path without reaching a
 * real IdP. The mock sits at the module boundary rather than on an exported function of
 * lib/oidc.ts: within an ES module, internal calls bind locally, so spying on
 * `getOidcConfiguration`/`getOidcEnv` would not intercept the callers inside the same file.
 */
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ISSUER = 'https://idp.example.test'
const CLIENT_ID = 'a2wave-web'
const CALLER_AUD = 'partner-service'

const state = vi.hoisted(() => ({
  jwksUri: '',
  discoveryCalls: 0,
  userInfoCalls: [] as unknown[][],
  discovery: (..._args: unknown[]): Promise<unknown> => Promise.reject(new Error('not set')),
  fetchUserInfo: (..._args: unknown[]): Promise<unknown> => Promise.reject(new Error('not set')),
}))

vi.mock('../sso-settings.js', () => ({
  // Force the env branch of resolveOidcEnv so tests drive config through process.env only.
  readSsoDbConfig: () => null,
  readOidcClientSecret: () => undefined,
}))
vi.mock('../settings.js', () => ({ getCategorySettings: () => ({}) }))
vi.mock('openid-client', () => ({
  discovery: (...args: unknown[]) => state.discovery(...args),
  fetchUserInfo: (...args: unknown[]) => {
    state.userInfoCalls.push(args)
    return state.fetchUserInfo(...args)
  },
  allowInsecureRequests: Symbol('allowInsecureRequests'),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../user-status.js', () => ({ isSsoAccountDisabled: () => false }))

import { validateGatewayAuth } from '../../middleware/gateway-auth.js'
import {
  enrichOidcIdentityFromUserInfo,
  isIdpUnavailableError,
  isOauthChannelConfigured,
  isOidcConfigured,
  oauthChannelAudiences,
  resetOidcForTests,
  verifyOauthChannelToken,
} from '../oidc.js'

let signingKey: KeyLike
let foreignKey: KeyLike
let jwksBody: string
let server: import('node:http').Server

async function issue(claims: Record<string, unknown>, key: KeyLike = signingKey): Promise<string> {
  return new SignJWT({ sub: 'user-1', email: 'user@example.com', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}

beforeAll(async () => {
  const [pair, foreign] = await Promise.all([
    generateKeyPair('RS256', { extractable: true }),
    generateKeyPair('RS256', { extractable: true }),
  ])
  signingKey = pair.privateKey
  foreignKey = foreign.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  jwksBody = JSON.stringify({ keys: [jwk] })

  const { createServer } = await import('node:http')
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(jwksBody)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  state.jwksUri = `http://127.0.0.1:${addr.port}/jwks`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  vi.stubEnv('A2WAVE_OIDC_ISSUER', ISSUER)
  vi.stubEnv('A2WAVE_OIDC_CLIENT_ID', CLIENT_ID)
  vi.stubEnv('A2WAVE_OIDC_CHANNEL_AUDIENCES', CALLER_AUD)
  resetOidcForTests()
  state.discoveryCalls = 0
  state.userInfoCalls = []
  state.fetchUserInfo = () => Promise.reject(new Error('unexpected UserInfo request'))
  state.discovery = () => {
    state.discoveryCalls += 1
    return Promise.resolve({
      serverMetadata: () => ({ issuer: ISSUER, jwks_uri: state.jwksUri }),
    })
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetOidcForTests()
})

describe('oauthChannelAudiences', () => {
  it('contains exactly the configured allowlist — clientId is NOT folded in', async () => {
    // Folding clientId in implicitly turned "can sign in to the console" into "can invoke
    // every all_idaas_users Agent", and made the empty-allowlist gate below unreachable.
    expect(await oauthChannelAudiences()).toEqual([CALLER_AUD])
    expect(await oauthChannelAudiences()).not.toContain(CLIENT_ID)
  })

  it('is empty when OIDC is unconfigured', async () => {
    vi.stubEnv('A2WAVE_OIDC_ISSUER', '')
    resetOidcForTests()
    expect(await oauthChannelAudiences()).toEqual([])
  })
})

describe('isOauthChannelConfigured', () => {
  /**
   * The invariant this whole predicate exists for: the `enabled` flag gates the *login*
   * entry point only. An admin disabling OIDC login (to force password-only sign-in, or
   * after moving to SAML) must not 503 every already-published OAuth Agent.
   */
  it('stays true when the OIDC login method is disabled', async () => {
    // The DB branch is the only one carrying `enabled: false` (env config is always enabled),
    // so this case re-mocks readSsoDbConfig for a freshly imported module instance.
    vi.resetModules()
    vi.doMock('../sso-settings.js', () => ({
      readSsoDbConfig: () => ({
        enabled: false,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        scopes: '',
        channelAudiences: [CALLER_AUD],
        callbackOrigin: '',
      }),
      readOidcClientSecret: () => undefined,
    }))
    try {
      const mod = await import('../oidc.js')
      mod.resetOidcForTests()

      expect(await mod.isOidcConfigured()).toBe(false)
      expect(await mod.isOauthChannelConfigured()).toBe(true)
    } finally {
      // In a finally block: if an expectation above fails, leaving the sso-settings mock
      // registered would leak into every later test in this file and turn one real failure
      // into an unrelated cascade.
      vi.doUnmock('../sso-settings.js')
      vi.resetModules()
    }
  })

  it('is false when the audience allowlist is empty (fail closed)', async () => {
    vi.stubEnv('A2WAVE_OIDC_CHANNEL_AUDIENCES', '')
    resetOidcForTests()
    expect(await oauthChannelAudiences()).toEqual([])
    expect(await isOauthChannelConfigured()).toBe(false)
  })

  it('is false when OIDC is not configured at all', async () => {
    vi.stubEnv('A2WAVE_OIDC_ISSUER', '')
    resetOidcForTests()
    expect(await isOauthChannelConfigured()).toBe(false)
    expect(await isOidcConfigured()).toBe(false)
  })
})

describe('verifyOauthChannelToken', () => {
  it('accepts a token whose aud is on the allowlist', async () => {
    const info = await verifyOauthChannelToken(await issue({ aud: CALLER_AUD }))
    expect(info).toMatchObject({ sub: 'user-1', issuer: ISSUER, email: 'user@example.com' })
    expect(state.userInfoCalls).toHaveLength(0)
  })

  it('fills a missing email from the standard UserInfo endpoint', async () => {
    state.fetchUserInfo = async () => ({
      sub: 'user-1',
      email: 'user@example.com',
      name: 'Example User',
    })
    const token = await issue({ aud: CALLER_AUD, email: undefined })

    const info = await verifyOauthChannelToken(token)

    expect(info).toMatchObject({
      sub: 'user-1',
      issuer: ISSUER,
      email: 'user@example.com',
      username: 'Example User',
    })
    expect(state.userInfoCalls).toHaveLength(1)
    expect(state.userInfoCalls[0]?.[1]).toBe(token)
    expect(state.userInfoCalls[0]?.[2]).toBe('user-1')
  })

  it('authorizes a UserInfo-resolved email through the specified-users allowlist', async () => {
    state.fetchUserInfo = async () => ({
      sub: 'user-1',
      email: 'allowlisted@example.com',
      email_verified: true,
    })
    const token = await issue({ aud: CALLER_AUD, email: undefined })

    const result = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: ['allowlisted@example.com'],
      },
      { clientIp: '127.0.0.1', authorizationHeader: `Bearer ${token}` },
    )

    expect(result.error).toBeUndefined()
    expect(result.caller?.userInfo.email).toBe('allowlisted@example.com')
    expect(state.userInfoCalls).toHaveLength(1)
  })

  it('never overwrites or upgrades an email identity that the JWT already supplied', async () => {
    state.fetchUserInfo = async () => ({
      sub: 'user-1',
      email: 'userinfo@example.com',
      email_verified: true,
    })

    const verified = await enrichOidcIdentityFromUserInfo('access-token', {
      sub: 'user-1',
      userId: 'user-1',
      issuer: ISSUER,
      email: 'jwt@example.com',
      raw: { sub: 'user-1', email: 'jwt@example.com' },
    })
    const unverified = await enrichOidcIdentityFromUserInfo('access-token', {
      sub: 'user-1',
      userId: 'user-1',
      issuer: ISSUER,
      unverifiedEmail: 'unverified-jwt@example.com',
      raw: {
        sub: 'user-1',
        email: 'unverified-jwt@example.com',
        email_verified: false,
      },
    })

    expect(verified.email).toBe('jwt@example.com')
    expect(unverified.email).toBeUndefined()
    expect(unverified.unverifiedEmail).toBe('unverified-jwt@example.com')
  })

  it('preserves unverified UserInfo email and fills other omitted identity fields', async () => {
    state.fetchUserInfo = async () => ({
      sub: 'user-1',
      email: 'unverified@example.com',
      email_verified: false,
      name: 'Example User',
      phone_number: '+1-555-0100',
      tenant_id: 'tenant-1',
      union_id: 'union-1',
    })

    const info = await enrichOidcIdentityFromUserInfo('access-token', {
      sub: 'user-1',
      userId: 'user-1',
      issuer: ISSUER,
      raw: { sub: 'user-1' },
    })

    expect(info).toMatchObject({
      unverifiedEmail: 'unverified@example.com',
      username: 'Example User',
      mobile: '+1-555-0100',
      tenantId: 'tenant-1',
      unionId: 'union-1',
    })
    expect(info.email).toBeUndefined()
  })

  it('does not call UserInfo when the token carries an explicitly unverified email', async () => {
    const info = await verifyOauthChannelToken(
      await issue({
        aud: CALLER_AUD,
        email: 'unverified@example.com',
        email_verified: false,
      }),
    )

    expect(info.email).toBeUndefined()
    expect(info.unverifiedEmail).toBe('unverified@example.com')
    expect(state.userInfoCalls).toHaveLength(0)
  })

  it('keeps the caller email-less when UserInfo returns no email', async () => {
    state.fetchUserInfo = async () => ({ sub: 'user-1', name: 'Example User' })

    const info = await verifyOauthChannelToken(await issue({ aud: CALLER_AUD, email: undefined }))

    expect(info.email).toBeUndefined()
    expect(info.username).toBe('Example User')
    expect(state.userInfoCalls).toHaveLength(1)
  })

  it('classifies a UserInfo subject mismatch as a caller token fault', async () => {
    state.fetchUserInfo = async () => {
      throw Object.assign(new Error('unexpected UserInfo sub'), {
        code: 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED',
      })
    }

    const error = await verifyOauthChannelToken(
      await issue({ aud: CALLER_AUD, email: undefined }),
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(isIdpUnavailableError(error)).toBe(false)
  })

  it.each(['OAUTH_RESPONSE_BODY_ERROR', 'OAUTH_WWW_AUTHENTICATE_CHALLENGE'])(
    'classifies a UserInfo token rejection (%s) as a caller token fault',
    (code) => {
      expect(
        isIdpUnavailableError(Object.assign(new Error('access token rejected'), { code })),
      ).toBe(false)
    },
  )

  it('classifies an unreachable UserInfo endpoint as an IdP availability failure', async () => {
    state.fetchUserInfo = async () => {
      throw new TypeError('fetch failed')
    }

    const error = await verifyOauthChannelToken(
      await issue({ aud: CALLER_AUD, email: undefined }),
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(isIdpUnavailableError(error)).toBe(true)
  })

  it('rejects an a2wave login token unless clientId is explicitly allowlisted', async () => {
    // An id_token minted for a2wave's own login is a console-sign-in credential, not an
    // Agent-invocation grant. Deployments that want that must say so in the allowlist.
    await expect(verifyOauthChannelToken(await issue({ aud: CLIENT_ID }))).rejects.toThrow()
  })

  it('accepts an a2wave login token once clientId is explicitly allowlisted', async () => {
    vi.stubEnv('A2WAVE_OIDC_CHANNEL_AUDIENCES', `${CALLER_AUD},${CLIENT_ID}`)
    resetOidcForTests()
    const info = await verifyOauthChannelToken(await issue({ aud: CLIENT_ID }))
    expect(info.sub).toBe('user-1')
  })

  /**
   * The regression this file exists for. Skipping `aud` entirely — which is what passing
   * `undefined` to jose does — accepts every token the IdP ever signed for any relying
   * party, and `oauthAccessMode='all_idaas_users'` has no second gate behind it.
   */
  it('rejects a token minted for a different relying party at the same IdP', async () => {
    await expect(verifyOauthChannelToken(await issue({ aud: 'some-other-app' }))).rejects.toThrow()
  })

  it('rejects a token with no aud claim', async () => {
    await expect(verifyOauthChannelToken(await issue({}))).rejects.toThrow()
  })

  it('rejects a token signed by a key absent from the IdP JWKS', async () => {
    await expect(
      verifyOauthChannelToken(await issue({ aud: CALLER_AUD }, foreignKey)),
    ).rejects.toThrow()
  })

  it('rejects a token from a different issuer', async () => {
    const token = await new SignJWT({ sub: 'user-1', aud: CALLER_AUD })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://evil.example.test')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey)
    await expect(verifyOauthChannelToken(token)).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const token = await new SignJWT({ sub: 'user-1', aud: CALLER_AUD })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(signingKey)
    await expect(verifyOauthChannelToken(token)).rejects.toThrow()
  })

  it('fails closed before any network call when OIDC is unconfigured', async () => {
    vi.stubEnv('A2WAVE_OIDC_ISSUER', '')
    resetOidcForTests()
    const token = await issue({ aud: CALLER_AUD })
    await expect(verifyOauthChannelToken(token)).rejects.toThrow(/not configured/)
    expect(state.discoveryCalls).toBe(0)
  })
})
