import { homedir } from 'node:os'
import { join } from 'node:path'
/**
 * `a2wave status` — one-stop self-check: URL resolution, SSO token cache, a2wave
 * credentials, backend connectivity, current user identity.
 *
 * This file is the RENDERER only. Every probe lives in lib/checks.ts and answers
 * as data, which is what lets `--json` exist at all: the command used to
 * interleave probing with `printKv` calls, so there was nothing to serialize and
 * an agent had to scrape a coloured column layout to learn whether its own CLI
 * was healthy. Two rules follow from the split:
 *   - all colour is applied here, never in checks.ts
 *   - the human layout is derived from `check.detail`, so the two modes can
 *     never report different facts
 *
 * Design principles that survive the split unchanged:
 *   - No section failure aborts the overall output (status is a diagnostic command; it must not crash itself)
 *   - Never writes any file (read-only)
 *   - Network probes carry a timeout to avoid hanging when offline / API is down
 */
import { defineCommand } from 'citty'
import { type Check, type CheckReport, maskToken, runChecks } from '../lib/checks.js'
import { emit, jsonArg } from '../lib/output.js'

const CONFIG_FILE = join(homedir(), '.a2wave', 'config.json')

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

/** Look a check up by its stable id. Absent is impossible — runChecks emits all five. */
function pick(report: CheckReport, name: string): Check {
  const found = report.checks.find((check) => check.name === name)
  if (!found) throw new Error(`missing check: ${name}`)
  return found
}

function str(check: Check, key: string): string | undefined {
  const value = check.detail?.[key]
  return typeof value === 'string' ? value : undefined
}

function num(check: Check, key: string): number | undefined {
  const value = check.detail?.[key]
  return typeof value === 'number' ? value : undefined
}

function renderInstance(report: CheckReport): void {
  const urlCheck = pick(report, 'instance.url')
  const healthCheck = pick(report, 'instance.health')
  printSection('a2wave instance')
  const url = str(urlCheck, 'url')
  if (!url) {
    printKv('URL:', c.warn('not set'))
    console.log(
      c.dim('Set it: a2wave config set-url <URL>, or export A2WAVE_URL=<URL>, or pass --url <URL>'),
    )
    return
  }
  printKv('URL:', `${url}  ${c.dim(`(source: ${str(urlCheck, 'source')})`)}`)
  if (healthCheck.status === 'pass') {
    printKv('Health:', `${ICON_OK} ${c.ok('ok')} (HTTP ${num(healthCheck, 'httpStatus')})`)
  } else if (typeof num(healthCheck, 'httpStatus') === 'number') {
    printKv('Health:', `${ICON_BAD} HTTP ${num(healthCheck, 'httpStatus')}`)
  } else {
    // `unreachable (<reason>)` — split so the label stays coloured and the
    // transport reason (ECONNREFUSED, timeouts) stays readable beside it.
    const reason = healthCheck.message.replace(/^unreachable \(|\)$/g, '')
    printKv('Health:', `${ICON_BAD} ${c.bad('unreachable')} (${reason})`)
  }
}

function renderSsoCache(report: CheckReport): void {
  const sso = pick(report, 'sso.cache')
  // Cache path resolves in two tiers: env A2WAVE_OAUTH_CACHE_PATH > ~/.a2wave/oauth.json
  printSection('SSO token cache', `(${str(sso, 'path')})`)
  const token = str(sso, 'token')
  if (!token) {
    printKv('Status:', `${ICON_BAD} ${c.bad(sso.message)}`)
    return
  }
  const expired = sso.status !== 'pass'
  printKv('Status:', expired ? `${ICON_BAD} ${c.bad('expired')}` : `${ICON_OK} ${c.ok('valid')}`)
  printKv('Token:', c.dim(token))
  printKv('Expires:', describeExpiry(num(sso, 'expiresAt')))
  const email = str(sso, 'email')
  if (email) printKv('Email:', email)
}

function renderCredentials(report: CheckReport): void {
  const cred = pick(report, 'credentials.token')
  // Key note: with SSO login, the token field in ~/.a2wave/config.json is the
  // IdP-issued JWT itself (same source as the SSO cache), not an a2wave self-signed
  // token. The a2wave 24h short-lived token is exchanged on every API call by
  // client.ts via oauth/exchange, lives only in memory, and is never persisted.
  printSection('a2wave credentials', `(${CONFIG_FILE})`)
  const kind = str(cred, 'kind')
  if (!kind) {
    printKv('Token:', `${ICON_BAD} ${c.warn('not logged in')} ${c.dim('(run a2wave login)')}`)
    return
  }
  const alg = str(cred, 'alg') ?? 'unknown'
  const expiresAt = num(cred, 'expiresAt')
  if (kind === 'sso') {
    // Any non-HS256 algorithm is an IdP-issued token; naming the actual alg beats
    // hardcoding RS256, which mislabelled ES256/PS256 deployments.
    const sameAsSsoCache = cred.detail?.sameAsSsoCache === true
    printKv(
      'Type:',
      `SSO JWT (${alg})${sameAsSsoCache ? c.dim(', same source as the SSO cache') : ''}`,
    )
    printKv('Expires:', describeExpiry(expiresAt))
    console.log(
      c.dim(
        'Note: the a2wave 24h short-lived token is exchanged on every API call, kept in memory only, never written to disk.',
      ),
    )
  } else if (kind === 'a2wave') {
    printKv('Type:', 'a2wave self-signed token (HS256)')
    printKv('Token:', c.dim(str(cred, 'token') ?? maskToken('')))
    printKv('Expires:', describeExpiry(expiresAt))
  } else {
    printKv('Type:', c.warn(`unknown (alg=${alg})`))
    printKv('Token:', c.dim(str(cred, 'token') ?? maskToken('')))
  }
}

function renderUser(report: CheckReport): void {
  const user = pick(report, 'user.identity')
  printSection('Current user')
  if (user.status === 'warn') {
    // The check names the precondition it is waiting on; the human line has
    // always been the shorter "skipped (<reason>)" form.
    const reason = user.message.includes('URL not set')
      ? 'URL not set'
      : user.message.includes('not logged in')
        ? 'not logged in'
        : 'instance unreachable'
    console.log(c.dim(`skipped (${reason})`))
    return
  }
  if (user.status === 'fail') {
    console.log(`${ICON_BAD} ${c.bad(user.message)}`)
    return
  }
  // /api/auth/me does not return email; displayName / username suffice —
  // the SSO email was already shown in the "SSO token cache" section.
  printKv('Username:', str(user, 'username') ?? c.dim('<unknown>'))
  const displayName = str(user, 'displayName')
  if (displayName) printKv('Display:', displayName)
  const role = str(user, 'role')
  printKv('Role:', role === 'admin' ? c.ok(role) : (role ?? c.dim('<unknown>')))
  printKv('ID:', str(user, 'id') ?? c.dim('<unknown>'))
  if (user.detail?.exchanged === true) {
    console.log(c.dim('(automatically exchanged the SSO JWT for an a2wave token)'))
  }
}

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    agentMeta: { risk: 'read' },
    description:
      'Show current a2wave CLI status: URL / credentials / SSO cache / backend health / current user',
  },
  args: {
    url: {
      type: 'string',
      description: 'One-off override of the a2wave instance URL (for the health probe)',
    },
    ...jsonArg,
  },
  run: async ({ args }) => {
    const report = await runChecks({ urlOverride: args.url as string | undefined })
    if (emit(args, report)) return

    renderInstance(report)
    renderSsoCache(report)
    renderCredentials(report)
    renderUser(report)
    console.log()
  },
})
