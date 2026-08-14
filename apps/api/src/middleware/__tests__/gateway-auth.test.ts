import { type JWK, type KeyLike, SignJWT, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OAuth 渠道验签走企业 OIDC（lib/oidc.js）。真实实现要拉 IdP discovery + JWKS，
 * 测试里换成同契约的本地验签：用本文件生成的密钥对校验签名与 issuer，claims 归一
 * 复用生产的 oidcClaimsToUserInfo —— 既不联网，又保留「签名/issuer/claims 任一不对
 * 就抛错」这一被测行为。configureOidc() 之前渠道判定为 false，用于覆盖
 * 「未配置返回 503」。
 */
const oidcState: {
  configured: boolean
  issuer: string
  key: KeyLike | null
  /** Simulate a discovery/JWKS fetch fault (a non-JOSE error) rather than a bad token. */
  networkFailure: boolean
} = {
  configured: false,
  issuer: '',
  key: null,
  networkFailure: false,
}
vi.mock('../../lib/oidc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/oidc.js')>()
  const { jwtVerify } = await import('jose')
  return {
    ...actual,
    isOidcConfigured: () => oidcState.configured,
    // The middleware gates on the *channel* predicate, not the login one — see the note on
    // isOauthChannelConfigured. Kept distinct here so a regression that swaps them back
    // (disabling OIDC login and 503-ing every published Agent) fails this file.
    isOauthChannelConfigured: () => oidcState.configured,
    getOidcEnv: () => (oidcState.configured ? { issuer: oidcState.issuer } : null),
    // NOTE: this stand-in verifies signature + issuer only. The **audience allowlist** is
    // deliberately not modelled here — it belongs to the verifier, and is covered against the
    // real implementation in lib/__tests__/oauth-channel-verify.test.ts. Do not read a passing
    // test in this file as evidence that `aud` is enforced.
    verifyOauthChannelToken: async (token: string) => {
      if (oidcState.networkFailure) throw new TypeError('fetch failed')
      if (!oidcState.key) throw new Error('OIDC is not configured')
      const { payload } = await jwtVerify(token, oidcState.key, {
        issuer: oidcState.issuer,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'sub'],
      })
      return actual.oidcClaimsToUserInfo(payload, oidcState.issuer)
    },
  }
})

// The OAuth branch gates on the local account being enabled. Default: the caller has
// no local a2wave account (external IdP user), which must stay allowed.
const mockIsSsoAccountDisabled = vi.hoisted(() => vi.fn(() => false))
vi.mock('../../lib/user-status.js', () => ({
  isSsoAccountDisabled: mockIsSsoAccountDisabled,
}))

import { GatewayAuthErrors } from '../../lib/gateway-auth-errors.js'
import { isIpInWhitelist, normalizeAuthType, validateGatewayAuth } from '../gateway-auth.js'

describe('isIpInWhitelist', () => {
  it('returns false for unknown client IP', async () => {
    expect(isIpInWhitelist('unknown', '10.0.0.1')).toBe(false)
  })

  it('returns false for empty entry', async () => {
    expect(isIpInWhitelist('10.0.0.1', '')).toBe(false)
    expect(isIpInWhitelist('10.0.0.1', '   ')).toBe(false)
  })

  it('returns true on exact IP match', async () => {
    expect(isIpInWhitelist('192.168.1.100', '192.168.1.100')).toBe(true)
  })

  it('returns false on exact IP non-match', async () => {
    expect(isIpInWhitelist('192.168.1.100', '192.168.1.200')).toBe(false)
  })

  it('matches CIDR /24', async () => {
    expect(isIpInWhitelist('10.0.1.55', '10.0.1.0/24')).toBe(true)
  })

  it('rejects IP outside CIDR /24', async () => {
    expect(isIpInWhitelist('10.0.2.55', '10.0.1.0/24')).toBe(false)
  })

  it('CIDR /0 matches everything', async () => {
    expect(isIpInWhitelist('1.2.3.4', '0.0.0.0/0')).toBe(true)
    expect(isIpInWhitelist('255.255.255.255', '0.0.0.0/0')).toBe(true)
  })

  it('CIDR /32 is exact match', async () => {
    expect(isIpInWhitelist('10.0.0.1', '10.0.0.1/32')).toBe(true)
    expect(isIpInWhitelist('10.0.0.2', '10.0.0.1/32')).toBe(false)
  })

  it('returns false for invalid CIDR prefix', async () => {
    expect(isIpInWhitelist('10.0.0.1', '10.0.0.0/33')).toBe(false)
    expect(isIpInWhitelist('10.0.0.1', '10.0.0.0/-1')).toBe(false)
    expect(isIpInWhitelist('10.0.0.1', '10.0.0.0/abc')).toBe(false)
  })
})

describe('normalizeAuthType', () => {
  it('returns "none" only for explicit "none"', async () => {
    expect(normalizeAuthType('none')).toBe('none')
  })

  it('returns "oauth" only for explicit "oauth"', async () => {
    expect(normalizeAuthType('oauth')).toBe('oauth')
  })

  it('defaults to "api_key" for null (legacy rows must require auth, not be open)', async () => {
    expect(normalizeAuthType(null)).toBe('api_key')
  })

  it('defaults to "api_key" for undefined', async () => {
    expect(normalizeAuthType(undefined)).toBe('api_key')
  })

  it('defaults to "api_key" for unknown string', async () => {
    expect(normalizeAuthType('something_else')).toBe('api_key')
    expect(normalizeAuthType('')).toBe('api_key')
  })
})

describe('validateGatewayAuth: legacy null publishAuthType regression', () => {
  it('treats null publishAuthType as api_key (NOT none — security regression guard)', async () => {
    const result = await validateGatewayAuth(
      { publishIpWhitelist: null, publishAuthType: null, endpointApiKey: 'shh' },
      { clientIp: '1.2.3.4' /* no Authorization header */ },
    )
    expect(result.error).toEqual({ error: 'Missing Authorization header', status: 401 })
  })

  it('treats unknown publishAuthType string as api_key', async () => {
    const result = await validateGatewayAuth(
      { publishIpWhitelist: null, publishAuthType: 'mystery_mode', endpointApiKey: 'shh' },
      { clientIp: '1.2.3.4' },
    )
    expect(result.error).toEqual({ error: 'Missing Authorization header', status: 401 })
  })
})

describe('validateGatewayAuth (none / api_key)', () => {
  it('returns ok when no IP whitelist and authType is none', async () => {
    const result = await validateGatewayAuth(
      { publishIpWhitelist: null, publishAuthType: 'none', endpointApiKey: null },
      { clientIp: '1.2.3.4' },
    )
    expect(result.error).toBeUndefined()
    expect(result.caller).toBeUndefined()
  })

  it('returns error when IP not in whitelist', async () => {
    const result = await validateGatewayAuth(
      { publishIpWhitelist: ['10.0.0.1'], publishAuthType: 'none', endpointApiKey: null },
      { clientIp: '10.0.0.2' },
    )
    expect(result.error).toEqual({ error: 'IP not allowed', status: 403 })
  })

  it('returns ok when IP is in whitelist', async () => {
    const result = await validateGatewayAuth(
      { publishIpWhitelist: ['10.0.0.0/24'], publishAuthType: 'none', endpointApiKey: null },
      { clientIp: '10.0.0.55' },
    )
    expect(result.error).toBeUndefined()
  })

  it('returns error when auth required but no Authorization header', async () => {
    const result = await validateGatewayAuth(
      { publishIpWhitelist: null, publishAuthType: 'api_key', endpointApiKey: 'secret' },
      { clientIp: '1.2.3.4' },
    )
    expect(result.error).toEqual({ error: 'Missing Authorization header', status: 401 })
  })

  it('returns error when API key does not match', async () => {
    const result = await validateGatewayAuth(
      { publishIpWhitelist: null, publishAuthType: 'api_key', endpointApiKey: 'correct-key' },
      { clientIp: '1.2.3.4', authorizationHeader: 'Bearer wrong-key' },
    )
    expect(result.error).toEqual({ error: 'Invalid token', status: 403 })
  })

  it('returns ok when API key matches with Bearer prefix', async () => {
    const result = await validateGatewayAuth(
      { publishIpWhitelist: null, publishAuthType: 'api_key', endpointApiKey: 'my-secret' },
      { clientIp: '1.2.3.4', authorizationHeader: 'Bearer my-secret' },
    )
    expect(result.error).toBeUndefined()
  })

  it('returns ok when API key matches without Bearer prefix', async () => {
    const result = await validateGatewayAuth(
      { publishIpWhitelist: null, publishAuthType: 'api_key', endpointApiKey: 'my-secret' },
      { clientIp: '1.2.3.4', authorizationHeader: 'my-secret' },
    )
    expect(result.error).toBeUndefined()
  })

  it('skips IP check when whitelist is empty array', async () => {
    const result = await validateGatewayAuth(
      { publishIpWhitelist: [], publishAuthType: 'none', endpointApiKey: null },
      { clientIp: 'unknown' },
    )
    expect(result.error).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// OAuth branch
// ---------------------------------------------------------------------------
describe('validateGatewayAuth (oauth)', () => {
  const ISSUER = 'https://idaas.example.test/'
  const AUD = 'testplugin_jwt62'
  const KID = 'kid-1'

  let privateKey: KeyLike
  let publicKey: KeyLike

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true })
    privateKey = pair.privateKey
    publicKey = pair.publicKey
  })

  beforeEach(() => {
    oidcState.configured = false
    oidcState.issuer = ''
    oidcState.key = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function configureEnv() {
    oidcState.configured = true
    oidcState.issuer = ISSUER
    oidcState.key = publicKey
  }

  async function makeToken(claims: Record<string, unknown> = {}): Promise<string> {
    // Default email is present so the allowlist gate has an address to match.
    // Tests that specifically exercise the "no email" path override with email: undefined.
    return new SignJWT({ sub: 'user-x', email: 'user-x@example.com', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }

  it('returns 503 when oauth strategy is not configured', async () => {
    const result = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
      },
      { clientIp: '1.2.3.4', authorizationHeader: 'Bearer whatever' },
    )
    expect(result.error).toEqual({ error: 'OAuth not configured', status: 503 })
  })

  it('returns 401 when Authorization header is missing', async () => {
    configureEnv()
    const result = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
      },
      { clientIp: '1.2.3.4' },
    )
    expect(result.error).toEqual({ error: 'Missing Authorization header', status: 401 })
  })

  /**
   * Verification now reaches the IdP (discovery + JWKS), so a failure is not necessarily the
   * caller's fault. Reporting an outage as 401 tells every integrator their credentials broke
   * and sends them rotating tokens that were fine, while the real problem is upstream.
   */
  it('returns 503, not 401, when the IdP itself is unreachable', async () => {
    configureEnv()
    const previous = oidcState.key
    // Any non-JOSE error stands in for a discovery/JWKS network fault.
    oidcState.key = null
    oidcState.networkFailure = true
    try {
      const result = await validateGatewayAuth(
        {
          publishIpWhitelist: null,
          publishAuthType: 'oauth',
          endpointApiKey: null,
        },
        { clientIp: '1.2.3.4', authorizationHeader: 'Bearer whatever' },
      )
      expect(result.error).toEqual({ error: 'Identity provider unavailable', status: 503 })
    } finally {
      oidcState.key = previous
      oidcState.networkFailure = false
    }
  })

  it('returns 401 when token is invalid (bad signature / wrong issuer)', async () => {
    configureEnv()
    // Forge a token with wrong issuer
    const bad = await new SignJWT({ sub: 'user-y' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer('https://evil.example.com/')
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const result = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${bad}` },
    )
    expect(result.error).toEqual({ error: 'Invalid token', status: 401 })
  })

  it('returns 401 when token is malformed (random string)', async () => {
    configureEnv()
    const result = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
      },
      { clientIp: '1.2.3.4', authorizationHeader: 'Bearer not-a-jwt' },
    )
    expect(result.error).toEqual({ error: 'Invalid token', status: 401 })
  })

  it('returns caller with IdP userInfo on a valid token', async () => {
    configureEnv()
    const token = await makeToken({
      email: 'eve@example.com',
      idpUsername: 'eve',
      tenant_id: 't1',
    })
    const result = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${token}` },
    )
    expect(result.error).toBeUndefined()
    expect(result.caller).toBeDefined()
    expect(result.caller!.kind).toBe('idaas_user')
    expect(result.caller!.userInfo.sub).toBe('user-x')
    expect(result.caller!.userInfo.email).toBe('eve@example.com')
    expect(result.caller!.userInfo.username).toBe('eve')
    expect(result.caller!.userInfo.tenantId).toBe('t1')
    expect(result.caller!.userInfo.issuer).toBe(ISSUER)
  })

  it('still enforces IP whitelist before oauth check', async () => {
    configureEnv()
    const token = await makeToken()
    const result = await validateGatewayAuth(
      {
        publishIpWhitelist: ['10.0.0.1'],
        publishAuthType: 'oauth',
        endpointApiKey: null,
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${token}` },
    )
    expect(result.error).toEqual({ error: 'IP not allowed', status: 403 })
  })

  it('accepts a token without Bearer prefix', async () => {
    configureEnv()
    const token = await makeToken()
    const result = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
      },
      { clientIp: '1.2.3.4', authorizationHeader: token },
    )
    expect(result.error).toBeUndefined()
    expect(result.caller?.kind).toBe('idaas_user')
  })

  it('accepts lowercase bearer scheme (RFC 6750 case-insensitive)', async () => {
    configureEnv()
    const token = await makeToken()
    const result = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
      },
      { clientIp: '1.2.3.4', authorizationHeader: `bearer ${token}` },
    )
    expect(result.error).toBeUndefined()
    expect(result.caller?.kind).toBe('idaas_user')
  })

  it('accepts uppercase BEARER with tab separator', async () => {
    configureEnv()
    const token = await makeToken()
    const result = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
      },
      { clientIp: '1.2.3.4', authorizationHeader: `BEARER\t${token}` },
    )
    expect(result.error).toBeUndefined()
    expect(result.caller?.kind).toBe('idaas_user')
  })
})

// ---------------------------------------------------------------------------
// OAuth + specified-users allowlist gate
// ---------------------------------------------------------------------------
describe('validateGatewayAuth (oauth + specified users gate)', () => {
  const ISSUER = 'https://idaas.example.test/'
  const AUD = 'testplugin_jwt62'
  const KID = 'kid-1'

  let privateKey: KeyLike

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true })
    privateKey = pair.privateKey
    oidcState.key = pair.publicKey
  })

  beforeEach(() => {
    oidcState.configured = true
    oidcState.issuer = ISSUER
  })

  async function token(claims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({ sub: 'user-x', email: 'alice@example.com', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }

  /**
   * The default is the *open* mode now, so a row that predates `oauthAccessMode` (NULL) admits
   * any verified OIDC-authenticated user. That is only safe because the retired `feishu_scope`
   * rows are migrated to `specified_users`, never left to fall through to this default.
   */
  it('defaults to all_idaas_users when the mode is absent', async () => {
    const t = await token()
    const r = await validateGatewayAuth(
      { publishIpWhitelist: null, publishAuthType: 'oauth', endpointApiKey: null },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toBeUndefined()
    expect(r.caller?.userInfo.email).toBe('alice@example.com')
  })

  it('returns caller without consulting any allowlist in all_idaas_users mode', async () => {
    const t = await token()
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'all_idaas_users',
        // Present but irrelevant: a stale list must not restrict the open mode.
        oauthAllowedEmails: ['someone-else@example.com'],
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toBeUndefined()
    expect(r.caller?.kind).toBe('idaas_user')
    expect(r.caller?.userInfo.email).toBe('alice@example.com')
  })

  it('admits a caller listed in specified_users', async () => {
    const t = await token()
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: ['bob@example.com', 'alice@example.com'],
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toBeUndefined()
    expect(r.caller?.userInfo.email).toBe('alice@example.com')
  })

  it('rejects a caller absent from the specified_users list', async () => {
    const t = await token()
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: ['bob@example.com'],
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toEqual({ error: GatewayAuthErrors.NOT_IN_ALLOWED_USERS, status: 403 })
    expect(r.caller).toBeUndefined()
  })

  /**
   * The state every migrated `feishu_scope` Agent lands in. Reading "no entries" as "no
   * restriction" would turn the upgrade into a silent widening of exactly the Agents whose
   * owners had deliberately restricted them.
   */
  it('denies everyone when the specified_users list is empty', async () => {
    const t = await token()
    for (const list of [[], null, undefined]) {
      const r = await validateGatewayAuth(
        {
          publishIpWhitelist: null,
          publishAuthType: 'oauth',
          endpointApiKey: null,
          oauthAccessMode: 'specified_users',
          oauthAllowedEmails: list,
        },
        { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
      )
      expect(r.error).toEqual({ error: GatewayAuthErrors.NOT_IN_ALLOWED_USERS, status: 403 })
    }
  })

  // The IdP decides the casing of its `email` claim, and an owner types the list by hand.
  // Comparing them verbatim would lock out a correctly-listed colleague over letter case.
  it('matches the allowlist case-insensitively and ignores surrounding whitespace', async () => {
    const t = await token({ email: 'Alice@Example.com' })
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: ['  ALICE@example.COM '],
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toBeUndefined()
    expect(r.caller?.kind).toBe('idaas_user')
  })

  /**
   * Was "allows all_idaas_users mode even when the token has no email claim". The email is
   * not needed for the Feishu lookup here, but it *is* needed for revocation:
   * isSsoAccountDisabled falls back to matching by email, and that hop is short-circuited
   * when the claim is absent — so an email-less token could outlive the disabling of its
   * own account. Both access modes now require it.
   */
  it('rejects a token with no email claim even in all_idaas_users mode', async () => {
    const t = await new SignJWT({ sub: 'no-email' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'all_idaas_users',
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toEqual({ error: GatewayAuthErrors.MISSING_EMAIL_CLAIM, status: 403 })
    expect(r.caller).toBeUndefined()
  })

  /**
   * An `email_verified: false` address is excluded from `userInfo.email` (it is the account
   * merge key, and an unverified address is user-selectable) but is still usable for the
   * revocation lookup, where it can only ever match *more* disabled rows. Rejecting these
   * callers outright broke every deployment whose IdP marks service accounts unverified —
   * the login path survives it by backfilling from userinfo, which this path cannot do.
   */
  it('admits a caller whose email is present but marked unverified (all_idaas_users)', async () => {
    const t = await new SignJWT({
      sub: 'u-unverified',
      email: 'svc@example.com',
      email_verified: false,
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'all_idaas_users',
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toBeUndefined()
    expect(r.caller?.userInfo.sub).toBe('u-unverified')
    // The unverified address must not be promoted into `email`, which is the merge key.
    expect(r.caller?.userInfo.email).toBeUndefined()
    expect(r.caller?.userInfo.unverifiedEmail).toBe('svc@example.com')
  })

  it('still revocation-checks that caller using the unverified address', async () => {
    // Restored in `finally`: leaking a `true` here would make every later test in this file
    // fail as "Account is disabled" — one real failure turning into a cascade.
    mockIsSsoAccountDisabled.mockReturnValue(true)
    try {
      const t = await new SignJWT({
        sub: 'u-unverified',
        email: 'svc@example.com',
        email_verified: false,
      })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(ISSUER)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
      const r = await validateGatewayAuth(
        {
          publishIpWhitelist: null,
          publishAuthType: 'oauth',
          endpointApiKey: null,
          oauthAccessMode: 'all_idaas_users',
        },
        { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
      )
      expect(r.error).toEqual({ error: GatewayAuthErrors.ACCOUNT_DISABLED, status: 403 })
      expect(mockIsSsoAccountDisabled).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'svc@example.com' }),
      )
    } finally {
      mockIsSsoAccountDisabled.mockReturnValue(false)
    }
  })

  /**
   * The allowlist decides who gets in, so it needs a *verified* address — a stricter bar than
   * the revocation gate, which accepts an unverified one because it can only ever match more
   * disabled rows. A self-asserted address would otherwise let a caller simply claim a listed
   * colleague's mailbox.
   */
  it('rejects an unverified address in specified_users mode even if it is listed', async () => {
    const t = await new SignJWT({
      sub: 'u-unverified',
      email: 'svc@example.com',
      email_verified: false,
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: ['svc@example.com'],
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toEqual({ error: GatewayAuthErrors.MISSING_VERIFIED_EMAIL, status: 403 })
  })

  it('returns 403 when the external JWT has no email claim', async () => {
    const t = await new SignJWT({ sub: 'no-email' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: ['alice@example.com'],
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toEqual({ error: 'Token missing email claim', status: 403 })
  })

  // The allowlist belongs to the oauth branch alone; the other auth types must not start
  // consulting it and lock out callers who never presented an SSO identity at all.
  it('does NOT consult the allowlist for api_key auth type', async () => {
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'api_key',
        endpointApiKey: 'k',
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: [],
      },
      { clientIp: '1.2.3.4', authorizationHeader: 'Bearer k' },
    )
    expect(r.error).toBeUndefined()
  })

  it('does NOT consult the allowlist for none auth type', async () => {
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'none',
        endpointApiKey: null,
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: [],
      },
      { clientIp: '1.2.3.4' },
    )
    expect(r.error).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Disabled-account gate — an admin disabling a user must also cut off the OAuth
// invocation path, otherwise "disabled" would not mean disabled for a leaver.
// ---------------------------------------------------------------------------
describe('validateGatewayAuth (oauth + disabled account gate)', () => {
  const ISSUER = 'https://idaas.example.test/'
  const AUD = 'testplugin_jwt62'
  const KID = 'kid-1'

  let privateKey: KeyLike

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true })
    privateKey = pair.privateKey
    oidcState.key = pair.publicKey
  })

  beforeEach(() => {
    oidcState.configured = true
    oidcState.issuer = ISSUER
    mockIsSsoAccountDisabled.mockReset()
    mockIsSsoAccountDisabled.mockReturnValue(false)
  })

  async function token(claims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({ sub: 'user-x', email: 'alice@example.com', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }

  it('rejects a disabled account in all_idaas_users mode', async () => {
    mockIsSsoAccountDisabled.mockReturnValue(true)
    const t = await token()
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'all_idaas_users',
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toEqual({ error: 'Account is disabled', status: 403 })
    expect(r.caller).toBeUndefined()
  })

  // Revocation is checked before the access-mode branch, so a leaver is turned away even from
  // an Agent whose allowlist still names them — removing the account is enough, and an owner
  // does not have to also prune every allowlist that mentions it.
  it('rejects a disabled account in specified_users mode even when listed', async () => {
    mockIsSsoAccountDisabled.mockReturnValue(true)
    const t = await token()
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: ['alice@example.com'],
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toEqual({ error: 'Account is disabled', status: 403 })
    expect(r.caller).toBeUndefined()
  })

  it('looks the account up by issuer + sub + email', async () => {
    const t = await token({ sub: 'sub-42', email: 'bob@example.com' })
    await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'all_idaas_users',
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(mockIsSsoAccountDisabled).toHaveBeenCalledWith({
      issuer: ISSUER,
      sub: 'sub-42',
      email: 'bob@example.com',
    })
  })

  it('allows an external IdP caller with no local a2wave account', async () => {
    mockIsSsoAccountDisabled.mockReturnValue(false)
    const t = await token()
    const r = await validateGatewayAuth(
      {
        publishIpWhitelist: null,
        publishAuthType: 'oauth',
        endpointApiKey: null,
        oauthAccessMode: 'all_idaas_users',
      },
      { clientIp: '1.2.3.4', authorizationHeader: `Bearer ${t}` },
    )
    expect(r.error).toBeUndefined()
    expect(r.caller?.kind).toBe('idaas_user')
  })

  it('does NOT consult account status for api_key auth', async () => {
    const r = await validateGatewayAuth(
      { publishIpWhitelist: null, publishAuthType: 'api_key', endpointApiKey: 'k' },
      { clientIp: '1.2.3.4', authorizationHeader: 'Bearer k' },
    )
    expect(r.error).toBeUndefined()
    expect(mockIsSsoAccountDisabled).not.toHaveBeenCalled()
  })
})
