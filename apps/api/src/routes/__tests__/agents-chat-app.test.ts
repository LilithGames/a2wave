/**
 * Route tests for GET /agents/:id/chat-app — the profile the chat app page renders
 * beside its conversation pane.
 *
 * Focus:
 *   - the channel gate (disabled channel reads as 404, not 403)
 *   - permission reuse (same owner/editor/viewer contract as GET /:id)
 *   - the response carries presentation copy only, never credentials
 *   - config falls back to sane defaults for agents saved before the channel existed
 */
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  // db/transaction.ts reads isPostgres + sqliteDatabase at module load.
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../lib/id.js', () => ({ createId: vi.fn((p?: string) => `${p ?? ''}_test`) }))
vi.mock('../../engine/index.js', () => ({
  engineRegistry: { get: vi.fn().mockReturnValue(true), types: ['cursor'] },
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock('../../worker/index.js', () => ({ executeInWorker: vi.fn() }))
vi.mock('../../lib/agent-helpers.js', () => ({
  resolveWorkDir: vi.fn().mockResolvedValue('/tmp/work'),
  WorktreeOccupiedError: class extends Error {},
  injectScmEnv: vi.fn(),
  buildAgentConfig: vi.fn().mockReturnValue({ engineType: 'cursor', maxRetries: 0 }),
  resolveEngineType: vi.fn(() => 'cursor'),
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
  collectAgentExecutionChecks: vi.fn().mockReturnValue([]),
}))

import { db } from '../../db/client.js'
import { AppError } from '../../lib/errors.js'
import { asyncQuery } from '../../test/async-query.js'
import { createTestAgent } from '../../test/factories.js'

/**
 * These tests build their app with a dynamic `import()` of a large route module.
 * Evaluating it is CPU-bound and happens while the rest of the api suite runs in
 * parallel, so the work is real but the wall-clock is dominated by contention,
 * not by anything under test. Vitest's 5s default was tight enough that a loaded
 * machine tipped these into "Test timed out" — a flake whose only signal is how
 * busy the box was. The file-level budget bounds a genuine hang without letting
 * scheduling noise fail a passing assertion.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const mockDb = db as unknown as { select: Mock }

function selectChain(getReturn: unknown) {
  const all = vi
    .fn()
    .mockReturnValue(Array.isArray(getReturn) ? getReturn : getReturn ? [getReturn] : [])
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        asyncQuery({
          get: vi.fn().mockReturnValue(getReturn),
          all,
        }),
      ),
    }),
  }
}

async function makeApp(role: 'admin' | 'user', userId: string): Promise<Hono> {
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

/**
 * Route the mocked `db.select` by the columns each query asks for rather than by
 * call order: an admin caller short-circuits the membership lookup, so a
 * positional mock would misalign and hand the creator row to the wrong query.
 *
 * - `select()` with no projection → the agent row
 * - `select({ role })`            → the agent_members row
 * - `select({ username, ... })`   → the creator row
 */
function primeLookup(
  agent: unknown,
  membership: { role: string } | null,
  creator?: { username: string; displayName: string | null },
) {
  mockDb.select.mockImplementation((projection?: Record<string, unknown>) => {
    if (!projection) return selectChain(agent)
    const keys = Object.keys(projection)
    if (keys.includes('username')) return selectChain(creator)
    if (keys.includes('role')) return selectChain(membership === null ? undefined : membership)
    return selectChain([])
  })
}

const CHAT_APP_AGENT = () =>
  createTestAgent({
    id: 'agt_target',
    userId: 'usr_owner',
    name: 'Support Bot',
    icon: '🤖',
    publishChannels: ['api', 'chat_app'],
    publishStatus: 'published',
    // A credential that must never appear in the response.
    feishuConfig: { appId: 'cli_app', appSecret: 'feishu-secret-plain' },
    chatAppConfig: {
      displayName: 'Helpdesk',
      welcomeMessage: 'Ask me anything',
      suggestedQuestions: ['How do I reset my password?'],
      showCreator: true,
      allowAttachments: false,
      showThinking: false,
    },
  })

type ChatAppResponse = {
  data: {
    id: string
    name: string
    icon: string
    creator: { name: string } | null
    welcomeMessage: string | null
    suggestedQuestions: string[]
    showCreator: boolean
    allowAttachments: boolean
    showThinking: boolean
  }
}

beforeEach(() => {
  mockDb.select.mockReset()
})

describe('GET /agents/:id/chat-app', () => {
  it('returns the profile when the channel is enabled', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(CHAT_APP_AGENT(), null, { username: 'alice', displayName: 'Alice' })

    const res = await app.request('/agents/agt_target/chat-app')
    expect(res.status).toBe(200)

    const json = (await res.json()) as ChatAppResponse
    expect(json.data).toMatchObject({
      id: 'agt_target',
      // displayName overrides the agent name
      name: 'Helpdesk',
      icon: '🤖',
      welcomeMessage: 'Ask me anything',
      suggestedQuestions: ['How do I reset my password?'],
      showCreator: true,
      allowAttachments: false,
      showThinking: false,
    })
    expect(json.data.creator).toEqual({ name: 'Alice' })
  })

  it('never leaks credentials or channel configs', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(CHAT_APP_AGENT(), null, { username: 'alice', displayName: 'Alice' })

    const res = await app.request('/agents/agt_target/chat-app')
    const body = await res.text()
    expect(body).not.toContain('feishu-secret-plain')
    expect(body).not.toContain('feishuConfig')
    expect(body).not.toContain('endpointApiKey')
  })

  it('falls back to the agent name when displayName is blank', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(
      createTestAgent({
        id: 'agt_target',
        userId: 'usr_owner',
        name: 'Support Bot',
        publishChannels: ['chat_app'],
        publishStatus: 'published',
        chatAppConfig: { displayName: '   ', suggestedQuestions: [] },
      }),
      null,
      { username: 'alice', displayName: null },
    )

    const res = await app.request('/agents/agt_target/chat-app')
    const json = (await res.json()) as ChatAppResponse
    expect(json.data.name).toBe('Support Bot')
    // displayName is null → falls back to username
    expect(json.data.creator).toEqual({ name: 'alice' })
  })

  it('applies defaults for an agent saved before the channel existed', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(
      createTestAgent({
        id: 'agt_target',
        userId: 'usr_owner',
        name: 'Legacy',
        publishChannels: ['chat_app'],
        publishStatus: 'published',
        chatAppConfig: null,
      }),
      null,
      { username: 'alice', displayName: 'Alice' },
    )

    const res = await app.request('/agents/agt_target/chat-app')
    expect(res.status).toBe(200)
    const json = (await res.json()) as ChatAppResponse
    expect(json.data).toMatchObject({
      name: 'Legacy',
      welcomeMessage: null,
      suggestedQuestions: [],
      showCreator: true,
      allowAttachments: true,
      showThinking: true,
    })
  })

  /**
   * `showCreator: false` is a privacy choice, not a rendering hint: an owner
   * turns it off precisely so a broadly-shared Agent does not name them. Sending
   * the name anyway and hiding it client-side leaks it to anyone who opens
   * devtools or curls the endpoint.
   */
  it('withholds the creator entirely when showCreator is off', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(
      createTestAgent({
        id: 'agt_target',
        userId: 'usr_owner',
        publishChannels: ['chat_app'],
        publishStatus: 'published',
        chatAppConfig: { showCreator: false },
      }),
      null,
      { username: 'alice', displayName: 'Alice Wang' },
    )

    const res = await app.request('/agents/agt_target/chat-app')
    expect(res.status).toBe(200)
    const json = (await res.json()) as ChatAppResponse
    expect(json.data.showCreator).toBe(false)
    expect(json.data.creator).toBeNull()
    // Belt and braces: the name must not survive anywhere in the payload.
    expect(JSON.stringify(json)).not.toContain('Alice Wang')
  })

  // Regression: agent-import preserves chat_app in publishChannels while forcing
  // publishStatus 'draft', so a channel-only check served a live chat page for an
  // imported Agent nobody had reviewed.
  it('404s for a draft agent even when the channel is present', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(
      createTestAgent({
        id: 'agt_target',
        userId: 'usr_owner',
        publishChannels: ['api', 'chat_app'],
        publishStatus: 'draft',
      }),
      null,
    )

    const res = await app.request('/agents/agt_target/chat-app')
    expect(res.status).toBe(404)
  })

  // A stopped Agent still resolves so the page can render its dedicated "stopped"
  // explanation instead of a generic "page unavailable"; turns are blocked
  // separately (see the POST gate tests below).
  it('still resolves for a stopped agent so the page can explain itself', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(
      createTestAgent({
        id: 'agt_target',
        userId: 'usr_owner',
        publishChannels: ['api', 'chat_app'],
        publishStatus: 'stopped',
      }),
      null,
      { username: 'alice', displayName: 'Alice' },
    )

    const res = await app.request('/agents/agt_target/chat-app')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { publishStatus: string } }
    expect(json.data.publishStatus).toBe('stopped')
  })

  it('404s when the chat app channel is disabled', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(
      createTestAgent({ id: 'agt_target', userId: 'usr_owner', publishChannels: ['api'] }),
      null,
    )

    const res = await app.request('/agents/agt_target/chat-app')
    expect(res.status).toBe(404)
  })

  it('404s when the agent does not exist', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(undefined, null)

    const res = await app.request('/agents/agt_missing/chat-app')
    expect(res.status).toBe(404)
  })

  it('404s for a caller with no permission — the link alone grants nothing', async () => {
    const app = await makeApp('user', 'usr_stranger')
    primeLookup(CHAT_APP_AGENT(), null)

    const res = await app.request('/agents/agt_target/chat-app')
    expect(res.status).toBe(404)
  })

  it('allows a viewer, matching the read contract of GET /:id', async () => {
    const app = await makeApp('user', 'usr_viewer')
    primeLookup(
      CHAT_APP_AGENT(),
      { role: 'viewer' },
      {
        username: 'alice',
        displayName: 'Alice',
      },
    )

    const res = await app.request('/agents/agt_target/chat-app')
    expect(res.status).toBe(200)
  })
})

/**
 * Regression: the profile 404 only gates a fresh page load. Without an equivalent
 * check on the turn-taking endpoint, a page left open kept chatting after an owner
 * disabled the channel, so revoking a shared link silently did nothing.
 */
describe('POST /agents/:id/chat — chat_app channel gate', () => {
  const chatBody = (channel?: string) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hi', ...(channel ? { channel } : {}) }),
  })

  it('rejects a chat_app turn once the channel is disabled', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(
      createTestAgent({ id: 'agt_target', userId: 'usr_owner', publishChannels: ['api'] }),
      null,
    )

    const res = await app.request('/agents/agt_target/chat', chatBody('chat_app'))
    expect(res.status).toBe(404)
  })

  it('does not gate test-drawer turns on the chat_app channel', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(
      createTestAgent({ id: 'agt_target', userId: 'usr_owner', publishChannels: ['api'] }),
      null,
    )

    // Default channel is 'debug'; it must get past the gate regardless of the
    // chat_app toggle (it may still fail later for unrelated execution reasons).
    const res = await app.request('/agents/agt_target/chat', chatBody())
    expect(res.status).not.toBe(404)
  })

  it('allows a chat_app turn while the channel is enabled', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(CHAT_APP_AGENT(), null)

    const res = await app.request('/agents/agt_target/chat', chatBody('chat_app'))
    expect(res.status).not.toBe(404)
  })

  it('rejects a chat_app turn for a stopped agent, so stopping halts new turns', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(
      createTestAgent({
        id: 'agt_target',
        userId: 'usr_owner',
        publishChannels: ['api', 'chat_app'],
        publishStatus: 'stopped',
      }),
      null,
    )

    const res = await app.request('/agents/agt_target/chat', chatBody('chat_app'))
    expect(res.status).toBe(404)
  })

  it('rejects a chat_app turn for a draft agent carrying the channel', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(
      createTestAgent({
        id: 'agt_target',
        userId: 'usr_owner',
        publishChannels: ['api', 'chat_app'],
        publishStatus: 'draft',
      }),
      null,
    )

    const res = await app.request('/agents/agt_target/chat', chatBody('chat_app'))
    expect(res.status).toBe(404)
  })
})

/**
 * The chat page's `allowAttachments` toggle must hold server-side.
 *
 * Hiding the upload control is a UI courtesy — the endpoint is reachable
 * directly, so a visitor could otherwise POST `channel: 'chat_app'` with
 * attachments and make the Agent consume files the owner turned off.
 */
describe('POST /agents/:id/chat — chat_app attachment gate', () => {
  const withAttachment = (channel: string) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'hi',
      channel,
      attachments: [{ token: 'att_1', name: 'x.png', mimeType: 'image/png', size: 10 }],
    }),
  })

  const agentWithAttachments = (allowAttachments: boolean) =>
    createTestAgent({
      id: 'agt_target',
      userId: 'usr_owner',
      publishChannels: ['api', 'chat_app'],
      publishStatus: 'published',
      chatAppConfig: { suggestedQuestions: [], allowAttachments },
    })

  it('rejects a chat_app turn carrying attachments when the toggle is off', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(agentWithAttachments(false), null)

    const res = await app.request('/agents/agt_target/chat', withAttachment('chat_app'))
    expect(res.status).toBe(403)
    const json = (await res.json()) as { code?: string }
    expect(json.code).toBe('CHAT_APP_ATTACHMENTS_DISABLED')
  })

  it('allows a chat_app turn carrying attachments when the toggle is on', async () => {
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(agentWithAttachments(true), null)

    const res = await app.request('/agents/agt_target/chat', withAttachment('chat_app'))
    expect(res.status).not.toBe(403)
  })

  it('does not gate the test drawer on the chat page toggle', async () => {
    // `debug` is a different surface; its attachments are governed by the global
    // attachment settings, not by the chat page's presentation config.
    const app = await makeApp('admin', 'usr_admin')
    primeLookup(agentWithAttachments(false), null)

    const res = await app.request('/agents/agt_target/chat', withAttachment('debug'))
    expect(res.status).not.toBe(403)
  })
})
