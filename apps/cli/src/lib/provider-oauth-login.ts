import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CliError } from '../errors.js'

interface LoginOptions {
  server: string
  loginId: string
  loginToken: string
  openBrowser: (url: string) => boolean
  onReady?: (localUrl: string) => void
  timeoutMs?: number
  signal?: AbortSignal
}

interface ConnectedAccount {
  accountId: string
}

function serverOrigin(value: string): string {
  const url = new URL(value)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new CliError(
      'The a2wave server must be an HTTP(S) URL without credentials or query parameters.',
    )
  }
  return url
    .toString()
    .replace(/\/$/, '')
    .replace(/\/api$/, '')
}

/** Keep credentials in process memory; only a short-lived authorization code crosses loopback. */
export async function connectProviderOauth(options: LoginOptions): Promise<ConnectedAccount> {
  const base = serverOrigin(options.server)
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const endpoint = `${base}/api/provider-oauth-logins/${encodeURIComponent(options.loginId)}`
  const request = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${endpoint}/${path}`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.loginToken}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new CliError(
        `ChatGPT account connection failed (HTTP ${response.status}). Start a new login from a2wave.`,
        {
          type: response.status === 401 || response.status === 403 ? 'auth' : 'server',
          subtype: 'provider_oauth_login_failed',
        },
      )
    }
    const payload = (await response.json()) as { data: T }
    return payload.data
  }

  let authorizeUrl: URL | undefined
  let state: string | undefined
  let completing = false
  let settled = false
  let resolveLogin!: (value: ConnectedAccount) => void
  let rejectLogin!: (reason: unknown) => void
  const completed = new Promise<ConnectedAccount>((resolve, reject) => {
    resolveLogin = resolve
    rejectLogin = reject
  })
  // A timeout can fire while /start is still awaiting a network response.
  void completed.catch(() => {})
  const fail = (error: unknown) => {
    if (settled) return
    settled = true
    rejectLogin(error)
  }
  const aborted = () =>
    fail(
      new CliError(
        options.signal?.aborted
          ? 'ChatGPT account connection cancelled.'
          : 'ChatGPT account connection timed out. Start a new login from a2wave.',
        { type: 'auth', subtype: 'provider_oauth_login_interrupted' },
      ),
    )
  signal.addEventListener('abort', aborted, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    if (url.pathname === '/auth/start' && authorizeUrl && !settled) {
      res.writeHead(302, { Location: authorizeUrl.toString() }).end()
      return
    }
    if (url.pathname !== '/auth/callback') {
      res.writeHead(404).end()
      return
    }
    if (!state || url.searchParams.get('state') !== state || completing || settled) {
      res.writeHead(400).end('This login callback is invalid or has already been used.')
      return
    }
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (!code && !error) {
      res.writeHead(400).end('Missing authorization result.')
      return
    }
    completing = true
    try {
      const account = await request<ConnectedAccount>('complete', {
        state,
        ...(error ? { error } : { code }),
        ...(url.searchParams.get('client_id')
          ? { clientId: url.searchParams.get('client_id') }
          : {}),
      })
      if (error || !account?.accountId)
        throw new CliError('ChatGPT authorization was not completed.')
      res
        .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('ChatGPT account connected. You can close this tab and return to a2wave.')
      settled = true
      resolveLogin(account)
    } catch (error) {
      res
        .writeHead(400)
        .end('ChatGPT account connection failed. Return to a2wave and start a new login.')
      fail(error)
    }
  })
  try {
    if (signal.aborted) {
      aborted()
      return await completed
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`
    const start = await request<{ authorizationUrl: string }>('start', { redirectUri })
    authorizeUrl = new URL(start.authorizationUrl)
    state = authorizeUrl.searchParams.get('state') ?? undefined
    if (
      authorizeUrl.origin !== 'https://auth.openai.com' ||
      authorizeUrl.pathname !== '/api/accounts/authorize' ||
      authorizeUrl.searchParams.get('redirect_uri') !== redirectUri ||
      !state
    ) {
      throw new CliError('The server returned an invalid ChatGPT authorization URL.')
    }
    // Only print/open the local entry point; keep transient authorization parameters out of terminal output.
    const localUrl = `http://127.0.0.1:${port}/auth/start`
    options.onReady?.(localUrl)
    options.openBrowser(localUrl)
    return await completed
  } catch (error) {
    if (signal.aborted) return await completed
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', aborted)
    controller.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
