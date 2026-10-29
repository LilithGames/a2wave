import { Tooltip } from 'antd'
import { AlertTriangle } from 'lucide-react'
import { z } from 'zod'
import i18n from '@/i18n'

export const namePattern = /^[a-zA-Z0-9_-]+$/

export type ProbeResult = { tools?: { name: string; description?: string }[]; error?: string }

/** Shared probe result display: error message and/or tool tags with tooltips */
export function ProbeResultDisplay({ result }: { result: ProbeResult | null }) {
  if (!result) return null
  return (
    <>
      {result.error && (
        <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {result.error}
        </div>
      )}
      {result.tools && result.tools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {result.tools.map((tool) => (
            <Tooltip key={tool.name} title={tool.description} placement="top">
              <span className="inline-flex items-center rounded border border-border/60 bg-muted/30 px-1 py-px font-mono text-2xs leading-tight cursor-default hover:bg-surface-hover transition-colors">
                {tool.name}
              </span>
            </Tooltip>
          ))}
        </div>
      )}
    </>
  )
}

const formGroupBackendSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('inline'),
    name: z.string().min(1).max(50).regex(namePattern),
    type: z.enum(['stdio', 'sse', 'http']),
    command: z.string().nullable().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    headers: z.record(z.string(), z.string()).nullable().optional(),
    env: z.record(z.string(), z.string()).nullable().optional(),
  }),
  z.object({
    mode: z.literal('ref'),
    mcpServerId: z.string().min(1),
  }),
])

const formGroupConfigSchema = z.object({
  backends: z.record(z.string(), z.array(formGroupBackendSchema)),
})

/** Built per language so eagerly-evaluated zod messages follow the active locale. */
export const createMcpServerFormSchema = (lng: string) =>
  z
    .object({
      name: z.string().min(1, i18n.t('mcpServerDetail.nameRequired', { lng })).max(100),
      description: z.string(),
      type: z.enum(['stdio', 'sse', 'http', 'group']),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      url: z.string(),
      headers: z.record(z.string(), z.string()),
      env: z.record(z.string(), z.string()),
      groupConfig: formGroupConfigSchema.optional(),
      isEnabled: z.boolean(),
      usageScope: z.enum(['private', 'admin-only', 'all-users']),
    })
    .superRefine((data, ctx) => {
      if (data.type === 'stdio' && !data.command.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: i18n.t('mcpServerDetail.commandRequired'),
          path: ['command'],
        })
      }
      if ((data.type === 'sse' || data.type === 'http') && !data.url.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: i18n.t('mcpServerDetail.urlRequired'),
          path: ['url'],
        })
      }
      if (data.type === 'group') {
        if (!data.groupConfig || Object.keys(data.groupConfig.backends).length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: i18n.t('mcpServerDetail.groupKeyRequired'),
            path: ['groupConfig'],
          })
          return
        }
        // Validate each backend
        for (const [groupKey, backends] of Object.entries(data.groupConfig.backends)) {
          if (backends.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: i18n.t('mcpServerDetail.groupNeedsBackend', { key: groupKey }),
              path: ['groupConfig'],
            })
          }
          const inlineNames: string[] = []
          for (let i = 0; i < backends.length; i++) {
            const b = backends[i]
            if (b.mode === 'inline') {
              if (!b.name?.trim()) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: 'Backend name is required',
                  path: ['groupConfig', 'backends', groupKey, i, 'name'],
                })
              } else if (!namePattern.test(b.name)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: 'Backend name can only contain letters, digits, hyphens, underscores',
                  path: ['groupConfig', 'backends', groupKey, i, 'name'],
                })
              } else if (inlineNames.includes(b.name)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `Duplicate backend name "${b.name}"`,
                  path: ['groupConfig', 'backends', groupKey, i, 'name'],
                })
              } else {
                inlineNames.push(b.name)
              }
              if (b.type === 'stdio' && !b.command?.trim()) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: 'Command is required for stdio backend',
                  path: ['groupConfig', 'backends', groupKey, i, 'command'],
                })
              }
              if ((b.type === 'sse' || b.type === 'http') && !b.url?.trim()) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `URL is required for ${b.type} backend`,
                  path: ['groupConfig', 'backends', groupKey, i, 'url'],
                })
              }
            } else if (b.mode === 'ref') {
              if (!b.mcpServerId?.trim()) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: 'MCP Server selection is required',
                  path: ['groupConfig', 'backends', groupKey, i, 'mcpServerId'],
                })
              }
            }
          }
        }
      }
    })

export type McpFormData = z.infer<ReturnType<typeof createMcpServerFormSchema>>

/**
 * True when a server would introduce stdio execution (top-level stdio, or a group
 * with any inline stdio backend). Mirrors the backend `introducesStdioExecution`
 * so the scope control's forced-admin-only rule matches what the server persists.
 */
export function introducesStdio(
  type: string | undefined,
  groupConfig: { backends?: Record<string, Array<{ mode?: string; type?: string }>> } | null,
): boolean {
  if (type === 'stdio') return true
  if (type === 'group' && groupConfig?.backends) {
    return Object.values(groupConfig.backends).some((backends) =>
      backends.some((b) => b.mode === 'inline' && b.type === 'stdio'),
    )
  }
  return false
}

export const isSensitiveEnvKey = (key: string) =>
  /token|key|secret|password|credential|auth|api[-_]?key/i.test(key)
