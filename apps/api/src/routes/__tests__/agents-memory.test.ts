import { Hono } from 'hono'
/**
 * Tests for PATCH /agents/:id — auto-mount/unmount a2wave-memory skill
 * when config.memoryEnabled changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- DB mock state ---

let mockExistingAgent: Record<string, unknown> | null = null
let mockMemorySkill: Record<string, unknown> | null = null
let mockUpdatedData: Record<string, unknown> = {}
let mockSelectResults: unknown[] = []
const mockWhereConditions: unknown[] = []

const mockRun = vi.fn()
const mockReturningGet = vi.fn(() => mockExistingAgent)

vi.mock('../../db/client.js', async () => {
  const { asyncQuery } = await import('../../test/async-query.js')
  return {
    db: {
      select: vi.fn(() => {
        const result = mockSelectResults.shift()
        return asyncQuery({
          from: vi.fn(() =>
            asyncQuery({
              where: vi.fn((condition: unknown) => {
                mockWhereConditions.push(condition)
                return asyncQuery({
                  get: vi.fn(() => result),
                  all: vi.fn(() => (Array.isArray(result) ? result : result ? [result] : [])),
                })
              }),
            }),
          ),
        })
      }),
      update: vi.fn(() =>
        asyncQuery({
          set: vi.fn((data: Record<string, unknown>) => {
            mockUpdatedData = data
            return asyncQuery({
              where: vi.fn(() =>
                asyncQuery({
                  returning: vi.fn(() => asyncQuery({ get: mockReturningGet })),
                }),
              ),
            })
          }),
        }),
      ),
      insert: vi.fn(() => asyncQuery({ values: vi.fn(() => asyncQuery({ run: mockRun })) })),
      delete: vi.fn(() => asyncQuery({ where: vi.fn(() => asyncQuery({ run: mockRun })) })),
    },
    // db/transaction.ts reads isPostgres + sqliteDatabase at module load.
    isPostgres: false,
    sqliteDatabase: { inTransaction: false, exec: vi.fn() },
  }
})

vi.mock('../../db/schema.js', () => ({
  agents: { id: 'agents.id', config: 'agents.config' },
  skills: {
    id: 'skills.id',
    name: 'skills.name',
    userId: 'skills.userId',
    visibility: 'skills.visibility',
  },
  runs: { id: 'runs.id', agentId: 'runs.agentId' },
  runSteps: { order: 'runSteps.order' },
  chatMessages: { id: 'chatMessages.id' },
  scmSources: { id: 'scmSources.id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ type: 'eq', column, value })),
  isNull: vi.fn((column: unknown) => ({ type: 'isNull', column })),
  desc: vi.fn(),
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  sql: vi.fn(),
  count: vi.fn(),
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn((prefix: string) => `${prefix}_test1`),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../../lib/memory-storage.js', () => ({
  removeAgentMemory: vi.fn(),
  removeMemoryOverride: vi.fn(),
}))

vi.mock('../../lib/memory-index.js', () => ({
  clearAgentIndex: vi.fn(),
}))

vi.mock('../../lib/feishu-service.js', () => ({
  feishuConnectionManager: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getActiveAgentIds: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('../../lib/schedule-trigger.js', () => ({
  scheduleTriggerManager: {
    start: vi.fn(),
    stop: vi.fn(),
    getActiveAgentIds: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('../../engine/index.js', () => ({
  engineRegistry: { get: vi.fn().mockReturnValue(true), types: [] },
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  resolveCleanupWorkDirs: vi.fn().mockResolvedValue(['/tmp/work']),
  removePerAgentWorkspace: vi.fn().mockResolvedValue(undefined),
  resolveWorkDir: vi.fn().mockReturnValue('/tmp/work'),
  injectScmEnv: vi.fn(),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor' }),
  resolveEngineType: vi.fn(
    (agentConfig, agentType) => agentConfig.engineType || agentType || 'cursor',
  ),
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: vi.fn().mockReturnValue('acquired'),
  scheduleNext: vi.fn(),
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

vi.mock('../../lib/execute-chat-run.js', () => ({
  executeChatRun: vi.fn(),
}))

vi.mock('../../worker/index.js', () => ({
  executeInWorker: vi.fn(),
}))

vi.mock('@a2wave/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@a2wave/shared')>()
  return {
    ...actual,
    createAgentInput: { safeParse: vi.fn().mockReturnValue({ success: true, data: {} }) },
    updateAgentInput: {
      safeParse: vi.fn((input: unknown) => ({
        success: true,
        data: input,
      })),
    },
  }
})

import agentsRoutes from '../../routes/agents.js'

const app = new Hono()
app.route('/agents', agentsRoutes)

describe('PATCH /agents/:id — memory skill auto-mount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdatedData = {}
    mockSelectResults = []
    mockWhereConditions.length = 0
    mockMemorySkill = {
      id: 'skl_memory1',
      name: 'a2wave-memory',
      userId: null,
      visibility: 'all-users',
    }
  })

  it('adds a2wave-memory skill when memoryEnabled changes to true', async () => {
    mockExistingAgent = {
      id: 'agt_1',
      name: 'Test',
      config: { memoryEnabled: false },
      skills: [],
      env: null,
      feishuConfig: null,
    }
    mockReturningGet.mockReturnValue({ ...mockExistingAgent, config: { memoryEnabled: true } })

    mockSelectResults = [mockExistingAgent, mockMemorySkill]

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { memoryEnabled: true },
      }),
    })

    expect(res.status).toBe(200)
    expect(mockUpdatedData.skills).toEqual(['skl_memory1'])
    expect(mockWhereConditions[1]).toEqual({
      type: 'and',
      conditions: [
        { type: 'eq', column: 'skills.name', value: 'a2wave-memory' },
        { type: 'isNull', column: 'skills.userId' },
        { type: 'eq', column: 'skills.visibility', value: 'all-users' },
      ],
    })
  })

  it('removes a2wave-memory skill when memoryEnabled changes to false', async () => {
    mockExistingAgent = {
      id: 'agt_1',
      name: 'Test',
      config: { memoryEnabled: true },
      skills: ['skl_user_memory', 'skl_memory1', 'skl_other'],
      env: null,
      feishuConfig: null,
    }
    mockReturningGet.mockReturnValue({ ...mockExistingAgent, config: { memoryEnabled: false } })

    mockSelectResults = [mockExistingAgent, mockMemorySkill]

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { memoryEnabled: false },
      }),
    })

    expect(res.status).toBe(200)
    expect(mockUpdatedData.skills).toEqual(['skl_user_memory', 'skl_other'])
  })
})
