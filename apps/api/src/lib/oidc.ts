/**
 * 标准 OIDC（OpenID Connect）支持，基于 openid-client（OpenID 基金会认证实现）。
 *
 * 企业 SSO 的唯一 JWT 方案：既是登录方式（授权码 + PKCE），也是 OAuth 发布渠道验签
 * 调用方 token 的来源。
 *   A2WAVE_OIDC_ISSUER             IdP issuer（discovery 地址 = {issuer}/.well-known/openid-configuration）
 *   A2WAVE_OIDC_CLIENT_ID          在 IdP 注册的 client_id
 *   A2WAVE_OIDC_CLIENT_SECRET      可选；缺省按 PKCE 公共客户端处理（token 端点 auth=none）
 *   A2WAVE_OIDC_SCOPES             可选；默认 "openid profile email"
 *   A2WAVE_OIDC_CHANNEL_AUDIENCES  可选；OAuth 渠道接受的 aud 白名单（逗号分隔）
 *
 * discovery / 授权 URL / code 换 token / id_token 验签（含 state/nonce/PKCE 校验）
 * 全部由 openid-client 完成；公钥从 IdP JWKS 自动拉取并随 kid 轮换刷新。
 * 本文件只做配置解析、Configuration/JWKS 缓存与 claims → JwtUserInfo 归一。
 */
import type { SsoConfigSource } from '@a2wave/shared'
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose'
import * as oidcClient from 'openid-client'
import type { JwtUserInfo } from './jwt-auth.js'
import { readOidcClientSecret, readSsoDbConfig } from './sso-settings.js'

/** discovery 结果缓存时长；过期后惰性重取（IdP 端点/元数据变更 10 分钟内生效）。 */
const CONFIGURATION_TTL_MS = 10 * 60 * 1000
/** exchange 手动验 id_token 时允许的签名算法（对称算法一律拒绝）。 */
const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384']

export interface OidcEnvConfig {
  issuer: string
  clientId: string
  clientSecret?: string
  scopes: string
  /**
   * OAuth 发布渠道接受的 aud 白名单（登录流不使用，登录恒校验 aud === clientId）。
   * 空数组 = 渠道关闭（fail closed）。clientId **不**隐式并入——见 oauthChannelAudiences()。
   */
  channelAudiences: string[]
  /** 回调 origin 覆盖（设置页填写）；空 = 回落 publicBaseUrl。env 兜底不支持覆盖。 */
  callbackOrigin: string
  /** 配置生效来源：settings（DB，设置页可编辑）或 env（部署环境变量兜底）。 */
  source: SsoConfigSource
  /** 是否启用（DB 配置可停用；env 兜底恒为 true）。生效判断由调用方结合此值。 */
  enabled: boolean
}

/**
 * scope 归一化：OIDC 规范要求授权请求 scope 必须含 openid（缺失时 IdP 直接拒绝，
 * 如 "scope must contain openid"）。管理员误填时自动补前缀，空值回落默认。
 */
function normalizeOidcScopes(raw: string): string {
  const scopes = raw.trim()
  if (!scopes) return 'openid profile email'
  return scopes.split(/\s+/).includes('openid') ? scopes : `openid ${scopes}`
}

/**
 * getOidcEnv 的短 TTL 记忆化。
 *
 * 一次 OAuth 渠道调用会走到 getOidcEnv 三到四次（渠道 gate、受众解析、验签、失败日志），
 * 每次都是一条未缓存的 settings 查询，DB 配置下还额外做一次 HKDF 派生 + AES-GCM 解密
 * client_secret——全在鉴权热路径上。缓存把单次请求内的重复读压成一次。
 *
 * 用 TTL 而不是「以 settings 行内容为键」：后者每次仍要查一次库才能算出键，等于把
 * 想省掉的那次查询保留了下来，而且会让纯 env 部署也被迫依赖 settings 表存在。
 *
 * **多副本下的失效边界（明确说清，不要以为已经解决）**：invalidateOidcEnvCache() 只对
 * 处理该次保存的那个进程生效。多副本部署（docs/PRODUCT.md 明确支持）里，管理员在 Pod A
 * 收紧受众白名单 / 轮换 client_secret / 停用 OIDC 后，Pod B..N 最多还会用旧配置放行
 * TTL 这么久。所以 TTL 取 1s 而非「更省事」的分钟级：它就是这个安全相关变更的传播上界，
 * 而单次请求内的重复调用只需要毫秒级窗口就能全部命中。
 */
const OIDC_ENV_TTL_MS = 1000
let oidcEnvCache: { value: OidcEnvConfig | null; at: number } | null = null

/**
 * OIDC 配置解析：DB（settings.sso.oidcConfig + oidcClientSecretEnc）> env 兜底。
 * DB 配置完整时整体优先，不做字段级混合。返回配置**不代表已启用**——
 * enabled=false 时配置仍返回（供设置页展示），是否生效由调用方查 enabled。
 * 便捷判断用 (await isOidcConfigured())（已启用且配置齐全）。
 */
export async function getOidcEnv(): Promise<OidcEnvConfig | null> {
  const now = Date.now()
  if (oidcEnvCache && now - oidcEnvCache.at < OIDC_ENV_TTL_MS) return oidcEnvCache.value

  const value = await resolveOidcEnv()
  oidcEnvCache = { value, at: now }
  return value
}

async function resolveOidcEnv(): Promise<OidcEnvConfig | null> {
  const db = await readSsoDbConfig('oidcConfig')
  if (db) {
    const clientSecret = await readOidcClientSecret()
    return {
      issuer: db.issuer,
      clientId: db.clientId,
      ...(clientSecret ? { clientSecret } : {}),
      scopes: normalizeOidcScopes(db.scopes),
      channelAudiences: db.channelAudiences,
      callbackOrigin: db.callbackOrigin,
      source: 'settings',
      enabled: db.enabled,
    }
  }

  const issuer = (process.env.A2WAVE_OIDC_ISSUER ?? '').trim()
  const clientId = (process.env.A2WAVE_OIDC_CLIENT_ID ?? '').trim()
  if (!issuer || !clientId) return null
  const clientSecret = (process.env.A2WAVE_OIDC_CLIENT_SECRET ?? '').trim()
  const scopes = normalizeOidcScopes(process.env.A2WAVE_OIDC_SCOPES ?? '')
  const channelAudiences = (process.env.A2WAVE_OIDC_CHANNEL_AUDIENCES ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
  return {
    issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    scopes,
    channelAudiences,
    callbackOrigin: '',
    source: 'env',
    enabled: true,
  }
}

/** OIDC **登录方式**是否生效（配置齐全且已启用）——登录端点的 gate。 */
export async function isOidcConfigured(): Promise<boolean> {
  return (await getOidcEnv())?.enabled === true
}

/**
 * OAuth 发布渠道接受的 aud 集合 —— **只有**管理员显式配置的那些。
 *
 * 曾经把 clientId 隐式并进来，理由是「用平台自己的登录 token 自测最方便」。那是错的，
 * 有两个后果：
 *   1. 任何持有 a2wave **登录** id_token 的人（即所有能登录控制台的员工）自动成为每个
 *      oauthAccessMode='all_idaas_users' Agent 的合法调用方 —— 把「能登录」悄悄放大成
 *      「能调用」，而这条渠道的授权边界本应由管理员显式声明。
 *   2. clientId 必填且非空，于是这个集合永远非空，isOauthChannelConfigured() 的
 *      「白名单为空即关闭」分支恒为真——文档里写的 fail-closed 根本不存在。
 * 需要用登录 token 调用的部署，把 clientId 显式写进 channelAudiences 即可，代价是一行
 * 配置，换来的是「谁能调用」在配置里一眼可见。
 */
export async function oauthChannelAudiences(): Promise<string[]> {
  const cfg = await getOidcEnv()
  if (!cfg) return []
  return [...new Set(cfg.channelAudiences.filter(Boolean))]
}

/**
 * OAuth 发布渠道是否可用。
 *
 * 刻意**不看** `enabled`：那个开关只管登录页出不出按钮。已发布的 oauth Agent 的验签
 * 能力必须与登录入口解耦，否则管理员为了「强制走密码登录」或「切到 SAML」把 OIDC
 * 登录一关，所有对外集成会同时 503。这条不变量在被删除的 oauth-config.ts 里写过，
 * 重构时丢了一次，这里恢复并由测试锁住。
 *
 * 渠道另需一个非空的受众白名单——没有它就等于接受该 IdP 签发的任何 token。
 */
export async function isOauthChannelConfigured(): Promise<boolean> {
  return !!(await getOidcEnv()) && (await oauthChannelAudiences()).length > 0
}

let configurationCache: {
  key: string
  value: oidcClient.Configuration
  fetchedAt: number
} | null = null
let jwksCache: { uri: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null

/** 直连 discovery（不走缓存）——设置页「测试连接」与缓存重建共用。 */
export async function probeOidcDiscovery(cfg: OidcEnvConfig): Promise<oidcClient.Configuration> {
  const issuerUrl = new URL(cfg.issuer)
  // http 协议的 issuer 仅供本地开发/测试（openid-client 默认拒绝，需显式放行）
  const insecure = issuerUrl.protocol === 'http:'
  return oidcClient.discovery(
    issuerUrl,
    cfg.clientId,
    cfg.clientSecret ? { client_secret: cfg.clientSecret } : undefined,
    undefined,
    insecure ? { execute: [oidcClient.allowInsecureRequests] } : undefined,
  )
}

/**
 * openid-client Configuration（含 discovery 元数据）缓存。
 * 缓存键含全部配置值：设置页改配置后下一次请求自动重建，无需重启。
 */
export async function getOidcConfiguration(): Promise<oidcClient.Configuration> {
  const cfg = await getOidcEnv()
  if (!cfg) throw new Error('OIDC is not configured (A2WAVE_OIDC_ISSUER / A2WAVE_OIDC_CLIENT_ID)')

  const key = [cfg.issuer, cfg.clientId, cfg.clientSecret ?? '', cfg.scopes].join('\n')
  if (
    configurationCache &&
    configurationCache.key === key &&
    Date.now() - configurationCache.fetchedAt < CONFIGURATION_TTL_MS
  ) {
    return configurationCache.value
  }

  const value = await probeOidcDiscovery(cfg)
  configurationCache = { key, value, fetchedAt: Date.now() }
  return value
}

function claim(payload: JWTPayload, key: string): string | undefined {
  const v = (payload as Record<string, unknown>)[key]
  return typeof v === 'string' && v ? v : undefined
}

/**
 * `email_verified` 为显式 `false`（布尔或字符串）时视为未验证邮箱。email 会被用作跨协议
 * 账号归并键，未验证邮箱可被用户自行篡改，据此归并会让攻击者继承同邮箱账号的角色，故显式
 * 未验证时丢弃 email（下游按缺邮箱处理）。缺失该 claim 不强制拒绝——不少 IdP 不下发该 claim，
 * 强制会误伤单 IdP 部署（信任域内 email 由管理员配置的 IdP 背书）。
 */
export function isEmailExplicitlyUnverified(payload: Record<string, unknown>): boolean {
  const v = payload.email_verified
  return v === false || v === 'false'
}

/** `email_verified` 显式为 `true`（布尔或字符串）。用于 userinfo 回填时的收紧判定。 */
export function isEmailExplicitlyVerified(payload: Record<string, unknown>): boolean {
  const v = payload.email_verified
  return v === true || v === 'true'
}

/**
 * OIDC claims → JwtUserInfo（登录 exchange / completeSsoLogin 与 OAuth 渠道共用）。
 *
 * 除 OIDC 标准声明外，还透传 `tenant_id` / `union_id` / `mobile`(或 `phone_number`) /
 * `user_id`(或 `uid`) 这几个企业 IdP 常见的扩展声明：它们会进入 run channel context 供
 * Agent 做业务判断与审计，缺失时下游按「未下发」处理，所以取不到就不写字段。
 */
export function oidcClaimsToUserInfo(payload: JWTPayload, issuer: string): JwtUserInfo {
  const sub = typeof payload.sub === 'string' ? payload.sub : ''
  if (!sub) throw new Error('oidc id_token missing sub claim')
  const rawEmail = claim(payload, 'email')
  const emailUnverified = isEmailExplicitlyUnverified(payload)
  const email = emailUnverified ? undefined : rawEmail
  const username =
    claim(payload, 'preferred_username') ?? claim(payload, 'name') ?? claim(payload, 'idpUsername')
  const userId = claim(payload, 'user_id') ?? claim(payload, 'uid') ?? sub
  const mobile = claim(payload, 'mobile') ?? claim(payload, 'phone_number')
  const tenantId = claim(payload, 'tenant_id')
  const unionId = claim(payload, 'union_id')
  const info: JwtUserInfo = { sub, issuer, raw: payload, userId }
  if (email) info.email = email
  // 显式未验证的邮箱不进 `email`（那是跨协议账号归并键，采信它等于让用户自选身份），
  // 但仍单独保留：撤销检查需要它去匹配本地账号行——「不能用来断言你是谁」与
  // 「可以用来查你是否已被停用」是两件事，后者只会更严格，不会放宽。
  if (emailUnverified && rawEmail) info.unverifiedEmail = rawEmail
  if (username) info.username = username
  if (mobile) info.mobile = mobile
  if (tenantId) info.tenantId = tenantId
  if (unionId) info.unionId = unionId
  return info
}

/**
 * 用 IdP JWKS 验签一个外部提交的 token，并归一为 JwtUserInfo。
 *
 * `audience` 是**必填**的：jose 在 audience 为 undefined 时会整个跳过 aud 校验，
 * 那等于接受该 IdP 为任何 relying party 签发的 token。受众策略由调用方给出，但
 * 「不给」不是一个合法选项——空列表在这里直接抛错（fail closed），不会退化成放行。
 */
async function verifyWithIdpJwks(token: string, audience: string | string[]): Promise<JwtUserInfo> {
  if (!(await getOidcEnv())) throw new Error('OIDC is not configured')
  const allowed = (Array.isArray(audience) ? audience : [audience]).filter(Boolean)
  if (allowed.length === 0) throw new Error('OIDC audience allowlist is empty')

  const configuration = await getOidcConfiguration()
  const meta = configuration.serverMetadata()
  if (!meta.jwks_uri) throw new Error('OIDC issuer metadata missing jwks_uri')

  if (!jwksCache || jwksCache.uri !== meta.jwks_uri) {
    jwksCache = { uri: meta.jwks_uri, jwks: createRemoteJWKSet(new URL(meta.jwks_uri)) }
  }

  const { payload } = await jwtVerify(token, jwksCache.jwks, {
    issuer: meta.issuer,
    audience: allowed,
    algorithms: ALLOWED_ALGS,
    requiredClaims: ['exp', 'sub'],
  })
  return oidcClaimsToUserInfo(payload, meta.issuer)
}

/**
 * jose 中**可归因于 token 本身**的错误码白名单。
 *
 * 必须用白名单而非「是不是 JOSEError」：jose 的 JWKS 拉取层对 HTTP 非 200 与非 JSON 响应
 * 抛的是**裸 JOSEError**（code=ERR_JOSE_GENERIC），与验签失败同属一个基类。按基类判定会
 * 把「IdP 的 JWKS 端点返回 502/503」这一最常见的故障形态判成「调用方 token 有问题」，
 * 正是 401/503 区分本身要避免的那个回归。
 *
 * 同理不按 `err.name` 比字符串：那是可被压缩改名的类名，而 `code` 是 jose 的稳定契约。
 * 实测（jose 5.10，见 __tests__/idp-error-classification.test.ts）：
 *   JWKS 503 / 404 / HTML body → ERR_JOSE_GENERIC（可用性）
 *   签名/issuer/aud/exp/kid 不匹配 → 下列各码（token 归因）
 */
const TOKEN_FAULT_CODES: ReadonlySet<string> = new Set([
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JOSE_ALG_NOT_ALLOWED',
])

/**
 * 验签失败是「联系不上 IdP / 我方配置问题」还是「调用方 token 有问题」？
 *
 * 返回 true → 可用性问题，调用方凭据没坏，应回 503（可重试）；
 * 返回 false → token 归因，应回 401。
 *
 * 把这个判定放在 lib/oidc.ts 而非中间件里：验签发生在这里，其它消费同一条验签路径的
 * 调用方（登录 exchange 等）需要同一套区分，放在中间件会逼它们复制一份。
 */
export function isIdpUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && TOKEN_FAULT_CODES.has(code)) return false
  // 其余一律按可用性/配置问题处理（含 ERR_JOSE_GENERIC 的 JWKS 拉取失败、
  // ERR_JWKS_TIMEOUT、openid-client/undici 的裸 Error/TypeError，以及本模块自己抛的
  // 配置错误）。宁可把未知错误报成「暂时不可用」，也不要误告调用方「你的凭据无效」。
  return true
}

/**
 * 手动验签一个外部提交的 OIDC id_token（POST /auth/oauth/exchange 的 CLI/headless 场景，
 * token 不经过本服务的授权码流程）。签名公钥走 IdP JWKS（jose createRemoteJWKSet）。
 */
export async function verifyOidcIdToken(idToken: string): Promise<JwtUserInfo> {
  const cfg = await getOidcEnv()
  if (!cfg) throw new Error('OIDC is not configured')
  return verifyWithIdpJwks(idToken, cfg.clientId)
}

/**
 * Verifies a caller token received by the OAuth publish channel.
 *
 * This uses the same enterprise OIDC configuration and JWKS as `verifyOidcIdToken`, but the
 * audience has a different role. A login ID token must include this platform's client ID, while
 * an OAuth-channel access token must identify a2wave as its target resource server. Reusing the
 * login client ID would restrict the channel to a2wave login tokens, but omitting audience
 * verification would let tokens issued for any relying party at the IdP invoke the Agent.
 *
 * Consequently, this path accepts only the explicitly configured a2wave resource audiences; it
 * does not implicitly add `clientId`. An empty list makes verification fail closed.
 */
export async function verifyOauthChannelToken(token: string): Promise<JwtUserInfo> {
  return verifyWithIdpJwks(token, await oauthChannelAudiences())
}

/**
 * 使 getOidcEnv 缓存立即失效。设置页保存 sso 配置后调用，避免管理员保存完立刻「测试连接」
 * 却读到上一秒的旧值——TTL 本身只是兜底，正常路径靠这里做到即时生效。
 */
export function invalidateOidcEnvCache(): void {
  oidcEnvCache = null
}

/** 重置 Configuration / JWKS / 配置缓存 — 仅测试用。 */
export function resetOidcForTests(): void {
  configurationCache = null
  jwksCache = null
  oidcEnvCache = null
}
