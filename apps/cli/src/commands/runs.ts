import { createWriteStream, renameSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as StreamWebReadable } from 'node:stream/web'
import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { parseIntFlag } from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'
import { parsePage, parsePageSize } from '../lib/paginate.js'
import { type PollOptions, pollUntilTerminal } from '../lib/poll.js'
import { forEachSSELine } from '../lib/sse.js'

interface Run {
  id: string
  intent: string
  status: string
  initiatorAgentId?: string | null
  agentName?: string | null
  triggerSource?: string | null
  createdAt: string
  result?: { output?: string; durationMs?: number; error?: string } | null
}

interface RunStep {
  order?: number
  agentId?: string | null
  status?: string
  output?: { logs?: StreamLogEntry[]; result?: string } | null
}

interface Pagination {
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/** Run statuses accepted by `runs list --status`. */
const RUN_STATUSES = ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'] as const

/**
 * Pagination moved to lib/paginate.ts when the other six list commands grew
 * `--limit`; re-exported here so the extensive tests that already pin this
 * behaviour keep importing it from where it used to live.
 */
export { parsePage, parsePageSize }

/**
 * Log entries printed per step by `runs get` before truncation kicks in.
 *
 * A long run's logs are the largest thing this CLI prints, and the usual reason
 * to call `runs get` is "how did it end?", not "replay every tool call". The
 * untruncated copy is one command away (`runs logs`), and the notice says so.
 */
const DEFAULT_MAX_LOG_LINES = 200

/** Resolve the per-step log cap; `0` (via --full) means unlimited. */
export function resolveMaxLogLines(args: Record<string, unknown>): number {
  if (args.full === true) return 0
  const raw = args['max-log-lines']
  if (raw === undefined || raw === '') return DEFAULT_MAX_LOG_LINES
  return parseIntFlag(raw, 'max-log-lines', { min: 0 })
}

/** Order steps by `order` so multi-turn logs print chronologically. */
export function sortSteps(steps: RunStep[]): RunStep[] {
  return [...steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/** Poll a run until it settles. Used by `rerun --wait`, which has no SSE stream. */
export async function waitForRun(
  client: { get: <T>(path: string) => Promise<T> },
  runId: string,
  opts: PollOptions = {},
): Promise<Run> {
  return pollUntilTerminal<Run>(
    client,
    `/api/runs/${runId}`,
    (run) => TERMINAL_RUN_STATUSES.has(run.status),
    (run, timeoutMs) =>
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${runId} (last status: ${run.status})`,
    { intervalMs: 2000, timeoutMs: 30 * 60_000 },
    opts,
  )
}

function printPagination(p: Pagination | undefined): void {
  if (!p || p.totalPages <= 1) return
  console.log(`\nPage ${p.page}/${p.totalPages} (${p.total} total) — next: --page ${p.page + 1}`)
}

interface StreamLogEntry {
  type: 'system' | 'assistant' | 'tool_call' | 'result' | 'error' | 'retry'
  text?: string
  message?: string
  toolName?: string
  subtype?: string
  attempt?: number
  nextAttemptIn?: number
  durationMs?: number
  ts: number
}

export function formatLog(entry: StreamLogEntry): string {
  switch (entry.type) {
    case 'assistant':
      return entry.text ?? ''
    case 'tool_call':
      return `[tool:${entry.toolName}] ${entry.subtype}`
    case 'result':
      return `[done] ${entry.subtype ?? ''}${entry.durationMs ? ` (${entry.durationMs}ms)` : ''}`
    case 'error':
      return `[error] ${entry.message ?? ''}`
    case 'retry':
      return `[retry] attempt ${entry.attempt}, retrying in ${entry.nextAttemptIn}ms`
    default:
      return ''
  }
}

export function handleSSELine(
  line: string,
  state: { currentEvent: string; lastContent: string },
): void {
  if (line.startsWith('event:')) {
    state.currentEvent = line.slice('event:'.length).trim()
    return
  }
  if (!line.startsWith('data:')) return
  const data = line.slice('data:'.length).trim()
  if (!data) return
  try {
    const parsed = JSON.parse(data)
    switch (state.currentEvent) {
      case 'update':
        // Server pushes cumulative content; print only the new part
        if (parsed.content && parsed.content !== state.lastContent) {
          process.stdout.write(parsed.content.slice(state.lastContent.length))
          state.lastContent = parsed.content
        }
        break
      case 'log': {
        const entry = parsed as StreamLogEntry
        if (entry.type === 'assistant') break // already shown via update events
        const formatted = formatLog(entry)
        if (formatted) console.log(`  ${formatted}`)
        break
      }
      case 'done':
        console.log('\n[execution complete]')
        if (parsed.durationMs) console.log(`Duration: ${parsed.durationMs}ms`)
        break
      case 'error':
        throw new CliError(`\n[execution failed] ${parsed.error ?? JSON.stringify(parsed)}`)
    }
  } catch (err) {
    if (err instanceof CliError) throw err
    // skip non-JSON lines
  }
}

async function consumeSSE(response: Response): Promise<void> {
  const state = { currentEvent: '', lastContent: '' }
  await forEachSSELine(response, (line) => handleSSELine(line, state))
}

export const runsCommand = defineCommand({
  meta: { name: 'runs', description: 'Manage runs' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List run records', agentMeta: { risk: 'read' } },
      args: {
        agent: { type: 'string', description: 'Filter by Agent ID or name' },
        status: {
          type: 'string',
          description: `Filter by status (${RUN_STATUSES.join(' | ')})`,
        },
        limit: {
          type: 'string',
          description: 'Records per page (default 20; clamped to the API max of 100)',
        },
        page: { type: 'string', description: 'Page number, 1-based (default 1)' },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })

        const status = args.status as string | undefined
        if (status && !RUN_STATUSES.includes(status as (typeof RUN_STATUSES)[number])) {
          throw new CliError(
            `Invalid --status "${status}". Expected one of: ${RUN_STATUSES.join(', ')}`,
          )
        }

        const page = parsePage(args.page)
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(parsePageSize(args.limit)),
        })
        if (args.agent) params.set('agentId', await client.resolveAgentId(args.agent as string))

        const result = await client.get<{ data: Run[]; pagination?: Pagination }>(
          `/api/runs?${params.toString()}`,
        )
        // The API has no status filter, so this narrows the current page only.
        // Say so explicitly rather than let it read as a global filter.
        const rows = status ? result.data.filter((r) => r.status === status) : result.data
        // Pairing a filtered `data` with the server's unfiltered `pagination`
        // would make `--json | jq '.data|length'` indistinguishable from a true
        // total. Stamp the narrowing explicitly so a consumer can detect it.
        if (
          emit(
            args,
            status
              ? {
                  ...result,
                  data: rows,
                  filter: {
                    status,
                    scope: 'page',
                    matchedOnPage: rows.length,
                    scannedOnPage: result.data.length,
                  },
                }
              : result,
          )
        )
          return

        if (rows.length === 0) {
          console.log(status ? `No runs with status "${status}" on this page` : 'No run records')
          return
        }
        for (const r of rows) {
          const agent = r.agentName ? `[${r.agentName}]` : ''
          const intent = r.intent.length > 50 ? `${r.intent.slice(0, 50)}...` : r.intent
          console.log(`${r.id}  ${r.status.padEnd(10)}  ${agent}  ${intent}`)
        }
        if (status) {
          console.log(
            `\n(--status filters this page only; ${rows.length}/${result.data.length} shown)`,
          )
        }
        printPagination(result.pagination)
      },
    }),

    get: defineCommand({
      meta: { name: 'get', description: 'View run details and logs', agentMeta: { risk: 'read' } },
      args: {
        id: { type: 'positional', description: 'Run ID (run_xxx)', required: true },
        'max-log-lines': {
          type: 'string',
          description: `Log entries to print per step, newest kept (default ${DEFAULT_MAX_LOG_LINES}, 0 = all)`,
        },
        full: { type: 'boolean', description: 'Print every log entry (same as --max-log-lines 0)' },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const result = await client.get<{ data: Run & { steps?: RunStep[] } }>(
          `/api/runs/${args.id}`,
        )
        if (emit(args, result)) return

        const r = result.data
        console.log(`ID:       ${r.id}`)
        console.log(`Status:   ${r.status}`)
        console.log(`Intent:   ${r.intent}`)
        console.log(`Created:  ${r.createdAt}`)
        if (r.result?.durationMs) console.log(`Duration: ${r.result.durationMs}ms`)
        if (r.result?.error) console.log(`Error:    ${r.result.error}`)

        // A multi-turn run has one step per turn. Printing only steps[0] silently
        // hid every later turn's logs and result, so walk them all in order.
        const steps = sortSteps(r.steps ?? [])
        const multi = steps.length > 1
        const maxLogLines = resolveMaxLogLines(args)
        steps.forEach((step, i) => {
          const label = multi ? ` (step ${i + 1}/${steps.length})` : ''
          const logs = step.output?.logs ?? []
          if (logs.length > 0) {
            console.log(`\n--- Execution logs${label} ---`)
            // Keep the TAIL: a run's logs are read to find out how it ended,
            // and the failure is at the bottom. Hiding the head is the lossy
            // choice that costs the least.
            const hidden = maxLogLines > 0 ? Math.max(0, logs.length - maxLogLines) : 0
            if (hidden > 0) {
              console.log(
                `... ${hidden} earlier entries hidden (--full, --max-log-lines N, or a2wave runs logs ${r.id})`,
              )
            }
            for (const entry of logs.slice(hidden)) {
              const formatted = formatLog(entry)
              if (formatted) console.log(formatted)
            }
          }
          if (step.output?.result) {
            console.log(`\n--- Execution result${label} ---`)
            console.log(step.output.result)
          }
        })
      },
    }),

    logs: defineCommand({
      meta: {
        name: 'logs',
        description: 'Download the full execution log (NDJSON, untruncated)',
        agentMeta: {
          risk: 'read',
          notFor: [
            'Checking whether a run finished — the server caps this at 256 MiB and it is never the cheap answer. Use `runs get <id> --fields data.status`',
          ],
          examples: ['a2wave runs logs run_x -o run.ndjson'],
        },
      },
      args: {
        id: { type: 'positional', description: 'Run ID (run_xxx)', required: true },
        output: {
          type: 'string',
          alias: 'o',
          description: 'Write to a file instead of stdout (default: <runId>.ndjson with --output)',
        },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = args.id as string
        // The bypass endpoint returns the whole NDJSON side file; runSteps.output.logs
        // is capped by MAX_STREAM_LOGS and drops the tail of long runs.
        const res = await client.getRaw(`/api/runs/${id}/logs/download`)
        if (!res.body) throw new CliError('Response body is empty')

        // Stream rather than `await res.text()`: this sidecar is the UNtruncated
        // log (MAX_STREAM_LOGS caps only the DB copy) and can reach hundreds of
        // MiB, so buffering it whole risks an OOM on exactly the large runs
        // people reach for this command to inspect.
        const target =
          args.output === undefined
            ? undefined
            : typeof args.output === 'string' && args.output
              ? args.output
              : `${id}.ndjson`

        if (target === undefined) {
          try {
            await pipeline(Readable.fromWeb(res.body as StreamWebReadable), process.stdout, {
              end: false,
            })
          } catch (err) {
            // `a2wave runs logs X | head` closes stdout early. That is the pipe
            // working as intended, not a download failure — exit quietly instead
            // of dumping an EPIPE stack trace.
            if ((err as NodeJS.ErrnoException)?.code !== 'EPIPE') throw err
          }
          return
        }

        // Stream to a sibling temp file and rename on success. createWriteStream
        // truncates its target immediately, so a mid-download network drop would
        // otherwise replace a good previous log with an empty or partial one.
        const tmp = `${target}.part-${process.pid}`
        // Ctrl-C kills the process before the catch below can run, which would
        // strand the partial file next to the real one. Clean it up on the
        // signal too, then re-raise so the exit code still reflects the abort.
        // SIGHUP matters as much as the other two: closing the terminal is the
        // exact case that strands the file. Exit codes follow the 128+signal
        // convention (the handler exits directly rather than re-raising).
        const SIGNALS: Array<[NodeJS.Signals, number]> = [
          ['SIGINT', 130],
          ['SIGTERM', 143],
          ['SIGHUP', 129],
        ]
        const handlers = SIGNALS.map(([sig, code]) => {
          const fn = () => {
            rmSync(tmp, { force: true })
            process.exit(code)
          }
          process.once(sig, fn)
          return [sig, fn] as const
        })
        let renamed = false
        try {
          await pipeline(Readable.fromWeb(res.body as StreamWebReadable), createWriteStream(tmp))
          renameSync(tmp, target)
          renamed = true
        } finally {
          for (const [sig, fn] of handlers) process.removeListener(sig, fn)
          // Clean up in `finally`, not `catch`: `pipeline` can reject AFTER the
          // write stream has been torn down, and on Linux a `catch`-only cleanup
          // raced that teardown and left the .part file behind. Keying off
          // `renamed` also covers a throw from renameSync itself.
          if (!renamed) rmSync(tmp, { force: true })
        }
        const { size } = statSync(target)
        console.log(`Logs → ${target} (${(size / 1024).toFixed(1)}KB)`)
      },
    }),

    cancel: defineCommand({
      meta: {
        name: 'cancel',
        description: 'Cancel a queued or running run',
        agentMeta: { risk: 'write' },
      },
      args: {
        id: { type: 'positional', description: 'Run ID (run_xxx)', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const result = await client.post<{ data: { runId: string; status: string } }>(
          `/api/runs/${args.id}/cancel`,
          {},
        )
        if (emit(args, result)) return
        console.log(`Cancelled ✓  ${result.data.runId} (${result.data.status})`)
      },
    }),

    rerun: defineCommand({
      meta: {
        name: 'rerun',
        description: 'Replay a run with its original intent and attachments',
        agentMeta: { risk: 'write' },
      },
      args: {
        id: { type: 'positional', description: 'Run ID (run_xxx)', required: true },
        wait: {
          type: 'boolean',
          description: 'Poll until the new run reaches a terminal status',
        },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        // The server starts (or queues) the replay itself — never POST /execute
        // afterwards, that would run the same intent a second time.
        const result = await client.post<{ data: { id: string; status: string } }>(
          `/api/runs/${args.id}/rerun`,
          {},
        )
        const newId = result.data.id

        if (!args.wait) {
          if (emit(args, result)) return
          console.log(`Rerun created ✓  ${newId} (${result.data.status})`)
          console.log(`Follow with: a2wave runs get ${newId}`)
          return
        }

        const final = await waitForRun(client, newId)
        // Set the exit code BEFORE emitting: `--json` returns early, and skipping
        // this would make a failed run exit 0 and silently pass a CI gate.
        if (final.status === 'failed' || final.status === 'cancelled') process.exitCode = 1
        if (emit(args, { data: final })) return
        console.log(`Rerun ${newId} → ${final.status}`)
        if (final.result?.error) console.log(`Error: ${final.result.error}`)
        if (final.result?.output) console.log(`\n${final.result.output}`)
      },
    }),

    trigger: defineCommand({
      meta: {
        name: 'trigger',
        description: 'Trigger an Agent run with live log output',
        agentMeta: { risk: 'write' },
      },
      args: {
        agent: { type: 'positional', description: 'Agent ID or name', required: true },
        intent: { type: 'string', description: 'Execution intent', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.agent as string)

        console.log(`Triggering Agent: ${agentId}`)
        console.log(`Intent: ${args.intent}\n`)

        // 1. Create the run
        const { data: run } = await client.post<{ data: { id: string } }>('/api/runs', {
          intent: args.intent,
          initiatorAgentId: agentId,
        })

        console.log(`Run ID: ${run.id}\n--- Execution logs ---`)

        // 2. Execute and consume the SSE stream
        const res = await client.postStream(`/api/runs/${run.id}/execute`, { stream: true })
        await consumeSSE(res)
      },
    }),
  },
})
