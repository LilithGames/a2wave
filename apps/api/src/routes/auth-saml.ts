/**
 * SAML 2.0 SP 登录路由（@node-saml/node-saml 实现）：
 *   GET  /api/auth/saml/login    → 302 到 IdP SSO 入口（HTTP-Redirect binding），
 *                                  RelayState 携带消毒后的站内回跳路径
 *   POST /api/auth/saml/acs      → Assertion Consumer Service（HTTP-POST binding）：
 *                                  验签 + 时效 + audience + InResponseTo →
 *                                  completeSsoLogin 落地会话 → 302 RelayState
 *   GET  /api/auth/saml/metadata → SP 元数据 XML（供 IdP 侧登记）
 *
 * 失败一律 302 回 /login?ssoError=<code>，由登录页 i18n 呈现（与 OIDC 链路一致）。
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Profile } from '@node-saml/node-saml'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { jwtVerify, SignJWT } from 'jose'
import { env } from '../env.js'
import { isCookieSecure } from '../lib/auth-cookie.js'
import { loadAuthSettings } from '../lib/auth-settings.js'
import { logger } from '../lib/logger.js'
import {
  classifySamlValidationError,
  extractSamlIdentity,
  getSaml,
  SamlPublicUrlMissingError,
  validateSamlPostResponse,
} from '../lib/saml.js'
import { getSamlEnv, isSamlConfigured } from '../lib/saml-config.js'
import {
  completeSsoBind,
  completeSsoLogin,
  completeSsoShareAccess,
  isSafeSharePath,
  loginErrorTarget,
  loopbackOriginFromReferer,
  resolveSessionUserId,
  type SsoFlowPurpose,
  type SsoIdentity,
  sanitizeReturnTarget,
  sanitizeReturnTo,
} from '../lib/sso-login.js'

const app = new Hono()

// ─────────────────────────────────────────────────────────────
// RelayState：SAML 无服务端会话，用途/回跳/绑定发起者都塞进 RelayState。
// RelayState 经 IdP 原样回传、可被篡改，故用 AUTH_SECRET 签名的短期 HS256 token
// 承载——bind 的 uid 一旦签名，攻击者无法改成他人 id（验签失败即拒）。
// ─────────────────────────────────────────────────────────────
const RELAY_TTL_SECONDS = 600

interface RelayState {
  /** 回跳路径（login/bind 站内相对；share 为 /s/ 路径；均可含 dev 回环前缀）。 */
  rt: string
  purpose: SsoFlowPurpose
  /** purpose='bind' 时发起者用户 id。 */
  uid?: string
  /**
   * purpose='bind' 时的浏览器绑定 nonce 的哈希（sha256）。ACS 是 IdP 发起的跨站 POST，
   * SameSite=Lax 的会话 cookie 不会被携带，故不能靠会话复核发起者；改在 /login 时给发起
   * 浏览器种一个专用短期 cookie（SameSite=None;Secure），把 nonce 哈希签进 RelayState，
   * ACS 时校验 cookie 里的 nonce 与之匹配，才允许把身份绑到 relay.uid。签名保证 nonce 哈希
   * 不可被篡改；cookie 保证「完成 ACS 的浏览器就是发起 bind 的浏览器」。
   */
  bindNonceHash?: string
}

/** bind 流的浏览器绑定 cookie 名。 */
const SAML_BIND_COOKIE = 'a2w_saml_bind'
const BIND_NONCE_TTL_SECONDS = 600

function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex')
}

/**
 * 种 bind 浏览器绑定 cookie。SameSite=None 需要 Secure（HTTPS）——SAML 跨站 POST ACS 本就
 * 应在 HTTPS 下运行。secure=false（内网 HTTP 部署）时回退 Lax：这类部署 IdP 与 SP 通常同站，
 * ACS 会携带 Lax cookie；跨站 + 纯 HTTP 的组合本就不被浏览器支持。
 */
function setBindNonceCookie(c: Context, nonce: string): void {
  const secure = isCookieSecure()
  setCookie(c, SAML_BIND_COOKIE, nonce, {
    httpOnly: true,
    secure,
    sameSite: secure ? 'None' : 'Lax',
    path: '/api/auth/saml',
    maxAge: BIND_NONCE_TTL_SECONDS,
  })
}

function clearBindNonceCookie(c: Context): void {
  deleteCookie(c, SAML_BIND_COOKIE, { path: '/api/auth/saml' })
}

function relaySecret(): Uint8Array {
  return new TextEncoder().encode(`${env.AUTH_SECRET}:saml-relay`)
}

async function sealRelay(state: RelayState): Promise<string> {
  return new SignJWT({ ...state })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(`${RELAY_TTL_SECONDS}s`)
    .setIssuedAt()
    .sign(relaySecret())
}

async function openRelay(sealed: string): Promise<RelayState | null> {
  try {
    const { payload } = await jwtVerify(sealed, relaySecret(), { algorithms: ['HS256'] })
    const purpose: SsoFlowPurpose =
      payload.purpose === 'share' || payload.purpose === 'bind' ? payload.purpose : 'login'
    return {
      rt: typeof payload.rt === 'string' ? payload.rt : '/',
      purpose,
      ...(typeof payload.uid === 'string' ? { uid: payload.uid } : {}),
      ...(typeof payload.bindNonceHash === 'string'
        ? { bindNonceHash: payload.bindNonceHash }
        : {}),
    }
  } catch {
    return null
  }
}

/** 失败重定向：dev 双端口下带上发起端回环 origin，否则相对路径（生产不变）。 */
function loginErrorRedirect(c: Context, code: string, origin?: string | null) {
  return c.redirect(loginErrorTarget(code, origin), 302)
}

/** SSO 总开关 + SAML env 就绪检查；未通过时返回失败重定向，通过返回 null。 */
async function gate(c: Context, origin?: string | null): Promise<Response | null> {
  if (!(await loadAuthSettings()).oauthEnabled) {
    return loginErrorRedirect(c, 'OAUTH_DISABLED_BY_ADMIN', origin)
  }
  if (!(await isSamlConfigured())) return loginErrorRedirect(c, 'OAUTH_NOT_CONFIGURED', origin)
  return null
}

app.get('/login', async (c) => {
  // dev 双端口跳回：回环 origin 发起时 rt 存绝对地址（IdP 原样带回），ACS 完成后跳回发起端；
  // 失败重定向同样要回到发起端。
  const devOrigin = loopbackOriginFromReferer(c.req.header('referer'))
  const blocked = await gate(c, devOrigin)
  if (blocked) return blocked

  // 流用途：login（默认）/ share（分享访客）/ bind（绑定当前登录用户）。
  const purposeRaw = c.req.query('purpose')
  const purpose: SsoFlowPurpose =
    purposeRaw === 'share' || purposeRaw === 'bind' ? purposeRaw : 'login'

  // bind 发起：GET 顶层导航，Lax 会话 cookie 会被携带，可安全捕获发起者 uid。
  // 同时生成浏览器绑定 nonce（种专用 cookie + 哈希入 RelayState），供 ACS 跨站 POST 复核。
  let uid: string | undefined
  let bindNonce: string | undefined
  if (purpose === 'bind') {
    const sessionUid = await resolveSessionUserId(c)
    if (!sessionUid) return loginErrorRedirect(c, 'BIND_REQUIRES_LOGIN', devOrigin)
    uid = sessionUid
    bindNonce = randomBytes(32).toString('base64url')
  }

  let rt: string
  if (purpose === 'share') {
    const sharePath = c.req.query('returnTo')
    if (!isSafeSharePath(sharePath)) return loginErrorRedirect(c, 'SHARE_BAD_RETURN', devOrigin)
    rt = devOrigin ? `${devOrigin}${sharePath}` : sharePath
  } else {
    const rtPath = sanitizeReturnTo(c.req.query('returnTo'))
    rt = devOrigin ? `${devOrigin}${rtPath}` : rtPath
  }

  try {
    const relayState = await sealRelay({
      rt,
      purpose,
      ...(uid ? { uid } : {}),
      ...(bindNonce ? { bindNonceHash: hashNonce(bindNonce) } : {}),
    })
    const authorizeUrl = await (await getSaml()).getAuthorizeUrlAsync(relayState, undefined, {})
    if (bindNonce) setBindNonceCookie(c, bindNonce)
    return c.redirect(authorizeUrl, 302)
  } catch (err) {
    if (err instanceof SamlPublicUrlMissingError) {
      logger.error('SAML login blocked: artifacts.publicBaseUrl not configured')
      return loginErrorRedirect(c, 'SSO_PUBLIC_URL_NOT_SET', devOrigin)
    }
    logger.error({ err: (err as Error).message }, 'SAML authorize URL generation failed')
    return loginErrorRedirect(c, 'SSO_FLOW_INVALID', devOrigin)
  }
})

app.post('/acs', async (c) => {
  const blocked = await gate(c)
  if (blocked) return blocked

  let samlResponse: unknown
  let relayState: unknown
  try {
    const body = await c.req.parseBody()
    samlResponse = body.SAMLResponse
    relayState = body.RelayState
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'SAML ACS form body parse failed')
    return loginErrorRedirect(c, 'SSO_FLOW_INVALID')
  }

  // RelayState 是签名 token：解出 purpose/rt/uid。解不开（篡改/过期/旧版明文）时
  // 退回登录流 + 站内路径白名单，保证部署切换期在途登录不中断。
  // 在验签之前先解：失败重定向也需要 rt 里的 dev 回环 origin 才能跳回前端端口。
  const relay = typeof relayState === 'string' ? await openRelay(relayState) : null
  const devOrigin = loopbackOriginFromReferer(relay?.rt)

  if (typeof samlResponse !== 'string' || !samlResponse) {
    return loginErrorRedirect(c, 'SSO_FLOW_INVALID', devOrigin)
  }

  let profile: Profile | null
  let loggedOut: boolean
  try {
    // 验签 + 时效（NotBefore/NotOnOrAfter）+ audience + InResponseTo 全部由 node-saml 完成。
    // 走 validateSamlPostResponse 而非直接调实例：它为本次校验开一个 AsyncLocalStorage
    // 作用域，node-saml 对同一 request id 的第二次读取只在本次校验内可见——并发或重放的
    // 同一份 SAMLResponse 因此拿不到已被消费的 id。
    ;({ profile, loggedOut } = await validateSamlPostResponse(samlResponse))
  } catch (err) {
    if (err instanceof SamlPublicUrlMissingError) {
      logger.error('SAML ACS blocked: artifacts.publicBaseUrl not configured')
      return loginErrorRedirect(c, 'SSO_PUBLIC_URL_NOT_SET', devOrigin)
    }
    // 分类后再报：audience / InResponseTo 不匹配是配置错，报「请重新登录」只会
    // 把管理员引向无效的重试（原因仅在服务端日志里）。
    const message = (err as Error).message
    const code = classifySamlValidationError(message)
    logger.warn({ err: message, code }, 'SAML response validation failed')
    return loginErrorRedirect(c, code, devOrigin)
  }
  // logout 响应 / 空 profile 不属于登录流程
  if (loggedOut || !profile) return loginErrorRedirect(c, 'SSO_FLOW_INVALID', devOrigin)

  let identity: SsoIdentity
  try {
    identity = extractSamlIdentity(profile, (await getSamlEnv())?.entryPoint ?? '')
  } catch (err) {
    // 断言验签通过、但缺 nameID 等必需身份字段：IdP 属性映射没配好，与「令牌过期」无关。
    logger.warn({ err: (err as Error).message }, 'SAML profile missing required identity fields')
    return loginErrorRedirect(c, 'SAML_MISSING_IDENTITY', devOrigin)
  }

  if (relay?.purpose === 'share') {
    const shareOutcome = await completeSsoShareAccess(c, identity)
    if (!shareOutcome.ok) return loginErrorRedirect(c, shareOutcome.error, devOrigin)
    return c.redirect(sanitizeReturnTarget(relay.rt), 302)
  }

  if (relay?.purpose === 'bind') {
    // ACS 是 IdP 发起的跨站 POST，Lax 会话 cookie 不会被携带，故不能靠会话复核发起者；
    // 改用 /login 时种下的浏览器绑定 nonce cookie。签名的 RelayState 只证明 a2wave 签发、
    // 不证明「完成 ACS 的浏览器就是发起 bind 的浏览器」——nonce cookie 补上这层浏览器绑定，
    // 阻断攻击者用自己账号生成 bind URL 诱导受害者完成认证的跨浏览器账号预劫持。
    const cookieNonce = getCookie(c, SAML_BIND_COOKIE)
    clearBindNonceCookie(c) // 一次性使用：无论成败都清除
    if (
      !relay.uid ||
      !relay.bindNonceHash ||
      !cookieNonce ||
      hashNonce(cookieNonce) !== relay.bindNonceHash
    ) {
      return loginErrorRedirect(c, 'BIND_REQUIRES_LOGIN', devOrigin)
    }
    const bindOutcome = await completeSsoBind(c, identity, relay.uid, 'saml')
    if (!bindOutcome.ok) return loginErrorRedirect(c, bindOutcome.error, devOrigin)
    return c.redirect(sanitizeReturnTarget(relay.rt), 302)
  }

  const outcome = await completeSsoLogin(c, identity, 'saml')
  if (!outcome.ok) return loginErrorRedirect(c, outcome.error, devOrigin)

  // relay 解出则用其 rt；否则退回把 RelayState 原值当站内路径白名单处理（旧版明文兼容）。
  const rt = relay ? relay.rt : typeof relayState === 'string' ? relayState : null
  return c.redirect(sanitizeReturnTarget(rt), 302)
})

app.get('/metadata', async (c) => {
  if (!(await isSamlConfigured())) return c.json({ error: 'SAML_NOT_CONFIGURED' }, 404)
  try {
    const xml = (await getSaml()).generateServiceProviderMetadata(null, null)
    return c.body(xml, 200, { 'Content-Type': 'application/xml' })
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'SAML SP metadata generation failed')
    return c.json({ error: 'SAML_METADATA_FAILED' }, 500)
  }
})

export default app
