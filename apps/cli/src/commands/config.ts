import { defineCommand } from 'citty'
import { loadConfig, saveConfig } from '../config.js'
import { CliError } from '../errors.js'

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
      meta: { name: 'get', description: 'Show current ~/.a2wave/config.json (token auto-masked)' },
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
  },
})
