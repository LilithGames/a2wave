import { createInterface } from 'node:readline/promises'
import { defineCommand } from 'citty'
import { clearConfig, loadConfig, resolveUrl, saveConfig, saveCredential } from '../config.js'
import { CliError } from '../errors.js'
import { readSecret } from '../lib/prompt.js'
import { deviceLogin } from './device-login.js'
import { oauthLogin } from './oauth.js'

/**
 * Whether this shell is attached to a machine the user is not sitting at.
 *
 * The loopback SSO flow binds a listener here and asks an IdP to redirect a
 * browser to it; over SSH that browser is on the *other* machine, so the callback
 * can never arrive and the login hangs until it times out. The device grant is
 * the flow that works, so it becomes the default rather than something the user
 * has to know to ask for.
 *
 * Only SSH is detected. A container or CI job has no reliable marker, and guessing
 * wrong would push a local user onto a two-step flow for no reason — they can pass
 * --device.
 */
function isRemoteShell(): boolean {
  return !!(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT)
}

/**
 * Adopt a token minted in the web UI.
 *
 * Verified against /auth/me before being written: a mistyped or already-revoked
 * token would otherwise be saved silently and fail on some later command, far
 * from the point where it could be understood.
 */
async function cliTokenLogin(url: string, token: string): Promise<void> {
  const baseUrl = url.replace(/\/+$/, '')
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'a2wave-cli' },
    })
  } catch (err) {
    throw new CliError(`Could not reach ${baseUrl}: ${(err as Error).message}`)
  }
  if (!res.ok) {
    throw new CliError(
      `The token was rejected (${res.status}). Check that it was copied in full and has not been revoked.`,
    )
  }

  let username: string | undefined
  try {
    username = ((await res.json()) as { data?: { username?: string } }).data?.username
  } catch {
    // A non-JSON body does not invalidate the token; the 200 already proved it.
  }

  const existing = loadConfig() ?? { token: '' }
  saveConfig({ ...existing, url: baseUrl, token })
  saveCredential(baseUrl, token)
  console.log(`Login successful ✓${username ? ` (${username})` : ''}`)
}

export const loginCommand = defineCommand({
  meta: {
    name: 'login',
    agentMeta: { risk: 'write' },
    description:
      'Log in to a2wave. Defaults to SSO (OAuth) browser login with no arguments needed; over SSH it switches to device login (approve a code from another machine). The token is written to the SSO token cache + ~/.a2wave/config.json.',
  },
  args: {
    'idaas-token': {
      type: 'string',
      description: 'Manually pass an IdP-issued JWT once (skips browser SSO; for CI / headless)',
    },
    // Declared as `browser` (default true), NOT `no-browser`: citty parses a
    // `--no-X` flag as negation of `X`, so `--no-browser` sets `args.browser =
    // false` and never populates `args['no-browser']`. Declaring it the other
    // way round makes the flag silently do nothing.
    browser: {
      type: 'boolean',
      default: true,
      description: 'Launch a browser for SSO. Use --no-browser to only reuse the existing cache',
    },
    token: {
      type: 'string',
      description:
        'Use a CLI token created in the web UI (Settings → CLI access). Non-interactive; ideal for CI',
    },
    device: {
      type: 'boolean',
      description:
        'Device login: show a code to approve in a browser on another machine. Default over SSH',
    },
    password: {
      type: 'boolean',
      description: 'Legacy username + password login (requires a2wave config set-url to be set)',
    },
  },
  run: async (ctx) => {
    const args = (ctx?.args ?? {}) as {
      'idaas-token'?: string
      token?: string
      browser?: boolean
      device?: boolean
      password?: boolean
    }

    // A CLI token is already a credential — nothing to negotiate, so this wins over
    // every interactive path including the SSH device-grant default.
    if (args.token) {
      await cliTokenLogin(resolveUrl(), args.token)
      return
    }

    // Device grant: explicitly asked for, or the only flow that can work here.
    // --idaas-token and --no-browser are both explicit non-interactive choices, so
    // they keep precedence over the SSH default; otherwise a CI job that happens to
    // run over SSH would start waiting for a human to approve a code.
    const wantsDevice =
      args.device ||
      (isRemoteShell() && !args.password && !args['idaas-token'] && args.browser !== false)
    if (wantsDevice) {
      // Unlike the IdP flow, this one talks to the a2wave instance itself, so it
      // needs a URL up front.
      await deviceLogin({ url: resolveUrl(), openBrowser: !isRemoteShell() })
      return
    }

    // Default: pure IDaaS OAuth; does not touch any a2wave URL
    if (!args.password) {
      await oauthLogin({
        idaasToken: args['idaas-token'],
        cacheOnly: args.browser === false,
      })
      return
    }

    // --password fallback path: username + password; URL comes from global resolution (config / env / error)
    const url = resolveUrl() // Throws a three-option hint when no URL is set

    // Checked before prompting for the username, so a piped invocation fails on
    // the first line rather than after asking a question it cannot follow up.
    if (!process.stdin.isTTY) {
      throw new CliError(
        [
          'Not a terminal: the password prompt would be echoed in the clear.',
          'For CI / headless use SSO instead: a2wave login --idaas-token <jwt>',
        ].join('\n'),
      )
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const username = await rl.question('Username: ')
    rl.close()
    const password = await readSecret('Password: ')

    if (url.startsWith('http://')) {
      console.warn('Warning: using an HTTP connection; the password will be sent in plain text')
    }

    const res = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new CliError(`Login failed (${res.status}): ${body}`)
    }

    let parsed: { data: { token: string } }
    try {
      parsed = (await res.json()) as { data: { token: string } }
    } catch {
      throw new CliError('Login failed: server returned a non-JSON response')
    }

    // Two writes, deliberately. The legacy top-level pair still moves to this
    // instance, so a single-instance user sees no change. But the credential is
    // ALSO filed under its own URL, so logging into a second deployment no
    // longer costs you the first one's token — which is what made `--url`
    // silently send the wrong credential.
    const existing = loadConfig() ?? { token: '' }
    saveConfig({ ...existing, url, token: parsed.data.token })
    saveCredential(url, parsed.data.token)
    console.log('Login successful ✓')
  },
})

export const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    agentMeta: { risk: 'write' },
    description:
      'Log out: best-effort revoke of the server token, then clear ~/.a2wave/config.json.',
  },
  run: async () => {
    const existing = loadConfig()
    if (existing?.url && existing.token) {
      try {
        await fetch(`${existing.url.replace(/\/+$/, '')}/api/auth/logout`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${existing.token}`,
            'User-Agent': 'a2wave-cli',
          },
        })
      } catch {
        // Local logout must not be blocked by network errors; the server token expires naturally within 24h at most.
      }
    }
    clearConfig()
    console.log('Logged out')
  },
})
