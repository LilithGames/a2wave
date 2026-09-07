import { Hono } from 'hono'
import { jwtVerify } from 'jose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../env.js'

// RelayState 现在是 AUTH_SECRET 签名的 token（承载 rt/purpose/uid）。用与路由同源的 secret 解出内层断言。
const RELAY_SECRET = new TextEncoder().encode(`${env.AUTH_SECRET}:saml-relay`)
async function decodeRelay(token: unknown): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(String(token), RELAY_SECRET, { algorithms: ['HS256'] })
  return payload as Record<string, unknown>
}
/** 与路由同款：sha256(nonce) → hex，供构造/校验 bindNonceHash。 */
async function hashNonce(nonce: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(nonce).digest('hex')
}

/** 从 Set-Cookie 里取指定 cookie 的值（简化解析）。 */
function readSetCookie(res: Response, name: string): string | null {
  const raw = res.headers.get('set-cookie')
  if (!raw) return null
  const m = raw.match(new RegExp(`${name}=([^;]*)`))
  return m ? m[1] : null
}

/** 从 sealRelay 造一个合法 RelayState（供 ACS 用例注入 purpose/rt/uid）。 */
async function sealRelay(state: Record<string, unknown>): Promise<string> {
  const { SignJWT } = await import('jose')
  return new SignJWT(state)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('600s')
    .setIssuedAt()
    .sign(RELAY_SECRET)
}

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const mockLoadAuthSettings = vi.fn()
vi.mock('../../lib/auth-settings.js', () => ({
  loadAuthSettings: () => mockLoadAuthSettings(),
}))

const mockIsCookieSecure = vi.fn(() => false)
vi.mock('../../lib/auth-cookie.js', () => ({
  isCookieSecure: () => mockIsCookieSecure(),
}))

const mockIsSamlConfigured = vi.fn()
const mockGetSamlEnv = vi.fn()
vi.mock('../../lib/saml-config.js', () => ({
  isSamlConfigured: () => mockIsSamlConfigured(),
  getSamlEnv: () => mockGetSamlEnv(),
}))

const mockGetAuthorizeUrl = vi.fn()
const mockValidatePostResponse = vi.fn()
const mockGenerateMetadata = vi.fn()
vi.mock('../../lib/saml.js', async (importOriginal) => ({
  // 分类逻辑本身就是被测行为——取真实实现，避免替身与实现各说各话。
  classifySamlValidationError: (await importOriginal<typeof import('../../lib/saml.js')>())
    .classifySamlValidationError,
  SamlPublicUrlMissingError: class SamlPublicUrlMissingError extends Error {
    constructor() {
      super('saml public url missing')
      this.name = 'SamlPublicUrlMissingError'
    }
  },
  getSaml: () => ({
    getAuthorizeUrlAsync: (...args: unknown[]) => mockGetAuthorizeUrl(...args),
    validatePostResponseAsync: (...args: unknown[]) => mockValidatePostResponse(...args),
    generateServiceProviderMetadata: (...args: unknown[]) => mockGenerateMetadata(...args),
  }),
  // ACS 走的入口：真实实现会把这次校验包进自己的 AsyncLocalStorage 作用域
  // （见 lib/saml.ts 的 samlValidationScope），替身只需保持同样的调用形状。
  validateSamlPostResponse: (samlResponse: string) =>
    mockValidatePostResponse({ SAMLResponse: samlResponse }),
  // 与 lib/saml.ts 的真实行为同形：nameID → sub，issuer 缺省回落 entryPoint
  extractSamlIdentity: (
    profile: { nameID?: string; email?: string; issuer?: string },
    fallbackIssuer: string,
  ) => {
    if (!profile.nameID) throw new Error('saml assertion missing nameID')
    return {
      sub: profile.nameID,
      ...(profile.email ? { email: profile.email } : {}),
      issuer: profile.issuer || fallbackIssuer,
    }
  },
  resetSamlForTests: vi.fn(),
}))

const mockCompleteSsoLogin = vi.fn()
const mockCompleteSsoShareAccess = vi.fn()
const mockCompleteSsoBind = vi.fn()
const mockResolveSessionUserId = vi.fn()
vi.mock('../../lib/sso-login.js', async (importOriginal) => ({
  // 保留真实的 sanitize/isSafeSharePath 等纯函数；只 stub 会碰 DB/cookie 的落地函数。
  ...(await importOriginal<typeof import('../../lib/sso-login.js')>()),
  completeSsoLogin: (...args: unknown[]) => mockCompleteSsoLogin(...args),
  completeSsoShareAccess: (...args: unknown[]) => mockCompleteSsoShareAccess(...args),
  completeSsoBind: (...args: unknown[]) => mockCompleteSsoBind(...args),
  resolveSessionUserId: (...args: unknown[]) => mockResolveSessionUserId(...args),
}))

import { logger } from '../../lib/logger.js'

const ENABLED_POLICY = {
  oauthEnabled: true,
  allowedEmailDomains: [],
  defaultRole: 'user',
  oauthAutoProvision: true,
  passwordLoginEnabled: true,
}

const SAML_ENV = {
  entryPoint: 'https://idp.test/sso/saml',
  idpCert: 'ZmFrZS1jZXJ0',
}

describe('SAML login routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockLoadAuthSettings.mockReturnValue(ENABLED_POLICY)
    mockIsSamlConfigured.mockReturnValue(true)
    mockGetSamlEnv.mockReturnValue(SAML_ENV)
    mockGetAuthorizeUrl.mockResolvedValue('https://idp.test/sso/saml?SAMLRequest=abc')

    const mod = await import('../auth-saml.js')
    app = new Hono()
    app.route('/api/auth/saml', mod.default)
  })

  function acsRequest(form: Record<string, string>, cookie?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    if (cookie) headers.cookie = cookie
    return app.request('/api/auth/saml/acs', {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
    })
  }

  /** 造一对匹配的 (nonce cookie, bindNonceHash)，模拟同一浏览器发起 bind 又完成 ACS。 */
  async function makeBindNonce() {
    const nonce = 'nonce-browser-A'
    return { cookie: `a2w_saml_bind=${nonce}`, hash: await hashNonce(nonce) }
  }

  describe('GET /login', () => {
    it('redirects with OAUTH_DISABLED_BY_ADMIN when SSO is disabled by policy', async () => {
      mockLoadAuthSettings.mockReturnValue({ ...ENABLED_POLICY, oauthEnabled: false })
      const res = await app.request('/api/auth/saml/login')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login?ssoError=OAUTH_DISABLED_BY_ADMIN')
      expect(mockGetAuthorizeUrl).not.toHaveBeenCalled()
    })

    it('redirects with OAUTH_NOT_CONFIGURED when SAML env is missing', async () => {
      mockIsSamlConfigured.mockReturnValue(false)
      const res = await app.request('/api/auth/saml/login')
      expect(res.headers.get('location')).toBe('/login?ssoError=OAUTH_NOT_CONFIGURED')
    })

    it('302s to the IdP redirect binding URL with a signed RelayState carrying the sanitized returnTo', async () => {
      const res = await app.request('/api/auth/saml/login?returnTo=/agents')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://idp.test/sso/saml?SAMLRequest=abc')
      const relay = await decodeRelay(mockGetAuthorizeUrl.mock.calls[0][0])
      expect(relay).toMatchObject({ rt: '/agents', purpose: 'login' })
    })

    it('uses / as RelayState rt when returnTo is an external URL', async () => {
      await app.request(
        `/api/auth/saml/login?returnTo=${encodeURIComponent('https://evil.example.com/x')}`,
      )
      const relay = await decodeRelay(mockGetAuthorizeUrl.mock.calls[0][0])
      expect(relay).toMatchObject({ rt: '/', purpose: 'login' })
    })

    it('carries the loopback referer origin in RelayState rt (dev two-port)', async () => {
      await app.request('/api/auth/saml/login?returnTo=/agents', {
        headers: { referer: 'http://127.0.0.1:3501/login' },
      })
      const relay = await decodeRelay(mockGetAuthorizeUrl.mock.calls[0][0])
      expect(relay).toMatchObject({ rt: 'http://127.0.0.1:3501/agents', purpose: 'login' })
    })

    it('ignores a non-loopback referer origin (production unchanged)', async () => {
      await app.request('/api/auth/saml/login?returnTo=/agents', {
        headers: { referer: 'https://a2wave.example.com/login' },
      })
      const relay = await decodeRelay(mockGetAuthorizeUrl.mock.calls[0][0])
      expect(relay).toMatchObject({ rt: '/agents', purpose: 'login' })
    })

    it('purpose=bind captures the session uid + sets a browser-binding nonce cookie matching RelayState', async () => {
      mockResolveSessionUserId.mockResolvedValue('usr_me')
      const res = await app.request('/api/auth/saml/login?purpose=bind&returnTo=/agents/x')
      const relay = await decodeRelay(mockGetAuthorizeUrl.mock.calls[0][0])
      expect(relay).toMatchObject({ rt: '/agents/x', purpose: 'bind', uid: 'usr_me' })
      // RelayState 带 nonce 哈希，且响应给发起浏览器种了对应明文 nonce cookie（两者哈希一致）
      const cookieNonce = readSetCookie(res, 'a2w_saml_bind')
      expect(cookieNonce).toBeTruthy()
      expect(await hashNonce(cookieNonce as string)).toBe(relay.bindNonceHash)
    })

    it('purpose=bind without a session redirects with BIND_REQUIRES_LOGIN', async () => {
      mockResolveSessionUserId.mockResolvedValue(null)
      const res = await app.request('/api/auth/saml/login?purpose=bind&returnTo=/agents/x')
      expect(res.headers.get('location')).toBe('/login?ssoError=BIND_REQUIRES_LOGIN')
      expect(mockGetAuthorizeUrl).not.toHaveBeenCalled()
    })

    it('purpose=share requires a /s/ returnTo; rejects otherwise', async () => {
      const bad = await app.request('/api/auth/saml/login?purpose=share&returnTo=/agents')
      expect(bad.headers.get('location')).toBe('/login?ssoError=SHARE_BAD_RETURN')

      await app.request('/api/auth/saml/login?purpose=share&returnTo=/s/abc')
      const relay = await decodeRelay(mockGetAuthorizeUrl.mock.calls[0][0])
      expect(relay).toMatchObject({ rt: '/s/abc', purpose: 'share' })
    })

    it('redirects with SSO_FLOW_INVALID and logs when authorize URL generation fails', async () => {
      mockGetAuthorizeUrl.mockRejectedValue(new Error('boom'))
      const res = await app.request('/api/auth/saml/login')
      expect(res.headers.get('location')).toBe('/login?ssoError=SSO_FLOW_INVALID')
      expect(logger.error).toHaveBeenCalled()
    })

    it('login-stage errors redirect back to the loopback origin (dev two-port)', async () => {
      // dev 双端口：错误页也必须跳回前端端口，否则落在 API 端口变 Not Found
      mockGetAuthorizeUrl.mockRejectedValue(new Error('boom'))
      const res = await app.request('/api/auth/saml/login', {
        headers: { referer: 'http://127.0.0.1:3501/login' },
      })
      expect(res.headers.get('location')).toBe(
        'http://127.0.0.1:3501/login?ssoError=SSO_FLOW_INVALID',
      )
    })
  })

  describe('POST /acs', () => {
    it('redirects with OAUTH_DISABLED_BY_ADMIN when SSO is disabled by policy', async () => {
      mockLoadAuthSettings.mockReturnValue({ ...ENABLED_POLICY, oauthEnabled: false })
      const res = await acsRequest({ SAMLResponse: 'xml' })
      expect(res.headers.get('location')).toBe('/login?ssoError=OAUTH_DISABLED_BY_ADMIN')
      expect(mockValidatePostResponse).not.toHaveBeenCalled()
    })

    it('redirects with OAUTH_NOT_CONFIGURED when SAML env is missing', async () => {
      mockIsSamlConfigured.mockReturnValue(false)
      const res = await acsRequest({ SAMLResponse: 'xml' })
      expect(res.headers.get('location')).toBe('/login?ssoError=OAUTH_NOT_CONFIGURED')
    })

    it('redirects with SSO_FLOW_INVALID when SAMLResponse is missing', async () => {
      const res = await acsRequest({ RelayState: '/agents' })
      expect(res.headers.get('location')).toBe('/login?ssoError=SSO_FLOW_INVALID')
      expect(mockValidatePostResponse).not.toHaveBeenCalled()
    })

    it('redirects with INVALID_IDAAS_TOKEN and warns when assertion validation fails', async () => {
      mockValidatePostResponse.mockRejectedValue(new Error('Invalid signature'))
      const res = await acsRequest({ SAMLResponse: 'tampered' })
      expect(res.headers.get('location')).toBe('/login?ssoError=INVALID_IDAAS_TOKEN')
      expect(logger.warn).toHaveBeenCalled()
      expect(mockCompleteSsoLogin).not.toHaveBeenCalled()
    })

    it('reports an audience mismatch as a config error, not as an expired token', async () => {
      // 这类失败重试永远不会好——报「请重新登录」会把管理员引向无效动作。
      mockValidatePostResponse.mockRejectedValue(
        new Error(
          'SAML assertion audience mismatch. Expected: http://localhost:3502/api/auth/saml/metadata Received: http://127.0.0.1:3502/api/auth/saml/metadata',
        ),
      )
      const res = await acsRequest({ SAMLResponse: 'mismatched' })
      expect(res.headers.get('location')).toBe('/login?ssoError=SAML_AUDIENCE_MISMATCH')
      expect(mockCompleteSsoLogin).not.toHaveBeenCalled()
    })

    it('reports an InResponseTo failure as an unsolicited response', async () => {
      mockValidatePostResponse.mockRejectedValue(new Error('InResponseTo is not valid'))
      const res = await acsRequest({ SAMLResponse: 'unsolicited' })
      expect(res.headers.get('location')).toBe('/login?ssoError=SAML_RESPONSE_UNSOLICITED')
    })

    it('redirects with SSO_FLOW_INVALID for a loggedOut (logout) response', async () => {
      mockValidatePostResponse.mockResolvedValue({ profile: null, loggedOut: true })
      const res = await acsRequest({ SAMLResponse: 'logout' })
      expect(res.headers.get('location')).toBe('/login?ssoError=SSO_FLOW_INVALID')
      expect(mockCompleteSsoLogin).not.toHaveBeenCalled()
    })

    it('redirects to a loopback absolute RelayState (dev two-port round-trip)', async () => {
      mockValidatePostResponse.mockResolvedValue({
        profile: {
          nameID: 'user-1',
          email: 'alice@example.com',
          issuer: 'https://idp.test/issuer',
        },
        loggedOut: false,
      })
      mockCompleteSsoLogin.mockResolvedValue({ ok: true, user: { id: 'usr_1' }, token: 't' })

      const res = await acsRequest({
        SAMLResponse: 'signed-xml',
        RelayState: 'http://127.0.0.1:3501/agents',
      })
      expect(res.headers.get('location')).toBe('http://127.0.0.1:3501/agents')
    })

    it('completes login and redirects to the RelayState path', async () => {
      mockValidatePostResponse.mockResolvedValue({
        profile: {
          nameID: 'user-1',
          email: 'alice@example.com',
          issuer: 'https://idp.test/issuer',
        },
        loggedOut: false,
      })
      mockCompleteSsoLogin.mockResolvedValue({ ok: true, user: { id: 'usr_1' }, token: 't' })

      const res = await acsRequest({ SAMLResponse: 'signed-xml', RelayState: '/agents' })

      expect(mockValidatePostResponse).toHaveBeenCalledWith(
        expect.objectContaining({ SAMLResponse: 'signed-xml' }),
      )
      expect(mockCompleteSsoLogin).toHaveBeenCalledWith(
        expect.anything(),
        { sub: 'user-1', email: 'alice@example.com', issuer: 'https://idp.test/issuer' },
        'saml',
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/agents')
    })

    it('purpose=share RelayState → share access (no login), redirects to /s/ path', async () => {
      mockValidatePostResponse.mockResolvedValue({
        profile: {
          nameID: 'user-1',
          email: 'alice@example.com',
          issuer: 'https://idp.test/issuer',
        },
        loggedOut: false,
      })
      mockCompleteSsoShareAccess.mockReturnValue({ ok: true })
      const RelayState = await sealRelay({ rt: '/s/abc', purpose: 'share' })

      const res = await acsRequest({ SAMLResponse: 'signed-xml', RelayState })
      expect(mockCompleteSsoShareAccess).toHaveBeenCalled()
      expect(mockCompleteSsoLogin).not.toHaveBeenCalled()
      expect(res.headers.get('location')).toBe('/s/abc')
    })

    it('purpose=bind → binds when the browser-binding nonce cookie matches RelayState', async () => {
      mockValidatePostResponse.mockResolvedValue({
        profile: {
          nameID: 'user-1',
          email: 'alice@example.com',
          issuer: 'https://idp.test/issuer',
        },
        loggedOut: false,
      })
      mockCompleteSsoBind.mockReturnValue({ ok: true })
      const { cookie, hash } = await makeBindNonce()
      const RelayState = await sealRelay({
        rt: '/agents/x',
        purpose: 'bind',
        uid: 'usr_me',
        bindNonceHash: hash,
      })

      const res = await acsRequest({ SAMLResponse: 'signed-xml', RelayState }, cookie)
      expect(mockCompleteSsoBind).toHaveBeenCalledWith(
        expect.anything(),
        { sub: 'user-1', email: 'alice@example.com', issuer: 'https://idp.test/issuer' },
        'usr_me',
        'saml',
      )
      expect(mockCompleteSsoLogin).not.toHaveBeenCalled()
      expect(res.headers.get('location')).toBe('/agents/x')
    })

    it('purpose=bind rejects when the ACS request carries NO binding nonce cookie (cross-browser pre-hijack)', async () => {
      mockValidatePostResponse.mockResolvedValue({
        profile: {
          nameID: 'user-1',
          email: 'alice@example.com',
          issuer: 'https://idp.test/issuer',
        },
        loggedOut: false,
      })
      // 攻击者生成带自己 uid + 合法 nonce 哈希的 bind URL，但受害者浏览器没有攻击者种下的 nonce cookie。
      const { hash } = await makeBindNonce()
      const RelayState = await sealRelay({
        rt: '/agents/x',
        purpose: 'bind',
        uid: 'usr_attacker',
        bindNonceHash: hash,
      })

      const res = await acsRequest({ SAMLResponse: 'signed-xml', RelayState }) // 无 cookie
      expect(mockCompleteSsoBind).not.toHaveBeenCalled()
      expect(res.headers.get('location')).toBe('/login?ssoError=BIND_REQUIRES_LOGIN')
    })

    it('purpose=bind rejects when the nonce cookie does not match the RelayState hash', async () => {
      mockValidatePostResponse.mockResolvedValue({
        profile: {
          nameID: 'user-1',
          email: 'alice@example.com',
          issuer: 'https://idp.test/issuer',
        },
        loggedOut: false,
      })
      const { hash } = await makeBindNonce()
      const RelayState = await sealRelay({
        rt: '/agents/x',
        purpose: 'bind',
        uid: 'usr_me',
        bindNonceHash: hash,
      })

      // 另一个浏览器的 nonce → 哈希不匹配
      const res = await acsRequest(
        { SAMLResponse: 'signed-xml', RelayState },
        'a2w_saml_bind=some-other-nonce',
      )
      expect(mockCompleteSsoBind).not.toHaveBeenCalled()
      expect(res.headers.get('location')).toBe('/login?ssoError=BIND_REQUIRES_LOGIN')
    })

    it('purpose=bind rejects a legacy RelayState with uid but no bindNonceHash', async () => {
      mockValidatePostResponse.mockResolvedValue({
        profile: {
          nameID: 'user-1',
          email: 'alice@example.com',
          issuer: 'https://idp.test/issuer',
        },
        loggedOut: false,
      })
      const { cookie } = await makeBindNonce()
      // 旧签名的 relay（无 bindNonceHash）即便带 cookie 也不放行（避免降级绕过）。
      const RelayState = await sealRelay({ rt: '/agents/x', purpose: 'bind', uid: 'usr_me' })

      const res = await acsRequest({ SAMLResponse: 'signed-xml', RelayState }, cookie)
      expect(mockCompleteSsoBind).not.toHaveBeenCalled()
      expect(res.headers.get('location')).toBe('/login?ssoError=BIND_REQUIRES_LOGIN')
    })

    it('purpose=bind RelayState with a bind conflict surfaces the error code', async () => {
      mockValidatePostResponse.mockResolvedValue({
        profile: {
          nameID: 'user-1',
          email: 'alice@example.com',
          issuer: 'https://idp.test/issuer',
        },
        loggedOut: false,
      })
      mockCompleteSsoBind.mockReturnValue({
        ok: false,
        error: 'IDAAS_SUB_ALREADY_BOUND',
        status: 409,
      })
      const { cookie, hash } = await makeBindNonce()
      const RelayState = await sealRelay({
        rt: '/agents/x',
        purpose: 'bind',
        uid: 'usr_me',
        bindNonceHash: hash,
      })

      const res = await acsRequest({ SAMLResponse: 'signed-xml', RelayState }, cookie)
      expect(res.headers.get('location')).toBe('/login?ssoError=IDAAS_SUB_ALREADY_BOUND')
    })

    it('falls back to / when RelayState is an external URL', async () => {
      mockValidatePostResponse.mockResolvedValue({
        profile: {
          nameID: 'user-1',
          email: 'alice@example.com',
          issuer: 'https://idp.test/issuer',
        },
        loggedOut: false,
      })
      mockCompleteSsoLogin.mockResolvedValue({ ok: true, user: { id: 'usr_1' }, token: 't' })

      const res = await acsRequest({
        SAMLResponse: 'signed-xml',
        RelayState: 'https://evil.example.com/phish',
      })
      expect(res.headers.get('location')).toBe('/')
    })

    it('redirects with SAML_MISSING_IDENTITY when the profile has no usable nameID', async () => {
      // 验签已通过，缺的是 IdP 属性映射——不是「令牌无效」。
      mockValidatePostResponse.mockResolvedValue({
        profile: { email: 'alice@example.com', issuer: 'https://idp.test/issuer' },
        loggedOut: false,
      })
      const res = await acsRequest({ SAMLResponse: 'signed-xml' })
      expect(res.headers.get('location')).toBe('/login?ssoError=SAML_MISSING_IDENTITY')
      expect(mockCompleteSsoLogin).not.toHaveBeenCalled()
    })

    it('surfaces completeSsoLogin policy failures via ssoError', async () => {
      mockValidatePostResponse.mockResolvedValue({
        profile: { nameID: 'user-1', email: 'a@evil.com', issuer: 'https://idp.test/issuer' },
        loggedOut: false,
      })
      mockCompleteSsoLogin.mockResolvedValue({
        ok: false,
        error: 'EMAIL_DOMAIN_NOT_ALLOWED',
        status: 403,
      })
      const res = await acsRequest({ SAMLResponse: 'signed-xml', RelayState: '/agents' })
      expect(res.headers.get('location')).toBe('/login?ssoError=EMAIL_DOMAIN_NOT_ALLOWED')
    })

    it('acs-stage errors redirect back to the loopback origin in RelayState (dev two-port)', async () => {
      // 登录从 vite 前端发起（RelayState rt 带回环 origin），ACS 阶段策略失败：
      // 错误页要跳回前端端口，否则落在 API 端口变 Not Found
      mockValidatePostResponse.mockResolvedValue({
        profile: {
          nameID: 'user-1',
          email: 'alice@example.com',
          issuer: 'https://idp.test/issuer',
        },
        loggedOut: false,
      })
      mockCompleteSsoLogin.mockResolvedValue({
        ok: false,
        error: 'EMAIL_ALREADY_BOUND',
        status: 403,
      })
      const RelayState = await sealRelay({ rt: 'http://127.0.0.1:3501/agents', purpose: 'login' })

      const res = await acsRequest({ SAMLResponse: 'signed-xml', RelayState })
      expect(res.headers.get('location')).toBe(
        'http://127.0.0.1:3501/login?ssoError=EMAIL_ALREADY_BOUND',
      )
    })

    it('acs validation errors also honor the loopback RelayState origin (dev two-port)', async () => {
      mockValidatePostResponse.mockRejectedValue(new Error('Invalid signature'))
      const RelayState = await sealRelay({ rt: 'http://127.0.0.1:3501/agents', purpose: 'login' })

      const res = await acsRequest({ SAMLResponse: 'tampered', RelayState })
      expect(res.headers.get('location')).toBe(
        'http://127.0.0.1:3501/login?ssoError=INVALID_IDAAS_TOKEN',
      )
    })
  })

  describe('GET /metadata', () => {
    it('returns 404 JSON when SAML is not configured', async () => {
      mockIsSamlConfigured.mockReturnValue(false)
      const res = await app.request('/api/auth/saml/metadata')
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toBe('SAML_NOT_CONFIGURED')
    })

    it('returns SP metadata XML when configured', async () => {
      mockGenerateMetadata.mockReturnValue('<EntityDescriptor/>')
      const res = await app.request('/api/auth/saml/metadata')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/xml')
      expect(await res.text()).toBe('<EntityDescriptor/>')
      expect(mockGenerateMetadata).toHaveBeenCalledWith(null, null)
    })
  })
})
