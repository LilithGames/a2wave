/**
 * OAuth (SSO) login flow for the a2wave CLI.
 *
 * Default behavior of `a2wave login`:
 *   1. Try to reuse a valid SSO JWT from the token cache
 *      (path resolution: env A2WAVE_OAUTH_CACHE_PATH > ~/.a2wave/oauth.json;
 *      see ../lib/token-cache.ts).
 *   2. If miss/expired: resolve the SSO entry URL from env A2WAVE_SSO_URL, launch system
 *      browser → IdP SSO → callback page extracts the JWT from the URL
 *      fragment and POSTs it back to a local loopback server.
 *   3. Exchange the SSO JWT for an a2wave-signed token via
 *      POST /api/auth/oauth/exchange and save it to ~/.a2wave/config.json.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { dirname } from 'node:path'
import { loadConfig, saveConfig } from '../config.js'
import { CliError } from '../errors.js'
import { resolveTokenCachePath } from '../lib/token-cache.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CALLBACK_PORT = 20265
const CALLBACK_TIMEOUT_SECONDS = 300
const SSO_URL_ENV_VAR = 'A2WAVE_SSO_URL'

// ---------------------------------------------------------------------------
// SSO entry URL resolution (config-driven; no IdP is hardcoded)
// ---------------------------------------------------------------------------

/**
 * SSO entry URL for the CLI's own browser flow.
 *
 * This flow needs an IdP entry that redirects back to the CLI's loopback listener, which is not
 * the platform's own OIDC login (that one redirects to the server's callback and ends in a browser
 * session, not a token this process can read). So it is resolved purely from `A2WAVE_SSO_URL`.
 *
 * Without it, `--device` is the path to reach for first: the device grant needs nothing
 * configured up front and works against any server new enough to expose
 * `/api/auth/device/code`. `--idaas-token` stays listed below it because it is still the
 * only option when the server predates device login (that endpoint 404s).
 */
export async function resolveSsoEntryUrl(): Promise<string> {
  const fromEnv = process.env[SSO_URL_ENV_VAR]?.trim()
  if (fromEnv) return fromEnv

  throw new CliError(
    [
      `No SSO login entry configured ($${SSO_URL_ENV_VAR} is not set).`,
      '  1. Approve a code from a browser on any machine (nothing to configure): a2wave login --device',
      `  2. Or export ${SSO_URL_ENV_VAR}=<IdP SSO URL> (the IdP entry that redirects back to the CLI; may include query params)`,
      '  3. Or pass an IdP-issued id_token directly: a2wave login --idaas-token <JWT>',
      '  4. Or use username/password: a2wave login --password',
    ].join('\n'),
  )
}

/**
 * Append callback params to the configured SSO entry URL. Only redirect_uri /
 * state / nonce are added; any query already on ssoUrl (e.g. tenant/enterprise
 * id like enterpriseId) is kept as-is — such params are configured directly in
 * the URL by the deployer, and the CLI makes no IdP-specific assumptions.
 */
export function buildSsoRedirectUrl(
  ssoEntryUrl: string,
  callbackUrl: string,
  nonce: string,
): string {
  let url: URL
  try {
    url = new URL(ssoEntryUrl)
  } catch {
    throw new CliError(`Invalid SSO entry URL: ${ssoEntryUrl}`)
  }
  // The result of this is handed to the system browser opener, so the scheme is
  // part of the contract: only a web page may be opened.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(`SSO entry URL must be http(s): ${ssoEntryUrl}`)
  }
  url.searchParams.set('redirect_uri', callbackUrl)
  url.searchParams.set('state', nonce)
  url.searchParams.set('nonce', nonce)
  return url.toString()
}

// ---------------------------------------------------------------------------
// Cached SSO token
// ---------------------------------------------------------------------------

interface CachedIdaasToken {
  version?: string
  access_token?: string
  token_type?: string
  expires_in?: number
  expires_at?: string // ISO UTC
  gateway_url?: string
}

function readSharedCache(path: string): string | null {
  if (!existsSync(path)) return null
  let raw: CachedIdaasToken
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8')) as CachedIdaasToken
  } catch {
    return null
  }
  const token = raw.access_token
  if (!token) return null
  // Treat tokens within 60s of expiry as already expired — gives the SSO flow
  // headroom to complete before downstream calls reject.
  if (raw.expires_at) {
    const exp = new Date(raw.expires_at)
    if (Number.isNaN(exp.getTime()) || exp.getTime() <= Date.now() + 60_000) return null
  }
  return token
}

function writeSharedCache(path: string, token: string, gatewayBaseUrl: string): void {
  const expiresAt = getJwtExpiry(token)
  const expiresIn = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000))
  const payload: CachedIdaasToken = {
    version: 'v1',
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    expires_at: expiresAt.toISOString(),
    gateway_url: gatewayBaseUrl,
  }
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 })
  chmodSync(path, 0o600)
}

function getJwtExpiry(token: string): Date {
  const parts = token.split('.')
  if (parts.length < 2) throw new CliError('Invalid SSO token format (not a valid JWT)')
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
  } catch {
    throw new CliError('Failed to parse SSO token')
  }
  const exp = claims.exp
  if (typeof exp !== 'number') throw new CliError('SSO token is missing the exp claim')
  return new Date(exp * 1000)
}

// ---------------------------------------------------------------------------
// Browser opener
// ---------------------------------------------------------------------------

/** Only a web page may be handed to the OS opener. */
function isOpenableWebUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function openBrowser(targetUrl: string): boolean {
  // The URL can come from a server response (the device grant's
  // verificationUriComplete), so its scheme is not ours to trust: `javascript:`,
  // `file:` and `data:` all mean something very different to the system opener
  // than "show the user a page".
  if (!isOpenableWebUrl(targetUrl)) {
    console.warn(`Refusing to open a non-http(s) URL: ${targetUrl}`)
    return false
  }

  const platform = process.platform
  let cmd: string
  let args: string[]
  if (platform === 'darwin') {
    cmd = 'open'
    args = [targetUrl]
  } else if (platform === 'win32') {
    // NOT `cmd /c start`: libuv quotes an argument only when it contains a space,
    // tab or quote, so `&`, `|` and `^` in the URL would reach cmd.exe's parser as
    // operators and run as commands. rundll32 takes the URL as a plain argument.
    cmd = 'rundll32'
    args = ['url.dll,FileProtocolHandler', targetUrl]
  } else {
    cmd = 'xdg-open'
    args = [targetUrl]
  }
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Callback HTML pages (rendered in user's browser)
// ---------------------------------------------------------------------------

const CALLBACK_STYLE =
  '<style>' +
  '*{margin:0;padding:0;box-sizing:border-box}' +
  "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
  'display:flex;align-items:center;justify-content:center;min-height:100vh;' +
  'background:#f7f8fa;color:#3c4043}' +
  '.card{background:#fff;border-radius:12px;padding:40px 48px;max-width:420px;width:90%;' +
  'box-shadow:0 1px 3px rgba(0,0,0,.08),0 4px 12px rgba(0,0,0,.04);text-align:center}' +
  '.icon{font-size:36px;margin-bottom:16px}' +
  'h1{font-size:18px;font-weight:600;color:#1a1a1a;margin-bottom:8px}' +
  'p{font-size:13px;line-height:1.6;color:#5f6368;margin-top:6px}' +
  '@keyframes spin{to{transform:rotate(360deg)}}' +
  '.spinner{width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:#6b7280;' +
  'border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}' +
  '</style>'

/**
 * Some IdPs return the JWT in the URL fragment (#id_token=...). The fragment
 * never reaches the server, so we render a tiny page that reads the fragment
 * with JS and POSTs the token to /callback/token.
 */
function renderFragmentExtractor(callbackPath: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signing in…</title>${CALLBACK_STYLE}</head>
<body><div class="card">
<div class="spinner"></div>
<h1>Processing a2wave login</h1>
<p>Please wait…</p>
</div>
<script>
(function(){
  var p = new URLSearchParams(window.location.hash.substring(1));
  var token = p.get('id_token') || p.get('access_token');
  var q = new URLSearchParams(window.location.search.substring(1));
  var state = q.get('state') || p.get('state') || '';
  if (!token) {
    document.querySelector('h1').textContent = 'Authorization failed';
    document.querySelector('p').textContent = 'No token found in the callback. Close this page and try again.';
    document.querySelector('.spinner').style.display = 'none';
    return;
  }
  fetch(${JSON.stringify(`${callbackPath}/token`)}, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id_token: token, state: state}) })
    .then(function(r){ return r.json(); })
    .then(function(){ window.location.replace('/callback/done'); })
    .catch(function(){ document.querySelector('p').textContent = 'Failed to send the token back. Close this page and try again.'; });
})();
</script></body></html>`
}

function renderDonePage(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>a2wave login successful</title>${CALLBACK_STYLE}</head>
<body><div class="card">
<div class="icon">✓</div>
<h1>a2wave login successful</h1>
<p>Token acquired. You can close this page and return to the terminal.</p>
<p style="margin-top:16px;color:#888;font-size:12px;">This page will close automatically in <span id="sec">5</span> seconds…</p>
</div>
<script>
var n=5,el=document.getElementById('sec');
var t=setInterval(function(){n--;el.textContent=n;if(n<=0){clearInterval(t);try{window.close();}catch(e){}}},1000);
</script></body></html>`
}

// ---------------------------------------------------------------------------
// Loopback callback server
// ---------------------------------------------------------------------------

function ensurePortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', () => {
      reject(
        new CliError(
          `Local port ${port} is already in use; cannot start the OAuth callback listener.\n  Free the port first (e.g. lsof -ti:${port} | xargs kill) and try again.`,
        ),
      )
    })
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
  })
}

interface CallbackResult {
  idToken: string | null
  error: string | null
}

export function waitForCallback(
  port: number,
  timeoutSeconds: number,
  callbackNonce: string,
): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const result: CallbackResult = { idToken: null, error: null }
    const callbackPath = '/callback'
    const callbackTokenPath = `${callbackPath}/token`

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`)

      if (req.method === 'GET' && url.pathname === callbackPath) {
        // The IdP may put the token in the query (?id_token=...) or the fragment (#id_token=...)
        // Check the query first; if it has no token, render the JS extractor to read the fragment.
        const state = url.searchParams.get('state')
        if (state !== callbackNonce) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Invalid OAuth state')
          return
        }
        result.error = url.searchParams.get('error')
        const queryToken = url.searchParams.get('id_token') ?? url.searchParams.get('access_token')
        if (queryToken) {
          result.idToken = queryToken
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderDonePage())
          finish()
          return
        }
        // No query token and no error → render fragment extractor
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderFragmentExtractor(callbackPath))
        if (result.error) finish()
        return
      }

      if (req.method === 'POST' && url.pathname === callbackTokenPath) {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += chunk
        })
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as { id_token?: string; state?: string }
            if (data.state !== callbackNonce) {
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'invalid state' }))
              return
            }
            result.idToken = data.id_token ?? null
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          finish()
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/callback/done') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderDonePage())
        return
      }

      res.writeHead(404)
      res.end('Not Found')
    })

    let timer: ReturnType<typeof setTimeout> | null = null
    let finished = false

    function finish(): void {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      server.close()
      resolve(result)
    }

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      reject(new CliError(`Failed to start the local callback listener: ${err.message}`))
    })

    timer = setTimeout(() => {
      if (finished) return
      finished = true
      server.close()
      reject(
        new CliError(
          `Timed out waiting for authorization (${timeoutSeconds}s). Complete the SSO login in the browser and try again.`,
        ),
      )
    }, timeoutSeconds * 1000)

    server.listen(port, '127.0.0.1')
  })
}

function createCallbackNonce(): string {
  return randomBytes(32).toString('base64url')
}

// ---------------------------------------------------------------------------
// SSO token acquisition (cache → browser SSO)
// ---------------------------------------------------------------------------

interface AcquireOptions {
  cachePath?: string
  /** Skip the browser flow entirely; only use the cache. Used by --no-browser. */
  cacheOnly?: boolean
}

async function acquireIdaasToken(
  opts: AcquireOptions = {},
): Promise<{ token: string; source: 'cache' | 'sso' }> {
  const cachePath = opts.cachePath ?? resolveTokenCachePath()

  // 1. Prefer reusing the cached token (under the legacy path the login state is shared with other tools using the same file)
  const cached = readSharedCache(cachePath)
  if (cached) {
    console.log(`Reusing cached SSO token: ${cachePath}`)
    return { token: cached, source: 'cache' }
  }

  if (opts.cacheOnly) {
    throw new CliError(
      `No valid SSO token found (cache: ${cachePath}). Remove --no-browser to run the browser SSO flow, or pass a JWT manually with --idaas-token.`,
    )
  }

  // 2. Cache miss → resolve the SSO entry, check the port, start the local listener, launch the browser SSO
  console.log(`No valid SSO cache found (${cachePath}); starting browser SSO…`)
  const ssoEntryUrl = await resolveSsoEntryUrl()
  await ensurePortAvailable(CALLBACK_PORT)
  console.log(`Waiting for the SSO callback at http://localhost:${CALLBACK_PORT}/callback`)

  const callbackNonce = createCallbackNonce()
  const callbackUrl = `http://localhost:${CALLBACK_PORT}/callback`
  const ssoUrlStr = buildSsoRedirectUrl(ssoEntryUrl, callbackUrl, callbackNonce)
  const opened = openBrowser(ssoUrlStr)
  if (opened) {
    console.log('Opened the browser for SSO login…')
  } else {
    console.log('Open the following URL in your browser to complete login:')
    console.log(ssoUrlStr)
  }

  const callback = await waitForCallback(CALLBACK_PORT, CALLBACK_TIMEOUT_SECONDS, callbackNonce)
  if (callback.error) {
    throw new CliError(`SSO authorization was denied: ${callback.error}`)
  }
  if (!callback.idToken) {
    throw new CliError('No SSO token received in the callback. Please try again.')
  }

  // 3. Write the new token back to the cache (under the legacy path other tools sharing the file can reuse it)
  try {
    writeSharedCache(cachePath, callback.idToken, '')
    console.log(`Saved SSO token cache: ${cachePath}`)
  } catch (err) {
    console.warn(
      `Warning: failed to write SSO token cache (${cachePath}): ${(err as Error).message}`,
    )
  }

  return { token: callback.idToken, source: 'sso' }
}

// ---------------------------------------------------------------------------
// Server-side exchange
// ---------------------------------------------------------------------------

export interface OauthLoginParams {
  /** Pre-acquired IdP JWT (skips cache + SSO; used by --idaas-token). */
  idaasToken?: string
  /** Skip browser flow even when cache misses. */
  cacheOnly?: boolean
  /** Override cache path; tests inject this. */
  cachePath?: string
}

/**
 * a2wave login flow = pure SSO (OAuth); the token is written to two places:
 *   1. SSO token cache — path per resolveTokenCachePath (env > ~/.a2wave/oauth.json)
 *   2. ~/.a2wave/config.json (token field) — so a2wave's own commands have a token
 *
 * config.url is not touched (existing value is preserved). The url comes from
 * `a2wave config set-url` or each command's --url / $A2WAVE_URL.
 */
export async function oauthLogin(params: OauthLoginParams = {}): Promise<void> {
  const { idaasToken, cacheOnly, cachePath } = params
  const finalCachePath = cachePath ?? resolveTokenCachePath()

  let jwt: string
  let source: 'manual' | 'cache' | 'sso'
  if (idaasToken) {
    jwt = idaasToken
    source = 'manual'
    try {
      writeSharedCache(finalCachePath, idaasToken, '')
    } catch (err) {
      console.warn(`Warning: failed to write shared cache: ${(err as Error).message}`)
    }
  } else {
    const acquired = await acquireIdaasToken({ cacheOnly, cachePath: finalCachePath })
    jwt = acquired.token
    source = acquired.source
  }

  // Only update the token; keep the existing url unchanged
  const existing = loadConfig() ?? { token: '' }
  saveConfig({ ...existing, token: jwt })

  // Parse the email for a friendly message
  let who = '<unknown>'
  try {
    const claims = JSON.parse(
      Buffer.from(jwt.split('.')[1], 'base64url').toString('utf-8'),
    ) as Record<string, unknown>
    const email = typeof claims.email === 'string' ? claims.email : undefined
    const sub = typeof claims.sub === 'string' ? claims.sub : undefined
    who = email ?? sub ?? '<unknown>'
  } catch {
    /* JWT parse failure does not affect the login-success verdict */
  }
  console.log(`Login successful ✓ (${who} · source: ${source})`)
  console.log(`SSO cache: ${finalCachePath}`)
  if (existing.url) {
    console.log(`a2wave config: ~/.a2wave/config.json (url=${existing.url})`)
  } else {
    console.log('a2wave config: ~/.a2wave/config.json (url not set)')
    console.log(
      'Next: a2wave config set-url http://localhost:3502  (or pass --url on each command)',
    )
  }
}

// Test-only: read the token cache directly.
export function readTokenCache(path: string = resolveTokenCachePath()): string | null {
  return readSharedCache(path)
}
