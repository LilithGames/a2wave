import { defineCommand } from 'citty'
import { loadConfig, resolveProfileUrl, saveConfig, saveProfile } from '../config.js'
import { CliError } from '../errors.js'
import { emit, jsonArg } from '../lib/output.js'

/** Mask a token for display: keep last 4 chars only. */
function maskToken(token: string | undefined): string {
  if (!token) return '<unset>'
  if (token.length <= 4) return '****'
  return `***${token.slice(-4)}`
}

export const configCommand = defineCommand({
  meta: {
    name: 'config',
    description: 'View and set a2wave CLI global config (~/.a2wave/config.json)',
  },
  subCommands: {
    'set-url': defineCommand({
      meta: {
        name: 'set-url',
        agentMeta: { risk: 'write' },
        description:
          "Set the global default a2wave instance URL (overridden by each command's --url / $A2WAVE_URL)",
      },
      args: {
        url: {
          type: 'positional',
          description: 'a2wave URL, e.g. http://localhost:3502',
          required: true,
        },
      },
      run: ({ args }) => {
        const url = (args.url as string).trim().replace(/\/+$/, '')
        if (!url) throw new CliError('URL must not be empty')
        if (!/^https?:\/\//.test(url)) {
          throw new CliError(`URL must start with http:// or https://, got: ${args.url}`)
        }
        const existing = loadConfig() ?? { token: '' }
        saveConfig({ ...existing, url })
        console.log(`a2wave URL set: ${url}`)
      },
    }),

    get: defineCommand({
      meta: {
        name: 'get',
        description: 'Show current ~/.a2wave/config.json (token auto-masked)',
        agentMeta: { risk: 'read' },
      },
      run: () => {
        const config = loadConfig()
        if (!config) {
          console.log('(not configured; run a2wave login to initialize)')
          return
        }
        console.log(`url:   ${config.url ?? '<unset>'}`)
        console.log(`token: ${maskToken(config.token)}`)
      },
    }),

    'unset-url': defineCommand({
      meta: {
        name: 'unset-url',
        agentMeta: { risk: 'write' },
        description:
          'Clear the global default URL (keeps token; use --url or $A2WAVE_URL when needed)',
      },
      run: () => {
        const config = loadConfig()
        if (!config) {
          console.log('(no config to clear)')
          return
        }
        const { url: _, ...rest } = config
        saveConfig({ ...rest, token: rest.token ?? '' })
        console.log('a2wave URL cleared')
      },
    }),

    // Profiles are named aliases over the URL-keyed credential store, not a
    // second mechanism. An agent almost never wants "a profile" — it wants
    // "this URL with the right token", which `--url` already gives it. These
    // exist for a human switching between deployments.
    'add-profile': defineCommand({
      meta: {
        name: 'add-profile',
        description: 'Name an instance URL so it can be switched to',
        agentMeta: { risk: 'write' },
      },
      args: {
        name: { type: 'positional', description: 'Profile name, e.g. staging', required: true },
        url: { type: 'positional', description: 'a2wave URL for this profile', required: true },
      },
      run: ({ args }) => {
        const url = (args.url as string).trim().replace(/\/+$/, '')
        // Same validation as set-url: a profile pointing at a scheme-less string
        // fails later, at the first request, where the cause is far less obvious.
        if (!/^https?:\/\//.test(url)) {
          throw new CliError(`URL must start with http:// or https://, got: ${args.url}`, {
            type: 'validation',
            subtype: 'invalid_url',
          })
        }
        saveProfile(args.name as string, url)
        console.log(`Profile saved: ${args.name} → ${url}`)
      },
    }),

    use: defineCommand({
      meta: {
        name: 'use',
        description: 'Switch the default instance URL to a named profile',
        agentMeta: { risk: 'write' },
      },
      args: {
        name: { type: 'positional', description: 'Profile name', required: true },
      },
      run: ({ args }) => {
        const name = args.name as string
        const url = resolveProfileUrl(name)
        const existing = loadConfig() ?? { token: '' }
        saveConfig({ ...existing, url, currentProfile: name })
        console.log(`Using profile ${name} (${url})`)
      },
    }),

    list: defineCommand({
      meta: {
        name: 'list',
        description: 'List the configured profiles',
        agentMeta: { risk: 'read' },
      },
      args: { ...jsonArg },
      run: ({ args }) => {
        const config = loadConfig()
        const profiles = config?.profiles ?? {}
        if (emit(args, { current: config?.currentProfile, profiles })) return

        const names = Object.keys(profiles)
        if (names.length === 0) {
          console.log('No profiles configured. Add one: a2wave config add-profile <name> <url>')
          return
        }
        for (const name of names) {
          const marker = name === config?.currentProfile ? '*' : ' '
          console.log(`${marker} ${name}  ${profiles[name].url}`)
        }
      },
    }),
  },
})
