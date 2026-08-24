import { and, eq, isNull, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { env } from '../env.js'
import { logAudit } from '../lib/audit.js'
import { AUDIT_ACTIONS } from '../lib/audit-actions.js'
import { hashPassword, signToken, validatePassword, verifyPassword } from '../lib/auth.js'
import { clearAuthCookie, setAuthCookie } from '../lib/auth-cookie.js'
import { loadAuthSettings } from '../lib/auth-settings.js'
import type { JwtUserInfo } from '../lib/jwt-auth.js'
import { logger } from '../lib/logger.js'
import {
  getOidcEnv,
  isIdpUnavailableError,
  isOidcConfigured,
  verifyOidcIdToken,
} from '../lib/oidc.js'
import { getSamlEnv, isSamlConfigured } from '../lib/saml-config.js'
import { getSsoCallbackOrigin, normalizeCallbackOriginOverride } from '../lib/server-url.js'
import { isSetupRequired } from '../lib/setup.js'
import { computeSsoAvailability } from '../lib/sso-availability.js'
import { completeSsoLogin } from '../lib/sso-login.js'

const app = new Hono()

/** GET /auth/status — 返回是否需要 setup */
app.get('/status', async (c) => {
  const needSetup = await isSetupRequired()
  return c.json({ data: { needSetup } })
})

const setupSchema = z.object({
  password: z.string(),
  confirmPassword: z.string(),
})

/** POST /auth/setup — 首次设置 admin 密码 */
app.post('/setup', async (c) => {
  if (!(await isSetupRequired())) {
    return c.json({ error: 'SETUP_ALREADY_COMPLETED' }, 400)
  }

  const mediaType = c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return c.json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415)
  }

  const body = await c.req.json().catch(() => null)
  const parsed = setupSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { password, confirmPassword } = parsed.data
  if (password !== confirmPassword) {
    return c.json({ error: 'PASSWORD_MISMATCH' }, 400)
  }

  const validation = validatePassword(password)
  if (!validation.valid) {
    return c.json({ error: validation.message }, 400)
  }

  const passwordHash = await hashPassword(password)
  const admin = (await db.select().from(users).where(eq(users.username, 'admin')).limit(1))[0]
  if (!admin) {
    return c.json({ error: 'ADMIN_NOT_FOUND' }, 500)
  }

  // `.returning()` rather than a driver row count: better-sqlite3 reports
  // `changes` and node-postgres `rowCount`, so counting returned rows is the one
  // form that means the same on both. This is the one-shot setup race guard —
  // reading `.changes` on PostgreSQL yielded undefined, so it always tripped.
  const updated = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(and(eq(users.id, admin.id), isNull(users.passwordHash)))
    .returning({ id: users.id })
  if (updated.length !== 1) {
    return c.json({ error: 'SETUP_ALREADY_COMPLETED' }, 409)
  }

  // 重新读 admin 拿最新 tokenVersion（默认 0，但走 reload 保证未来加字段不漏）
  const refreshed = (await db.select().from(users).where(eq(users.id, admin.id)).limit(1))[0]
  if (!refreshed) {
    return c.json({ error: 'SETUP_ALREADY_COMPLETED' }, 409)
  }
  const token = await signToken({
    id: refreshed.id,
    role: refreshed.role,
    tokenVersion: refreshed.tokenVersion,
  })
  setAuthCookie(c, token)
  logAudit(c, {
    action: AUDIT_ACTIONS.AUTH_SETUP_COMPLETED,
    resource: 'user',
    resourceId: admin.id,
    userId: admin.id,
    details: { method: 'first-time-setup' },
  })
  return c.json({
    data: {
      token,
      user: {
        id: admin.id,
        username: admin.username,
        displayName: admin.displayName,
        role: admin.role,
        onboarding: admin.onboarding ?? {},
      },
    },
  })
})

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
  /**
   * "Keep me signed in". Defaults to **false**, not true: an older client that
   * predates the checkbox, or any caller that simply omits the field, must get
   * the short shared-computer session rather than silently inheriting the full
   * AUTH_SESSION_TTL_DAYS one. Strict boolean — a stray "false" string coercing
   * to true is exactly the failure this default exists to prevent.
   */
  remember: z.boolean().optional().default(false),
})

/** POST /auth/login — 用户登录 */
app.post('/login', async (c) => {
  const body = await c.req.json()
  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { username, password, remember } = parsed.data

  const policy = loadAuthSettings()
  if (!(await policy).passwordLoginEnabled) {
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_PASSWORD_LOGIN_DISABLED_ATTEMPT,
      details: { username },
    })
    return c.json({ error: 'PASSWORD_LOGIN_DISABLED' }, 403)
  }

  const user = (await db.select().from(users).where(eq(users.username, username)).limit(1))[0]
  if (!user || !user.passwordHash) {
    return c.json({ error: 'INVALID_CREDENTIALS' }, 401)
  }

  if (!user.isActive) {
    return c.json({ error: 'ACCOUNT_DISABLED' }, 403)
  }

  const valid = await verifyPassword(user.passwordHash, password)
  if (!valid) {
    return c.json({ error: 'INVALID_CREDENTIALS' }, 401)
  }

  const token = await signToken(
    { id: user.id, role: user.role, tokenVersion: user.tokenVersion },
    remember,
  )
  setAuthCookie(c, token, remember)

  logAudit(c, {
    action: AUDIT_ACTIONS.AUTH_LOGIN,
    resource: 'user',
    resourceId: user.id,
    userId: user.id,
    // Session lifetime chosen at login is worth having in the trail: it explains
    // why one session outlived another when reconstructing an incident.
    details: { username, remember },
  })

  return c.json({
    data: {
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        // email / idaasBound so the web can seed its /auth/me cache consistently
        // (the user menu reads idaasBound to show "已绑定" vs an actionable bind entry).
        email: user.email,
        idaasBound: !!user.idaasSub,
        idaasProtocol: user.idaasProtocol,
        // 必含 onboarding：前端登录成功后用本对象 seed /auth/me 缓存，缺它会让 done=false，
        // 已完成引导的用户登录后仍被弹欢迎引导。
        onboarding: user.onboarding ?? {},
      },
    },
  })
})

// ============================================================
// OAuth (external IdP JWT) — CLI / SSO 登录
// ============================================================

/**
 * GET /auth/oauth/config — public; 让客户端（CLI / Web）发现 SSO 元信息和当前是否启用。
 * 不返回密钥；只返回 caller 发起 SSO 需要的最小集合。
 *
 * 两种登录方式按配置汇总进 `methods` 数组，Web 登录页据此渲染按钮：
 *   - oidc：env A2WAVE_OIDC_*（标准授权码 + PKCE，浏览器直接进 /api/auth/oidc/login）
 *   - saml：env A2WAVE_SAML_*（SAML 2.0 SP，浏览器直接进 /api/auth/saml/login）
 */
app.get('/oauth/config', async (c) => {
  const policy = loadAuthSettings()
  // OIDC/SAML 的回调地址由服务端生成，须回调 origin 实际可用（生产需 publicBaseUrl），
  // 否则展示为可用但登录必失败。与门禁 / /sso/status 复用同一 computeSsoAvailability。
  //
  // 回调 origin 按方式判定：某方式填了自己的 callbackOrigin 覆盖，即便 publicBaseUrl 未配
  // 也能登录，不该被全局布尔一票否决。基准值只取一次，覆盖为空时两者退化为同一个判断。
  const baseCallbackOriginAvailable = (await getSsoCallbackOrigin()) !== null
  const originAvailable = async (override: string | undefined) =>
    (await normalizeCallbackOriginOverride(override)) !== null || baseCallbackOriginAvailable
  const availability = computeSsoAvailability({
    callbackOriginAvailable: baseCallbackOriginAvailable,
    oidcCallbackOriginAvailable: await originAvailable((await getOidcEnv())?.callbackOrigin),
    samlCallbackOriginAvailable: await originAvailable((await getSamlEnv())?.callbackOrigin),
    oidcConfigured: await isOidcConfigured(),
    samlConfigured: await isSamlConfigured(),
  })
  if (!(await policy).oauthEnabled || !availability.anyActive) {
    // 有配置但都被停用 / 总开关关 / 回调地址未配，也算 disabled（登录页不出 SSO 区）
    const anyConfigured = !!(await getOidcEnv()) || !!(await getSamlEnv())
    return c.json({
      data: {
        enabled: false,
        reason: !anyConfigured ? 'OAUTH_NOT_CONFIGURED' : 'OAUTH_DISABLED_BY_ADMIN',
      },
    })
  }
  const methods = [
    ...(availability.oidc ? [{ type: 'oidc' as const, loginUrl: '/api/auth/oidc/login' }] : []),
    ...(availability.saml ? [{ type: 'saml' as const, loginUrl: '/api/auth/saml/login' }] : []),
  ]
  return c.json({ data: { enabled: true, methods } })
})

const oauthExchangeSchema = z.object({
  idaasToken: z.string().min(1),
  /** Web SSO callback supplies the per-request nonce. CLI/headless exchange may omit it. */
  nonce: z.string().min(16).optional(),
})

/**
 * POST /auth/oauth/exchange
 * Body: { idaasToken: <jwt> }
 * 流程：验签外部 SSO JWT → 取 email/sub → 查/建本地 user → 下发 a2wave 自签 token。
 * a2wave 不持有外部 JWT、不做 refresh；过期再走一次 SSO 即可。
 *
 * 验签走企业 OIDC（JWKS 远程验签，供 CLI / headless 直接提交 IdP 签发的 id_token）；
 * 未配置 OIDC 时 503。
 */
app.post('/oauth/exchange', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = oauthExchangeSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const policy = await loadAuthSettings()
  if (!(await isOidcConfigured())) {
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
      details: { reason: 'OAUTH_NOT_CONFIGURED', status: 503 },
    })
    return c.json({ error: 'OAUTH_NOT_CONFIGURED' }, 503)
  }
  if (!policy.oauthEnabled) {
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
      details: { reason: 'OAUTH_DISABLED_BY_ADMIN', status: 503 },
    })
    return c.json({ error: 'OAUTH_DISABLED_BY_ADMIN' }, 503)
  }

  let claims: JwtUserInfo | null = null
  let lastValidationError = ''
  // Verification reaches the IdP (discovery + JWKS), so a failure here is not
  // necessarily the caller's fault — and this route is what `a2wave login` calls.
  // Reporting an outage as INVALID_IDAAS_TOKEN tells the user to sign in again,
  // which cannot possibly help and buries the real cause. Same classifier as the
  // OAuth channel, so both paths agree on what counts as a token fault.
  let idpUnavailable = false
  try {
    claims = await verifyOidcIdToken(parsed.data.idaasToken)
  } catch (err) {
    lastValidationError = (err as Error).message
    idpUnavailable = isIdpUnavailableError(err)
  }
  if (!claims) {
    const reason = idpUnavailable ? 'IDP_UNAVAILABLE' : 'INVALID_IDAAS_TOKEN'
    const status = idpUnavailable ? 503 : 401
    logger.warn(
      { err: lastValidationError, idpUnavailable },
      idpUnavailable
        ? 'OAuth exchange: IdP unreachable, cannot verify token'
        : 'OAuth exchange: SSO JWT validation failed',
    )
    // The response stays a bare code for an unauthenticated caller, but the audit
    // entry is the admin's only record of why a login was refused. With just
    // INVALID_IDAAS_TOKEN, a misconfiguration and an expired token look identical
    // — which is how a trailing-slash mismatch stayed hidden for so long.
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
      details: {
        reason,
        status,
        // Truncated: an OIDC discovery failure can wrap an IdP response body, and
        // this is an unauthenticated, repeatable write path.
        ...(lastValidationError ? { detail: lastValidationError.slice(0, 500) } : {}),
      },
    })
    return c.json({ error: reason }, status)
  }

  if (!claims.email) {
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
      details: { reason: 'IDAAS_TOKEN_MISSING_EMAIL', status: 400 },
    })
    return c.json({ error: 'IDAAS_TOKEN_MISSING_EMAIL' }, 400)
  }

  if (parsed.data.nonce) {
    const tokenNonce = (claims.raw as Record<string, unknown>).nonce
    if (tokenNonce !== parsed.data.nonce) {
      logAudit(c, {
        action: AUDIT_ACTIONS.AUTH_OAUTH_EXCHANGE_FAILED,
        details: { reason: 'OAUTH_NONCE_MISMATCH', status: 401 },
      })
      return c.json({ error: 'OAUTH_NONCE_MISMATCH' }, 401)
    }
  }

  const outcome = await completeSsoLogin(c, claims, 'exchange')
  if (!outcome.ok) {
    return c.json({ error: outcome.error }, outcome.status)
  }
  const { user, token } = outcome

  return c.json({
    data: {
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        email: user.email,
        // SSO 登录天然已绑定身份；显式回传 idaasBound 让前端 me 缓存即时正确，
        // 不必等下一次 /auth/me 刷新（否则菜单会短暂显示成可点的「绑定企业身份」）。
        idaasBound: !!user.idaasSub,
        idaasProtocol: user.idaasProtocol,
        // 必含 onboarding：前端用本对象 seed /auth/me 缓存，缺它会让已完成引导的用户登录后又被弹引导。
        onboarding: user.onboarding ?? {},
      },
    },
  })
})

/** GET /auth/me — 获取当前用户信息（需认证） */
app.get('/me', async (c) => {
  const userId = c.get('userId' as never) as string
  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]
  if (!user) {
    return c.json({ error: 'USER_NOT_FOUND' }, 404)
  }

  return c.json({
    data: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      locale: user.locale,
      onboarding: user.onboarding ?? {},
      isActive: user.isActive,
      createdAt: user.createdAt,
      // email / idaasBound let the web UI gate the "run schedule as me" toggle:
      // it's only meaningful once the current user has bound an SSO identity.
      email: user.email,
      idaasBound: !!user.idaasSub,
      // Which protocol established the binding, so the UI can state it instead of
      // inferring it from the currently enabled login methods. Null on rows
      // predating the column — "bound, protocol unknown".
      idaasProtocol: user.idaasProtocol,
    },
  })
})

const updateLocaleSchema = z.object({
  locale: z.enum(['zh', 'en']),
})

/** PATCH /auth/locale — 更新当前用户的界面语言偏好 */
app.patch('/locale', async (c) => {
  const userId = c.get('userId' as never) as string
  const body = await c.req.json()
  const parsed = updateLocaleSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  await db
    .update(users)
    .set({ locale: parsed.data.locale, updatedAt: new Date() })
    .where(eq(users.id, userId))

  return c.json({ data: { locale: parsed.data.locale } })
})

const updateOnboardingSchema = z.object({
  /** 引导 id，如 'newbie'；预留多引导扩展 */
  guide: z.string().min(1).max(64),
  /** completed/dismissed 落库；reset 清除该引导状态（重新可触发，便于测试） */
  status: z.enum(['completed', 'dismissed', 'reset']),
})

/** PATCH /auth/onboarding — 合并更新当前用户的新手引导完成状态（按引导 id 存 JSON） */
app.patch('/onboarding', async (c) => {
  const userId = c.get('userId' as never) as string
  const body = await c.req.json()
  const parsed = updateOnboardingSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]
  if (!user) {
    return c.json({ error: 'USER_NOT_FOUND' }, 404)
  }

  const next = { ...(user.onboarding ?? {}) }
  if (parsed.data.status === 'reset') {
    delete next[parsed.data.guide]
  } else {
    next[parsed.data.guide] = parsed.data.status
  }
  await db
    .update(users)
    .set({ onboarding: next, updatedAt: new Date() })
    .where(eq(users.id, userId))

  return c.json({ data: { onboarding: next } })
})

const changePasswordSchema = z.object({
  oldPassword: z.string(),
  newPassword: z.string(),
})

/** POST /auth/change-password — 修改自己的密码 */
app.post('/change-password', async (c) => {
  const userId = c.get('userId' as never) as string
  const body = await c.req.json()
  const parsed = changePasswordSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { oldPassword, newPassword } = parsed.data

  const validation = validatePassword(newPassword)
  if (!validation.valid) {
    return c.json({ error: validation.message }, 400)
  }

  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]
  if (!user || !user.passwordHash) {
    return c.json({ error: 'USER_NOT_FOUND' }, 404)
  }

  const valid = await verifyPassword(user.passwordHash, oldPassword)
  if (!valid) {
    return c.json({ error: 'WRONG_PASSWORD' }, 400)
  }

  const passwordHash = await hashPassword(newPassword)
  // 改密码同步自增 tokenVersion，吊销所有旧 token（包括其他设备 / 浏览器残留）
  // 当前请求自己也得重新签一张新 token，否则下一个请求就会因 tokenVersion 不匹配 401
  const refreshed = (
    await db
      .update(users)
      .set({
        passwordHash,
        tokenVersion: sql`${users.tokenVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning()
  )[0]
  if (!refreshed) {
    return c.json({ error: 'USER_NOT_FOUND' }, 404)
  }
  const newToken = await signToken({
    id: refreshed.id,
    role: refreshed.role,
    tokenVersion: refreshed.tokenVersion,
  })
  setAuthCookie(c, newToken)

  logAudit(c, { action: AUDIT_ACTIONS.AUTH_CHANGE_PASSWORD, resource: 'user', resourceId: userId })

  return c.json({ data: { message: 'ok' } })
})

/**
 * POST /auth/logout — 服务端吊销当前 token + 清 cookie。
 * 自增 tokenVersion 后，所有用同一旧 token 调用的请求都会 401，包括其他设备。
 */
app.post('/logout', async (c) => {
  const userId = c.get('userId' as never) as string
  await db
    .update(users)
    .set({
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
  clearAuthCookie(c)
  logAudit(c, { action: AUDIT_ACTIONS.AUTH_LOGOUT, resource: 'user', resourceId: userId, userId })
  return c.json({ data: { message: 'ok' } })
})

export default app
