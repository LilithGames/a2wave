import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * a2wave-mcp-group-proxy — MCP Server that proxies requests to grouped backends.
 *
 * Progressive disclosure: list_groups → list_tools → get_tool_schema → call_tool
 * Reads config from a JSON file (path in A2WAVE_GROUP_CONFIG_PATH env var).
 */
import { z } from 'zod'
import { createStreamingSafeFetch, parseTrustedHostnames } from '../lib/streaming-safe-fetch.js'
import type { ToolEntry } from './lib/types.js'

// ============================================================
// Logging — stdio transport reserves stdout for JSON-RPC frames,
// so all diagnostics must go to stderr. `console.error` is also stderr,
// but using it for info-level prints muddies severity; this helper
// keeps semantics clean (info vs warn vs error).
// ============================================================

const log = {
  info: (msg: string) => process.stderr.write(`[info]  ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[warn]  ${msg}\n`),
  error: (msg: string, err?: unknown) => {
    const tail = err ? ` ${err instanceof Error ? (err.stack ?? err.message) : String(err)}` : ''
    process.stderr.write(`[error] ${msg}${tail}\n`)
  },
}

// ============================================================
// Types
// ============================================================

interface InlineBackend {
  mode: 'inline'
  name: string
  type: 'stdio' | 'sse' | 'http'
  command?: string | null
  args?: string[]
  cwd?: string | null
  url?: string | null
  headers?: Record<string, string> | null
  env?: Record<string, string> | null
}

interface GroupConfig {
  backends: Record<string, InlineBackend[]>
}

// ============================================================
// Config
// ============================================================

const configPath = process.env.A2WAVE_GROUP_CONFIG_PATH
const groupName = process.env.A2WAVE_GROUP_NAME ?? 'mcp-group-proxy'
const safeMcpFetch = createStreamingSafeFetch({
  trustedHosts: parseTrustedHostnames(process.env.A2WAVE_TRUSTED_MCP_HOSTS),
})

if (!configPath) {
  log.error('[group-proxy] A2WAVE_GROUP_CONFIG_PATH is not set')
  process.exit(1)
}

let config: GroupConfig
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'))
  // Credentials are resident in memory now; remove the carrier immediately.
  // The parent worker owns an idempotent lifecycle cleanup as a fallback.
  try {
    unlinkSync(configPath)
  } catch {
    // Best effort: parent cleanup handles the remaining file.
  }
} catch (err) {
  log.error('[group-proxy] Failed to read config:', err)
  process.exit(1)
}

// ============================================================
// Resolve stdio command (inline version of resolveStdioCommand)
// ============================================================

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

// ============================================================
// Connection pool & tool cache
// ============================================================

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK Client type
type Client = any

const clientPool = new Map<string, Promise<Client>>()
const toolCache = new Map<string, Map<string, ToolEntry[]>>() // groupKey → backendName → tools[]

function getOrCreateClient(groupKey: string, backend: InlineBackend): Promise<Client> {
  const key = `${groupKey}:${backend.name}`
  const existing = clientPool.get(key)
  if (existing) return existing

  const promise = connectBackend(groupKey, backend).catch((err) => {
    clientPool.delete(key)
    throw err
  })

  clientPool.set(key, promise)
  return promise
}

async function connectBackend(groupKey: string, backend: InlineBackend): Promise<Client> {
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js')

  const CONNECTION_TIMEOUT = 10_000

  // SSE type: try StreamableHTTP first, fall back to SSE (only on connection errors)
  if (backend.type === 'sse') {
    if (!backend.url) {
      throw new Error(`Backend '${backend.name}' has type 'sse' but no url`)
    }
    const url = new URL(backend.url)
    const headers: Record<string, string> = backend.headers ?? {}
    let client = new McpClient({ name: 'a2wave-group-proxy', version: '1.0.0' })
    try {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      )
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
        fetch: safeMcpFetch,
      })
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_TIMEOUT),
        ),
      ])
    } catch {
      // StreamableHTTP connection failed — fall back to SSE transport
      try {
        client.close()
      } catch {
        /* ignore */
      }
      client = new McpClient({ name: 'a2wave-group-proxy', version: '1.0.0' })
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
      const transport = new SSEClientTransport(url, {
        requestInit: { headers },
        fetch: safeMcpFetch,
      })
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_TIMEOUT),
        ),
      ])
    }
    // Connection succeeded with one of the transports — now setup tools
    return await setupClient(client, groupKey, backend)
  }

  const client = new McpClient({ name: 'a2wave-group-proxy', version: '1.0.0' })
  const transport = await createTransport(backend)
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_TIMEOUT),
    ),
  ])

  return await setupClient(client, groupKey, backend)
}

function mapToolsToEntries(
  tools: Array<{ name: string; description?: string; inputSchema: object }>,
  backendName: string,
): ToolEntry[] {
  return tools.map((t) => ({
    name: `${backendName}:${t.name}`,
    originalName: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
    backend: backendName,
  }))
}

function cacheBackendTools(groupKey: string, backendName: string, entries: ToolEntry[]) {
  let group = toolCache.get(groupKey)
  if (!group) {
    group = new Map()
    toolCache.set(groupKey, group)
  }
  group.set(backendName, entries)
}

async function setupClient(
  client: Client,
  groupKey: string,
  backend: InlineBackend,
): Promise<Client> {
  // Evict dead clients from pool on transport close
  const poolKey = `${groupKey}:${backend.name}`
  try {
    client.onclose = () => {
      clientPool.delete(poolKey)
      log.info(`[close] ${poolKey}: evicted from pool`)
    }
  } catch {
    /* ignore if SDK doesn't support onclose */
  }

  // Register tools/list_changed notification handler
  try {
    client.setNotificationHandler({ method: 'notifications/tools/list_changed' }, async () => {
      try {
        const result = await client.listTools()
        const entries = mapToolsToEntries(result.tools, backend.name)
        cacheBackendTools(groupKey, backend.name, entries)
        log.info(`[tools_changed] ${groupKey}/${backend.name}: ${entries.length} tools refreshed`)
      } catch (err) {
        log.error(`[tools_changed] ${groupKey}/${backend.name} error:`, err)
      }
    })
  } catch {
    // Some SDK versions may not support this pattern — ignore
  }

  // Fetch initial tools.
  //
  // A failure here must propagate. Returning the client anyway would let
  // getOrCreateClient cache the *resolved* promise for the process lifetime —
  // its `.catch` evicts only on connection failure — so ensureToolsLoaded would
  // hit that entry forever and never retry. The backend's tools would stay
  // permanently missing while list_tools reported success (it only flags an
  // error when the whole group is empty), leaving the calling Agent to conclude
  // those tools do not exist. Failing here evicts the entry, so the next call
  // reconnects and tries again.
  try {
    const result = await client.listTools()
    const entries = mapToolsToEntries(result.tools, backend.name)
    cacheBackendTools(groupKey, backend.name, entries)
    log.info(`[init] ${groupKey}/${backend.name}: ${entries.length} tools cached`)
  } catch (err) {
    log.error(`[init] ${groupKey}/${backend.name} tools fetch failed:`, err)
    try {
      await client.close()
    } catch {
      /* the transport may already be gone; eviction is what matters */
    }
    throw err
  }

  return client
}

async function createTransport(backend: InlineBackend) {
  if (backend.type === 'stdio') {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    if (!backend.command)
      throw new Error(`Backend "${backend.name}" missing command for stdio type`)
    const resolvedCommand = resolveStdioCommand(backend.command)
    const backendEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...(backend.env ?? {}),
    }
    const opts: {
      command: string
      args: string[]
      env: Record<string, string>
      stderr: 'pipe'
      cwd?: string
    } = {
      command: resolvedCommand,
      args: backend.args ?? [],
      env: backendEnv,
      stderr: 'pipe',
    }
    if (backend.cwd?.trim()) {
      opts.cwd = backend.cwd.trim()
    }
    return new StdioClientTransport(opts)
  }

  if (!backend.url)
    throw new Error(`Backend "${backend.name}" missing url for ${backend.type} type`)
  const url = new URL(backend.url)
  const headers: Record<string, string> = backend.headers ?? {}

  // http type: StreamableHTTP only (SSE fallback handled in connectBackend for 'sse' type)
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    fetch: safeMcpFetch,
  })
}

// ============================================================
// Group key resolver
// ============================================================

function resolveGroupKey(groupKey?: string): string {
  const keys = Object.keys(config.backends)
  if (groupKey) {
    if (!keys.includes(groupKey)) {
      throw new Error(`Invalid groupKey "${groupKey}". Available: ${keys.join(', ')}`)
    }
    return groupKey
  }
  if (keys.length === 1) return keys[0]
  throw new Error(`groupKey is required when multiple groups exist. Available: ${keys.join(', ')}`)
}

// ============================================================
// Ensure tools loaded for a groupKey
// ============================================================

async function ensureToolsLoaded(groupKey: string): Promise<void> {
  const backends = config.backends[groupKey]
  if (!backends) return

  const results = await Promise.allSettled(backends.map((b) => getOrCreateClient(groupKey, b)))

  // Log failures
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      log.error(
        `[connect] ${groupKey}/${backends[i].name} failed:`,
        (results[i] as PromiseRejectedResult).reason,
      )
    }
  }
}

// ============================================================
// Preconnect
// ============================================================

async function preconnectAll() {
  const allTasks = Object.entries(config.backends).flatMap(([groupKey, backends]) =>
    backends.map((b) => ({
      groupKey,
      backend: b,
      promise: getOrCreateClient(groupKey, b),
    })),
  )
  await Promise.allSettled(allTasks.map((t) => t.promise))

  const groupKeys = new Set(allTasks.map((t) => t.groupKey))
  log.info(`[preconnect] Done. ${allTasks.length} backends across ${groupKeys.size} groups.`)
}

// ============================================================
// Graceful shutdown
// ============================================================

async function shutdown() {
  log.info('[group-proxy] Shutting down...')
  const closePromises: Promise<void>[] = []
  for (const [, clientPromise] of clientPool.entries()) {
    closePromises.push(
      clientPromise
        .then((client) => client.close())
        .catch(() => {
          /* ignore */
        }),
    )
  }
  await Promise.allSettled(closePromises)
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ============================================================
// MCP Server
// ============================================================

export async function startServer(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')

  const server = new McpServer({
    name: groupName,
    version: '1.0.0',
  })

  // --- list_groups ---
  server.tool(
    'list_groups',
    'List all available group keys (e.g. prod, staging, dev) and their backend counts. Discovery flow: list_groups → list_tools(groupKey) → get_tool_schema(toolNames) → call_tool(toolName, arguments).',
    {},
    () => {
      const groups = Object.entries(config.backends).map(([groupKey, backends]) => ({
        groupKey,
        backends: backends.length,
      }))
      const keys = Object.keys(config.backends)
      const hint =
        keys.length === 1
          ? 'Only one group — groupKey can be omitted in list_tools and call_tool'
          : undefined
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ groups, ...(hint ? { hint } : {}) }, null, 2),
          },
        ],
      }
    },
  )

  // --- list_tools ---
  server.tool(
    'list_tools',
    'List all tools in a group. Returns tool names and descriptions (lightweight, no inputSchema). Use get_tool_schema to fetch full inputSchema before calling a tool. groupKey is optional when only one group exists.',
    {
      groupKey: z
        .string()
        .optional()
        .describe('Target group key (e.g. prod, staging). Optional when only one group exists.'),
    },
    async ({ groupKey }) => {
      let gk: string
      try {
        gk = resolveGroupKey(groupKey)
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true,
        }
      }

      await ensureToolsLoaded(gk)

      const allToolsMap = toolCache.get(gk)
      if (!allToolsMap || allToolsMap.size === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No tools available for group "${gk}". Backends may be unreachable.`,
            },
          ],
          isError: true,
        }
      }

      const allTools = Array.from(allToolsMap.values()).flat()

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                tools: allTools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  backend: t.backend,
                })),
                total: allTools.length,
                hint: 'Use get_tool_schema(toolNames) to fetch inputSchema before calling a tool.',
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // --- get_tool_schema ---
  server.tool(
    'get_tool_schema',
    'Get the full inputSchema for one or more tools. Use this after list_tools to get parameter details before calling a tool. groupKey is optional when only one group exists.',
    {
      groupKey: z
        .string()
        .optional()
        .describe('Target group key. Optional when only one group exists.'),
      toolNames: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe('Tool names from list_tools results (format: backendName:toolName)'),
    },
    async ({ groupKey, toolNames }) => {
      let gk: string
      try {
        gk = resolveGroupKey(groupKey)
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true,
        }
      }

      await ensureToolsLoaded(gk)

      const allToolsMap = toolCache.get(gk)
      if (!allToolsMap) {
        return {
          content: [{ type: 'text' as const, text: `No tools available for group "${gk}".` }],
          isError: true,
        }
      }

      // Build a flat lookup from all backends
      const toolLookup = new Map<string, ToolEntry>()
      for (const entries of allToolsMap.values()) {
        for (const t of entries) {
          toolLookup.set(t.name, t)
        }
      }

      const schemas: Array<Record<string, unknown>> = []
      const notFound: string[] = []
      for (const name of toolNames) {
        const t = toolLookup.get(name)
        if (t) {
          schemas.push({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            backend: t.backend,
          })
        } else {
          notFound.push(name)
        }
      }

      const result: Record<string, unknown> = { tools: schemas }
      if (notFound.length > 0) {
        result.notFound = notFound
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  // --- call_tool ---
  server.tool(
    'call_tool',
    "Execute a tool in a group. Typical flow: list_tools → get_tool_schema → call_tool. toolName must come from list_tools results. arguments must match the tool's inputSchema. groupKey is optional when only one group exists.",
    {
      groupKey: z
        .string()
        .optional()
        .describe('Target group key (e.g. prod, staging). Optional when only one group exists.'),
      toolName: z
        .string()
        .describe('Full tool name from list_tools (format: backendName:toolName)'),
      arguments: z.record(z.unknown()).describe('Tool arguments matching the inputSchema'),
    },
    async ({ groupKey, toolName, arguments: args }) => {
      let gk: string
      try {
        gk = resolveGroupKey(groupKey)
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true,
        }
      }

      // Parse backendName:toolName
      const colonIdx = toolName.indexOf(':')
      if (colonIdx === -1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid toolName "${toolName}". Expected format: "backendName:toolName". Use list_tools first.`,
            },
          ],
          isError: true,
        }
      }
      const backendName = toolName.slice(0, colonIdx)
      const originalToolName = toolName.slice(colonIdx + 1)

      // Find backend
      const backends = config.backends[gk]
      const backend = backends?.find((b) => b.name === backendName)
      if (!backend) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Backend "${backendName}" not found in group "${gk}". Available backends: ${backends?.map((b) => b.name).join(', ') ?? 'none'}`,
            },
          ],
          isError: true,
        }
      }

      // Get or create client (with retry on failure)
      let client: Client
      try {
        client = await getOrCreateClient(gk, backend)
      } catch {
        // Retry once — delete stale entry and reconnect
        clientPool.delete(`${gk}:${backend.name}`)
        try {
          client = await getOrCreateClient(gk, backend)
        } catch (retryErr) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to connect to backend "${backendName}": ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
              },
            ],
            isError: true,
          }
        }
      }

      try {
        const result = await client.callTool({ name: originalToolName, arguments: args })
        return result
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Tool "${toolName}" execution failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Background preconnect — don't block server startup
  preconnectAll().catch((err) => log.error('[preconnect]', err))
}

// ============================================================
// Direct execution guard
// ============================================================

const currentFile =
  typeof __filename !== 'undefined'
    ? __filename
    : import.meta.url
      ? fileURLToPath(import.meta.url)
      : undefined
const isDirectExecution =
  currentFile && process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)

if (isDirectExecution) {
  startServer().catch((err) => {
    log.error('[group-proxy] Failed to start:', err)
    process.exit(1)
  })
}
