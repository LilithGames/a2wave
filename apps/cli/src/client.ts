import { resolveCredential, resolveUrl } from './config.js'
import { CliError, type CliErrorType } from './errors.js'

/**
 * Longest server body embedded in an error message.
 *
 * A 5xx can answer with a whole HTML error page, and a zod failure with a
 * multi-kilobyte dump. Untruncated, that lands in a terminal scrollback, a CI
 * log, or an agent's context window. The head is kept because a server error
 * puts its summary first.
 */
const MAX_ERROR_BODY_CHARS = 2000

/**
 * Map an HTTP status onto a stable branch key.
 *
 * An agent recovers from a failure by branching on it, and matching the prose
 * of a message breaks the moment anyone rewords it. The status is the one
 * thing the server always states unambiguously.
 *
 * 401 is absent on purpose: `request()` intercepts it before any caller sees an
 * ApiError, and turns it into an auth error carrying a login hint.
 */
function classifyStatus(status: number): CliErrorType {
  if (status === 403) return 'permission'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (status >= 400) return 'validation'
  return 'cli'
}

function clipErrorBody(body: string): string {
  if (body.length <= MAX_ERROR_BODY_CHARS) return body
  return `${body.slice(0, MAX_ERROR_BODY_CHARS)}… (${body.length - MAX_ERROR_BODY_CHARS} more chars truncated)`
}

export class ApiError extends CliError {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`API Error (${status}): ${clipErrorBody(message)}`, {
      type: classifyStatus(status),
      subtype: String(status),
    })
    this.name = 'ApiError'
  }
}

/**
 * Shared args fragment: all data commands (skills/agents/runs) use `args: { ...urlArg, ... }`
 * to gain one-off `--url` override support. Priority is implemented in `resolveUrl`:
 *   --url > $A2WAVE_URL > config.url > error.
 */
export const urlArg = {
  url: {
    type: 'string' as const,
    description: 'One-off override of the a2wave instance URL (highest priority)',
  },
}

export interface ClientOptions {
  /** From the --url CLI flag; highest priority. */
  url?: string
}

interface JwtHeader {
  alg?: string
  typ?: string
  kid?: string
}

/**
 * Does this token need exchanging at `/auth/oauth/exchange` before it can be used?
 *
 * Answered by identifying **our own** session token rather than enumerating the IdP's
 * algorithms. The previous form asked `alg === 'RS256'` and treated everything else as an
 * a2wave session — but the server verifies OIDC tokens with RS256/RS384/RS512/PS256/ES256/
 * ES384 (ALLOWED_ALGS in apps/api/src/lib/oidc.ts). An IdP signing with ES256 therefore had
 * its token sent straight to `/api/*` as if it were a session, where HS256 verification
 * rejected it: `a2wave login` reported success and every subsequent command failed 401.
 * Enumerating the far side is the wrong direction — it silently breaks whenever the server
 * gains an algorithm.
 *
 * So: a JWT signed with anything other than HS256 is an IdP token and gets exchanged.
 * a2wave signs its own sessions with HS256 (`sign(payload, AUTH_SECRET)`) and verifies them
 * as HS256 explicitly, so that is the one value we can positively identify.
 *
 * Anything that is not a readable JWT is passed through untouched. Every token this CLI
 * stores comes from an a2wave endpoint, so an opaque value is far more likely to be a
 * corrupted or hand-edited config than an IdP credential — and sending it to exchange would
 * report "malformed exchange response" instead of the plain 401 that actually explains it.
 */
function needsIdaasExchange(token: string): boolean {
  const parts = token.split('.')
  if (parts.length < 3) return false
  let header: JwtHeader
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8')) as JwtHeader
  } catch {
    return false
  }
  if (typeof header.alg !== 'string') return false
  return header.alg !== 'HS256'
}

/** POST IDaaS JWT to /api/auth/oauth/exchange and return the a2wave-signed token. */
async function exchangeIdaasToken(baseUrl: string, idaasJwt: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/auth/oauth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'a2wave-cli' },
      body: JSON.stringify({ idaasToken: idaasJwt }),
    })
  } catch (err) {
    throw new CliError(`Cannot connect to ${baseUrl}: ${(err as Error).message}`, {
      type: 'network',
      hint: 'a2wave status',
    })
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 503) {
      // Two different 503s reach here and they need different advice: the IdP
      // being briefly unreachable is worth retrying, whereas OAuth not being
      // configured never resolves on its own.
      if (body.includes('IDP_UNAVAILABLE')) {
        throw new CliError(
          [
            `The identity provider could not be reached (${baseUrl}, status=503).`,
            'Your credentials are not the problem — no need to re-login or re-issue a token.',
            'Retry shortly; if it persists, ask ops to check connectivity to the OIDC issuer.',
          ].join('\n'),
        )
      }
      throw new CliError(
        [
          `Server OAuth is not enabled (${baseUrl}, status=503): ${body}`,
          'Enable oauthEnabled in the Web UI under "Settings → Auth & Security",',
          'or have ops configure enterprise OIDC login (A2WAVE_OIDC_*);',
          'or use a2wave login --password for legacy password login.',
        ].join('\n'),
      )
    }
    if (res.status === 401) {
      throw new CliError(
        `IDaaS token expired or invalid. Log in again: a2wave login (status=401, body=${body})`,
      )
    }
    throw new CliError(`OAuth exchange failed (${res.status}): ${body}`)
  }

  const parsed = (await res.json()) as { data: { token: string } }
  if (!parsed?.data?.token)
    throw new CliError('Malformed OAuth exchange response: missing data.token')
  return parsed.data.token
}

export function createClient(opts: ClientOptions = {}) {
  // Order matters: resolve the URL FIRST, then ask for the credential that
  // belongs to it. These two lines used to be independent — `requireToken()`
  // took no argument — so `--url https://other` paired that instance with the
  // stored token for a completely different one, leaked it to that host, and
  // surfaced as a 401 blaming the user's login.
  const url = resolveUrl(opts.url)
  const initialToken = resolveCredential(url)

  // a2wave session token: exchanged on demand at the first request, reused afterwards.
  let sessionToken: string | null = needsIdaasExchange(initialToken) ? null : initialToken
  let exchangePromise: Promise<string> | null = null

  async function getSessionToken(): Promise<string> {
    if (sessionToken) return sessionToken
    // Concurrent requests: reuse the same exchange call
    if (!exchangePromise) {
      exchangePromise = exchangeIdaasToken(url, initialToken).then((tok) => {
        sessionToken = tok
        return tok
      })
    }
    return exchangePromise
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const token = await getSessionToken()
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...init?.headers,
      },
    })
    if (res.status === 401) {
      // Intercepted here rather than left to ApiError so every caller gets the
      // same recovery instruction, and so `type` says "your credentials", not
      // "the request was rejected".
      throw new CliError('Session expired or invalid.', {
        type: 'auth',
        subtype: 'expired',
        hint: 'a2wave login',
      })
    }
    return res
  }

  async function get<T>(path: string): Promise<T> {
    const res = await request(path)
    if (!res.ok) throw new ApiError(res.status, await res.text())
    return res.json() as Promise<T>
  }

  /**
   * Fetch a Response via the unified auth path (incl. IDaaS exchange) without parsing JSON —
   * for binary downloads (e.g. agents export) and cases that need response headers (content-disposition).
   */
  async function getRaw(path: string): Promise<Response> {
    const res = await request(path)
    if (!res.ok) throw new ApiError(res.status, await res.text())
    return res
  }

  async function patch<T>(path: string, body: unknown): Promise<T> {
    const res = await request(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new ApiError(res.status, await res.text())
    return res.json() as Promise<T>
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new ApiError(res.status, await res.text())
    return res.json() as Promise<T>
  }

  /**
   * PUT exists only for the `a2wave api` escape hatch. No typed command needs it
   * today, but a raw caller reaching a PUT route must still go through this
   * client — an independent fetch would skip the IDaaS exchange above and 401
   * for every OIDC user.
   */
  async function put<T>(path: string, body: unknown): Promise<T> {
    const res = await request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new ApiError(res.status, await res.text())
    return res.json() as Promise<T>
  }

  async function del<T>(path: string): Promise<T> {
    const res = await request(path, { method: 'DELETE' })
    if (!res.ok) throw new ApiError(res.status, await res.text())
    return res.json() as Promise<T>
  }

  async function postStream(path: string, body: unknown): Promise<Response> {
    const res = await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new ApiError(res.status, await res.text())
    return res
  }

  async function postFormData<T>(path: string, formData: FormData): Promise<T> {
    const res = await request(path, {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) throw new ApiError(res.status, await res.text())
    return res.json() as Promise<T>
  }

  // Resolve skl_/agt_/run_ prefixed ID or lookup by name
  /**
   * Uniquely locate one record among candidates by name. On duplicates (name has no
   * unique constraint) it **errors** instead of silently taking the first match —
   * otherwise irreversible operations like `delete <name>` would hit whichever row
   * happens to sort first and delete the wrong object. Consistent with resolveUserId.
   */
  function pickUniqueByName<T extends { id: string; name: string }>(
    rows: T[],
    name: string,
    label: string,
    idPrefix: string,
  ): T {
    const matches = rows.filter((r) => r.name === name)
    if (matches.length === 0) throw new CliError(`${label} not found: "${name}"`)
    if (matches.length > 1) {
      const candidates = matches.map((m) => `  ${m.id}  ${m.name}`).join('\n')
      throw new CliError(
        `Name "${name}" matches multiple ${label} records. Use a ${idPrefix} ID to specify exactly:\n${candidates}`,
      )
    }
    return matches[0]
  }

  async function resolveSkillId(idOrName: string): Promise<string> {
    if (idOrName.startsWith('skl_')) return idOrName
    const result = await get<{ data: Array<{ id: string; name: string }> }>(
      '/api/skills?pageSize=100',
    )
    if (result.data.length >= 100)
      console.warn(
        'Warning: more than 100 Skills; name resolution may be incomplete, use an ID instead',
      )
    return pickUniqueByName(result.data, idOrName, 'Skill', 'skl_').id
  }

  async function resolveAgentId(idOrName: string): Promise<string> {
    if (idOrName.startsWith('agt_')) return idOrName
    const result = await get<{ data: Array<{ id: string; name: string }> }>(
      '/api/agents?pageSize=100',
    )
    if (result.data.length >= 100)
      console.warn(
        'Warning: more than 100 Agents; name resolution may be incomplete, use an ID instead',
      )
    return pickUniqueByName(result.data, idOrName, 'Agent', 'agt_').id
  }

  async function resolveUserId(keyword: string): Promise<string> {
    if (keyword.startsWith('usr_')) return keyword
    const result = await get<{
      data: Array<{
        id: string
        username: string
        displayName: string | null
        email: string | null
      }>
    }>(`/api/user-lookup?q=${encodeURIComponent(keyword)}&limit=10`)
    const matches = result.data
    if (matches.length === 0) throw new CliError(`User not found: ${keyword}`)
    if (matches.length > 1) {
      const candidates = matches
        .map((m) => `  ${m.id}  ${m.username}${m.email ? ` / ${m.email}` : ''}`)
        .join('\n')
      throw new CliError(
        `Multiple users matched. Use a usr_xxx ID to specify exactly:\n${candidates}`,
      )
    }
    return matches[0].id
  }

  async function resolveMcpServerId(idOrName: string): Promise<string> {
    if (idOrName.startsWith('mcp_')) return idOrName
    const result = await get<{ data: Array<{ id: string; name: string }> }>(
      '/api/mcp-servers?pageSize=100',
    )
    if (result.data.length >= 100)
      console.warn(
        'Warning: more than 100 MCP Servers; name resolution may be incomplete, use an ID instead',
      )
    return pickUniqueByName(result.data, idOrName, 'MCP Server', 'mcp_').id
  }

  async function resolveProviderId(idOrName: string): Promise<string> {
    if (idOrName.startsWith('prv_')) return idOrName
    const result = await get<{ data: Array<{ id: string; name: string }> }>(
      '/api/providers?pageSize=100',
    )
    const provider = result.data.find((p) => p.name === idOrName)
    if (!provider)
      throw new CliError(
        `Provider not found: "${idOrName}". Available: ${result.data.map((p) => p.name).join(', ')}`,
      )
    return provider.id
  }

  async function resolveScmSourceId(idOrName: string): Promise<string> {
    if (idOrName.startsWith('scm_')) return idOrName
    const result = await get<{ data: Array<{ id: string; name: string }> }>(
      '/api/scm-sources?pageSize=100',
    )
    return pickUniqueByName(result.data, idOrName, 'SCM Source', 'scm_').id
  }

  async function resolveSkillGroupId(idOrName: string): Promise<string> {
    if (idOrName.startsWith('skg_')) return idOrName
    const result = await get<{ data: Array<{ id: string; name: string }> }>(
      '/api/skill-groups?pageSize=100',
    )
    if (result.data.length >= 100)
      console.warn(
        'Warning: more than 100 Skill Groups; name resolution may be incomplete, use an ID instead',
      )
    return pickUniqueByName(result.data, idOrName, 'Skill Group', 'skg_').id
  }

  async function resolveKbDocumentId(idOrName: string): Promise<string> {
    if (idOrName.startsWith('kbd_')) return idOrName
    const result = await get<{ data: Array<{ id: string; name: string }> }>(
      '/api/kb-documents?pageSize=100',
    )
    if (result.data.length >= 100)
      console.warn(
        'Warning: more than 100 KB Documents; name resolution may be incomplete, use an ID instead',
      )
    return pickUniqueByName(result.data, idOrName, 'KB Document', 'kbd_').id
  }

  /** Find an agent by exact name; returns null when absent (used by the apply command). */
  async function findAgentByName(name: string): Promise<{ id: string; name: string } | null> {
    const result = await get<{ data: Array<{ id: string; name: string }> }>(
      '/api/agents?pageSize=100',
    )
    if (result.data.length >= 100)
      console.warn('Warning: more than 100 Agents; name lookup may be incomplete')
    const matches = result.data.filter((a) => a.name === name)
    if (matches.length === 0) return null
    if (matches.length > 1) {
      throw new CliError(
        `Name conflict: found ${matches.length} Agents with name="${name}" (${matches.map((a) => a.id).join(', ')}). Reference by ID in the yaml, or rename one of them first.`,
      )
    }
    return matches[0]
  }

  return {
    get,
    getRaw,
    patch,
    post,
    put,
    del,
    postStream,
    postFormData,
    resolveSkillId,
    resolveAgentId,
    resolveMcpServerId,
    resolveProviderId,
    resolveScmSourceId,
    resolveSkillGroupId,
    resolveKbDocumentId,
    resolveUserId,
    findAgentByName,
  }
}
