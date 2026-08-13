/**
 * Server-side SSRF protection for user-controlled URLs — **env-free core**.
 *
 * This module does not import `env.js`, so independently spawned subprocesses
 * such as built-in MCP servers can load it without a complete API environment.
 * The `TRUSTED_IMPORT_HOSTS` relaxation remains in `url-safety.ts`.
 *
 * Literal address classification is delegated to `ipaddr.js`. Callers that
 * make network requests should additionally use `resolvePublicUrl` and pin
 * the returned addresses into their connection layer.
 */

import { lookup } from 'node:dns/promises'
import type { LookupFunction } from 'node:net'
import ipaddr from 'ipaddr.js'

/** 去掉 IPv6 字面量在 URL hostname 里的 `[]` 外壳并小写，方便 ipaddr 解析。 */
function normalizeHost(hostname: string): string {
  return hostname
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
}

/**
 * IPv6 隧道/映射地址（ipv4Mapped / NAT64 rfc6052 / rfc6145 / 6to4）里内嵌的 IPv4。
 * 这些段的「私网性」取决于内嵌的 v4，而非 IPv6 段本身——抽出来递归按 v4 判。
 * 无内嵌则 null。Teredo 等不解码 → 由调用方按「非公网 unicast」直接拦。
 */
function embeddedIpv4(addr: ipaddr.IPv6): ipaddr.IPv4 | null {
  const p = addr.parts // 8 × 16-bit
  const mk = (hi: number, lo: number) =>
    new ipaddr.IPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff])
  switch (addr.range()) {
    case 'ipv4Mapped':
      return addr.toIPv4Address()
    case 'rfc6052': // NAT64 well-known 64:ff9b::/96，内嵌 v4 在末 32 位
    case 'rfc6145': // IPv4-translatable，同样末 32 位
      return mk(p[6], p[7])
    case '6to4': // 2002::/16，内嵌 v4 在 2~5 字节
      return mk(p[1], p[2])
    default:
      return null
  }
}

const CLOUD_METADATA_IPV4_ADDRESSES = new Set(['169.254.169.254', '100.100.100.200'])
const CLOUD_METADATA_IPV6_ADDRESSES = new Set(['fd00:ec2::254'])
const CLOUD_METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
])

export function isCloudMetadataHostname(hostname: string): boolean {
  return CLOUD_METADATA_HOSTNAMES.has(normalizeHost(hostname).replace(/\.$/, ''))
}

/**
 * Cloud instance metadata endpoints that exact trusted-host allowlists must
 * never unlock. Embedded IPv4 forms recurse through the same deny set so an
 * IPv4-mapped, NAT64, translated, or 6to4 spelling has identical semantics.
 */
export function isCloudMetadataAddress(address: string): boolean {
  const host = normalizeHost(address)
  if (!ipaddr.isValid(host)) return false
  const addr = ipaddr.parse(host)
  if (addr.kind() === 'ipv6') {
    const v4 = embeddedIpv4(addr as ipaddr.IPv6)
    if (v4) return isCloudMetadataAddress(v4.toString())
    return CLOUD_METADATA_IPV6_ADDRESSES.has(addr.toString())
  }
  return CLOUD_METADATA_IPV4_ADDRESSES.has(addr.toString())
}

/** 仅当地址是「普通公网 unicast」时返回 true。隧道地址按内嵌 v4 递归判。 */
function isPublicUnicast(addr: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (addr.kind() === 'ipv6') {
    const v4 = embeddedIpv4(addr as ipaddr.IPv6)
    if (v4) return isPublicUnicast(v4)
  }
  return addr.range() === 'unicast'
}

const TRUSTED_PRIVATE_DNS_RANGES = new Set(['private', 'carrierGradeNat', 'uniqueLocal'])

/**
 * A trusted DNS hostname may resolve to ordinary enterprise-private networks,
 * but never to loopback, link-local/metadata, multicast, unspecified, or other
 * reserved ranges. Public unicast answers remain valid as before.
 */
function isAllowedTrustedDnsAddress(address: string): boolean {
  const host = normalizeHost(address)
  if (!ipaddr.isValid(host)) return false
  const addr = ipaddr.parse(host)
  if (isCloudMetadataAddress(host)) return false
  if (addr.kind() === 'ipv6') {
    const v4 = embeddedIpv4(addr as ipaddr.IPv6)
    if (v4) return isAllowedTrustedDnsAddress(v4.toString())
  }
  return addr.range() === 'unicast' || TRUSTED_PRIVATE_DNS_RANGES.has(addr.range())
}

/**
 * 判定 hostname 是否指向私网 / loopback / 云元数据 / IPv6 特殊段。
 *
 * IP 段分类委托 `ipaddr.js`（事实标准，覆盖 loopback/private/linkLocal/uniqueLocal/
 * carrierGradeNat/multicast/reserved/unspecified 及 IPv4-mapped/NAT64/6to4/teredo 等
 * IPv6 隧道写法）——只放行「普通公网 unicast」，其余一律视为内网/保留。
 * 非 IP 字面量（域名）在本层放行；DNS rebinding 是连接层的另一道 TODO。
 *
 * 不吃 TRUSTED_IMPORT_HOSTS。所有其它检查（包括 isBlockedHost）都在此基础上叠加。
 */
export function isPrivateOrReserved(hostname: string): boolean {
  const host = normalizeHost(hostname)

  // 字面主机名（非 IP，ipaddr 不认）：localhost / 云 metadata 域名。
  if (host === 'localhost' || isCloudMetadataHostname(host)) return true

  if (!ipaddr.isValid(host)) return false // 域名 → 本层不判
  if (isCloudMetadataAddress(host)) return true
  return !isPublicUnicast(ipaddr.parse(host))
}

/** 不吃 TRUSTED_IMPORT_HOSTS 放行，供 webhook / MCP 走严格通道。 */
export function isBlockedHostStrict(hostname: string): boolean {
  return isPrivateOrReserved(hostname)
}

export type UnsafeUrlErrorCode =
  | 'private_dns_address'
  | 'forbidden_dns_address'
  | 'dns_resolution_failed'

export class UnsafeUrlError extends Error {
  constructor(
    public reason: 'invalid' | 'protocol' | 'blocked',
    message: string,
    public code?: UnsafeUrlErrorCode,
  ) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

export const PRIVATE_DNS_ADDRESS_ERROR = 'URL hostname resolves to a private or reserved address'

export interface SafeHttpUrlOptions {
  /** Allow ordinary private/CGNAT/ULA addresses while retaining reserved-address hard blocks. */
  allowPrivateAddresses?: boolean
}

/**
 * Validate an HTTP(S) URL under either the strict public-only policy or the
 * enterprise-network policy used by remote A2A routes. The latter admits
 * ordinary private/CGNAT/ULA literals, but still rejects localhost, loopback,
 * link-local, cloud metadata, multicast, unspecified, and other reserved
 * ranges.
 */
export function assertSafeHttpUrl(rawUrl: string, options: SafeHttpUrlOptions = {}): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new UnsafeUrlError('invalid', 'Invalid URL')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UnsafeUrlError('protocol', 'Only http/https allowed')
  }

  const hostname = normalizeHost(parsed.hostname)
  const blocked = options.allowPrivateAddresses
    ? isCloudMetadataHostname(hostname) ||
      hostname === 'localhost' ||
      (ipaddr.isValid(hostname) && !isAllowedTrustedDnsAddress(hostname))
    : isBlockedHostStrict(hostname)

  if (blocked) {
    throw new UnsafeUrlError(
      'blocked',
      options.allowPrivateAddresses
        ? 'URL points to a forbidden address'
        : 'URL points to a private or reserved address',
    )
  }

  return parsed
}

/**
 * 严格的对外 fetch URL 校验（不吃 TRUSTED_IMPORT_HOSTS，零 env 依赖）：
 *   - 只允许 http / https
 *   - 挡私网 / loopback / 云元数据 / IPv6 特殊段
 *   - 不做 DNS 解析层的 rebinding 防护（TODO）
 *
 * 失败抛 UnsafeUrlError。供独立子进程（MCP）/ webhook 复用。
 */
export function assertSafeStrictUrl(rawUrl: string): URL {
  return assertSafeHttpUrl(rawUrl)
}

export interface ResolvedPublicAddress {
  address: string
  family: number
}

/**
 * Build a DNS lookup function that can return only addresses already validated
 * by the caller. Node's address-family auto selection requests the array form
 * with `all: true`; older/single-family callers use the scalar form.
 */
export function createPinnedLookup(addresses: readonly ResolvedPublicAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family })),
      )
      return
    }
    const first = addresses[0]
    callback(null, first.address, first.family)
  }
}

export type PublicHostnameResolver = (hostname: string) => Promise<readonly ResolvedPublicAddress[]>

const defaultHostnameResolver: PublicHostnameResolver = (hostname) =>
  lookup(normalizeHost(hostname), { all: true, verbatim: true })

export interface ResolvedPublicUrl {
  url: URL
  addresses: readonly ResolvedPublicAddress[]
}

export interface ResolvePublicUrlOptions {
  /**
   * 仅供调用方已按精确主机名完成部署级信任校验后使用。允许普通企业私网地址，
   * 但 IP 字面量、loopback、link-local/metadata 和其它保留地址仍会被拦截。
   */
  allowPrivateDnsAnswers?: boolean
  /**
   * Allow ordinary private/CGNAT/ULA literals and DNS answers. Unlike the
   * historical bypass, URL validation, redirect checks, DNS pinning, and the
   * hard deny for loopback/link-local/metadata/reserved ranges stay enabled.
   */
  allowPrivateAddresses?: boolean
}

/**
 * Resolve a validated HTTP(S) URL and reject the entire hostname if any DNS
 * answer is private or reserved. DNS errors and empty answer sets fail closed.
 *
 * The returned addresses are intended for connection-layer pinning. Resolving
 * without pinning still leaves a DNS-rebinding gap between validation and use.
 */
export async function resolvePublicUrl(
  rawUrl: string,
  resolveHostname: PublicHostnameResolver = defaultHostnameResolver,
  options: ResolvePublicUrlOptions = {},
): Promise<ResolvedPublicUrl> {
  const url = assertSafeHttpUrl(rawUrl, {
    allowPrivateAddresses: options.allowPrivateAddresses,
  })
  let addresses: readonly ResolvedPublicAddress[]
  try {
    addresses = await resolveHostname(normalizeHost(url.hostname))
  } catch {
    throw new UnsafeUrlError(
      'blocked',
      'URL hostname could not be resolved safely',
      'dns_resolution_failed',
    )
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(
      'blocked',
      'URL hostname could not be resolved safely',
      'dns_resolution_failed',
    )
  }
  const hasForbiddenAddress = addresses.some(({ address }) => !isAllowedTrustedDnsAddress(address))
  const hasBlockedAddress =
    hasForbiddenAddress ||
    (!options.allowPrivateAddresses &&
      !options.allowPrivateDnsAnswers &&
      addresses.some(({ address }) => isPrivateOrReserved(address)))
  if (hasBlockedAddress) {
    throw new UnsafeUrlError(
      'blocked',
      PRIVATE_DNS_ADDRESS_ERROR,
      hasForbiddenAddress ? 'forbidden_dns_address' : 'private_dns_address',
    )
  }

  return { url, addresses }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SAFE_CROSS_ORIGIN_REDIRECT_HEADERS = new Set([
  'accept',
  'accept-language',
  'a2a-version',
  'cache-control',
  'content-language',
  'content-type',
  'mcp-protocol-version',
  'pragma',
  'user-agent',
])
const BODY_METADATA_HEADERS = new Set(['digest', 'transfer-encoding'])

function headerNames(headers: Headers): string[] {
  const names: string[] = []
  headers.forEach((_value, name) => names.push(name))
  return names
}

/** Apply redirect method/body semantics and the cross-origin header trust boundary. */
export function prepareRedirectRequest(
  request: RequestInit,
  status: number,
  crossOrigin: boolean,
): RequestInit {
  let next = request
  if (status === 301 || status === 302 || status === 303) {
    const method = (request.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      const headers = new Headers(request.headers)
      for (const name of headerNames(headers)) {
        if (name.startsWith('content-') || BODY_METADATA_HEADERS.has(name)) headers.delete(name)
      }
      next = { ...request, method: 'GET', body: undefined, headers }
    }
  }

  if (!crossOrigin) return next

  // Use the post-rewrite headers so entity metadata removed above cannot be
  // reintroduced by filtering the original request.
  const rewrittenHeaders = new Headers(next.headers)
  for (const name of headerNames(rewrittenHeaders)) {
    if (!SAFE_CROSS_ORIGIN_REDIRECT_HEADERS.has(name.toLowerCase())) rewrittenHeaders.delete(name)
  }
  return { ...next, headers: rewrittenHeaders }
}

export interface SafeFetchOptions extends RequestInit {
  /** 每一跳（含首跳）的 URL 校验器，抛错即中止。默认 assertSafeStrictUrl（严格）。 */
  validateHop?: (url: string) => void
  /** 最大重定向跳数，默认 5。 */
  maxRedirects?: number
}

/**
 * SSRF-safe 出站 fetch——**唯一出站收口**。
 *
 * 解决「fetch 默认跟随重定向」的盲 SSRF：自控公网 URL 返回 `302 Location:
 * http://169.254.169.254/...`，普通 fetch 会跟随读取内网/metadata。这里改用
 * `redirect: 'manual'`，对**首跳与每个 Location**（含相对地址 resolve 后）都跑
 * `validateHop` 校验，通过才手动续跳。首跳也校验 → 不依赖调用方先行 check，重构不易漂移。
 *
 * 重定向方法语义对齐 fetch 规范：301/302/303 把非 GET/HEAD 请求转 GET 并去 body，
 * 307/308 原样保留方法与 body。
 */
export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { validateHop = assertSafeStrictUrl, maxRedirects = 5, ...rest } = options
  let current = url
  let reqInit: RequestInit = { ...rest, redirect: 'manual' }
  for (let hop = 0; ; hop++) {
    validateHop(current)
    const res = await fetch(current, reqInit)
    if (!REDIRECT_STATUSES.has(res.status)) return res
    const location = res.headers.get('location')
    if (!location) return res // 3xx 但无 Location，交给调用方按非 2xx 处理
    if (hop >= maxRedirects) {
      throw new UnsafeUrlError('blocked', `Too many redirects (>${maxRedirects})`)
    }
    // Resolve relative Location values before the next hop is validated.
    const next = new URL(location, current).toString()
    reqInit = prepareRedirectRequest(
      reqInit,
      res.status,
      new URL(current).origin !== new URL(next).origin,
    )
    current = next
  }
}
