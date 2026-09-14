import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `listSchedules` / `computeNextRun` use the real croner so the next-run
 * computation is what the cron registration itself will do. Everything that
 * would touch a database or the run queue is stubbed out.
 */
vi.mock('../../db/client.js', () => ({ db: {} }))
vi.mock('../../engine/task-queue.js', () => ({ tryAcquireSlot: vi.fn() }))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))
vi.mock('../execute-chat-run.js', () => ({ executeChatRun: vi.fn() }))
vi.mock('../pending-job-registry.js', () => ({ registerPendingContext: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { computeNextRun, listSchedules } = await import('../schedule-trigger.js')

describe('computeNextRun', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T08:30:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('evaluates the cron in the schedule timezone', () => {
    // 09:00 in Shanghai (UTC+8) is 01:00Z; at 08:30Z today, the next one is tomorrow.
    expect(computeNextRun('0 9 * * *', 'Asia/Shanghai')).toBe('2026-09-15T01:00:00.000Z')
    expect(computeNextRun('0 9 * * *', 'UTC')).toBe('2026-09-14T09:00:00.000Z')
  })

  it('returns null for an invalid cron or an unknown timezone', () => {
    expect(computeNextRun('not a cron', 'UTC')).toBeNull()
    expect(computeNextRun('0 9 * * *', 'Asia/Shangai')).toBeNull()
  })
})

describe('listSchedules', () => {
  it('normalizes a single object and an array, falling back to <agentId>:<index> ids', () => {
    expect(listSchedules('agt_1', { cron: '0 9 * * *', intent: 'one' })).toEqual([
      {
        id: 'agt_1:0',
        index: 0,
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        intent: 'one',
        nextRun: expect.any(String),
        stable: false,
      },
    ])
    const rows = listSchedules('agt_1', [
      { id: 'sch_a', cron: '0 9 * * *', intent: 'a', timezone: 'UTC' },
      { cron: 'bad', intent: 'b' },
    ])
    expect(rows.map((r) => [r.id, r.index, r.timezone, r.nextRun === null, r.stable])).toEqual([
      ['sch_a', 0, 'UTC', false, true],
      ['agt_1:1', 1, 'Asia/Shanghai', true, false],
    ])
  })

  it('marks an entry unregistrable for an unknown timezone even when the cron is fine', () => {
    const [row] = listSchedules('agt_1', [
      { id: 'sch_tz', cron: '0 9 * * *', intent: 'a', timezone: 'Asia/Shangai' },
    ])
    expect(row.nextRun).toBeNull()
    expect(row.stable).toBe(true)
  })

  it('returns an empty list for a missing config', () => {
    expect(listSchedules('agt_1', null)).toEqual([])
  })
})
