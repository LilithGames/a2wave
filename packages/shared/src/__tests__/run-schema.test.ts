import { describe, expect, it } from 'vitest'
import {
  isActiveRunStatus,
  runSchema,
  runSessionDetailSchema,
  runSessionSummarySchema,
  runTriggerSourceEnum,
  runWithAgentSchema,
} from '../schemas/run.js'

const BASE_RUN = {
  id: 'run_1',
  intent: 'Check an order',
  status: 'completed' as const,
  createdAt: new Date('2026-08-08T00:00:00.000Z'),
  updatedAt: new Date('2026-08-08T00:00:01.000Z'),
}

describe('run caller provenance', () => {
  it('accepts QQ Official as a trigger source', () => {
    expect(runTriggerSourceEnum.parse('qq_official')).toBe('qq_official')
  })
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

describe('run session contracts', () => {
  const LATEST_RUN = {
    ...BASE_RUN,
    conversationId: 'conv_1',
    triggerSource: 'oauth' as const,
    initiatorAgentId: 'agt_1',
    agentName: 'Support Agent',
  }

  it('accepts an aggregate summary with failure and activity metadata', () => {
    expect(
      runSessionSummarySchema.parse({
        id: 'run_1',
        conversationId: 'conv_1',
        latestRun: LATEST_RUN,
        status: 'running',
        runCount: 3,
        turnCount: 3,
        failedCount: 1,
        failedRunIds: ['run_failed'],
        hasActiveRun: true,
        activeRunId: 'run_active',
        createdAt: new Date('2026-08-08T00:00:00.000Z'),
        updatedAt: new Date('2026-08-08T00:00:03.000Z'),
      }),
    ).toMatchObject({ runCount: 3, failedCount: 1, activeRunId: 'run_active' })
  })

  it('accepts detail grouped into per-run turns', () => {
    expect(
      runSessionDetailSchema.parse({
        summary: {
          id: 'run_1',
          conversationId: 'conv_1',
          latestRun: LATEST_RUN,
          status: 'completed',
          runCount: 1,
          turnCount: 1,
          failedCount: 0,
          failedRunIds: [],
          hasActiveRun: false,
          activeRunId: null,
          createdAt: BASE_RUN.createdAt,
          updatedAt: BASE_RUN.updatedAt,
        },
        runs: [
          {
            run: LATEST_RUN,
            messages: [
              {
                id: 'msg_1',
                runId: 'run_1',
                role: 'user',
                content: 'Check an order',
                createdAt: BASE_RUN.createdAt,
                attachments: [{ token: 'att_1', name: 'order.pdf', mimeType: 'application/pdf' }],
              },
            ],
            hasFullLog: false,
          },
        ],
      }),
    ).toMatchObject({ runs: [{ run: { id: 'run_1' } }] })
  })

  it('rejects private attachment fields in session history', () => {
    const parsed = runSessionDetailSchema.safeParse({
      summary: {
        id: 'run_1',
        conversationId: null,
        latestRun: LATEST_RUN,
        status: 'completed',
        runCount: 1,
        turnCount: 1,
        failedCount: 0,
        failedRunIds: [],
        hasActiveRun: false,
        activeRunId: null,
        createdAt: BASE_RUN.createdAt,
        updatedAt: BASE_RUN.updatedAt,
      },
      runs: [
        {
          run: LATEST_RUN,
          messages: [
            {
              id: 'msg_1',
              runId: 'run_1',
              role: 'user',
              content: 'secret attachment fields',
              createdAt: BASE_RUN.createdAt,
              attachments: [
                {
                  name: 'order.pdf',
                  mimeType: 'application/pdf',
                  path: '/private/order.pdf',
                },
              ],
            },
          ],
          hasFullLog: false,
        },
      ],
    })

    expect(parsed.success).toBe(false)
  })
})
