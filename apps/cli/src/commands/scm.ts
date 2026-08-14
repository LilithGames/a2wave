import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { confirmDestructive, parseIntFlag, readJsonFile } from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'

interface Workspace {
  name: string
  path: string
  /** Branch lives per sub-repo — a workspace can hold several (multi-repo mode). */
  repos?: Array<{ directory: string; branch: string | null; error?: string }>
  cleanup?: string | null
  lastRunId?: string | null
  occupied?: boolean
}

/** Render the branches of a workspace: "main", or "web=main, api=dev" for multi-repo. */
function formatBranches(w: Workspace): string {
  const repos = w.repos ?? []
  if (repos.length === 0) return ''
  if (repos.length === 1) return repos[0].branch ?? 'detached'
  return repos.map((r) => `${r.directory || '.'}=${r.branch ?? 'detached'}`).join(', ')
}

interface ScmSource {
  id: string
  name: string
  description?: string | null
  type: 'git' | 'p4'
  localPath: string
  isEnabled: boolean
  syncStatus?: string | null
  lastSyncAt?: string | null
  lastSyncError?: string | null
  createdAt: string
  updatedAt: string
}

/** Builds config per git/p4 type; --config-file provides the full body as a fallback. */
function buildCreateBody(args: Record<string, unknown>): Record<string, unknown> {
  if (args['config-file']) {
    return readJsonFile(args['config-file'] as string)
  }

  const type = args.type as string | undefined
  if (type !== 'git' && type !== 'p4') {
    throw new CliError(
      'Creating an SCM source requires --type git | p4 (use --config-file for complex structures)',
    )
  }
  if (!args.name) throw new CliError('Creating an SCM source requires --name')

  const config: Record<string, unknown> = { type }
  if (type === 'git') {
    if (!args['repo-url']) throw new CliError('A git SCM source requires --repo-url')
    config.repoUrl = args['repo-url'] as string
    if (args.branch) config.branch = args.branch as string
    if (args.username) config.username = args.username as string
    if (args.pat) config.pat = args.pat as string
  } else {
    if (!args['local-path']) {
      throw new CliError('Creating a p4 SCM source requires --local-path (absolute path)')
    }
    if (!args.p4port || !args.p4user || !args.p4client) {
      throw new CliError('A p4 SCM source requires --p4port --p4user --p4client')
    }
    config.p4port = args.p4port as string
    config.p4user = args.p4user as string
    config.p4client = args.p4client as string
    if (args.p4passwd) config.p4passwd = args.p4passwd as string
    if (args['depot-path']) config.depotPath = args['depot-path'] as string
  }
  if (args['auto-sync'] !== undefined) config.autoSync = args['auto-sync'] as boolean
  if (args['sync-interval'] !== undefined)
    config.syncIntervalMin = parseIntFlag(args['sync-interval'], 'sync-interval', { min: 1 })

  const body: Record<string, unknown> = {
    name: args.name as string,
    type,
    config,
  }
  if (args['local-path']) body.localPath = args['local-path'] as string
  if (args.description) body.description = args.description as string
  if (args['workspaces-path']) body.workspacesPath = args['workspaces-path'] as string
  if (args.enabled !== undefined) body.isEnabled = args.enabled as boolean
  return body
}

const createArgs = {
  name: { type: 'string' as const, description: 'SCM source name' },
  type: { type: 'string' as const, description: 'Type: git | p4' },
  description: { type: 'string' as const, description: 'Description' },
  'local-path': {
    type: 'string' as const,
    description: 'Absolute local storage path (optional for managed Git; required for P4)',
  },
  'workspaces-path': {
    type: 'string' as const,
    description: 'Root directory for worktrees/workspaces',
  },
  'repo-url': { type: 'string' as const, description: 'git: repository URL' },
  branch: { type: 'string' as const, description: 'git: branch (default main)' },
  username: { type: 'string' as const, description: 'git: username' },
  pat: { type: 'string' as const, description: 'git: personal access token' },
  p4port: { type: 'string' as const, description: 'p4: P4PORT' },
  p4user: { type: 'string' as const, description: 'p4: P4USER' },
  p4passwd: { type: 'string' as const, description: 'p4: P4PASSWD' },
  p4client: { type: 'string' as const, description: 'p4: P4CLIENT' },
  'depot-path': { type: 'string' as const, description: 'p4: depot path' },
  'auto-sync': { type: 'boolean' as const, description: 'Enable auto sync' },
  'sync-interval': { type: 'string' as const, description: 'Sync interval (minutes)' },
  enabled: { type: 'boolean' as const, description: 'Enable or disable' },
  'config-file': {
    type: 'string' as const,
    description: 'Read the full body from a JSON file (fallback for multi-repo etc.)',
  },
}

export const scmCommand = defineCommand({
  meta: { description: 'Manage SCM sources' },
  subCommands: {
    list: defineCommand({
      meta: { description: 'List all SCM sources' },
      args: { ...jsonArg, ...urlArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const result = await client.get<{ data: ScmSource[] }>('/api/scm-sources?pageSize=100')
        if (emit(args, result)) return
        if (result.data.length === 0) {
          console.log('No SCM sources')
          return
        }
        for (const s of result.data) {
          const sync = s.syncStatus ? `  sync=${s.syncStatus}` : ''
          console.log(
            `${s.id}  [${s.type}]  ${s.name}  ${s.isEnabled ? 'enabled' : 'disabled'}${sync}`,
          )
        }
      },
    }),

    get: defineCommand({
      meta: { description: 'Show SCM source details (ID or name)' },
      args: {
        id: { type: 'positional', description: 'SCM source ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveScmSourceId(args.id as string)
        const res = await client.get<{ data: ScmSource }>(`/api/scm-sources/${id}`)
        if (emit(args, res)) return
        const s = res.data
        console.log(`ID:          ${s.id}`)
        console.log(`Name:        ${s.name}`)
        console.log(`Type:        ${s.type}`)
        console.log(`Enabled:     ${s.isEnabled}`)
        console.log(`LocalPath:   ${s.localPath}`)
        if (s.syncStatus) console.log(`SyncStatus:  ${s.syncStatus}`)
        if (s.lastSyncAt) console.log(`LastSyncAt:  ${s.lastSyncAt}`)
        if (s.lastSyncError) console.log(`LastError:   ${s.lastSyncError}`)
        if (s.description) console.log(`Description: ${s.description}`)
        console.log(`Updated:     ${s.updatedAt}`)
      },
    }),

    create: defineCommand({
      meta: { description: 'Create an SCM source (--type git | p4)' },
      args: { ...createArgs, ...urlArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const body = buildCreateBody(args)
        const { data } = await client.post<{ data: ScmSource }>('/api/scm-sources', body)
        console.log(`SCM source created ✓  ${data.id}  ${data.name}`)
      },
    }),

    update: defineCommand({
      meta: { description: 'Update an SCM source (excludes type; ID or name)' },
      args: {
        id: { type: 'positional', description: 'SCM source ID or name', required: true },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        'local-path': { type: 'string', description: 'Absolute local storage path' },
        'workspaces-path': { type: 'string', description: 'Worktree root directory' },
        enabled: { type: 'boolean', description: 'Enable or disable' },
        'config-file': { type: 'string', description: 'Read the full patch body from a JSON file' },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveScmSourceId(args.id as string)
        let body: Record<string, unknown>
        if (args['config-file']) {
          body = readJsonFile(args['config-file'] as string)
        } else {
          body = {}
          if (args.name) body.name = args.name as string
          if (args.description) body.description = args.description as string
          if (args['local-path']) body.localPath = args['local-path'] as string
          if (args['workspaces-path']) body.workspacesPath = args['workspaces-path'] as string
          if (args.enabled !== undefined) body.isEnabled = args.enabled as boolean
          if (Object.keys(body).length === 0) {
            throw new CliError(
              'Specify at least one field to update (use --config-file for complex config)',
            )
          }
        }
        await client.patch(`/api/scm-sources/${id}`, body)
        console.log('SCM source updated ✓')
      },
    }),

    delete: defineCommand({
      meta: { description: 'Delete an SCM source (409 if referenced by an agent)' },
      args: {
        id: { type: 'positional', description: 'SCM source ID or name', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveScmSourceId(args.id as string)
        await client.del(`/api/scm-sources/${id}`)
        console.log('SCM source deleted ✓')
      },
    }),

    sync: defineCommand({
      meta: { description: 'Trigger a background sync (async, 202)' },
      args: {
        id: { type: 'positional', description: 'SCM source ID or name', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveScmSourceId(args.id as string)
        await client.post(`/api/scm-sources/${id}/sync`, {})
        console.log('Sync triggered ✓ (runs in background; use scm status to check progress)')
      },
    }),

    check: defineCommand({
      meta: { description: 'Check SCM source connectivity' },
      args: {
        id: { type: 'positional', description: 'SCM source ID or name', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveScmSourceId(args.id as string)
        const { data } = await client.post<{ data: { ok?: boolean; message?: string } }>(
          `/api/scm-sources/${id}/check`,
          {},
        )
        console.log(JSON.stringify(data, null, 2))
      },
    }),

    status: defineCommand({
      meta: { description: 'Show sync and CodeGraph status snapshot' },
      args: {
        id: { type: 'positional', description: 'SCM source ID or name', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveScmSourceId(args.id as string)
        const { data } = await client.get<{ data: unknown }>(`/api/scm-sources/${id}/status`)
        console.log(JSON.stringify(data, null, 2))
      },
    }),

    workspaces: defineCommand({
      meta: { description: 'Manage the worktrees of an SCM source' },
      subCommands: {
        list: defineCommand({
          meta: { description: 'List worktrees (with occupied status)' },
          args: {
            id: { type: 'positional', description: 'SCM source ID or name', required: true },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const id = await client.resolveScmSourceId(args.id as string)
            const result = await client.get<{ data: Workspace[] }>(
              `/api/scm-sources/${id}/workspaces`,
            )
            if (emit(args, result)) return
            if (result.data.length === 0) {
              console.log('No worktrees')
              return
            }
            for (const w of result.data) {
              const flags = [w.occupied ? 'occupied' : 'free', formatBranches(w)]
                .filter(Boolean)
                .join('  ')
              console.log(`${w.name.padEnd(28)}  ${flags}\n  ${w.path}`)
            }
          },
        }),

        remove: defineCommand({
          meta: { description: 'Delete a worktree (409 when occupied by a run)' },
          args: {
            id: { type: 'positional', description: 'SCM source ID or name', required: true },
            name: { type: 'positional', description: 'Worktree name', required: true },
            force: { type: 'boolean', description: 'Skip confirmation (for scripts/CI)' },
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const id = await client.resolveScmSourceId(args.id as string)
            await confirmDestructive(
              `Delete worktree "${args.name}" of ${id} (irreversible).`,
              args.force === true,
            )
            await client.del(
              `/api/scm-sources/${id}/workspaces/${encodeURIComponent(args.name as string)}`,
            )
            console.log(`Worktree deleted ✓  ${args.name}`)
          },
        }),
      },
    }),

    codegraph: defineCommand({
      meta: { description: 'CodeGraph index maintenance' },
      subCommands: {
        reindex: defineCommand({
          meta: { description: 'Rebuild the CodeGraph index (409 while the checkout is busy)' },
          args: {
            id: { type: 'positional', description: 'SCM source ID or name', required: true },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const id = await client.resolveScmSourceId(args.id as string)
            const result = await client.post<{ data: unknown }>(
              `/api/scm-sources/${id}/codegraph/reindex`,
              {},
            )
            if (emit(args, result)) return
            console.log('CodeGraph reindex triggered ✓ (runs in background)')
          },
        }),
      },
    }),
  },
})
