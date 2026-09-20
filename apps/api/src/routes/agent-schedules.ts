/**
 * Schedule catalogue and manual rehearsal for the `schedule` publish channel.
 *
 * Lives outside routes/agents.ts to keep that file under the 3000-line gate;
 * both handlers are mounted onto the same `/agents` router, so the URL is
 * `/api/agents/:id/schedules[...]`.
 */
import type { Context, Hono } from 'hono'
import type { agents } from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import { AUDIT_ACTIONS } from '../lib/audit-actions.js'
import { AppError, NotFoundError } from '../lib/errors.js'
import {
  describeUnregistrable,
  fireSchedule,
  listSchedules,
  normalizeScheduleConfigs,
  type ScheduleConfigInput,
} from '../lib/schedule-trigger.js'

type AgentRow = typeof agents.$inferSelect
export type AgentGuard = (c: Context, id: string) => Promise<{ agent: AgentRow }>

/**
 * GET /agents/:id/schedules — the Agent's schedule entries as a flat list with
 * stable ids and the next firing time. Read-only, so no audit entry.
 */
export async function handleListAgentSchedules(
  c: Context,
  requireRead: AgentGuard,
): Promise<Response> {
  const { id } = c.req.param()
  const { agent } = await requireRead(c, id)
  return c.json({ data: listSchedules(agent.id, agent.scheduleConfig as ScheduleConfigInput) })
}

/**
 * POST /agents/:id/schedules/:scheduleId/run — fire one schedule entry now,
 * exactly as its cron would: same trigger source, channel context, run-as
 * identity and queue admission. Deliberately strict about eligibility — the
 * point is to rehearse the real thing, not to bypass publishing.
 */
export async function handleRunAgentSchedule(
  c: Context,
  requireWrite: AgentGuard,
): Promise<Response> {
  const { id, scheduleId } = c.req.param()
  const { agent } = await requireWrite(c, id)

  if (agent.publishStatus !== 'published') {
    throw new AppError(
      409,
      'Agent is not published; publish it with the schedule channel before rehearsing a schedule',
      'AGENT_NOT_PUBLISHED',
    )
  }
  if (!(agent.publishChannels ?? []).includes('schedule')) {
    throw new AppError(
      409,
      'The schedule channel is not enabled on this Agent',
      'SCHEDULE_CHANNEL_DISABLED',
    )
  }
  if (agent.status === 'inactive') {
    throw new AppError(409, 'Agent is inactive; schedules do not fire', 'AGENT_INACTIVE')
  }

  const config = agent.scheduleConfig as ScheduleConfigInput
  const matches = listSchedules(agent.id, config).filter((s) => s.id === scheduleId)
  const entry = matches[0]
  if (!entry) throw new NotFoundError('Schedule')
  // The shared schema now rejects duplicate ids, but configs persisted before
  // that rule can still carry them; firing "the first match" would run an intent
  // the caller did not pick.
  if (matches.length > 1) {
    throw new AppError(
      409,
      `Schedule id ${scheduleId} is shared by ${matches.length} entries; give each entry a unique \`id\` in scheduleConfig`,
      'SCHEDULE_ID_AMBIGUOUS',
    )
  }
  // A positional `<agentId>:<index>` id points at whichever entry currently sits
  // at that index, so a rehearsal addressed by it can silently fire a different
  // entry once the array is edited. Only a persisted id is safe to act on.
  if (!entry.stable) {
    throw new AppError(
      409,
      `Schedule ${scheduleId} has no persisted id; give the entry an \`id\` in scheduleConfig (the web publish tab mints one automatically, the CLI YAML accepts \`id:\`) and address it by that`,
      'SCHEDULE_ID_REQUIRED',
    )
  }
  // Fire only what the cron registrar would: an entry it skips must not produce
  // a run here, and an unknown timezone would otherwise throw from rendering.
  if (entry.nextRun === null) {
    throw new AppError(
      409,
      `Schedule ${scheduleId} is not registered and never fires: ${describeUnregistrable(entry)}`,
      'SCHEDULE_NOT_REGISTERED',
    )
  }

  const result = await fireSchedule(
    agent,
    normalizeScheduleConfigs(config)[entry.index],
    entry.index,
  )

  logAudit(c, {
    action: AUDIT_ACTIONS.AGENT_SCHEDULE_RUN,
    resource: 'agent',
    resourceId: agent.id,
    details: { scheduleId, runId: result.runId, status: result.status },
  })

  // Through the AppError envelope like the other 409s, so the CLI's ApiError
  // carries the body; the run id lives in the message because AppError has no
  // details payload.
  if (result.status === 'queue_full') {
    throw new AppError(
      409,
      `Agent queue is full; run ${result.runId} was recorded as failed`,
      'QUEUE_FULL',
    )
  }
  return c.json({ data: result }, 202)
}

/**
 * Mount both schedule routes on the agents router. Lives here rather than in
 * routes/agents.ts so that file (already at the file-lines gate) does not grow
 * by one line per route.
 */
export function registerAgentScheduleRoutes(
  app: Hono,
  guards: { read: AgentGuard; write: AgentGuard },
): void {
  app.get('/:id/schedules', (c) => handleListAgentSchedules(c, guards.read))
  app.post('/:id/schedules/:scheduleId/run', (c) => handleRunAgentSchedule(c, guards.write))
}
