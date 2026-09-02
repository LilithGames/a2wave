/**
 * SAML 2.0 SP 封装，基于 @node-saml/node-saml（成熟实现，不手写 XML 签名验证）。
 *
 * env 解析在 lib/saml-config.ts（A2WAVE_SAML_IDP_ENTRY_POINT / A2WAVE_SAML_IDP_CERT /
 * A2WAVE_SAML_SP_ENTITY_ID）；本文件负责：
 *   - getSaml()：按 serverUrl 构造并缓存 SAML 实例（ACS = {serverUrl}/api/auth/saml/acs，
 *     SP entityId 默认 {serverUrl}/api/auth/saml/metadata）
 *   - extractSamlIdentity()：断言 Profile → SsoIdentity 归一（纯函数）
 *
 * 安全基线：断言必须签名（wantAssertionsSigned）、audience 必须等于 SP entityId、
 * InResponseTo 强制校验（validateInResponseTo=always，防未经请求的响应注入 / 重放）。
 * idpCert 接受完整 PEM 或去掉头尾行的 base64 体（node-saml 原生支持两种格式）。
 *
 * InResponseTo state is durable, not in-process: issued request ids live in the
 * `saml_requests` table (createSamlRequestCacheProvider), because the IdP posts
 * the assertion back through the load balancer and it may land on any replica —
 * or on the same one after a restart. node-saml's default InMemoryCacheProvider
 * fails those logins with SAML_RESPONSE_UNSOLICITED.
 */
import { type CacheProvider, type Profile, SAML, ValidateInResponseTo } from '@node-saml/node-saml'
import { and, eq, gte, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { samlRequests } from '../db/schema.js'
import { logger } from './logger.js'
import { getSamlEnv } from './saml-config.js'
import { getSsoCallbackOrigin } from './server-url.js'
import type { SsoIdentity } from './sso-login.js'

/** publicBaseUrl 未配（生产）导致无法确定稳定回调 origin 时抛出，路由层据此报 SSO_PUBLIC_URL_NOT_SET。 */
export class SamlPublicUrlMissingError extends Error {
  constructor() {
    super('SAML callback origin unavailable: artifacts.publicBaseUrl must be set in production')
    this.name = 'SamlPublicUrlMissingError'
  }
}

/**
 * 把 node-saml 的断言校验异常归类成 ssoError 码 —— 决定登录页给管理员看什么。
 *
 * 为什么要分类：这些失败里只有极少数真的是「令牌过期，重试即可」。audience /
 * InResponseTo 不匹配是**配置错**，重试一万次也不会好；统一报「请重新登录」会
 * 把管理员推向错误的动作，真正的原因只躺在服务端日志里。
 *
 * 判据是 node-saml 抛出的英文文案（见其 saml.js 的 checkTimestampsValidityError /
 * validateAudience / validateInResponseTo）。它是上游实现细节，可能随版本漂移——
 * 因此**匹配不上时一律回落 INVALID_IDAAS_TOKEN**，保持与升级前一致的行为，
 * 绝不因为分类失败而让登录以别的方式坏掉。
 */
export type SamlValidationErrorCode =
  | 'SAML_AUDIENCE_MISMATCH'
  | 'SAML_RESPONSE_UNSOLICITED'
  | 'INVALID_IDAAS_TOKEN'

export function classifySamlValidationError(message: string): SamlValidationErrorCode {
  // audience 不匹配：SP EntityID 与 IdP 侧登记的 Audience 不一致（含 localhost
  // vs 127.0.0.1 这种逐字符差异），属于配置错。
  if (message.includes('audience mismatch') || message.includes('AudienceRestriction')) {
    return 'SAML_AUDIENCE_MISMATCH'
  }
  // InResponseTo 对不上：断言并非本次请求的响应（IdP-initiated、重放、或跨进程
  // 丢了请求 ID）。同样不是「重新登录」能解决的。
  if (message.includes('InResponseTo')) return 'SAML_RESPONSE_UNSOLICITED'
  // 其余（签名无效 / 时效不符 / 结构异常）保持原有语义。
  return 'INVALID_IDAAS_TOKEN'
}

/** email 属性的常见命名（LDAP / WS-Fed / OID），依序取第一个命中的。 */
const EMAIL_ATTRIBUTES = [
  'mail',
  'emailAddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
] as const

/** 显示名属性的常见命名，依序取第一个命中的。 */
const USERNAME_ATTRIBUTES = [
  'displayName',
  'cn',
  'givenName',
  'urn:oid:2.16.840.1.113730.3.1.241',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
] as const

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 读取断言属性：字符串直接返回；数组（多值属性）取第一个字符串项。 */
function attributeValue(profile: Profile, key: string): string | undefined {
  const value = profile[key]
  if (typeof value === 'string' && value) return value
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) return value[0]
  return undefined
}

/**
 * 已验签的 SAML Profile → SsoIdentity（completeSsoLogin 的输入）。
 * sub = NameID；email 依序：email 属性 → NameID（形如邮箱时）→ 常见属性名；
 * issuer 取断言里的 IdP issuer，缺失时回落调用方给的 fallbackIssuer（entryPoint）。
 */
export function extractSamlIdentity(profile: Profile, fallbackIssuer: string): SsoIdentity {
  const sub = typeof profile.nameID === 'string' ? profile.nameID : ''
  if (!sub) throw new Error('saml assertion missing nameID')

  let email = attributeValue(profile, 'email')
  if (!email && EMAIL_LIKE.test(sub)) email = sub
  if (!email) {
    for (const key of EMAIL_ATTRIBUTES) {
      email = attributeValue(profile, key)
      if (email) break
    }
  }

  let username: string | undefined
  for (const key of USERNAME_ATTRIBUTES) {
    username = attributeValue(profile, key)
    if (username) break
  }

  const issuer = (typeof profile.issuer === 'string' && profile.issuer) || fallbackIssuer
  const identity: SsoIdentity = { sub, issuer }
  if (email) identity.email = email
  if (username) identity.username = username
  return identity
}

/**
 * How long an issued AuthnRequest id stays acceptable.
 *
 * Mirrors node-saml's own `requestIdExpirationPeriodMs` default (8h) so the
 * durable cache expires ids on exactly the schedule the library documents;
 * shortening it here would silently fail logins the library considers valid.
 */
export const SAML_REQUEST_EXPIRATION_MS = 8 * 60 * 60 * 1000

/** Hourly, matching the other lapsed-row sweepers. Cheap: one indexed DELETE. */
const SAML_REQUEST_SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * node-saml `CacheProvider` backed by the `saml_requests` table.
 *
 * `validateInResponseTo: always` is only as good as the store behind it. The
 * default `InMemoryCacheProvider` keeps issued request ids in the heap of the
 * process that built the redirect, while the IdP form-POSTs the assertion to
 * `/api/auth/saml/acs` through the load balancer. Any replica but that one — or
 * that same one after a restart or a deploy — finds no matching id and rejects a
 * perfectly good login as `SAML_RESPONSE_UNSOLICITED`, an error whose shape
 * points the administrator at their IdP configuration rather than at us.
 *
 * A table is the whole fix: the state is already per-flow, tiny, and short
 * lived. Expiry is enforced on **read** as well as by the sweeper, so a sweeper
 * that is late (or a replica whose timer has not started) can never widen the
 * window an id stays replayable.
 */
export function createSamlRequestCacheProvider(): CacheProvider {
  return {
    async saveAsync(key: string, value: string) {
      const createdAt = new Date()
      // node-saml reads null as "this id is already in use" and refuses to
      // reissue, so the pre-existing row must win rather than be overwritten.
      const existing = (
        await db.select().from(samlRequests).where(eq(samlRequests.id, key)).limit(1)
      )[0]
      if (existing) return null

      const inserted = await db
        .insert(samlRequests)
        .values({ id: key, value, createdAt })
        .onConflictDoNothing()
        .returning({ id: samlRequests.id })
      // Lost the insert race against another replica: same answer as above.
      if (inserted.length === 0) return null

      return { value, createdAt: createdAt.getTime() }
    },

    async getAsync(key: string) {
      const row = (
        await db
          .select()
          .from(samlRequests)
          .where(
            and(
              eq(samlRequests.id, key),
              gte(samlRequests.createdAt, new Date(Date.now() - SAML_REQUEST_EXPIRATION_MS)),
            ),
          )
          .limit(1)
      )[0]
      return row?.value ?? null
    },

    async removeAsync(key: string | null) {
      if (key === null) return null
      // `.returning()` rather than a row count: the two drivers disagree on
      // `changes`/`rowCount` (see apps/api/AGENTS.md).
      const removed = await db
        .delete(samlRequests)
        .where(eq(samlRequests.id, key))
        .returning({ id: samlRequests.id })
      return removed[0]?.id ?? null
    },
  }
}

/** Delete request ids past the expiration window. Returns how many went. */
export async function sweepExpiredSamlRequests(now: Date): Promise<number> {
  const deleted = await db
    .delete(samlRequests)
    .where(lt(samlRequests.createdAt, new Date(now.getTime() - SAML_REQUEST_EXPIRATION_MS)))
    .returning({ id: samlRequests.id })
  return deleted.length
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the sweeper once, lazily, the first time a SAML instance is built.
 *
 * Deliberately not wired into server startup: a deployment with no SAML
 * configured never issues a request id, so there is nothing to sweep and no
 * reason to hold a timer. Consumed rows are deleted by `removeAsync` on the
 * success path; this only clears the abandoned ones.
 */
function ensureSamlRequestSweeper(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    void sweepExpiredSamlRequests(new Date())
      .then((deleted) => {
        if (deleted > 0) logger.info({ deleted }, 'saml: swept expired request ids')
      })
      // A failed sweep must not kill the timer — the next tick is the recovery.
      .catch((error) => logger.error({ error }, 'saml: request id sweep failed'))
  }, SAML_REQUEST_SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
}

let samlCache: { key: string; instance: SAML } | null = null

/**
 * 构造（或返回缓存的）node-saml SP 实例。缓存键含 serverUrl 与全部 env 值：
 * publicBaseUrl / 请求头推断变化或 env 变化时自动重建。
 */
export async function getSaml(): Promise<SAML> {
  const cfg = await getSamlEnv()
  if (!cfg) {
    throw new Error('SAML is not configured (A2WAVE_SAML_IDP_ENTRY_POINT / A2WAVE_SAML_IDP_CERT)')
  }

  // 回调 origin：本方式的 callbackOrigin 覆盖 > 显式 publicBaseUrl（生产），
  // 都不可从被投毒的请求头推断（见 getSsoCallbackOrigin）。
  const serverUrl = await getSsoCallbackOrigin(cfg.callbackOrigin)
  if (!serverUrl) throw new SamlPublicUrlMissingError()
  const key = [serverUrl, cfg.entryPoint, cfg.idpCert, cfg.spEntityId ?? ''].join('\n')
  if (samlCache?.key === key) return samlCache.instance

  const spEntityId = cfg.spEntityId ?? `${serverUrl}/api/auth/saml/metadata`
  const instance = new SAML({
    entryPoint: cfg.entryPoint,
    idpCert: cfg.idpCert,
    issuer: spEntityId,
    callbackUrl: `${serverUrl}/api/auth/saml/acs`,
    // audience 校验断言只签发给本 SP
    audience: spEntityId,
    // 断言本身必须签名；不强制整份 Response 签名（多数 IdP 只签断言），
    // 两者至少其一有效签名由 node-saml 保证。
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    // InResponseTo is enforced, and the issued request ids live in the
    // `saml_requests` table rather than node-saml's in-memory default. The ACS
    // POST arrives on whichever replica the load balancer picks, so process
    // memory would fail every login that does not come back to the issuer — see
    // createSamlRequestCacheProvider.
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_EXPIRATION_MS,
    cacheProvider: createSamlRequestCacheProvider(),
  })
  ensureSamlRequestSweeper()
  samlCache = { key, instance }
  return instance
}

/** 重置实例缓存 — 仅测试用。 */
export function resetSamlForTests(): void {
  samlCache = null
}
