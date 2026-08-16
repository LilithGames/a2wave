import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import {
  EXAMPLE_AGENT_YAML,
  computeDiff,
  describeDestructiveDiff,
  parseAgentYaml,
  resolveRefs,
  toCreatePayload,
  toPublishPayload,
} from '../lib/agent-yaml.js'
import {
  confirmDestructive,
  forceArgs,
  requireConfirmation,
  resolveForceFlag,
} from '../lib/args.js'
import { emit, jsonArg, redactSecrets } from '../lib/output.js'
import { pageArgs, pageQuery } from '../lib/paginate.js'

interface Agent {
  id: string
  name: string
  description?: string | null
  type: string
  publishStatus: string
  status: string
  createdAt: string
}

interface ArtifactPolicy {
  autoShare: 'off' | 'on'
  shareAccessLevel: 'authenticated' | 'public'
  shareExpiryDays: number
}

interface AgentDetail extends Agent {
  icon?: string
  config?: Record<string, unknown> | null
  skills: string[]
  skillGroupIds?: string[]
  mcpServerIds: string[]
  kbDocumentIds?: string[]
  env?: Record<string, { value: string; sensitive?: boolean }> | null
  workspaceType?: string
  scmSourceId?: string | null
  maxConcurrency?: number
  authMode?: string
  providerId?: string | null
  showLocalChildOutput?: boolean
  showRemoteChildOutput?: boolean
  feishuConfig?: unknown
  scheduleConfig?: unknown
  a2aRouteTargets?: unknown[] | null
  a2aSkills?: Array<{ id: string; name: string }> | null
  systemPrompt?: string
  artifactPolicy?: ArtifactPolicy | null
}

const ARTIFACT_POLICY_DEFAULTS: ArtifactPolicy = {
  autoShare: 'off',
  shareAccessLevel: 'authenticated',
  shareExpiryDays: 7,
}

/**
 * The one part of the freeform `config` the CLI renders by value.
 *
 * `config` is printed as bare key names because it can hold credentials, but
 * that rule also hid the Agent's entire execution plan — which models run, in
 * what order, at which reasoning depth. These four fields are schema-declared
 * (`providerChainItemSchema`) and carry no secret; the credential fields sitting
 * beside them in the same object are never read here.
 */
interface ProviderChainEntryView {
  providerId?: string | null
  model?: string | null
  reasoningEffort?: string | null
  fastMode?: boolean | null
  enabled?: boolean
}

function readProviderChain(config: Record<string, unknown> | null | undefined) {
  const chain = config?.providerChain
  if (!Array.isArray(chain) || chain.length === 0) return null
  return chain as ProviderChainEntryView[]
}

function formatProviderChainEntry(entry: ProviderChainEntryView, index: number): string {
  const parts = [
    `${index + 1}. ${entry.providerId || '(no provider)'}`,
    entry.model ? `model=${entry.model}` : null,
    entry.reasoningEffort ? `effort=${entry.reasoningEffort}` : null,
    // Only an explicit `true` is worth a line: fast mode is off by default, and
    // the level it was requested at is what a reader is scanning for.
    entry.fastMode === true ? 'fastMode=true' : null,
    entry.enabled === false ? '[disabled]' : null,
  ].filter(Boolean)
  return parts.join('  ')
}

const AUTO_SHARE_VALUES = ['off', 'on'] as const
const SHARE_ACCESS_LEVELS = ['authenticated', 'public'] as const

function assertAutoShare(value: unknown): asserts value is (typeof AUTO_SHARE_VALUES)[number] {
  if (
    typeof value !== 'string' ||
    !AUTO_SHARE_VALUES.includes(value as (typeof AUTO_SHARE_VALUES)[number])
  ) {
    throw new CliError(
      `Invalid --auto-share: ${String(value)} (options: ${AUTO_SHARE_VALUES.join(' | ')})`,
    )
  }
}

function assertShareAccessLevel(
  value: unknown,
): asserts value is (typeof SHARE_ACCESS_LEVELS)[number] {
  if (
    typeof value !== 'string' ||
    !SHARE_ACCESS_LEVELS.includes(value as (typeof SHARE_ACCESS_LEVELS)[number])
  ) {
    throw new CliError(
      `Invalid --share-access-level: ${String(value)} (options: ${SHARE_ACCESS_LEVELS.join(' | ')})`,
    )
  }
}

function parseShareExpiryDays(value: unknown): number {
  const days = Number(value)
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new CliError(
      `Invalid --share-expiry-days: ${String(value)} (must be an integer between 1 and 365)`,
    )
  }
  return days
}

interface DiagnoseCheck {
  id: string
  severity: 'error' | 'warn' | 'info'
  message: string
}

interface DiagnoseResult {
  ok: boolean
  meta: { scope: string; checkedAt: string }
  checks: DiagnoseCheck[]
}

interface AgentStats {
  total: number
  successRate: number | string
  avgDuration: number | string
  todayRuns: number
  askerCount: number
  // Backend GET /:id/stats returns byStatus as an object { completed, failed, running, pending, queued, cancelled },
  // not an array; only channelBreakdown is an array.
  byStatus?: Record<string, number>
  channelBreakdown?: Array<{ source: string; count: number }>
}

interface ArtifactRow {
  id: string
  filename: string
  kind: string
  size: number
  createdAt: string
}

interface MemberRow {
  userId: string
  username: string
  displayName: string | null
  email: string | null
  role: string
  isOwner: boolean
  createdAt: string
}

const MEMBER_ROLES = ['viewer', 'editor'] as const

function assertMemberRole(role: unknown): asserts role is (typeof MEMBER_ROLES)[number] {
  if (typeof role !== 'string' || !MEMBER_ROLES.includes(role as (typeof MEMBER_ROLES)[number])) {
    throw new CliError(`Invalid role: ${String(role)} (options: ${MEMBER_ROLES.join(' | ')})`)
  }
}

export const agentsCommand = defineCommand({
  meta: { name: 'agents', description: 'Manage Agents' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List all Agents', agentMeta: { risk: 'read' } },
      args: { ...jsonArg, ...pageArgs, ...urlArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const result = await client.get<{ data: Agent[] }>(`/api/agents?${pageQuery(args, 100)}`)
        if (emit(args, result)) return
        if (result.data.length === 0) {
          console.log('No Agents yet')
          return
        }
        for (const a of result.data) {
          const desc = a.description ? `  ${a.description}` : ''
          console.log(`${a.id}  [${a.publishStatus}]  ${a.name}${desc}`)
        }
      },
    }),

    get: defineCommand({
      meta: {
        name: 'get',
        description: 'Show Agent details (accepts ID or name)',
        agentMeta: { risk: 'read' },
      },
      args: {
        id: { type: 'positional', description: 'Agent ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.id as string)
        const result = await client.get<{ data: AgentDetail }>(`/api/agents/${agentId}`)
        if (emit(args, result)) return
        const a = result.data
        console.log(`ID:            ${a.id}`)
        console.log(`Name:          ${a.name}`)
        if (a.icon) console.log(`Icon:          ${a.icon}`)
        console.log(`Type:          ${a.type}`)
        console.log(`Status:        ${a.status}`)
        console.log(`Publish:       ${a.publishStatus}`)
        console.log(`Description:   ${a.description ?? ''}`)
        console.log(`Skills:        ${a.skills?.join(', ') || 'none'}`)
        if (a.skillGroupIds?.length) console.log(`Skill Groups:  ${a.skillGroupIds.join(', ')}`)
        console.log(`MCP Servers:   ${a.mcpServerIds?.join(', ') || 'none'}`)
        if (a.kbDocumentIds?.length) console.log(`KB Documents:  ${a.kbDocumentIds.join(', ')}`)

        console.log('\n--- Runtime Config ---')
        console.log(`Provider:      ${a.providerId || '(builtin/unspecified)'}`)
        console.log(`Auth Mode:     ${a.authMode ?? 'apiKey'}`)
        const workspace =
          a.workspaceType === 'scm'
            ? `scm${a.scmSourceId ? ` (${a.scmSourceId})` : ''}`
            : (a.workspaceType ?? 'temp')
        console.log(`Workspace:     ${workspace}`)
        console.log(`Max Concurr.:  ${a.maxConcurrency ?? 1}`)
        const providerChain = readProviderChain(a.config)
        // A chain-less Agent keeps its single model here; with a chain, each
        // entry names its own and this line would just repeat the first.
        if (!providerChain && typeof a.config?.model === 'string') {
          console.log(`Model:         ${a.config.model}`)
        }
        if (a.showLocalChildOutput !== undefined || a.showRemoteChildOutput !== undefined) {
          console.log(
            `Child output:  local=${a.showLocalChildOutput ? 'on' : 'off'} remote=${a.showRemoteChildOutput ? 'on' : 'off'}`,
          )
        }

        if (providerChain) {
          console.log('\n--- Provider Chain ---')
          for (const [index, entry] of providerChain.entries()) {
            console.log(formatProviderChainEntry(entry, index))
          }
        }

        if (a.env && Object.keys(a.env).length > 0) {
          console.log('\n--- Environment Variables ---')
          for (const [k, v] of Object.entries(a.env)) {
            // Sensitive variables show a placeholder only; never echo plaintext values
            console.log(`${k} = ${v.sensitive ? '********' : v.value}`)
          }
        }

        if (a.feishuConfig) console.log('\nFeishu channel: configured (feishuConfig)')
        // scheduleConfig is a union(single, array): an object for one entry, an array for multiple.
        const scheduleCount = Array.isArray(a.scheduleConfig)
          ? a.scheduleConfig.length
          : a.scheduleConfig
            ? 1
            : 0
        if (scheduleCount > 0) console.log(`Schedules:     ${scheduleCount} entries`)
        if (a.a2aRouteTargets?.length) console.log(`A2A route targets: ${a.a2aRouteTargets.length}`)
        if (a.a2aSkills?.length) {
          console.log(`A2A outbound skills: ${a.a2aSkills.map((s) => s.name).join(', ')}`)
        }
        if (a.config && Object.keys(a.config).length > 0) {
          // config is freeform and may contain tokens/secrets; list top-level keys only, never values, to avoid leaking plaintext to the terminal/logs.
          console.log(`\nconfig:        configured (keys: ${Object.keys(a.config).join(', ')})`)
        }

        const policy = { ...ARTIFACT_POLICY_DEFAULTS, ...(a.artifactPolicy ?? {}) }
        console.log('\n--- Artifact Policy ---')
        console.log(`Auto share:    ${policy.autoShare === 'on' ? 'enabled' : 'disabled'}`)
        console.log(
          `Access level:  ${policy.shareAccessLevel === 'public' ? 'public' : 'login required'}`,
        )
        console.log(`Share expiry:  ${policy.shareExpiryDays} days`)
        if (a.systemPrompt) {
          console.log('\n--- System Prompt ---')
          console.log(a.systemPrompt)
        }
      },
    }),

    update: defineCommand({
      meta: {
        name: 'update',
        description: 'Update Agent (accepts ID or name)',
        agentMeta: {
          risk: 'write',
          notFor: [
            'A full config change — use `agents apply` with a YAML; a sequence of updates is not equivalent and will not converge',
          ],
          examples: ['a2wave agents update agt_x --add-skill lark-mail'],
        },
      },
      args: {
        id: { type: 'positional', description: 'Agent ID or name', required: true },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        'system-prompt': { type: 'string', description: 'New System Prompt' },
        'add-skill': { type: 'string', description: 'Add a Skill (ID or name)' },
        'remove-skill': { type: 'string', description: 'Remove a Skill (ID or name)' },
        'add-mcp': { type: 'string', description: 'Add an MCP Server (ID or name)' },
        'remove-mcp': { type: 'string', description: 'Remove an MCP Server (ID or name)' },
        'auto-share': { type: 'string', description: 'Artifact auto share: on | off' },
        'share-access-level': {
          type: 'string',
          description: 'Share access level: authenticated (login required) | public',
        },
        'share-expiry-days': { type: 'string', description: 'Share expiry in days (1-365)' },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.id as string)

        const body: Record<string, unknown> = {}
        if (args.name) body.name = args.name as string
        if (args.description) body.description = args.description as string
        if (args['system-prompt']) body.systemPrompt = args['system-prompt'] as string

        const needSkills = args['add-skill'] || args['remove-skill']
        const needMcp = args['add-mcp'] || args['remove-mcp']
        const needPolicy =
          args['auto-share'] !== undefined ||
          args['share-access-level'] !== undefined ||
          args['share-expiry-days'] !== undefined

        if (needSkills || needMcp || needPolicy) {
          const current = await client.get<{ data: AgentDetail }>(`/api/agents/${agentId}`)

          if (needSkills) {
            let skills = [...(current.data.skills || [])]
            if (args['add-skill']) {
              const skillId = await client.resolveSkillId(args['add-skill'] as string)
              if (!skills.includes(skillId)) skills.push(skillId)
            }
            if (args['remove-skill']) {
              const skillId = await client.resolveSkillId(args['remove-skill'] as string)
              skills = skills.filter((s) => s !== skillId)
            }
            body.skills = skills
          }

          if (needMcp) {
            let mcpServerIds = [...(current.data.mcpServerIds || [])]
            if (args['add-mcp']) {
              const mcpId = await client.resolveMcpServerId(args['add-mcp'] as string)
              if (!mcpServerIds.includes(mcpId)) mcpServerIds.push(mcpId)
            }
            if (args['remove-mcp']) {
              const mcpId = await client.resolveMcpServerId(args['remove-mcp'] as string)
              mcpServerIds = mcpServerIds.filter((m) => m !== mcpId)
            }
            body.mcpServerIds = mcpServerIds
          }

          if (needPolicy) {
            // Backend validates artifactPolicy as a whole object (no per-field merge); when changing
            // a single flag, read the current policy first so unspecified fields keep their values
            // instead of resetting to schema defaults.
            const policy: ArtifactPolicy = {
              ...ARTIFACT_POLICY_DEFAULTS,
              ...(current.data.artifactPolicy ?? {}),
            }
            if (args['auto-share'] !== undefined) {
              assertAutoShare(args['auto-share'])
              policy.autoShare = args['auto-share']
            }
            if (args['share-access-level'] !== undefined) {
              assertShareAccessLevel(args['share-access-level'])
              policy.shareAccessLevel = args['share-access-level']
            }
            if (args['share-expiry-days'] !== undefined) {
              policy.shareExpiryDays = parseShareExpiryDays(args['share-expiry-days'])
            }
            body.artifactPolicy = policy
          }
        }

        if (Object.keys(body).length === 0) {
          throw new CliError(
            'Specify at least one field to update: --name, --description, --system-prompt, --add-skill, --remove-skill, --add-mcp, --remove-mcp, --auto-share, --share-access-level, --share-expiry-days',
          )
        }

        await client.patch(`/api/agents/${agentId}`, body)
        console.log('Agent updated ✓')
      },
    }),

    diagnose: defineCommand({
      meta: {
        name: 'diagnose',
        agentMeta: { risk: 'read' },
        description:
          'Full Agent diagnosis (GET /agents/:id/diagnose): engine/Provider/Feishu/gateway, etc.',
      },
      args: {
        id: { type: 'positional', description: 'Agent ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.id as string)
        const result = await client.get<{ data: DiagnoseResult }>(`/api/agents/${agentId}/diagnose`)
        const d = result.data
        // Set the CI-gate exit code BEFORE any early return: emit() bails out
        // straight after printing, so deciding this afterwards would make
        // `diagnose --json | jq` exit 0 on a red diagnosis. Same trap that
        // `runs rerun --wait` and `eval run --wait` already guard against.
        if (!d.ok) process.exitCode = 1
        if (emit(args, result)) return
        const sym = { error: '✗', warn: '!', info: '·' } as const
        console.log(
          `${d.ok ? '✓ ok' : '✗ has errors'}  scope=${d.meta.scope}  at ${d.meta.checkedAt}`,
        )
        console.log('')
        if (d.checks.length === 0) {
          console.log('(no diagnostic checks)')
          return
        }
        for (const c of d.checks) {
          console.log(`${sym[c.severity]} [${c.severity}] ${c.id}: ${c.message}`)
        }
      },
    }),

    export: defineCommand({
      meta: {
        name: 'export',
        description: 'Export Agent config as ZIP (accepts ID or name)',
        agentMeta: { risk: 'read' },
      },
      args: {
        id: { type: 'positional', description: 'Agent ID or name', required: true },
        output: {
          type: 'string',
          alias: 'o',
          description: 'Output file path (default: <agent-name>-export.zip)',
        },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.id as string)

        const res = await client.getRaw(`/api/agents/${agentId}/export`)
        const buffer = Buffer.from(await res.arrayBuffer())

        const disposition = res.headers.get('content-disposition') ?? ''
        const filenameMatch = disposition.match(/filename="?([^"]+)"?/)
        const defaultName = filenameMatch
          ? decodeURIComponent(filenameMatch[1])
          : `${agentId}-export.zip`
        const outputPath = (args.output as string) || defaultName

        writeFileSync(outputPath, buffer)
        console.log(`Exported → ${outputPath} (${(buffer.length / 1024).toFixed(1)}KB)`)
      },
    }),

    import: defineCommand({
      meta: {
        name: 'import',
        description: 'Import Agent from a ZIP file',
        agentMeta: { risk: 'write' },
      },
      args: {
        file: { type: 'positional', description: 'ZIP file path', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const filePath = args.file as string
        let buffer: Buffer
        try {
          buffer = readFileSync(filePath)
        } catch {
          throw new CliError(`Cannot read file: ${filePath}`)
        }

        const client = createClient({ url: args.url as string | undefined })
        const formData = new FormData()
        formData.append(
          'file',
          new Blob([buffer], { type: 'application/zip' }),
          filePath.split('/').pop() ?? 'import.zip',
        )

        const result = await client.postFormData<{
          data: {
            agent: { id: string; name: string }
            mcpServers: Array<{ name: string }>
            skills: Array<{ name: string }>
            warnings: string[]
          }
        }>('/api/agents/import', formData)
        const d = result.data
        console.log('Imported ✓')
        console.log(`  Agent: ${d.agent.name} (${d.agent.id})`)
        if (d.mcpServers.length > 0)
          console.log(`  MCP Servers: ${d.mcpServers.map((m) => m.name).join(', ')}`)
        if (d.skills.length > 0) console.log(`  Skills: ${d.skills.map((s) => s.name).join(', ')}`)
        if (d.warnings.length > 0) {
          console.log('\nWarnings:')
          for (const w of d.warnings) console.log(`  - ${w}`)
        }
      },
    }),

    apply: defineCommand({
      meta: {
        name: 'apply',
        agentMeta: {
          risk: 'write',
          preconditions: [
            'Every name the YAML references (provider, skills, mcpServers, kbDocuments, workspace.source) already exists — apply resolves names to IDs and fails on an unknown one',
            'Any ${ENV} placeholder in the YAML is exported in the calling shell',
          ],
          notFor: [
            'Changing one field — `agents update` is one request against one field',
            'Deleting an Agent; apply never removes one',
          ],
          examples: [
            'a2wave agents apply -f bot.yaml --dry-run',
            'a2wave agents apply --example > bot.yaml',
          ],
        },
        description:
          'YAML-driven idempotent apply (looked up by name; --example shows the full example yaml)',
      },
      args: {
        file: {
          type: 'string',
          alias: 'f',
          description: 'YAML file path (mutually exclusive with --example)',
        },
        example: {
          type: 'boolean',
          description: 'Print the full example YAML to stdout and exit (redirect: > my-bot.yaml)',
        },
        'dry-run': {
          type: 'boolean',
          description: 'Only print the changes that would be made; no write API calls',
        },
        // Declared as `publish` (default true), NOT `no-publish`: citty parses a
        // `--no-X` flag as negation of `X`, so `--no-publish` sets
        // `args.publish = false` and never populates `args['no-publish']`.
        // Declaring it the other way round makes the flag silently do nothing.
        publish: {
          type: 'boolean',
          default: true,
          description: 'Apply the publish block in the yaml. Use --no-publish to stay in draft',
        },
        // Only consulted when the diff actually removes something; an additive
        // apply never asks, so this flag is inert on the common path.
        ...forceArgs,
        ...urlArg,
      },
      run: async ({ args }) => {
        if (args.example) {
          process.stdout.write(EXAMPLE_AGENT_YAML)
          return
        }

        const filePath = args.file as string | undefined
        if (!filePath) {
          throw new CliError(
            'Specify a file with -f <yaml-file>, or use --example to see the example yaml',
          )
        }
        const dryRun = !!args['dry-run']
        const noPublish = args.publish === false

        const yaml = parseAgentYaml(filePath)
        const client = createClient({ url: args.url as string | undefined })
        const refs = await resolveRefs(client, yaml)
        const payload = toCreatePayload(yaml, refs)
        const publishBody = noPublish ? null : toPublishPayload(yaml)

        const existing = await client.findAgentByName(yaml.name)

        if (!existing) {
          if (dryRun) {
            console.log(`[dry-run] Would CREATE agent "${yaml.name}"`)
            console.log(JSON.stringify(redactSecrets(payload), null, 2))
            if (publishBody)
              console.log(
                `[dry-run] Would PUBLISH (channels: ${(publishBody.channels as string[] | undefined)?.join(', ') ?? 'default'})`,
              )
            return
          }
          const created = await client.post<{ data: { id: string } }>('/api/agents', payload)
          console.log(`Created ${created.data.id} (${yaml.name})`)
          if (publishBody) {
            await client.post(`/api/agents/${created.data.id}/publish`, publishBody)
            console.log(
              `Published ${created.data.id} (channels: ${(publishBody.channels as string[] | undefined)?.join(', ') ?? 'default'})`,
            )
          }
          return
        }

        const current = await client.get<{ data: Record<string, unknown> }>(
          `/api/agents/${existing.id}`,
        )
        const diff = computeDiff(current.data, payload)
        if (Object.keys(diff).length === 0) {
          console.log(`Unchanged ${existing.id} (${yaml.name})`)
        } else {
          if (dryRun) {
            console.log(
              `[dry-run] Would UPDATE ${existing.id} — fields: ${Object.keys(diff).join(', ')}`,
            )
            console.log(JSON.stringify(redactSecrets(diff), null, 2))
          } else {
            // Apply is `write` in general, but a diff that UNMOUNTS something is
            // the one shape a caller cannot undo from the YAML in hand — the
            // thing removed is exactly what the new YAML no longer names. Only
            // that subset is gated; labelling every apply high-risk would teach
            // callers to pass --yes always and cost the protection here.
            const destructive = describeDestructiveDiff(current.data, diff)
            if (destructive.length > 0) {
              await requireConfirmation(
                'high-risk-write',
                `This apply removes configuration from ${existing.id} (${yaml.name}):\n${destructive
                  .map((line) => `  - ${line}`)
                  .join('\n')}`,
                resolveForceFlag(args),
              )
            }
            await client.patch(`/api/agents/${existing.id}`, diff)
            console.log(
              `Updated ${existing.id} (${yaml.name}) — fields: ${Object.keys(diff).join(', ')}`,
            )
          }
        }
        if (publishBody && !dryRun) {
          await client.post(`/api/agents/${existing.id}/publish`, publishBody)
          console.log(
            `Published ${existing.id} (channels: ${(publishBody.channels as string[] | undefined)?.join(', ') ?? 'default'})`,
          )
        }
      },
    }),

    publish: defineCommand({
      meta: {
        name: 'publish',
        description: 'Publish Agent (POST /agents/:id/publish)',
        agentMeta: { risk: 'write' },
      },
      args: {
        id: { type: 'positional', description: 'Agent ID or name', required: true },
        channels: {
          type: 'string',
          description: 'Comma-separated channel list, e.g. api,feishu (default api)',
        },
        'auth-type': { type: 'string', description: 'Auth type: none | api_key (default api_key)' },
        description: {
          type: 'string',
          description: 'Publish description (written to the public API docs)',
        },
        'regenerate-api-key': {
          type: 'boolean',
          description: 'Also regenerate endpointApiKey (rotate)',
        },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.id as string)

        const body: Record<string, unknown> = {}
        if (args.channels)
          body.channels = (args.channels as string)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        if (args['auth-type']) body.authType = args['auth-type']
        if (args.description) body.description = args.description
        if (args['regenerate-api-key']) body.regenerateApiKey = true

        await client.post(`/api/agents/${agentId}/publish`, body)
        console.log(`Published ${agentId}`)
      },
    }),

    stop: defineCommand({
      meta: {
        name: 'stop',
        description: 'Stop a published Agent (POST /agents/:id/stop)',
        agentMeta: { risk: 'write' },
      },
      args: {
        id: { type: 'positional', description: 'Agent ID or name', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.id as string)
        await client.post(`/api/agents/${agentId}/stop`, {})
        console.log(`Stopped ${agentId}`)
      },
    }),

    resume: defineCommand({
      meta: {
        name: 'resume',
        description: 'Resume a stopped Agent (POST /agents/:id/resume)',
        agentMeta: { risk: 'write' },
      },
      args: {
        id: { type: 'positional', description: 'Agent ID or name', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.id as string)
        await client.post(`/api/agents/${agentId}/resume`, {})
        console.log(`Resumed ${agentId}`)
      },
    }),

    clone: defineCommand({
      meta: {
        name: 'clone',
        agentMeta: { risk: 'write' },
        description:
          'Clone Agent (POST /agents/:id/clone); new agent is named "<original> (Copy)" with draft status',
      },
      args: {
        id: { type: 'positional', description: 'Source Agent ID or name', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const sourceId = await client.resolveAgentId(args.id as string)
        const result = await client.post<{ data: { id: string; name: string } }>(
          `/api/agents/${sourceId}/clone`,
          {},
        )
        console.log(`Cloned ${sourceId} → ${result.data.id} (${result.data.name})`)
      },
    }),

    'regenerate-api-key': defineCommand({
      meta: {
        name: 'regenerate-api-key',
        agentMeta: { risk: 'write' },
        description:
          'Regenerate the Agent endpointApiKey (POST /agents/:id/regenerate-api-key). Note: the old key becomes invalid immediately.',
      },
      args: {
        id: { type: 'positional', description: 'Agent ID or name', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.id as string)
        const result = await client.post<{ data: { endpointApiKey: string } }>(
          `/api/agents/${agentId}/regenerate-api-key`,
          {},
        )
        console.log(`Regenerated key for ${agentId}:`)
        console.log(`  endpointApiKey: ${result.data.endpointApiKey}`)
        console.log('(Store it safely; the old key is now invalid)')
      },
    }),

    members: defineCommand({
      meta: { name: 'members', description: 'Manage Agent members' },
      subCommands: {
        list: defineCommand({
          meta: {
            name: 'list',
            description: 'List all Agent members (including owner)',
            agentMeta: { risk: 'read' },
          },
          args: {
            agent: { type: 'positional', description: 'Agent ID or name', required: true },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const result = await client.get<{ data: MemberRow[] }>(`/api/agents/${agentId}/members`)
            if (emit(args, result)) return
            const rows = result.data
            if (rows.length === 0) {
              console.log('No members yet')
              return
            }
            console.log('userId  [role]  username  email')
            for (const r of rows) {
              const marker = r.isOwner ? '*' : ' '
              console.log(`${marker} ${r.userId}  [${r.role}]  ${r.username}  ${r.email ?? ''}`)
            }
          },
        }),

        add: defineCommand({
          meta: {
            name: 'add',
            description: 'Add a member to the Agent',
            agentMeta: { risk: 'write' },
          },
          args: {
            agent: { type: 'positional', description: 'Agent ID or name', required: true },
            user: {
              type: 'string',
              description: 'User ID (usr_xxx) / username / email',
              required: true,
            },
            role: { type: 'string', description: 'Role: viewer | editor', required: true },
            ...urlArg,
          },
          run: async ({ args }) => {
            assertMemberRole(args.role)
            const role = args.role
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const userId = await client.resolveUserId(args.user as string)
            const result = await client.post<{ data: MemberRow }>(
              `/api/agents/${agentId}/members`,
              { userId, role },
            )
            console.log(`Added ${result.data.username} as ${result.data.role}`)
          },
        }),

        update: defineCommand({
          meta: {
            name: 'update',
            description: 'Update an Agent member role',
            agentMeta: { risk: 'write' },
          },
          args: {
            agent: { type: 'positional', description: 'Agent ID or name', required: true },
            user: {
              type: 'string',
              description: 'User ID (usr_xxx) / username / email',
              required: true,
            },
            role: { type: 'string', description: 'Role: viewer | editor', required: true },
            ...urlArg,
          },
          run: async ({ args }) => {
            assertMemberRole(args.role)
            const role = args.role
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const userId = await client.resolveUserId(args.user as string)
            const result = await client.patch<{ data: MemberRow }>(
              `/api/agents/${agentId}/members/${userId}`,
              { role },
            )
            console.log(`Updated ${result.data.username} to ${result.data.role}`)
          },
        }),

        remove: defineCommand({
          meta: {
            name: 'remove',
            description: 'Remove an Agent member',
            agentMeta: { risk: 'write' },
          },
          args: {
            agent: { type: 'positional', description: 'Agent ID or name', required: true },
            user: {
              type: 'string',
              description: 'User ID (usr_xxx) / username / email',
              required: true,
            },
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const userId = await client.resolveUserId(args.user as string)
            await client.del<{ data: { removed: true; userId: string } }>(
              `/api/agents/${agentId}/members/${userId}`,
            )
            console.log(`Removed ${userId}`)
          },
        }),
      },
    }),

    delete: defineCommand({
      meta: {
        name: 'delete',
        agentMeta: { risk: 'high-risk-write' },
        description:
          'Delete Agent (irreversible; accepts ID or name; asks for confirmation by default)',
      },
      args: {
        id: { type: 'positional', description: 'Agent ID or name', required: true },
        force: { type: 'boolean', description: 'Skip confirmation (for scripts/CI)' },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        // Resolve first (duplicate names error out instead of deleting the first match), then confirm — so the user sees the resolved ID.
        const agentId = await client.resolveAgentId(args.id as string)
        await confirmDestructive(
          `This will permanently delete Agent ${agentId} (${args.id}). This action is irreversible.`,
          args.force as boolean,
        )
        await client.del(`/api/agents/${agentId}`)
        console.log('Agent deleted ✓')
      },
    }),

    stats: defineCommand({
      meta: {
        name: 'stats',
        agentMeta: { risk: 'read' },
        description: 'Agent overview stats (KPI / asker count / channel breakdown)',
      },
      args: {
        id: { type: 'positional', description: 'Agent ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.id as string)
        // Note: /stats returns the stats object directly, not wrapped in { data }
        const s = await client.get<AgentStats>(`/api/agents/${agentId}/stats`)
        if (emit(args, s)) return
        console.log(`Total runs:    ${s.total}`)
        console.log(`Success rate:  ${s.successRate}`)
        console.log(`Avg duration:  ${s.avgDuration}`)
        console.log(`Today runs:    ${s.todayRuns}`)
        console.log(`Askers:        ${s.askerCount}`)
        const statusEntries = Object.entries(s.byStatus ?? {})
        if (statusEntries.length > 0) {
          console.log('By status:')
          for (const [status, cnt] of statusEntries) console.log(`  ${status}: ${cnt}`)
        }
        if (s.channelBreakdown?.length) {
          console.log('By channel:')
          for (const c of s.channelBreakdown) console.log(`  ${c.source}: ${c.count}`)
        }
      },
    }),

    artifacts: defineCommand({
      meta: { name: 'artifacts', description: 'Manage Agent artifacts' },
      subCommands: {
        list: defineCommand({
          meta: { name: 'list', description: 'List Agent artifacts', agentMeta: { risk: 'read' } },
          args: {
            agent: { type: 'positional', description: 'Agent ID or name', required: true },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const { data } = await client.get<{ data: ArtifactRow[] }>(
              `/api/artifacts?agentId=${agentId}`,
            )
            if (emit(args, { data })) return
            if (data.length === 0) {
              console.log('No artifacts yet')
              return
            }
            for (const a of data) {
              console.log(`${a.id}  [${a.kind}]  ${a.filename}  ${a.size}B  ${a.createdAt}`)
            }
          },
        }),

        download: defineCommand({
          meta: {
            name: 'download',
            description: 'Download a single artifact',
            agentMeta: { risk: 'read' },
          },
          args: {
            id: { type: 'positional', description: 'Artifact ID (art_xxx)', required: true },
            out: {
              type: 'string',
              description:
                'Output path (defaults to the response filename, written to the current directory)',
            },
            force: { type: 'boolean', description: 'Overwrite the target file if it exists' },
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const artifactId = args.id as string
            const res = await client.getRaw(`/api/artifacts/${artifactId}/download`)
            let outPath = args.out as string | undefined
            if (!outPath) {
              // The server Content-Disposition filename is untrusted: it may contain ../, absolute paths,
              // or clash with a local file. Take only the basename into the current directory to
              // prevent writing outside it; fall back to artifactId if parsing fails.
              const disp = res.headers.get('content-disposition') ?? ''
              const m =
                disp.match(/filename\*=UTF-8''([^;]+)/) ?? disp.match(/filename="?([^";]+)"?/)
              const rawName = m ? decodeURIComponent(m[1]) : artifactId
              // basename strips path separators; also guard against degenerate names like '' / '.' / '..' to avoid writing to a directory.
              const safeName = basename(rawName)
              outPath = !safeName || safeName === '.' || safeName === '..' ? artifactId : safeName
            }
            // Silent overwrite loses data; explicit --out is protected too. Require --force when the target exists.
            if (existsSync(outPath) && !args.force) {
              throw new CliError(
                `Target file already exists: ${outPath} (use --force to overwrite)`,
              )
            }
            const buf = Buffer.from(await res.arrayBuffer())
            writeFileSync(outPath, buf)
            console.log(`Artifact saved to ${outPath} ✓ (${buf.length} bytes)`)
          },
        }),

        delete: defineCommand({
          meta: {
            name: 'delete',
            description: 'Delete a single artifact',
            agentMeta: { risk: 'high-risk-write' },
          },
          args: {
            id: { type: 'positional', description: 'Artifact ID (art_xxx)', required: true },
            ...forceArgs,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            await requireConfirmation(
              'high-risk-write',
              `This will permanently delete artifact ${args.id as string}. This action is irreversible.`,
              resolveForceFlag(args),
            )
            await client.del(`/api/artifacts/${args.id as string}`)
            console.log('Artifact deleted ✓')
          },
        }),
      },
    }),

    memory: defineCommand({
      meta: { name: 'memory', description: 'Manage Agent memory' },
      subCommands: {
        stats: defineCommand({
          meta: { name: 'stats', description: 'Memory stats', agentMeta: { risk: 'read' } },
          args: {
            agent: { type: 'positional', description: 'Agent ID or name', required: true },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const { data } = await client.get<{ data: unknown }>(`/api/memories/${agentId}/stats`)
            if (emit(args, data)) return
            console.log(JSON.stringify(redactSecrets(data), null, 2))
          },
        }),

        search: defineCommand({
          meta: { name: 'search', description: 'Search memories', agentMeta: { risk: 'read' } },
          args: {
            agent: { type: 'positional', description: 'Agent ID or name', required: true },
            query: { type: 'string', description: 'Search query', required: true },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const q = encodeURIComponent(args.query as string)
            const { data } = await client.get<{ data: { results: unknown[] } }>(
              `/api/memories/${agentId}/search?q=${q}`,
            )
            if (emit(args, data.results)) return
            console.log(JSON.stringify(redactSecrets(data.results), null, 2))
          },
        }),

        reindex: defineCommand({
          meta: {
            name: 'reindex',
            description: 'Rebuild the memory index',
            agentMeta: { risk: 'write' },
          },
          args: {
            agent: { type: 'positional', description: 'Agent ID or name', required: true },
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            await client.post(`/api/memories/${agentId}/reindex`, {})
            console.log('Memory index rebuilt ✓')
          },
        }),

        consolidate: defineCommand({
          meta: {
            name: 'consolidate',
            description: 'Consolidate / merge memories',
            agentMeta: { risk: 'write' },
          },
          args: {
            agent: { type: 'positional', description: 'Agent ID or name', required: true },
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            await client.post(`/api/memories/${agentId}/consolidate`, {})
            console.log('Memory consolidation triggered ✓')
          },
        }),
      },
    }),

    'import-url': defineCommand({
      meta: {
        name: 'import-url',
        description: 'Import Agent from a remote a2wave instance URL',
        agentMeta: { risk: 'write' },
      },
      args: {
        source: {
          type: 'positional',
          description: 'Remote Agent export URL (import source)',
          required: true,
        },
        header: { type: 'string', description: 'Custom request header (format: "Key: Value")' },
        ...urlArg,
      },
      run: async ({ args }) => {
        const sourceUrl = args.source as string
        const customHeaders: Record<string, string> = {}
        if (args.header) {
          const headerStr = args.header as string
          const colonIdx = headerStr.indexOf(':')
          if (colonIdx > 0) {
            customHeaders[headerStr.slice(0, colonIdx).trim()] = headerStr
              .slice(colonIdx + 1)
              .trim()
          }
        }

        const client = createClient({ url: args.url as string | undefined })
        const result = await client.post<{
          data: {
            agent: { id: string; name: string }
            mcpServers: Array<{ name: string }>
            skills: Array<{ name: string }>
            warnings: string[]
          }
        }>('/api/agents/import-url', {
          url: sourceUrl,
          headers: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
        })

        const d = result.data
        console.log('Imported ✓')
        console.log(`  Agent: ${d.agent.name} (${d.agent.id})`)
        if (d.mcpServers.length > 0)
          console.log(`  MCP Servers: ${d.mcpServers.map((m) => m.name).join(', ')}`)
        if (d.skills.length > 0) console.log(`  Skills: ${d.skills.map((s) => s.name).join(', ')}`)
        if (d.warnings.length > 0) {
          console.log('\nWarnings:')
          for (const w of d.warnings) console.log(`  - ${w}`)
        }
      },
    }),
  },
})
