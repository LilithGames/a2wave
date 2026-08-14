import { existsSync, readFileSync } from 'node:fs'
/**
 * The CLI's self-diagnostic probes, as data.
 *
 * `a2wave status` used to interleave probing with `printKv` calls, which meant
 * there was nothing to serialize: an agent asking "is this CLI healthy?" had to
 * scrape a coloured column layout. This module owns the probing half — it
 * answers in a stable, machine-readable shape and knows nothing about how the
 * answer is displayed. Two consequences worth stating explicitly:
 *
 *   - **No ANSI, ever.** Colour is the renderer's job. An escape sequence inside
 *     a JSON payload is garbage to every consumer that is not a terminal.
 *   - **No credential leaves in the clear.** `detail` is emitted verbatim under
 *     `--json`, which lands in terminal scrollback and CI logs, so tokens go
 *     through `maskToken` on the way in.
 *
 * Nothing here throws: a diagnostic that crashes on the failure it was run to
 * diagnose is worse than useless, so every probe degrades to a `fail` check
 * carrying the reason.
 */
import { loadConfig } from '../config.js'
import { resolveTokenCachePath } from './token-cache.js'

const URL_ENV_VAR = 'A2WAVE_URL'
const PROBE_TIMEOUT_MS = 5000

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface Check {
  /** Stable dot-separated id. Callers branch on this, never on `message`. */
  name: string
  status: CheckStatus
  /** Short, human-readable, free of ANSI colour. */
  message: string
  /** A RUNNABLE next step (a command), present on every non-pass check. */
  hint?: string
  /** Structured extras — url, expiry, role. Credentials arrive masked. */
  detail?: Record<string, unknown>
}

export interface CheckReport {
  /**
   * The rollup: false iff some check is `fail`.
   *
   * A `warn` deliberately does NOT flip it. Half of what this reports is
   * optional (an SSO cache on a password-login install) or merely blocked on an
   * earlier failure, and letting those read as failures is precisely the noise
   * that makes a health signal worth ignoring.
   */
  ok: boolean
  checks: Check[]
}

export interface RunChecksOptions {
  /** `--url`, which outranks $A2WAVE_URL and the stored config. */
  urlOverride?: string
}

// ---------------------------------------------------------------------------
// Remediation hints. These are the exact strings `status` has always printed;
// they are constants so the renderer and the JSON payload cannot drift apart.
// ---------------------------------------------------------------------------
const HINT_SET_URL = 'a2wave config set-url <URL>'
/**
 * A reachability failure is NOT fixed by setting the URL — the URL is already
 * set, which is how we got far enough to dial it. Pointing at `config set-url`
 * here sends the caller to change a value that is probably correct, and an
 * agent acting on a hint that cannot work is worse off than one given none.
 * Name the two things that actually explain it instead.
 */
const HINT_UNREACHABLE = 'check the instance is running and the URL is reachable'
const HINT_LOGIN = 'a2wave login'

interface JwtHeader {
  alg?: string
  typ?: string
}

interface JwtClaims {
  sub?: string
  email?: string
  exp?: number
  iat?: number
  username?: string
}

function decodeBase64UrlJson<T>(s: string): T | null {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf-8')) as T
  } catch {
    return null
  }
}

export function parseJwt(token: string): { header: JwtHeader | null; claims: JwtClaims | null } {
  const parts = token.split('.')
  if (parts.length < 2) return { header: null, claims: null }
  return {
    header: decodeBase64UrlJson<JwtHeader>(parts[0]),
    claims: decodeBase64UrlJson<JwtClaims>(parts[1]),
  }
}

/** Truncate and mask the token to avoid leaking it into stdout-captured logs. */
export function maskToken(token: string): string {
  if (token.length <= 8) return '****'
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export type UrlSource = 'flag' | 'env' | 'config' | 'unset'

export interface UrlResolution {
  url: string | null
  source: UrlSource
}

export function resolveUrlForStatus(override: string | undefined): UrlResolution {
  const fromFlag = override?.trim()
  if (fromFlag) return { url: trimTrailingSlash(fromFlag), source: 'flag' }
  const fromEnv = process.env[URL_ENV_VAR]?.trim()
  if (fromEnv) return { url: trimTrailingSlash(fromEnv), source: 'env' }
  const fromConfig = loadConfig()?.url?.trim()
  if (fromConfig) return { url: trimTrailingSlash(fromConfig), source: 'config' }
  return { url: null, source: 'unset' }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

interface SsoCacheRaw {
  access_token?: string
  expires_at?: string
}

function readSsoCacheRaw(path: string): SsoCacheRaw | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SsoCacheRaw
  } catch {
    return null
  }
}

export interface MeUser {
  id?: string
  username?: string
  displayName?: string | null
  role?: string
}

export type MeProbeResult =
  | { ok: true; user: MeUser; exchanged: boolean }
  | { ok: false; reason: string }

/**
 * Call /api/auth/me with the token; if it is an IdP-issued JWT, first go through
 * oauth/exchange to get an a2wave self-signed token. Returns a structured reason on
 * failure instead of throwing.
 *
 * Identifies our own HS256 session rather than enumerating IdP algorithms — the server
 * accepts RS256/RS384/RS512/PS256/ES256/ES384, so an RS256-only test made `a2wave status`
 * report a broken connection on every deployment whose IdP signs with anything else.
 * Mirrors needsIdaasExchange() in client.ts; keep the two in step.
 */
export async function probeMe(baseUrl: string, token: string): Promise<MeProbeResult> {
  const { header } = parseJwt(token)
  let bearer = token
  let exchanged = false

  if (typeof header?.alg === 'string' && header.alg !== 'HS256') {
    const exchangeRes = await fetchWithTimeout(`${baseUrl}/api/auth/oauth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'a2wave-cli' },
      body: JSON.stringify({ idaasToken: token }),
    })
    if (!exchangeRes.ok) {
      const body = await exchangeRes.text().catch(() => '')
      return { ok: false, reason: `exchange failed HTTP ${exchangeRes.status} ${body}` }
    }
    const parsed = (await exchangeRes.json().catch(() => null)) as {
      data?: { token?: string }
    } | null
    if (!parsed?.data?.token) return { ok: false, reason: 'exchange response missing data.token' }
    bearer = parsed.data.token
    exchanged = true
  }

  const meRes = await fetchWithTimeout(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  if (!meRes.ok) {
    return { ok: false, reason: `/auth/me HTTP ${meRes.status}` }
  }
  const meParsed = (await meRes.json().catch(() => null)) as { data?: MeUser } | null
  if (!meParsed?.data) return { ok: false, reason: '/auth/me response missing data' }
  return { ok: true, user: meParsed.data, exchanged }
}

function isExpired(expSec: number | undefined): boolean {
  return typeof expSec === 'number' && expSec * 1000 <= Date.now()
}

/**
 * Run every probe, in dependency order: instance → sso cache → credentials →
 * user. A check that cannot run because an earlier one failed is a `warn` naming
 * what it is waiting on, mirroring what the human output has always said
 * ("skipped (URL not set)") — it is not evidence of a problem in its own right,
 * and reporting it as one would fire twice for a single root cause.
 */
export async function runChecks(options: RunChecksOptions = {}): Promise<CheckReport> {
  const checks: Check[] = []
  const { url, source } = resolveUrlForStatus(options.urlOverride)

  // ---------- instance.url ----------
  if (url) {
    checks.push({
      name: 'instance.url',
      status: 'pass',
      message: `${url} (source: ${source})`,
      detail: { url, source },
    })
  } else {
    checks.push({
      name: 'instance.url',
      status: 'fail',
      message: 'not set',
      hint: HINT_SET_URL,
      detail: { source },
    })
  }

  // ---------- instance.health ----------
  let instanceReachable = false
  if (!url) {
    checks.push({
      name: 'instance.health',
      status: 'warn',
      message: 'skipped: waiting on instance.url (URL not set)',
      hint: HINT_SET_URL,
    })
  } else {
    try {
      const res = await fetchWithTimeout(`${url}/api/health`)
      instanceReachable = res.ok
      checks.push(
        res.ok
          ? {
              name: 'instance.health',
              status: 'pass',
              message: `ok (HTTP ${res.status})`,
              detail: { httpStatus: res.status },
            }
          : {
              name: 'instance.health',
              status: 'fail',
              message: `HTTP ${res.status}`,
              hint: HINT_UNREACHABLE,
              detail: { httpStatus: res.status },
            },
      )
    } catch (err) {
      checks.push({
        name: 'instance.health',
        status: 'fail',
        message: `unreachable (${(err as Error).message})`,
        hint: HINT_UNREACHABLE,
        detail: { url },
      })
    }
  }

  // ---------- sso.cache ----------
  // The cache is OPTIONAL: a password-login install never writes one, so a
  // missing or stale cache warns and never fails the rollup.
  const tokenCachePath = resolveTokenCachePath()
  const ssoCache = readSsoCacheRaw(tokenCachePath)
  if (!ssoCache) {
    checks.push({
      name: 'sso.cache',
      status: 'warn',
      message: existsSync(tokenCachePath) ? 'file exists but cannot be parsed' : 'not found',
      hint: HINT_LOGIN,
      detail: { path: tokenCachePath },
    })
  } else if (!ssoCache.access_token) {
    checks.push({
      name: 'sso.cache',
      status: 'warn',
      message: 'file exists but missing access_token',
      hint: HINT_LOGIN,
      detail: { path: tokenCachePath },
    })
  } else {
    const { claims } = parseJwt(ssoCache.access_token)
    const expired = isExpired(claims?.exp)
    checks.push({
      name: 'sso.cache',
      status: expired ? 'warn' : 'pass',
      message: expired ? 'expired' : 'valid',
      ...(expired ? { hint: HINT_LOGIN } : {}),
      detail: {
        path: tokenCachePath,
        token: maskToken(ssoCache.access_token),
        ...(typeof claims?.exp === 'number' ? { expiresAt: claims.exp } : {}),
        ...(claims?.email ? { email: claims.email } : {}),
      },
    })
  }

  // ---------- credentials.token ----------
  // With SSO login the `token` field in ~/.a2wave/config.json is the IdP-issued
  // JWT itself (same source as the SSO cache), not an a2wave self-signed token.
  // The a2wave 24h short-lived token is exchanged on every API call by client.ts
  // and lives only in memory, so there is nothing on disk to check for it.
  const cfg = loadConfig()
  const token = cfg?.token
  if (!token) {
    checks.push({
      name: 'credentials.token',
      status: 'warn',
      message: 'not logged in',
      hint: HINT_LOGIN,
    })
  } else {
    const { header, claims } = parseJwt(token)
    const alg = header?.alg ?? 'unknown'
    // Any non-HS256 algorithm is an IdP-issued token; naming the actual alg beats
    // hardcoding RS256, which mislabelled ES256/PS256 deployments.
    const kind = alg === 'HS256' ? 'a2wave' : alg === 'unknown' ? 'unknown' : 'sso'
    const expired = isExpired(claims?.exp)
    const detail: Record<string, unknown> = {
      kind,
      alg,
      token: maskToken(token),
      sameAsSsoCache: ssoCache?.access_token === token,
      ...(typeof claims?.exp === 'number' ? { expiresAt: claims.exp } : {}),
    }
    if (expired) {
      // Unlike the SSO cache, this one IS a failure: it is the credential every
      // API call uses, and an expired one means nothing works.
      checks.push({
        name: 'credentials.token',
        status: 'fail',
        message: `expired ${kind === 'sso' ? `SSO JWT (${alg})` : 'token'}`,
        hint: HINT_LOGIN,
        detail,
      })
    } else if (kind === 'unknown') {
      checks.push({
        name: 'credentials.token',
        status: 'warn',
        message: `unknown token type (alg=${alg})`,
        hint: HINT_LOGIN,
        detail,
      })
    } else {
      checks.push({
        name: 'credentials.token',
        status: 'pass',
        message: kind === 'sso' ? `SSO JWT (${alg})` : 'a2wave self-signed token (HS256)',
        detail,
      })
    }
  }

  // ---------- user.identity ----------
  // Needs all three of the above: a URL to call, a reachable backend, and a
  // credential to present. Each missing precondition names itself, so a reader
  // is told what to fix rather than being handed a bare "skipped".
  if (!url) {
    checks.push({
      name: 'user.identity',
      status: 'warn',
      message: 'skipped: waiting on instance.url (URL not set)',
      hint: HINT_SET_URL,
    })
  } else if (!instanceReachable) {
    checks.push({
      name: 'user.identity',
      status: 'warn',
      message: 'skipped: waiting on instance.health (instance unreachable)',
      hint: HINT_SET_URL,
    })
  } else if (!token) {
    checks.push({
      name: 'user.identity',
      status: 'warn',
      message: 'skipped: waiting on credentials.token (not logged in)',
      hint: HINT_LOGIN,
    })
  } else {
    try {
      const me = await probeMe(url, token)
      if (me.ok) {
        checks.push({
          name: 'user.identity',
          status: 'pass',
          message: me.user.username ?? '<unknown>',
          detail: {
            id: me.user.id ?? null,
            username: me.user.username ?? null,
            displayName: me.user.displayName ?? null,
            role: me.user.role ?? null,
            exchanged: me.exchanged,
          },
        })
      } else {
        checks.push({
          name: 'user.identity',
          status: 'fail',
          message: me.reason,
          hint: HINT_LOGIN,
        })
      }
    } catch (err) {
      checks.push({
        name: 'user.identity',
        status: 'fail',
        message: `probe failed: ${(err as Error).message}`,
        hint: HINT_LOGIN,
      })
    }
  }

  return { ok: !checks.some((check) => check.status === 'fail'), checks }
}
