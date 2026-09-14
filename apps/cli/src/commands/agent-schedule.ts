/**
 * `agents schedule` — inspect and rehearse an Agent's schedule entries.
 *
 * An Agent may carry many `{ cron, intent, timezone }` entries, each with
 * `{{date}}` / `{{time}}` / `{{iso}}` placeholders. Before this command the only
 * way to try one was to hand-copy the intent into `chat send` — which ran it
 * through the `debug` channel, not the `schedule` channel the cron actually
 * uses. `run` goes through the server's real schedule path; `--dry-run` shows
 * what the rendered intent would be without creating a run.
 */
import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { emit, jsonArg } from '../lib/output.js'

interface ScheduleEntry {
  id: string
  index: number
  cron: string
  timezone: string
  intent: string
  nextRun: string | null
}

interface ScheduleRunResult {
  runId: string
  status: 'pending' | 'queued'
  intent: string
}

const INTENT_PREVIEW_CHARS = 60

/**
 * Render the intent placeholders the same way the server does when a schedule
 * fires: `{{date}}` → YYYY-MM-DD and `{{time}}` → HH:mm in the schedule's
 * timezone, `{{iso}}` → the UTC instant. Mirrors `renderIntent` in
 * apps/api/src/lib/schedule-trigger.ts — the CLI ships standalone and cannot
 * import it.
 */
export function renderScheduleIntent(template: string, timezone: string, now: Date): string {
  const dateStr = now.toLocaleDateString('sv-SE', { timeZone: timezone })
  const timeStr = now.toLocaleTimeString('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return template
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{time\}\}/g, timeStr)
    .replace(/\{\{iso\}\}/g, now.toISOString())
}

function previewIntent(intent: string): string {
  const oneLine = intent.replace(/\s+/g, ' ').trim()
  return oneLine.length > INTENT_PREVIEW_CHARS
    ? `${oneLine.slice(0, INTENT_PREVIEW_CHARS)}…`
    : oneLine
}

const agentArg = {
  agent: { type: 'positional' as const, description: 'Agent ID or name', required: true },
}

export const agentScheduleCommand = defineCommand({
  meta: { name: 'schedule', description: 'Inspect and rehearse Agent schedule entries' },
  subCommands: {
    list: defineCommand({
      meta: {
        name: 'list',
        description: 'List schedule entries with their id, cron, timezone and next run',
        agentMeta: {
          risk: 'read',
          examples: [
            'a2wave agents schedule list my-agent',
            'a2wave agents schedule list agt_x --json',
          ],
        },
      },
      args: { ...agentArg, ...jsonArg, ...urlArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.agent as string)
        const result = await client.get<{ data: ScheduleEntry[] }>(
          `/api/agents/${agentId}/schedules`,
        )
        if (emit(args, result)) return
        if (result.data.length === 0) {
          console.log('No schedules configured')
          return
        }
        console.log('ID  CRON  TIMEZONE  NEXT RUN  INTENT')
        for (const s of result.data) {
          console.log(
            `${s.id}  ${s.cron}  ${s.timezone}  ${s.nextRun ?? '-'}  ${previewIntent(s.intent)}`,
          )
        }
      },
    }),

    run: defineCommand({
      meta: {
        name: 'run',
        description:
          'Fire one schedule entry now through the real schedule channel (--dry-run only renders the intent)',
        agentMeta: {
          risk: 'write',
          preconditions: ['The Agent is published with the schedule channel enabled'],
          notFor: ['Trying an intent that is not a schedule entry — use `chat send` for that'],
          examples: [
            'a2wave agents schedule run my-agent sch_morning --dry-run',
            'a2wave agents schedule run my-agent sch_morning',
          ],
        },
      },
      args: {
        ...agentArg,
        scheduleId: {
          type: 'positional',
          description: 'Schedule ID (see `agents schedule list`)',
          required: true,
        },
        'dry-run': {
          type: 'boolean',
          description: 'Print the intent with placeholders rendered; do not create a run',
        },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.agent as string)
        const scheduleId = args.scheduleId as string

        if (args['dry-run'] === true) {
          const { data } = await client.get<{ data: ScheduleEntry[] }>(
            `/api/agents/${agentId}/schedules`,
          )
          const schedule = data.find((s) => s.id === scheduleId)
          if (!schedule) {
            throw new CliError(`Schedule not found: ${scheduleId}`, {
              type: 'not_found',
              hint: `a2wave agents schedule list ${agentId}`,
            })
          }
          const intent = renderScheduleIntent(schedule.intent, schedule.timezone, new Date())
          if (emit(args, { data: { ...schedule, intent, dryRun: true } })) return
          console.log(`Schedule:  ${schedule.id}  (${schedule.cron}, ${schedule.timezone})`)
          console.log('Rendered intent (dry run, no run created):')
          console.log(intent)
          return
        }

        const result = await client.post<{ data: ScheduleRunResult }>(
          `/api/agents/${agentId}/schedules/${encodeURIComponent(scheduleId)}/run`,
          {},
        )
        if (emit(args, result)) return
        const { runId, status } = result.data
        console.log(`Run created: ${runId}  (${status})`)
        console.log(`Follow it with: a2wave runs get ${runId}`)
      },
    }),
  },
})
