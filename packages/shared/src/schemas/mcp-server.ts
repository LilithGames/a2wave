import { z } from 'zod'

// ============================================================
// MCP Server — MCP server configuration
// Four transports: stdio (local command), sse (remote SSE), http (Streamable
// HTTP) and group (multi-environment proxy).
// ============================================================

export const mcpServerTypeEnum = z.enum(['stdio', 'sse', 'http', 'group'])

/**
 * Who may bind/run an MCP server on their own agents. The SINGLE persisted source
 * of truth — decided at write time, only read afterwards; never derived from the
 * owner's current role (so promoting/demoting the owner never changes sharing).
 *   - 'private': only the owner. Default for a non-admin's own sse/http (its URL /
 *     headers / env are private credentials, so it must not be shared implicitly).
 *   - 'admin-only': only admins (their agents). FORCED for stdio-capable servers
 *     (top-level stdio or a group with an inline stdio backend), which execute
 *     arbitrary host commands.
 *   - 'all-users': explicitly shared to everyone. Only an ADMIN may set this — it
 *     is the deliberate "share with the whole org" action; any signed-in user may
 *     then bind it to their own agents.
 * Replaces the old `adminOnly` boolean.
 */
export const mcpUsageScopeEnum = z.enum(['private', 'admin-only', 'all-users'])
export type McpUsageScope = z.infer<typeof mcpUsageScopeEnum>

// ============================================================
// Group Backend Schemas — backend configuration for a `group` MCP Server
// ============================================================

/** Letters, digits, hyphens and underscores only. ":" is forbidden because a tool is addressed as "backendName:toolName". */
const namePattern = /^[a-zA-Z0-9_-]+$/

/** Inline backend configuration */
const inlineBackendSchema = z.object({
  mode: z.literal('inline'),
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(namePattern, 'Only letters, digits, hyphens, underscores allowed'),
  type: z.enum(['stdio', 'sse', 'http']),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  env: z.record(z.string(), z.string()).nullable().optional(),
})

/** Reference to an existing MCP Server */
const refBackendSchema = z.object({
  mode: z.literal('ref'),
  mcpServerId: z.string().min(1),
})

export const groupBackendSchema = z.discriminatedUnion('mode', [
  inlineBackendSchema,
  refBackendSchema,
])

export const groupConfigSchema = z.object({
  backends: z
    .record(z.string(), z.array(groupBackendSchema).min(1).max(20))
    .refine((obj) => Object.keys(obj).length >= 1 && Object.keys(obj).length <= 20, {
      message: 'Must have 1-20 group keys',
    })
    .refine((obj) => Object.keys(obj).every((k) => namePattern.test(k)), {
      message: 'Group key names must only contain letters, digits, hyphens, underscores',
    })
    .refine(
      (obj) => {
        for (const backends of Object.values(obj)) {
          const names = backends.filter((b) => b.mode === 'inline').map((b) => b.name)
          if (new Set(names).size !== names.length) return false
        }
        return true
      },
      { message: 'Backend names must be unique within each group key' },
    ),
})

export type GroupBackend = z.infer<typeof groupBackendSchema>
export type GroupConfig = z.infer<typeof groupConfigSchema>
export type McpServerType = z.infer<typeof mcpServerTypeEnum>

export const mcpServerSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
  /** Transport: stdio | sse | http | group */
  type: mcpServerTypeEnum.default('stdio'),
  /** stdio: launch command (e.g. npx) */
  command: z.string().nullable().optional(),
  /** stdio: command arguments */
  args: z.array(z.string()).default([]),
  /** stdio: child-process working directory. Lets a server run from a local install dir via node, sidestepping npx cache issues. */
  cwd: z.string().nullable().optional(),
  /** sse/http: remote server URL */
  url: z.string().nullable().optional(),
  /** sse/http: custom request headers */
  headers: z.record(z.string(), z.string()).nullable().optional(),
  /** All transports: environment variables */
  env: z.record(z.string(), z.string()).nullable().optional(),
  /** group: multi-environment backend configuration */
  groupConfig: groupConfigSchema.nullable().optional(),
  /** Whether the server is enabled */
  isEnabled: z.boolean().default(false),
  /** Who may bind/run this MCP on their own Agents. Replaces the old `adminOnly` boolean. */
  usageScope: mcpUsageScopeEnum.default('private'),
  /** Owner user id (null for system built-ins). The web UI reads this to decide whether the current user owns the server — e.g. whether tool probing is offered. */
  userId: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type McpServer = z.infer<typeof mcpServerSchema>

// ============================================================
// Defaults — single source of truth for DB & Zod
// ============================================================

export const MCP_SERVER_DEFAULTS = {
  type: 'stdio' as const,
  isEnabled: false,
} as const

// ============================================================
// CRUD Input Schemas
// ============================================================

export const createMcpServerInput = z.object({
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
  type: mcpServerTypeEnum.default(MCP_SERVER_DEFAULTS.type),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  env: z.record(z.string(), z.string()).nullable().optional(),
  groupConfig: groupConfigSchema.nullable().optional(),
  isEnabled: z.boolean().optional(),
  /** Admin-settable usage scope. Ignored for non-admins; forced 'admin-only' for
   *  stdio-capable servers regardless of the submitted value. */
  usageScope: mcpUsageScopeEnum.optional(),
})

export type CreateMcpServerInput = z.infer<typeof createMcpServerInput>

export const updateMcpServerInput = createMcpServerInput
  .extend({
    type: createMcpServerInput.shape.type.unwrap(),
  })
  .partial()
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerInput>

// ============================================================
// Internal MCP Servers — system built-ins, hidden from users
// ============================================================

/** Built-in MCP names, filtered out of web lists and selectors */
export const INTERNAL_MCP_NAMES: ReadonlySet<string> = new Set(['a2wave-agent-router'])

/** Admin-only MCP names — visible and assignable to administrators only */
export const ADMIN_MCP_NAMES: ReadonlySet<string> = new Set(['a2wave-platform-admin'])
