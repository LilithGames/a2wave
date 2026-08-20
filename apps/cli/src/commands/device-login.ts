/**
 * Device authorization grant (RFC 8628) for `a2wave login` on a machine that has
 * no browser — SSH, a container, CI.
 *
 * The terminal prints a short code and a URL; the user opens that URL on any
 * machine where they already have an a2wave session, types the code, and this
 * loop picks up the resulting token. Nothing is typed back into the terminal, so
 * the token never passes through a shell history or a scrollback buffer.
 */
import { loadConfig, saveConfig, saveCredential } from '../config.js'
import { CliError } from '../errors.js'
import { openBrowser } from './oauth.js'

interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export interface DeviceLoginParams {
  /** a2wave instance to log into. Already resolved by the caller. */
  url: string
  /** Try to open the verification page locally. False on a headless box. */
  openBrowser?: boolean
  /** Injected by tests so the poll loop does not actually wait. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Each `slow_down` adds this much to the interval, per RFC 8628 §3.5. */
const SLOW_DOWN_INCREMENT_SECONDS = 5

async function requestDeviceCode(baseUrl: string): Promise<DeviceCodeResponse> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'User-Agent': 'a2wave-cli' },
    })
  } catch (err) {
    throw new CliError(`Could not reach ${baseUrl}: ${(err as Error).message}`)
  }

  if (res.status === 404) {
    throw new CliError(
      [
        `${baseUrl} does not support device login (404).`,
        '  The server is likely older than this CLI. Upgrade it, or log in with:',
        '    a2wave login --idaas-token <jwt>',
      ].join('\n'),
    )
  }
  if (!res.ok) {
    throw new CliError(`Failed to start device login (${res.status}): ${await res.text()}`)
  }
  const parsed = (await res.json()) as { data: DeviceCodeResponse }
  return parsed.data
}

/**
 * Poll outcome, mapped to what the user should do about it. The RFC's own codes
 * are protocol detail; a person waiting at a prompt needs a sentence.
 */
function describePollFailure(error: string | null, status: number): string {
  switch (error) {
    case 'access_denied':
      return 'Login was denied in the browser.'
    case 'expired_token':
      return 'The login request expired or was already used. Run `a2wave login` again.'
    default:
      // Anything else is a server-side fault rather than a grant outcome; report the
      // status, which is actionable, instead of stringifying an unknown payload.
      return `Login failed (HTTP ${status})${error ? `: ${error}` : ''}.`
  }
}

/**
 * Run the device grant end to end. Resolves once the token is on disk; throws a
 * CliError describing what the user should do otherwise.
 */
export async function deviceLogin(params: DeviceLoginParams): Promise<void> {
  const baseUrl = params.url.replace(/\/+$/, '')
  const sleep = params.sleep ?? defaultSleep
  const device = await requestDeviceCode(baseUrl)

  console.log('')
  console.log(`  Open this page:  ${device.verificationUri}`)
  console.log(`  Enter this code: ${device.userCode}`)
  console.log('')
  if (params.openBrowser !== false && openBrowser(device.verificationUriComplete)) {
    console.log('  Opened the page in your browser.')
  } else {
    console.log(`  Or open it directly: ${device.verificationUriComplete}`)
  }
  console.log('  Waiting for approval… (Ctrl-C to cancel)')

  // The server's own deadline, so a code that has died on the server does not
  // keep this loop alive on the client.
  const deadline = Date.now() + device.expiresIn * 1000
  let intervalSeconds = device.interval

  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000)

    let res: Response
    try {
      res = await fetch(`${baseUrl}/api/auth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'a2wave-cli' },
        body: JSON.stringify({ deviceCode: device.deviceCode }),
      })
    } catch (err) {
      // A transient network blip must not abandon a login the user is midway
      // through approving; keep polling until the deadline decides.
      console.log(`  (network error, retrying: ${(err as Error).message})`)
      continue
    }

    if (res.ok) {
      const { data } = (await res.json()) as {
        data: { token: string; user?: { username?: string } }
      }
      const existing = loadConfig() ?? { token: '' }
      // Two writes for the same reason as the password path: the top-level pair
      // moves to this instance, and the credential is also filed under its URL so
      // logging into a second deployment does not cost the first one's token.
      saveConfig({ ...existing, url: baseUrl, token: data.token })
      saveCredential(baseUrl, data.token)
      console.log(`Login successful ✓${data.user?.username ? ` (${data.user.username})` : ''}`)
      return
    }

    // Rate limiting is not a poll outcome: the grant is still live and the user may
    // already be approving it. Backing off is the only correct response — aborting
    // would kill a login that was about to succeed.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After'))
      intervalSeconds =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS
      console.log(`  (rate limited, retrying in ${intervalSeconds}s)`)
      continue
    }

    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    // The middleware's error is an object ({ code, message }); the device endpoints'
    // is a bare RFC 8628 string. Only a string can be a poll outcome, and coercing
    // the object would render it as "[object Object]" in the user's terminal.
    const error = typeof body?.error === 'string' ? body.error : null
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS
      continue
    }
    throw new CliError(describePollFailure(error, res.status))
  }

  throw new CliError('Login request expired before it was approved. Run `a2wave login` again.')
}
