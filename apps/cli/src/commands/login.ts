import { createInterface } from 'node:readline/promises'
import { defineCommand } from 'citty'
import { clearConfig, loadConfig, resolveUrl, saveConfig, saveCredential } from '../config.js'
import { CliError } from '../errors.js'
import { readSecret } from '../lib/prompt.js'
import { oauthLogin } from './oauth.js'

export const loginCommand = defineCommand({
  meta: {
    name: 'login',
    agentMeta: { risk: 'write' },
    description:
      'Log in to a2wave. Defaults to SSO (OAuth) browser login with no arguments needed; the token is written to the SSO token cache + ~/.a2wave/config.json.',
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
    password: {
      type: 'boolean',
      description: 'Legacy username + password login (requires a2wave config set-url to be set)',
    },
  },
  run: async (ctx) => {
    const args = (ctx?.args ?? {}) as {
      'idaas-token'?: string
      browser?: boolean
      password?: boolean
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
