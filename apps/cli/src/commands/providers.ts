import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { emit, jsonArg } from '../lib/output.js'
import { pageArgs, pageQuery } from '../lib/paginate.js'

interface Provider {
  id: string
  name: string
  description?: string | null
  isPreset: boolean
  kind: string
  checkScript?: string | null
  createdAt: string
  updatedAt: string
}

interface LoginStatus {
  installed: boolean
  loggedIn: boolean
  detail?: string
  method?: string
  error?: string
  version?: string
  minVersion?: string
  versionOk?: boolean
}

const ENGINE_TYPES = [
  'cursor',
  'claude-code',
  'codex',
  'opencode',
  'qoder',
  'trae',
  'kimi',
  'pi',
] as const

export const providersCommand = defineCommand({
  meta: { name: 'providers', description: 'Manage Providers (execution engines)' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List all Providers', agentMeta: { risk: 'read' } },
      args: { ...jsonArg, ...pageArgs, ...urlArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const result = await client.get<{ data: Provider[] }>(
          `/api/providers?${pageQuery(args, 100)}`,
        )
        if (emit(args, result)) return
        if (result.data.length === 0) {
          console.log('No providers found')
          return
        }
        for (const p of result.data) {
          console.log(`${p.id}  ${p.name}  (${p.kind})`)
        }
      },
    }),

    get: defineCommand({
      meta: {
        name: 'get',
        description: 'View Provider details (accepts ID or name)',
        agentMeta: { risk: 'read' },
      },
      args: {
        id: { type: 'positional', description: 'Provider ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveProviderId(args.id as string)
        const res = await client.get<{ data: Provider }>(`/api/providers/${id}`)
        if (emit(args, res)) return
        const p = res.data
        console.log(`ID:            ${p.id}`)
        console.log(`Name:          ${p.name}`)
        console.log(`Preset:        ${p.isPreset}`)
        console.log(`Kind:          ${p.kind}`)
        if (p.checkScript) console.log(`CheckScript:   ${p.checkScript}`)
      },
    }),

    'login-status': defineCommand({
      meta: {
        name: 'login-status',
        agentMeta: { risk: 'read' },
        description: 'Check local CLI login state (for the "use server login state" mode)',
      },
      args: {
        engine: {
          type: 'positional',
          description: `Engine type: ${ENGINE_TYPES.join(' | ')}`,
          required: true,
        },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const engine = args.engine as string
        if (!ENGINE_TYPES.includes(engine as (typeof ENGINE_TYPES)[number])) {
          throw new CliError(
            `Invalid engine type: ${engine} (allowed: ${ENGINE_TYPES.join(' | ')})`,
          )
        }
        const client = createClient({ url: args.url as string | undefined })
        const { data } = await client.get<{ data: LoginStatus }>(
          `/api/providers/login-status/${engine}`,
        )
        if (emit(args, data)) return
        console.log(`Installed:  ${data.installed}`)
        console.log(`LoggedIn:   ${data.loggedIn}`)
        if (data.method) console.log(`Method:     ${data.method}`)
        if (data.detail) console.log(`Detail:     ${data.detail}`)
        if (data.version) console.log(`Version:    ${data.version}`)
        if (data.minVersion) {
          console.log(
            `MinVersion: ${data.minVersion}${data.versionOk === false ? '  ⚠ version too old' : ''}`,
          )
        }
        if (data.error) console.log(`Error:      ${data.error}`)
      },
    }),

    dependents: defineCommand({
      meta: {
        name: 'dependents',
        description: 'List Agents that depend on this Provider',
        agentMeta: { risk: 'read' },
      },
      args: {
        id: { type: 'positional', description: 'Provider ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveProviderId(args.id as string)
        const { data } = await client.get<{
          data: { agents: Array<{ id: string; name: string }> }
        }>(`/api/providers/${id}/dependents`)
        if (emit(args, data)) return
        if (data.agents.length === 0) {
          console.log('No agents depend on this provider')
          return
        }
        for (const a of data.agents) {
          console.log(`${a.id}  ${a.name}`)
        }
      },
    }),
  },
})
