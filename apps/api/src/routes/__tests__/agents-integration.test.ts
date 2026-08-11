import { GatewayErrorCode } from '@a2wave/shared'
import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

type Json = Record<string, unknown>
type ErrorJson = { error: { code: string; message: string; details?: unknown } }

vi.mock('../../db/client.js', () => {
  const database = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  }
  database.transaction.mockImplementation((fn: (tx: typeof database) => unknown) => fn(database))
  // db/transaction.ts reads isPostgres + sqliteDatabase at module load.
  return {
    db: database,
    isPostgres: false,
    sqliteDatabase: { inTransaction: false, exec: vi.fn() },
  }
})

vi.mock('../../lib/id.js', () => {
  let counter = 0
  return {
    createId: vi.fn((prefix?: string) => {
      counter++
      return prefix ? `${prefix}_test${counter}` : `test${counter}`
    }),
  }
})

vi.mock('../../engine/index.js', () => ({
  engineRegistry: {
    get: vi.fn().mockReturnValue({ kill: vi.fn().mockReturnValue(true) }),
    types: [],
  },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('../../worker/index.js', () => ({
  executeInWorker: vi.fn(),
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  resolveCleanupWorkDirs: vi.fn().mockResolvedValue(['/tmp/work']),
  removePerAgentWorkspace: vi.fn().mockResolvedValue(undefined),
  resolveWorkDir: vi.fn().mockResolvedValue('/tmp/work'),
  WorktreeOccupiedError: class extends Error {
    constructor(p: string) {
      super(`occupied: ${p}`)
      this.name = 'WorktreeOccupiedError'
    }
  },
  injectScmEnv: vi.fn(),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor' }),
  resolveEngineType: vi.fn(
    (agentConfig, agentType) => agentConfig.engineType || agentType || 'cursor',
  ),
}))

vi.mock('../../lib/git-workspace.js', () => ({
  WorktreeBranchLockedError: class extends Error {
    constructor(b: string, l: string) {
      super(`locked: ${b} by ${l}`)
      this.name = 'WorktreeBranchLockedError'
    }
  },
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

vi.mock('../../middleware/gateway-auth.js', () => ({
  validateGatewayAuth: vi.fn(),
  normalizeAuthType: (v: string | null | undefined) =>
    v === 'none' || v === 'oauth' ? v : 'api_key',
}))

vi.mock('../../middleware/rate-limit.js', () => ({
  rateLimit: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}))

vi.mock('@a2wave/shared', async () => {
  const actual = await vi.importActual<typeof import('@a2wave/shared')>('@a2wave/shared')
  return {
    ...actual,
    createAgentInput: {
      safeParse: vi.fn().mockReturnValue({ success: true, data: {} }),
    },
    updateAgentInput: {
      safeParse: vi.fn().mockReturnValue({ success: true, data: {} }),
    },
  }
})

function makeSelectChain(result: unknown) {
  const dataArray = result ? (Array.isArray(result) ? result : [result]) : []
  // `get` yields ONE row. When a test configures a list, handing the whole array
  // back would make asyncQuery resolve to `[[row]]` — a length-1 result whose
  // single element is the array, not the row.
  const single = Array.isArray(result) ? result[0] : result
  const offsetChain = {
    all: vi.fn().mockReturnValue(dataArray),
    get: vi.fn().mockReturnValue(single),
  }
  const limitChain = {
    get: vi.fn().mockReturnValue(single),
    offset: vi.fn().mockReturnValue(offsetChain),
  }
  const terminalMethods = {
    get: vi.fn().mockReturnValue(single),
    all: vi.fn().mockReturnValue(dataArray),
    orderBy: vi.fn().mockReturnValue(
      asyncQuery({
        all: vi.fn().mockReturnValue(dataArray),
        limit: vi.fn().mockReturnValue(limitChain),
        get: vi.fn().mockReturnValue(single),
      }),
    ),
    limit: vi.fn().mockReturnValue(limitChain),
  }
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(terminalMethods),
        orderBy: terminalMethods.orderBy,
        all: terminalMethods.all,
      }),
    ),
  }
}

function makeInsertChain(returnValue?: unknown) {
  return {
    values: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(returnValue ?? {}),
          }),
        ),
        run: vi.fn(),
      }),
    ),
  }
}

function makeUpdateChain(returnValue?: unknown) {
  return {
    set: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            run: vi.fn().mockReturnValue({ changes: 1 }),
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue(returnValue),
              }),
            ),
          }),
        ),
      }),
    ),
  }
}

function makeDeleteChain(returnValue?: unknown) {
  return {
    where: vi.fn().mockReturnValue(
      asyncQuery({
        run: vi.fn(),
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(returnValue),
          }),
        ),
      }),
    ),
  }
}

import { createAgentInput, updateAgentInput } from '@a2wave/shared'
import { db } from '../../db/client.js'
import { AppError } from '../../lib/errors.js'
import { validateGatewayAuth } from '../../middleware/gateway-auth.js'
import { executeInWorker } from '../../worker/index.js'

import { asyncQuery } from '../../test/async-query.js'

const mockDb = db as unknown as {
  select: Mock
  insert: Mock
  update: Mock
  delete: Mock
}

function createAppWithErrorHandler() {
  const app = new Hono()
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    return c.json({ error: 'Internal Server Error' }, 500)
  })
  return app
}

// ---------------------------------------------------------------------------
// Agent CRUD Lifecycle
// ---------------------------------------------------------------------------
describe('Agent CRUD Lifecycle', () => {
  let agentsApp: Hono

  const CREATED_AGENT = {
    id: 'agt_test1',
    name: 'Integration Test Agent',
    description: 'An agent for integration tests',
    type: 'cursor',
    config: { model: 'gpt-4' },
    status: 'active',
    icon: '🧪',
    systemPrompt: null,
    skills: [],
    mcpServerIds: [],
    publishStatus: 'draft',
    apiKey: null,
    publishAuthType: 'api_key',
    publishIpWhitelist: [],
    publishDescription: null,
    publishChannels: ['api'],
    a2aSkills: null,
    publishedAt: null,
    providerId: null,
    env: null,
    workspaceType: 'temp',
    scmSourceId: null,
    maxConcurrency: 1,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    ;(createAgentInput.safeParse as Mock).mockReturnValue({
      success: true,
      data: {
        name: 'Integration Test Agent',
        description: 'An agent for integration tests',
        type: 'cursor',
        config: { model: 'gpt-4' },
        icon: '🧪',
      },
    })
    ;(updateAgentInput.safeParse as Mock).mockReturnValue({
      success: true,
      data: { name: 'Updated Agent', description: 'Updated desc' },
    })

    const mod = await import('../agents.js')
    agentsApp = createAppWithErrorHandler()
    agentsApp.route('/agents', mod.default)
  })

  it('creates an agent with valid data (201)', async () => {
    mockDb.insert.mockReturnValue(makeInsertChain(CREATED_AGENT))

    const res = await agentsApp.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Integration Test Agent',
        description: 'An agent for integration tests',
        type: 'cursor',
      }),
    })

    expect(res.status).toBe(201)
    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.id).toBe('agt_test1')
    expect(data.name).toBe('Integration Test Agent')
    expect(data.description).toBe('An agent for integration tests')
    expect(data.status).toBe('active')
    expect(data.publishStatus).toBe('draft')
  })

  it('gets the created agent (200)', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CREATED_AGENT))

    const res = await agentsApp.request('/agents/agt_test1')

    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.id).toBe('agt_test1')
    expect(data.name).toBe('Integration Test Agent')
  })

  it('updates the agent name and description (200)', async () => {
    const updatedAgent = {
      ...CREATED_AGENT,
      name: 'Updated Agent',
      description: 'Updated desc',
      updatedAt: new Date('2025-06-01'),
    }
    mockDb.update.mockReturnValue(makeUpdateChain(updatedAgent))

    const res = await agentsApp.request('/agents/agt_test1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Agent', description: 'Updated desc' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.name).toBe('Updated Agent')
    expect(data.description).toBe('Updated desc')
  })

  it('lists agents and includes the created agent', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([CREATED_AGENT]))

    const res = await agentsApp.request('/agents')

    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    const data = json.data as Json[]
    expect(data.length).toBe(1)
    expect(data[0].id).toBe('agt_test1')
  })

  it('deletes the agent (200)', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CREATED_AGENT))
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockDb.delete.mockReturnValue(makeDeleteChain(CREATED_AGENT))

    const res = await agentsApp.request('/agents/agt_test1', { method: 'DELETE' })

    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    expect(json.data).toBeDefined()
  })

  it('refuses to delete a running (published) agent (409)', async () => {
    mockDb.select.mockReturnValue(makeSelectChain({ ...CREATED_AGENT, publishStatus: 'published' }))
    mockDb.delete.mockReturnValue(makeDeleteChain(CREATED_AGENT))

    const res = await agentsApp.request('/agents/agt_test1', { method: 'DELETE' })

    expect(res.status).toBe(409)
    expect(mockDb.delete).not.toHaveBeenCalled()
  })

  it('returns 404 when getting a deleted agent', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(undefined))

    const res = await agentsApp.request('/agents/agt_test1')

    expect(res.status).toBe(404)
  })

  it('returns 404 when updating a non-existent agent', async () => {
    mockDb.update.mockReturnValue(makeUpdateChain(undefined))

    const res = await agentsApp.request('/agents/agt_nonexistent', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    })

    expect(res.status).toBe(404)
  })

  it('returns 404 when deleting a non-existent agent', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(undefined))

    const res = await agentsApp.request('/agents/agt_nonexistent', { method: 'DELETE' })

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Run Lifecycle (Gateway invoke → query run status)
// ---------------------------------------------------------------------------
describe('Run Lifecycle via Gateway', () => {
  let gatewayApp: Hono

  const publishedAgent = {
    id: 'agt_pub1',
    name: 'Published Agent',
    publishStatus: 'published',
    publishAuthType: 'none',
    publishIpWhitelist: [],
    apiKey: null,
    config: {},
    providerId: null,
    systemPrompt: null,
    skills: [],
    env: null,
    workspaceType: 'temp' as const,
    scmSourceId: null,
    type: 'cursor',
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    ;(validateGatewayAuth as Mock).mockResolvedValue({})
    ;(mockDb.insert as Mock).mockReturnValue(makeInsertChain())
    ;(mockDb.update as Mock).mockReturnValue(makeUpdateChain())

    const mod = await import('../gateway.js')
    gatewayApp = new Hono().route('/api/gateway', mod.default)
  })

  it('invokes a published agent and creates a run with running status', async () => {
    ;(mockDb.select as Mock).mockReturnValue(makeSelectChain(publishedAgent))
    ;(executeInWorker as Mock).mockResolvedValue({
      success: true,
      output: 'Result!',
      chatId: 'chat_1',
      durationMs: 500,
    })

    const res = await gatewayApp.request('/api/gateway/agt_pub1/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello', stream: false, async: false }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.reply).toBe('Result!')
    expect(data.runId).toBeDefined()
    expect(typeof data.durationMs).toBe('number')
  })

  it('queries run status after async invoke', async () => {
    ;(mockDb.select as Mock).mockReturnValue(makeSelectChain(publishedAgent))
    ;(executeInWorker as Mock).mockResolvedValue({
      success: true,
      output: 'Async done',
      durationMs: 300,
    })

    const invokeRes = await gatewayApp.request('/api/gateway/agt_pub1/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'do work', async: true }),
    })

    expect(invokeRes.status).toBe(202)
    const invokeJson = (await invokeRes.json()) as Json
    const invokeData = invokeJson.data as Json
    expect(invokeData.runId).toBeDefined()
    const runId = invokeData.runId as string

    const completedRun = {
      id: runId,
      status: 'completed',
      result: { output: 'Async done', durationMs: 300 },
      initiatorAgentId: 'agt_pub1',
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    }

    let selectCallCount = 0
    ;(mockDb.select as Mock).mockImplementation(() => {
      selectCallCount++
      if (selectCallCount === 1) return makeSelectChain(publishedAgent)
      return makeSelectChain(completedRun)
    })

    const statusRes = await gatewayApp.request(`/api/gateway/agt_pub1/runs/${runId}`)

    expect(statusRes.status).toBe(200)
    const statusJson = (await statusRes.json()) as Json
    const statusData = statusJson.data as Json
    expect(statusData.runId).toBe(runId)
    expect(statusData.status).toBe('completed')
    expect(statusData.result).toEqual({ output: 'Async done', durationMs: 300 })
  })
})

// ---------------------------------------------------------------------------
// Gateway Auth Tests
// ---------------------------------------------------------------------------
describe('Gateway Auth', () => {
  let gatewayApp: Hono

  const publishedAgent = {
    id: 'agt_auth1',
    name: 'Auth Agent',
    publishStatus: 'published',
    publishAuthType: 'api_key',
    publishIpWhitelist: [],
    apiKey: 'ak_correctkey',
    config: {},
    providerId: null,
    systemPrompt: null,
    skills: [],
    env: null,
    workspaceType: 'temp' as const,
    scmSourceId: null,
    type: 'cursor',
  }

  const draftAgent = { ...publishedAgent, id: 'agt_draft1', publishStatus: 'draft' }

  beforeEach(async () => {
    vi.clearAllMocks()
    ;(validateGatewayAuth as Mock).mockResolvedValue({})
    ;(mockDb.insert as Mock).mockReturnValue(makeInsertChain())
    ;(mockDb.update as Mock).mockReturnValue(makeUpdateChain())

    const mod = await import('../gateway.js')
    gatewayApp = new Hono().route('/api/gateway', mod.default)
  })

  function invokeRequest(
    agentId: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    return gatewayApp.request(`/api/gateway/${agentId}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  it('returns AGENT_NOT_PUBLISHED for unpublished agent', async () => {
    ;(mockDb.select as Mock).mockReturnValue(makeSelectChain(draftAgent))

    const res = await invokeRequest('agt_draft1', { message: 'hi' })

    expect(res.status).toBe(403)
    const json = (await res.json()) as ErrorJson
    expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_PUBLISHED)
    expect(json.error.message).toBe('Agent is not published')
  })

  it('returns AUTH_FAILED for wrong apiKey', async () => {
    ;(mockDb.select as Mock).mockReturnValue(makeSelectChain(publishedAgent))
    ;(validateGatewayAuth as Mock).mockResolvedValue({
      error: { error: 'Invalid token', status: 403 },
    })

    const res = await invokeRequest(
      'agt_auth1',
      { message: 'hi' },
      {
        Authorization: 'Bearer wrong_key',
      },
    )

    expect(res.status).toBe(403)
    const json = (await res.json()) as ErrorJson
    expect(json.error.code).toBe(GatewayErrorCode.AUTH_FAILED)
    expect(json.error.message).toBe('Invalid token')
  })

  it('returns AUTH_FAILED when Authorization header is missing', async () => {
    ;(mockDb.select as Mock).mockReturnValue(makeSelectChain(publishedAgent))
    ;(validateGatewayAuth as Mock).mockResolvedValue({
      error: { error: 'Missing Authorization header', status: 401 },
    })

    const res = await invokeRequest('agt_auth1', { message: 'hi' })

    expect(res.status).toBe(401)
    const json = (await res.json()) as ErrorJson
    expect(json.error.code).toBe(GatewayErrorCode.AUTH_FAILED)
    expect(json.error.message).toBe('Missing Authorization header')
  })

  it('returns AGENT_NOT_FOUND for non-existent agent', async () => {
    ;(mockDb.select as Mock).mockReturnValue(makeSelectChain(undefined))

    const res = await invokeRequest('agt_nonexistent', { message: 'hi' })

    expect(res.status).toBe(404)
    const json = (await res.json()) as ErrorJson
    expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_FOUND)
    expect(json.error.message).toBe('Agent not found')
  })

  it('returns AGENT_NOT_PUBLISHED for stopped agent', async () => {
    const stoppedAgent = { ...publishedAgent, id: 'agt_stopped1', publishStatus: 'stopped' }
    ;(mockDb.select as Mock).mockReturnValue(makeSelectChain(stoppedAgent))

    const res = await invokeRequest('agt_stopped1', { message: 'hi' })

    expect(res.status).toBe(403)
    const json = (await res.json()) as ErrorJson
    expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_PUBLISHED)
  })

  it('succeeds with correct apiKey on published agent', async () => {
    ;(mockDb.select as Mock).mockReturnValue(makeSelectChain(publishedAgent))
    ;(executeInWorker as Mock).mockResolvedValue({
      success: true,
      output: 'OK',
      chatId: 'chat_1',
      durationMs: 100,
    })

    const res = await invokeRequest(
      'agt_auth1',
      { message: 'hi', async: false },
      {
        Authorization: 'Bearer ak_correctkey',
      },
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.reply).toBe('OK')
  })

  it('returns INVALID_REQUEST for missing message field', async () => {
    ;(mockDb.select as Mock).mockReturnValue(makeSelectChain(publishedAgent))

    const res = await invokeRequest('agt_auth1', {})

    expect(res.status).toBe(400)
    const json = (await res.json()) as ErrorJson
    expect(json.error.code).toBe(GatewayErrorCode.INVALID_REQUEST)
  })
})
