import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetExecutionLeasesForTests,
  reserveExecutionLease,
} from '../../engine/execution-lease-registry.js'
import {
  _resetScmWorkloadLeasesForTests,
  findActiveAgentScmWorkload,
  registerScmEvaluationWorkload,
} from '../scm-workload-guard.js'

function executor(results: unknown[][]) {
  const select = vi.fn()
  for (const rows of results) {
    select.mockReturnValueOnce({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
      }),
    })
  }
  return { select }
}

describe('findActiveAgentScmWorkload', () => {
  afterEach(() => {
    _resetExecutionLeasesForTests()
    _resetScmWorkloadLeasesForTests()
  })

  it('reports a cancelled Run while its execution lease is still active', async () => {
    reserveExecutionLease('run_cancelled', 'agt_1')
    const db = executor([])

    await expect(findActiveAgentScmWorkload(db as never, 'agt_1')).resolves.toEqual({
      type: 'run',
      id: 'run_cancelled',
    })
    expect(db.select).not.toHaveBeenCalled()
  })

  it('reports the actual executing Agent from its execution lease', async () => {
    reserveExecutionLease('run_override', 'agt_executor')
    const db = executor([])

    await expect(findActiveAgentScmWorkload(db as never, 'agt_executor')).resolves.toEqual({
      type: 'run',
      id: 'run_override',
    })
  })

  it('reports a cancelled Evaluation until workspace cleanup finishes', async () => {
    const release = registerScmEvaluationWorkload('evt_cancelled', 'agt_1')
    const db = executor([])

    await expect(findActiveAgentScmWorkload(db as never, 'agt_1')).resolves.toEqual({
      type: 'evaluation',
      id: 'evt_cancelled',
    })
    release()
  })
  it('reports an active Run before an SCM binding can be released', async () => {
    const db = executor([[], [{ id: 'run_1' }]])

    await expect(findActiveAgentScmWorkload(db as never, 'agt_1')).resolves.toEqual({
      type: 'run',
      id: 'run_1',
    })
  })

  it('reports an active Evaluation when no Run is active', async () => {
    const db = executor([[], [], [], [{ id: 'evt_1' }]])

    await expect(findActiveAgentScmWorkload(db as never, 'agt_1')).resolves.toEqual({
      type: 'evaluation',
      id: 'evt_1',
    })
  })

  it('allows a binding change after all workloads are terminal', async () => {
    const db = executor([[], [], [], []])

    await expect(findActiveAgentScmWorkload(db as never, 'agt_1')).resolves.toBeNull()
  })
})
