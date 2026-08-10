import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { registerAgentEnvMaskingTests } from './agents-env-masking-cases.js'
import { registerOauthPublishTests } from './agents-oauth-publish-cases.js'
import { registerAgentSecretRedactionTests } from './agents-secret-redaction-cases.js'
import { registerSkillVisibilityCloneTests } from './agents-skill-visibility-clone-cases.js'

type Json = Record<string, unknown>

const mockBuildAgentConfig = vi.hoisted(() =>
  vi.fn().mockReturnValue({ engineType: 'cursor', maxRetries: 0 }),
)
const mockValidateAgentProviderConfiguration = vi.hoisted(() => vi.fn())
const mockResolveEngineType = vi.hoisted(() =>
  vi.fn(
    (agentConfig: { engineType?: string }, agentType?: string | null) =>
      agentConfig.engineType || agentType || 'cursor',
  ),
)

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
  engineRegistry: { get: vi.fn().mockReturnValue(true), types: [] },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('../../worker/index.js', () => ({
  executeInWorker: vi.fn(),
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  resolveWorkDir: vi.fn().mockResolvedValue('/tmp/work'),
  WorktreeOccupiedError: class extends Error {
    constructor(p: string) {
      super(`occupied: ${p}`)
      this.name = 'WorktreeOccupiedError'
    }
  },
  injectScmEnv: vi.fn(),
  buildAgentConfig: mockBuildAgentConfig,
  resolveEngineType: mockResolveEngineType,
  validateAgentProviderConfiguration: mockValidateAgentProviderConfiguration,
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

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../../lib/feishu-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/feishu-service.js')>()
  return {
    normalizeFeishuConfig: actual.normalizeFeishuConfig,
    feishuConnectionManager: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      getFeishuConnectionStatuses: vi.fn().mockReturnValue([]),
      isRegistered: vi.fn().mockReturnValue(false),
      isSocketOpen: vi.fn().mockReturnValue(false),
    },
  }
})

vi.mock('../../lib/slack-service.js', () => ({
  slackConnectionManager: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getConnectionStatuses: vi.fn().mockReturnValue([]),
    isRegistered: vi.fn().mockReturnValue(false),
    isSocketOpen: vi.fn().mockReturnValue(false),
  },
}))

vi.mock('../../lib/discord-service.js', () => ({
  discordConnectionManager: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getConnectionStatuses: vi.fn().mockReturnValue([]),
    isRegistered: vi.fn().mockReturnValue(false),
    isSocketOpen: vi.fn().mockReturnValue(false),
  },
}))

const mockRunAgentFeishuDiagnose = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    meta: { scope: 'current_api_process' as const, checkedAt: '2025-01-01T00:00:00.000Z' },
    checks: [] as Array<{ id: string; severity: 'error' | 'warn' | 'info'; message: string }>,
  }),
)

const mockCollectAgentExecutionChecks = vi.hoisted(() =>
  vi
    .fn()
    .mockReturnValue(
      [] as Array<{ id: string; severity: 'error' | 'warn' | 'info'; message: string }>,
    ),
)

vi.mock('../../lib/feishu-diagnose.js', () => ({
  runAgentFeishuDiagnose: (...args: unknown[]) => mockRunAgentFeishuDiagnose(...args),
}))

vi.mock('../../lib/agent-execution-diagnose.js', () => ({
  collectAgentExecutionChecks: (agent: unknown) => mockCollectAgentExecutionChecks(agent),
}))

vi.mock('../../lib/schedule-trigger.js', () => ({
  scheduleTriggerManager: {
    start: vi.fn(),
    stop: vi.fn(),
    getActiveAgentIds: vi.fn().mockReturnValue([]),
  },
}))

vi.mock('@a2wave/shared', async () => {
  const actual = await vi.importActual<typeof import('@a2wave/shared')>('@a2wave/shared')
  return {
    ...actual,
    createAgentInput: { safeParse: vi.fn().mockReturnValue({ success: true, data: {} }) },
    updateAgentInput: {
      safeParse: vi.fn().mockImplementation((input: unknown) => ({ success: true, data: input })),
    },
    publishAuthTypeEnum: z.enum(['none', 'api_key']),
    publishChannelEnum: z.enum(['api', 'a2a', 'feishu', 'slack', 'discord', 'schedule', 'oauth']),
    oauthAccessModeEnum: z.enum(['all_idaas_users', 'specified_users']),
    oauthAllowedEmailsSchema: z.array(z.string().trim().toLowerCase().email().max(320)).max(500),
    isSupportedScheduleCron: (v: string) =>
      /^(\S+\s+){4}\S+$/.test(v.trim()) && v.trim() !== '0 7/12 * * *',
    scheduleConfigSchema: z.object({
      cron: z
        .string()
        .min(1)
        .refine((v) => /^(\S+\s+){4}\S+$/.test(v.trim()) && v.trim() !== '0 7/12 * * *'),
      intent: z.string().min(1),
      timezone: z.string().default('Asia/Shanghai'),
    }),
    a2aSkillSchema: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      tags: z.array(z.string()).default([]),
    }),
  }
})

function makeSelectChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(result),
            all: vi.fn().mockReturnValue(result ? [result] : []),
            orderBy: vi.fn().mockReturnValue(
              asyncQuery({
                all: vi.fn().mockReturnValue(result ? [result] : []),
              }),
            ),
          }),
        ),
        orderBy: vi.fn().mockReturnValue(
          asyncQuery({
            all: vi.fn().mockReturnValue(result ? [result] : []),
          }),
        ),
        all: vi.fn().mockReturnValue(result ? [result] : []),
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

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            run: vi.fn().mockReturnValue({ changes: 1 }),
          }),
        ),
      }),
    ),
  }
}

function makeUpdateReturningChain(returnValue?: unknown) {
  return {
    set: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue(returnValue ?? {}),
              }),
            ),
            run: vi.fn(),
          }),
        ),
      }),
    ),
  }
}

function makeDeleteChain() {
  return {
    where: vi.fn().mockReturnValue(
      asyncQuery({
        run: vi.fn(),
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(undefined),
          }),
        ),
      }),
    ),
  }
}

import { db } from '../../db/client.js'
import { scheduleNext, tryAcquireSlot } from '../../engine/task-queue.js'
import { WorktreeOccupiedError, resolveWorkDir } from '../../lib/agent-helpers.js'
import { AppError, ProviderMcpUnsupportedError } from '../../lib/errors.js'
import { WorktreeBranchLockedError } from '../../lib/git-workspace.js'
import { MEMORY_OVERRIDE_MARKER } from '../../lib/memory-storage.js'
import { executeInWorker } from '../../worker/index.js'

import { asyncQuery } from '../../test/async-query.js'

/**
 * Build the test app with the same global onError shape as `apps/api/src/index.ts`
 * (AppError → its statusCode + code; everything else → 500). Without this, errors
 * thrown by `requireAgentRead/Write/Owner` would bubble up as 500 instead of 404/403.
 */
function makeAgentsApp(
  routes: import('hono').Hono,
  auth?: { userId: string; role: 'admin' | 'user' },
): Hono {
  const app = new Hono()
  if (auth) {
    app.use('*', async (c, next) => {
      c.set('userId' as never, auth.userId as never)
      c.set('userRole' as never, auth.role as never)
      await next()
    })
  }
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    return c.json({ error: 'Internal Server Error' }, 500)
  })
  app.route('/agents', routes)
  return app
}

const mockDb = db as unknown as {
  select: Mock
  insert: Mock
  update: Mock
  delete: Mock
}
const mockTryAcquireSlot = tryAcquireSlot as unknown as Mock
const mockExecuteInWorker = executeInWorker as unknown as Mock
const mockResolveWorkDir = resolveWorkDir as unknown as Mock
const mockScheduleNext = scheduleNext as unknown as Mock

beforeEach(() => {
  mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', maxRetries: 0 })
  mockValidateAgentProviderConfiguration.mockReturnValue(undefined)
  mockResolveEngineType.mockImplementation(
    (agentConfig: { engineType?: string }, agentType?: string | null) =>
      agentConfig.engineType || agentType || 'cursor',
  )
})

const SAMPLE_AGENT = {
  id: 'agt_original',
  name: 'My Agent',
  description: 'A test agent',
  type: 'cursor' as const,
  config: { model: 'gpt-4', readOnly: true },
  status: 'active' as const,
  icon: '🤖',
  systemPrompt: 'You are helpful',
  skills: ['skl_1'],
  mcpServerIds: ['mcp_1'],
  publishStatus: 'published' as const,
  endpointApiKey: 'ak_secret',
  providerApiKey: 'provider-key',
  providerBaseUrl: 'https://proxy.example.com',
  publishAuthType: 'api_key' as const,
  publishIpWhitelist: ['10.0.0.1'],
  publishDescription: 'Published desc',
  publishChannels: ['api', 'a2a'],
  a2aSkills: [{ id: 's1', name: 'Skill', description: 'desc', tags: ['t'] }],
  publishedAt: new Date('2025-01-01'),
  providerId: 'prv_1',
  env: { TOKEN: { value: 'secret', sensitive: true } },
  workspaceType: 'scm' as const,
  scmSourceId: 'scm_1',
  maxConcurrency: 3,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-06-01'),
}

describe('POST /agents', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  /**
   * `createAgentInput` has no `oauthAccessMode`, and drizzle binds the column's TS-side default
   * into the INSERT — so without an explicit value a brand-new Agent is stored on the retired
   * `feishu_scope`. Harmless to read (it normalizes to this same open mode) but it keeps
   * re-seeding rows on the value migration 0100 exists to eliminate.
   */
  it('writes a current access mode, never the retired one', async () => {
    let inserted: Record<string, unknown> = {}
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        inserted = v
        return { returning: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(v) }) }
      }),
    })

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Agent' }),
    })

    expect(res.status).toBe(201)
    expect(inserted.oauthAccessMode).toBe('all_idaas_users')
    expect(inserted.oauthAccessMode).not.toBe('feishu_scope')
  })

  it('persists the selected Provider manifest default when authMode is omitted', async () => {
    const { createAgentInput } = await import('@a2wave/shared')
    vi.mocked(createAgentInput.safeParse).mockReturnValueOnce({
      success: true,
      data: { name: 'Pi Agent', providerId: 'prv_pi' },
    } as ReturnType<typeof createAgentInput.safeParse>)
    mockDb.select.mockReturnValueOnce(makeSelectChain({ kind: 'pi' }))
    let inserted: Record<string, unknown> = {}
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockImplementation((value: Record<string, unknown>) => {
        inserted = value
        return { returning: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(value) }) }
      }),
    })

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pi Agent', providerId: 'prv_pi' }),
    })

    expect(res.status).toBe(201)
    expect(inserted.authMode).toBe('localSession')
  })
})

describe('POST /agents/:id/clone', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  it('returns 404 when agent does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(undefined))

    const res = await app.request('/agents/agt_nonexistent/clone', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as Json
    expect(body.error).toBe('Agent not found')
  })

  it('returns 201 with cloned agent', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(SAMPLE_AGENT))

    const clonedResult = {
      ...SAMPLE_AGENT,
      id: 'agt_test1',
      name: 'My Agent (Copy)',
      publishStatus: 'draft',
    }
    mockDb.insert.mockReturnValue(makeInsertChain(clonedResult))

    const res = await app.request('/agents/agt_original/clone', { method: 'POST' })
    expect(res.status).toBe(201)
    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data).toBeDefined()
    expect(data.id).toBe('agt_test1')
  })

  /**
   * Drizzle binds the column's TS-side default into the INSERT, so omitting `oauthAccessMode`
   * writes the retired `feishu_scope`, which reads normalize to the *open* mode — a clone of a
   * restricted Agent came back as "all enterprise users".
   */
  it.each([
    { mode: 'specified_users', expected: 'specified_users' },
    { mode: 'all_idaas_users', expected: 'all_idaas_users' },
    // Only an explicit `all_idaas_users` clones as open. The retired value's real boundary
    // lived in Feishu and cannot be read here, so the tier is unclear → restricted. The copy
    // must also never resurrect the retired value itself.
    { mode: 'feishu_scope', expected: 'specified_users' },
  ])(
    'clones access mode $mode as $expected, with an empty allowlist',
    async ({ mode, expected }) => {
      mockDb.select.mockReturnValue(
        makeSelectChain({
          ...SAMPLE_AGENT,
          oauthAccessMode: mode,
          oauthAllowedEmails: ['alice@example.com'],
        }),
      )
      let inserted: Record<string, unknown> = {}
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
          inserted = v
          return { returning: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(v) }) }
        }),
      })

      const res = await app.request('/agents/agt_original/clone', { method: 'POST' })

      expect(res.status).toBe(201)
      expect(inserted.oauthAccessMode).toBe(expected)
      expect(inserted.oauthAccessMode).not.toBe('feishu_scope')
      // Never inherited: the copy starts deny-all and its new owner enters their own roster,
      // which OAUTH_ALLOWED_EMAILS_REQUIRED then forces before the oauth channel can publish.
      expect(inserted.oauthAllowedEmails).toBeNull()
    },
  )

  it('appends "(Copy)" to the cloned agent name', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(SAMPLE_AGENT))

    const clonedResult = {
      ...SAMPLE_AGENT,
      id: 'agt_test2',
      name: 'My Agent (Copy)',
      publishStatus: 'draft',
    }
    mockDb.insert.mockReturnValue(makeInsertChain(clonedResult))

    const res = await app.request('/agents/agt_original/clone', { method: 'POST' })
    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.name).toBe('My Agent (Copy)')
  })

  it('sets publishStatus to draft for cloned agent', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(SAMPLE_AGENT))

    const clonedResult = { ...SAMPLE_AGENT, id: 'agt_test3', publishStatus: 'draft' }
    mockDb.insert.mockReturnValue(makeInsertChain(clonedResult))

    const res = await app.request('/agents/agt_original/clone', { method: 'POST' })
    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.publishStatus).toBe('draft')
  })

  it('copies config fields from original agent', async () => {
    // Admin clone so the MCP ownership/stdio filter keeps everything — this test
    // asserts field copy-through, not MCP filtering (covered separately).
    const adminApp = makeAgentsApp((await import('../agents.js')).default, {
      userId: 'usr_admin',
      role: 'admin',
    })
    mockDb.select.mockReturnValue(makeSelectChain(SAMPLE_AGENT))

    let capturedValues: Record<string, unknown> = {}
    mockDb.insert.mockReturnValue(
      asyncQuery({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues = vals
          return {
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue({ ...vals, id: 'agt_test4' }),
              }),
            ),
          }
        }),
      }),
    )

    await adminApp.request('/agents/agt_original/clone', { method: 'POST' })

    expect(capturedValues.description).toBe(SAMPLE_AGENT.description)
    expect(capturedValues.type).toBe(SAMPLE_AGENT.type)
    expect(capturedValues.config).toEqual(SAMPLE_AGENT.config)
    expect(capturedValues.status).toBe(SAMPLE_AGENT.status)
    expect(capturedValues.icon).toBe(SAMPLE_AGENT.icon)
    expect(capturedValues.systemPrompt).toBe(SAMPLE_AGENT.systemPrompt)
    expect(capturedValues.skills).toEqual(SAMPLE_AGENT.skills)
    expect(capturedValues.mcpServerIds).toEqual(SAMPLE_AGENT.mcpServerIds)
    expect(capturedValues.providerId).toBe(SAMPLE_AGENT.providerId)
    expect(capturedValues.workspaceType).toBe(SAMPLE_AGENT.workspaceType)
    expect(capturedValues.scmSourceId).toBe(SAMPLE_AGENT.scmSourceId)
    expect(capturedValues.maxConcurrency).toBe(SAMPLE_AGENT.maxConcurrency)
  })

  registerSkillVisibilityCloneTests({
    sampleAgent: SAMPLE_AGENT,
    createApp: async (auth) => makeAgentsApp((await import('../agents.js')).default, auth),
    makeSelectChain,
    setSelectImplementation: (implementation) => mockDb.select.mockImplementation(implementation),
    setInsertResult: (value) => mockDb.insert.mockReturnValue(value),
  })

  it('strips secrets so editor cannot walk away with the original credentials', async () => {
    // Source has a sensitive env entry, an api key, base url, and an oauth token.
    const SOURCE = {
      ...SAMPLE_AGENT,
      providerApiKey: 'provider-key-XYZ',
      providerBaseUrl: 'https://internal.proxy/anthropic',
      providerOauthToken: 'oauth-token-abc',
      authMode: 'oauth' as const,
      env: {
        TOKEN: { value: 'secret', sensitive: true },
        NODE_ENV: { value: 'production', sensitive: false },
      },
    }
    mockDb.select.mockReturnValue(makeSelectChain(SOURCE))

    let capturedValues: Record<string, unknown> = {}
    mockDb.insert.mockReturnValue(
      asyncQuery({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues = vals
          return {
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue({ ...vals, id: 'agt_clone1' }),
              }),
            ),
          }
        }),
      }),
    )

    await app.request('/agents/agt_original/clone', { method: 'POST' })

    expect(capturedValues.providerApiKey).toBeNull()
    expect(capturedValues.providerBaseUrl).toBeNull()
    expect(capturedValues.providerOauthToken).toBeNull()
    // sensitive env value is empty; non-sensitive value passes through.
    expect(capturedValues.env).toEqual({
      TOKEN: { value: '', sensitive: true },
      NODE_ENV: { value: 'production', sensitive: false },
    })
    // authMode preserved so the caller knows which credential to refill.
    expect(capturedValues.authMode).toBe(SOURCE.authMode)
  })

  it('drops admin-only / stdio MCP the non-admin cloner could not bind themselves', async () => {
    // Clone hands the new agent to the caller. If it copied a stdio (host-RCE) or
    // adminOnly MCP verbatim, a non-admin editor would keep executing it even
    // after their editor membership is revoked — mirrors the provider-secret strip.
    // Caller OWNS the source (userId matches) so requireAgentWrite resolves on the
    // fast path with a single agent select; the next select is the MCP filter.
    const editorApp = makeAgentsApp((await import('../agents.js')).default, {
      userId: 'usr_owner',
      role: 'user',
    })
    const SOURCE = {
      ...SAMPLE_AGENT,
      userId: 'usr_owner',
      mcpServerIds: ['mcp_stdio', 'mcp_sse'],
    }

    // Both owned by the caller; the stdio one is admin-only (dropped), the sse one
    // is all-users (kept).
    const mcpCandidates = [
      {
        id: 'mcp_stdio',
        type: 'stdio',
        usageScope: 'admin-only',
        groupConfig: null,
        userId: 'usr_owner',
      },
      {
        id: 'mcp_sse',
        type: 'sse',
        usageScope: 'all-users',
        groupConfig: null,
        userId: 'usr_owner',
      },
    ]
    let selectCall = 0
    mockDb.select.mockImplementation(() => {
      selectCall++
      // 1st select → requireAgentWrite loads the source agent (.get()).
      // 2nd select → the clone MCP filter loads candidate rows (.all()).
      if (selectCall === 1) return makeSelectChain(SOURCE)
      return {
        from: () => asyncQuery({ where: () => asyncQuery({ all: () => mcpCandidates }) }),
      }
    })

    let capturedValues: Record<string, unknown> = {}
    mockDb.insert.mockReturnValue(
      asyncQuery({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues = vals
          return {
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue({ ...vals, id: 'agt_clone_mcp' }),
              }),
            ),
          }
        }),
      }),
    )

    const res = await editorApp.request('/agents/agt_original/clone', { method: 'POST' })
    expect(res.status).toBe(201)
    // stdio dropped, sse kept.
    expect(capturedValues.mcpServerIds).toEqual(['mcp_sse'])
  })

  it('keeps all MCP on clone when the caller is admin', async () => {
    const adminApp = makeAgentsApp((await import('../agents.js')).default, {
      userId: 'usr_admin',
      role: 'admin',
    })
    const SOURCE = { ...SAMPLE_AGENT, mcpServerIds: ['mcp_stdio', 'mcp_sse'] }
    mockDb.select.mockReturnValue(makeSelectChain(SOURCE))

    let capturedValues: Record<string, unknown> = {}
    mockDb.insert.mockReturnValue(
      asyncQuery({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues = vals
          return {
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue({ ...vals, id: 'agt_clone_admin' }),
              }),
            ),
          }
        }),
      }),
    )

    await adminApp.request('/agents/agt_original/clone', { method: 'POST' })
    // Admin keeps everything — no MCP filter query is even needed.
    expect(capturedValues.mcpServerIds).toEqual(['mcp_stdio', 'mcp_sse'])
  })

  it("drops another owner's sse MCP when a non-admin clones a shared agent (IDOR)", async () => {
    // A viewer/editor of a SHARED agent clones it. The clone is theirs, so it must
    // not carry an sse MCP owned by someone else — otherwise it would resolve that
    // owner's private URL/headers/credentials permanently, even after unshare.
    const editorApp = makeAgentsApp((await import('../agents.js')).default, {
      userId: 'usr_bob',
      role: 'user',
    })
    // Bob is a member (editor) of an agent owned by Alice.
    const SOURCE = {
      ...SAMPLE_AGENT,
      userId: 'usr_alice',
      mcpServerIds: ['mcp_alice_sse', 'mcp_bob_sse'],
    }
    let selectCall = 0
    mockDb.select.mockImplementation(() => {
      selectCall++
      if (selectCall === 1) return makeSelectChain(SOURCE) // requireAgentWrite
      if (selectCall === 2)
        // membership lookup (editor) → non-undefined member row
        return makeSelectChain({ role: 'editor' })
      // clone MCP filter candidates
      return {
        from: () =>
          asyncQuery({
            where: () =>
              asyncQuery({
                all: () => [
                  {
                    id: 'mcp_alice_sse',
                    type: 'sse',
                    usageScope: 'private', // Alice's private server → cross-owner, dropped
                    groupConfig: null,
                    userId: 'usr_alice',
                  },
                  {
                    id: 'mcp_bob_sse',
                    type: 'sse',
                    usageScope: 'private', // Bob's own private server → kept
                    groupConfig: null,
                    userId: 'usr_bob',
                  },
                ],
              }),
          }),
      }
    })

    let capturedValues: Record<string, unknown> = {}
    mockDb.insert.mockReturnValue(
      asyncQuery({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues = vals
          return {
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue({ ...vals, id: 'agt_clone_idor' }),
              }),
            ),
          }
        }),
      }),
    )

    const res = await editorApp.request('/agents/agt_original/clone', { method: 'POST' })
    expect(res.status).toBe(201)
    // Alice's MCP dropped, Bob's own kept.
    expect(capturedValues.mcpServerIds).toEqual(['mcp_bob_sse'])
  })

  it('resets publish-related fields for cloned agent', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(SAMPLE_AGENT))

    let capturedValues: Record<string, unknown> = {}
    mockDb.insert.mockReturnValue(
      asyncQuery({
        values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedValues = vals
          return {
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue({ ...vals, id: 'agt_test5' }),
              }),
            ),
          }
        }),
      }),
    )

    await app.request('/agents/agt_original/clone', { method: 'POST' })

    expect(capturedValues.publishStatus).toBe('draft')
    expect(capturedValues.endpointApiKey).toBeNull()
    expect(capturedValues.publishDescription).toBeNull()
    expect(capturedValues.a2aSkills).toBeNull()
    expect(capturedValues.publishedAt).toBeNull()
  })
})

describe('POST /agents/:id/chat queue handling', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  it('does not delete existing run when queue is full', async () => {
    const activeAgent = {
      ...SAMPLE_AGENT,
      id: 'agt_original',
      status: 'active',
      workspaceType: 'temp',
      scmSourceId: null,
      maxConcurrency: 1,
    }
    const existingRun = {
      id: 'run_existing',
      initiatorAgentId: 'agt_original',
      status: 'completed',
      intent: 'prev message',
      executionMetadata: { some: 'prior' },
      result: { chatId: 'chat_123' },
    }

    // 捕获所有 update().set() 载荷，验证复用 run 被还原回原 intent/executionMetadata。
    const setCalls: Record<string, unknown>[] = []
    const capturingUpdate = {
      set: vi.fn((payload: Record<string, unknown>) => {
        setCalls.push(payload)
        return { where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }
      }),
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(activeAgent))
      .mockReturnValueOnce(makeSelectChain(existingRun))
    mockDb.update.mockReturnValue(capturingUpdate)
    mockDb.delete.mockReturnValue(makeDeleteChain())
    mockTryAcquireSlot.mockReturnValue('queue_full')

    const res = await app.request('/agents/agt_original/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', chatId: 'chat_123' }),
    })

    expect(res.status).toBe(429)
    expect(mockDb.delete).not.toHaveBeenCalled()
    // queue_full 时复用 run 必须被还原：intent 回到原值、executionMetadata 回到原值——
    // 否则一条从未执行的新消息污染会话历史（review [P2]）。
    const restore = setCalls.find((p) => p.intent === 'prev message')
    expect(restore).toBeDefined()
    expect(restore?.executionMetadata).toEqual({ some: 'prior' })
  })
})

describe('POST /agents/:id/publish', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  const publishBody = {
    authType: 'api_key',
    ipWhitelist: [],
    description: '',
    channels: ['feishu'],
    feishuConfig: {
      appId: 'app123',
      appSecret: 'secret456',
      groupTriggerOnAt: true,
      groupTriggerOnNewMessage: false,
      groupReplyMode: 'quote',
      topicTriggerOnAt: true,
      topicTriggerOnNewTopic: false,
      topicTriggerOnNewComment: false,
      topicReplyMode: 'topic_reply',
    },
  }

  it('keeps publishStatus as stopped when agent is currently stopped', async () => {
    const stoppedAgent = {
      ...SAMPLE_AGENT,
      publishStatus: 'stopped' as const,
      endpointApiKey: 'ak_existing',
    }
    let capturedSet: Record<string, unknown> = {}

    mockDb.select.mockReturnValue(makeSelectChain(stoppedAgent))
    mockValidateAgentProviderConfiguration.mockImplementation(() => {
      throw new ProviderMcpUnsupportedError(stoppedAgent.id, 'prv_pi', 'pi', 'Pi CLI')
    })
    mockDb.update.mockReturnValue(
      asyncQuery({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          capturedSet = values
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue(
                asyncQuery({
                  get: vi.fn().mockReturnValue({ ...stoppedAgent, ...values }),
                }),
              ),
            }),
          }
        }),
      }),
    )

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(publishBody),
    })

    expect(res.status).toBe(200)
    expect(capturedSet.publishStatus).toBe('stopped')
    expect(mockValidateAgentProviderConfiguration).not.toHaveBeenCalled()
  })

  const captureUpdate = (agent: Record<string, unknown>) => {
    let capturedSet: Record<string, unknown> = {}
    mockDb.update.mockReturnValue(
      asyncQuery({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          capturedSet = values
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue(
                asyncQuery({
                  get: vi.fn().mockReturnValue({ ...agent, ...values }),
                }),
              ),
            }),
          }
        }),
      }),
    )
    return () => capturedSet
  }

  const scheduleRunAsOwnerBody = {
    authType: 'api_key',
    ipWhitelist: [],
    description: '',
    channels: ['schedule'],
    scheduleConfig: { cron: '0 9 * * *', intent: 'daily', timezone: 'Asia/Shanghai' },
    scheduleRunAsOwner: true,
  }

  it('pins scheduleRunAsUserId to the current user when enabling scheduleRunAsOwner with a bound identity', async () => {
    const mod = await import('../agents.js')
    const authedApp = makeAgentsApp(mod.default, { userId: 'usr_me', role: 'admin' })
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, endpointApiKey: null }
    const boundUser = {
      id: 'usr_me',
      isActive: true,
      email: 'me@example.com',
      idaasSub: 'sub_me',
      displayName: 'Me',
    }
    // 1st select → requireAgentWrite(agent); 2nd select → the run-as user lookup
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(draftAgent))
      .mockReturnValueOnce(makeSelectChain(boundUser))
    const getSet = captureUpdate(draftAgent)

    const res = await authedApp.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scheduleRunAsOwnerBody),
    })

    expect(res.status).toBe(200)
    const set = getSet()
    expect(set.scheduleRunAsOwner).toBe(true)
    // pinned to the publisher server-side, never client-supplied
    expect(set.scheduleRunAsUserId).toBe('usr_me')
  })

  it('rejects enabling scheduleRunAsOwner when the current user has no bound SSO identity (400)', async () => {
    const mod = await import('../agents.js')
    const authedApp = makeAgentsApp(mod.default, { userId: 'usr_me', role: 'admin' })
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, endpointApiKey: null }
    const unboundUser = {
      id: 'usr_me',
      isActive: true,
      email: 'me@example.com',
      idaasSub: null, // never bound an SSO identity
      displayName: 'Me',
    }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(draftAgent))
      .mockReturnValueOnce(makeSelectChain(unboundUser))
    captureUpdate(draftAgent)

    const res = await authedApp.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scheduleRunAsOwnerBody),
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe(
      'SCHEDULE_RUN_AS_OWNER_REQUIRES_BOUND_IDENTITY',
    )
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('generates an independent A2A key (a2ak_ prefix) on first a2a+api_key publish and persists trustForwardedIdentity', async () => {
    const draftAgent = {
      ...SAMPLE_AGENT,
      publishStatus: 'draft' as const,
      endpointApiKey: null,
      a2aEndpointApiKey: null, // no A2A key yet
    }
    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    const getSet = captureUpdate(draftAgent)

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'none', // REST channel public…
        ipWhitelist: [],
        description: '',
        channels: ['api', 'a2a'],
        a2aAuthType: 'api_key', // …A2A requires its own key
        trustForwardedIdentity: true,
      }),
    })

    expect(res.status).toBe(200)
    const set = getSet()
    expect(set.a2aAuthType).toBe('api_key')
    expect(set.trustForwardedIdentity).toBe(true)
    expect(set.a2aEndpointApiKey).toMatch(/^a2ak_/) // independent prefix, not ak_
    // The auto-generated A2A key must be masked in the response.
    const json = (await res.json()) as { data: { a2aEndpointApiKey?: string } }
    expect(json.data.a2aEndpointApiKey).toBe('********')
  })

  it('does not regenerate the A2A key when one already exists', async () => {
    const agent = {
      ...SAMPLE_AGENT,
      publishStatus: 'draft' as const,
      a2aEndpointApiKey: 'a2ak_existing',
    }
    mockDb.select.mockReturnValue(makeSelectChain(agent))
    const getSet = captureUpdate(agent)

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
        channels: ['api', 'a2a'],
        a2aAuthType: 'api_key',
      }),
    })

    expect(res.status).toBe(200)
    expect(getSet().a2aEndpointApiKey).toBeUndefined() // untouched
  })

  it('sets publishStatus to published when agent is in draft state', async () => {
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, endpointApiKey: null }
    let capturedSet: Record<string, unknown> = {}

    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    mockDb.update.mockReturnValue(
      asyncQuery({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          capturedSet = values
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue(
                asyncQuery({
                  get: vi.fn().mockReturnValue({ ...draftAgent, ...values }),
                }),
              ),
            }),
          }
        }),
      }),
    )

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(publishBody),
    })

    expect(res.status).toBe(200)
    expect(capturedSet.publishStatus).toBe('published')
  })

  it('rejects an incompatible execution config before publishing or starting channels', async () => {
    const { feishuConnectionManager } = await import('../../lib/feishu-service.js')
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, endpointApiKey: null }

    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    mockValidateAgentProviderConfiguration.mockImplementationOnce(() => {
      throw new ProviderMcpUnsupportedError(draftAgent.id, 'prv_pi', 'pi', 'Pi CLI')
    })

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(publishBody),
    })

    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('PROVIDER_MCP_UNSUPPORTED')
    expect(mockDb.update).not.toHaveBeenCalled()
    expect(feishuConnectionManager.start).not.toHaveBeenCalled()
  })

  it('does not start feishu connection when agent is stopped', async () => {
    const { feishuConnectionManager } = await import('../../lib/feishu-service.js')
    const stoppedAgent = { ...SAMPLE_AGENT, publishStatus: 'stopped' as const }

    mockDb.select.mockReturnValue(makeSelectChain(stoppedAgent))
    mockDb.update.mockReturnValue(makeUpdateReturningChain({ ...stoppedAgent }))

    await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(publishBody),
    })

    expect(feishuConnectionManager.start).not.toHaveBeenCalled()
  })

  it('publishes Slack and Discord configs and starts both native connections', async () => {
    const { slackConnectionManager } = await import('../../lib/slack-service.js')
    const { discordConnectionManager } = await import('../../lib/discord-service.js')
    const draftAgent = {
      ...SAMPLE_AGENT,
      publishStatus: 'draft' as const,
      endpointApiKey: null,
      slackConfig: null,
      discordConfig: null,
    }
    let capturedSet: Record<string, unknown> = {}
    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    mockDb.update.mockReturnValue(
      asyncQuery({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          capturedSet = values
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue(
                asyncQuery({
                  get: vi.fn().mockReturnValue({ ...draftAgent, ...values }),
                }),
              ),
            }),
          }
        }),
      }),
    )

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        channels: ['slack', 'discord'],
        slackConfig: {
          appId: 'A123',
          appToken: 'xapp-test',
          botToken: 'xoxb-test',
        },
        discordConfig: {
          applicationId: 'D123',
          botToken: 'discord-test',
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(capturedSet.slackConfig).toEqual(
      expect.objectContaining({
        appId: 'A123',
        groupTriggerOnAt: true,
        groupReplyMode: 'thread',
      }),
    )
    expect(capturedSet.discordConfig).toEqual(
      expect.objectContaining({
        applicationId: 'D123',
        guildTriggerOnMention: true,
        guildReplyMode: 'reply',
      }),
    )
    expect(slackConnectionManager.start).toHaveBeenCalledWith(
      'agt_original',
      expect.objectContaining({ appToken: 'xapp-test', botToken: 'xoxb-test' }),
    )
    expect(discordConnectionManager.start).toHaveBeenCalledWith(
      'agt_original',
      expect.objectContaining({ botToken: 'discord-test' }),
    )
  })

  it('starts schedule trigger when publishing with schedule channel', async () => {
    const { scheduleTriggerManager } = await import('../../lib/schedule-trigger.js')
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, endpointApiKey: null }

    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    mockDb.update.mockReturnValue(
      makeUpdateReturningChain({ ...draftAgent, publishStatus: 'published' }),
    )

    const scheduleBody = {
      authType: 'api_key',
      ipWhitelist: [],
      description: '',
      channels: ['api', 'schedule'],
      scheduleConfig: { cron: '0 9 * * *', intent: 'Daily review' },
    }

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scheduleBody),
    })

    expect(res.status).toBe(200)
    expect(scheduleTriggerManager.start).toHaveBeenCalledWith('agt_original', {
      cron: '0 9 * * *',
      intent: 'Daily review',
      timezone: 'Asia/Shanghai',
    })
  })

  it('rejects unsupported schedule cron before updating publish config', async () => {
    const { scheduleTriggerManager } = await import('../../lib/schedule-trigger.js')
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, endpointApiKey: null }

    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    mockDb.update.mockReturnValue(
      makeUpdateReturningChain({ ...draftAgent, publishStatus: 'published' }),
    )

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
        channels: ['api', 'schedule'],
        scheduleConfig: { cron: '0 7/12 * * *', intent: 'Daily review' },
      }),
    })

    expect(res.status).toBe(400)
    expect(mockDb.update).not.toHaveBeenCalled()
    expect(scheduleTriggerManager.start).not.toHaveBeenCalled()
  })

  it('does not start schedule trigger when agent is stopped', async () => {
    const { scheduleTriggerManager } = await import('../../lib/schedule-trigger.js')
    const stoppedAgent = { ...SAMPLE_AGENT, publishStatus: 'stopped' as const }

    mockDb.select.mockReturnValue(makeSelectChain(stoppedAgent))
    mockDb.update.mockReturnValue(makeUpdateReturningChain({ ...stoppedAgent }))

    const scheduleBody = {
      authType: 'api_key',
      ipWhitelist: [],
      description: '',
      channels: ['api', 'schedule'],
      scheduleConfig: { cron: '0 9 * * *', intent: 'Daily review' },
    }

    await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scheduleBody),
    })

    expect(scheduleTriggerManager.start).not.toHaveBeenCalled()
  })

  it('stops schedule trigger when schedule channel is removed', async () => {
    const { scheduleTriggerManager } = await import('../../lib/schedule-trigger.js')
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, endpointApiKey: null }

    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    mockDb.update.mockReturnValue(
      makeUpdateReturningChain({ ...draftAgent, publishStatus: 'published' }),
    )

    const noScheduleBody = {
      authType: 'api_key',
      ipWhitelist: [],
      description: '',
      channels: ['api'],
    }

    await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noScheduleBody),
    })

    expect(scheduleTriggerManager.stop).toHaveBeenCalledWith('agt_original')
  })

  registerOauthPublishTests({
    getApp: () => app,
    SAMPLE_AGENT,
    mockDb,
    makeSelectChain,
    captureUpdate,
  })

  it('accepts oauth channel publish in all_idaas_users mode without feishu credentials', async () => {
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, feishuConfig: null }
    let capturedSet: Record<string, unknown> = {}
    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    mockDb.update.mockReturnValue(
      asyncQuery({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          capturedSet = values
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue(
                asyncQuery({
                  get: vi.fn().mockReturnValue({ ...draftAgent, ...values }),
                }),
              ),
            }),
          }
        }),
      }),
    )

    const body = {
      authType: 'api_key',
      ipWhitelist: [],
      description: '',
      channels: ['api', 'oauth'],
      oauthAccessMode: 'all_idaas_users',
    }
    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(res.status).toBe(200)
    expect(capturedSet.publishChannels).toContain('oauth')
    expect(capturedSet.oauthAccessMode).toBe('all_idaas_users')
    expect(capturedSet.feishuConfig).toBeUndefined()
  })

  it('preserves stored all_idaas_users mode when publish body omits oauthAccessMode', async () => {
    const existingAgent = {
      ...SAMPLE_AGENT,
      publishStatus: 'published' as const,
      feishuConfig: null,
      oauthAccessMode: 'all_idaas_users' as const,
    }
    mockDb.select.mockReturnValue(makeSelectChain(existingAgent))
    const getSet = captureUpdate(existingAgent)

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
        channels: ['api', 'oauth'],
      }),
    })

    expect(res.status).toBe(200)
    expect(getSet().oauthAccessMode).toBe('all_idaas_users')
  })

  it('accepts oauth channel publish when feishu credentials come from the request body', async () => {
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, feishuConfig: null }
    let capturedSet: Record<string, unknown> = {}
    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    mockDb.update.mockReturnValue(
      asyncQuery({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          capturedSet = values
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue(
                asyncQuery({
                  get: vi.fn().mockReturnValue({ ...draftAgent, ...values }),
                }),
              ),
            }),
          }
        }),
      }),
    )

    const body = {
      authType: 'api_key',
      ipWhitelist: [],
      description: '',
      channels: ['api', 'oauth'],
      feishuConfig: {
        appId: 'app_scope',
        appSecret: 'secret_scope',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: false,
        groupReplyMode: 'quote',
        topicTriggerOnAt: true,
        topicTriggerOnNewTopic: false,
        topicTriggerOnNewComment: false,
        topicReplyMode: 'topic_reply',
      },
    }
    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(res.status).toBe(200)
    expect(capturedSet.publishChannels).toContain('oauth')
    expect(capturedSet.publishAuthType).toBe('api_key')
  })

  it('accepts oauth channel publish when feishu credentials are preserved on the existing agent', async () => {
    const existingAgent = {
      ...SAMPLE_AGENT,
      publishStatus: 'stopped' as const,
      feishuConfig: {
        appId: 'stored_app',
        appSecret: 'stored_secret',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: false,
        groupReplyMode: 'quote' as const,
        topicTriggerOnAt: true,
        topicTriggerOnNewTopic: false,
        topicTriggerOnNewComment: false,
        topicReplyMode: 'topic_reply' as const,
        replyContentType: 'text' as const,
        sendArtifactsAsFile: true,
        fetchUserInfo: false,
      },
    }
    mockDb.select.mockReturnValue(makeSelectChain(existingAgent))
    mockDb.update.mockReturnValue(makeUpdateReturningChain({ ...existingAgent }))

    const body = {
      authType: 'api_key',
      ipWhitelist: [],
      description: '',
      channels: ['api', 'oauth'],
      // feishuConfig omitted — should fall back to stored credentials
    }
    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(res.status).toBe(200)
  })
})

describe('POST /agents/:id/stop - schedule cleanup', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  it('stops schedule trigger on agent stop', async () => {
    const { scheduleTriggerManager } = await import('../../lib/schedule-trigger.js')

    mockDb.select.mockReturnValue(makeSelectChain(SAMPLE_AGENT))
    mockDb.update.mockReturnValue(
      makeUpdateReturningChain({ ...SAMPLE_AGENT, publishStatus: 'stopped' }),
    )

    await app.request('/agents/agt_original/stop', { method: 'POST' })

    expect(scheduleTriggerManager.stop).toHaveBeenCalledWith('agt_original')
  })
})

describe('POST /agents/:id/resume', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  it('rejects an incompatible execution config before resuming or starting channels', async () => {
    const { feishuConnectionManager } = await import('../../lib/feishu-service.js')
    const stoppedAgent = { ...SAMPLE_AGENT, publishStatus: 'stopped' as const }

    mockDb.select.mockReturnValue(makeSelectChain(stoppedAgent))
    mockValidateAgentProviderConfiguration.mockImplementationOnce(() => {
      throw new ProviderMcpUnsupportedError(stoppedAgent.id, 'prv_pi', 'pi', 'Pi CLI')
    })

    const res = await app.request('/agents/agt_original/resume', { method: 'POST' })

    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('PROVIDER_MCP_UNSUPPORTED')
    expect(mockDb.update).not.toHaveBeenCalled()
    expect(feishuConnectionManager.start).not.toHaveBeenCalled()
  })
})

describe('PATCH /agents/:id - published execution-config preflight', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  it('rejects an incompatible candidate config before changing a published Agent', async () => {
    const providerChain = [
      {
        id: 'pc_pi',
        providerId: 'prv_pi',
        authMode: 'localSession',
        model: 'anthropic/claude-sonnet-4-6',
        enabled: true,
      },
    ]
    mockDb.select.mockReturnValue(makeSelectChain(SAMPLE_AGENT))
    mockValidateAgentProviderConfiguration.mockImplementationOnce(() => {
      throw new ProviderMcpUnsupportedError(SAMPLE_AGENT.id, 'prv_pi', 'pi', 'Pi CLI')
    })

    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcpServerIds: ['mcp_1'],
        config: { providerChain },
      }),
    })

    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('PROVIDER_MCP_UNSUPPORTED')
    expect(mockValidateAgentProviderConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServerIds: ['mcp_1'],
        config: { providerChain },
      }),
    )
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('removes legacy memory overrides after disabling memory successfully', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'a2wave-agent-patch-'))
    const instructionFiles = ['CLAUDE.md', 'AGENTS.md', '.cursorrules']

    for (const file of instructionFiles) {
      writeFileSync(
        join(workDir, file),
        [
          `# ${file}`,
          MEMORY_OVERRIDE_MARKER,
          'Use the a2wave memory system.',
          MEMORY_OVERRIDE_MARKER,
          'Keep this line.',
          '',
        ].join('\n'),
        'utf-8',
      )
    }

    try {
      const publishedAgent = {
        ...SAMPLE_AGENT,
        config: { ...SAMPLE_AGENT.config, memoryEnabled: true },
      }
      const updatedAgent = {
        ...publishedAgent,
        config: { ...publishedAgent.config, memoryEnabled: false },
      }
      mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))
      mockDb.update.mockReturnValue(makeUpdateReturningChain(updatedAgent))
      mockResolveWorkDir.mockResolvedValue(workDir)

      const res = await app.request('/agents/agt_original', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: updatedAgent.config }),
      })

      expect(res.status).toBe(200)
      for (const file of instructionFiles) {
        expect(readFileSync(join(workDir, file), 'utf-8')).toBe(
          [`# ${file}`, 'Keep this line.', ''].join('\n'),
        )
      }
    } finally {
      mockResolveWorkDir.mockResolvedValue('/tmp/work')
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('leaves memory files unchanged when a published update fails provider preflight', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'a2wave-agent-patch-'))
    const agentInstructionsPath = join(workDir, 'AGENTS.md')
    const originalInstructions = [
      '# Agent instructions',
      MEMORY_OVERRIDE_MARKER,
      'Use the a2wave memory system.',
      MEMORY_OVERRIDE_MARKER,
      '',
    ].join('\n')
    writeFileSync(agentInstructionsPath, originalInstructions, 'utf-8')

    try {
      const publishedAgent = {
        ...SAMPLE_AGENT,
        config: { ...SAMPLE_AGENT.config, memoryEnabled: true },
      }
      mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))
      mockResolveWorkDir.mockResolvedValue(workDir)
      mockValidateAgentProviderConfiguration.mockImplementationOnce(() => {
        throw new ProviderMcpUnsupportedError(publishedAgent.id, 'prv_pi', 'pi', 'Pi CLI')
      })

      const res = await app.request('/agents/agt_original', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { ...publishedAgent.config, memoryEnabled: false },
        }),
      })

      expect(res.status).toBe(409)
      expect(readFileSync(agentInstructionsPath, 'utf-8')).toBe(originalInstructions)
      expect(mockResolveWorkDir).not.toHaveBeenCalled()
    } finally {
      mockResolveWorkDir.mockResolvedValue('/tmp/work')
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('leaves memory files unchanged when the database update fails', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'a2wave-agent-patch-'))
    const agentInstructionsPath = join(workDir, 'AGENTS.md')
    const originalInstructions = [
      '# Agent instructions',
      MEMORY_OVERRIDE_MARKER,
      'Use the a2wave memory system.',
      MEMORY_OVERRIDE_MARKER,
      '',
    ].join('\n')
    writeFileSync(agentInstructionsPath, originalInstructions, 'utf-8')

    try {
      const publishedAgent = {
        ...SAMPLE_AGENT,
        config: { ...SAMPLE_AGENT.config, memoryEnabled: true },
      }
      mockDb.select.mockReturnValue(makeSelectChain(publishedAgent))
      mockResolveWorkDir.mockResolvedValue(workDir)
      mockDb.update.mockImplementationOnce(() => {
        throw new Error('database unavailable')
      })

      const res = await app.request('/agents/agt_original', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { ...publishedAgent.config, memoryEnabled: false },
        }),
      })

      expect(res.status).toBe(500)
      expect(readFileSync(agentInstructionsPath, 'utf-8')).toBe(originalInstructions)
    } finally {
      mockResolveWorkDir.mockResolvedValue('/tmp/work')
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('preflights a partial published update against the unchanged execution config', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(SAMPLE_AGENT))
    mockDb.update.mockReturnValue(makeUpdateReturningChain(SAMPLE_AGENT))

    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Updated description' }),
    })

    expect(res.status).toBe(200)
    expect(mockValidateAgentProviderConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Updated description',
        config: SAMPLE_AGENT.config,
        mcpServerIds: SAMPLE_AGENT.mcpServerIds,
        providerId: SAMPLE_AGENT.providerId,
      }),
    )
  })

  it.each(['draft', 'stopped'] as const)(
    'keeps a %s Agent editable while its execution config is being repaired',
    async (publishStatus) => {
      const inactiveAgent = { ...SAMPLE_AGENT, publishStatus }
      mockDb.select.mockReturnValue(makeSelectChain(inactiveAgent))
      mockDb.update.mockReturnValue(makeUpdateReturningChain(inactiveAgent))
      mockValidateAgentProviderConfiguration.mockImplementation(() => {
        throw new ProviderMcpUnsupportedError(inactiveAgent.id, 'prv_pi', 'pi', 'Pi CLI')
      })

      const res = await app.request('/agents/agt_original', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Repair in progress' }),
      })

      expect(res.status).toBe(200)
      expect(mockValidateAgentProviderConfiguration).not.toHaveBeenCalled()
      expect(mockDb.update).toHaveBeenCalledOnce()
    },
  )
})

describe('DELETE /agents/:id - connection cleanup', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  it('stops both feishu and schedule connections on delete', async () => {
    const { feishuConnectionManager } = await import('../../lib/feishu-service.js')
    const { scheduleTriggerManager } = await import('../../lib/schedule-trigger.js')

    // 删除加固：published agent 会被 409 拦在 cleanup 之前（须先停用）。
    // 本用例验证的是「可删除态删除时停掉两类连接」，故用 stopped 态 fixture。
    mockDb.select.mockReturnValue(makeSelectChain({ ...SAMPLE_AGENT, publishStatus: 'stopped' }))
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockDb.delete.mockReturnValue(makeDeleteChain())

    await app.request('/agents/agt_original', { method: 'DELETE' })

    expect(feishuConnectionManager.stop).toHaveBeenCalledWith('agt_original')
    expect(scheduleTriggerManager.stop).toHaveBeenCalledWith('agt_original')
  })

  it('blocks deleting a published agent with 409 and skips all cleanup', async () => {
    const { feishuConnectionManager } = await import('../../lib/feishu-service.js')
    const { scheduleTriggerManager } = await import('../../lib/schedule-trigger.js')

    // 删除加固契约：published 必须先停用，409 拦截且不触达任何 cleanup / 实际删除。
    mockDb.select.mockReturnValue(makeSelectChain({ ...SAMPLE_AGENT, publishStatus: 'published' }))

    const res = await app.request('/agents/agt_original', { method: 'DELETE' })

    expect(res.status).toBe(409)
    expect(feishuConnectionManager.stop).not.toHaveBeenCalled()
    expect(scheduleTriggerManager.stop).not.toHaveBeenCalled()
    expect(mockDb.delete).not.toHaveBeenCalled()
  })
})

describe('GET /agents/:id/diagnose', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockCollectAgentExecutionChecks.mockReturnValue([
      { id: 'provider_not_selected', severity: 'warn', message: '未选择 Provider' },
    ])
    mockRunAgentFeishuDiagnose.mockResolvedValue({
      ok: true,
      meta: { scope: 'current_api_process', checkedAt: '2025-01-01T00:00:00.000Z' },
      checks: [{ id: 'feishu_channel_off', severity: 'info', message: '未启用飞书' }],
    })
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  it('merges execution checks with feishu checks', async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain({ ...SAMPLE_AGENT, providerId: null, publishChannels: ['api'] }),
    )

    const res = await app.request('/agents/agt_original/diagnose')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    const data = json.data as { ok: boolean; checks: Array<{ id: string }> }
    expect(data.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['provider_not_selected', 'feishu_channel_off']),
    )
    expect(data.ok).toBe(true)
  })

  it('ok is false when any merged check has severity error', async () => {
    mockCollectAgentExecutionChecks.mockReturnValue([
      { id: 'provider_record_missing', severity: 'error', message: 'Provider 不存在' },
    ])
    mockRunAgentFeishuDiagnose.mockResolvedValue({
      ok: true,
      meta: { scope: 'current_api_process', checkedAt: '2025-01-01T00:00:00.000Z' },
      checks: [],
    })
    mockDb.select.mockReturnValue(makeSelectChain(SAMPLE_AGENT))

    const res = await app.request('/agents/agt_original/diagnose')
    const json = (await res.json()) as Json
    const data = json.data as { ok: boolean }
    expect(data.ok).toBe(false)
  })

  it('reports a disconnected enabled Slack channel as an error', async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain({
        ...SAMPLE_AGENT,
        publishStatus: 'published',
        publishChannels: ['slack'],
        slackConfig: { appId: 'A123', appToken: 'xapp-test', botToken: 'xoxb-test' },
      }),
    )

    const res = await app.request('/agents/agt_original/diagnose')
    const json = (await res.json()) as Json
    const data = json.data as { ok: boolean; checks: Array<{ id: string; severity: string }> }
    expect(data.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'slack_connection_closed', severity: 'error' }),
      ]),
    )
    expect(data.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Chat execution — shared agent fixture (temp workspace, no SCM check)
// ---------------------------------------------------------------------------
const CHAT_AGENT = {
  ...SAMPLE_AGENT,
  id: 'agt_chat',
  status: 'active' as const,
  workspaceType: 'temp' as const,
  scmSourceId: null,
  maxConcurrency: 1,
}

describe('POST /agents/:id/chat — sync execution', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockTryAcquireSlot.mockReturnValue('acquired')
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  function chatRequest(body: Record<string, unknown>) {
    return app.request('/agents/agt_chat/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns reply on successful sync execution', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockExecuteInWorker.mockResolvedValue({
      success: true,
      output: 'Hello from agent',
      chatId: 'chat_1',
      durationMs: 500,
    })

    const res = await chatRequest({ message: 'hi' })
    expect(res.status).toBe(200)

    const json = (await res.json()) as Json
    const data = json.data as Json
    expect(data.reply).toBe('Hello from agent')
    expect(data.chatId).toBe('chat_1')
    expect(typeof data.durationMs).toBe('number')
    expect(data.runId).toBeDefined()
  })

  it('returns 500 when execution fails with success=false', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'Model timeout',
      durationMs: 100,
    })

    const res = await chatRequest({ message: 'hi' })
    expect(res.status).toBe(500)

    const json = (await res.json()) as Json
    expect(json.error).toBe('Model timeout')
  })

  it('returns 500 when execution throws', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockExecuteInWorker.mockRejectedValue(new Error('Worker crashed'))

    const res = await chatRequest({ message: 'hi' })
    expect(res.status).toBe(500)
  })

  it('returns 404 when agent does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(undefined))

    const res = await chatRequest({ message: 'hi' })
    expect(res.status).toBe(404)
  })

  it('returns 400 when message is missing', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))

    const res = await chatRequest({})
    expect(res.status).toBe(400)
  })
})

describe('POST /agents/:id/chat — stream execution', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockTryAcquireSlot.mockReturnValue('acquired')
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  function chatRequest(body: Record<string, unknown>) {
    return app.request('/agents/agt_chat/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns SSE done event on successful stream execution', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockExecuteInWorker.mockResolvedValue({
      success: true,
      output: 'Stream reply',
      chatId: 'chat_s1',
      durationMs: 500,
    })

    const res = await chatRequest({ message: 'hi', stream: true })
    const text = await res.text()

    expect(text).toContain('event: done')
    expect(text).toContain('"reply":"Stream reply"')
    expect(text).toContain('"chatId":"chat_s1"')
  })

  it('returns SSE error event when execution returns success=false', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'Model error',
      durationMs: 100,
    })

    const res = await chatRequest({ message: 'hi', stream: true })
    const text = await res.text()

    expect(text).toContain('event: error')
    expect(text).toContain('Model error')
  })

  it('returns SSE error event when execution throws', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockExecuteInWorker.mockRejectedValue(new Error('Worker crashed'))

    const res = await chatRequest({ message: 'hi', stream: true })
    const text = await res.text()

    expect(text).toContain('event: error')
  })

  it('forwards log entries as SSE log events', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockExecuteInWorker.mockImplementation(
      (_taskId: string, _payload: unknown, options?: { onLogEntry?: (entry: unknown) => void }) => {
        options?.onLogEntry?.({ type: 'system', subtype: 'init', model: 'gpt-4', ts: Date.now() })
        return Promise.resolve({ success: true, output: 'ok', durationMs: 100 })
      },
    )

    const res = await chatRequest({ message: 'hi', stream: true })
    const text = await res.text()

    expect(text).toContain('event: log')
  })
})

describe('POST /agents/:id/chat — worktree 409', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    mockTryAcquireSlot.mockReturnValue('acquired')
    // Default: resolveWorkDir succeeds; tests below override to reject
    mockResolveWorkDir.mockResolvedValue('/tmp/work')
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  function chatRequest(body: Record<string, unknown>) {
    return app.request('/agents/agt_chat/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns 409 and deletes newly-created run when resolveWorkDir throws WorktreeOccupiedError', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockDb.delete.mockReturnValue(makeDeleteChain())
    mockResolveWorkDir.mockRejectedValueOnce(new WorktreeOccupiedError('/tmp/wt-a'))

    const res = await chatRequest({
      message: 'hi',
      worktree: { name: 'wt-a', cleanup: 'ephemeral' },
    })
    expect(res.status).toBe(409)
    const json = (await res.json()) as Json
    expect(String(json.error)).toContain('occupied')

    // newly-created run must be deleted
    expect(mockDb.delete).toHaveBeenCalled()

    // scheduler should be re-triggered so queued work resumes
    expect(mockScheduleNext).toHaveBeenCalled()

    // Worker must not run
    expect(mockExecuteInWorker).not.toHaveBeenCalled()
  })

  it('returns 409 on WorktreeBranchLockedError with scheduleNext + run delete', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockDb.delete.mockReturnValue(makeDeleteChain())
    mockResolveWorkDir.mockRejectedValueOnce(
      new WorktreeBranchLockedError('feature-x', 'owner-run'),
    )

    const res = await chatRequest({
      message: 'hi',
      worktree: { name: 'wt-locked', cleanup: 'persistent' },
    })
    expect(res.status).toBe(409)
    const json = (await res.json()) as Json
    expect(String(json.error)).toContain('locked')
    expect(mockDb.delete).toHaveBeenCalled()
    expect(mockScheduleNext).toHaveBeenCalled()
    expect(mockExecuteInWorker).not.toHaveBeenCalled()
  })

  it('does NOT delete run when reusing existing run (chatId) but still returns 409 + scheduleNext', async () => {
    const existingRun = {
      id: 'run_existing',
      initiatorAgentId: 'agt_chat',
      intent: 'prev',
      status: 'completed',
      result: { chatId: 'chat_reuse' },
    }
    // 1st select → agent; 2nd select → existing run for chatId
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(CHAT_AGENT))
      .mockReturnValueOnce(makeSelectChain(existingRun))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockDb.delete.mockReturnValue(makeDeleteChain())
    mockResolveWorkDir.mockRejectedValueOnce(new WorktreeOccupiedError('/tmp/wt-a'))

    const res = await chatRequest({
      message: 'hi',
      chatId: 'chat_reuse',
      worktree: { name: 'wt-a', cleanup: 'ephemeral' },
    })
    expect(res.status).toBe(409)

    // Reused run should NOT be deleted
    expect(mockDb.delete).not.toHaveBeenCalled()

    // It should be reset back to pending (an update call)
    expect(mockDb.update).toHaveBeenCalled()

    expect(mockScheduleNext).toHaveBeenCalled()
  })

  it('rethrows non-worktree errors (no 409 capture)', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(CHAT_AGENT))
    mockDb.insert.mockReturnValue(makeInsertChain())
    mockDb.update.mockReturnValue(makeUpdateChain())
    mockDb.delete.mockReturnValue(makeDeleteChain())
    mockResolveWorkDir.mockRejectedValueOnce(new Error('disk exploded'))

    const res = await chatRequest({
      message: 'hi',
      worktree: { name: 'wt-a', cleanup: 'ephemeral' },
    })
    // Generic error → 500 via Hono onError; must NOT be 409
    expect(res.status).not.toBe(409)
  })
})

// ── feishuConfig 旧格式兼容集成测试 ─────────────────────────────

describe('feishuConfig legacy normalization in HTTP handlers', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  const EXISTING_FEISHU_SECRET = 'real_secret_value'
  const agentWithOldFeishuConfig = {
    ...SAMPLE_AGENT,
    publishStatus: 'published' as const,
    publishChannels: ['feishu'],
    feishuConfig: {
      appId: 'cli_old',
      appSecret: EXISTING_FEISHU_SECRET,
      triggerOnAt: true,
      triggerOnNewMessage: false,
      replyMode: 'quote' as const,
      replyContentType: 'text' as const,
      sendArtifactsAsFile: true,
    },
  }

  function mockDbForUpdate(existingAgent: Record<string, unknown>) {
    let capturedSet: Record<string, unknown> = {}
    mockDb.select.mockReturnValue(makeSelectChain(existingAgent))
    mockDb.update.mockReturnValue(
      asyncQuery({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          capturedSet = values
          return {
            where: vi.fn().mockReturnValue(
              asyncQuery({
                returning: vi.fn().mockReturnValue(
                  asyncQuery({
                    get: vi.fn().mockReturnValue({ ...existingAgent, ...values }),
                  }),
                ),
                run: vi.fn(),
              }),
            ),
          }
        }),
      }),
    )
    return { getCaptured: () => capturedSet }
  }

  // ── PATCH /agents/:id ──
  // 注：PATCH 使用 shared 的 updateAgentInput（未 passthrough），旧字段会被 zod 剥离。
  // 因此 PATCH 测试验证新格式 + normalizeFeishuConfig 补齐默认值的场景。

  it('PATCH: 新格式不完整 payload 经 normalizeFeishuConfig 补齐默认值后写入 DB', async () => {
    const { getCaptured } = mockDbForUpdate(SAMPLE_AGENT)

    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feishuConfig: {
          appId: 'cli_new',
          appSecret: 'secret789',
          groupTriggerOnAt: false,
          groupReplyMode: 'new',
        },
      }),
    })

    expect(res.status).toBe(200)
    const saved = getCaptured().feishuConfig as Record<string, unknown>
    expect(saved.groupTriggerOnAt).toBe(false)
    expect(saved.groupReplyMode).toBe('new')
    // normalizeFeishuConfig 补齐的默认值
    expect(saved.topicTriggerOnAt).toBe(true)
    expect(saved.topicTriggerOnNewTopic).toBe(false)
    expect(saved.topicReplyMode).toBe('topic_reply')
  })

  it('PATCH: appSecret 为 *** 时还原已有 secret', async () => {
    const { getCaptured } = mockDbForUpdate(agentWithOldFeishuConfig)

    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feishuConfig: {
          appId: 'cli_old',
          appSecret: '********',
          groupTriggerOnAt: true,
          groupReplyMode: 'quote',
        },
      }),
    })

    expect(res.status).toBe(200)
    const saved = getCaptured().feishuConfig as Record<string, unknown>
    expect(saved.appSecret).toBe(EXISTING_FEISHU_SECRET)
  })

  // ── POST /agents/:id/publish ──

  it('publish: 新格式 feishuConfig 经 normalizeFeishuConfig 补齐默认值后写入 DB', async () => {
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, endpointApiKey: null }
    const { getCaptured } = mockDbForUpdate(draftAgent)

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
        channels: ['feishu'],
        feishuConfig: {
          appId: 'cli_pub',
          appSecret: 'pub_secret',
          groupTriggerOnAt: false,
          groupTriggerOnNewMessage: true,
          groupReplyMode: 'none',
        },
      }),
    })

    expect(res.status).toBe(200)
    const saved = getCaptured().feishuConfig as Record<string, unknown>
    expect(saved.groupTriggerOnAt).toBe(false)
    expect(saved.groupTriggerOnNewMessage).toBe(true)
    expect(saved.groupReplyMode).toBe('none')
    // normalizeFeishuConfig 补齐的话题群默认值
    expect(saved.topicTriggerOnAt).toBe(true)
    expect(saved.topicTriggerOnNewTopic).toBe(false)
    expect(saved.topicReplyMode).toBe('topic_reply')
  })

  it('publish: appSecret 为 *** 时还原已有 secret', async () => {
    const { getCaptured } = mockDbForUpdate(agentWithOldFeishuConfig)

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
        channels: ['feishu'],
        feishuConfig: {
          appId: 'cli_old',
          appSecret: '********',
          groupTriggerOnAt: true,
          groupReplyMode: 'quote',
        },
      }),
    })

    expect(res.status).toBe(200)
    const saved = getCaptured().feishuConfig as Record<string, unknown>
    expect(saved.appSecret).toBe(EXISTING_FEISHU_SECRET)
  })
})

registerAgentSecretRedactionTests({
  SAMPLE_AGENT,
  makeAgentsApp,
  makeSelectChain,
  mockDb,
})
registerAgentEnvMaskingTests({
  SAMPLE_AGENT,
  makeAgentsApp,
  makeSelectChain,
  mockDb,
})
describe('Provider chain API compatibility', () => {
  async function createAgentsRouteApp() {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    return makeAgentsApp(mod.default)
  }

  function mockDbForUpdate(existingAgent: Record<string, unknown>) {
    let capturedSet: Record<string, unknown> = {}
    mockDb.select.mockReturnValue(makeSelectChain(existingAgent))
    mockDb.update.mockReturnValue(
      asyncQuery({
        set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
          capturedSet = values
          return {
            where: vi.fn().mockReturnValue(
              asyncQuery({
                returning: vi.fn().mockReturnValue(
                  asyncQuery({
                    get: vi.fn().mockReturnValue({ ...existingAgent, ...values }),
                  }),
                ),
                run: vi.fn(),
              }),
            ),
          }
        }),
      }),
    )
    return { getCaptured: () => capturedSet }
  }

  it('GET /agents/:id masks providerChain apiKey/baseUrl AND legacy top-level provider secrets, reveals OAuth token', async () => {
    const app = await createAgentsRouteApp()
    const agentWithChain = {
      ...SAMPLE_AGENT,
      providerId: 'prv_legacy',
      providerApiKey: 'legacy-api-key',
      providerBaseUrl: 'https://legacy.example.com',
      providerOauthToken: null,
      authMode: 'apiKey' as const,
      config: {
        providerChain: [
          {
            id: 'pc_primary',
            providerId: 'prv_primary',
            authMode: 'apiKey',
            providerApiKey: 'primary-secret',
            providerBaseUrl: 'https://primary.example.com',
            enabled: true,
          },
          {
            id: 'pc_fallback',
            providerId: 'prv_fallback',
            authMode: 'oauth',
            providerOauthToken: 'fallback-oauth-secret',
            enabled: true,
          },
        ],
      },
    }
    mockDb.select.mockReturnValue(makeSelectChain(agentWithChain))

    const res = await app.request('/agents/agt_original', { method: 'GET' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        providerId: string
        providerApiKey: string
        providerBaseUrl: string
        config: { providerChain: Array<Record<string, unknown>> }
      }
    }
    expect(body.data.providerId).toBe('prv_legacy')
    // Legacy top-level provider credentials are secrets too — must be masked in
    // every read (this endpoint is reachable by viewers). The frontend reads
    // credentials only from config.providerChain, so masking the column is safe.
    expect(body.data.providerApiKey).toBe('********')
    expect(body.data.providerBaseUrl).toBe('********')
    expect(body.data.config.providerChain[0]?.providerApiKey).toBe('********')
    expect(body.data.config.providerChain[0]?.providerBaseUrl).toBe('********')
    // OAuth Token 在单个详情接口回传明文（供编辑页"点眼睛查看"），apiKey/baseUrl 仍脱敏。
    expect(body.data.config.providerChain[1]?.providerOauthToken).toBe('fallback-oauth-secret')
  })

  it('PATCH /agents/:id preserves providerChain secrets when client sends masked placeholders', async () => {
    const app = await createAgentsRouteApp()
    const existingAgent = {
      ...SAMPLE_AGENT,
      config: {
        providerChain: [
          {
            id: 'pc_primary',
            providerId: 'prv_primary',
            authMode: 'apiKey',
            providerApiKey: 'primary-secret',
            providerBaseUrl: 'https://primary.example.com',
            enabled: true,
          },
          {
            id: 'pc_fallback',
            providerId: 'prv_fallback',
            authMode: 'oauth',
            providerOauthToken: 'fallback-oauth-secret',
            enabled: true,
          },
        ],
      },
    }
    const { getCaptured } = mockDbForUpdate(existingAgent)

    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          providerChain: [
            {
              id: 'pc_primary',
              providerId: 'prv_primary',
              authMode: 'apiKey',
              providerApiKey: '********',
              providerBaseUrl: '********',
              enabled: true,
            },
            {
              id: 'pc_fallback',
              providerId: 'prv_fallback',
              authMode: 'oauth',
              providerOauthToken: '********',
              enabled: true,
            },
          ],
        },
      }),
    })

    expect(res.status).toBe(200)
    const savedConfig = getCaptured().config as { providerChain: Array<Record<string, unknown>> }
    expect(savedConfig.providerChain[0]?.providerApiKey).toBe('primary-secret')
    expect(savedConfig.providerChain[0]?.providerBaseUrl).toBe('https://primary.example.com')
    expect(savedConfig.providerChain[1]?.providerOauthToken).toBe('fallback-oauth-secret')

    const body = (await res.json()) as {
      data: { config: { providerChain: Array<Record<string, unknown>> } }
    }
    expect(body.data.config.providerChain[0]?.providerApiKey).toBe('********')
    expect(body.data.config.providerChain[0]?.providerBaseUrl).toBe('********')
    expect(body.data.config.providerChain[1]?.providerOauthToken).toBe('********')
  })

  it('PATCH /agents/:id preserves legacy OAuth token during first providerChain migration', async () => {
    const app = await createAgentsRouteApp()
    const legacyOauthAgent = {
      ...SAMPLE_AGENT,
      providerId: 'prv_legacy',
      providerApiKey: null,
      providerBaseUrl: 'https://legacy.example.com',
      providerOauthToken: 'legacy-oauth-secret',
      authMode: 'oauth' as const,
      config: { model: 'legacy-model', force: true },
    }
    const { getCaptured } = mockDbForUpdate(legacyOauthAgent)

    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          model: 'legacy-model',
          providerChain: [
            {
              id: 'pc_migrated',
              providerId: 'prv_legacy',
              authMode: 'oauth',
              providerOauthToken: '********',
              providerBaseUrl: '********',
              enabled: true,
            },
          ],
        },
      }),
    })

    expect(res.status).toBe(200)
    const savedConfig = getCaptured().config as { providerChain: Array<Record<string, unknown>> }
    expect(savedConfig.providerChain[0]?.providerOauthToken).toBe('legacy-oauth-secret')
    expect(savedConfig.providerChain[0]?.providerBaseUrl).toBe('https://legacy.example.com')
  })

  it('PATCH /agents/:id preserves top-level Provider placeholders sent from masked chain rows', async () => {
    const app = await createAgentsRouteApp()
    const existingAgent = {
      ...SAMPLE_AGENT,
      providerId: 'prv_primary',
      providerApiKey: 'legacy-api-key',
      providerBaseUrl: 'https://legacy.example.com',
      providerOauthToken: null,
      authMode: 'apiKey' as const,
      config: {
        providerChain: [
          {
            id: 'pc_primary',
            providerId: 'prv_primary',
            authMode: 'apiKey',
            providerApiKey: 'legacy-api-key',
            providerBaseUrl: 'https://legacy.example.com',
            enabled: true,
          },
        ],
      },
    }
    const { getCaptured } = mockDbForUpdate(existingAgent)

    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: 'prv_primary',
        providerApiKey: '********',
        providerBaseUrl: '********',
        authMode: 'apiKey',
        config: {
          providerChain: [
            {
              id: 'pc_primary',
              providerId: 'prv_primary',
              authMode: 'apiKey',
              providerApiKey: '********',
              providerBaseUrl: '********',
              enabled: true,
            },
          ],
        },
      }),
    })

    expect(res.status).toBe(200)
    const saved = getCaptured()
    expect(saved.providerApiKey).toBe('legacy-api-key')
    expect(saved.providerBaseUrl).toBe('https://legacy.example.com')
  })

  it('PATCH /agents/:id does not restore masked secrets after provider identity changes', async () => {
    const app = await createAgentsRouteApp()
    const existingAgent = {
      ...SAMPLE_AGENT,
      config: {
        providerChain: [
          {
            id: 'pc_primary',
            providerId: 'prv_primary',
            authMode: 'apiKey',
            providerApiKey: 'primary-secret',
            providerBaseUrl: 'https://primary.example.com',
            enabled: true,
          },
        ],
      },
    }
    const { getCaptured } = mockDbForUpdate(existingAgent)

    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          providerChain: [
            {
              id: 'pc_primary',
              providerId: 'prv_other',
              authMode: 'apiKey',
              providerApiKey: '********',
              providerBaseUrl: '********',
              enabled: true,
            },
          ],
        },
      }),
    })

    expect(res.status).toBe(200)
    const savedConfig = getCaptured().config as { providerChain: Array<Record<string, unknown>> }
    expect(savedConfig.providerChain[0]?.providerApiKey).toBeNull()
    expect(savedConfig.providerChain[0]?.providerBaseUrl).toBeNull()
  })

  it('PATCH /agents/:id preserves idless providerChain secrets by stable position and identity', async () => {
    const app = await createAgentsRouteApp()
    const existingAgent = {
      ...SAMPLE_AGENT,
      config: {
        providerChain: [
          {
            providerId: 'prv_primary',
            authMode: 'apiKey',
            providerApiKey: 'primary-secret',
            enabled: true,
          },
        ],
      },
    }
    const { getCaptured } = mockDbForUpdate(existingAgent)

    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          providerChain: [
            {
              id: 'pc_generated_by_ui',
              providerId: 'prv_primary',
              authMode: 'apiKey',
              providerApiKey: '********',
              enabled: true,
            },
          ],
        },
      }),
    })

    expect(res.status).toBe(200)
    const savedConfig = getCaptured().config as { providerChain: Array<Record<string, unknown>> }
    expect(savedConfig.providerChain[0]?.providerApiKey).toBe('primary-secret')
  })

  it('PATCH /agents/:id with legacy-only Provider config does not force providerChain migration', async () => {
    const app = await createAgentsRouteApp()
    const legacyAgent = {
      ...SAMPLE_AGENT,
      providerId: 'prv_legacy',
      providerApiKey: 'legacy-api-key',
      providerBaseUrl: 'https://legacy.example.com',
      providerOauthToken: null,
      authMode: 'apiKey' as const,
      config: { model: 'legacy-model', force: true },
    }
    const { getCaptured } = mockDbForUpdate(legacyAgent)

    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Legacy Agent Renamed' }),
    })

    expect(res.status).toBe(200)
    const saved = getCaptured()
    expect(saved.name).toBe('Legacy Agent Renamed')
    expect(saved).not.toHaveProperty('providerChain')
    expect(saved).not.toHaveProperty('providerId')
    expect(saved).not.toHaveProperty('providerApiKey')
    expect(saved).not.toHaveProperty('providerBaseUrl')
    expect(saved).not.toHaveProperty('authMode')
  })
})

// A chain that satisfies every shape the /:id/stats handler uses:
// from → where → { get, all, groupBy.*, orderBy.*, limit.* }.
function makeStatsChain(getResult: unknown, allResult: unknown[]) {
  // `.groupBy()` marks a LIST query, so from there on only `allResult` may be
  // consulted: asyncQuery prefers `get`, and a scalar getResult configured for
  // the sibling single-row lookups would otherwise leak in as a phantom row.
  const grouped: Record<string, unknown> = { all: vi.fn().mockReturnValue(allResult) }
  grouped.groupBy = vi.fn().mockReturnValue(grouped)
  grouped.orderBy = vi.fn().mockReturnValue(grouped)
  grouped.limit = vi.fn().mockReturnValue(grouped)

  const terminal: Record<string, unknown> = {
    get: vi.fn().mockReturnValue(getResult),
    all: vi.fn().mockReturnValue(allResult),
  }
  terminal.groupBy = vi.fn().mockReturnValue(grouped)
  terminal.orderBy = vi.fn().mockReturnValue(terminal)
  terminal.limit = vi.fn().mockReturnValue(terminal)
  return { from: vi.fn().mockReturnValue(asyncQuery({ where: vi.fn().mockReturnValue(terminal) })) }
}

describe('GET /agents/:id/stats', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default)
  })

  it('returns 404 when agent does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(undefined))

    const res = await app.request('/agents/agt_nonexistent/stats')
    expect(res.status).toBe(404)
    const body = (await res.json()) as Json
    expect(body.error).toBe('Agent not found')
  })

  it('returns empty aggregates when the agent has no runs', async () => {
    // 1st select = agent visibility check; the rest = empty run aggregates.
    mockDb.select
      .mockReturnValueOnce(makeStatsChain({ id: 'agt_original' }, []))
      .mockReturnValue(makeStatsChain({ cnt: 0, avg: null }, []))

    const res = await app.request('/agents/agt_original/stats')
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      total: number
      successRate: number
      askerCount: number
      topAskers: unknown[]
      channelBreakdown: unknown[]
    }
    expect(json.total).toBe(0)
    expect(json.successRate).toBe(0)
    expect(json.askerCount).toBe(0)
    expect(json.topAskers).toEqual([])
    expect(json.channelBreakdown).toEqual([])
  })

  it('allows a viewer member to read stats for a shared agent', async () => {
    const mod = await import('../agents.js')
    app = makeAgentsApp(mod.default, { userId: 'usr_viewer', role: 'user' })
    const sharedAgent = { ...SAMPLE_AGENT, userId: 'usr_owner' }

    mockDb.select.mockImplementation((selection?: Record<string, unknown>) => {
      // Old implementation used an owner-filter visibility query:
      // db.select({ id }).from(agents).where(ownerFilter).get()
      // For a member viewer that should miss; the fixed route uses
      // requireAgentRead → db.select().from(agents).where(id).get().
      if (selection && Object.keys(selection).length === 1 && 'id' in selection) {
        return makeStatsChain(undefined, [])
      }
      const callNo = mockDb.select.mock.calls.length
      if (callNo === 1) return makeSelectChain(sharedAgent)
      if (callNo === 2) return makeSelectChain({ role: 'viewer' })
      return makeStatsChain({ cnt: 0, avg: null }, [])
    })

    const res = await app.request('/agents/agt_original/stats')

    expect(res.status).toBe(200)
    const json = (await res.json()) as { total: number; askerCount: number }
    expect(json.total).toBe(0)
    expect(json.askerCount).toBe(0)
  })

  it('surfaces NULL triggerSource rows as the "unknown" bucket so breakdown ⊆ total', async () => {
    // Regression: previously channelBreakdown filtered with isNotNull(triggerSource),
    // making the sum of breakdown counts < total whenever legacy NULL-source
    // runs existed. Now NULL rolls into 'unknown'.
    let statsCallNo = 0
    mockDb.select.mockImplementation(() => {
      statsCallNo += 1
      switch (statsCallNo) {
        case 1: // requireAgentRead — agent visibility
          return makeSelectChain(SAMPLE_AGENT)
        case 2: // status counts
          return makeStatsChain(undefined, [
            { status: 'completed', cnt: 8 },
            { status: 'failed', cnt: 2 },
          ])
        case 3: // todayRuns
          return makeStatsChain({ cnt: 3 }, [])
        case 4: // avgDuration
          return makeStatsChain({ avg: 1234 }, [])
        case 5: // askerCount
          return makeStatsChain({ cnt: 5 }, [])
        case 6: // topAskers
          return makeStatsChain(undefined, [])
        case 7: // channelBreakdown — includes a NULL bucket
          return makeStatsChain(undefined, [
            { source: 'api', cnt: 6 },
            { source: null, cnt: 4 },
          ])
        default:
          return makeStatsChain({ cnt: 0, avg: null }, [])
      }
    })

    const res = await app.request('/agents/agt_original/stats')
    const json = (await res.json()) as {
      total: number
      channelBreakdown: { source: string; count: number }[]
    }
    expect(json.channelBreakdown).toEqual([
      { source: 'api', count: 6 },
      { source: 'unknown', count: 4 },
    ])
    const sum = json.channelBreakdown.reduce((s, c) => s + c.count, 0)
    expect(sum).toBe(json.total)
  })

  it('returns tokens aggregate scoped to the agent', async () => {
    let statsCallNo = 0
    mockDb.select.mockImplementation(() => {
      statsCallNo += 1
      switch (statsCallNo) {
        case 1: // requireAgentRead — agent visibility
          return makeSelectChain(SAMPLE_AGENT)
        case 2: // status counts
          return makeStatsChain(undefined, [])
        case 3: // todayRuns
          return makeStatsChain({ cnt: 0 }, [])
        case 4: // avgDuration
          return makeStatsChain({ avg: null }, [])
        case 5: // askerCount
          return makeStatsChain({ cnt: 0 }, [])
        case 6: // topAskers
          return makeStatsChain(undefined, [])
        case 7: // channelBreakdown
          return makeStatsChain(undefined, [])
        case 8: // tokens aggregate
          return makeStatsChain(
            { input: 1200, output: 300, reasoning: 200, cacheRead: 5000, cacheWrite: 800 },
            [],
          )
        default:
          return makeStatsChain({ cnt: 0, avg: null }, [])
      }
    })

    const res = await app.request('/agents/agt_original/stats')
    expect(res.status).toBe(200)
    const json = (await res.json()) as Json
    expect(json.tokens).toEqual({
      input: 1200,
      output: 300,
      reasoning: 200,
      cacheRead: 5000,
      cacheWrite: 800,
    })
  })
})
