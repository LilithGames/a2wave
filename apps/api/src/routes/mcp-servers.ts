import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  ADMIN_MCP_NAMES,
  createMcpServerInput,
  type GroupConfig,
  INTERNAL_MCP_NAMES,
  updateMcpServerInput,
} from '@a2wave/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { and, count, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { mcpServers, users } from '../db/schema.js'
import { env } from '../env.js'
import { cleanupTempGroupConfig } from '../lib/agent-helpers.js'
import { logAudit } from '../lib/audit.js'
import { createId } from '../lib/id.js'
import { redactMcpServerSecrets } from '../lib/mcp-redaction.js'
import { introducesStdioExecution, resolveUsageScope } from '../lib/mcp-stdio.js'
import { getCurrentUserId, getOwnerFilter } from '../lib/owner-filter.js'
import { createStreamingSafeFetch, parseTrustedHostnames } from '../lib/streaming-safe-fetch.js'
import { assertSafeStrictUrl } from '../lib/url-safety-core.js'
import { isAdmin } from '../middleware/auth-middleware.js'

const execFileAsync = promisify(execFile)
const app = new Hono()
const safeMcpFetch = createStreamingSafeFetch({
  trustedHosts: parseTrustedHostnames(env.TRUSTED_MCP_HOSTS),
})

/** System-managed builtin MCP names (seeded with userId IS NULL); a user may not
 *  create a row shadowing one. `a2wave-mcp-group-proxy` is a config-only builtin
 *  (no DB row) but is reserved here too so it can never be forged. */
const RESERVED_MCP_NAMES: ReadonlySet<string> = new Set([
  ...INTERNAL_MCP_NAMES,
  ...ADMIN_MCP_NAMES,
  'a2wave-mcp-group-proxy',
])

/**
 * Rows an MCP list/selector should show the caller. Admins see everything. A
 * non-admin sees their OWN rows plus SHARED ones (usage_scope = 'all-users', which
 * only an admin can set, so it is always a deliberate share). A non-admin's own
 * private sse/http is not shown to others — mirrors canNonAdminUseMcp so list
 * visibility matches bindability. No owner-role lookup: scope is the single source.
 */
function getMcpVisibilityFilter(c: import('hono').Context): SQL<unknown> | undefined {
  const role = c.get('userRole' as never) as string
  if (role === 'admin') return undefined
  const me = c.get('userId' as never) as string | undefined
  // Fail closed if identity is missing (defence in depth; the auth middleware
  // should already guarantee it) — show only shared rows, never someone's private one.
  if (!me) {
    return eq(mcpServers.usageScope, 'all-users')
  }
  return or(eq(mcpServers.userId, me), eq(mcpServers.usageScope, 'all-users'))
}

/**
 * Redact a row's private config for a caller who is NOT its owner (and not admin).
 * A shared MCP is bindable/runnable purely by id (the server resolves credentials
 * in buildAgentConfig), so a non-owner viewer never needs the raw config: its
 * `env`/`headers` values are fully masked and the `url` is reduced to its bare
 * origin (userinfo/path/query/hash dropped, since a secret can hide in any of
 * them). id/name/type/usageScope/description stay for the selector.
 * groupConfig inline env/headers are masked too. Returns the row unchanged for the
 * owner or an admin.
 */
function maskMcpForViewer<T extends Record<string, unknown>>(c: import('hono').Context, row: T): T {
  const role = c.get('userRole' as never) as string
  const me = c.get('userId' as never) as string | undefined
  if (role === 'admin' || (me && row.userId === me)) return row
  return redactMcpServerSecrets(row)
}

/** 解析 stdio 命令：若为 npx/node/uvx，使用已知路径的可执行文件，避免 ENOENT（API 进程 PATH 与用户 shell 不同） */
function resolveStdioCommand(command: string): string {
  const base = command.trim().toLowerCase()
  if (base === 'npx' || base === 'node') {
    const nodeDir = dirname(process.execPath)
    const name = process.platform === 'win32' ? (base === 'npx' ? 'npx.cmd' : 'node.exe') : base
    return join(nodeDir, name)
  }
  if (base === 'uvx' || base === 'uv') {
    const wellKnown = join('/usr/local/bin', base)
    if (existsSync(wellKnown)) return wellKnown
    return command
  }
  return command
}

/**
 * Validate that all ref backend mcpServerId values are accessible to the requesting
 * user. "Accessible" must mirror what the caller can actually bind at runtime
 * (canNonAdminUseMcp / getMcpVisibilityFilter): an admin sees everything, and a
 * non-admin may reference a server they OWN or one explicitly shared 'all-users'
 * (incl. system builtins). Otherwise a non-admin could build a group referencing an
 * admin-shared server that resolveGroupRefs happily resolves at run time, yet the
 * save is rejected — an asymmetry that blocks a legitimate composition.
 */
async function validateRefOwnership(
  groupConfig: GroupConfig,
  ownerFilter: ReturnType<typeof getOwnerFilter>,
): Promise<string[]> {
  const refIds: string[] = []
  for (const backends of Object.values(groupConfig.backends)) {
    for (const b of backends) {
      if (b.mode === 'ref') refIds.push(b.mcpServerId)
    }
  }
  if (refIds.length === 0) return []

  const uniqueIds = [...new Set(refIds)]
  // ownerFilter is undefined for admins (see everything); for a non-admin it scopes
  // to their own rows — widen it to also accept shared 'all-users' servers.
  const conditions = ownerFilter
    ? and(
        inArray(mcpServers.id, uniqueIds),
        or(ownerFilter, eq(mcpServers.usageScope, 'all-users')),
      )
    : inArray(mcpServers.id, uniqueIds)
  const accessible = await db.select({ id: mcpServers.id }).from(mcpServers).where(conditions)
  const accessibleIds = new Set(accessible.map((r) => r.id))
  return uniqueIds.filter((id) => !accessibleIds.has(id))
}

/** Validate inline backend URLs are not internal/blocked addresses */
function validateInlineBackendUrls(groupConfig: GroupConfig): string[] {
  const blocked: string[] = []
  for (const [groupKey, backends] of Object.entries(groupConfig.backends)) {
    for (const b of backends) {
      if (b.mode === 'inline' && (b.type === 'sse' || b.type === 'http') && b.url) {
        try {
          assertSafeStrictUrl(b.url)
        } catch {
          blocked.push(`${groupKey}/${b.name}: ${b.url}`)
        }
      }
    }
  }
  return blocked
}

/** GET / - 列出所有 MCP Servers */
app.get('/', async (c) => {
  const { page = '1', pageSize = '50' } = c.req.query()
  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize) || 50))
  const offset = (pageNum - 1) * limit

  // Show own rows + genuinely shared (all-users, admin/builtin-owned) servers, so
  // an admin-shared MCP is discoverable and bindable by non-admins.
  const visibility = getMcpVisibilityFilter(c)
  const totalResult = (
    await db.select({ count: count() }).from(mcpServers).where(visibility).limit(1)
  )[0]
  const data = await db
    .select()
    .from(mcpServers)
    .where(visibility)
    .orderBy(desc(mcpServers.createdAt))
    .limit(limit)
    .offset(offset)
  const total = totalResult?.count ?? 0

  return c.json({
    // Redact private config (env/headers/url creds) on rows the caller does not
    // own — a shared MCP is bound by id; the raw credentials must not leak.
    data: data.map((row) => maskMcpForViewer(c, row)),
    pagination: { total, page: pageNum, pageSize: limit, totalPages: Math.ceil(total / limit) },
  })
})

/** GET /:id - 获取单个 MCP Server */
app.get('/:id', async (c) => {
  const { id } = c.req.param()
  // Read path: visible if own or genuinely shared (so a shared server can be viewed
  // and bound by a non-admin).
  const visibility = getMcpVisibilityFilter(c)
  const conditions = visibility ? and(eq(mcpServers.id, id), visibility) : eq(mcpServers.id, id)
  const server = (await db.select().from(mcpServers).where(conditions).limit(1))[0]
  if (!server) {
    return c.json({ error: 'MCP Server not found' }, 404)
  }
  // Redact private config for a non-owner viewer (shared servers are bound by id).
  return c.json({ data: maskMcpForViewer(c, server) })
})

/** GET /:id/tools - 获取 MCP Server 的工具列表（支持 SSE/HTTP、stdio 和 group） */
app.get('/:id/tools', async (c) => {
  const { id } = c.req.param()
  // Read path: own or genuinely shared servers are viewable (probe still gated
  // separately: only admins probe stdio, below).
  const visibility = getMcpVisibilityFilter(c)
  const conditions = visibility ? and(eq(mcpServers.id, id), visibility) : eq(mcpServers.id, id)
  const server = (await db.select().from(mcpServers).where(conditions).limit(1))[0]
  if (!server) {
    return c.json({ error: 'MCP Server not found' }, 404)
  }

  // Probing tools spawns the stdio command (host RCE), same primitive as create.
  // Gate it here too — otherwise a pre-existing / imported stdio row owned by a
  // non-admin (create is gated, but legacy + agent-import rows exist) stays
  // executable via this endpoint.
  if (
    introducesStdioExecution(server.type, server.groupConfig as GroupConfig | null) &&
    !isAdmin(c)
  ) {
    return c.json({ error: 'Only admin can probe stdio MCP servers' }, 403)
  }

  // Live-probing an sse/http server makes an outbound call using the SERVER's
  // headers (owner credentials). A non-owner probing a shared server would be a
  // confused deputy — the platform would authenticate to the remote as the owner.
  // Only the owner or an admin may live-probe; groups return static meta-tools
  // below (no outbound call), so they are exempt.
  const me = c.get('userId' as never) as string | undefined
  if (
    (server.type === 'sse' || server.type === 'http') &&
    !isAdmin(c) &&
    server.userId !== null &&
    server.userId !== me
  ) {
    return c.json({ error: 'Only the owner or an admin can probe this MCP server' }, 403)
  }

  // Group type: return static meta-tool descriptions
  if (server.type === 'group') {
    const tools = [
      {
        name: 'list_groups',
        description:
          'List all available group keys and their backend counts. Discovery flow: list_groups → list_tools → get_tool_schema → call_tool.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_tools',
        description:
          'List all tools in a group. Returns names and descriptions (lightweight). Use get_tool_schema for full inputSchema.',
        inputSchema: {
          type: 'object',
          properties: {
            groupKey: { type: 'string', description: 'Target group key' },
          },
        },
      },
      {
        name: 'get_tool_schema',
        description:
          'Get full inputSchema for one or more tools. Use after list_tools, before call_tool.',
        inputSchema: {
          type: 'object',
          properties: {
            groupKey: { type: 'string', description: 'Target group key' },
            toolNames: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names from list_tools',
            },
          },
          required: ['toolNames'],
        },
      },
      {
        name: 'call_tool',
        description: 'Execute a tool. Flow: list_tools → get_tool_schema → call_tool.',
        inputSchema: {
          type: 'object',
          properties: {
            groupKey: { type: 'string', description: 'Target group key' },
            toolName: { type: 'string', description: 'Full tool name (backendName:toolName)' },
            arguments: { type: 'object', description: 'Tool arguments' },
          },
          required: ['toolName', 'arguments'],
        },
      },
    ]
    return c.json({ data: { tools } })
  }

  const timeout = 10000

  if (server.type === 'stdio') {
    if (!server.command) {
      return c.json({ error: 'Command is required for stdio MCP server' }, 400)
    }
    // Spawning the stdio command is host execution, gated to admin above; leave a
    // durable audit trail like the sibling POST /probe-tools stdio branch does.
    logAudit(c, {
      action: 'mcp_server.list_tools_stdio',
      resource: 'mcp_server',
      resourceId: id,
      details: { command: server.command },
    })
    const env: Record<string, string> = {}
    if (server.env && typeof server.env === 'object') {
      Object.assign(env, server.env)
    }
    const args = Array.isArray(server.args) ? (server.args as string[]) : []
    let client: Client | undefined
    let stderrOutput = ''
    const resolvedCommand = resolveStdioCommand(server.command)
    const transportOpts: {
      command: string
      args: string[]
      env: Record<string, string>
      stderr: 'pipe'
      cwd?: string
    } = {
      command: resolvedCommand,
      args,
      env,
      stderr: 'pipe',
    }
    if (server.cwd?.trim()) {
      transportOpts.cwd = server.cwd.trim()
    }
    try {
      client = new Client({ name: 'a2wave', version: '1.0.0' })
      const transport = new StdioClientTransport(transportOpts)
      // Capture stderr for diagnostics
      // `stderr` is only populated when the transport was created with stderr: 'pipe'.
      if (transport.stderr) {
        transport.stderr.on('data', (chunk: Buffer) => {
          stderrOutput += chunk.toString().slice(0, 1000)
        })
      }
      const connectPromise = client.connect(transport)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout')), timeout),
      )
      await Promise.race([connectPromise, timeoutPromise])
      const result = await client.listTools()
      const tools = result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
      return c.json({ data: { tools } })
    } catch (err) {
      const baseMessage =
        err instanceof Error ? err.message : 'Failed to connect to stdio MCP server'
      // Extract meaningful error line from stderr (prefer lines starting with "Error:")
      const stderrLines = stderrOutput.trim().split('\n').filter(Boolean)
      const errorLine = stderrLines.find(
        (l) => l.startsWith('Error:') || l.startsWith('TypeError:') || l.startsWith('SyntaxError:'),
      )
      const stderrHint = errorLine ?? stderrLines[0]
      // Auto-repair: detect npm dependency conflict (empty package directory) and fix
      if (stderrOutput.includes('Cannot find package')) {
        const repairMatch = stderrOutput.match(
          /Cannot find package '([^']+)' imported from (\/.*?\/node_modules\/(?:@[^/]+\/)?[^/]+)\//,
        )
        if (repairMatch) {
          const [, missingPkg, importerPkgPath] = repairMatch
          const pkgDir = `${importerPkgPath}/`
          try {
            const pkgJson = JSON.parse(readFileSync(`${pkgDir}package.json`, 'utf8'))
            const requiredVersion =
              pkgJson.dependencies?.[missingPkg] ?? pkgJson.peerDependencies?.[missingPkg]
            if (requiredVersion) {
              await execFileAsync(
                'npm',
                ['install', '--no-save', `${missingPkg}@${requiredVersion}`],
                { cwd: pkgDir },
              )
              const retryClient = new Client({ name: 'a2wave', version: '1.0.0' })
              try {
                const retryTransport = new StdioClientTransport(transportOpts)
                await Promise.race([
                  retryClient.connect(retryTransport),
                  new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('Connection timeout')), timeout),
                  ),
                ])
                const retryResult = await retryClient.listTools()
                const tools = retryResult.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema,
                }))
                return c.json({ data: { tools } })
              } finally {
                try {
                  await retryClient.close()
                } catch {
                  /* ignore */
                }
              }
            }
          } catch {
            // Repair failed, fall through to original error
          }
        }
      }
      const message = stderrHint ? `${baseMessage}: ${stderrHint}` : baseMessage
      return c.json({ error: message }, 502)
    } finally {
      if (client) {
        try {
          await client.close()
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (!server.url) {
    return c.json({ error: 'URL is required for SSE/HTTP MCP server' }, 400)
  }

  const headers: Record<string, string> = {}
  if (server.headers && typeof server.headers === 'object') {
    Object.assign(headers, server.headers)
  }

  const url = new URL(server.url)

  // http: 直接使用 StreamableHTTPClientTransport
  // sse: 保持原有探测逻辑（先 Streamable HTTP，失败回退 SSE）
  const transportFactories =
    server.type === 'http'
      ? [
          () =>
            new StreamableHTTPClientTransport(url, {
              requestInit: { headers },
              fetch: safeMcpFetch,
            }),
        ]
      : [
          () =>
            new StreamableHTTPClientTransport(url, {
              requestInit: { headers },
              fetch: safeMcpFetch,
            }),
          () => new SSEClientTransport(url, { requestInit: { headers }, fetch: safeMcpFetch }),
        ]

  let lastError: Error | undefined
  for (const createTransport of transportFactories) {
    let client: Client | undefined
    try {
      client = new Client({ name: 'a2wave', version: '1.0.0' })
      const transport = createTransport()

      const connectPromise = client.connect(transport)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout')), timeout),
      )
      await Promise.race([connectPromise, timeoutPromise])

      const result = await client.listTools()
      const tools = result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))

      return c.json({ data: { tools } })
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Failed to connect to MCP server')
    } finally {
      if (client) {
        try {
          await client.close()
        } catch {
          // ignore close errors
        }
      }
    }
  }

  return c.json({ error: lastError?.message ?? 'Failed to connect to MCP server' }, 502)
})

/** POST /probe-tools - 用临时连接探测 MCP Server 工具列表（不需要先保存） */
const probeToolsInput = z.object({
  type: z.enum(['stdio', 'sse', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})

app.post('/probe-tools', async (c) => {
  const body = await c.req.json()
  const parsed = probeToolsInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const { type, command, args, url, headers: hdrs, env } = parsed.data

  const timeout = 10000

  if (type === 'stdio') {
    if (!command?.trim()) return c.json({ error: 'command is required for stdio' }, 400)
    // Probing a stdio server spawns an arbitrary local command (host RCE); gate
    // to admin and audit it — the handler otherwise writes no audit trail.
    if (!isAdmin(c)) {
      return c.json({ error: 'Only admin can probe stdio MCP servers' }, 403)
    }
    logAudit(c, {
      action: 'mcp_server.probe_stdio',
      resource: 'mcp_server',
      resourceId: 'probe',
      details: { command },
    })
    const resolvedArgs = Array.isArray(args) ? args : []
    const resolvedEnv: Record<string, string> = {}
    if (env && typeof env === 'object') Object.assign(resolvedEnv, env)
    let client: Client | undefined
    let stderrOutput = ''
    try {
      client = new Client({ name: 'a2wave-probe', version: '1.0.0' })
      const transport = new StdioClientTransport({
        command: resolveStdioCommand(command.trim()),
        args: resolvedArgs,
        env: resolvedEnv,
        stderr: 'pipe',
      })
      // `stderr` is only populated when the transport was created with stderr: 'pipe'.
      if (transport.stderr) {
        transport.stderr.on('data', (chunk: Buffer) => {
          stderrOutput += chunk.toString().slice(0, 1000)
        })
      }
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), timeout),
        ),
      ])
      const result = await client.listTools()
      return c.json({
        data: {
          tools: result.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      })
    } catch (err) {
      const base = err instanceof Error ? err.message : 'Failed to connect'
      const lines = stderrOutput.trim().split('\n').filter(Boolean)
      const hint =
        lines.find((l) => l.startsWith('Error:') || l.startsWith('TypeError:')) ?? lines[0]
      return c.json({ error: hint ? `${base}: ${hint}` : base }, 502)
    } finally {
      if (client) {
        try {
          await client.close()
        } catch {
          /* ignore */
        }
      }
    }
  }

  // sse / http
  if (!url?.trim()) return c.json({ error: 'url is required for sse/http' }, 400)
  let parsedUrl: URL
  try {
    parsedUrl = assertSafeStrictUrl(url)
  } catch {
    return c.json({ error: 'URL must be a public HTTP(S) address' }, 400)
  }
  const headers: Record<string, string> = {}
  if (hdrs && typeof hdrs === 'object') Object.assign(headers, hdrs)

  const factories =
    type === 'http'
      ? [
          () =>
            new StreamableHTTPClientTransport(parsedUrl, {
              requestInit: { headers },
              fetch: safeMcpFetch,
            }),
        ]
      : [
          () =>
            new StreamableHTTPClientTransport(parsedUrl, {
              requestInit: { headers },
              fetch: safeMcpFetch,
            }),
          () =>
            new SSEClientTransport(parsedUrl, { requestInit: { headers }, fetch: safeMcpFetch }),
        ]

  let lastError: Error | undefined
  for (const create of factories) {
    let client: Client | undefined
    try {
      client = new Client({ name: 'a2wave-probe', version: '1.0.0' })
      await Promise.race([
        client.connect(create()),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), timeout),
        ),
      ])
      const result = await client.listTools()
      return c.json({
        data: {
          tools: result.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      })
    } catch (err) {
      lastError = err instanceof Error ? err : new Error('Failed to connect')
    } finally {
      if (client) {
        try {
          await client.close()
        } catch {
          /* ignore */
        }
      }
    }
  }
  return c.json({ error: lastError?.message ?? 'Failed to connect' }, 502)
})

/** POST / - 创建 MCP Server */
app.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = createMcpServerInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  // Reserved builtin names are system-managed (seeded with userId IS NULL). Block
  // manual creation so a user row can never shadow a builtin — belt to the seeder's
  // userId-scoped query, and it stops the confusing UX of a duplicate reserved name.
  if (RESERVED_MCP_NAMES.has(parsed.data.name)) {
    return c.json({ error: `'${parsed.data.name}' is a reserved built-in MCP name` }, 400)
  }

  // stdio = arbitrary local command execution (host RCE); admin-only. This also
  // covers inline stdio backends inside group configs.
  if (
    introducesStdioExecution(parsed.data.type, parsed.data.groupConfig as GroupConfig | null) &&
    !isAdmin(c)
  ) {
    return c.json({ error: 'Only admin can create stdio MCP servers' }, 403)
  }

  // Cross-validate: group type requires groupConfig
  if (parsed.data.type === 'group') {
    if (!parsed.data.groupConfig || Object.keys(parsed.data.groupConfig.backends).length === 0) {
      return c.json(
        { error: 'groupConfig with at least one group key is required for group type' },
        400,
      )
    }
    // Reject group keys with empty backends arrays
    const emptyKeys = Object.entries(parsed.data.groupConfig.backends)
      .filter(([, bs]) => bs.length === 0)
      .map(([k]) => k)
    if (emptyKeys.length > 0) {
      return c.json({ error: `Group key(s) have no backends: ${emptyKeys.join(', ')}` }, 400)
    }
    // Validate ref ownership
    const ownerFilter = getOwnerFilter(c, mcpServers.userId)
    const inaccessible = validateRefOwnership(parsed.data.groupConfig as GroupConfig, ownerFilter)
    if ((await inaccessible).length > 0) {
      return c.json(
        { error: `Referenced MCP server(s) not accessible: ${(await inaccessible).join(', ')}` },
        403,
      )
    }
    // SSRF: block inline SSE/HTTP backends targeting internal addresses
    const blockedUrls = validateInlineBackendUrls(parsed.data.groupConfig as GroupConfig)
    if (blockedUrls.length > 0) {
      return c.json(
        { error: `Inline backend URL(s) point to blocked addresses: ${blockedUrls.join(', ')}` },
        400,
      )
    }
  }
  if ((parsed.data.type === 'sse' || parsed.data.type === 'http') && parsed.data.url) {
    try {
      assertSafeStrictUrl(parsed.data.url)
    } catch {
      return c.json({ error: 'URL must be a public HTTP(S) address' }, 400)
    }
  }
  // Non-group type: clear groupConfig
  if (parsed.data.type !== 'group') {
    parsed.data.groupConfig = null
  }

  const id = createId('mcp')
  const userId = getCurrentUserId(c)
  // The usage scope lives in the DATA (single source of truth read by the bind
  // check and runtime). stdio-capable → forced 'admin-only'; a non-stdio server is
  // 'private' (owner-only) by default — its URL/headers/env are private credentials,
  // so it is NOT shared implicitly. Only an admin may set 'all-users' to share it.
  const usageScope = resolveUsageScope({
    type: parsed.data.type,
    groupConfig: parsed.data.groupConfig as GroupConfig | null,
    requested: parsed.data.usageScope,
    isAdmin: isAdmin(c),
    fallback: 'private',
  })
  const newServer = (
    await db
      .insert(mcpServers)
      .values({
        id,
        ...parsed.data,
        usageScope,
        userId,
      })
      .returning()
  )[0]

  logAudit(c, { action: 'mcp_server.create', resource: 'mcp_server', resourceId: id })

  return c.json({ data: newServer }, 201)
})

/** PATCH /:id - 更新 MCP Server */
app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, mcpServers.userId)
  const conditions = ownerFilter ? and(eq(mcpServers.id, id), ownerFilter) : eq(mcpServers.id, id)
  const existing = (await db.select().from(mcpServers).where(conditions).limit(1))[0]
  if (!existing) {
    return c.json({ error: 'MCP Server not found' }, 404)
  }

  if (existing.usageScope === 'admin-only') {
    const role = c.get('userRole' as never) as string
    if (role !== 'admin') {
      return c.json({ error: 'Admin-only MCP servers can only be modified by admins' }, 403)
    }
  }

  const body = await c.req.json()
  const parsed = updateMcpServerInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  // Same reserved-name invariant as create: a user row must never shadow a builtin.
  // updateMcpServerInput allows `name`, so a rename to a reserved builtin name must
  // be blocked here too (create-only would let PATCH sidestep it).
  if (parsed.data.name !== undefined && RESERVED_MCP_NAMES.has(parsed.data.name)) {
    return c.json({ error: `'${parsed.data.name}' is a reserved built-in MCP name` }, 400)
  }

  // Cross-validate: merge with existing to check group type
  const effectiveType = parsed.data.type ?? existing.type
  const effectiveUrl = parsed.data.url === undefined ? existing.url : parsed.data.url

  // Grandfather an already-stored legacy private target for unrelated edits
  // (name/description/enabled). The protected runtime still refuses to connect
  // to it; URL/type changes must pass the new literal boundary so an old row
  // cannot be used to introduce another unsafe target.
  const remoteTargetChanged = parsed.data.type !== undefined || parsed.data.url !== undefined
  if (
    remoteTargetChanged &&
    (effectiveType === 'sse' || effectiveType === 'http') &&
    effectiveUrl
  ) {
    try {
      assertSafeStrictUrl(effectiveUrl)
    } catch {
      return c.json({ error: 'URL must be a public HTTP(S) address' }, 400)
    }
  }

  // Deny non-admins introducing stdio execution via update (type→stdio, or a
  // group config gaining an inline stdio backend). Same host-RCE bar as create.
  const effectiveGroupConfigForStdio = (parsed.data.groupConfig ??
    existing.groupConfig) as GroupConfig | null
  if (introducesStdioExecution(effectiveType, effectiveGroupConfigForStdio) && !isAdmin(c)) {
    return c.json({ error: 'Only admin can configure stdio MCP servers' }, 403)
  }

  if (effectiveType === 'group') {
    const effectiveGroupConfig = parsed.data.groupConfig ?? existing.groupConfig
    if (!effectiveGroupConfig || Object.keys(effectiveGroupConfig.backends).length === 0) {
      return c.json(
        { error: 'groupConfig with at least one group key is required for group type' },
        400,
      )
    }
    // Reject group keys with empty backends arrays
    const emptyKeys = Object.entries(effectiveGroupConfig.backends)
      .filter(([, bs]) => (bs as unknown[]).length === 0)
      .map(([k]) => k)
    if (emptyKeys.length > 0) {
      return c.json({ error: `Group key(s) have no backends: ${emptyKeys.join(', ')}` }, 400)
    }
    // Reject self-reference
    if (parsed.data.groupConfig) {
      for (const backends of Object.values(parsed.data.groupConfig.backends)) {
        if (backends.some((b) => b.mode === 'ref' && b.mcpServerId === id)) {
          return c.json({ error: 'A group server cannot reference itself' }, 400)
        }
      }
      // Validate ref ownership
      const inaccessible = validateRefOwnership(parsed.data.groupConfig as GroupConfig, ownerFilter)
      if ((await inaccessible).length > 0) {
        return c.json(
          { error: `Referenced MCP server(s) not accessible: ${(await inaccessible).join(', ')}` },
          403,
        )
      }
      // SSRF: block inline SSE/HTTP backends targeting internal addresses
      const blockedUrls = validateInlineBackendUrls(parsed.data.groupConfig as GroupConfig)
      if (blockedUrls.length > 0) {
        return c.json(
          { error: `Inline backend URL(s) point to blocked addresses: ${blockedUrls.join(', ')}` },
          400,
        )
      }
    }
  }
  if (effectiveType !== 'group') {
    parsed.data.groupConfig = null
  }

  // Recompute the persisted usage scope: stdio-capable stays 'admin-only'
  // (an update can't downgrade it into something a non-admin could bind); a
  // non-stdio server takes the admin-submitted scope, else keeps its current one.
  const usageScope = resolveUsageScope({
    type: effectiveType,
    groupConfig: effectiveGroupConfigForStdio,
    requested: parsed.data.usageScope,
    isAdmin: isAdmin(c),
    fallback: existing.usageScope,
  })
  // Invariant: an 'all-users' row must be owned by an admin or be a system builtin
  // (userId === null). Otherwise sharing a NON-admin owner's server would expose
  // THEIR private url/headers/env credentials to everyone at run time. An admin
  // cannot cross-share someone else's private server by PATCH — the owner must be
  // transferred (or the owner shares it themselves) first. Only enforced when the
  // scope is actually becoming all-users (a same-owner keep of an existing admin
  // share is fine).
  if (
    usageScope === 'all-users' &&
    existing.usageScope !== 'all-users' &&
    existing.userId !== null
  ) {
    const owner = (
      await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, existing.userId))
        .limit(1)
    )[0]
    if (owner?.role !== 'admin') {
      return c.json(
        {
          error:
            'Cannot share a non-admin-owned MCP server to all users; transfer ownership to an admin first',
        },
        422,
      )
    }
  }
  const updated = (
    await db
      .update(mcpServers)
      .set({
        ...parsed.data,
        usageScope,
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, id))
      .returning()
  )[0]

  logAudit(c, { action: 'mcp_server.update', resource: 'mcp_server', resourceId: id })

  return c.json({ data: updated })
})

/** POST /:id/clone - 克隆 MCP Server */
app.post('/:id/clone', async (c) => {
  const { id } = c.req.param()
  // Source lookup must use the same VISIBILITY as GET (own + shared 'all-users' +
  // builtins), not just owned rows — otherwise a non-admin who can see a shared
  // server in the list/detail gets a 404 here, and the "non-admin clones a shared
  // server → private clone" path below is unreachable. Ownership is not required to
  // clone something you can see; the clone becomes a fresh private row you own.
  const visibility = getMcpVisibilityFilter(c)
  const conditions = visibility ? and(eq(mcpServers.id, id), visibility) : eq(mcpServers.id, id)
  const server = (await db.select().from(mcpServers).where(conditions).limit(1))[0]
  if (!server) {
    return c.json({ error: 'MCP Server not found' }, 404)
  }

  // Cloning a stdio server mints another arbitrary-command executor; keep the
  // same admin bar as create so clone can't be used to sidestep it.
  if (
    introducesStdioExecution(server.type, server.groupConfig as GroupConfig | null) &&
    !isAdmin(c)
  ) {
    return c.json({ error: 'Only admin can clone stdio MCP servers' }, 403)
  }

  const cloneId = createId('mcp')
  const now = new Date()
  const userId = getCurrentUserId(c)

  // Cloning a server you don't own (a shared 'all-users' one) must NOT hand you the
  // owner's secrets — GET/list already mask them for a non-owner viewer, so clone
  // cannot be a side-channel around that mask. Strip url/headers/env (and inline
  // group-backend credentials) from the clone and require the caller to re-enter
  // them. An admin or the actual owner keeps the full config (they can already read
  // it via GET). stdio is unreachable here for a non-admin (blocked above).
  const callerOwnsSource = server.userId != null && server.userId === userId
  const stripSecrets = !isAdmin(c) && !callerOwnsSource
  const stripGroupCredentials = (gc: GroupConfig | null): GroupConfig | null => {
    if (!gc?.backends) return gc
    return {
      backends: Object.fromEntries(
        Object.entries(gc.backends).map(([key, list]) => [
          key,
          list.map((b) =>
            b.mode === 'inline' ? { ...b, url: null, headers: null, env: null } : b,
          ),
        ]),
      ),
    } as GroupConfig
  }

  const cloned = (
    await db
      .insert(mcpServers)
      .values({
        id: cloneId,
        name: `${server.name} (Copy)`,
        description: server.description,
        type: server.type,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        url: stripSecrets ? null : server.url,
        headers: stripSecrets ? null : server.headers,
        env: stripSecrets ? null : server.env,
        groupConfig: stripSecrets
          ? stripGroupCredentials(server.groupConfig as GroupConfig | null)
          : server.groupConfig,
        // A clone is a freshly authored row owned by the caller, so it follows the
        // CREATE rule, not the source's scope: fallback 'private' (owner-only). An
        // admin may carry the source's scope forward via `requested` (incl. sharing
        // to all-users); a non-admin's request is clamped, so a non-admin cloning an
        // admin-shared server gets a PRIVATE clone — they can't mint an all-users row.
        // stdio-capable is still re-forced 'admin-only' inside resolveUsageScope.
        usageScope: resolveUsageScope({
          type: server.type,
          groupConfig: server.groupConfig as GroupConfig | null,
          requested: isAdmin(c) ? server.usageScope : undefined,
          isAdmin: isAdmin(c),
          fallback: 'private',
        }),
        userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
  )[0]

  // Warn if group config has refs the cloning user cannot access
  if (server.type === 'group' && server.groupConfig) {
    const ownerFilter = getOwnerFilter(c, mcpServers.userId)
    const inaccessible = await validateRefOwnership(server.groupConfig as GroupConfig, ownerFilter)
    if (inaccessible.length > 0) {
      logAudit(c, { action: 'mcp_server.clone', resource: 'mcp_server', resourceId: cloneId })
      return c.json(
        {
          data: cloned,
          warnings: [
            `Some referenced MCP server(s) are not accessible and will be skipped at runtime: ${(inaccessible).join(', ')}`,
          ],
        },
        201,
      )
    }
  }

  logAudit(c, { action: 'mcp_server.clone', resource: 'mcp_server', resourceId: cloneId })

  return c.json({ data: cloned }, 201)
})

/** DELETE /:id - 删除 MCP Server */
app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, mcpServers.userId)
  const conditions = ownerFilter ? and(eq(mcpServers.id, id), ownerFilter) : eq(mcpServers.id, id)
  const server = (await db.select().from(mcpServers).where(conditions).limit(1))[0]
  if (!server) {
    return c.json({ error: 'MCP Server not found' }, 404)
  }

  if (server.usageScope === 'admin-only') {
    const role = c.get('userRole' as never) as string
    if (role !== 'admin') {
      return c.json({ error: 'Admin-only MCP servers can only be deleted by admins' }, 403)
    }
  }

  // Check if any group-type MCP Server references this one (scan all, not just current user's)
  const groupServers = await db.select().from(mcpServers).where(eq(mcpServers.type, 'group'))
  let refCount = 0
  for (const gs of groupServers) {
    if (!gs.groupConfig) continue
    const gc = gs.groupConfig as import('@a2wave/shared').GroupConfig
    for (const backends of Object.values(gc.backends)) {
      for (const backend of backends) {
        if (backend.mode === 'ref' && backend.mcpServerId === id) {
          refCount++
          break
        }
      }
    }
  }
  if ((await refCount) > 0) {
    return c.json(
      {
        error: `Cannot delete: referenced by ${refCount} group MCP server(s). Remove the reference first.`,
      },
      409,
    )
  }

  const deleted = (await db.delete(mcpServers).where(eq(mcpServers.id, id)).returning())[0]

  // Clean up temp group config file if it was a group server
  if (server.type === 'group') {
    cleanupTempGroupConfig(id)
  }

  logAudit(c, { action: 'mcp_server.delete', resource: 'mcp_server', resourceId: id })

  return c.json({ data: deleted })
})

export default app
