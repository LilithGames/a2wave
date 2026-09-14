import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { forceArgs, parseIntFlag, requireConfirmation, resolveForceFlag } from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'
import { pageArgs, pageQuery } from '../lib/paginate.js'
import { type PollOptions, pollUntilTerminal } from '../lib/poll.js'

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

/** One row of `GET /api/provider-clis` — see apps/api/src/lib/cli-installer.ts. */
export interface ProviderCliState {
  kind: string
  binary: string
  lockedVersion: string
  installType: string
  installed: boolean
  installedVersion: string | null
  matchesLock: boolean | null
  /** Direction of any mismatch against the lock pin; null when not installed. */
  lockDrift: 'match' | 'below' | 'above' | 'unknown' | null
  minVersion: string | null
  meetsMinimum: boolean | null
  status: 'idle' | 'installing' | 'uninstalling' | 'error'
  lastError: string | null
  lastOutput: string | null
}

const PROVIDER_CLIS_PATH = '/api/provider-clis'

/**
 * The lock pins an EXACT version, so `above` is not a problem: the build is
 * newer than the pin and the engine (which gates on `minVersion`, a floor)
 * accepts it. Without this line an admin reads "drift" as "outdated" and
 * reinstalls — which downgrades. See docs/agent/provider-cli.md.
 */
const DRIFT_ABOVE_HINT =
  'lockDrift "above" means the installed build is newer than the lock pin; the engine accepts it.'

/** Widest `lastError` the status table shows before eliding. */
const MAX_LAST_ERROR_CHARS = 60

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Fetch every managed CLI, or just `kind`; an unknown kind names the real ones. */
async function fetchCliStates(
  client: { get: <T>(path: string) => Promise<T> },
  kind: string | undefined,
): Promise<ProviderCliState[]> {
  const { data } = await client.get<{ data: ProviderCliState[] }>(PROVIDER_CLIS_PATH)
  if (kind === undefined) return data
  const match = data.filter((s) => s.kind === kind)
  if (match.length === 0) {
    const known = data.map((s) => s.kind).join(' | ')
    throw new CliError(`Unknown Provider CLI: ${kind} (managed: ${known})`)
  }
  return match
}

/**
 * Poll the CLI list until `kind` leaves its in-progress state.
 *
 * `installing` AND `uninstalling` are treated as in-progress: an install
 * requested while an uninstall is still draining is refused by the server, and
 * waiting through it is more useful than reporting a status the caller did not
 * ask about.
 *
 * The list endpoint returns every CLI, so the poller narrows it to the one row
 * and fails loudly if that row disappears — a lock edit mid-install is the
 * only way that happens, and silently looping forever would hide it.
 */
export async function waitForCliInstall(
  client: { get: <T>(path: string) => Promise<T> },
  kind: string,
  opts: PollOptions = {},
): Promise<ProviderCliState> {
  // The poll helper fetches one path and reads `.data.status`; adapt the list
  // endpoint to that shape by narrowing each response to the requested row.
  const oneRow = {
    get: async <T>(): Promise<T> => {
      const [row] = await fetchCliStates(client, kind)
      return { data: row } as T
    },
  }
  return pollUntilTerminal<ProviderCliState>(
    oneRow,
    PROVIDER_CLIS_PATH,
    (s) => s.status !== 'installing' && s.status !== 'uninstalling',
    (s, timeoutMs) =>
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${kind} (last status: ${s.status})`,
    { intervalMs: 3000, timeoutMs: 600_000 },
    opts,
  )
}

function dash(value: string | boolean | null | undefined): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return value
}

function printCliTable(rows: ProviderCliState[]): void {
  const header = ['KIND', 'INSTALLED', 'LOCKED', 'DRIFT', 'MIN-OK', 'STATUS', 'LAST ERROR']
  const cells = rows.map((s) => [
    s.kind,
    dash(s.installedVersion),
    s.lockedVersion,
    dash(s.lockDrift),
    dash(s.meetsMinimum),
    s.status,
    s.lastError ? truncate(s.lastError, MAX_LAST_ERROR_CHARS) : '-',
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
  const line = (c: string[]) =>
    c
      .map((v, i) => v.padEnd(widths[i]))
      .join('  ')
      .trimEnd()
  console.log(line(header))
  for (const c of cells) console.log(line(c))
  if (rows.some((s) => s.lockDrift === 'above')) console.log(`\n${DRIFT_ABOVE_HINT}`)
}

function printInstallOutcome(s: ProviderCliState): void {
  if (s.status === 'error') {
    console.log(`Install of ${s.kind} failed (status: error)`)
    if (s.lastError) console.log(`Error: ${s.lastError}`)
    return
  }
  console.log(`Installed ${s.kind} ✓  version ${dash(s.installedVersion)}  (status: ${s.status})`)
  console.log(`Locked:    ${s.lockedVersion}`)
  console.log(`LockDrift: ${dash(s.lockDrift)}`)
  if (s.minVersion) console.log(`MinVersion: ${s.minVersion}  meets: ${dash(s.meetsMinimum)}`)
  if (s.lockDrift === 'above') console.log(DRIFT_ABOVE_HINT)
}

const kindArg = {
  kind: {
    type: 'positional' as const,
    description: 'Provider CLI kind, e.g. claude-code (see `providers cli status`)',
    required: true,
  },
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

    cli: defineCommand({
      meta: {
        name: 'cli',
        description: 'Install, inspect or remove the Provider CLIs on the server (admin)',
      },
      subCommands: {
        status: defineCommand({
          meta: {
            name: 'status',
            description: 'Show installed / locked version, lock drift and install job state',
            agentMeta: { risk: 'read' },
          },
          args: {
            kind: {
              type: 'positional',
              description: 'Limit to one Provider CLI kind, e.g. claude-code',
              required: false,
            },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const rows = await fetchCliStates(client, args.kind as string | undefined)
            if (emit(args, { data: rows })) return
            printCliTable(rows)
          },
        }),

        install: defineCommand({
          meta: {
            name: 'install',
            description: 'Install (or reinstall) a Provider CLI at its locked version',
            agentMeta: { risk: 'write' },
          },
          args: {
            ...kindArg,
            wait: {
              type: 'boolean',
              description: 'Poll every 3s until the install job settles; exit 1 on error',
            },
            timeout: {
              type: 'string',
              description: 'Seconds to wait with --wait before giving up (default 600)',
            },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const kind = args.kind as string
            // Validate before the POST: a bad flag must not leave a job running
            // that the caller then cannot follow.
            const timeoutMs =
              args.timeout === undefined
                ? undefined
                : parseIntFlag(args.timeout, 'timeout', { min: 0 }) * 1000
            const client = createClient({ url: args.url as string | undefined })
            const started = await client.post<{ data: { kind: string; status: string } }>(
              `${PROVIDER_CLIS_PATH}/${kind}/install`,
              {},
            )

            if (!args.wait) {
              if (emit(args, started)) return
              console.log(`Install started ✓  ${kind} (${started.data.status})`)
              console.log(`Follow with: a2wave providers cli status ${kind}`)
              return
            }

            const final = await waitForCliInstall(client, kind, { timeoutMs })
            // Exit code BEFORE emitting: `--json` returns early, and a failed
            // install must not exit 0 in a provisioning script.
            if (final.status === 'error') process.exitCode = 1
            if (emit(args, { data: final })) return
            printInstallOutcome(final)
          },
        }),

        uninstall: defineCommand({
          meta: {
            name: 'uninstall',
            description: 'Remove a Provider CLI from the server (Agents bound to it stop working)',
            agentMeta: { risk: 'high-risk-write' },
          },
          args: { ...kindArg, ...forceArgs, ...jsonArg, ...urlArg },
          run: async ({ args }) => {
            const kind = args.kind as string
            await requireConfirmation(
              'high-risk-write',
              `This will remove the ${kind} CLI from the server. Every Agent bound to it fails until it is reinstalled.`,
              resolveForceFlag(args),
            )
            const client = createClient({ url: args.url as string | undefined })
            const result = await client.post<{ data: { kind: string; status: string } }>(
              `${PROVIDER_CLIS_PATH}/${kind}/uninstall`,
              {},
            )
            if (emit(args, result)) return
            console.log(`Uninstalled ${kind} ✓  (status: ${result.data.status})`)
          },
        }),
      },
    }),
  },
})
