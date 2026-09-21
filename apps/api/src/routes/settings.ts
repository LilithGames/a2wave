import {
  type OtelStatus,
  type OtelTestResult,
  SSO_CONFIG_SCHEMAS,
  type SsoConfigKey,
  updateSettingsInput,
} from '@a2wave/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { settings } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { logAudit } from '../lib/audit.js'
import { AUDIT_ACTIONS } from '../lib/audit-actions.js'
import { resetAuthSettingsCache } from '../lib/auth-settings.js'
import {
  getOidcEnv,
  invalidateOidcEnvCache,
  isOauthChannelConfigured,
  isOidcConfigured,
  oauthChannelAudiences,
  probeOidcDiscovery,
} from '../lib/oidc.js'
import { readOtelSettingsView } from '../lib/otel/config.js'
import { getOtelExportStats, getOtelRuntime } from '../lib/otel/provider.js'
import { prepareOtelSettingsPatch } from '../lib/otel/settings-patch.js'
import { resolveOtelTestConfig } from '../lib/otel/test-draft.js'
import { sendOtelTestSpan } from '../lib/otel/test-trace.js'
import { getSaml } from '../lib/saml.js'
import { getSamlEnv, isSamlConfigured } from '../lib/saml-config.js'
import { encryptSecret } from '../lib/secret-box.js'
import {
  clearDetectedServerUrl,
  getServerUrl,
  getSsoCallbackOrigin,
  isLocalhostOrLoopback,
  isSsoCallbackOriginUsable,
  normalizeCallbackOriginOverride,
} from '../lib/server-url.js'
import {
  getAllSettings,
  getCategorySettings,
  getSettingsVersions,
  isNonAdminReadableSetting,
  redactCategoryForViewer,
  redactSettingsForViewer,
  refreshSettingsCache,
} from '../lib/settings.js'
import { computeSsoAvailability } from '../lib/sso-availability.js'
import { assertSafePublicUrl, UnsafeUrlError } from '../lib/url-safety.js'
import { sendWebhookTest } from '../lib/webhook-notifier.js'
import { isAdmin, requireAdmin } from '../middleware/auth-middleware.js'

const app = new Hono()

/** GET / - 读取所有 settings，按 category 分组，合并默认值（非 admin 剔除敏感键） */
app.get('/', async (c) => {
  const admin = isAdmin(c)
  const data = redactSettingsForViewer(getAllSettings(), admin)
  // Filtered through the SAME whitelist as `data`: an unfiltered map would tell a
  // non-admin which sensitive keys exist and when they last changed, walking past
  // this endpoint's fail-closed redaction.
  const versions = await getSettingsVersions()
  const visibleVersions = admin
    ? versions
    : Object.fromEntries(
        Object.entries(versions).filter(([path]) => isNonAdminReadableSetting(path)),
      )
  return c.json({ data, meta: { versions: visibleVersions } })
})

/**
 * GET /oauth-env/status - 只读查看 OAuth 发布渠道是否已配置可用。
 *
 * 渠道用企业 OIDC 的 issuer + JWKS 验签调用方 token，并按受众白名单放行，所以
 * 「渠道能不能用」= 「OIDC 配置齐全」且「受众白名单非空」。**不看** OIDC 登录方式的
 * enabled 开关——那只 gate 登录入口（见 isOauthChannelConfigured）。
 *
 * `configured` 与 `missing` 必须同源：早先 configured 取自「已启用」而 missing 取自
 * 「配置存在」，于是「配了但停用」会回 {configured:false, missing:[]}，发布页据 missing
 * 为空判成「配置不可用」，把管理员指向错误的排查方向。
 *
 * Deliberately available to authenticated users, not only admins: Agent
 * owner/editor users need this summary on the publish OAuth tab.
 */
app.get('/oauth-env/status', async (c) => {
  const oidc = await getOidcEnv()
  const missing: string[] = []
  if (!oidc) missing.push('A2WAVE_OIDC_ISSUER', 'A2WAVE_OIDC_CLIENT_ID')
  else if ((await oauthChannelAudiences()).length === 0)
    missing.push('A2WAVE_OIDC_CHANNEL_AUDIENCES')
  return c.json({
    data: {
      configured: await isOauthChannelConfigured(),
      issuer: oidc?.issuer ?? null,
      source: oidc?.source ?? null,
      missing,
    },
  })
})

/**
 * GET /sso/status — 两种 SSO 登录方式的生效状态（仅 Admin，设置页「登录方式」面板用）。
 * 只回非敏感字段与「是否已设置」布尔；证书/JWK/密文一概不回。
 * 各方式附 IdP 侧注册所需的回调/元数据地址（按当前 serverUrl 计算）。
 */
app.get('/sso/status', requireAdmin, async (c) => {
  // 展示 IdP 侧登记地址：优先显式 publicBaseUrl（与真实回调一致），未配时回退推断值仅供 admin
  // 参考（并由前端提示需先配置 publicBaseUrl）。纯展示，不作安全边界。
  const serverUrl = (await getSsoCallbackOrigin()) ?? (await getServerUrl())
  const oidc = await getOidcEnv()
  const saml = await getSamlEnv()
  const ssoSettings = getCategorySettings('sso')
  // 每种方式的回调 origin：自身覆盖 > publicBaseUrl > 展示兜底。展示值必须与运行时
  // 实际拼出的回调**同源**，否则管理员照着复制去 IdP 注册的地址是错的。
  const originFor = async (override: string | undefined) =>
    (await getSsoCallbackOrigin(override)) ?? (await getServerUrl())
  const oidcOrigin = await originFor(oidc?.callbackOrigin)
  const samlOrigin = await originFor(saml?.callbackOrigin)

  return c.json({
    data: {
      // configured = 配置存在（不论启用）；enabled = 是否启用（配置存在时有意义）。
      // 前端据此：无配置隐藏开关；有配置显示 enabled 开关 + 状态徽标（已启用/已停用）。
      oidc: {
        configured: !!oidc,
        enabled: oidc?.enabled ?? false,
        source: oidc?.source ?? null,
        issuer: oidc?.issuer ?? null,
        clientId: oidc?.clientId ?? null,
        scopes: oidc?.scopes ?? null,
        clientSecretSet: oidc
          ? !!oidc.clientSecret
          : !!(ssoSettings.oidcClientSecretEnc ?? '').trim(),
        /** 在 IdP 注册的 redirect_uri。 */
        redirectUri: `${oidcOrigin}/api/auth/oidc/callback`,
        callbackOrigin: oidc?.callbackOrigin ?? '',
      },
      saml: {
        configured: !!saml,
        enabled: saml?.enabled ?? false,
        source: saml?.source ?? null,
        entryPoint: saml?.entryPoint ?? null,
        spEntityId: saml ? (saml.spEntityId ?? `${samlOrigin}/api/auth/saml/metadata`) : null,
        certPresent: !!saml,
        /** IdP 侧登记的 ACS（POST binding）与 SP 元数据地址。 */
        acsUrl: `${samlOrigin}/api/auth/saml/acs`,
        metadataUrl: `${samlOrigin}/api/auth/saml/metadata`,
        callbackOrigin: saml?.callbackOrigin ?? '',
      },
      // 回调 origin（publicBaseUrl）是否已配置可用：OIDC/SAML 依赖它才能真正登录。
      // 前端据此在未配时对 OIDC/SAML 面板给出「需先配置对外访问地址」提示。
      callbackOriginAvailable: (await getSsoCallbackOrigin()) !== null,
    },
  })
})

/**
 * GET /otel/status — OpenTelemetry trace export status (Admin only). Header names and a "set"
 * boolean only; header values and the ciphertext are never returned. Export stats describe THIS
 * API instance: the settings cache and the exporter are per-process.
 */
app.get('/otel/status', requireAdmin, (c) => {
  const data: OtelStatus = {
    ...readOtelSettingsView(),
    ...getOtelExportStats(),
    scope: 'this-instance',
  }
  return c.json({ data })
})

/**
 * POST /otel/test — sends a synthetic test trace. An optional JSON body (OtelTestDraft) carries the
 * unsaved form state; it is validated exactly like a save but never persisted or audited, and
 * omitted keys fall back to the saved settings. Always 200; `data.ok` carries the verdict. Works
 * while export is disabled so an admin can verify before enabling.
 */
app.post('/otel/test', requireAdmin, async (c) => {
  const resolved = resolveOtelTestConfig(await c.req.text())
  const data: OtelTestResult = resolved.ok
    ? await sendOtelTestSpan(resolved.config)
    : { ok: false, reason: 'INVALID_CONFIG', error: resolved.error }
  return c.json({ data })
})

const ssoTestSchema = z.object({ type: z.enum(['oidc', 'saml']) })

/**
 * POST /sso/test — 按当前生效配置（DB > env）做连通性/有效性测试（仅 Admin）。
 * 始终 200，结果在 data.ok / data.error —— 测试失败是常态而非异常。
 */
app.post('/sso/test', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = ssoTestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  try {
    if (parsed.data.type === 'oidc') {
      const cfg = await getOidcEnv()
      if (!cfg) return c.json({ data: { ok: false, reason: 'OIDC_NOT_CONFIGURED' } })
      // 必须与 auth-oidc 的 redirectUri() 同源，否则「测试通过」与真实登录会用两个地址。
      const callbackOrigin = await getSsoCallbackOrigin(cfg.callbackOrigin)
      if (!callbackOrigin) {
        return c.json({ data: { ok: false, reason: 'PUBLIC_URL_NOT_SET' } })
      }
      const configuration = await probeOidcDiscovery(cfg)
      const meta = configuration.serverMetadata()
      const redirectUri = `${callbackOrigin}/api/auth/oidc/callback`
      const detail = {
        issuer: meta.issuer,
        authorizationEndpoint: meta.authorization_endpoint,
        tokenEndpoint: meta.token_endpoint,
        jwksUri: meta.jwks_uri,
        redirectUri,
      }
      // discovery 通过 ≠ 登录能走通：redirect_uri 未在 IdP 注册是最常见的翻车点。
      // 向 authorize 端点发一次不带会话的探测请求——IdP 返回 4xx 即拒绝了本回调地址；
      // 302/200 视为接受；探测网络失败不算配置错误（discovery 已证明 IdP 可达）。
      if (meta.authorization_endpoint) {
        const probe = new URL(meta.authorization_endpoint)
        probe.searchParams.set('client_id', cfg.clientId)
        probe.searchParams.set('response_type', 'code')
        probe.searchParams.set('scope', 'openid')
        probe.searchParams.set('redirect_uri', redirectUri)
        probe.searchParams.set('state', 'a2wave-config-test')
        try {
          const res = await fetch(probe, {
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
          })
          if (res.status >= 400) {
            let idpError = ''
            try {
              const j = (await res.json()) as { error?: string; error_description?: string }
              idpError = [j.error, j.error_description].filter(Boolean).join(': ')
            } catch {
              // 非 JSON 错误体：只报状态码
            }
            return c.json({
              data: {
                ok: false,
                reason: 'REDIRECT_URI_REJECTED',
                // 文案交给前端 i18n；这里只回结构化上下文供插值。
                reasonContext: { status: res.status, idpError, redirectUri },
                detail,
              },
            })
          }
        } catch {
          // 探测不可达/超时：不影响 discovery 结论
        }
      }
      return c.json({ data: { ok: true, detail } })
    }
    // saml —— schema 已把 type 限定为 oidc | saml，此处即穷尽分支。
    const cfg = await getSamlEnv()
    if (!cfg) return c.json({ data: { ok: false, reason: 'SAML_NOT_CONFIGURED' } })
    const serverUrl = await getSsoCallbackOrigin(cfg.callbackOrigin)
    if (!serverUrl)
      return c.json({ data: { ok: false, reason: 'PUBLIC_URL_NOT_SET' } })
      // 构造期校验证书格式；能产出 SP metadata 即视为配置结构有效
    ;(await getSaml()).generateServiceProviderMetadata(null, null)
    return c.json({
      data: {
        ok: true,
        detail: {
          entryPoint: cfg.entryPoint,
          source: cfg.source,
          // IdP 侧需登记的三件套：ACS / SP EntityID（Audience）/ 元数据地址。
          // 断言的 Destination/Recipient 必须逐字符等于 acsUrl，Audience 等于 spEntityId。
          acsUrl: `${serverUrl}/api/auth/saml/acs`,
          spEntityId: cfg.spEntityId?.trim() || `${serverUrl}/api/auth/saml/metadata`,
          metadataUrl: `${serverUrl}/api/auth/saml/metadata`,
        },
      },
    })
  } catch (err) {
    // 运行时异常文本非可本地化内容，作为 detail 透传；前端用通用「测试异常」壳包裹。
    return c.json({ data: { ok: false, reason: 'TEST_EXCEPTION', error: (err as Error).message } })
  }
})

/** GET /:category - 读取指定 category 下的 settings（非 admin 剔除敏感键，如 stagingPath） */
app.get('/:category', (c) => {
  const { category } = c.req.param()
  const data = redactCategoryForViewer(category, getCategorySettings(category), isAdmin(c))
  return c.json({ data })
})

/** POST /webhook/test - 发送一条测试 Webhook 消息 — 仅 Admin */
app.post('/webhook/test', requireAdmin, async (c) => {
  const body = await c.req.json()
  const { url, type } = body as { url?: string; type?: string }

  if (!url || typeof url !== 'string') {
    return c.json({ error: 'url is required' }, 400)
  }
  const webhookType = type === 'custom' ? 'custom' : 'feishu'

  try {
    assertSafePublicUrl(url)
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return c.json({ error: 'WEBHOOK_URL_BLOCKED', reason: err.reason, message: err.message }, 400)
    }
    throw err
  }

  const result = await sendWebhookTest(url, webhookType)
  return c.json({ data: result })
})

/** PATCH / - 批量更新 settings（upsert）— 仅 Admin */
app.patch('/', requireAdmin, async (c) => {
  const body = await c.req.json()
  const parsed = updateSettingsInput.safeParse(body)
  if (!parsed.success) {
    // Only attribute the failure to the versions map when that is what is wrong;
    // labelling every validation error INVALID_SETTINGS_VERSIONS both misleads and
    // replaces useful field errors with a message about a map the caller may not
    // have sent.
    const flattened = parsed.error.flatten()
    return 'expectedVersions' in flattened.fieldErrors
      ? c.json({ error: 'INVALID_SETTINGS_VERSIONS', details: flattened }, 400)
      : c.json({ error: flattened }, 400)
  }
  const expectedVersions = parsed.data.expectedVersions

  const publicBaseUrl = parsed.data.artifacts?.publicBaseUrl
  if (publicBaseUrl?.trim() && isLocalhostOrLoopback(publicBaseUrl)) {
    return c.json({ error: 'artifacts.publicBaseUrl cannot be localhost or 127.0.0.1' }, 400)
  }

  // OpenTelemetry export: the plaintext `otel.headers` pseudo-key is encrypted into
  // `otel.headersEnc` and the endpoint is normalized. Must run before the `settingsData` snapshot
  // below, like the SSO rewrite.
  if (parsed.data.otel) {
    const prepared = prepareOtelSettingsPatch(parsed.data.otel, getCategorySettings('otel'))
    if (!prepared.ok) return c.json({ error: prepared.error, message: prepared.message }, 400)
    parsed.data.otel = prepared.patch
  }

  // SSO 配置写入预处理：
  //   1. 明文 client_secret 拦截加密 —— `sso.oidcClientSecret` 只存在于请求体，
  //      落库前改写为 AES-GCM 密文键 oidcClientSecretEnc，明文不落任何存储。
  //   2. 两个 *Config JSON 键按 schema 校验并归一化后存储；空串 = 清除（回落 env）。
  const ssoLoginActivePatch: Partial<Record<SsoConfigKey, boolean>> = {}
  // 合并后各方式的 callbackOrigin 覆盖值；undefined = 本次未改，沿用库里的。
  const ssoCallbackOriginPatch: Partial<Record<SsoConfigKey, string>> = {}
  if (parsed.data.sso) {
    // oidcClientSecret 是伪键（不进 settings 表），解构剔除后改写为密文键。
    const { oidcClientSecret, ...ssoRest } = parsed.data.sso
    const ssoPatch: Record<string, string> = { ...ssoRest }
    if (oidcClientSecret !== undefined) {
      ssoPatch.oidcClientSecretEnc = oidcClientSecret.trim()
        ? encryptSecret(oidcClientSecret.trim())
        : ''
    }
    for (const key of Object.keys(SSO_CONFIG_SCHEMAS) as SsoConfigKey[]) {
      const value = ssoPatch[key]
      if (value === undefined) continue
      if (value.trim() === '') {
        // Clearing a DB override may reveal an env fallback, but the current helpers still see
        // the pre-write DB value. Treat it as unavailable for this atomic lockdown check; an
        // admin can clear first, verify the fallback, then disable password login separately.
        ssoLoginActivePatch[key] = false
        ssoCallbackOriginPatch[key] = ''
        continue
      }
      let json: unknown
      try {
        json = JSON.parse(value)
      } catch {
        return c.json({ error: 'INVALID_SSO_CONFIG', key, message: 'not valid JSON' }, 400)
      }
      const result = SSO_CONFIG_SCHEMAS[key].safeParse(json)
      if (!result.success) {
        return c.json({ error: 'INVALID_SSO_CONFIG', key, issues: result.error.flatten() }, 400)
      }
      ssoPatch[key] = JSON.stringify(result.data)
      const config = result.data as { enabled: boolean; callbackOrigin?: string }
      ssoLoginActivePatch[key] = config.enabled
      ssoCallbackOriginPatch[key] = config.callbackOrigin ?? ''
    }
    parsed.data.sso = ssoPatch
  }

  // 安全闸：管理员不能让系统进入「无任何可用登录入口」的状态，否则会把所有人（含自己）锁死。
  // 触发条件必须覆盖所有会影响「实际可登录方式」的变更：auth（密码/总开关）、sso（两种方式配置）、
  // 以及 artifacts.publicBaseUrl（OIDC/SAML 回调 origin 的唯一来源——清空/改坏它会让 OIDC/SAML
  // 实际登录失败）。判定基于「当前配置 + 本次 patch 合并后的最终状态」，并与 /oauth/config、
  // /sso/status 复用同一 computeSsoAvailability，避免「展示可用但实际登录失败」的裂缝。
  const authPatch = parsed.data.auth
  const artifactsPatch = parsed.data.artifacts as Record<string, string> | undefined
  const touchesLoginSurface =
    !!authPatch || !!parsed.data.sso || artifactsPatch?.publicBaseUrl !== undefined
  if (touchesLoginSurface) {
    // 缺省语义须与 schema/loadAuthSettings 默认一致：passwordLoginEnabled 缺省为 true、
    // oauthEnabled 缺省为 false。把「未设置」当成 false 会让不含 auth 段的 PATCH 在密码登录
    // 仍开着的新装系统上被误判为锁死。
    const storedAuth = getCategorySettings('auth')
    const boolSetting = (patch: string | undefined, stored: string | undefined, dflt: boolean) =>
      patch !== undefined ? patch === 'true' : stored !== undefined ? stored === 'true' : dflt
    const oauthEnabledRequested = boolSetting(
      authPatch?.oauthEnabled,
      storedAuth.oauthEnabled,
      false,
    )
    const passwordEnabledRequested = boolSetting(
      authPatch?.passwordLoginEnabled,
      storedAuth.passwordLoginEnabled,
      true,
    )

    // 合并后的 publicBaseUrl 最终值 → 回调 origin 是否可用（OIDC/SAML 依赖它）。
    const mergedPublicBaseUrl =
      artifactsPatch?.publicBaseUrl !== undefined
        ? artifactsPatch.publicBaseUrl
        : getCategorySettings('artifacts').publicBaseUrl
    const callbackOriginAvailable = isSsoCallbackOriginUsable(mergedPublicBaseUrl)

    // 某方式自带合法 callbackOrigin 覆盖时，即便 publicBaseUrl 缺失它依然能登录 ——
    // 门禁若忽略这点，会把「只靠覆盖地址登录」的合法部署误判为锁死并拒绝保存。
    const mergedCallbackOrigin = (key: SsoConfigKey, current: string | undefined) =>
      ssoCallbackOriginPatch[key] ?? current ?? ''
    const originUsable = (key: SsoConfigKey, current: string | undefined) =>
      normalizeCallbackOriginOverride(mergedCallbackOrigin(key, current)) !== null ||
      callbackOriginAvailable

    const availability = computeSsoAvailability({
      callbackOriginAvailable,
      oidcCallbackOriginAvailable: originUsable('oidcConfig', (await getOidcEnv())?.callbackOrigin),
      samlCallbackOriginAvailable: originUsable('samlConfig', (await getSamlEnv())?.callbackOrigin),
      oidcConfigured: ssoLoginActivePatch.oidcConfig ?? (await isOidcConfigured()),
      samlConfigured: ssoLoginActivePatch.samlConfig ?? (await isSamlConfigured()),
    })

    // oauth 总开关关闭时，OIDC/SAML 都不出登录入口。
    const oauthLoginAvailable = oauthEnabledRequested && availability.anyActive
    if (!passwordEnabledRequested && !oauthLoginAvailable) {
      return c.json(
        {
          error: 'AUTH_LOCKDOWN_REFUSED',
          message:
            '关闭密码登录前，必须先确保至少一种 SSO 登录方式可用（OAuth 已启用、配置齐全，且 OIDC/SAML 已配置对外访问地址）。',
        },
        400,
      )
    }
  }

  // Split off the reserved key only AFTER the SSO pre-processing above, which
  // rewrites `parsed.data.sso` in place (plaintext secret -> ciphertext). Taking
  // the snapshot earlier silently wrote the pre-encryption payload.
  const { expectedVersions: _ignored, ...settingsData } = parsed.data
  const now = new Date()

  // The conflict check and the writes share one transaction so "all or nothing" is
  // enforced by the database rather than by the happenstance that better-sqlite3 is
  // synchronous and nothing currently awaits between them.
  const conflicts: string[] = []
  await withTransaction(async (tx) => {
    if (expectedVersions) {
      // Through `tx`: the check must see the same snapshot the writes below
      // commit against, or a concurrent PATCH slips past it.
      const current = await getSettingsVersions(tx)
      for (const [category, entries] of Object.entries(settingsData)) {
        for (const key of Object.keys(entries)) {
          const path = `${category}.${key}`
          // Absent on both sides = still on its default, nothing to clobber. Absent
          // only from `expected` means the row appeared after the client's read — a
          // create-create race, which IS a conflict.
          const before = (expectedVersions as Record<string, unknown>)[path]
          const after = current[path]
          if (after !== undefined && before !== after) conflicts.push(path)
        }
      }
      if (conflicts.length > 0) return
    }

    // Every statement goes through `tx`, never the outer `db`. On SQLite the two
    // are the same handle, but on PostgreSQL `db` draws a *different* pooled
    // client, so a write issued on it would land outside this transaction and
    // survive a rollback — the exact "all or nothing" guarantee this block wants.
    for (const [category, entries] of Object.entries(settingsData)) {
      for (const [key, value] of Object.entries(entries)) {
        const existing = (
          await tx
            .select()
            .from(settings)
            .where(and(eq(settings.category, category), eq(settings.key, key)))
            .limit(1)
        )[0]

        if (existing) {
          await tx
            .update(settings)
            .set({ value, updatedAt: now })
            .where(and(eq(settings.category, category), eq(settings.key, key)))
        } else {
          await tx.insert(settings).values({ category, key, value, updatedAt: now })
        }
      }
    }
  })

  if (conflicts.length > 0) {
    logAudit(c, {
      action: AUDIT_ACTIONS.SETTINGS_UPDATE_CONFLICT,
      resource: 'settings',
      details: { conflicts },
    })
    return c.json({ error: 'SETTINGS_CONFLICT', conflicts }, 409)
  }

  // Settings reads are served from the in-memory cache only (see readSettingRows:
  // ~22 synchronous readers cannot await a PostgreSQL query). The rows just
  // committed are therefore invisible — including to the response below — until
  // the cache is reloaded, so a saved setting would appear not to apply until the
  // next restart.
  await refreshSettingsCache()

  if (parsed.data.artifacts?.publicBaseUrl !== undefined) {
    clearDetectedServerUrl()
  }

  if (parsed.data.auth) {
    resetAuthSettingsCache()
    logAudit(c, {
      action: AUDIT_ACTIONS.SETTINGS_AUTH_UPDATED,
      resource: 'settings',
      // Keys only, no values: `patch: <raw config>` is the exact shape CLAUDE.md
      // forbids in `details`, and this surface sits next to `sso`.
      details: { changedKeys: Object.keys(parsed.data.auth) },
    })
  }

  // SSO 配置变更：解析函数按配置值作缓存键，写库后下一请求自动生效（无需重启）。
  // 审计只记 changedKeys —— 配置值含证书/JWK（公开材料但噪音大），密文键绝不进日志。
  if (parsed.data.sso) {
    // 配置已落库，让 OIDC 解析立刻重读：否则管理员保存完马上点「测试连接」，
    // 可能还在读上一秒的旧值（getOidcEnv 有 1s TTL 记忆化）。
    invalidateOidcEnvCache()
    logAudit(c, {
      action: AUDIT_ACTIONS.SETTINGS_SSO_UPDATED,
      resource: 'settings',
      details: { changedKeys: Object.keys(parsed.data.sso) },
    })
  }

  if (parsed.data.otel) {
    // Rebuild the exporter now rather than on the next run, so "save, then test / watch status"
    // reflects the new config. Other replicas pick it up on restart (per-process settings cache).
    getOtelRuntime()
    logAudit(c, {
      action: AUDIT_ACTIONS.SETTINGS_OTEL_UPDATED,
      resource: 'settings',
      // Turning content capture on sends prompts and responses to an external collector, so the
      // resulting state is recorded — as a boolean. Header values never reach `details`.
      details: {
        changedKeys: Object.keys(parsed.data.otel),
        captureContent: getCategorySettings('otel').captureContent === 'true',
      },
    })
  }

  logAudit(c, {
    action: AUDIT_ACTIONS.SETTINGS_UPDATE,
    resource: 'settings',
    details: {
      changedKeys: Object.entries(settingsData).flatMap(([category, entries]) =>
        Object.keys(entries as Record<string, string>).map((key) => `${category}.${key}`),
      ),
      precondition: expectedVersions ? 'checked' : 'none',
    },
  })

  const data = getAllSettings()
  // Return refreshed versions so the client can update its cache synchronously;
  // without them a save fired before a refetch lands carries the pre-write map.
  return c.json({ data, meta: { versions: await getSettingsVersions() } })
})

export default app
