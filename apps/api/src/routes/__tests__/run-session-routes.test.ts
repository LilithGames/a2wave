import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

type Json = Record<string, unknown>
const { cancelMock } = vi.hoisted(() => ({ cancelMock: vi.fn().mockResolvedValue(false) }))

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn((prefix?: string) => (prefix ? `${prefix}_test` : 'test')),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  resolveWorkDir: vi.fn().mockResolvedValue('/tmp/work'),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor' }),
}))

vi.mock('../../engine/index.js', () => ({
  engineRegistry: { cancel: cancelMock, types: [] },
}))

vi.mock('../../engine/execution-lease-registry.js', () => ({
  cancelExecutionLease: vi.fn().mockResolvedValue(undefined),
  bindExecutionLeaseTask: vi.fn(),
  hasExecutionLease: vi.fn().mockReturnValue(false),
  isRunExecutionSettling: vi.fn().mockReturnValue(false),
  reserveExecutionLease: vi.fn(),
  reserveExecutionLeaseForAgent: vi.fn().mockResolvedValue(undefined),
  completeExecutionLease: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/scm-workload-lifecycle.js', () => ({
  activateScmWorkload: vi.fn().mockResolvedValue(undefined),
  releaseReservedScmWorkload: vi.fn().mockResolvedValue(false),
  releaseReservedScmWorkloadInMutation: vi.fn().mockResolvedValue(false),
  withScmWorkloadAdmission: vi.fn(async (_input, callback) => {
    const { db } = await import('../../db/client.js')
    return callback(db, {
      workspaceType: 'temp',
      scmSourceId: null,
      leaseId: null,
      alreadyReserved: false,
    })
  }),
}))

const mockTryAcquireSlot = vi.hoisted(() => vi.fn().mockReturnValue('acquired'))
vi.mock('../../engine/task-queue.js', () => ({
  scheduleNext: vi.fn(),
  tryAcquireSlot: mockTryAcquireSlot,
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
  countOccupiedRunSlots: vi.fn().mockResolvedValue(0),
}))

vi.mock('../../lib/execute-chat-run.js', () => ({
  executeChatRun: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/run-launcher.js', () => ({
  runWithLifecycle: vi.fn(),
}))

vi.mock('../../lib/pending-job-registry.js', () => ({
  registerPendingContext: vi.fn(),
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../../lib/owner-filter.js', () => ({
  getCurrentUserId: vi.fn().mockReturnValue(undefined),
}))

const mockGetRunReadFilter = vi.hoisted(() => vi.fn(() => undefined))
vi.mock('../../lib/agent-access.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRunReadFilter: mockGetRunReadFilter,
}))

import { db } from '../../db/client.js'
import { asyncQuery } from '../../test/async-query.js'

const mockDb = db as unknown as {
  select: Mock
  insert: Mock
  update: Mock
}

beforeEach(() => {
  mockDb.select.mockReset()
  mockDb.insert.mockReset()
  mockDb.update.mockReset()
})

function makeSelectChain(result: unknown) {
  const rows = Array.isArray(result) ? result : result ? [result] : []
  const orderByFn = vi.fn().mockReturnValue(
    asyncQuery({
      all: vi.fn().mockReturnValue(rows),
      limit: vi.fn().mockReturnValue(
        asyncQuery({
          get: vi.fn().mockReturnValue(rows[0]),
          offset: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(rows) })),
        }),
      ),
    }),
  )
  const leftJoinWhere = vi.fn().mockReturnValue(
    asyncQuery({
      orderBy: vi.fn().mockReturnValue(
        asyncQuery({
          all: vi.fn().mockReturnValue(rows),
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(rows) })),
          }),
        }),
      ),
    }),
  )

  return {
    leftJoinWhere,
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(rows[0]),
            all: vi.fn().mockReturnValue(rows),
            orderBy: orderByFn,
          }),
        ),
        leftJoin: vi.fn().mockReturnValue(asyncQuery({ where: leftJoinWhere })),
        orderBy: orderByFn,
        all: vi.fn().mockReturnValue(rows),
      }),
    ),
  }
}

function makeGroupedSelectChain(result: unknown[]) {
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            groupBy: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(result) })),
          }),
        ),
      }),
    ),
  }
}

function makeSessionAggregateChain(result: unknown[]) {
  const where = vi.fn((_: unknown) => awaitable)
  const having = vi.fn((_: unknown) => awaitable)
  const chain: Record<string, unknown> = {
    from: vi.fn(() => awaitable),
    where,
    groupBy: vi.fn(() => awaitable),
    having,
    orderBy: vi.fn(() => awaitable),
    limit: vi.fn(() => awaitable),
    offset: vi.fn(() => awaitable),
    all: vi.fn(() => result),
  }
  const awaitable = asyncQuery(chain)
  return { chain: awaitable, where, having }
}

const SAMPLE_RUN = {
  id: 'run_1',
  intent: 'Fix the bug',
  status: 'completed' as const,
  result: { output: 'Done' },
  initiatorAgentId: 'agt_1',
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
}

describe('GET /runs', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockTryAcquireSlot.mockReturnValue('acquired')
    const mod = await import('../runs.js')
    app = new Hono().route('/runs', mod.default)
  })

  it('returns paginated runs list', async () => {
    const countChain = {
      from: vi.fn().mockReturnValue(
        asyncQuery({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockReturnValue({ count: 1 }),
            }),
          ),
        }),
      ),
    }

    const dataChain = {
      from: vi.fn().mockReturnValue(
        asyncQuery({
          leftJoin: vi.fn().mockReturnValue(
            asyncQuery({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockReturnValue(
                      asyncQuery({
                        all: vi
                          .fn()
                          .mockReturnValue([
                            { ...SAMPLE_RUN, agentName: 'Agent', agentIcon: '🤖' },
                          ]),
                      }),
                    ),
                  }),
                }),
              }),
            }),
          ),
        }),
      ),
    }

    mockDb.select.mockReturnValueOnce(countChain).mockReturnValueOnce(dataChain)

    const res = await app.request('/runs')
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    expect(json.data).toBeDefined()
    expect(json.pagination).toBeDefined()

    const pagination = json.pagination as Json
    expect(pagination.total).toBe(1)
    expect(pagination.page).toBe(1)
    expect(mockDb.select).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ triggerAgentName: expect.anything() }),
    )
  })

  it('respects page and pageSize query params', async () => {
    const countChain = {
      from: vi.fn().mockReturnValue(
        asyncQuery({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockReturnValue({ count: 50 }),
            }),
          ),
        }),
      ),
    }

    const dataChain = {
      from: vi.fn().mockReturnValue(
        asyncQuery({
          leftJoin: vi.fn().mockReturnValue(
            asyncQuery({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockReturnValue(
                      asyncQuery({
                        all: vi.fn().mockReturnValue([]),
                      }),
                    ),
                  }),
                }),
              }),
            }),
          ),
        }),
      ),
    }

    mockDb.select.mockReturnValueOnce(countChain).mockReturnValueOnce(dataChain)

    const res = await app.request('/runs?page=2&pageSize=10')
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    const pagination = json.pagination as Json
    expect(pagination.page).toBe(2)
    expect(pagination.pageSize).toBe(10)
    expect(pagination.totalPages).toBe(5)
  })
})

describe('GET /runs/sessions', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../runs.js')
    app = new Hono().route('/runs', mod.default)
  })

  it('keeps a session visible when its representative updates after the aggregate read', async () => {
    const aggregate = {
      groupKey: 'conv_1',
      conversationId: 'conv_1',
      initiatorAgentId: 'agt_1',
      triggerSource: 'oauth',
      runCount: 2,
      failedCount: 1,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:01:00.000Z'),
      total: 1,
    }
    const members = [
      {
        ...SAMPLE_RUN,
        id: 'run_old',
        conversationId: 'conv_1',
        triggerSource: 'oauth',
        status: 'failed',
        updatedAt: new Date('2026-08-01T00:00:10.000Z'),
        agentName: 'Agent',
        agentIcon: '🤖',
      },
      {
        ...SAMPLE_RUN,
        id: 'run_latest',
        conversationId: 'conv_1',
        status: 'running',
        triggerSource: 'oauth',
        // Simulate this Run completing/updating between the aggregate SELECT and
        // the representative SELECT. The earlier aggregate timestamp must be a
        // lower bound rather than an exact-match join.
        updatedAt: new Date('2026-08-01T00:01:01.000Z'),
        agentName: 'Agent',
        agentIcon: '🤖',
      },
    ]
    const representativeChain = makeSelectChain([members[1]])
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([aggregate]))
      .mockReturnValueOnce(representativeChain)
      .mockReturnValueOnce(makeSelectChain(members))

    const res = await app.request('/runs/sessions?page=1&pageSize=20')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    expect(json.pagination).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 })
    expect(json.data).toEqual([
      expect.objectContaining({
        id: 'run_latest',
        conversationId: 'conv_1',
        status: 'running',
        runCount: 2,
        turnCount: 2,
        failedCount: 1,
        failedRunIds: ['run_old'],
        hasActiveRun: true,
        activeRunId: 'run_latest',
        latestRun: expect.objectContaining({ id: 'run_latest' }),
      }),
    ])
    const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
    const dialect = new SQLiteSyncDialect()
    expect(
      dialect.sqlToQuery(representativeChain.leftJoinWhere.mock.calls[0]?.[0] as never).sql,
    ).toContain('>=')
  })

  it('keeps a Run without conversationId as a singleton session', async () => {
    const aggregate = {
      groupKey: 'run_1',
      conversationId: null,
      initiatorAgentId: 'agt_1',
      triggerSource: 'schedule',
      runCount: 1,
      failedCount: 0,
      createdAt: SAMPLE_RUN.createdAt,
      updatedAt: SAMPLE_RUN.updatedAt,
      total: 1,
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([aggregate]))
      .mockReturnValueOnce(
        makeSelectChain([{ ...SAMPLE_RUN, conversationId: null, triggerSource: 'schedule' }]),
      )
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeGroupedSelectChain([]))

    const res = await app.request('/runs/sessions')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    expect(json.data).toEqual([
      expect.objectContaining({
        id: 'run_1',
        conversationId: null,
        runCount: 1,
        turnCount: 1,
      }),
    ])
  })

  it('groups a legacy NULL row with newer turns that point to its Run id', async () => {
    const aggregate = {
      groupKey: 'run_legacy',
      conversationId: 'run_legacy',
      initiatorAgentId: 'agt_1',
      triggerSource: 'oauth',
      runCount: 2,
      failedCount: 0,
      createdAt: SAMPLE_RUN.createdAt,
      updatedAt: SAMPLE_RUN.updatedAt,
      total: 1,
    }
    const members = [
      { ...SAMPLE_RUN, id: 'run_legacy', conversationId: null, triggerSource: 'oauth' },
      { ...SAMPLE_RUN, id: 'run_new', conversationId: 'run_legacy', triggerSource: 'oauth' },
    ]
    const aggregateChain = makeSessionAggregateChain([aggregate])
    mockDb.select
      .mockReturnValueOnce(aggregateChain.chain)
      .mockReturnValueOnce(makeSelectChain(members))
      .mockReturnValueOnce(makeSelectChain([]))

    const res = await app.request('/runs/sessions?startDate=2026-08-01T00:00:00.000Z')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    expect(json.data).toEqual([
      expect.objectContaining({ conversationId: 'run_legacy', runCount: 2 }),
    ])
    const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
    const dialect = new SQLiteSyncDialect()
    expect(aggregateChain.where).toHaveBeenCalledWith(undefined)
    expect(
      dialect.sqlToQuery(aggregateChain.having.mock.calls[0]?.[0] as never).sql.toLowerCase(),
    ).toContain('max("runs"."updated_at")')
  })

  it('does not merge equal conversation ids across Agents or trigger sources', async () => {
    const aggregateBase = {
      groupKey: 'provider_session_1',
      conversationId: 'provider_session_1',
      runCount: 1,
      failedCount: 0,
      createdAt: SAMPLE_RUN.createdAt,
      updatedAt: SAMPLE_RUN.updatedAt,
      total: 3,
    }
    const aggregates = [
      { ...aggregateBase, initiatorAgentId: 'agt_1', triggerSource: 'oauth' },
      { ...aggregateBase, initiatorAgentId: 'agt_2', triggerSource: 'oauth' },
      { ...aggregateBase, initiatorAgentId: 'agt_1', triggerSource: 'feishu' },
    ]
    const members = [
      {
        ...SAMPLE_RUN,
        id: 'run_agent_1',
        initiatorAgentId: 'agt_1',
        conversationId: 'provider_session_1',
        triggerSource: 'oauth',
      },
      {
        ...SAMPLE_RUN,
        id: 'run_agent_2',
        initiatorAgentId: 'agt_2',
        conversationId: 'provider_session_1',
        triggerSource: 'oauth',
      },
      {
        ...SAMPLE_RUN,
        id: 'run_feishu',
        initiatorAgentId: 'agt_1',
        conversationId: 'provider_session_1',
        triggerSource: 'feishu',
      },
    ]
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(aggregates))
      .mockReturnValueOnce(makeSelectChain(members))
      .mockReturnValueOnce(makeSelectChain([]))

    const res = await app.request('/runs/sessions')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    expect((json.data as Json[]).map((summary) => summary.id)).toEqual([
      'run_agent_1',
      'run_agent_2',
      'run_feishu',
    ])
    expect((json.data as Json[]).every((summary) => summary.runCount === 1)).toBe(true)
  })

  it('rejects an invalid date filter', async () => {
    const res = await app.request('/runs/sessions?startDate=not-a-date')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid startDate' })
  })

  it('uses running over queued and pending for the aggregate status', async () => {
    const aggregate = {
      groupKey: 'conv_active',
      conversationId: 'conv_active',
      initiatorAgentId: 'agt_1',
      triggerSource: 'oauth',
      runCount: 3,
      failedCount: 0,
      createdAt: SAMPLE_RUN.createdAt,
      updatedAt: SAMPLE_RUN.updatedAt,
      total: 1,
    }
    const members = [
      {
        ...SAMPLE_RUN,
        id: 'run_pending',
        conversationId: 'conv_active',
        triggerSource: 'oauth',
        status: 'pending',
      },
      {
        ...SAMPLE_RUN,
        id: 'run_running',
        conversationId: 'conv_active',
        triggerSource: 'oauth',
        status: 'running',
      },
      {
        ...SAMPLE_RUN,
        id: 'run_queued',
        conversationId: 'conv_active',
        triggerSource: 'oauth',
        status: 'queued',
        updatedAt: new Date(SAMPLE_RUN.updatedAt.getTime() + 1_000),
      },
    ]
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([aggregate]))
      .mockReturnValueOnce(makeSelectChain(members))
      .mockReturnValueOnce(makeSelectChain(members))

    const res = await app.request('/runs/sessions')
    const json = (await res.json()) as Json
    expect(json.data).toEqual([
      expect.objectContaining({ status: 'running', activeRunId: 'run_running' }),
    ])
  })

  it('preserves the real session total when a page is past the end', async () => {
    const firstGroup = {
      groupKey: 'conv_1',
      conversationId: 'conv_1',
      initiatorAgentId: 'agt_1',
      triggerSource: 'oauth',
      runCount: 1,
      failedCount: 0,
      createdAt: SAMPLE_RUN.createdAt,
      updatedAt: SAMPLE_RUN.updatedAt,
      total: 7,
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([firstGroup]))

    const res = await app.request('/runs/sessions?page=99&pageSize=2')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [],
      pagination: { total: 7, page: 99, pageSize: 2, totalPages: 4 },
    })
  })
})

describe('GET /runs/:id/session', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../runs.js')
    app = new Hono().route('/runs', mod.default)
  })

  it('returns every retained Run in the conversation as a separate turn', async () => {
    const anchor = {
      ...SAMPLE_RUN,
      id: 'run_2',
      conversationId: 'conv_1',
      triggerSource: 'oauth',
    }
    const members = [
      {
        ...SAMPLE_RUN,
        id: 'run_1',
        conversationId: 'conv_1',
        triggerSource: 'oauth',
        agentName: 'Agent',
        agentIcon: '🤖',
      },
      { ...anchor, agentName: 'Agent', agentIcon: '🤖' },
    ]
    const steps = [
      { id: 'step_1', runId: 'run_1', order: 1, input: {}, status: 'completed' },
      { id: 'step_2', runId: 'run_2', order: 1, input: {}, status: 'completed' },
    ]
    const messages = [
      { id: 'msg_1', runId: 'run_1', role: 'user', content: 'one', createdAt: new Date() },
      { id: 'msg_2', runId: 'run_2', role: 'user', content: 'two', createdAt: new Date() },
    ]
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(anchor))
      .mockReturnValueOnce(makeSelectChain(members))
      .mockReturnValueOnce(makeSelectChain(steps))
      .mockReturnValueOnce(makeSelectChain(messages))

    const res = await app.request('/runs/run_2/session')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    expect((json.data as Json).runs).toEqual([
      expect.objectContaining({ run: expect.objectContaining({ id: 'run_1' }) }),
      expect.objectContaining({ run: expect.objectContaining({ id: 'run_2' }) }),
    ])
    expect((json.data as Json).summary).toMatchObject({ runCount: 2, turnCount: 2 })
    expect(Object.keys(mockDb.select.mock.calls[2]?.[0] as Record<string, unknown>).sort()).toEqual(
      ['input', 'order', 'runId'],
    )
  })

  it('loads newer turns when the requested legacy anchor has no conversationId', async () => {
    const anchor = {
      id: 'run_legacy',
      conversationId: null,
      initiatorAgentId: 'agt_1',
      triggerSource: 'oauth',
    }
    const members = [
      { ...SAMPLE_RUN, ...anchor, agentName: 'Agent', agentIcon: '🤖' },
      {
        ...SAMPLE_RUN,
        id: 'run_new',
        conversationId: 'run_legacy',
        triggerSource: 'oauth',
        agentName: 'Agent',
        agentIcon: '🤖',
      },
    ]
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(anchor))
      .mockReturnValueOnce(makeSelectChain(members))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]))

    const res = await app.request('/runs/run_legacy/session')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    expect((json.data as Json).summary).toMatchObject({
      conversationId: 'run_legacy',
      runCount: 2,
    })
  })

  it('returns 404 when the requested Run is not visible or does not exist', async () => {
    mockDb.select.mockReturnValueOnce(makeSelectChain(undefined))

    const res = await app.request('/runs/run_missing/session')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Run not found' })
  })
})
