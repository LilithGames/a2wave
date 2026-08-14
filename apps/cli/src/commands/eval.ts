import { readFileSync } from 'node:fs'
import { defineCommand } from 'citty'
import { parse as parseYaml } from 'yaml'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { confirmDestructive } from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'
import { type PollOptions, pollUntilTerminal } from '../lib/poll.js'

interface EvaluationSet {
  id: string
  name: string
  description?: string | null
  createdAt?: string
}

interface EvaluationTurn {
  request: string
  expectedResponse?: string
}

interface EvaluationCase {
  id: string
  name: string
  turns: EvaluationTurn[]
  sortOrder?: number
}

interface EvaluationResult {
  id: string
  caseName: string
  status: string
  /** Manual review is a nested object, not flat `verdict`/`note` columns. */
  review?: { verdict: string; note?: string | null } | null
  error?: string | null
  /** Replayed turns with the Agent's answers; `turnsSnapshot` holds the expectations. */
  actualTurns?: Array<{
    request: string
    expectedResponse?: string
    actualResponse?: string | null
    error?: string | null
  }> | null
  turnsSnapshot?: Array<{ request: string; expectedResponse?: string }> | null
}

interface EvaluationTaskSummary {
  total: number
  passed: number
  failed: number
  unreviewed: number
  passRate: number | null
}

interface EvaluationTask {
  id: string
  name?: string | null
  setName: string
  status: string
  summary?: EvaluationTaskSummary | null
  configSnapshot?: { providerName?: string | null; model?: string | null } | null
  /** Task-level failure reason (e.g. the snapshotted provider was unbound). */
  error?: string | null
  createdAt?: string
  startedAt?: string | null
  /** The column is `finished_at` — there is no `completedAt`. */
  finishedAt?: string | null
  results?: EvaluationResult[]
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const VERDICTS = ['pass', 'fail', 'unreviewed'] as const

/** Resolve an evaluation set by `evs_` ID or exact name within one agent. */
async function resolveSetId(
  client: ReturnType<typeof createClient>,
  agentId: string,
  idOrName: string,
): Promise<string> {
  if (idOrName.startsWith('evs_')) return idOrName
  const { data } = await client.get<{ data: EvaluationSet[] }>(
    `/api/agents/${agentId}/evaluation-sets`,
  )
  const matches = data.filter((s) => s.name === idOrName)
  if (matches.length === 0) {
    const available = data.map((s) => s.name).join(', ') || '(none)'
    throw new CliError(`Evaluation set not found: "${idOrName}". Available: ${available}`)
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => `  ${m.id}  ${m.name}`).join('\n')
    throw new CliError(
      `Name "${idOrName}" matches multiple evaluation sets. Use an evs_ ID:\n${candidates}`,
    )
  }
  return matches[0].id
}

/**
 * Parse a cases file (YAML or JSON) into create-case payloads.
 *
 * Accepts either a bare list of cases or `{ cases: [...] }`, and lets a single
 * turn be written as `{request, expectedResponse}` at the case level so simple
 * one-shot cases don't need a nested `turns` array.
 */
export function parseCasesFile(raw: string): Array<{
  name: string
  turns: EvaluationTurn[]
  sortOrder: number
}> {
  let doc: unknown
  try {
    doc = parseYaml(raw)
  } catch (err) {
    throw new CliError(`Cannot parse cases file: ${(err as Error).message}`)
  }

  const list = Array.isArray(doc)
    ? doc
    : Array.isArray((doc as { cases?: unknown })?.cases)
      ? ((doc as { cases: unknown[] }).cases as unknown[])
      : null
  if (!list) throw new CliError('Cases file must be a list, or an object with a `cases` list')
  if (list.length === 0) throw new CliError('Cases file contains no cases')

  return list.map((entry, i) => {
    const c = entry as Record<string, unknown>
    const name = typeof c.name === 'string' && c.name ? c.name : `case-${i + 1}`

    const rawTurns = Array.isArray(c.turns)
      ? (c.turns as Array<Record<string, unknown>>)
      : typeof c.request === 'string'
        ? [{ request: c.request, expectedResponse: c.expectedResponse }]
        : null
    if (!rawTurns || rawTurns.length === 0) {
      throw new CliError(`Case "${name}" has no turns (need \`turns:\` or a \`request:\`)`)
    }

    const turns = rawTurns.map((t, ti) => {
      if (typeof t.request !== 'string' || !t.request) {
        throw new CliError(`Case "${name}" turn ${ti + 1} is missing \`request\``)
      }
      return {
        request: t.request,
        expectedResponse: typeof t.expectedResponse === 'string' ? t.expectedResponse : '',
      }
    })

    return { name, turns, sortOrder: typeof c.sortOrder === 'number' ? c.sortOrder : i }
  })
}

function formatSummary(s: EvaluationTaskSummary | null | undefined): string {
  if (!s) return ''
  const rate = s.passRate === null ? 'n/a' : `${Math.round(s.passRate * 100)}%`
  return `${s.passed}/${s.total} passed (fail=${s.failed}, unreviewed=${s.unreviewed}, rate=${rate})`
}

/** Poll a task until it settles. Powers `eval run --wait`. */
export async function waitForTask(
  client: { get: <T>(path: string) => Promise<T> },
  agentId: string,
  taskId: string,
  opts: PollOptions = {},
): Promise<EvaluationTask> {
  return pollUntilTerminal<EvaluationTask>(
    client,
    `/api/agents/${agentId}/evaluation-tasks/${taskId}`,
    (task) => TERMINAL_TASK_STATUSES.has(task.status),
    (task, timeoutMs) =>
      `Timed out after ${Math.round(timeoutMs / 60_000)}min waiting for ${taskId} (last status: ${task.status})`,
    // A replay fans out into N sequential agent invocations, so it is polled
    // less often and allowed far longer than a single run.
    { intervalMs: 5000, timeoutMs: 60 * 60_000 },
    opts,
  )
}

const agentArg = {
  agent: { type: 'positional' as const, description: 'Agent ID or name', required: true },
}

export const evalCommand = defineCommand({
  meta: { name: 'eval', description: 'Manage Agent evaluation sets, cases and replay tasks' },
  subCommands: {
    sets: defineCommand({
      meta: { name: 'sets', description: 'Manage evaluation sets' },
      subCommands: {
        list: defineCommand({
          meta: { name: 'list', description: 'List evaluation sets', agentMeta: { risk: 'read' } },
          args: { ...agentArg, ...jsonArg, ...urlArg },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const result = await client.get<{ data: EvaluationSet[] }>(
              `/api/agents/${agentId}/evaluation-sets`,
            )
            if (emit(args, result)) return
            if (result.data.length === 0) {
              console.log('No evaluation sets')
              return
            }
            for (const s of result.data) {
              console.log(`${s.id}  ${s.name}${s.description ? `  — ${s.description}` : ''}`)
            }
          },
        }),

        create: defineCommand({
          meta: {
            name: 'create',
            description: 'Create an evaluation set',
            agentMeta: { risk: 'write' },
          },
          args: {
            ...agentArg,
            name: { type: 'string', description: 'Set name', required: true },
            description: { type: 'string', description: 'Set description' },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const result = await client.post<{ data: EvaluationSet }>(
              `/api/agents/${agentId}/evaluation-sets`,
              { name: args.name, description: args.description ?? null },
            )
            if (emit(args, result)) return
            console.log(`Evaluation set created ✓  ${result.data.id}  ${result.data.name}`)
          },
        }),

        update: defineCommand({
          meta: {
            name: 'update',
            description: 'Update an evaluation set',
            agentMeta: { risk: 'write' },
          },
          args: {
            ...agentArg,
            set: { type: 'positional', description: 'Set ID or name', required: true },
            name: { type: 'string', description: 'New name' },
            description: { type: 'string', description: 'New description' },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const setId = await resolveSetId(client, agentId, args.set as string)

            const body: Record<string, unknown> = {}
            if (args.name !== undefined) body.name = args.name
            if (args.description !== undefined) body.description = args.description
            if (Object.keys(body).length === 0) {
              throw new CliError('Nothing to update. Pass --name and/or --description')
            }

            const result = await client.patch<{ data: EvaluationSet }>(
              `/api/agents/${agentId}/evaluation-sets/${setId}`,
              body,
            )
            if (emit(args, result)) return
            console.log(`Updated ✓  ${result.data.id}  ${result.data.name}`)
          },
        }),

        delete: defineCommand({
          meta: {
            name: 'delete',
            agentMeta: { risk: 'high-risk-write' },
            description: 'Delete an evaluation set (cases cascade; task history kept)',
          },
          args: {
            ...agentArg,
            set: { type: 'positional', description: 'Set ID or name', required: true },
            force: { type: 'boolean', description: 'Skip the confirmation prompt' },
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const setId = await resolveSetId(client, agentId, args.set as string)
            await confirmDestructive(
              `Delete evaluation set ${setId} and all its cases (irreversible).`,
              args.force === true,
            )
            await client.del(`/api/agents/${agentId}/evaluation-sets/${setId}`)
            console.log(`Deleted ✓  ${setId}`)
          },
        }),
      },
    }),

    cases: defineCommand({
      meta: { name: 'cases', description: 'Manage the cases of an evaluation set' },
      subCommands: {
        list: defineCommand({
          meta: { name: 'list', description: 'List cases in a set', agentMeta: { risk: 'read' } },
          args: {
            ...agentArg,
            set: { type: 'positional', description: 'Set ID or name', required: true },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const setId = await resolveSetId(client, agentId, args.set as string)
            const result = await client.get<{ data: EvaluationCase[] }>(
              `/api/agents/${agentId}/evaluation-sets/${setId}/cases`,
            )
            if (emit(args, result)) return
            if (result.data.length === 0) {
              console.log('No cases')
              return
            }
            for (const c of result.data) {
              console.log(`${c.id}  ${c.name}  (${c.turns.length} turn(s))`)
            }
          },
        }),

        add: defineCommand({
          meta: {
            name: 'add',
            description: 'Add one case (single turn) to a set',
            agentMeta: { risk: 'write' },
          },
          args: {
            ...agentArg,
            set: { type: 'positional', description: 'Set ID or name', required: true },
            name: { type: 'string', description: 'Case name', required: true },
            request: { type: 'string', description: 'The user request', required: true },
            expected: { type: 'string', description: 'Expected response' },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const setId = await resolveSetId(client, agentId, args.set as string)
            const result = await client.post<{ data: EvaluationCase }>(
              `/api/agents/${agentId}/evaluation-sets/${setId}/cases`,
              {
                name: args.name,
                turns: [
                  { request: args.request, expectedResponse: (args.expected as string) ?? '' },
                ],
                sortOrder: 0,
              },
            )
            if (emit(args, result)) return
            console.log(`Case added ✓  ${result.data.id}  ${result.data.name}`)
          },
        }),

        import: defineCommand({
          meta: {
            name: 'import',
            description: 'Bulk-import cases from a YAML or JSON file',
            agentMeta: { risk: 'write' },
          },
          args: {
            ...agentArg,
            set: { type: 'positional', description: 'Set ID or name', required: true },
            file: { type: 'string', alias: 'f', description: 'Cases file', required: true },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            let raw: string
            try {
              raw = readFileSync(args.file as string, 'utf-8')
            } catch {
              throw new CliError(`Cannot read file: ${args.file}`)
            }
            const cases = parseCasesFile(raw)

            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const setId = await resolveSetId(client, agentId, args.set as string)

            const created: EvaluationCase[] = []
            // Sequential on purpose: sortOrder is positional, so cases must land
            // in file order. There is no bulk endpoint and no transaction, so a
            // mid-way failure leaves a partial import — report exactly how far it
            // got before rethrowing, otherwise the user cannot tell which cases
            // already exist and a blind retry duplicates them.
            try {
              for (const c of cases) {
                const { data } = await client.post<{ data: EvaluationCase }>(
                  `/api/agents/${agentId}/evaluation-sets/${setId}/cases`,
                  c,
                )
                created.push(data)
              }
            } catch (err) {
              console.error(
                `Partial import: ${created.length}/${cases.length} case(s) were created before the failure.`,
              )
              if (created.length > 0) {
                console.error(`Already created: ${created.map((c) => c.name).join(', ')}`)
                console.error(
                  'Remove them from the file (or delete them) before retrying, or the retry will duplicate them.',
                )
              }
              throw err
            }

            if (emit(args, { data: created })) return
            console.log(`Imported ${created.length} case(s) ✓`)
            for (const c of created) console.log(`  ${c.id}  ${c.name}`)
          },
        }),

        delete: defineCommand({
          meta: {
            name: 'delete',
            description: 'Delete one case',
            agentMeta: { risk: 'high-risk-write' },
          },
          args: {
            ...agentArg,
            set: { type: 'positional', description: 'Set ID or name', required: true },
            case: { type: 'positional', description: 'Case ID (evc_xxx)', required: true },
            force: { type: 'boolean', description: 'Skip the confirmation prompt' },
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const setId = await resolveSetId(client, agentId, args.set as string)
            await confirmDestructive(
              `Delete case ${args.case} (irreversible).`,
              args.force === true,
            )
            await client.del(`/api/agents/${agentId}/evaluation-sets/${setId}/cases/${args.case}`)
            console.log(`Deleted ✓  ${args.case}`)
          },
        }),
      },
    }),

    run: defineCommand({
      meta: {
        name: 'run',
        agentMeta: { risk: 'write' },
        description: 'Start an evaluation task (replay a set against the Agent)',
      },
      args: {
        ...agentArg,
        set: { type: 'string', description: 'Set ID or name to replay', required: true },
        name: { type: 'string', description: 'Task name' },
        wait: { type: 'boolean', description: 'Poll until the task finishes' },
        'fail-on-fail': {
          type: 'boolean',
          description:
            'With --wait, exit 1 if any case has a "fail" verdict OR errored during replay (for CI)',
        },
        verbose: {
          type: 'boolean',
          description: 'With --wait, print full turn transcripts instead of clipping them',
        },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.agent as string)
        const setId = await resolveSetId(client, agentId, args.set as string)

        const created = await client.post<{ data: EvaluationTask }>(
          `/api/agents/${agentId}/evaluation-tasks`,
          { setId, name: (args.name as string) ?? null },
        )
        const taskId = created.data.id

        if (!args.wait) {
          if (emit(args, created)) return
          console.log(`Evaluation task started ✓  ${taskId} (${created.data.status})`)
          console.log(`Follow with: a2wave eval tasks get ${args.agent} ${taskId}`)
          return
        }

        const task = await waitForTask(client, agentId, taskId)
        // Set the exit code BEFORE emitting: `--json` returns early, and skipping
        // this would make a failed task exit 0 and silently pass a CI gate.
        applyEvalExitCode(task, args['fail-on-fail'] === true)
        if (emit(args, { data: task })) return
        printTask(task, args.verbose === true)
      },
    }),

    tasks: defineCommand({
      meta: { name: 'tasks', description: 'Inspect evaluation tasks' },
      subCommands: {
        list: defineCommand({
          meta: {
            name: 'list',
            description: 'List evaluation tasks (newest first)',
            agentMeta: { risk: 'read' },
          },
          args: { ...agentArg, ...jsonArg, ...urlArg },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const result = await client.get<{ data: EvaluationTask[] }>(
              `/api/agents/${agentId}/evaluation-tasks`,
            )
            if (emit(args, result)) return
            if (result.data.length === 0) {
              console.log('No evaluation tasks')
              return
            }
            for (const t of result.data) {
              const summary = formatSummary(t.summary)
              console.log(
                `${t.id}  ${t.status.padEnd(10)}  ${t.setName}${summary ? `  ${summary}` : ''}`,
              )
            }
          },
        }),

        get: defineCommand({
          meta: {
            name: 'get',
            description: 'Show a task with its per-case results',
            agentMeta: { risk: 'read' },
          },
          args: {
            ...agentArg,
            task: { type: 'positional', description: 'Task ID (evt_xxx)', required: true },
            verbose: {
              type: 'boolean',
              description: 'Print full turn transcripts instead of clipping them',
            },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const result = await client.get<{ data: EvaluationTask }>(
              `/api/agents/${agentId}/evaluation-tasks/${args.task}`,
            )
            if (emit(args, result)) return
            printTask(result.data, args.verbose === true)
          },
        }),

        verdict: defineCommand({
          meta: {
            name: 'verdict',
            description: 'Record a manual verdict on one case result',
            agentMeta: { risk: 'write' },
          },
          args: {
            ...agentArg,
            task: { type: 'positional', description: 'Task ID (evt_xxx)', required: true },
            result: { type: 'positional', description: 'Result ID (evr_xxx)', required: true },
            verdict: {
              type: 'string',
              description: `One of: ${VERDICTS.join(' | ')}`,
              required: true,
            },
            note: { type: 'string', description: 'Reviewer note' },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const verdict = args.verdict as string
            if (!VERDICTS.includes(verdict as (typeof VERDICTS)[number])) {
              throw new CliError(
                `Invalid verdict "${verdict}". Expected one of: ${VERDICTS.join(', ')}`,
              )
            }
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const body: Record<string, unknown> = { verdict }
            if (args.note !== undefined) body.note = args.note

            const result = await client.patch<{ data: EvaluationResult }>(
              `/api/agents/${agentId}/evaluation-tasks/${args.task}/results/${args.result}`,
              body,
            )
            if (emit(args, result)) return
            console.log(`Verdict recorded ✓  ${args.result} → ${verdict}`)
          },
        }),

        cancel: defineCommand({
          meta: {
            name: 'cancel',
            description: 'Cancel a queued or running task',
            agentMeta: { risk: 'write' },
          },
          args: {
            ...agentArg,
            task: { type: 'positional', description: 'Task ID (evt_xxx)', required: true },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const result = await client.post<{ data: { id: string; cancelling: boolean } }>(
              `/api/agents/${agentId}/evaluation-tasks/${args.task}/cancel`,
              {},
            )
            if (emit(args, result)) return
            // A running task stops between cases, so this is a request, not an
            // immediate stop — say so rather than claim it already ended.
            console.log(`Cancellation requested ✓  ${result.data.id} (takes effect between cases)`)
          },
        }),

        delete: defineCommand({
          meta: {
            name: 'delete',
            description: 'Delete a task and its results',
            agentMeta: { risk: 'high-risk-write' },
          },
          args: {
            ...agentArg,
            task: { type: 'positional', description: 'Task ID (evt_xxx)', required: true },
            force: { type: 'boolean', description: 'Skip the confirmation prompt' },
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            await confirmDestructive(
              `Delete evaluation task ${args.task} and its results (irreversible).`,
              args.force === true,
            )
            await client.del(`/api/agents/${agentId}/evaluation-tasks/${args.task}`)
            console.log(`Deleted ✓  ${args.task}`)
          },
        }),
      },
    }),
  },
})

/**
 * Characters of a turn body printed before truncation.
 *
 * The transcripts are the bulk of a task's output — a 50-case, 3-turn task
 * printed 750+ lines of full request/expected/actual text — and the usual
 * reason to run `eval tasks get` is "which cases failed", not "replay every
 * transcript". `--verbose` prints them whole; `--json` is never truncated.
 */
const MAX_TURN_BODY_CHARS = 200

function clipBody(text: string, verbose: boolean): string {
  if (verbose || text.length <= MAX_TURN_BODY_CHARS) return text
  return `${text.slice(0, MAX_TURN_BODY_CHARS)}… (${text.length - MAX_TURN_BODY_CHARS} more chars, --verbose for all)`
}

function printTask(t: EvaluationTask, verbose = false): void {
  console.log(`ID:       ${t.id}`)
  console.log(`Set:      ${t.setName}`)
  console.log(`Status:   ${t.status}`)
  if (t.configSnapshot) {
    const { providerName, model } = t.configSnapshot
    console.log(`Snapshot: provider=${providerName ?? 'n/a'} model=${model ?? 'n/a'}`)
  }
  // A task can fail as a whole (e.g. its snapshotted provider was unbound before
  // it started), which is separate from any individual case failing.
  if (t.error) console.log(`Error:    ${t.error}`)
  if (t.finishedAt) console.log(`Finished: ${t.finishedAt}`)
  if (t.summary) console.log(`Summary:  ${formatSummary(t.summary)}`)
  // Distinct from summary.failed, which counts manual verdicts only: a case can
  // error during replay and still leave the task `completed` with failed=0.
  const errored = countErroredCases(t)
  if (errored > 0) console.log(`Errored:  ${errored} case(s) failed during replay`)

  for (const r of t.results ?? []) {
    const v = r.review?.verdict
    const verdict = v && v !== 'unreviewed' ? ` verdict=${v}` : ''
    console.log(`\n  ${r.id}  ${r.caseName}  [${r.status}]${verdict}`)
    if (r.review?.note) console.log(`    note: ${r.review.note}`)
    if (r.error) console.log(`    error: ${r.error}`)

    // A case that never ran has no actualTurns; fall back to the frozen
    // expectations so the row still shows what it would have asked.
    const turns = r.actualTurns ?? r.turnsSnapshot ?? []
    for (const turn of turns) {
      console.log(`    request:  ${clipBody(turn.request, verbose)}`)
      if (turn.expectedResponse) {
        console.log(`    expected: ${clipBody(turn.expectedResponse, verbose)}`)
      }
      const actual = (turn as { actualResponse?: string | null }).actualResponse
      if (actual) console.log(`    actual:   ${clipBody(actual, verbose)}`)
      // Errors are never clipped: they are short, and they are the reason
      // someone opened this output.
      const turnError = (turn as { error?: string | null }).error
      if (turnError) console.log(`    turn error: ${turnError}`)
    }
  }
}

/** Cases that errored during replay, as opposed to being judged `fail` by a human. */
export function countErroredCases(task: EvaluationTask): number {
  return (task.results ?? []).filter((r) => r.status === 'failed' || r.error).length
}

/**
 * Exit non-zero so CI fails on a broken evaluation.
 *
 * A failed/cancelled task is always an error. `--fail-on-fail` additionally
 * gates on two INDEPENDENT signals, and needs both:
 *
 *  - `summary.failed` counts **manual verdicts only** (`evaluation-runner.ts`
 *    buckets purely by `review.verdict`, and verdicts are manual in v1), so on a
 *    task that just finished it is always 0.
 *  - a case that errored during replay leaves `result.status === 'failed'` /
 *    `result.error`, but the server still settles the task as `completed` —
 *    per-case errors never demote it.
 *
 * Gating on the summary alone made the advertised CI gate dead code: a 50-case
 * run in which every case errored exited 0.
 */
function applyEvalExitCode(task: EvaluationTask, failOnFail: boolean): void {
  if (task.status === 'failed' || task.status === 'cancelled') {
    process.exitCode = 1
    return
  }
  if (!failOnFail) return
  if ((task.summary?.failed ?? 0) > 0 || countErroredCases(task) > 0) process.exitCode = 1
}
