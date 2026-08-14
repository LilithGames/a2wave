/**
 * Route-level integration tests for the new agent permission model.
 *
 * Covers the permission matrix for the routes refactored in `routes/agents.ts`:
 *   - admin / owner / editor / viewer / unrelated → expected status code per route
 *   - GET /:id response carries `meta.permission`
 *   - GET / list uses `getAgentReadFilter` (admin gets unfiltered; non-admin gets the OR filter)
 *
 * Strategy: use the real `agent-access.ts` (no mock) and drive `db.select` per
 * scenario. The first `select()` call resolves the agent row; the second
 * `select({ role })` call resolves the agent_members membership row.
 *
 * The handlers under test only need to reach past the permission guard for write
 * routes (PATCH/DELETE/etc); we keep DB writes mocked so we don't have to
 * fully simulate update/delete chains for unrelated assertions.
 */
import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

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
  engineRegistry: { get: vi.fn().mockReturnValue(true), types: ['cursor'] },
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
  WorktreeOccupiedError: class extends Error {},
  injectScmEnv: vi.fn(),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor', maxRetries: 0 }),
  resolveEngineType: vi.fn(
    (agentConfig, agentType) => agentConfig.engineType || agentType || 'cursor',
  ),
}))

vi.mock('../../lib/git-workspace.js', () => ({
  WorktreeBranchLockedError: class extends Error {},
  WorktreeDirtyError: class extends Error {},
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: vi.fn().mockReturnValue('queue_full'),
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

vi.mock('../../lib/schedule-trigger.js', () => ({
  scheduleTriggerManager: { start: vi.fn(), stop: vi.fn() },
}))

vi.mock('../../lib/feishu-diagnose.js', () => ({
  runAgentFeishuDiagnose: vi.fn().mockResolvedValue({ ok: true, meta: {}, checks: [] }),
}))

vi.mock('../../lib/agent-execution-diagnose.js', () => ({
  collectAgentExecutionChecks: vi.fn().mockResolvedValue([]),
}))

// Permissive zod schemas — the permission matrix is the focus, not body validation.
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
    publishChannelEnum: z.enum([
      'api',
      'a2a',
      'feishu',
      'slack',
      'discord',
      'schedule',
      'oauth',
      'chat_app',
    ]),
  }
})

import { db } from '../../db/client.js'
import { AppError } from '../../lib/errors.js'
import { createTestAgent } from '../../test/factories.js'

import { asyncQuery } from '../../test/async-query.js'

const mockDb = db as unknown as {
  select: Mock
  insert: Mock
  update: Mock
  delete: Mock
}

// ────────────────────────────────────────────────────────────────────────────
// Drizzle chain helpers
// ────────────────────────────────────────────────────────────────────────────

function selectChain(getReturn: unknown) {
  const all = vi
    .fn()
    .mockReturnValue(Array.isArray(getReturn) ? getReturn : getReturn ? [getReturn] : [])
  // `get` yields ONE row: an array argument is the row *list*, so returning it
  // whole would resolve an awaited chain to `[[row]]` rather than `[row]`.
  const single = Array.isArray(getReturn) ? getReturn[0] : getReturn
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(single),
            all,
            orderBy: vi.fn().mockReturnValue(
              asyncQuery({
                all,
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockReturnValue(asyncQuery({ all })),
                  all,
                }),
              }),
            ),
            limit: vi.fn().mockReturnValue(
              asyncQuery({
                offset: vi.fn().mockReturnValue(asyncQuery({ all })),
                all,
              }),
            ),
          }),
        ),
        orderBy: vi.fn().mockReturnValue(
          asyncQuery({
            all,
            limit: vi.fn().mockReturnValue(
              asyncQuery({
                offset: vi.fn().mockReturnValue(asyncQuery({ all })),
                all,
              }),
            ),
          }),
        ),
        all,
      }),
    ),
  }
}

function updateReturningChain(returnValue: unknown) {
  return {
    set: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue(returnValue),
              }),
            ),
            run: vi.fn(),
          }),
        ),
      }),
    ),
  }
}

function updateChain() {
  return {
    set: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })),
      }),
    ),
  }
}

function deleteReturningChain(returnValue: unknown) {
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

// ────────────────────────────────────────────────────────────────────────────
// Test app factory
// ────────────────────────────────────────────────────────────────────────────

async function makeAppAsRole(role: 'admin' | 'user', userId: string): Promise<Hono> {
  const mod = await import('../agents.js')
  const app = new Hono()
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    return c.json({ error: 'Internal Server Error' }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('userRole' as never, role)
    c.set('userId' as never, userId)
    await next()
  })
  app.route('/agents', mod.default)
  return app
}

// Configures `db.select` to return:
//   1st call → agent row (or undefined if missing)
//   2nd call → membership row (or undefined for unrelated callers)
function primeAgentLookup(agent: unknown, membership: { role: string } | null) {
  mockDb.select
    .mockReturnValueOnce(selectChain(agent))
    .mockReturnValueOnce(selectChain(membership === null ? undefined : membership))
  // Subsequent calls (e.g. listing chat history runs) — return empty.
  mockDb.select.mockReturnValue(selectChain([]))
}

// Helper: fresh agent owned by a given user id.
function ownedBy(
  ownerId: string | null,
  overrides: Partial<ReturnType<typeof createTestAgent>> = {},
) {
  return createTestAgent({ id: 'agt_target', userId: ownerId, ...overrides })
}

// Helper: agent carrying plaintext secrets, used to assert reveal-vs-mask by role on GET /:id.
function withSecrets(): Partial<ReturnType<typeof createTestAgent>> {
  return {
    feishuConfig: { appId: 'cli_app', appSecret: 'feishu-secret-plain' },
    providerOauthToken: 'oauth-token-plain',
  }
}

type SecretResponse = {
  data: { feishuConfig?: { appSecret?: string } | null; providerOauthToken?: string | null }
  meta: { permission: string; skillBindingScope: 'all-visible' | 'owner-or-shared' }
}

beforeEach(() => {
  // Reset only the DB mocks — clearing implementation + queued return values so
  // each test's `primeAgentLookup` starts fresh. Other module-level mocks
  // (zod, registries, etc.) keep their setup from the top of this file.
  mockDb.select.mockReset()
  mockDb.insert.mockReset()
  mockDb.update.mockReset()
  mockDb.delete.mockReset()
})

// ============================================================================
// GET /:id — meta.permission and 404 vs 200 by caller
// ============================================================================

describe('GET /agents/:id — meta.permission per caller', () => {
  it('admin caller → 200 with meta.permission="owner"', async () => {
    const app = await makeAppAsRole('admin', 'usr_admin')
    primeAgentLookup(ownedBy('usr_someone_else'), null)

    const res = await app.request('/agents/agt_target')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: unknown; meta: { permission: string } }
    expect(json.meta.permission).toBe('owner')
    expect(json.data).toBeDefined()
  })

  it('owner via agents.userId → 200, meta.permission="owner" + plaintext secrets', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_alice', withSecrets()), null)

    const res = await app.request('/agents/agt_target')
    expect(res.status).toBe(200)
    const json = (await res.json()) as SecretResponse
    expect(json.meta.permission).toBe('owner')
    expect(json.data.feishuConfig?.appSecret).toBe('feishu-secret-plain')
    expect(json.data.providerOauthToken).toBe('oauth-token-plain')
  })

  it('editor member → 200, meta.permission="editor" + plaintext secrets', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_bob', withSecrets()), { role: 'editor' })

    const res = await app.request('/agents/agt_target')
    expect(res.status).toBe(200)
    const json = (await res.json()) as SecretResponse
    expect(json.meta.permission).toBe('editor')
    expect(json.data.feishuConfig?.appSecret).toBe('feishu-secret-plain')
    expect(json.data.providerOauthToken).toBe('oauth-token-plain')
  })

  it('reports all-visible Skill binding scope when the Agent owner is an active admin', async () => {
    const app = await makeAppAsRole('user', 'usr_editor')
    primeAgentLookup(ownedBy('usr_owner_admin'), { role: 'editor' })
    mockDb.select.mockReturnValueOnce(selectChain({ role: 'admin', isActive: true }))

    const res = await app.request('/agents/agt_target')

    expect(res.status).toBe(200)
    const json = (await res.json()) as SecretResponse
    expect(json.meta.skillBindingScope).toBe('all-visible')
  })

  it('reports owner-or-shared Skill binding scope for a regular Agent owner', async () => {
    const app = await makeAppAsRole('user', 'usr_editor')
    primeAgentLookup(ownedBy('usr_owner'), { role: 'editor' })
    mockDb.select.mockReturnValueOnce(selectChain({ role: 'user', isActive: true }))

    const res = await app.request('/agents/agt_target')

    expect(res.status).toBe(200)
    const json = (await res.json()) as SecretResponse
    expect(json.meta.skillBindingScope).toBe('owner-or-shared')
  })

  it('viewer member → 200, meta.permission="viewer" but secrets masked', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_bob', withSecrets()), { role: 'viewer' })

    const res = await app.request('/agents/agt_target')
    expect(res.status).toBe(200)
    const json = (await res.json()) as SecretResponse
    expect(json.meta.permission).toBe('viewer')
    expect(json.data.feishuConfig?.appSecret).toBe('********')
    expect(json.data.providerOauthToken).toBe('********')
  })

  it('unrelated user → 404 (no membership row)', async () => {
    const app = await makeAppAsRole('user', 'usr_stranger')
    primeAgentLookup(ownedBy('usr_bob'), null)

    const res = await app.request('/agents/agt_target')
    expect(res.status).toBe(404)
  })

  it('non-existent agent → 404', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(undefined, null)

    const res = await app.request('/agents/agt_missing')
    expect(res.status).toBe(404)
  })

  it('non-admin caller against null-owner agent → 404', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy(null), null)

    const res = await app.request('/agents/agt_target')
    expect(res.status).toBe(404)
  })
})

// ============================================================================
// PATCH /:id — write permission matrix
// ============================================================================

describe('PATCH /agents/:id — viewer/editor/owner', () => {
  it('viewer → 403', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_bob'), { role: 'viewer' })

    const res = await app.request('/agents/agt_target', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New' }),
    })
    expect(res.status).toBe(403)
  })

  it('editor → 200', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    const target = ownedBy('usr_bob')
    primeAgentLookup(target, { role: 'editor' })
    mockDb.update.mockReturnValue(updateReturningChain({ ...target, name: 'New' }))

    const res = await app.request('/agents/agt_target', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New' }),
    })
    expect(res.status).toBe(200)
  })

  it('owner → 200', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    const target = ownedBy('usr_alice')
    mockDb.select.mockReturnValue(selectChain(target))
    mockDb.update.mockReturnValue(updateReturningChain({ ...target, name: 'X' }))

    const res = await app.request('/agents/agt_target', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    })
    expect(res.status).toBe(200)
  })

  it('unrelated user → 404', async () => {
    const app = await makeAppAsRole('user', 'usr_stranger')
    primeAgentLookup(ownedBy('usr_bob'), null)

    const res = await app.request('/agents/agt_target', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New' }),
    })
    expect(res.status).toBe(404)
  })
})

// ============================================================================
// DELETE /:id — owner-only
// ============================================================================

describe('DELETE /agents/:id — owner-only', () => {
  it('owner → 200', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    const target = ownedBy('usr_alice')
    mockDb.select.mockReturnValue(selectChain(target))
    mockDb.update.mockReturnValue(updateChain())
    mockDb.delete.mockReturnValue(deleteReturningChain(target))

    const res = await app.request('/agents/agt_target', { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  it('admin → 200', async () => {
    const app = await makeAppAsRole('admin', 'usr_admin')
    const target = ownedBy('usr_someone')
    mockDb.select.mockReturnValue(selectChain(target))
    mockDb.update.mockReturnValue(updateChain())
    mockDb.delete.mockReturnValue(deleteReturningChain(target))

    const res = await app.request('/agents/agt_target', { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  it('editor → 403 (cannot delete)', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_bob'), { role: 'editor' })

    const res = await app.request('/agents/agt_target', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('viewer → 403', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_bob'), { role: 'viewer' })

    const res = await app.request('/agents/agt_target', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('unrelated user → 404', async () => {
    const app = await makeAppAsRole('user', 'usr_stranger')
    primeAgentLookup(ownedBy('usr_bob'), null)

    const res = await app.request('/agents/agt_target', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

// ============================================================================
// PATCH /:id/channels/:channel — per-channel config save (requireAgentWrite)
// ============================================================================

describe('PATCH /agents/:id/channels/:channel — viewer/editor/owner', () => {
  const feishuBody = {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { appId: 'cli_a', appSecret: 's' } }),
  }

  it('viewer → 403', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_bob'), { role: 'viewer' })

    const res = await app.request('/agents/agt_target/channels/feishu', feishuBody)
    expect(res.status).toBe(403)
  })

  it('editor → passes the guard', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_bob'), { role: 'editor' })

    const res = await app.request('/agents/agt_target/channels/feishu', feishuBody)
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(404)
  })

  it('unrelated user → 404', async () => {
    const app = await makeAppAsRole('user', 'usr_stranger')
    primeAgentLookup(ownedBy('usr_bob'), null)

    const res = await app.request('/agents/agt_target/channels/feishu', feishuBody)
    expect(res.status).toBe(404)
  })
})

// ============================================================================
// POST /:id/chat — viewer can chat (requireAgentRead)
// ============================================================================

describe('POST /agents/:id/chat — viewer can chat', () => {
  it('viewer reaches past the permission guard', async () => {
    // We don't care about the full chat lifecycle here. Just prove that the guard
    // accepts viewer (i.e. the response is NOT a 403/404 from requireAgentRead).
    // The `tryAcquireSlot` mock returns 'queue_full' → handler returns 429, which
    // is sufficient evidence that we cleared the agent fetch + permission check.
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_bob', { workspaceType: 'temp', scmSourceId: null }), {
      role: 'viewer',
    })
    mockDb.insert.mockReturnValue(
      asyncQuery({
        values: vi.fn().mockReturnValue(
          asyncQuery({
            run: vi.fn(),
            returning: vi.fn().mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue({}) })),
          }),
        ),
      }),
    )
    mockDb.delete.mockReturnValue(deleteReturningChain(undefined))

    const res = await app.request('/agents/agt_target/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })

    // Permission guard passed; we reach the queue check (which the test forces to 429).
    expect(res.status).toBe(429)
  })

  it('unrelated user → 404 (cannot even reach chat)', async () => {
    const app = await makeAppAsRole('user', 'usr_stranger')
    primeAgentLookup(ownedBy('usr_bob'), null)

    const res = await app.request('/agents/agt_target/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(404)
  })
})

// ============================================================================
// GET / list — getAgentReadFilter scoping
// ============================================================================

describe('GET /agents — list scoping via getAgentReadFilter', () => {
  it('admin sees agents owned by anyone (filter is undefined → no scoping)', async () => {
    const app = await makeAppAsRole('admin', 'usr_admin')
    const a1 = ownedBy('usr_x')
    // For the list route, `db.select({ count })` (count query) and `db.select()` (data query)
    // each consume one chain. We return a count for the first and the row list for the second.
    mockDb.select
      .mockReturnValueOnce(selectChain({ count: 1 }))
      .mockReturnValueOnce(selectChain([a1]))

    const res = await app.request('/agents')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: unknown[]; pagination: { total: number } }
    expect(json.pagination.total).toBe(1)
    expect(json.data).toHaveLength(1)
  })

  it('non-admin caller invokes the filter (membership-aware) and gets the data path', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    const visible = ownedBy('usr_bob')
    mockDb.select
      .mockReturnValueOnce(selectChain({ count: 1 }))
      .mockReturnValueOnce(selectChain([visible]))
      // 3rd select: editor-membership set for canManage (empty → not an editor of this agent)
      .mockReturnValueOnce(selectChain([]))

    const res = await app.request('/agents')
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      data: { canManage: boolean }[]
      pagination: { total: number }
    }
    // The actual filter SQL is exercised in agent-access.test.ts; here we only assert the
    // route plumbs the helper through and serializes whatever the DB returned.
    expect(json.pagination.total).toBe(1)
    expect(json.data).toHaveLength(1)
    // usr_alice owns neither (owner is usr_bob) nor is an editor member → cannot manage.
    expect(json.data[0].canManage).toBe(false)
  })

  it('non-admin editor of a visible agent → canManage true', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    const visible = ownedBy('usr_bob') // id: agt_target
    mockDb.select
      .mockReturnValueOnce(selectChain({ count: 1 }))
      .mockReturnValueOnce(selectChain([visible]))
      // 3rd select: editor-membership set contains this agent id.
      .mockReturnValueOnce(selectChain([{ agentId: 'agt_target' }]))

    const res = await app.request('/agents')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { canManage: boolean }[] }
    expect(json.data[0].canManage).toBe(true)
  })

  it('non-admin owner of a visible agent → canManage true (no membership query needed)', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    const owned = ownedBy('usr_alice')
    mockDb.select
      .mockReturnValueOnce(selectChain({ count: 1 }))
      .mockReturnValueOnce(selectChain([owned]))
      .mockReturnValueOnce(selectChain([]))

    const res = await app.request('/agents')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { canManage: boolean }[] }
    expect(json.data[0].canManage).toBe(true)
  })

  it('non-admin editor of a legacy null-owner agent → canManage false (matches requireAgentWrite 404)', async () => {
    // Regression: getAgentReadFilter's memberSubquery surfaces null-owner agents the caller
    // is a member of, but requireAgentWrite → loadAgentWithPerm returns null for null-owner
    // agents. canManage must mirror that (false) so we never render a pin button that 404s.
    const app = await makeAppAsRole('user', 'usr_alice')
    const legacy = ownedBy(null) // userId IS NULL
    mockDb.select
      .mockReturnValueOnce(selectChain({ count: 1 }))
      .mockReturnValueOnce(selectChain([legacy]))
    // No 3rd select expected: null-owner rows are excluded from the editor lookup up front.

    const res = await app.request('/agents')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { canManage: boolean }[] }
    expect(json.data[0].canManage).toBe(false)
  })

  it('admin → every row canManage true', async () => {
    const app = await makeAppAsRole('admin', 'usr_admin')
    const a1 = ownedBy('usr_x')
    mockDb.select
      .mockReturnValueOnce(selectChain({ count: 1 }))
      .mockReturnValueOnce(selectChain([a1]))
    // No 3rd select: admin path skips the editor-membership query entirely.

    const res = await app.request('/agents')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { canManage: boolean }[] }
    expect(json.data[0].canManage).toBe(true)
  })

  it('non-admin with no visible agents → empty list (no membership query on empty page)', async () => {
    const app = await makeAppAsRole('user', 'usr_stranger')
    mockDb.select
      .mockReturnValueOnce(selectChain({ count: 0 }))
      .mockReturnValueOnce(selectChain([]))
    // No 3rd select: empty page short-circuits the editor-membership query.

    const res = await app.request('/agents')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: unknown[]; pagination: { total: number } }
    expect(json.pagination.total).toBe(0)
    expect(json.data).toEqual([])
  })
})

// ============================================================================
// POST /:id/pin & /:id/unpin — write-guarded, server-stamped pinnedAt
// ============================================================================

describe('POST /agents/:id/pin — write permission + server-stamped pinnedAt', () => {
  it('owner pins an un-pinned agent → 200, pinnedAt set', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    const target = ownedBy('usr_alice', { pinnedAt: null })
    primeAgentLookup(target, null)
    mockDb.update.mockReturnValue(
      updateReturningChain({ ...target, pinnedAt: new Date('2025-07-08') }),
    )

    const res = await app.request('/agents/agt_target/pin', { method: 'POST' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { pinnedAt: string | null } }
    expect(json.data.pinnedAt).toBeTruthy()
  })

  it('editor can pin → 200', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    const target = ownedBy('usr_bob', { pinnedAt: null })
    primeAgentLookup(target, { role: 'editor' })
    mockDb.update.mockReturnValue(
      updateReturningChain({ ...target, pinnedAt: new Date('2025-07-08') }),
    )

    const res = await app.request('/agents/agt_target/pin', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('viewer cannot pin → 403', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_bob', { pinnedAt: null }), { role: 'viewer' })

    const res = await app.request('/agents/agt_target/pin', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('unrelated user → 404', async () => {
    const app = await makeAppAsRole('user', 'usr_stranger')
    primeAgentLookup(ownedBy('usr_bob'), null)

    const res = await app.request('/agents/agt_target/pin', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('re-pinning an already-pinned agent preserves the original pinnedAt', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    const originalPin = new Date('2025-01-01')
    const target = ownedBy('usr_alice', { pinnedAt: originalPin })
    primeAgentLookup(target, null)
    let capturedSet: Record<string, unknown> | undefined
    mockDb.update.mockReturnValue(
      asyncQuery({
        set: vi.fn().mockImplementation((v: Record<string, unknown>) => {
          capturedSet = v
          return {
            where: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue(target) })),
            }),
          }
        }),
      }),
    )

    const res = await app.request('/agents/agt_target/pin', { method: 'POST' })
    expect(res.status).toBe(200)
    // Existing pinnedAt kept as-is — re-pin must NOT bump it past the last-pinned agent.
    expect(capturedSet?.pinnedAt).toEqual(originalPin)
  })
})

describe('POST /agents/:id/unpin — write permission clears pinnedAt', () => {
  it('owner unpins → 200, pinnedAt null', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    const target = ownedBy('usr_alice', { pinnedAt: new Date('2025-01-01') })
    primeAgentLookup(target, null)
    let capturedSet: Record<string, unknown> | undefined
    mockDb.update.mockReturnValue(
      asyncQuery({
        set: vi.fn().mockImplementation((v: Record<string, unknown>) => {
          capturedSet = v
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue(
                asyncQuery({
                  get: vi.fn().mockReturnValue({ ...target, pinnedAt: null }),
                }),
              ),
            }),
          }
        }),
      }),
    )

    const res = await app.request('/agents/agt_target/unpin', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(capturedSet?.pinnedAt).toBeNull()
    const json = (await res.json()) as { data: { pinnedAt: string | null } }
    expect(json.data.pinnedAt).toBeNull()
  })

  it('viewer cannot unpin → 403', async () => {
    const app = await makeAppAsRole('user', 'usr_alice')
    primeAgentLookup(ownedBy('usr_bob', { pinnedAt: new Date() }), { role: 'viewer' })

    const res = await app.request('/agents/agt_target/unpin', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(mockDb.update).not.toHaveBeenCalled()
  })
})
