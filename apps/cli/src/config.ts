import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CliError } from './errors.js'

const CONFIG_DIR = join(homedir(), '.a2wave')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const URL_ENV_VAR = 'A2WAVE_URL'

export interface Config {
  /** a2wave instance URL; may be unset in OAuth-only scenarios (user provides via --url / env / config set-url) */
  url?: string
  token: string
  /**
   * Credentials keyed by instance URL.
   *
   * The legacy shape held ONE token with no link to the URL it belonged to, so
   * `--url https://other` sent the stored instance's token to a different
   * deployment and failed as a 401 that blamed the login. Keying by URL is the
   * whole fix; `profiles` below is sugar over this, not a second mechanism.
   */
  credentials?: Record<string, { token: string }>
  /** Named aliases for URLs, for humans switching contexts. */
  profiles?: Record<string, { url: string }>
  currentProfile?: string
}

/** One instance is one key, whatever the caller typed. */
function credentialKey(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Config
  } catch {
    return null
  }
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writePrivateConfig(JSON.stringify(config, null, 2))
}

export function clearConfig(): void {
  if (existsSync(CONFIG_FILE)) writePrivateConfig('{}')
}

function writePrivateConfig(content: string): void {
  writeFileSync(CONFIG_FILE, content, { encoding: 'utf-8', mode: 0o600 })
  chmodSync(CONFIG_FILE, 0o600)
}

/**
 * The token to use against `url`.
 *
 * Migration is implicit and lazy — no version field, no rewrite-on-read. A
 * per-URL credential wins; otherwise the legacy top-level token applies, but
 * ONLY when it belongs to the URL being called. That conditional is the entire
 * bug fix: the fallback used to be unconditional, so targeting a second
 * instance silently reused the first one's token.
 *
 * An old config therefore keeps working untouched, and because nothing is
 * rewritten on read, downgrading to an older CLI still works too.
 */
export function resolveCredential(url: string): string {
  const config = loadConfig()
  if (!config) {
    throw new CliError('Not logged in. Run: a2wave login', {
      type: 'auth',
      subtype: 'not_logged_in',
      hint: 'a2wave login',
    })
  }

  const key = credentialKey(url)
  const perUrl = config.credentials?.[key]?.token
  if (perUrl) return perUrl

  if (config.token && config.url && credentialKey(config.url) === key) return config.token

  // Never fall through to "some token we happen to have". Sending the wrong
  // instance's credential is worse than failing: it leaks it to that host and
  // then reports a 401 that points the caller at their login instead.
  throw new CliError(
    config.token
      ? `No stored credential for ${key} (the saved login is for ${config.url ?? 'another instance'}).`
      : 'Not logged in. Run: a2wave login',
    {
      type: 'auth',
      subtype: config.token ? 'no_credential_for_url' : 'not_logged_in',
      hint: `a2wave login --url ${key}`,
    },
  )
}

/** Store a credential against one instance, leaving the legacy fields alone. */
export function saveCredential(url: string, token: string): void {
  const config = loadConfig() ?? ({ token: '' } as Config)
  const credentials = { ...(config.credentials ?? {}), [credentialKey(url)]: { token } }
  saveConfig({ ...config, credentials })
}

export function saveProfile(name: string, url: string): void {
  const config = loadConfig() ?? ({ token: '' } as Config)
  const profiles = { ...(config.profiles ?? {}), [name]: { url: credentialKey(url) } }
  saveConfig({ ...config, profiles })
}

export function resolveProfileUrl(name: string): string {
  const profiles = loadConfig()?.profiles ?? {}
  const found = profiles[name]
  if (found) return found.url

  const known = Object.keys(profiles)
  throw new CliError(
    known.length > 0
      ? `Unknown profile "${name}". Known profiles: ${known.join(', ')}`
      : `Unknown profile "${name}". No profiles are configured.`,
    { type: 'validation', subtype: 'unknown_profile', hint: 'a2wave config list' },
  )
}

/** Get the token; if missing, the user has never logged in. */
export function requireToken(): string {
  const config = loadConfig()
  if (!config?.token) {
    throw new CliError('Not logged in. Run: a2wave login')
  }
  return config.token
}

/**
 * URL resolution: override (--url flag) > $A2WAVE_URL > config.url > throw a friendly error.
 * Returns the first non-empty match; if none, errors and shows the three ways to set it.
 */
export function resolveUrl(override?: string): string {
  const fromFlag = override?.trim()
  if (fromFlag) return fromFlag.replace(/\/+$/, '')

  const fromEnv = process.env[URL_ENV_VAR]?.trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')

  const fromConfig = loadConfig()?.url?.trim()
  if (fromConfig) return fromConfig.replace(/\/+$/, '')

  throw new CliError(
    [
      'No a2wave instance URL specified. Provide one of the following:',
      '  1. One-off: <command> --url http://localhost:3502',
      `  2. Shell-persistent: export ${URL_ENV_VAR}=http://localhost:3502`,
      '  3. Globally persistent: a2wave config set-url http://localhost:3502',
    ].join('\n'),
  )
}
