import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fireSchedule: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: mocks.audit }))
vi.mock('../../lib/schedule-trigger.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fireSchedule: mocks.fireSchedule,
}))
vi.mock('../../db/client.js', () => ({ db: {} }))
vi.mock('../../engine/task-queue.js', () => ({ tryAcquireSlot: vi.fn() }))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))
vi.mock('../../lib/execute-chat-run.js', () => ({ executeChatRun: vi.fn() }))
vi.mock('../../lib/pending-job-registry.js', () => ({ registerPendingContext: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import type { agents } from '../../db/schema.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import {
  type AgentGuard,
  handleListAgentSchedules,
  handleRunAgentSchedule,
  registerAgentScheduleRoutes,
} from '../agent-schedules.js'

type AgentRow = typeof agents.$inferSelect

/** Mirrors the global onError in index.ts, which maps AppError to its status. */
const withErrorMapping = (app: Hono) =>
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json({ error: err.message, code: err.code }, err.statusCode as 403)
      : c.json({ error: 'Internal Server Error' }, 500),
  )

const publishedAgent = {
  id: 'agt_1',
  userId: 'usr_owner',
  status: 'active',
  publishStatus: 'published',
  publishChannels: ['api', 'schedule'],
  scheduleConfig: [
    { id: 'sch_morning', cron: '0 9 * * *', intent: 'Morning {{date}}', timezone: 'UTC' },
    { cron: '0 18 * * *', intent: 'Evening' },
  ],
} as unknown as AgentRow & { scheduleConfig: Array<{ cron: string; intent: string }> }

const guard = (result: { agent: AgentRow }) => vi.fn<AgentGuard>().mockResolvedValue(result)
const denying = (err: Error) => vi.fn<AgentGuard>().mockRejectedValue(err)

function listApp(guard: AgentGuard) {
  return withErrorMapping(
    new Hono().get('/agents/:id/schedules', (c) => handleListAgentSchedules(c, guard)),
  )
}

function runApp(guard: AgentGuard) {
  return withErrorMapping(
    new Hono().post('/agents/:id/schedules/:scheduleId/run', (c) =>
      handleRunAgentSchedule(c, guard),
    ),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /agents/:id/schedules', () => {
  it('lists the normalized schedule entries for a reader', async () => {
    const allow = guard({ agent: publishedAgent })

    const res = await listApp(allow).request('/agents/agt_1/schedules')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(allow).toHaveBeenCalledWith(expect.anything(), 'agt_1')
    expect(body.data).toEqual([
      {
        id: 'sch_morning',
        index: 0,
        cron: '0 9 * * *',
        timezone: 'UTC',
        intent: 'Morning {{date}}',
        nextRun: expect.stringMatching(/T09:00:00\.000Z$/),
        stable: true,
      },
      {
        id: 'agt_1:1',
        index: 1,
        cron: '0 18 * * *',
        timezone: 'Asia/Shanghai',
        intent: 'Evening',
        nextRun: expect.stringMatching(/T10:00:00\.000Z$/),
        stable: false,
      },
    ])
  })

  it('returns an empty list when the agent has no schedule config', async () => {
    const allow = guard({ agent: { ...publishedAgent, scheduleConfig: null } })

    const res = await listApp(allow).request('/agents/agt_1/schedules')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [] })
  })

  it('propagates the read guard denial', async () => {
    const denied = denying(new NotFoundError('Agent'))

    const res = await listApp(denied).request('/agents/agt_missing/schedules')

    expect(res.status).toBe(404)
  })
})

describe('POST /agents/:id/schedules/:scheduleId/run', () => {
  it('fires the schedule through the shared cron path and audits it', async () => {
    const allow = guard({ agent: publishedAgent })
    mocks.fireSchedule.mockResolvedValue({
      runId: 'run_1',
      status: 'pending',
      intent: 'Morning 2026-09-14',
    })

    const res = await runApp(allow).request('/agents/agt_1/schedules/sch_morning/run', {
      method: 'POST',
    })

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({
      data: { runId: 'run_1', status: 'pending', intent: 'Morning 2026-09-14' },
    })
    expect(mocks.fireSchedule).toHaveBeenCalledWith(
      publishedAgent,
      publishedAgent.scheduleConfig[0],
      0,
    )
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), {
      action: 'agent.schedule_run',
      resource: 'agent',
      resourceId: 'agt_1',
      details: { scheduleId: 'sch_morning', runId: 'run_1', status: 'pending' },
    })
    const details = mocks.audit.mock.calls[0][1].details
    expect(JSON.stringify(details)).not.toContain('Morning')
  })

  it('refuses a positional <agentId>:<index> id with SCHEDULE_ID_REQUIRED instead of firing', async () => {
    // The positional fallback silently re-targets a different entry once the
    // array is edited, so a rehearsal must address a persisted id only.
    const allow = guard({ agent: publishedAgent })

    const res = await runApp(allow).request('/agents/agt_1/schedules/agt_1:1/run', {
      method: 'POST',
    })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('SCHEDULE_ID_REQUIRED')
    expect(body.error).toContain('agt_1:1')
    expect(body.error).toContain('scheduleConfig')
    expect(mocks.fireSchedule).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it.each([
    [
      'timezone',
      { id: 'sch_tz', cron: '0 9 * * *', intent: 'x', timezone: 'Asia/Shangai' },
      /timezone/,
    ],
    ['cron', { id: 'sch_cron', cron: '0 7/12 * * *', intent: 'x', timezone: 'UTC' }, /cron/],
  ])(
    '409s with SCHEDULE_NOT_REGISTERED for an entry the cron registrar skips (invalid %s)',
    async (_label, entry, reason) => {
      const allow = guard({
        agent: { ...publishedAgent, scheduleConfig: [entry] } as unknown as AgentRow,
      })

      const res = await runApp(allow).request(`/agents/agt_1/schedules/${entry.id}/run`, {
        method: 'POST',
      })

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.code).toBe('SCHEDULE_NOT_REGISTERED')
      expect(body.error).toContain(entry.id)
      expect(body.error).toMatch(reason)
      expect(mocks.fireSchedule).not.toHaveBeenCalled()
      expect(mocks.audit).not.toHaveBeenCalled()
    },
  )

  it('404s on an unknown schedule id without firing', async () => {
    const allow = guard({ agent: publishedAgent })

    const res = await runApp(allow).request('/agents/agt_1/schedules/sch_nope/run', {
      method: 'POST',
    })

    expect(res.status).toBe(404)
    expect(mocks.fireSchedule).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it.each([
    ['not published', { ...publishedAgent, publishStatus: 'draft' as const }],
    ['schedule channel disabled', { ...publishedAgent, publishChannels: ['api' as const] }],
    ['inactive', { ...publishedAgent, status: 'inactive' as const }],
  ])('409s when the agent is %s', async (_label, agent) => {
    const allow = guard({ agent })

    const res = await runApp(allow).request('/agents/agt_1/schedules/sch_morning/run', {
      method: 'POST',
    })

    expect(res.status).toBe(409)
    expect(mocks.fireSchedule).not.toHaveBeenCalled()
  })

  it('409s with the run id when the queue is full', async () => {
    const allow = guard({ agent: publishedAgent })
    mocks.fireSchedule.mockResolvedValue({ runId: 'run_3', status: 'queue_full', intent: 'x' })

    const res = await runApp(allow).request('/agents/agt_1/schedules/sch_morning/run', {
      method: 'POST',
    })

    expect(res.status).toBe(409)
    // Goes through the AppError envelope so the CLI's ApiError shows the run id.
    const body = await res.json()
    expect(body.code).toBe('QUEUE_FULL')
    expect(body.error).toContain('run_3')
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ status: 'queue_full' }) }),
    )
  })

  it('does not fire or audit when the write guard denies the caller', async () => {
    const denied = denying(new ForbiddenError('Write access required'))

    const res = await runApp(denied).request('/agents/agt_1/schedules/sch_morning/run', {
      method: 'POST',
    })

    expect(res.status).toBe(403)
    expect(mocks.fireSchedule).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})

describe('registerAgentScheduleRoutes', () => {
  it('mounts the list route with the read guard and the run route with the write guard', async () => {
    const calls: string[] = []
    const guardFor =
      (label: string) =>
      async (_c: unknown, _id: string): Promise<never> => {
        calls.push(label)
        throw new ForbiddenError(`${label} guard`)
      }
    const app = new Hono()
    registerAgentScheduleRoutes(app, { read: guardFor('read'), write: guardFor('write') })

    await app.request('/agt_1/schedules')
    await app.request('/agt_1/schedules/sch_1/run', { method: 'POST' })

    expect(calls).toEqual(['read', 'write'])
  })
})
