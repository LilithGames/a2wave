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
  fireSchedule,
  listSchedules,
  normalizeScheduleConfigs,
  resolveScheduleId,
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

  const schedules = normalizeScheduleConfigs(agent.scheduleConfig as ScheduleConfigInput)
  const index = schedules.findIndex(
    (schedule, i) => resolveScheduleId(agent.id, schedule, i) === scheduleId,
  )
  if (index < 0) throw new NotFoundError('Schedule')

  const result = await fireSchedule(agent, schedules[index], index)

  logAudit(c, {
    action: AUDIT_ACTIONS.AGENT_SCHEDULE_RUN,
    resource: 'agent',
    resourceId: agent.id,
    details: { scheduleId, runId: result.runId, status: result.status },
  })

  if (result.status === 'queue_full') {
    return c.json(
      {
        error: 'Agent queue is full; the run was recorded as failed',
        code: 'QUEUE_FULL',
        runId: result.runId,
      },
      409,
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
