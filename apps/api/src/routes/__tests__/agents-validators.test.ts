/**
 * Tests for the diff-only validators in routes/agents.ts.
 *
 * The four resource validators (`checkAdminOnlyMcpAccess`, `checkSkillAccess`,
 * `validateKbDocumentIds`, `validateSkillGroupIds`) accept an optional `existingIds` arg. When provided, only
 * newly-added IDs are checked — previously-attached IDs short-circuit. This lets
 * editor-role members PATCH an agent without re-validating attachments they don't own.
 *
 * The functions are not exported, so we exercise them indirectly via the PATCH and
 * POST routes (POST = legacy full validation; PATCH = diff-only).
 */
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { z } from 'zod'

type Json = Record<string, unknown>

const agentAccessTestState = vi.hoisted(() => ({
  permission: 'owner' as 'owner' | 'editor' | 'viewer',
}))

beforeEach(() => {
  agentAccessTestState.permission = 'owner'
})

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  // db/transaction.ts reads isPostgres + sqliteDatabase at module load.
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

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
  WorktreeOccupiedError: class extends Error {},
  injectScmEnv: vi.fn(),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor' }),
  resolveEngineType: vi.fn(
    (agentConfig, agentType) => agentConfig.engineType || agentType || 'cursor',
  ),
}))

vi.mock('../../lib/git-workspace.js', () => ({
  WorktreeBranchLockedError: class extends Error {},
  WorktreeDirtyError: class extends Error {},
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: vi.fn().mockReturnValue('acquired'),
  scheduleNext: vi.fn(),
}))

vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))
vi.mock('../../lib/execute-chat-run.js', () => ({ executeChatRun: vi.fn() }))
vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))

vi.mock('../../lib/feishu-service.js', () => ({
  normalizeFeishuConfig: (v: unknown) => v,
  feishuConnectionManager: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getFeishuConnectionStatuses: vi.fn().mockReturnValue([]),
    isRegistered: vi.fn().mockReturnValue(false),
    isSocketOpen: vi.fn().mockReturnValue(false),
  },
}))

vi.mock('../../lib/feishu-diagnose.js', () => ({
  runAgentFeishuDiagnose: vi.fn(),
}))

vi.mock('../../lib/agent-execution-diagnose.js', () => ({
  collectAgentExecutionChecks: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../lib/schedule-trigger.js', () => ({
  scheduleTriggerManager: { start: vi.fn(), stop: vi.fn() },
}))

// Minimal shared schemas — accept the input as-is, no validation noise.
vi.mock('@a2wave/shared', async () => {
  const actual = await vi.importActual<typeof import('@a2wave/shared')>('@a2wave/shared')
  return {
    ...actual,
    createAgentInput: {
      safeParse: vi.fn().mockImplementation((input: unknown) => ({ success: true, data: input })),
    },
    updateAgentInput: {
      safeParse: vi.fn().mockImplementation((input: unknown) => ({ success: true, data: input })),
    },
    publishAuthTypeEnum: z.enum(['none', 'api_key']),
    publishChannelEnum: z.enum(['api', 'a2a', 'feishu', 'slack', 'discord', 'schedule', 'oauth']),
  }
})

// `userRole` / `userId` middleware injection — we mock owner-filter to bypass admin role
// checks, then drive `checkAdminOnlyMcpAccess` directly via the userRole context value.
vi.mock('../../lib/owner-filter.js', () => ({
  getOwnerFilter: vi.fn(() => undefined),
  getCurrentUserId: vi.fn(() => 'usr_caller'),
}))

// Bypass the agent-access permission helpers so we can test validator behavior
// independently of permission resolution. The mocks below simulate "owner can read/write".
// loadAgentWithPerm shape: { agent, permission }. We resolve `agent` lazily by fetching
// from the (mocked) DB so each test case can shape the agent through its select stub.
vi.mock('../../lib/agent-access.js', async () => {
  const { db } = await import('../../db/client.js')
  const { agents } = await import('../../db/schema.js')
  const { eq } = await import('drizzle-orm')
  const { NotFoundError, ForbiddenError } = await import('../../lib/errors.js')

  function loadAgentWithPerm(_c: unknown, agentId: string) {
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
    if (!agent) return null
    return { agent, permission: agentAccessTestState.permission }
  }

  return {
    loadAgentWithPerm,
    getAgentReadFilter: vi.fn(() => undefined),
    requireAgentRead: async (c: unknown, id: string) => {
      const r = await loadAgentWithPerm(c, id)
      if (!r) throw new NotFoundError('Agent')
      return r
    },
    requireAgentWrite: async (c: unknown, id: string) => {
      const r = await loadAgentWithPerm(c, id)
      if (!r) throw new NotFoundError('Agent')
      return r
    },
    requireAgentOwner: async (c: unknown, id: string) => {
      const r = await loadAgentWithPerm(c, id)
      if (!r) throw new NotFoundError('Agent')
      if (r.permission !== 'owner') throw new ForbiddenError('Owner access required')
      return r
    },
  }
})

import { db } from '../../db/client.js'

import { asyncQuery } from '../../test/async-query.js'

const mockDb = db as unknown as {
  select: Mock
  insert: Mock
  update: Mock
  delete: Mock
}

// Drizzle chain helpers
function makeSelectChain(result: unknown) {
  // An array result is the row *list*, a scalar result is a single row. `get`
  // must therefore stay unset for list results — asyncQuery consults `get`
  // first, so a configured one would collapse a multi-row list to its head.
  const rows = Array.isArray(result) ? result : result ? [result] : []
  const terminal: Record<string, unknown> = { all: vi.fn().mockReturnValue(rows) }
  if (!Array.isArray(result)) terminal.get = vi.fn().mockReturnValue(result)
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(asyncQuery(terminal)),
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

const BASE_AGENT = {
  id: 'agt_1',
  name: 'A',
  description: '',
  type: 'cursor' as const,
  config: {},
  status: 'active' as const,
  icon: null,
  systemPrompt: null,
  skills: [],
  skillGroupIds: [] as string[],
  mcpServerIds: [] as string[],
  kbDocumentIds: [] as string[],
  publishStatus: 'draft' as const,
  endpointApiKey: null,
  providerApiKey: null,
  providerBaseUrl: null,
  providerOauthToken: null,
  authMode: null,
  publishAuthType: 'api_key' as const,
  publishIpWhitelist: [],
  publishDescription: null,
  publishChannels: ['api'],
  a2aSkills: null,
  feishuConfig: null,
  scheduleConfig: null,
  publishedAt: null,
  providerId: null,
  env: null,
  workspaceType: 'temp' as const,
  scmSourceId: null,
  maxConcurrency: 1,
  userId: 'usr_owner',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
}

async function loadApp() {
  const mod = await import('../agents.js')
  return new Hono().route('/agents', mod.default)
}

// ───────────────────────────────────────────────────────────────────────────────
// validateKbDocumentIds — exercised via POST (no existing) and PATCH (with existing)
// ───────────────────────────────────────────────────────────────────────────────
describe('validateKbDocumentIds — diff-only behavior', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    app = await loadApp()
  })

  it('without existingIds (POST) → full validation: unknown id → 400', async () => {
    // POST flow: no existing record fetched. Validator only sees the input list.
    // db.select for kbDocuments returns empty → "doc_unknown" missing → 400.
    mockDb.select.mockReturnValue(makeSelectChain([]))

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', kbDocumentIds: ['doc_unknown'] }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as Json
    expect(String(body.error)).toContain('KB documents not found')
    expect(String(body.error)).toContain('doc_unknown')
  })

  it('PATCH with existingIds=[doc1], input=[doc1] → no DB validation runs, returns 200', async () => {
    // Only the agent fetch should hit the DB; the validator must short-circuit
    // because the diff is empty.
    const existing = { ...BASE_AGENT, kbDocumentIds: ['doc1'] }

    let validatorQueryCount = 0
    mockDb.select.mockImplementation((arg?: unknown) => {
      // The fluent select() with no args → full agent row fetch.
      // select({ id: kbDocuments.id }) → projection-only call (validator query).
      if (arg !== undefined) {
        validatorQueryCount++
      }
      return makeSelectChain(arg === undefined ? existing : [])
    })
    mockDb.update.mockReturnValue(makeUpdateReturningChain(existing))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kbDocumentIds: ['doc1'] }),
    })

    expect(res.status).toBe(200)
    expect(validatorQueryCount).toBe(0)
  })

  it('validates via getOwnerFilter (visibility-aligned): admin can mount docs they do not own', async () => {
    // getOwnerFilter is mocked to return undefined (= admin, no filter). The validator
    // must derive its condition from getOwnerFilter(kbDocuments.userId), not from
    // getCurrentUserId — so a doc owned by someone else still validates for admins.
    const { getOwnerFilter } = await import('../../lib/owner-filter.js')
    const { kbDocuments } = await import('../../db/schema.js')
    const existing = { ...BASE_AGENT, kbDocumentIds: [] as string[] }

    mockDb.select.mockImplementation((arg?: unknown) =>
      makeSelectChain(arg === undefined ? existing : [{ id: 'doc_owned_by_other' }]),
    )
    mockDb.update.mockReturnValue(makeUpdateReturningChain(existing))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kbDocumentIds: ['doc_owned_by_other'] }),
    })

    expect(res.status).toBe(200)
    expect(getOwnerFilter).toHaveBeenCalledWith(expect.anything(), kbDocuments.userId)
  })

  // Binding an SCM source hands the Agent a checkout of that repository, cloned
  // with the source's *stored* credentials. Every other mountable resource (KB
  // documents, Skill groups, MCP servers) is validated through getOwnerFilter;
  // SCM must be too, or a caller can bind a source they cannot see and read a
  // private repo through their own Agent.
  it('validates a newly bound SCM source through getOwnerFilter, not by id alone', async () => {
    const { getOwnerFilter } = await import('../../lib/owner-filter.js')
    const { scmSources } = await import('../../db/schema.js')
    const existing = { ...BASE_AGENT, workspaceType: 'scm' as const, scmSourceId: null }

    mockDb.select.mockImplementation((arg?: unknown) =>
      makeSelectChain(arg === undefined ? existing : []),
    )
    mockDb.update.mockReturnValue(makeUpdateReturningChain(existing))

    await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scmSourceId: 'scm_owned_by_someone_else' }),
    })

    expect(getOwnerFilter).toHaveBeenCalledWith(expect.anything(), scmSources.userId)
  })

  it('PATCH with existingIds=[doc1], input=[doc1, doc2] → only doc2 is validated; missing doc2 → 400', async () => {
    const existing = { ...BASE_AGENT, kbDocumentIds: ['doc1'] }
    const captured: unknown[] = []

    mockDb.select.mockImplementation((arg?: unknown) => {
      if (arg === undefined) {
        // Agent fetch
        return makeSelectChain(existing)
      }
      // KB validator query — capture and return empty so doc2 is "missing"
      captured.push(arg)
      return makeSelectChain([])
    })
    mockDb.update.mockReturnValue(makeUpdateReturningChain(existing))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kbDocumentIds: ['doc1', 'doc2'] }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as Json
    // Only the new id (doc2) should appear in the error; doc1 was passed through.
    expect(String(body.error)).toContain('doc2')
    expect(String(body.error)).not.toContain('doc1')
  })
})

// ───────────────────────────────────────────────────────────────────────────────
// validateSkillGroupIds — same trio
// ───────────────────────────────────────────────────────────────────────────────
describe('validateSkillGroupIds — diff-only behavior', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    app = await loadApp()
  })

  it('without existingIds (POST) → full validation: unknown id → 400', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]))

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', skillGroupIds: ['skg_unknown'] }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as Json
    expect(String(body.error)).toContain('Skill groups not found')
    expect(String(body.error)).toContain('skg_unknown')
  })

  it('POST rejects an owned group containing a private Skill unavailable to the new Agent owner', async () => {
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_owned' }]))
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_owned', userId: 'usr_caller' }]))
      .mockReturnValueOnce(
        makeSelectChain([
          { id: 'skl_foreign_private', userId: 'usr_other', visibility: 'private' },
        ]),
      )

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', skillGroupIds: ['skg_owned'] }),
    })

    expect(res.status).toBe(403)
    const error = String(((await res.json()) as Json).error)
    expect(error).toBe('Selected Skill groups contain Skills unavailable to the Agent owner')
    expect(error).not.toContain('skl_foreign_private')
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('POST accepts an owned group whose members are owner-private or all-users', async () => {
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_owned' }]))
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_owned', userId: 'usr_caller' }]))
      .mockReturnValueOnce(
        makeSelectChain([
          { id: 'skl_owned', userId: 'usr_caller', visibility: 'private' },
          { id: 'skl_shared', userId: 'usr_admin', visibility: 'all-users' },
        ]),
      )
    mockDb.insert.mockReturnValue(
      makeInsertChain({ ...BASE_AGENT, userId: 'usr_caller', skillGroupIds: ['skg_owned'] }),
    )

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', skillGroupIds: ['skg_owned'] }),
    })

    expect(res.status).toBe(201)
  })

  it('PATCH with existingIds=[skg1], input=[skg1] → validator skipped, returns 200', async () => {
    agentAccessTestState.permission = 'editor'
    const existing = { ...BASE_AGENT, skillGroupIds: ['skg1'] }

    let validatorQueryCount = 0
    mockDb.select.mockImplementation((arg?: unknown) => {
      if (arg !== undefined) validatorQueryCount++
      return makeSelectChain(arg === undefined ? existing : [])
    })
    mockDb.update.mockReturnValue(makeUpdateReturningChain(existing))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillGroupIds: ['skg1'] }),
    })

    expect(res.status).toBe(200)
    expect(validatorQueryCount).toBe(0)
  })

  it("rejects an editor-owned group before its private members can reach another owner's Agent", async () => {
    agentAccessTestState.permission = 'editor'
    const existing = { ...BASE_AGENT, skillGroupIds: [] as string[] }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(existing))
      .mockReturnValueOnce(makeSelectChain({ role: 'user', isActive: true }))
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_editor' }]))
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_editor', userId: 'usr_caller' }]))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillGroupIds: ['skg_editor'] }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as Json
    expect(String(body.error)).toContain('not owned by the Agent owner')
    expect(String(body.error)).toContain('skg_editor')
  })

  it('rejects an admin attaching a foreign group to a regular-user-owned Agent', async () => {
    const mod = await import('../agents.js')
    const adminApp = new Hono()
    adminApp.use('*', async (c, next) => {
      c.set('userRole' as never, 'admin' as never)
      c.set('userId' as never, 'usr_admin' as never)
      await next()
    })
    adminApp.route('/agents', mod.default)

    const existing = { ...BASE_AGENT, skillGroupIds: [] as string[] }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(existing))
      .mockReturnValueOnce(makeSelectChain({ role: 'user', isActive: true }))
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_admin' }]))
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_admin', userId: 'usr_admin' }]))

    const res = await adminApp.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillGroupIds: ['skg_admin'] }),
    })

    expect(res.status).toBe(403)
  })

  it('rejects an owner-scoped group whose current private member is unavailable to the Agent owner', async () => {
    const mod = await import('../agents.js')
    const adminApp = new Hono()
    adminApp.use('*', async (c, next) => {
      c.set('userRole' as never, 'admin' as never)
      c.set('userId' as never, 'usr_admin' as never)
      await next()
    })
    adminApp.route('/agents', mod.default)

    const existing = { ...BASE_AGENT, skillGroupIds: [] as string[] }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(existing))
      .mockReturnValueOnce(makeSelectChain({ role: 'user', isActive: true }))
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_owner' }]))
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_owner', userId: 'usr_owner' }]))
      .mockReturnValueOnce(
        makeSelectChain([{ id: 'skl_admin_private', userId: 'usr_admin', visibility: 'private' }]),
      )

    const res = await adminApp.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillGroupIds: ['skg_owner'] }),
    })

    expect(res.status).toBe(403)
    const error = String(((await res.json()) as Json).error)
    expect(error).toBe('Selected Skill groups contain Skills unavailable to the Agent owner')
    expect(error).not.toContain('skl_admin_private')
  })

  it('allows an admin attaching any visible group when the Agent owner is an active admin', async () => {
    const mod = await import('../agents.js')
    const adminApp = new Hono()
    adminApp.use('*', async (c, next) => {
      c.set('userRole' as never, 'admin' as never)
      c.set('userId' as never, 'usr_admin' as never)
      await next()
    })
    adminApp.route('/agents', mod.default)

    const existing = { ...BASE_AGENT, skillGroupIds: [] as string[] }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(existing))
      .mockReturnValueOnce(makeSelectChain({ role: 'admin', isActive: true }))
      .mockReturnValueOnce(makeSelectChain([{ id: 'skg_foreign' }]))
    mockDb.update.mockReturnValue(
      makeUpdateReturningChain({ ...existing, skillGroupIds: ['skg_foreign'] }),
    )

    const res = await adminApp.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillGroupIds: ['skg_foreign'] }),
    })

    expect(res.status).toBe(200)
  })

  it('PATCH with existingIds=[skg1], input=[skg1, skg2] → only skg2 validated; missing → 400', async () => {
    const existing = { ...BASE_AGENT, skillGroupIds: ['skg1'] }

    mockDb.select.mockImplementation((arg?: unknown) =>
      makeSelectChain(arg === undefined ? existing : []),
    )
    mockDb.update.mockReturnValue(makeUpdateReturningChain(existing))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillGroupIds: ['skg1', 'skg2'] }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as Json
    expect(String(body.error)).toContain('skg2')
    expect(String(body.error)).not.toContain('skg1')
  })
})

// ───────────────────────────────────────────────────────────────────────────────
// checkSkillAccess — private owner rows + administrator-published all-users rows
// ───────────────────────────────────────────────────────────────────────────────
describe('checkSkillAccess — visibility and diff-only behavior', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    agentAccessTestState.permission = 'editor'
    const mod = await import('../agents.js')
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userRole' as never, 'user' as never)
      c.set('userId' as never, 'usr_caller' as never)
      await next()
    })
    app.route('/agents', mod.default)
  })

  it('allows a non-admin to bind an all-users Skill', async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: 'skl_shared', userId: 'usr_admin', visibility: 'all-users' }]),
    )
    mockDb.insert.mockReturnValue(makeInsertChain({ ...BASE_AGENT, skills: ['skl_shared'] }))

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', skills: ['skl_shared'] }),
    })

    expect(res.status).toBe(201)
  })

  it('keeps create semantics: a non-admin may bind their own private Skill', async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: 'skl_owned', userId: 'usr_caller', visibility: 'private' }]),
    )
    mockDb.insert.mockReturnValue(makeInsertChain({ ...BASE_AGENT, skills: ['skl_owned'] }))

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', skills: ['skl_owned'] }),
    })

    expect(res.status).toBe(201)
  })

  it("rejects a non-admin binding another user's private Skill", async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([{ id: 'skl_private', userId: 'usr_admin', visibility: 'private' }]),
    )

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', skills: ['skl_private'] }),
    })

    expect(res.status).toBe(403)
    expect(String(((await res.json()) as Json).error)).toContain('skl_private')
  })

  it('does not revalidate an unchanged Skill attachment on PATCH', async () => {
    const existing = { ...BASE_AGENT, skills: ['skl_existing'] }
    let validatorQueryCount = 0
    mockDb.select.mockImplementation((arg?: unknown) => {
      if (arg !== undefined) validatorQueryCount++
      return makeSelectChain(arg === undefined ? existing : [])
    })
    mockDb.update.mockReturnValue(makeUpdateReturningChain(existing))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['skl_existing'], description: 'updated' }),
    })

    expect(res.status).toBe(200)
    expect(validatorQueryCount).toBe(0)
  })

  it("rejects an editor's private Skill when the Agent owner cannot use it", async () => {
    agentAccessTestState.permission = 'editor'
    const existing = { ...BASE_AGENT, skills: [] as string[] }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(existing))
      .mockReturnValueOnce(makeSelectChain({ role: 'user', isActive: true }))
      .mockReturnValueOnce(
        makeSelectChain([
          { id: 'skl_editor_private', userId: 'usr_caller', visibility: 'private' },
        ]),
      )

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['skl_editor_private'] }),
    })

    expect(res.status).toBe(403)
    expect(String(((await res.json()) as Json).error)).toContain('skl_editor_private')
  })

  it("rejects an Agent owner's private Skill when the editor cannot bind it", async () => {
    agentAccessTestState.permission = 'editor'
    const existing = { ...BASE_AGENT, skills: [] as string[] }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(existing))
      .mockReturnValueOnce(makeSelectChain({ role: 'user', isActive: true }))
      .mockReturnValueOnce(
        makeSelectChain([{ id: 'skl_owner_private', userId: 'usr_owner', visibility: 'private' }]),
      )

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['skl_owner_private'] }),
    })

    expect(res.status).toBe(403)
    expect(String(((await res.json()) as Json).error)).toContain('skl_owner_private')
  })

  it('allows an editor to add an all-users Skill that the Agent owner can resolve', async () => {
    agentAccessTestState.permission = 'editor'
    const existing = { ...BASE_AGENT, skills: [] as string[] }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(existing))
      .mockReturnValueOnce(makeSelectChain({ role: 'user', isActive: true }))
      .mockReturnValueOnce(
        makeSelectChain([{ id: 'skl_shared', userId: 'usr_admin', visibility: 'all-users' }]),
      )
    mockDb.update.mockReturnValue(makeUpdateReturningChain({ ...existing, skills: ['skl_shared'] }))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['skl_shared'] }),
    })

    expect(res.status).toBe(200)
  })

  it('allows a persisted all-users platform Skill for both editor and Agent owner', async () => {
    agentAccessTestState.permission = 'editor'
    const existing = { ...BASE_AGENT, skills: [] as string[] }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(existing))
      .mockReturnValueOnce(makeSelectChain({ role: 'user', isActive: true }))
      .mockReturnValueOnce(
        makeSelectChain([{ id: 'skl_builtin', userId: null, visibility: 'all-users' }]),
      )
    mockDb.update.mockReturnValue(
      makeUpdateReturningChain({ ...existing, skills: ['skl_builtin'] }),
    )

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['skl_builtin'] }),
    })

    expect(res.status).toBe(200)
  })

  it('allows admin create with an existing private Skill but rejects a PATCH Skill unusable by a regular Agent owner', async () => {
    const mod = await import('../agents.js')
    const adminApp = new Hono()
    adminApp.use('*', async (c, next) => {
      c.set('userRole' as never, 'admin' as never)
      c.set('userId' as never, 'usr_admin' as never)
      await next()
    })
    adminApp.route('/agents', mod.default)

    mockDb.select.mockReturnValueOnce(
      makeSelectChain([{ id: 'skl_any', userId: 'usr_other', visibility: 'private' }]),
    )
    mockDb.insert.mockReturnValue(makeInsertChain({ ...BASE_AGENT, skills: ['skl_any'] }))
    const createRes = await adminApp.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', skills: ['skl_any'] }),
    })
    expect(createRes.status).toBe(201)

    const existing = { ...BASE_AGENT, skills: [] as string[] }
    mockDb.select
      .mockReturnValueOnce(makeSelectChain(existing))
      .mockReturnValueOnce(makeSelectChain({ role: 'user', isActive: true }))
      .mockReturnValueOnce(
        makeSelectChain([{ id: 'skl_admin_private', userId: 'usr_admin', visibility: 'private' }]),
      )

    const patchRes = await adminApp.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: ['skl_admin_private'] }),
    })
    expect(patchRes.status).toBe(403)
  })

  it('rejects a missing Skill when an admin creates an Agent', async () => {
    const mod = await import('../agents.js')
    const adminApp = new Hono()
    adminApp.use('*', async (c, next) => {
      c.set('userRole' as never, 'admin' as never)
      c.set('userId' as never, 'usr_admin' as never)
      await next()
    })
    adminApp.route('/agents', mod.default)

    mockDb.select.mockReturnValueOnce(makeSelectChain([]))
    const res = await adminApp.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', skills: ['skl_missing'] }),
    })

    expect(res.status).toBe(403)
    expect(String(((await res.json()) as Json).error)).toContain('skl_missing')
    expect(mockDb.insert).not.toHaveBeenCalled()
  })
})

// ───────────────────────────────────────────────────────────────────────────────
// checkAdminOnlyMcpAccess — same trio (must inject userRole=editor for non-admin path)
// ───────────────────────────────────────────────────────────────────────────────
describe('checkAdminOnlyMcpAccess — diff-only behavior', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    // Wrap the app with middleware that sets userRole=editor (non-admin path).
    const mod = await import('../agents.js')
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userRole' as never, 'editor' as never)
      c.set('userId' as never, 'usr_caller' as never)
      await next()
    })
    app.route('/agents', mod.default)
  })

  it('without existingIds (POST) → full validation: adminOnly mcp → 403', async () => {
    // The candidate query returns the offending mcp row (adminOnly=true).
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: 'mcp_admin',
          type: 'sse',
          usageScope: 'admin-only',
          groupConfig: null,
          userId: 'usr_caller',
        },
      ]),
    )

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', mcpServerIds: ['mcp_admin'] }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as Json
    expect(String(body.error)).toContain('not assignable')
    expect(String(body.error)).toContain('mcp_admin')
  })

  it('PATCH with existingIds=[mcp_admin], input=[mcp_admin] → validator skipped → 200', async () => {
    // Existing record already has mcp_admin attached. Editor PATCH that keeps the
    // same list must NOT re-run the adminOnly check.
    const existing = { ...BASE_AGENT, mcpServerIds: ['mcp_admin'] }

    let validatorQueryCount = 0
    mockDb.select.mockImplementation((arg?: unknown) => {
      if (arg !== undefined) validatorQueryCount++
      return makeSelectChain(arg === undefined ? existing : [])
    })
    mockDb.update.mockReturnValue(makeUpdateReturningChain(existing))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServerIds: ['mcp_admin'] }),
    })

    expect(res.status).toBe(200)
    expect(validatorQueryCount).toBe(0)
  })

  it('PATCH with existingIds=[mcp_ok], input=[mcp_ok, mcp_admin] → only mcp_admin checked → 403', async () => {
    const existing = { ...BASE_AGENT, mcpServerIds: ['mcp_ok'] }

    mockDb.select.mockImplementation((arg?: unknown) => {
      if (arg === undefined) return makeSelectChain(existing)
      // candidate query → only the newly-added id is checked (diff-only), and it
      // is adminOnly=true so it must be blocked.
      return makeSelectChain([
        {
          id: 'mcp_admin',
          type: 'sse',
          usageScope: 'admin-only',
          groupConfig: null,
          userId: 'usr_caller',
        },
      ])
    })
    mockDb.update.mockReturnValue(makeUpdateReturningChain(existing))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServerIds: ['mcp_ok', 'mcp_admin'] }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as Json
    expect(String(body.error)).toContain('mcp_admin')
    expect(String(body.error)).not.toContain('mcp_ok')
  })

  it('non-admin binding a legacy adminOnly=FALSE stdio server → 403 (P0-1 RCE gate)', async () => {
    // Regression for the blocking finding: a stdio server executes host commands.
    // Even if a legacy row still has adminOnly=false (pre-backfill), the binding
    // check must reject it for a non-admin based on its stdio TYPE, not the flag.
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: 'mcp_stdio',
          type: 'stdio',
          usageScope: 'admin-only',
          groupConfig: null,
          userId: 'usr_caller',
        },
      ]),
    )

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', mcpServerIds: ['mcp_stdio'] }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as Json
    expect(String(body.error)).toContain('mcp_stdio')
  })

  it('non-admin binding a group with an inline stdio backend → 403 (P0-1 RCE gate)', async () => {
    // The other stdio execution face: a group server whose inline backend spawns
    // a host command. adminOnly=false but introducesStdioExecution() catches it.
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: 'mcp_group',
          type: 'group',
          usageScope: 'admin-only',
          groupConfig: { backends: { default: [{ mode: 'inline', type: 'stdio', command: 'x' }] } },
          userId: 'usr_caller',
        },
      ]),
    )

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', mcpServerIds: ['mcp_group'] }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as Json
    expect(String(body.error)).toContain('mcp_group')
  })

  it('non-admin binding an OWNED sse server (adminOnly=false) → allowed (no over-block)', async () => {
    // Ensure the gate does not over-reach: URL-only sse/http servers the caller
    // owns remain bindable.
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: 'mcp_sse',
          type: 'sse',
          usageScope: 'all-users',
          groupConfig: null,
          userId: 'usr_caller',
        },
      ]),
    )
    mockDb.insert.mockReturnValue(makeInsertChain({ ...BASE_AGENT, mcpServerIds: ['mcp_sse'] }))

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', mcpServerIds: ['mcp_sse'] }),
    })

    expect(res.status).not.toBe(403)
  })

  it("non-admin binding ANOTHER user's PRIVATE sse server → 403 (IDOR)", async () => {
    // The runtime resolves the server's URL/headers/env (private credentials)
    // under this agent. A private server owned by someone else is an IDOR even
    // though it is only sse (no host RCE). (all-users is a deliberate share — see
    // the separate 'allowed' test.)
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: 'mcp_other',
          type: 'sse',
          usageScope: 'private',
          groupConfig: null,
          userId: 'usr_bob',
        },
      ]),
    )

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', mcpServerIds: ['mcp_other'] }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as Json
    expect(String(body.error)).toContain('mcp_other')
  })

  it('non-admin binding a system builtin (userId=null) sse → allowed', async () => {
    // Platform builtins have userId === null and must remain bindable by anyone.
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: 'mcp_builtin',
          type: 'sse',
          usageScope: 'all-users',
          groupConfig: null,
          userId: null,
        },
      ]),
    )
    mockDb.insert.mockReturnValue(makeInsertChain({ ...BASE_AGENT, mcpServerIds: ['mcp_builtin'] }))

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', mcpServerIds: ['mcp_builtin'] }),
    })

    expect(res.status).not.toBe(403)
  })

  it('non-admin binding an all-users (shared) sse → allowed (genuine sharing)', async () => {
    // 'all-users' is an explicit share (only an admin can set it at write time), so
    // any non-admin may bind it — a pure scope read, no owner-role lookup.
    mockDb.select.mockReturnValue(
      makeSelectChain([
        {
          id: 'mcp_shared',
          type: 'sse',
          usageScope: 'all-users',
          groupConfig: null,
          userId: 'usr_admin',
        },
      ]),
    )
    mockDb.insert.mockReturnValue(makeInsertChain({ ...BASE_AGENT, mcpServerIds: ['mcp_shared'] }))

    const res = await app.request('/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', mcpServerIds: ['mcp_shared'] }),
    })

    expect(res.status).not.toBe(403)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
// Integration: PATCH where editor sends the same arrays as existing → all validators skipped
// ───────────────────────────────────────────────────────────────────────────────
describe('PATCH /agents/:id — editor with unchanged attachments', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    agentAccessTestState.permission = 'editor'
    const mod = await import('../agents.js')
    app = new Hono()
    app.use('*', async (c, next) => {
      c.set('userRole' as never, 'editor' as never)
      c.set('userId' as never, 'usr_caller' as never)
      await next()
    })
    app.route('/agents', mod.default)
  })

  it('all four diff-validators short-circuit; no resource queries hit the DB', async () => {
    const existing = {
      ...BASE_AGENT,
      mcpServerIds: ['mcp_admin'],
      kbDocumentIds: ['doc_owned_by_admin'],
      skillGroupIds: ['skg_owned_by_admin'],
      skills: ['skl_owned_by_admin'],
    }

    let validatorQueryCount = 0
    mockDb.select.mockImplementation((arg?: unknown) => {
      if (arg !== undefined) validatorQueryCount++
      return makeSelectChain(arg === undefined ? existing : [])
    })
    mockDb.update.mockReturnValue(makeUpdateReturningChain(existing))
    mockDb.insert.mockReturnValue(makeInsertChain(existing))

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Same arrays as existing — diff is empty for all four
        mcpServerIds: ['mcp_admin'],
        kbDocumentIds: ['doc_owned_by_admin'],
        skillGroupIds: ['skg_owned_by_admin'],
        skills: ['skl_owned_by_admin'],
        description: 'edited by editor',
      }),
    })

    expect(res.status).toBe(200)
    expect(validatorQueryCount).toBe(0)
  })
})
