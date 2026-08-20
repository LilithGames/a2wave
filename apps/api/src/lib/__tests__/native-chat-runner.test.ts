import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockAgentGet = vi.hoisted(() => vi.fn())
const mockReservedRunGet = vi.hoisted(() => vi.fn())
const mockInsertRun = vi.hoisted(() => vi.fn())
const mockUpdateRun = vi.hoisted(() => vi.fn())
const mockUpdateReturning = vi.hoisted(() => vi.fn())
const mockTryAcquireSlot = vi.hoisted(() => vi.fn())
const mockExecuteChatRun = vi.hoisted(() => vi.fn())
const mockCompleteExecutionLease = vi.hoisted(() => vi.fn())
const insertedRunValues = vi.hoisted(() => [] as Record<string, unknown>[])

vi.mock('../../db/client.js', () => ({
  // Async builders: the reservation path awaits every query now. `mockAgentGet`
  // still stands for "the agent this lookup finds"; the store asks for
  // `.limit(1)` and destructures the resulting array.
  db: {
    select: () => ({
      from: (table: { __kind?: string }) => ({
        where: () => ({
          limit: () => {
            const row = table.__kind === 'runs' ? mockReservedRunGet() : mockAgentGet()
            return Promise.resolve(row === undefined || row === null ? [] : [row])
          },
        }),
      }),
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        insertedRunValues.push(value)
        return Promise.resolve(mockInsertRun())
      },
    }),
    update: () => ({
      set: () => ({
        where: (w: unknown) => {
          const result = Promise.resolve(mockUpdateRun(w)) as Promise<unknown> & {
            returning: () => Promise<unknown>
          }
          result.returning = () => Promise.resolve(mockUpdateReturning())
          return result
        },
      }),
    }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: { __kind: 'agents', id: {} },
  runs: {
    __kind: 'runs',
    id: {},
    initiatorAgentId: {},
    triggerSource: {},
    triggerEventId: {},
  },
}))

vi.mock('drizzle-orm', () => ({ and: vi.fn(() => ({})), eq: vi.fn(() => ({})) }))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: mockTryAcquireSlot,
}))
vi.mock('../../engine/execution-lease-registry.js', () => ({
  completeExecutionLease: mockCompleteExecutionLease,
}))

vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))
vi.mock('../execute-chat-run.js', () => ({ executeChatRun: mockExecuteChatRun }))
vi.mock('../id.js', () => ({ createId: () => 'run_native' }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { preflightNativeChatRun, reserveNativeChatRun } from '../native-chat-runner.js'

const slackChannel = {
  channel_type: 'slack' as const,
  channel_info: {
    app_id: 'A1',
    team_id: 'T1',
    channel_id: 'C1',
    chat_type: 'channel' as const,
    message_ts: '1.1',
    sender_user_id: 'U1',
  },
  user_info: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  insertedRunValues.length = 0
  mockReservedRunGet.mockReturnValue(undefined)
  mockAgentGet.mockReturnValue({
    id: 'agt_1',
    userId: 'usr_1',
    publishStatus: 'published',
    publishChannels: ['slack'],
    maxConcurrency: 2,
  })
  mockInsertRun.mockReturnValue({ changes: 1 })
  mockUpdateRun.mockReturnValue({ changes: 1 })
  mockUpdateReturning.mockReturnValue([{ id: 'run_native' }])
  mockExecuteChatRun.mockResolvedValue(undefined)
})

describe('preflightNativeChatRun', () => {
  it('allows a published native channel event that has not been reserved', async () => {
    await expect(
      preflightNativeChatRun({ agentId: 'agt_1', source: 'slack', eventId: 'Ev-new' }),
    ).resolves.toEqual({ status: 'ready' })
  })

  it('rejects a duplicate before transport attachments are downloaded', async () => {
    mockReservedRunGet.mockReturnValue({ id: 'run_existing' })

    await expect(
      preflightNativeChatRun({ agentId: 'agt_1', source: 'slack', eventId: 'Ev-existing' }),
    ).resolves.toEqual({ status: 'duplicate' })
  })

  it('rejects an event when its native channel is not published', async () => {
    mockAgentGet.mockReturnValue({
      id: 'agt_1',
      publishStatus: 'published',
      publishChannels: ['api'],
    })

    await expect(
      preflightNativeChatRun({ agentId: 'agt_1', source: 'slack', eventId: 'Ev-ignored' }),
    ).resolves.toEqual({ status: 'ignored' })
  })
})

describe('reserveNativeChatRun', () => {
  it('marks the durable Run failed when scheduling throws after insertion', async () => {
    mockTryAcquireSlot.mockRejectedValue(new Error('queue database unavailable'))

    await expect(
      reserveNativeChatRun({
        agentId: 'agt_1',
        source: 'slack',
        eventId: 'Ev-reserved-error',
        conversationId: 'T1:C1:1.1',
        intent: 'hello',
        channel: slackChannel,
      }),
    ).resolves.toEqual({ status: 'scheduling_failed', runId: 'run_native' })
    expect(mockUpdateReturning).toHaveBeenCalled()
    expect(mockCompleteExecutionLease).toHaveBeenCalledWith('run_native')
  })

  it('preserves reservation ownership when the failure transition also fails', async () => {
    mockTryAcquireSlot.mockRejectedValue(new Error('queue database unavailable'))
    mockUpdateReturning.mockRejectedValue(new Error('run database unavailable'))

    await expect(
      reserveNativeChatRun({
        agentId: 'agt_1',
        source: 'slack',
        eventId: 'Ev-unknown-state',
        conversationId: 'T1:C1:1.1',
        intent: 'hello',
        channel: slackChannel,
      }),
    ).rejects.toMatchObject({ nativeChatRunReserved: true, runId: 'run_native' })
    expect(mockCompleteExecutionLease).not.toHaveBeenCalled()
  })

  it('persists context before starting an acquired run', async () => {
    mockTryAcquireSlot.mockReturnValue('acquired')

    const result = await reserveNativeChatRun({
      agentId: 'agt_1',
      source: 'slack',
      eventId: 'Ev1',
      conversationId: 'T1:C1:1.1',
      intent: 'hello',
      channel: slackChannel,
      displayName: 'Alice',
    })

    expect(result).toEqual({ status: 'started', runId: 'run_native' })
    expect(mockInsertRun).toHaveBeenCalled()
    expect(mockTryAcquireSlot).toHaveBeenCalledWith({}, 'agt_1', 'run_native', 2)
    expect(mockExecuteChatRun).toHaveBeenCalledWith('agt_1', 'run_native')
  })

  it('persists native attachment descriptors with the channel context', async () => {
    mockTryAcquireSlot.mockReturnValue('queued')
    const nativeAttachments = [
      {
        source: 'slack' as const,
        remoteId: 'F123',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 42,
      },
    ]

    await reserveNativeChatRun({
      agentId: 'agt_1',
      source: 'slack',
      eventId: 'Ev-file',
      conversationId: 'T1:D1',
      intent: '',
      channel: slackChannel,
      nativeAttachments,
    })

    expect(insertedRunValues[0]?.executionMetadata).toEqual({
      nativeChatContext: { channel: slackChannel },
      nativeAttachments,
    })
  })

  it('persists pre-staged QQ attachment refs without a signed vendor URL', async () => {
    mockTryAcquireSlot.mockReturnValue('queued')
    mockAgentGet.mockReturnValue({
      id: 'agt_1',
      userId: 'usr_1',
      publishStatus: 'published',
      publishChannels: ['qq_official'],
      maxConcurrency: 2,
    })
    const attachments = [
      {
        token: 'att_internal',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 42,
      },
    ]

    await reserveNativeChatRun({
      agentId: 'agt_1',
      source: 'qq_official',
      eventId: 'qq_official:message-1',
      conversationId: 'app:c2c:user',
      intent: 'review this file',
      channel: slackChannel,
      attachments,
      attachmentConsumerId: 'agent:agt_1',
    })

    expect(insertedRunValues[0]?.executionMetadata).toEqual({
      nativeChatContext: { channel: slackChannel },
      attachments,
      attachmentConsumerId: 'agent:agt_1',
    })
    expect(JSON.stringify(insertedRunValues[0])).not.toContain('https://')
  })

  it('persists a native chat session reset across queueing and restart', async () => {
    mockTryAcquireSlot.mockReturnValue('queued')
    mockAgentGet.mockReturnValue({
      id: 'agt_1',
      userId: 'usr_1',
      publishStatus: 'published',
      publishChannels: ['qq_official'],
      maxConcurrency: 2,
    })

    await reserveNativeChatRun({
      agentId: 'agt_1',
      source: 'qq_official',
      eventId: 'qq_official:message-new',
      conversationId: 'app:c2c:user',
      intent: '新会话已开始',
      channel: slackChannel,
      resetSession: true,
    })

    expect(insertedRunValues[0]?.executionMetadata).toEqual({
      nativeChatContext: { channel: slackChannel },
      nativeChatResetSession: true,
    })
  })

  it('keeps a queued run durable without executing it immediately', async () => {
    mockTryAcquireSlot.mockReturnValue('queued')

    const result = await reserveNativeChatRun({
      agentId: 'agt_1',
      source: 'slack',
      eventId: 'Ev2',
      conversationId: 'T1:C1:1.1',
      intent: 'queued',
      channel: slackChannel,
    })

    expect(result).toEqual({ status: 'queued', runId: 'run_native' })
    expect(mockExecuteChatRun).not.toHaveBeenCalled()
  })

  it('treats the native event unique-index conflict as a duplicate delivery', async () => {
    mockInsertRun.mockImplementation(() => {
      throw new Error('UNIQUE constraint failed: runs.initiator_agent_id, runs.trigger_event_id')
    })

    const result = await reserveNativeChatRun({
      agentId: 'agt_1',
      source: 'slack',
      eventId: 'Ev1',
      conversationId: 'T1:C1:1.1',
      intent: 'duplicate',
      channel: slackChannel,
    })

    expect(result).toEqual({ status: 'duplicate' })
    expect(mockTryAcquireSlot).not.toHaveBeenCalled()
  })

  it('rejects events when the native channel is not published', async () => {
    mockAgentGet.mockReturnValue({
      id: 'agt_1',
      publishStatus: 'published',
      publishChannels: ['api'],
      maxConcurrency: 1,
    })

    const result = await reserveNativeChatRun({
      agentId: 'agt_1',
      source: 'slack',
      eventId: 'Ev3',
      conversationId: 'T1:C1:1.1',
      intent: 'ignored',
      channel: slackChannel,
    })

    expect(result).toEqual({ status: 'ignored' })
    expect(mockInsertRun).not.toHaveBeenCalled()
  })

  it('marks a full-queue run failed so the event remains deduplicated', async () => {
    mockTryAcquireSlot.mockReturnValue('queue_full')

    const result = await reserveNativeChatRun({
      agentId: 'agt_1',
      source: 'slack',
      eventId: 'Ev4',
      conversationId: 'T1:C1:1.1',
      intent: 'too many',
      channel: slackChannel,
    })

    expect(result).toEqual({ status: 'queue_full', runId: 'run_native' })
    expect(mockUpdateRun).toHaveBeenCalled()
  })
})
