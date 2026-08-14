import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import {
  forceArgs,
  parseKeyValues,
  readJsonFile,
  requireConfirmation,
  resolveForceFlag,
  toStringArray,
} from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'
import { pageArgs, pageQuery } from '../lib/paginate.js'

interface McpServer {
  id: string
  name: string
  description?: string | null
  type: string
  command?: string | null
  args?: string[]
  cwd?: string | null
  url?: string | null
  headers?: Record<string, string> | null
  env?: Record<string, string> | null
  isEnabled: boolean
  usageScope: 'private' | 'admin-only' | 'all-users'
  createdAt: string
  updatedAt: string
}

const MCP_TYPES = ['stdio', 'sse', 'http', 'group'] as const

/** Build the request body from create/update flags; when create=true, validate required name/type combinations. */
function buildMcpBody(args: Record<string, unknown>, create: boolean): Record<string, unknown> {
  // --config-file fallback: read the whole JSON body directly (complex structures like group go here)
  if (args['config-file']) {
    return readJsonFile(args['config-file'] as string)
  }

  const body: Record<string, unknown> = {}
  if (args.name) body.name = args.name as string
  if (args.description) body.description = args.description as string
  if (args.type) {
    if (!MCP_TYPES.includes(args.type as (typeof MCP_TYPES)[number])) {
      throw new CliError(`Invalid --type: ${args.type} (options: ${MCP_TYPES.join(' | ')})`)
    }
    if (args.type === 'group') {
      throw new CliError('For the group type, provide groupConfig via --config-file <json>')
    }
    body.type = args.type as string
  }
  if (args.command) body.command = args.command as string
  const argList = toStringArray(args.arg)
  if (argList.length > 0) body.args = argList
  if (args.cwd) body.cwd = args.cwd as string
  if (args.endpoint) body.url = args.endpoint as string
  const headers = parseKeyValues(args.header, 'header')
  if (headers) body.headers = headers
  const env = parseKeyValues(args.env, 'env')
  if (env) body.env = env
  if (args.enabled !== undefined) body.isEnabled = args.enabled as boolean

  if (create && !body.name) {
    throw new CliError('--name is required when creating an MCP Server')
  }
  return body
}

const mutationArgs = {
  name: { type: 'string' as const, description: 'MCP Server name' },
  description: { type: 'string' as const, description: 'Description' },
  type: {
    type: 'string' as const,
    description: 'Type: stdio | sse | http (use --config-file for group)',
  },
  command: { type: 'string' as const, description: 'stdio: launch command' },
  arg: { type: 'string' as const, description: 'stdio: command argument (repeatable)' },
  cwd: { type: 'string' as const, description: 'stdio: working directory' },
  endpoint: {
    type: 'string' as const,
    description: 'sse/http: server address (maps to body.url, avoids --url)',
  },
  header: {
    type: 'string' as const,
    description: 'sse/http: request header key=value (repeatable)',
  },
  env: {
    type: 'string' as const,
    description: 'stdio: environment variable key=value (repeatable)',
  },
  enabled: { type: 'boolean' as const, description: 'Enable or disable' },
  'config-file': {
    type: 'string' as const,
    description: 'Read the full body from a JSON file (fallback for complex structures like group)',
  },
}

export const mcpCommand = defineCommand({
  meta: { name: 'mcp', description: 'Manage MCP Servers' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List all MCP Servers', agentMeta: { risk: 'read' } },
      args: { ...jsonArg, ...pageArgs, ...urlArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const result = await client.get<{ data: McpServer[] }>(
          `/api/mcp-servers?${pageQuery(args, 100)}`,
        )
        if (emit(args, result)) return
        if (result.data.length === 0) {
          console.log('No MCP Servers')
          return
        }
        for (const m of result.data) {
          const flags = [
            m.isEnabled ? 'enabled' : 'disabled',
            // 'private' is the default (owner-only) — show only the notable scopes.
            m.usageScope === 'admin-only'
              ? 'admin-only'
              : m.usageScope === 'all-users'
                ? 'shared'
                : null,
          ]
            .filter(Boolean)
            .join(',')
          console.log(`${m.id}  [${m.type}]  ${m.name}  (${flags})`)
        }
      },
    }),

    get: defineCommand({
      meta: {
        name: 'get',
        description: 'Show MCP Server details (accepts ID or name)',
        agentMeta: { risk: 'read' },
      },
      args: {
        id: { type: 'positional', description: 'MCP Server ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveMcpServerId(args.id as string)
        const res = await client.get<{ data: McpServer }>(`/api/mcp-servers/${id}`)
        if (emit(args, res)) return
        const m = res.data
        console.log(`ID:          ${m.id}`)
        console.log(`Name:        ${m.name}`)
        console.log(`Type:        ${m.type}`)
        console.log(`Enabled:     ${m.isEnabled}`)
        if (m.description) console.log(`Description: ${m.description}`)
        if (m.command) console.log(`Command:     ${m.command}`)
        if (m.args?.length) console.log(`Args:        ${m.args.join(' ')}`)
        if (m.cwd) console.log(`Cwd:         ${m.cwd}`)
        if (m.url) console.log(`URL:         ${m.url}`)
        if (m.headers && Object.keys(m.headers).length)
          console.log(`Headers:     ${Object.keys(m.headers).join(', ')}`)
        if (m.env && Object.keys(m.env).length)
          console.log(`Env:         ${Object.keys(m.env).join(', ')}`)
        console.log(`Updated:     ${m.updatedAt}`)
      },
    }),

    create: defineCommand({
      meta: { name: 'create', description: 'Create an MCP Server', agentMeta: { risk: 'write' } },
      args: { ...mutationArgs, ...urlArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const body = buildMcpBody(args, true)
        const { data } = await client.post<{ data: McpServer }>('/api/mcp-servers', body)
        console.log(`MCP Server created ✓  ${data.id}  ${data.name}`)
      },
    }),

    update: defineCommand({
      meta: {
        name: 'update',
        description: 'Update an MCP Server (accepts ID or name)',
        agentMeta: { risk: 'write' },
      },
      args: {
        id: { type: 'positional', description: 'MCP Server ID or name', required: true },
        ...mutationArgs,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveMcpServerId(args.id as string)
        const body = buildMcpBody(args, false)
        if (Object.keys(body).length === 0) {
          throw new CliError('Specify at least one field to update')
        }
        await client.patch(`/api/mcp-servers/${id}`, body)
        console.log('MCP Server updated ✓')
      },
    }),

    delete: defineCommand({
      meta: {
        name: 'delete',
        description: 'Delete an MCP Server (accepts ID or name)',
        agentMeta: { risk: 'high-risk-write' },
      },
      args: {
        id: { type: 'positional', description: 'MCP Server ID or name', required: true },
        ...forceArgs,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        // Resolve first so the confirmation names the ID actually being deleted.
        const id = await client.resolveMcpServerId(args.id as string)
        await requireConfirmation(
          'high-risk-write',
          `This will permanently delete MCP Server ${id} (${args.id}). This action is irreversible.`,
          resolveForceFlag(args),
        )
        await client.del(`/api/mcp-servers/${id}`)
        console.log('MCP Server deleted ✓')
      },
    }),

    tools: defineCommand({
      meta: {
        name: 'tools',
        agentMeta: { risk: 'read' },
        description: 'Connect and list the tools this MCP Server exposes (for troubleshooting)',
      },
      args: {
        id: { type: 'positional', description: 'MCP Server ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveMcpServerId(args.id as string)
        const { data } = await client.get<{
          data: { tools: Array<{ name: string; description?: string }> }
        }>(`/api/mcp-servers/${id}/tools`)
        if (emit(args, data)) return
        const tools = data.tools ?? []
        if (tools.length === 0) {
          console.log('This MCP Server exposes no tools')
          return
        }
        for (const t of tools) {
          console.log(`${t.name}${t.description ? `  ${t.description}` : ''}`)
        }
      },
    }),
  },
})
