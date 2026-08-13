import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EVALUATION_MAX_QUEUE_LENGTH,
  type EvaluationQueueDb,
  type EvaluationTaskRow,
  _resumeEvaluationQueuePromotionsForTests,
  pauseEvaluationQueuePromotions,
  recoverEvaluationsOnStartup,
  scheduleNextEvaluation,
  tryAcquireEvaluationSlot,
} from '../evaluation-queue.js'

beforeEach(() => {
  _resumeEvaluationQueuePromotionsForTests()
})

/**
 * In-memory stand-in for the evaluation tables. Holds just enough state for the
 * scheduler's decisions to be observable: a status per task and the insertion
 * order that decides FIFO promotion.
 */
function makeDb(
  tasks: Array<{ id: string; agentId: string; status: string }> = [],
  maxConcurrency = 2,
): EvaluationQueueDb & { tasks: typeof tasks; failed: Map<string, string> } {
  const failed = new Map<string, string>()
  return {
    tasks,
    failed,
    countTasksByStatus: async (agentId, status) =>
      tasks.filter((t) => t.agentId === agentId && t.status === status).length,
    getMaxConcurrency: () => maxConcurrency,
    updateTaskStatus: async (taskId, status) => {
      const row = tasks.find((t) => t.id === taskId)
      if (row) row.status = status
    },
    // Conditional claim: only the caller whose transition wins may execute.
    tryTransitionTaskStatus: async (taskId, from, to) => {
      const row = tasks.find((t) => t.id === taskId)
      if (!row || row.status !== from) return false
      row.status = to
      return true
    },
    getOldestQueuedTask: async (agentId) => {
      const row = tasks.find((t) => t.agentId === agentId && t.status === 'queued')
      return row ? { id: row.id, agentId: row.agentId } : undefined
    },
    getTasksByStatus: async (status) =>
      tasks
        .filter((t) => t.status === status)
        .map((t): EvaluationTaskRow => ({ id: t.id, agentId: t.agentId })),
    failTask: async (taskId, reason) => {
      failed.set(taskId, reason)
      const row = tasks.find((t) => t.id === taskId)
      if (row) row.status = 'failed'
    },
    getAgentIdsWithQueuedTasks: async () => [
      ...new Set(tasks.filter((t) => t.status === 'queued').map((t) => t.agentId)),
    ],
    claimQueuedTasks: async (agentId) => {
      const running = tasks.filter(
        (task) => task.agentId === agentId && task.status === 'running',
      ).length
      const available = Math.max(0, maxConcurrency - running)
      const claimed = tasks
        .filter((task) => task.agentId === agentId && task.status === 'queued')
        .slice(0, available)
      for (const task of claimed) task.status = 'running'
      return claimed.map(({ id, agentId: executingAgentId }) => ({
        id,
        agentId: executingAgentId,
      }))
    },
  }
}

describe('tryAcquireEvaluationSlot', () => {
  it('rejects new evaluations after graceful shutdown begins', async () => {
    const tasks = [{ id: 'evt_1', agentId: 'agt_a', status: 'pending' }]
    const db = makeDb(tasks, 1)
    pauseEvaluationQueuePromotions()

    expect(await tryAcquireEvaluationSlot(db, 'agt_a', 'evt_1')).toBe('queue_full')
    expect(tasks[0]?.status).toBe('pending')
  })

  it('runs immediately when the agent has a free slot', async () => {
    const db = makeDb([{ id: 'evt_1', agentId: 'agt_a', status: 'pending' }], 2)

    expect(await tryAcquireEvaluationSlot(db, 'agt_a', 'evt_1')).toBe('acquired')
    expect(db.tasks[0].status).toBe('running')
  })

  it('queues once the agent is at its concurrency limit', async () => {
    const db = makeDb(
      [
        { id: 'evt_1', agentId: 'agt_a', status: 'running' },
        { id: 'evt_2', agentId: 'agt_a', status: 'pending' },
      ],
      1,
    )

    expect(await tryAcquireEvaluationSlot(db, 'agt_a', 'evt_2')).toBe('queued')
    expect(db.tasks[1].status).toBe('queued')
  })

  it('counts slots per agent, so a busy agent never blocks another', async () => {
    const db = makeDb(
      [
        { id: 'evt_1', agentId: 'agt_a', status: 'running' },
        { id: 'evt_2', agentId: 'agt_b', status: 'pending' },
      ],
      1,
    )

    expect(await tryAcquireEvaluationSlot(db, 'agt_b', 'evt_2')).toBe('acquired')
    expect(db.tasks[1].status).toBe('running')
  })

  it('rejects once the queue is full rather than growing without bound', async () => {
    const tasks = [{ id: 'evt_run', agentId: 'agt_a', status: 'running' }]
    for (let i = 0; i < EVALUATION_MAX_QUEUE_LENGTH; i++) {
      tasks.push({ id: `evt_q${i}`, agentId: 'agt_a', status: 'queued' })
    }
    tasks.push({ id: 'evt_new', agentId: 'agt_a', status: 'pending' })
    const db = makeDb(tasks, 1)

    expect(await tryAcquireEvaluationSlot(db, 'agt_a', 'evt_new')).toBe('queue_full')
    expect(db.tasks.at(-1)?.status).toBe('pending')
  })
})

describe('tryAcquireEvaluationSlot — concurrent submissions', () => {
  /**
   * Two submissions racing for one per-agent slot.
   *
   * This is the case the first fix missed. A compare-and-set on the task row
   * cannot close it: each submission inserts its OWN task id, so the two CAS
   * updates touch different rows and both succeed. The invariant is per-AGENT
   * ("how many tasks are running"), not per-task, which is why the acquire path
   * is serialised with a keyed lock.
   *
   * It has to be a genuine race — `Promise.all`, not sequential calls — because
   * the bug lives entirely in the await window between counting and claiming.
   * Every sequential test passed against the broken version.
   */
  it('hands the single slot to exactly one of two concurrent submissions', async () => {
    const db = makeDb(
      [
        { id: 'evt_1', agentId: 'agt_a', status: 'pending' },
        { id: 'evt_2', agentId: 'agt_a', status: 'pending' },
      ],
      1,
    )

    const results = await Promise.all([
      tryAcquireEvaluationSlot(db, 'agt_a', 'evt_1'),
      tryAcquireEvaluationSlot(db, 'agt_a', 'evt_2'),
    ])

    expect(results.filter((r) => r === 'acquired')).toHaveLength(1)
    expect(results.filter((r) => r === 'queued')).toHaveLength(1)
    expect(db.tasks.filter((t) => t.status === 'running')).toHaveLength(1)
  })

  it('respects a concurrency budget above one', async () => {
    const db = makeDb(
      [
        { id: 'evt_1', agentId: 'agt_a', status: 'pending' },
        { id: 'evt_2', agentId: 'agt_a', status: 'pending' },
        { id: 'evt_3', agentId: 'agt_a', status: 'pending' },
      ],
      2,
    )

    const results = await Promise.all([
      tryAcquireEvaluationSlot(db, 'agt_a', 'evt_1'),
      tryAcquireEvaluationSlot(db, 'agt_a', 'evt_2'),
      tryAcquireEvaluationSlot(db, 'agt_a', 'evt_3'),
    ])

    expect(results.filter((r) => r === 'acquired')).toHaveLength(2)
    expect(db.tasks.filter((t) => t.status === 'running')).toHaveLength(2)
  })

  it('does not serialise across different agents', async () => {
    // The lock key is per agent, so one agent's queue must not block another's.
    const db = makeDb(
      [
        { id: 'evt_1', agentId: 'agt_a', status: 'pending' },
        { id: 'evt_2', agentId: 'agt_b', status: 'pending' },
      ],
      1,
    )

    const results = await Promise.all([
      tryAcquireEvaluationSlot(db, 'agt_a', 'evt_1'),
      tryAcquireEvaluationSlot(db, 'agt_b', 'evt_2'),
    ])

    expect(results).toEqual(['acquired', 'acquired'])
  })
})

describe('scheduleNextEvaluation', () => {
  it('uses the database-serialized promotion path before starting work', async () => {
    const db = makeDb([], 1)
    const claimQueuedTasks = vi.fn().mockResolvedValue([{ id: 'evt_1', agentId: 'agt_a' }])
    db.claimQueuedTasks = claimQueuedTasks
    db.getOldestQueuedTask = vi.fn(db.getOldestQueuedTask)
    const onExecute = vi.fn()

    expect(await scheduleNextEvaluation(db, 'agt_a', onExecute)).toBe(1)

    expect(claimQueuedTasks).toHaveBeenCalledWith('agt_a')
    expect(db.getOldestQueuedTask).not.toHaveBeenCalled()
    expect(onExecute).toHaveBeenCalledWith('evt_1', 'agt_a')
  })

  it('does not promote queued evaluations after graceful shutdown begins', async () => {
    const tasks = [{ id: 'evt_1', agentId: 'agt_a', status: 'queued' }]
    const db = makeDb(tasks, 1)
    pauseEvaluationQueuePromotions()

    expect(await scheduleNextEvaluation(db, 'agt_a', vi.fn())).toBe(0)
    expect(tasks[0]?.status).toBe('queued')
  })

  it('promotes queued tasks up to the concurrency limit', async () => {
    const db = makeDb(
      [
        { id: 'evt_1', agentId: 'agt_a', status: 'queued' },
        { id: 'evt_2', agentId: 'agt_a', status: 'queued' },
        { id: 'evt_3', agentId: 'agt_a', status: 'queued' },
      ],
      2,
    )
    const onExecute = vi.fn()

    expect(await scheduleNextEvaluation(db, 'agt_a', onExecute)).toBe(2)
    expect(onExecute).toHaveBeenCalledTimes(2)
    expect(db.tasks.map((t) => t.status)).toEqual(['running', 'running', 'queued'])
  })

  it('promotes nothing while the agent is already saturated', async () => {
    const db = makeDb(
      [
        { id: 'evt_1', agentId: 'agt_a', status: 'running' },
        { id: 'evt_2', agentId: 'agt_a', status: 'queued' },
      ],
      1,
    )
    const onExecute = vi.fn()

    expect(await scheduleNextEvaluation(db, 'agt_a', onExecute)).toBe(0)
    expect(onExecute).not.toHaveBeenCalled()
  })

  it('stops cleanly when the queue is empty', async () => {
    const db = makeDb([{ id: 'evt_1', agentId: 'agt_a', status: 'completed' }], 2)

    expect(await scheduleNextEvaluation(db, 'agt_a', vi.fn())).toBe(0)
  })
})

describe('recoverEvaluationsOnStartup', () => {
  it('fails tasks stranded mid-execution by the restart', async () => {
    const db = makeDb(
      [
        { id: 'evt_1', agentId: 'agt_a', status: 'running' },
        { id: 'evt_2', agentId: 'agt_a', status: 'pending' },
      ],
      2,
    )

    const stats = await recoverEvaluationsOnStartup(db, vi.fn())

    expect((await stats).runningAborted).toBe(1)
    expect((await stats).pendingAborted).toBe(1)
    expect(db.tasks[0].status).toBe('failed')
    expect(db.failed.get('evt_1')).toMatch(/restart/i)
  })

  it('releases recovered workload leases after failing interrupted tasks', async () => {
    const db = makeDb(
      [
        { id: 'evt_running', agentId: 'agt_a', status: 'running' },
        { id: 'evt_pending', agentId: 'agt_a', status: 'pending' },
      ],
      1,
    )
    const onTaskFailed = vi.fn()

    await recoverEvaluationsOnStartup(db, vi.fn(), { onTaskFailed })

    expect(onTaskFailed).toHaveBeenCalledTimes(2)
    expect(onTaskFailed).toHaveBeenNthCalledWith(1, {
      id: 'evt_running',
      agentId: 'agt_a',
    })
    expect(onTaskFailed).toHaveBeenNthCalledWith(2, {
      id: 'evt_pending',
      agentId: 'agt_a',
    })
  })

  it('re-runs tasks that were still waiting in the queue', async () => {
    const db = makeDb([{ id: 'evt_1', agentId: 'agt_a', status: 'queued' }], 2)
    const onExecute = vi.fn()

    const stats = await recoverEvaluationsOnStartup(db, onExecute)

    expect((await stats).queuedPromoted).toBe(1)
    expect(onExecute).toHaveBeenCalledWith('evt_1', 'agt_a')
    expect(db.tasks[0].status).toBe('running')
  })

  it('preserves in-flight tasks that may belong to another PostgreSQL replica', async () => {
    const db = makeDb(
      [
        { id: 'evt_running', agentId: 'agt_a', status: 'running' },
        { id: 'evt_pending', agentId: 'agt_a', status: 'pending' },
      ],
      2,
    )

    const onTaskFailed = vi.fn()
    const stats = await recoverEvaluationsOnStartup(db, vi.fn(), {
      recoverInFlight: false,
      onTaskFailed,
    })

    expect(stats).toEqual({ runningAborted: 0, pendingAborted: 0, queuedPromoted: 0 })
    expect(db.tasks.map((task) => task.status)).toEqual(['running', 'pending'])
    expect(onTaskFailed).not.toHaveBeenCalled()
  })

  it('leaves finished tasks untouched', async () => {
    const db = makeDb(
      [
        { id: 'evt_1', agentId: 'agt_a', status: 'completed' },
        { id: 'evt_2', agentId: 'agt_a', status: 'cancelled' },
      ],
      2,
    )

    const stats = await recoverEvaluationsOnStartup(db, vi.fn())

    expect(stats).toEqual({ runningAborted: 0, pendingAborted: 0, queuedPromoted: 0 })
    expect(db.tasks.map((t) => t.status)).toEqual(['completed', 'cancelled'])
  })
})
