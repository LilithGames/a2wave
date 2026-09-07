import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

const mockDbSelectAll = vi.hoisted(() => vi.fn())
const mockDbSelectGet = vi.hoisted(() => vi.fn())
const mockDbInsertRun = vi.hoisted(() => vi.fn())
const mockDbInsertValues = vi.hoisted(() => vi.fn())
const mockDbUpdateRun = vi.hoisted(() => vi.fn())
const mockTryAcquireSlot = vi.hoisted(() => vi.fn())
const mockExecuteChatRun = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockRegisterPendingContext = vi.hoisted(() => vi.fn())

vi.mock('croner', () => {
  class FakeCron {
    callback: (() => void) | undefined
    stopped = false
    constructor(pattern: string, opts: { timezone?: string } | undefined, cb?: () => void) {
      if (!pattern || !/^(\S+\s+){4}\S+$/.test(pattern.trim())) {
        throw new Error(`Invalid cron pattern: ${pattern}`)
      }
      // Mirrors croner: an unknown IANA name throws synchronously from the constructor.
      if (opts?.timezone === 'Asia/Shangai') {
        throw new Error("Failed to convert date to timezone 'Asia/Shangai'")
      }
      if (pattern.trim() === '0 7/12 * * *') {
        throw new Error(
          "CronPattern: Syntax error, stepping with numeric prefix ('7/12') is not allowed",
        )
      }
      this.callback = cb
    }
    stop() {
      this.stopped = true
    }
  }
  return { Cron: FakeCron }
})

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () =>
        asyncQuery({
          where: () =>
            asyncQuery({
              all: mockDbSelectAll,
              get: mockDbSelectGet,
            }),
        }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        mockDbInsertValues(v)
        return asyncQuery({ run: mockDbInsertRun })
      },
    }),
    update: () => ({
      set: () =>
        asyncQuery({
          where: () =>
            asyncQuery({
              run: mockDbUpdateRun,
            }),
        }),
    }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: {
    id: 'id',
    publishStatus: 'publish_status',
    publishChannels: 'publish_channels',
    scheduleConfig: 'schedule_config',
    status: 'status',
    maxConcurrency: 'max_concurrency',
  },
  runs: { id: 'id' },
  users: { id: 'id', email: 'email', idaasSub: 'idaas_sub', displayName: 'display_name' },
}))

vi.mock('../pending-job-registry.js', () => ({
  registerPendingContext: mockRegisterPendingContext,
}))

vi.mock('../id.js', () => ({
  createId: (prefix: string) => `${prefix}_test123`,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: mockTryAcquireSlot,
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

vi.mock('../execute-chat-run.js', () => ({
  executeChatRun: mockExecuteChatRun,
}))

describe('renderIntent', () => {
  it('replaces {{date}}, {{time}}, and {{iso}} template variables', async () => {
    const { renderIntent } = await import('../schedule-trigger.js')
    const result = renderIntent(
      'Daily review on {{date}} at {{time}}, iso: {{iso}}',
      'Asia/Shanghai',
    )
    expect(result).toMatch(
      /Daily review on \d{4}-\d{2}-\d{2} at \d{2}:\d{2}, iso: \d{4}-\d{2}-\d{2}T/,
    )
  })

  it('returns template unchanged when no variables present', async () => {
    const { renderIntent } = await import('../schedule-trigger.js')
    expect(renderIntent('No variables here', 'UTC')).toBe('No variables here')
  })

  it('uses the specified timezone for formatting', async () => {
    const { renderIntent } = await import('../schedule-trigger.js')
    const utcResult = renderIntent('{{time}}', 'UTC')
    expect(utcResult).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('isValidCron', () => {
  it('accepts valid 5-field cron expressions', async () => {
    const { isValidCron } = await import('../schedule-trigger.js')
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('*/30 * * * *')).toBe(true)
    expect(isValidCron('0 10 * * 1')).toBe(true)
    expect(isValidCron('0 0 1 * *')).toBe(true)
    expect(isValidCron('0 7,19 * * *')).toBe(true)
    expect(isValidCron('0 7-23/12 * * *')).toBe(true)
  })

  it('rejects invalid cron expressions', async () => {
    const { isValidCron } = await import('../schedule-trigger.js')
    expect(isValidCron('')).toBe(false)
    expect(isValidCron('not a cron')).toBe(false)
    expect(isValidCron('0 7/12 * * *')).toBe(false)
  })
})

describe('ScheduleTriggerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbSelectAll.mockReturnValue([])
    mockDbSelectGet.mockReturnValue(null)
  })

  it('start registers a cron job and stop removes it', async () => {
    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    const config = { cron: '0 9 * * *', intent: 'test', timezone: 'UTC' }

    scheduleTriggerManager.start('agt_1', config)
    expect(scheduleTriggerManager.getActiveAgentIds()).toContain('agt_1')

    scheduleTriggerManager.stop('agt_1')
    expect(scheduleTriggerManager.getActiveAgentIds()).not.toContain('agt_1')
  })

  it('start registers multiple cron jobs for the same agent', async () => {
    const { scheduleTriggerManager } = await import('../schedule-trigger.js')

    scheduleTriggerManager.start('agt_1', [
      { cron: '0 9 * * *', intent: 'first' },
      { cron: '0 10 * * *', intent: 'second' },
    ])
    expect(scheduleTriggerManager.getActiveAgentIds()).toContain('agt_1')
    expect(await getInternalJobs('agt_1')).toHaveLength(2)

    scheduleTriggerManager.stop('agt_1')
  })

  it('stopAll stops all registered jobs', async () => {
    const { scheduleTriggerManager } = await import('../schedule-trigger.js')

    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'a' })
    scheduleTriggerManager.start('agt_2', { cron: '0 10 * * *', intent: 'b' })
    expect(scheduleTriggerManager.getActiveAgentIds()).toHaveLength(2)

    scheduleTriggerManager.stopAll()
    expect(scheduleTriggerManager.getActiveAgentIds()).toHaveLength(0)
  })

  it('restoreAll registers crons for published agents with schedule channel', async () => {
    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()

    mockDbSelectAll.mockReturnValue([
      {
        id: 'agt_pub',
        publishStatus: 'published',
        publishChannels: ['api', 'schedule'],
        scheduleConfig: [
          { cron: '0 9 * * *', intent: 'daily' },
          { cron: '0 18 * * *', intent: 'evening' },
        ],
      },
      {
        id: 'agt_no_schedule',
        publishStatus: 'published',
        publishChannels: ['api'],
        scheduleConfig: null,
      },
    ])

    await scheduleTriggerManager.restoreAll()
    expect(scheduleTriggerManager.getActiveAgentIds()).toContain('agt_pub')
    expect(scheduleTriggerManager.getActiveAgentIds()).not.toContain('agt_no_schedule')
    expect(await getInternalJobs('agt_pub')).toHaveLength(2)

    scheduleTriggerManager.stopAll()
  })

  it('start skips a schedule whose timezone croner rejects and keeps the valid ones', async () => {
    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()

    expect(() =>
      scheduleTriggerManager.start('agt_1', [
        { cron: '0 9 * * *', intent: 'bad tz', timezone: 'Asia/Shangai' },
        { cron: '0 18 * * *', intent: 'good tz', timezone: 'Asia/Shanghai' },
      ]),
    ).not.toThrow()

    expect(scheduleTriggerManager.getActiveAgentIds()).toContain('agt_1')
    expect(await getInternalJobs('agt_1')).toHaveLength(1)

    scheduleTriggerManager.stopAll()
  })

  it('restoreAll keeps restoring later agents when one agent throws', async () => {
    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()

    mockDbSelectAll.mockReturnValue([
      {
        id: 'agt_bad',
        publishStatus: 'published',
        publishChannels: ['schedule'],
        // A non-array, non-object config makes `normalizeScheduleConfigs` yield a
        // primitive and `start` throw — standing in for any per-agent failure.
        scheduleConfig: 'not-a-schedule-config',
      },
      {
        id: 'agt_good',
        publishStatus: 'published',
        publishChannels: ['schedule'],
        scheduleConfig: [{ cron: '0 9 * * *', intent: 'daily' }],
      },
    ])

    await expect(scheduleTriggerManager.restoreAll()).resolves.toBeUndefined()
    expect(scheduleTriggerManager.getActiveAgentIds()).toContain('agt_good')
    expect(scheduleTriggerManager.getActiveAgentIds()).not.toContain('agt_bad')

    scheduleTriggerManager.stopAll()
  })

  it('stop is a no-op for unregistered agent', async () => {
    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    expect(() => scheduleTriggerManager.stop('agt_nonexistent')).not.toThrow()
  })
})

type InternalJob = { callback: () => void | Promise<void>; stopped: boolean }

/**
 * Fire a cron callback and wait for the run it kicks off to finish.
 *
 * The production callback is `() => { this.triggerRun(...).catch(...) }` — it returns
 * void, so awaiting it settles immediately. Every DB read inside `triggerRun` is now
 * awaited, so the work spans several microtask turns; draining the queue here is what
 * makes the assertions below observe the completed trigger rather than a half-run one.
 */
async function runJobCallback(job: InternalJob): Promise<void> {
  await job.callback()
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function getInternalJob(agentId: string): Promise<InternalJob> {
  return (await getInternalJobs(agentId))[0]
}

async function getInternalJobs(agentId: string): Promise<InternalJob[]> {
  const { scheduleTriggerManager } = await import('../schedule-trigger.js')
  const internal = scheduleTriggerManager as unknown as { jobs: Map<string, InternalJob[]> }
  const jobs = internal.jobs.get(agentId)
  if (!jobs) throw new Error(`Internal jobs for ${agentId} not registered`)
  return jobs
}

describe('triggerRun (via cron callback)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips when agent is not published', async () => {
    mockDbSelectGet.mockReturnValue({
      id: 'agt_1',
      publishStatus: 'draft',
      status: 'active',
      maxConcurrency: 1,
    })

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'test' })

    const job = await getInternalJob('agt_1')
    await runJobCallback(job)

    expect(mockDbInsertRun).not.toHaveBeenCalled()
    scheduleTriggerManager.stopAll()
  })

  it('skips when agent is inactive', async () => {
    mockDbSelectGet.mockReturnValue({
      id: 'agt_1',
      publishStatus: 'published',
      status: 'inactive',
      maxConcurrency: 1,
    })

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'test' })

    const job = await getInternalJob('agt_1')
    await runJobCallback(job)

    expect(mockDbInsertRun).not.toHaveBeenCalled()
    scheduleTriggerManager.stopAll()
  })

  it('creates a run and calls executeChatRun when slot acquired', async () => {
    mockDbSelectGet.mockReturnValue({
      id: 'agt_1',
      publishStatus: 'published',
      status: 'active',
      maxConcurrency: 1,
    })
    mockTryAcquireSlot.mockReturnValue('acquired')

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'Review {{date}}' })

    const job = await getInternalJob('agt_1')
    await runJobCallback(job)

    expect(mockDbInsertRun).toHaveBeenCalled()
    expect(mockExecuteChatRun).toHaveBeenCalledWith('agt_1', 'run_test123')
    scheduleTriggerManager.stopAll()
  })

  it('uses persisted schedule id in channel context', async () => {
    mockDbSelectGet.mockReturnValue({
      id: 'agt_1',
      publishStatus: 'published',
      status: 'active',
      maxConcurrency: 1,
    })
    mockTryAcquireSlot.mockReturnValue('queued')

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', {
      id: 'sch_morning',
      cron: '0 9 * * *',
      intent: 'test',
    })

    const job = await getInternalJob('agt_1')
    await runJobCallback(job)

    expect(mockRegisterPendingContext).toHaveBeenCalledWith(
      'run_test123',
      expect.objectContaining({
        channel: expect.objectContaining({
          channel_type: 'schedule',
          channel_info: expect.objectContaining({ schedule_id: 'sch_morning' }),
        }),
      }),
    )
    scheduleTriggerManager.stopAll()
  })

  it('marks run as failed when queue is full', async () => {
    mockDbSelectGet.mockReturnValue({
      id: 'agt_1',
      publishStatus: 'published',
      status: 'active',
      maxConcurrency: 1,
    })
    mockTryAcquireSlot.mockReturnValue('queue_full')

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'test' })

    const job = await getInternalJob('agt_1')
    await runJobCallback(job)

    expect(mockDbInsertRun).toHaveBeenCalled()
    expect(mockDbUpdateRun).toHaveBeenCalled()
    expect(mockExecuteChatRun).not.toHaveBeenCalled()
    scheduleTriggerManager.stopAll()
  })

  it('does not call executeChatRun when run is queued', async () => {
    mockDbSelectGet.mockReturnValue({
      id: 'agt_1',
      publishStatus: 'published',
      status: 'active',
      maxConcurrency: 1,
    })
    mockTryAcquireSlot.mockReturnValue('queued')

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'test' })

    const job = await getInternalJob('agt_1')
    await runJobCallback(job)

    expect(mockDbInsertRun).toHaveBeenCalled()
    expect(mockExecuteChatRun).not.toHaveBeenCalled()
    scheduleTriggerManager.stopAll()
  })

  it('auto-stops cron job when agent is deleted', async () => {
    mockDbSelectGet.mockReturnValue(null)

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'test' })
    expect(scheduleTriggerManager.getActiveAgentIds()).toContain('agt_1')

    const job = await getInternalJob('agt_1')
    await runJobCallback(job)

    expect(scheduleTriggerManager.getActiveAgentIds()).not.toContain('agt_1')
    expect(mockDbInsertRun).not.toHaveBeenCalled()
  })

  it('auto-stops cron job when agent is no longer published', async () => {
    mockDbSelectGet.mockReturnValue({
      id: 'agt_1',
      publishStatus: 'stopped',
      status: 'active',
      maxConcurrency: 1,
    })

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'test' })
    expect(scheduleTriggerManager.getActiveAgentIds()).toContain('agt_1')

    const job = await getInternalJob('agt_1')
    await runJobCallback(job)

    expect(scheduleTriggerManager.getActiveAgentIds()).not.toContain('agt_1')
    expect(mockDbInsertRun).not.toHaveBeenCalled()
  })

  it('resolves the run-as user identity into the schedule channel when scheduleRunAsOwner is on', async () => {
    // 1st get → agent row; 2nd get → run-as user row
    mockDbSelectGet
      .mockReturnValueOnce({
        id: 'agt_1',
        publishStatus: 'published',
        status: 'active',
        maxConcurrency: 1,
        scheduleRunAsOwner: true,
        publishChannels: ['schedule'],
        scheduleRunAsUserId: 'usr_enabler',
      })
      .mockReturnValueOnce({
        id: 'usr_enabler',
        email: 'enabler@example.com',
        displayName: 'Enabler',
        idaasSub: 'sub_enabler',
        isActive: true,
      })
    mockTryAcquireSlot.mockReturnValue('acquired')

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'daily' })
    await runJobCallback(await getInternalJob('agt_1'))

    expect(mockRegisterPendingContext).toHaveBeenCalledTimes(1)
    const ctx = mockRegisterPendingContext.mock.calls[0][1].channel
    expect(ctx.channel_type).toBe('schedule')
    expect(ctx.user_info).toMatchObject({ email: 'enabler@example.com', source: 'idaas' })
    // run is attributed to the run-as user (resolution succeeded)
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_enabler' }),
    )
    scheduleTriggerManager.stopAll()
  })

  it('stays anonymous and attributes the run to the agent owner when the run-as user is inactive', async () => {
    mockDbSelectGet
      .mockReturnValueOnce({
        id: 'agt_1',
        publishStatus: 'published',
        status: 'active',
        maxConcurrency: 1,
        scheduleRunAsOwner: true,
        publishChannels: ['schedule'],
        scheduleRunAsUserId: 'usr_enabler',
        userId: 'usr_owner',
      })
      .mockReturnValueOnce({
        id: 'usr_enabler',
        email: 'enabler@example.com',
        displayName: 'Enabler',
        idaasSub: 'sub_enabler',
        isActive: false,
      })
    mockTryAcquireSlot.mockReturnValue('acquired')

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'daily' })
    await runJobCallback(await getInternalJob('agt_1'))

    const ctx = mockRegisterPendingContext.mock.calls[0][1].channel
    expect(ctx.user_info).toBeNull()
    // resolution failed → run must NOT be misattributed to the run-as user; falls back to owner
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_owner' }),
    )
    scheduleTriggerManager.stopAll()
  })

  it('stays anonymous when the run-as user has an email but no bound SSO identity (idaasSub)', async () => {
    mockDbSelectGet
      .mockReturnValueOnce({
        id: 'agt_1',
        publishStatus: 'published',
        status: 'active',
        maxConcurrency: 1,
        scheduleRunAsOwner: true,
        publishChannels: ['schedule'],
        scheduleRunAsUserId: 'usr_enabler',
      })
      .mockReturnValueOnce({
        id: 'usr_enabler',
        email: 'enabler@example.com',
        displayName: 'Enabler',
        idaasSub: null, // email present but never bound an SSO identity → must not sign
        isActive: true,
      })
    mockTryAcquireSlot.mockReturnValue('acquired')

    const { scheduleTriggerManager } = await import('../schedule-trigger.js')
    scheduleTriggerManager.stopAll()
    scheduleTriggerManager.start('agt_1', { cron: '0 9 * * *', intent: 'daily' })
    await runJobCallback(await getInternalJob('agt_1'))

    const ctx = mockRegisterPendingContext.mock.calls[0][1].channel
    expect(ctx.user_info).toBeNull()
    scheduleTriggerManager.stopAll()
  })
})
