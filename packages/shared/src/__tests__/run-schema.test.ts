import { describe, expect, it } from 'vitest'
import { isActiveRunStatus, runSchema, runWithAgentSchema } from '../schemas/run.js'

const BASE_RUN = {
  id: 'run_1',
  intent: 'Check an order',
  status: 'completed' as const,
  createdAt: new Date('2026-08-08T00:00:00.000Z'),
  updatedAt: new Date('2026-08-08T00:00:01.000Z'),
}

describe('run caller provenance', () => {
  it('preserves the immediate caller Agent name on Run contracts', () => {
    expect(
      runSchema.parse({
        ...BASE_RUN,
        triggerUserName: 'Alice',
        triggerAgentName: 'Order Router',
        triggerSource: 'a2a',
      }),
    ).toMatchObject({
      triggerUserName: 'Alice',
      triggerAgentName: 'Order Router',
      triggerSource: 'a2a',
    })

    expect(
      runWithAgentSchema.parse({
        ...BASE_RUN,
        triggerAgentName: 'Order Router',
        agentName: 'Order Expert',
      }),
    ).toMatchObject({
      triggerAgentName: 'Order Router',
      agentName: 'Order Expert',
    })
  })
})

describe('active run status', () => {
  it.each(['pending', 'queued', 'running'] as const)('treats %s as active', (status) => {
    expect(isActiveRunStatus(status)).toBe(true)
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('treats %s as terminal', (status) => {
    expect(isActiveRunStatus(status)).toBe(false)
  })

  it('treats missing status as inactive', () => {
    expect(isActiveRunStatus(null)).toBe(false)
    expect(isActiveRunStatus(undefined)).toBe(false)
  })
})
