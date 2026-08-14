/**
 * 动态捕获服务器的 public URL，用于生成绝对链接（如产物下载）。
 * 优先级：artifacts.publicBaseUrl > 请求头推断 > localhost:{PORT}
 */
import { normalizeSsoCallbackOrigin } from '@a2wave/shared'
import { env } from '../env.js'
import { logger } from './logger.js'
import { getSetting } from './settings.js'

let detectedServerUrl: string | null = null

/** 清除请求头推断的 URL 缓存，使下次 getServerUrl 时重新从 publicBaseUrl 或请求头读取 */
export function clearDetectedServerUrl(): void {
  detectedServerUrl = null
}

/** 仅用于测试：重置 detectedServerUrl */
export function __resetDetectedForTesting(): void {
  clearDetectedServerUrl()
}

/** 从 HTTP 请求头推断 public URL 并缓存（由中间件调用） */
export function detectServerUrl(headers: { get(name: string): string | null }): void {
  if (detectedServerUrl) return

  const proto = headers.get('x-forwarded-proto') ?? headers.get('x-scheme') ?? 'http'
  const forwardedHost = headers.get('x-forwarded-host')
  const host = forwardedHost ?? headers.get('host')
  if (!host) return

  // 不要用 Docker HEALTHCHECK（`curl http://localhost:3502/api/health`，Host=localhost 且无
  // x-forwarded-host）污染缓存：否则进程首个请求就把回调 origin 钉死成 localhost，OIDC
  // redirect_uri / SAML ACS 全部指向本机，IdP 拒绝或回跳到用户本机。仅当 host 为环回且没有
  // 显式转发头时跳过；运营方主动转发的环回 host 仍然信任。
  if (!forwardedHost && isLocalhostOrLoopback(`${proto}://${host}`)) return

  detectedServerUrl = `${proto}://${host}`
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

/** 判断 URL 是否为 localhost 或 127.0.0.1，供 server-url 与 settings 路由复用 */
export function isLocalhostOrLoopback(url: string): boolean {
  try {
    const u = new URL(url.trim())
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

/**
 * 纯函数：把候选 publicBaseUrl 归一为可用的公开 origin，否则 null。
 *
 * 用 new URL() 严格解析，拒绝：非 http(s)、loopback、带凭据（user:pass@）、带 query/fragment、
 * 或路径非根（`/foo`）。前缀检查不够——`https://host?tenant=x` 会通过前缀判断，但拼上回调路径后
 * pathname 塌成 `/`、回调路径被吞进 query，OIDC/SAML 回调实际失效；管理员据此关掉密码登录即锁死。
 * 归一化输出为纯 origin（scheme://host[:port]，无尾斜杠），确保拼 `${origin}/api/...` 得到正确路径。
 */
export function normalizeUsablePublicOrigin(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  let u: URL
  try {
    u = new URL(value.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return null
  // 凭据 / query / fragment 一律拒绝；path 只允许空或根（`/`）。
  if (u.username || u.password || u.search || u.hash) return null
  if (u.pathname !== '' && u.pathname !== '/') return null
  return u.origin
}

/**
 * 安全的 public origin：**只**认管理员显式配置的 artifacts.publicBaseUrl（http(s) 且非 loopback），
 * 未配置返回 null。用于 OIDC/SAML 回调地址（redirect_uri / ACS / SP entityID）等**安全敏感**场景。
 *
 * 为什么不能用 getServerUrl 的请求头推断值：detectServerUrl 会永久缓存进程首个请求的
 * Host / X-Forwarded-Host，攻击者或内网探测抢在真实流量前发一个伪造 Host 的请求，即可把回调
 * origin 钉死到错误域名，造成 SSO 持续不可用（DoS），甚至把断言 POST 引到攻击者域名。回调地址
 * 必须来自稳定、显式、经校验的配置，不可从不可信请求头推断。产物下载等非安全 URL 仍用 getServerUrl。
 */
export async function getPublicOrigin(): Promise<string | null> {
  return normalizeUsablePublicOrigin(getSetting('artifacts', 'publicBaseUrl'))
}

/**
 * 判定「合并本次 patch 后」SSO 回调 origin 是否可用——供 PATCH /settings 防自锁门禁使用。
 * 语义须与 getSsoCallbackOrigin 一致：显式 publicBaseUrl 可用即可用；非生产环境未配也算可用
 * （回退 localhost）；生产未配则不可用。candidate 为合并后的 publicBaseUrl 最终值。
 */
export function isSsoCallbackOriginUsable(
  candidatePublicBaseUrl: string | null | undefined,
): boolean {
  if (normalizeUsablePublicOrigin(candidatePublicBaseUrl)) return true
  return env.NODE_ENV !== 'production'
}

/**
 * SSO 回调 origin，优先级：**该方式自己的 callbackOrigin 覆盖** > 显式 publicBaseUrl >
 * （仅非生产）`http://localhost:PORT`。生产环境三者皆无时返回 null，由调用方报明确错误
 * （SSO_PUBLIC_URL_NOT_SET）。非生产的 localhost 回退由本机可控、不受 Host 投毒影响。
 *
 * 关键：绝不回退到 detectServerUrl 的请求头推断值（可被伪造 Host 永久投毒）。
 *
 * `override` 来自管理员在设置页显式填写的 sso.*Config.callbackOrigin —— 与 publicBaseUrl
 * 同为「显式、经 schema 校验、稳定」的配置源，故与之同级可信；区别只是作用域更窄。
 * 这里额外用 new URL 归一为纯 origin，兼容历史上写进库的带尾斜杠/路径的值。
 */
export async function getSsoCallbackOrigin(override?: string | null): Promise<string | null> {
  const scoped = await normalizeCallbackOriginOverride(override)
  if (scoped) return scoped
  const explicit = await getPublicOrigin()
  if (explicit) return explicit
  if (env.NODE_ENV !== 'production') return `http://localhost:${env.PORT}`
  return null
}

/**
 * 归一化「按方式」的回调 origin 覆盖值 → 纯 origin，非法/空则 null（交由上层回落）。
 *
 * 判定直接委托 shared 的 normalizeSsoCallbackOrigin —— 与落库时的 schema 校验**同一份
 * 实现**。两处若各写一套，就会出现「schema 放行、运行时拒绝」的静默回落：管理员看到
 * 保存成功，IdP 却收到 publicBaseUrl 拼出的另一个地址。
 *
 * 与 normalizeUsablePublicOrigin 的差别：**允许 loopback**。内网 IdP 与本地联调是真实
 * 部署形态，而该值必须由管理员显式填写，不存在请求头投毒面。
 */
export function normalizeCallbackOriginOverride(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  // shared 对空串返回 ''（表示「未配置」）；这里的语义是「无可用覆盖」，统一收敛为 null。
  return normalizeSsoCallbackOrigin(value) || null
}

/** 获取 server public URL，优先级：publicBaseUrl > 请求头 > localhost */
export async function getServerUrl(): Promise<string> {
  const configured = getSetting('artifacts', 'publicBaseUrl')
  if (configured?.trim()) {
    const normalized = normalizeBaseUrl(configured)
    if (
      (normalized.startsWith('http://') || normalized.startsWith('https://')) &&
      !isLocalhostOrLoopback(normalized)
    ) {
      return normalized
    }
  }
  const fallback = detectedServerUrl ?? `http://localhost:${env.PORT}`
  logger.debug(
    {
      source: detectedServerUrl ? 'requestHeaders' : 'localhost',
      configured: (await configured)?.trim() || '(empty)',
      fallback,
    },
    'getServerUrl: using fallback (configure 设置-运行产物-用户可访问地址 to override)',
  )
  return fallback
}

/** 拼接产物下载完整 URL，确保 base 与 path 之间恰好一个 / */
export async function getArtifactDownloadUrl(artifactId: string): Promise<string> {
  const base = await getServerUrl()
  const path = `/api/artifacts/${artifactId}/download`
  return new URL(path, await base).href
}

/**
 * 拼接产物分享页完整 URL（公开渲染路由 /s/:agentId/:shareId）。
 * agentId 段让外部从链接即可追溯「哪个 agent 生成」；system run 等无 agent 的产物
 * 用占位段 `_`。该段在路由层会与 share 实际所属 agent 校验，不匹配返回 404。
 */
export const SHARE_NO_AGENT_SEGMENT = '_'
export async function getShareUrl(
  agentId: string | null | undefined,
  shareId: string,
): Promise<string> {
  const base = await getServerUrl()
  const agentSeg = agentId ?? SHARE_NO_AGENT_SEGMENT
  return new URL(`/s/${encodeURIComponent(agentSeg)}/${shareId}`, await base).href
}
