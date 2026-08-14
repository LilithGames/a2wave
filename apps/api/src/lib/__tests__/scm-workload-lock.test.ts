import { describe, expect, it } from 'vitest'
import { withAgentScmWorkloadLock } from '../scm-workload-lock.js'

describe('withAgentScmWorkloadLock', () => {
  it('does not admit a workload while the SCM binding is being released', async () => {
    const events: string[] = []
    let releaseBinding!: () => void
    const bindingGate = new Promise<void>((resolve) => {
      releaseBinding = resolve
    })

    const binding = withAgentScmWorkloadLock('agt_1', async () => {
      events.push('binding:start')
      await bindingGate
      events.push('binding:end')
    })
    await Promise.resolve()
    const workload = withAgentScmWorkloadLock('agt_1', async () => {
      events.push('workload')
    })

    expect(events).toEqual(['binding:start'])
    releaseBinding()
    await Promise.all([binding, workload])
    expect(events).toEqual(['binding:start', 'binding:end', 'workload'])
  })
})
