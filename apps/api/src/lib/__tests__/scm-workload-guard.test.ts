import { describe, expect, it, vi } from 'vitest'
import { findActiveAgentScmWorkload } from '../scm-workload-guard.js'

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
  it('reports an active Run before an SCM binding can be released', async () => {
    const db = executor([[{ id: 'run_1' }]])

    await expect(findActiveAgentScmWorkload(db as never, 'agt_1')).resolves.toEqual({
      type: 'run',
      id: 'run_1',
    })
  })

  it('reports an active Evaluation when no Run is active', async () => {
    const db = executor([[], [{ id: 'evt_1' }]])

    await expect(findActiveAgentScmWorkload(db as never, 'agt_1')).resolves.toEqual({
      type: 'evaluation',
      id: 'evt_1',
    })
  })

  it('allows a binding change after all workloads are terminal', async () => {
    const db = executor([[], []])

    await expect(findActiveAgentScmWorkload(db as never, 'agt_1')).resolves.toBeNull()
  })
})
