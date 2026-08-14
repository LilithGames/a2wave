/**
 * Machine-readable output support.
 *
 * Every read-oriented command accepts `--json`, so scripts and CI can consume
 * the raw API payload instead of scraping the human-formatted columns. The two
 * modes are mutually exclusive by construction: `emit()` either prints JSON and
 * returns true (telling the caller to skip its own formatting), or returns
 * false and leaves printing to the caller.
 */

import { parseFieldPaths, projectFields } from './fields.js'

/** Shared args fragment: add `...jsonArg` to any command that can emit JSON. */
export const jsonArg = {
  json: {
    type: 'boolean' as const,
    description: 'Emit the raw payload as compact JSON (for scripts, CI and agents)',
  },
  'json-pretty': {
    type: 'boolean' as const,
    description: 'Like --json, but indented for reading (10-30% more bytes)',
  },
  fields: {
    type: 'string' as const,
    description:
      'Keep only these comma-separated paths, e.g. data[].id,data[].name (implies --json)',
  },
  'show-secrets': {
    type: 'boolean' as const,
    description:
      'With --json, print credentials in plaintext instead of ******** (use only when piping to a secure consumer)',
  },
}

/**
 * Whether JSON output was requested. Citty gives booleans as `true`/undefined.
 *
 * `--json-pretty` implies `--json`: it names a *layout*, and requiring both
 * spellings would make the pretty flag alone a silent no-op that prints the
 * human table instead.
 */
export function wantsJson(args: Record<string, unknown>): boolean {
  return args.json === true || args['json-pretty'] === true || typeof args.fields === 'string'
}

const REDACTED = '********'

/**
 * Credential-bearing keys the API returns in plaintext to an owner/editor.
 *
 * The server masks these for viewers but deliberately reveals them to members
 * who could edit them anyway — the Web UI gates that behind a "click the eye"
 * affordance. A CLI has no such affordance: `--json` output lands in terminal
 * scrollback, shell history, and CI logs, so it is redacted by default and
 * released only with an explicit `--show-secrets`.
 *
 * Matching is on the key name, at any depth, so nested shapes
 * (`config.providerChain[].providerApiKey`, `feishuConfig.appSecret`,
 * `env.X.value`) are covered without enumerating every container.
 */
/**
 * NOTE: this is a DENYLIST, so it fails open.
 *
 * A credential field added to the API under a name that matches neither this
 * set nor the suffix rule below will be printed in plaintext by `--json`. That
 * is a deliberate trade — an allowlist would silently drop useful non-secret
 * fields as the API grows, which is a worse default for a machine-readable
 * mode — but it means this list has to be revisited whenever a new secret-
 * bearing column lands. The container and URL rules below exist because two
 * whole shapes (free-form maps, embedded URL credentials) cannot be covered by
 * name matching at all.
 */
const SECRET_KEYS = new Set([
  'appSecret',
  'apiKey',
  'endpointApiKey',
  'a2aEndpointApiKey',
  'providerApiKey',
  'providerBaseUrl',
  'providerOauthToken',
  'oauthToken',
  'memoryProviderApiKey',
  'embeddingApiKey',
  'botToken',
  'signingSecret',
  'appToken',
  'clientSecret',
  'token',
  'secret',
  'password',
  // SCM credentials. Both evade the suffix rule below — `pat` is three letters
  // with no matching suffix, and `p4passwd` ends in "passwd", not "password".
  // The server masks these on every read, so this is defence-in-depth: its
  // maskScmConfig fails OPEN on an unrecognised `type`, and a third SCM type
  // added before that switch is updated would arrive here in plaintext.
  'pat',
  'p4passwd',
])

/** Case-insensitive suffix match, so `notionToken` / `xxxSecret` are caught too. */
function isSecretKey(key: string): boolean {
  if (SECRET_KEYS.has(key)) return true
  const lower = key.toLowerCase()
  return (
    lower.endsWith('secret') ||
    lower.endsWith('token') ||
    lower.endsWith('apikey') ||
    lower.endsWith('password')
  )
}

/**
 * Containers whose values are ALL credentials regardless of key name.
 *
 * Name-based matching cannot help here: MCP servers store secrets in free-form
 * maps (`env.OPENAI_API_KEY`, `env.P4PASSWD`, `headers.Authorization`,
 * `headers.X-API-Key`), and the key is chosen by whoever configured the server.
 * The API returns these verbatim to an owner/admin — it only masks them for a
 * non-owner viewer — so the CLI must mask the whole map itself.
 */
const SECRET_CONTAINER_KEYS = new Set(['env', 'headers'])

/**
 * Any key whose value is a URL. Masking is done on the URL's PARTS, so this can
 * be permissive: a link with nothing secret in it comes back unchanged.
 */
const URL_KEYS = new Set(['url', 'repoUrl', 'endpoint', 'baseUrl'])

/**
 * Strip the credential-bearing PARTS of a URL, keeping scheme, host and path.
 *
 * Secrets live in the userinfo (`user:tok@`), the query (`?apikey=…`) and the
 * fragment. The path is kept: reducing everything to `origin/********` made
 * every source on one host identical, turned scp-style `git@host:org/repo` into
 * a bare `********`, and — the reason this was rewritten — destroyed the
 * server's `********@host/path` sentinel, which `isMaskedRepoUrl` relies on to
 * mean "keep the stored value". That broke the documented
 * `scm get --json` → edit → `scm update --config-file` round-trip, persisting
 * an unusable repo URL.
 *
 * A token embedded in the PATH (`/sse/<token>`, an MCP convention) still needs
 * hiding, so a path segment that looks like a credential is masked on its own
 * while the rest of the path survives.
 *
 * Non-URL strings (scp-style `git@host:org/repo`) are returned unchanged: they
 * carry a username, not a password. This mirrors the server's own
 * `redactRepoUrlCredential`.
 */
function redactUrl(u: string): string {
  if (!u) return u
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return u
  }

  let changed = false
  if (parsed.username || parsed.password) {
    // Keep the sentinel shape the server uses, so a masked value still
    // round-trips through `--config-file` as "unchanged".
    parsed.password = ''
    parsed.username = REDACTED
    changed = true
  }
  if (parsed.search) {
    parsed.search = `?${REDACTED}`
    changed = true
  }
  if (parsed.hash) {
    parsed.hash = `#${REDACTED}`
    changed = true
  }

  // Opaque high-entropy path segments are the MCP token convention. Anything
  // short or wordlike is a normal path component and stays readable.
  const segments = parsed.pathname.split('/')
  const masked = segments.map((seg) =>
    seg.length >= 20 && /^[A-Za-z0-9._~-]+$/.test(seg) && /\d/.test(seg) ? REDACTED : seg,
  )
  if (masked.some((seg, i) => seg !== segments[i])) {
    parsed.pathname = masked.join('/')
    changed = true
  }

  return changed ? parsed.toString() : u
}

/** Mask every value of a free-form map, keeping the keys visible. */
function redactValues(rec: unknown): unknown {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return redactSecrets(rec)
  return Object.fromEntries(
    Object.entries(rec as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === 'string' ? REDACTED : redactSecrets(v),
    ]),
  )
}

/**
 * Deep-copy `value`, replacing credential values with `********`.
 *
 * Three rules, because secrets reach the CLI in three different shapes:
 *  1. the key name looks like a credential (`appSecret`, `providerApiKey`, …);
 *  2. the key is an Agent env entry `{value, sensitive: true}` — the marker is
 *     the sibling flag, since env var names are arbitrary;
 *  3. the key is a free-form secret container (`env` / `headers` on an MCP
 *     server) — every value inside is masked, keys stay visible.
 *
 * `url` is special-cased rather than masked outright: the origin is useful and
 * only the credential-bearing parts need to go. Recursion covers `groupConfig`
 * backends, which nest the same shapes one level down.
 *
 * Only strings are redacted — `oauthToken: null` is more useful left intact,
 * since it tells you the field is unset.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value === null || typeof value !== 'object') return value

  const source = value as Record<string, unknown>
  const sensitiveEnvEntry = source.sensitive === true && typeof source.value === 'string'

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(source)) {
    if (SECRET_CONTAINER_KEYS.has(key)) {
      out[key] = redactValues(val)
      continue
    }
    if (URL_KEYS.has(key) && typeof val === 'string') {
      out[key] = redactUrl(val)
      continue
    }
    if (typeof val === 'string' && (isSecretKey(key) || (sensitiveEnvEntry && key === 'value'))) {
      out[key] = REDACTED
      continue
    }
    out[key] = redactSecrets(val)
  }
  return out
}

/**
 * Print `payload` as JSON when `--json` (or `--json-pretty`) is set.
 *
 * Returns true when it printed, so callers read as:
 *   if (emit(args, data)) return
 *   ...human formatting...
 *
 * Credentials are redacted unless `--show-secrets` is passed, matching what the
 * human-readable path already does (it prints `********` for sensitive env vars
 * and never echoes `config` values).
 *
 * Output is compact by default; `--json-pretty` indents it. The human-readable
 * path stays the default for a bare invocation, so nothing that scrapes today
 * changes — only `--json` consumers see the smaller payload, and they parse it.
 */
export function emit(args: Record<string, unknown>, payload: unknown): boolean {
  if (!wantsJson(args)) return false

  // Redact FIRST, then project. redactSecrets reads sibling keys to decide what
  // is secret (an env entry is `{value, sensitive: true}`), so projecting first
  // would strip the marker and print the value in clear. See lib/fields.ts.
  const safe = args['show-secrets'] === true ? payload : redactSecrets(payload)

  let output = safe
  if (typeof args.fields === 'string') {
    const { value, unmatched } = projectFields(safe, parseFieldPaths(args.fields))
    output = value
    if (unmatched.length > 0 && isPlainRecord(value)) {
      // Namespaced under `_meta` so it cannot collide with a real payload key,
      // and only present when something actually missed — an agent that named a
      // field wrong gets told, without a second round-trip.
      output = { ...value, _meta: { unmatchedFields: unmatched } }
    }
  }

  // Compact by default: this output is read by an agent far more often than by
  // a human. Indentation is 9-25% of the bytes depending on payload shape —
  // highest on wide, short-valued rows, lowest when a long systemPrompt
  // dominates. `--json-pretty` buys the indentation back for human eyes.
  // For the large win, reach for `--fields` (>90% on a list projection).
  const indent = args['json-pretty'] === true ? 2 : undefined
  console.log(JSON.stringify(output, null, indent))
  return true
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
