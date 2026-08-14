import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
/**
 * `a2wave status` — one-stop self-check: URL resolution, SSO token cache, a2wave
 * credentials, backend connectivity, current user identity. Design principles:
 *   - No section failure aborts the overall output (status is a diagnostic command; it must not crash itself)
 *   - Never writes any file (read-only)
 *   - Network probes carry a timeout to avoid hanging when offline / API is down
 */
import { defineCommand } from 'citty'
import { loadConfig } from '../config.js'
import { resolveTokenCachePath } from '../lib/token-cache.js'

const CONFIG_FILE = join(homedir(), '.a2wave', 'config.json')
const URL_ENV_VAR = 'A2WAVE_URL'
const PROBE_TIMEOUT_MS = 5000

// ---------------------------------------------------------------------------
// Color helpers — enabled only on TTY without NO_COLOR. Hand-rolled ANSI to avoid a chalk dependency.
// ---------------------------------------------------------------------------
const ENABLE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

function ansi(code: string, s: string): string {
  return ENABLE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s
}

const c = {
  ok: (s: string) => ansi('32', s), // green
  bad: (s: string) => ansi('31', s), // red
  warn: (s: string) => ansi('33', s), // yellow
  dim: (s: string) => ansi('2', s),
  bold: (s: string) => ansi('1', s),
}

const ICON_OK = c.ok('✓')
const ICON_BAD = c.bad('✗')

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

function parseJwt(token: string): { header: JwtHeader | null; claims: JwtClaims | null } {
  const parts = token.split('.')
  if (parts.length < 2) return { header: null, claims: null }
  return {
    header: decodeBase64UrlJson<JwtHeader>(parts[0]),
    claims: decodeBase64UrlJson<JwtClaims>(parts[1]),
  }
}

/** Truncate and mask the token to avoid leaking it into stdout-captured logs. */
function maskToken(token: string): string {
  if (token.length <= 8) return '****'
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

/**
 * Render a seconds-epoch as "ISO + remaining/expired time" with color:
 *   - expired: red
 *   - expiring within 24h: yellow
 *   - otherwise: default color
 */
function describeExpiry(epochSec: number | undefined): string {
  if (typeof epochSec !== 'number' || !Number.isFinite(epochSec)) return c.dim('unknown')
  const ms = epochSec * 1000
  const iso = new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC')
  const diffSec = Math.floor((ms - Date.now()) / 1000)
  if (diffSec <= 0) return `${iso} (${c.bad(`expired ${humanDuration(-diffSec)} ago`)})`
  const tail = `${humanDuration(diffSec)} left`
  const colored = diffSec < 86_400 ? c.warn(tail) : tail
  return `${iso} (${colored})`
}

function humanDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 48) return `${hr}h${min % 60 ? ` ${min % 60}m` : ''}`
  const day = Math.floor(hr / 24)
  return `${day}d${hr % 24 ? ` ${hr % 24}h` : ''}`
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

interface UrlResolution {
  url: string | null
  source: 'flag' | 'env' | 'config' | 'unset'
}

function resolveUrlForStatus(override: string | undefined): UrlResolution {
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

function printSection(title: string, subtitle?: string): void {
  console.log()
  console.log(subtitle ? `${c.bold(title)} ${c.dim(subtitle)}` : c.bold(title))
}

/**
 * Compute a string's visual width — CJK / fullwidth chars count as 2 columns, others as 1.
 * Keeps keys of different widths aligned to the same column.
 * Note: skips ANSI escape sequences (\x1b[...m) so color codes don't count.
 */
function visualWidth(s: string): number {
  let w = 0
  let i = 0
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b && s[i + 1] === '[') {
      // skip the CSI escape up to 'm'
      const end = s.indexOf('m', i + 2)
      if (end === -1) break
      i = end + 1
      continue
    }
    const code = s.codePointAt(i) ?? 0
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      w += 2
    } else {
      w += 1
    }
    i += code > 0xffff ? 2 : 1
  }
  return w
}

const KV_KEY_COL = 9

function printKv(key: string, value: string): void {
  const pad = Math.max(1, KV_KEY_COL - visualWidth(key))
  console.log(`${key}${' '.repeat(pad)}${value}`)
}

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Show current a2wave CLI status: URL / credentials / SSO cache / backend health / current user',
  },
  args: {
    url: {
      type: 'string',
      description: 'One-off override of the a2wave instance URL (for the health probe)',
    },
  },
  run: async ({ args }) => {
    const { url, source } = resolveUrlForStatus(args.url as string | undefined)

    // ---------- a2wave instance ----------
    printSection('a2wave instance')
    if (url) {
      printKv('URL:', `${url}  ${c.dim(`(source: ${source})`)}`)
      try {
        const res = await fetchWithTimeout(`${url}/api/health`)
        printKv(
          'Health:',
          res.ok
            ? `${ICON_OK} ${c.ok('ok')} (HTTP ${res.status})`
            : `${ICON_BAD} HTTP ${res.status}`,
        )
      } catch (err) {
        printKv('Health:', `${ICON_BAD} ${c.bad('unreachable')} (${(err as Error).message})`)
      }
    } else {
      printKv('URL:', c.warn('not set'))
      console.log(
        c.dim(
          'Set it: a2wave config set-url <URL>, or export A2WAVE_URL=<URL>, or pass --url <URL>',
        ),
      )
    }

    // ---------- SSO token cache ----------
    // Cache path resolves in two tiers: env A2WAVE_OAUTH_CACHE_PATH > ~/.a2wave/oauth.json
    const tokenCachePath = resolveTokenCachePath()
    printSection('SSO token cache', `(${tokenCachePath})`)
    const ssoCache = readSsoCacheRaw(tokenCachePath)
    if (!ssoCache) {
      printKv(
        'Status:',
        `${ICON_BAD} ${c.bad(existsSync(tokenCachePath) ? 'file exists but cannot be parsed' : 'not found')}`,
      )
    } else if (!ssoCache.access_token) {
      printKv('Status:', `${ICON_BAD} ${c.bad('file exists but missing access_token')}`)
    } else {
      const { claims } = parseJwt(ssoCache.access_token)
      const expSec = claims?.exp
      const expired = typeof expSec === 'number' && expSec * 1000 <= Date.now()
      printKv(
        'Status:',
        expired ? `${ICON_BAD} ${c.bad('expired')}` : `${ICON_OK} ${c.ok('valid')}`,
      )
      printKv('Token:', c.dim(maskToken(ssoCache.access_token)))
      printKv('Expires:', describeExpiry(expSec))
      if (claims?.email) printKv('Email:', claims.email)
    }

    // ---------- a2wave local credentials ----------
    // Key note: with SSO login, the token field in ~/.a2wave/config.json is the
    // IdP-issued JWT itself (same source as the SSO cache), not an a2wave self-signed
    // token. The a2wave 24h short-lived token is exchanged on every API call by
    // client.ts via oauth/exchange, lives only in memory, and is never persisted.
    printSection('a2wave credentials', `(${CONFIG_FILE})`)
    const cfg = loadConfig()
    if (!cfg?.token) {
      printKv('Token:', `${ICON_BAD} ${c.warn('not logged in')} ${c.dim('(run a2wave login)')}`)
    } else {
      const { header, claims } = parseJwt(cfg.token)
      const alg = header?.alg ?? 'unknown'
      const sameAsSsoCache = ssoCache?.access_token === cfg.token
      if (alg !== 'HS256' && alg !== 'unknown') {
        // Any non-HS256 algorithm is an IdP-issued token; naming the actual alg beats
        // hardcoding RS256, which mislabelled ES256/PS256 deployments.
        printKv(
          'Type:',
          `SSO JWT (${alg})${sameAsSsoCache ? c.dim(', same source as the SSO cache') : ''}`,
        )
        printKv('Expires:', describeExpiry(claims?.exp))
        console.log(
          c.dim(
            'Note: the a2wave 24h short-lived token is exchanged on every API call, kept in memory only, never written to disk.',
          ),
        )
      } else if (alg === 'HS256') {
        printKv('Type:', 'a2wave self-signed token (HS256)')
        printKv('Token:', c.dim(maskToken(cfg.token)))
        printKv('Expires:', describeExpiry(claims?.exp))
      } else {
        printKv('Type:', c.warn(`unknown (alg=${alg})`))
        printKv('Token:', c.dim(maskToken(cfg.token)))
      }
    }

    // ---------- Current user (needs URL + credentials + reachable backend) ----------
    printSection('Current user')
    if (!url) {
      console.log(c.dim('skipped (URL not set)'))
    } else if (!cfg?.token) {
      console.log(c.dim('skipped (not logged in)'))
    } else {
      try {
        const me = await probeMe(url, cfg.token)
        if (me.ok) {
          // /api/auth/me does not return email; displayName / username suffice —
          // the SSO email was already shown in the "SSO token cache" section.
          printKv('Username:', me.user.username ?? c.dim('<unknown>'))
          if (me.user.displayName) printKv('Display:', me.user.displayName)
          const role = me.user.role
          printKv('Role:', role === 'admin' ? c.ok(role) : (role ?? c.dim('<unknown>')))
          printKv('ID:', me.user.id ?? c.dim('<unknown>'))
          if (me.exchanged)
            console.log(c.dim('(automatically exchanged the SSO JWT for an a2wave token)'))
        } else {
          console.log(`${ICON_BAD} ${c.bad(me.reason)}`)
        }
      } catch (err) {
        console.log(`${ICON_BAD} ${c.bad(`probe failed: ${(err as Error).message}`)}`)
      }
    }
    console.log()
  },
})

interface MeUser {
  id?: string
  username?: string
  displayName?: string | null
  role?: string
}

type MeProbeResult = { ok: true; user: MeUser; exchanged: boolean } | { ok: false; reason: string }

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
async function probeMe(baseUrl: string, token: string): Promise<MeProbeResult> {
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
