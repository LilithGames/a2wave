/**
 * PATCH /agents/:id/channels/:channel — per-channel config save.
 *
 * The distinction this endpoint exists to preserve: **configuring a channel is
 * not the same as publishing the agent**. `POST /:id/publish` writes config AND
 * flips publishStatus to 'published', stamps publishedAt, rotates the endpoint
 * API key and starts every enabled channel's long connection. Saving Feishu
 * credentials from a card's config dialog must do none of that — a draft agent
 * stays a draft until the user explicitly hits Publish.
 */
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

vi.mock('../../db/client.js', () => {
  const chain = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }
  return { db: chain }
})

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn(() => 'agt_generated'),
}))

vi.mock('../../engine/index.js', () => ({
  buildAgentConfig: vi.fn(() => ({ engineType: 'cursor', maxRetries: 0 })),
  resolveEngineType: vi.fn(() => 'cursor'),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../worker/index.js', () => ({
  executeInWorker: vi.fn(),
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  resolveWorkDir: vi.fn(() => '/tmp/work'),
  tryAcquireSlot: vi.fn(() => true),
  scheduleNext: vi.fn(),
}))

vi.mock('../../lib/git-workspace.js', () => ({
  removeAgentWorkspace: vi.fn(),
}))

const feishuStart = vi.fn().mockResolvedValue(undefined)
const feishuStop = vi.fn()
vi.mock('../../lib/feishu-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/feishu-service.js')>()
  return {
    ...actual,
    feishuConnectionManager: { start: feishuStart, stop: feishuStop, isOpen: vi.fn(() => false) },
  }
})

const slackStart = vi.fn().mockResolvedValue(undefined)
const slackStop = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/slack-service.js', () => ({
  slackConnectionManager: { start: slackStart, stop: slackStop },
}))

const discordStart = vi.fn().mockResolvedValue(undefined)
const discordStop = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/discord-service.js', () => ({
  discordConnectionManager: { start: discordStart, stop: discordStop },
}))

const qqOfficialStart = vi.fn().mockResolvedValue(undefined)
const qqOfficialStop = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/qq-official-service.js', () => ({
  qqOfficialConnectionManager: {
    start: qqOfficialStart,
    stop: qqOfficialStop,
    isRegistered: vi.fn(() => false),
    isSocketOpen: vi.fn(() => false),
  },
}))

const scheduleStart = vi.fn()
const scheduleStop = vi.fn()
vi.mock('../../lib/schedule-trigger.js', () => ({
  scheduleTriggerManager: { start: scheduleStart, stop: scheduleStop },
}))

const gitTriggerStart = vi.fn()
const gitTriggerStop = vi.fn()
const gitTriggerStopAgent = vi.fn()
vi.mock('../../lib/git-trigger-manager.js', () => ({
  gitTriggerManager: {
    start: gitTriggerStart,
    stop: gitTriggerStop,
    stopAgent: gitTriggerStopAgent,
    stopAll: vi.fn(),
    restoreAll: vi.fn(),
  },
}))

const probeGitTriggerCliMock = vi.fn()
vi.mock('../../lib/git-trigger-cli.js', () => ({
  probeGitTriggerCli: (...args: unknown[]) => probeGitTriggerCliMock(...args),
}))

const logAuditMock = vi.fn()
vi.mock('../../lib/audit.js', () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
  logBackgroundAudit: vi.fn(),
}))

import { db } from '../../db/client.js'
import { AppError } from '../../lib/errors.js'

import { asyncQuery } from '../../test/async-query.js'

const mockDb = db as unknown as { select: Mock; insert: Mock; update: Mock; delete: Mock }

function makeSelectChain(result: unknown) {
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(result),
          all: vi.fn().mockReturnValue(result ? [result] : []),
          limit: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockReturnValue(result),
              all: vi.fn().mockReturnValue(result ? [result] : []),
            }),
          ),
        }),
        get: vi.fn().mockReturnValue(result),
        all: vi.fn().mockReturnValue(result ? [result] : []),
      }),
    ),
  }
}

/** Captures the object handed to `.set()` so assertions can inspect the write. */
function mockUpdateCapturing(agent: Record<string, unknown>) {
  const captured: { set: Record<string, unknown> } = { set: {} }
  mockDb.update.mockReturnValue({
    set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
      captured.set = values
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
  })
  return captured
}

function makeApp(
  routes: Hono,
  auth: { userId: string; role: 'admin' | 'user' } = { userId: 'usr_admin', role: 'admin' },
): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, auth.userId as never)
    c.set('userRole' as never, auth.role as never)
    await next()
  })
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    return c.json({ error: 'Internal Server Error' }, 500)
  })
  app.route('/agents', routes)
  return app
}

const DRAFT_AGENT = {
  id: 'agt_1',
  name: 'Draft Agent',
  type: 'cursor' as const,
  config: {},
  status: 'active' as const,
  publishStatus: 'draft' as const,
  publishChannels: ['api'],
  publishAuthType: 'api_key' as const,
  publishIpWhitelist: [],
  publishDescription: '',
  endpointApiKey: 'ak_existing',
  publishedAt: null,
  feishuConfig: null,
  slackConfig: null,
  discordConfig: null,
  qqOfficialConfig: null,
  chatAppConfig: null,
  scheduleConfig: null,
  glabConfig: null,
  ghConfig: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-06-01'),
}

const FEISHU_BODY = {
  config: {
    appId: 'cli_abc',
    appSecret: 'secret-plain',
    groupTriggerOnAt: true,
    groupTriggerOnNewMessage: false,
    groupReplyMode: 'quote',
    topicTriggerOnAt: true,
    topicTriggerOnNewTopic: false,
    topicTriggerOnNewComment: false,
    topicReplyMode: 'topic_reply',
  },
}

describe('PATCH /agents/:id/channels/:channel', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeApp(mod.default)
  })

  it('writes only the channel config and leaves publish state untouched', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    const captured = mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FEISHU_BODY),
    })

    expect(res.status).toBe(200)
    expect(captured.set.feishuConfig).toMatchObject({ appId: 'cli_abc', appSecret: 'secret-plain' })
    // Saving config must not publish, re-stamp, or rotate the key.
    expect(captured.set).not.toHaveProperty('publishStatus')
    expect(captured.set).not.toHaveProperty('publishedAt')
    expect(captured.set).not.toHaveProperty('endpointApiKey')
    expect(captured.set).not.toHaveProperty('publishChannels')
    expect(captured.set.updatedAt).toBeInstanceOf(Date)
  })

  it('keeps a draft agent in draft', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    const captured = mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FEISHU_BODY),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { publishStatus: string } }
    expect(body.data.publishStatus).toBe('draft')
    expect(captured.set).not.toHaveProperty('publishStatus')
  })

  it('does not start a connection for a draft agent', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FEISHU_BODY),
    })

    expect(feishuStart).not.toHaveBeenCalled()
  })

  it('restarts only its own channel when the agent is published with that channel on', async () => {
    const published = {
      ...DRAFT_AGENT,
      publishStatus: 'published' as const,
      publishChannels: ['api', 'feishu', 'slack'],
    }
    mockDb.select.mockReturnValue(makeSelectChain(published))
    mockUpdateCapturing(published)

    await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FEISHU_BODY),
    })

    expect(feishuStart).toHaveBeenCalledWith('agt_1', expect.objectContaining({ appId: 'cli_abc' }))
    // Editing Feishu must not bounce Slack's live socket.
    expect(slackStart).not.toHaveBeenCalled()
    expect(slackStop).not.toHaveBeenCalled()
  })

  it('does not start a connection when the channel is saved but not enabled', async () => {
    const published = {
      ...DRAFT_AGENT,
      publishStatus: 'published' as const,
      publishChannels: ['api'],
    }
    mockDb.select.mockReturnValue(makeSelectChain(published))
    mockUpdateCapturing(published)

    await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FEISHU_BODY),
    })

    // Configured-but-not-enabled is a legitimate state; nothing should go live.
    expect(feishuStart).not.toHaveBeenCalled()
  })

  it('preserves the stored secret when the masked sentinel is sent back', async () => {
    const withSecret = {
      ...DRAFT_AGENT,
      feishuConfig: { appId: 'cli_abc', appSecret: 'stored-secret' },
    }
    mockDb.select.mockReturnValue(makeSelectChain(withSecret))
    const captured = mockUpdateCapturing(withSecret)

    await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { ...FEISHU_BODY.config, appSecret: '********' },
      }),
    })

    expect((captured.set.feishuConfig as { appSecret: string }).appSecret).toBe('stored-secret')
  })

  it('refuses to blank the credentials of a live channel, keeping the socket up', async () => {
    // feishuConnectionManager.start() calls stop() BEFORE it validates, then
    // returns early on a missing appId. So persisting a blank credential for an
    // enabled+published channel would take a working bot offline while the
    // route still answered 200 and the dialog said "saved".
    const live = {
      ...DRAFT_AGENT,
      publishStatus: 'published' as const,
      publishChannels: ['api', 'feishu'],
      feishuConfig: { appId: 'cli_abc', appSecret: 'stored-secret' },
    }
    mockDb.select.mockReturnValue(makeSelectChain(live))
    mockUpdateCapturing(live)

    const res = await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...FEISHU_BODY.config, appId: '' } }),
    })

    expect(res.status).toBe(400)
    // Neither the stored config nor the running connection may be touched.
    expect(mockDb.update).not.toHaveBeenCalled()
    expect(feishuStop).not.toHaveBeenCalled()
    expect(feishuStart).not.toHaveBeenCalled()
  })

  it('allows blank credentials while the channel is not live', async () => {
    // Clearing a field mid-edit on a draft (or a disabled channel) is normal —
    // nothing is running, so there is no connection to protect.
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    const captured = mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...FEISHU_BODY.config, appId: '' } }),
    })

    expect(res.status).toBe(200)
    expect(captured.set.feishuConfig).toMatchObject({ appId: '' })
    expect(feishuStart).not.toHaveBeenCalled()
  })

  it('refuses to blank a live Slack channel', async () => {
    const live = {
      ...DRAFT_AGENT,
      publishStatus: 'published' as const,
      publishChannels: ['api', 'slack'],
      slackConfig: { appId: 'A1', appToken: 'xapp-stored', botToken: 'xoxb-stored' },
    }
    mockDb.select.mockReturnValue(makeSelectChain(live))
    mockUpdateCapturing(live)

    const res = await app.request('/agents/agt_1/channels/slack', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { appId: 'A1', appToken: '', botToken: '********' } }),
    })

    expect(res.status).toBe(400)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('rejects the masked sentinel when there is no stored secret to restore', async () => {
    // The config dialog is the primary way credentials are entered on a draft
    // agent — exactly the state where nothing is stored yet. Writing the mask
    // through would persist '********' AS the secret: it then reads back as an
    // already-masked value, so the field looks configured forever while every
    // Feishu call fails auth, and re-saving restores the mask again.
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...FEISHU_BODY.config, appSecret: '********' } }),
    })

    expect(res.status).toBe(400)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('rejects masked Slack tokens when nothing is stored', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/slack', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { appId: 'A1', appToken: '********', botToken: '********' },
      }),
    })

    expect(res.status).toBe(400)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('never writes an undefined token when the stored config is missing one', async () => {
    // A stored config can lack a token (older schema, or corrupted earlier).
    // Restoring `undefined` would fail slackConfigSchema inside the connection
    // manager — swallowed by .catch(), so the user sees 200 with a dead socket.
    const partial = { ...DRAFT_AGENT, slackConfig: { appId: 'A1', botToken: 'xoxb-stored' } }
    mockDb.select.mockReturnValue(makeSelectChain(partial))
    mockUpdateCapturing(partial)

    const res = await app.request('/agents/agt_1/channels/slack', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { appId: 'A1', appToken: '********', botToken: '********' },
      }),
    })

    expect(res.status).toBe(400)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('preserves stored Slack tokens behind the masked sentinel', async () => {
    const withTokens = {
      ...DRAFT_AGENT,
      slackConfig: { appId: 'A1', appToken: 'xapp-stored', botToken: 'xoxb-stored' },
    }
    mockDb.select.mockReturnValue(makeSelectChain(withTokens))
    const captured = mockUpdateCapturing(withTokens)

    await app.request('/agents/agt_1/channels/slack', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { appId: 'A1', appToken: '********', botToken: '********' },
      }),
    })

    expect(captured.set.slackConfig).toMatchObject({
      appToken: 'xapp-stored',
      botToken: 'xoxb-stored',
    })
  })

  it('saves QQ Official config without publishing and masks the secret', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    const captured = mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/qq_official', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { appId: '102000000', appSecret: 'secret-plain' } }),
    })

    expect(res.status).toBe(200)
    expect(captured.set.qqOfficialConfig).toMatchObject({
      appId: '102000000',
      appSecret: 'secret-plain',
      groupTriggerOnAt: true,
    })
    expect(captured.set.publishStatus).toBeUndefined()
    expect(await res.text()).not.toContain('secret-plain')
    expect(qqOfficialStart).not.toHaveBeenCalled()
  })

  it('restores the masked QQ Official secret and restarts a live channel', async () => {
    const live = {
      ...DRAFT_AGENT,
      publishStatus: 'published',
      publishChannels: ['api', 'qq_official'],
      qqOfficialConfig: { appId: '102000000', appSecret: 'stored-secret' },
    }
    mockDb.select.mockReturnValue(makeSelectChain(live))
    const captured = mockUpdateCapturing(live)

    const res = await app.request('/agents/agt_1/channels/qq_official', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { appId: '102000000', appSecret: '********' } }),
    })

    expect(res.status).toBe(200)
    expect(captured.set.qqOfficialConfig).toMatchObject({ appSecret: 'stored-secret' })
    expect(qqOfficialStart).toHaveBeenCalledWith(
      'agt_1',
      expect.objectContaining({ appSecret: 'stored-secret' }),
    )
  })

  it('writes an audit entry', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FEISHU_BODY),
    })

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.publish_channel',
        resource: 'agent',
        resourceId: 'agt_1',
      }),
    )
  })

  it('never leaks the saved secret back in the response', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FEISHU_BODY),
    })

    const raw = await res.text()
    expect(raw).not.toContain('secret-plain')
  })

  it('rejects an unknown channel key with 400', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/telegram', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: {} }),
    })

    expect(res.status).toBe(400)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('rejects a malformed config with 400 before touching the database', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/feishu', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // appId/appSecret are required for Feishu.
      body: JSON.stringify({ config: { groupReplyMode: 'quote' } }),
    })

    expect(res.status).toBe(400)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  // Permission coverage (owner/editor/viewer/unrelated) lives in the
  // agents-permission.test.ts matrix, which mocks the membership lookup
  // properly rather than returning the agent for every select.

  it('saves chat app presentation config', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    const captured = mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/chat_app', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { welcomeMessage: 'hi', suggestedQuestions: ['a'], showCreator: true },
      }),
    })

    expect(res.status).toBe(200)
    expect(captured.set.chatAppConfig).toMatchObject({ welcomeMessage: 'hi' })
  })
  // ── Git repository trigger channels (glab / gh) ─────────────────────────

  const GLAB_CONFIG = {
    provider: 'glab',
    repos: [{ project: 'group/repo', host: 'gitlab.example.com' }],
    events: ['opened', 'commented'],
    intervalSeconds: 60,
    intent: 'review {{url}}',
  }

  it('saves glab config into its own column', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    const captured = mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/glab', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: GLAB_CONFIG }),
    })

    expect(res.status).toBe(200)
    expect(captured.set.glabConfig).toMatchObject({
      provider: 'glab',
      intervalSeconds: 60,
    })
    // Configuring is not publishing.
    expect(captured.set.publishStatus).toBeUndefined()
    // Draft agent: nothing is live, so no poll may be started.
    expect(gitTriggerStart).not.toHaveBeenCalled()
  })

  it('keeps gh config in a separate column from glab', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    const captured = mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/gh', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...GLAB_CONFIG, provider: 'gh' } }),
    })

    expect(res.status).toBe(200)
    expect(captured.set.ghConfig).toMatchObject({ provider: 'gh' })
    expect(captured.set.glabConfig).toBeUndefined()
  })

  it('restarts only the saved provider poll when that channel is live', async () => {
    const liveAgent = {
      ...DRAFT_AGENT,
      publishStatus: 'published' as const,
      publishChannels: ['api', 'glab'],
    }
    mockDb.select.mockReturnValue(makeSelectChain(liveAgent))
    mockUpdateCapturing(liveAgent)

    const res = await app.request('/agents/agt_1/channels/glab', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: GLAB_CONFIG }),
    })

    expect(res.status).toBe(200)
    expect(gitTriggerStart).toHaveBeenCalledWith('agt_1', 'glab', expect.anything())
    // Editing glab must not disturb an unrelated channel's connection.
    expect(feishuStart).not.toHaveBeenCalled()
  })

  it('rejects an interval below the forge-protection floor', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/glab', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...GLAB_CONFIG, intervalSeconds: 5 } }),
    })

    expect(res.status).toBe(400)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('rejects a config whose provider does not match the channel', async () => {
    // Both git channels share one schema, so a glab-shaped config saved into
    // ghConfig validates fine — and then `gitTriggerManager.start()` refuses to
    // arm a timer on the mismatch. The channel would read as configured and
    // published while never polling once, with only a warn line as evidence.
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/gh', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: GLAB_CONFIG }),
    })

    // Rejected by schema validation itself now that each column is bound to its
    // own provider literal, so the explicit guard is a second line of defence
    // rather than the only one. The status and the refusal to write are what
    // matter; which layer caught it is an implementation detail.
    expect(res.status).toBe(400)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('rejects a config with no events selected', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1/channels/glab', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...GLAB_CONFIG, events: [] } }),
    })

    expect(res.status).toBe(400)
  })
})

const PATCH_GLAB_CONFIG = {
  provider: 'glab',
  repos: [{ project: 'group/repo' }],
  events: ['opened'],
  intervalSeconds: 60,
  intent: 'review {{url}}',
}

describe('PATCH /agents/:id — git trigger config', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeApp(mod.default)
  })

  it('rejects a provider-mismatched config on the generic update route', async () => {
    // Regression: this route reaches glabConfig/ghConfig through
    // `updateAgentInput` but applied neither the mismatch guard nor a channel
    // resync, so a mismatched config persisted and the poll silently refused to
    // arm — leaving a channel that reads as configured but never runs.
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockUpdateCapturing(DRAFT_AGENT)

    const res = await app.request('/agents/agt_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ghConfig: { ...PATCH_GLAB_CONFIG } }),
    })

    expect(res.status).toBe(400)
    expect(mockDb.update).not.toHaveBeenCalled()
  })
})

describe('GET /agents/:id/git-trigger/status', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agents.js')
    app = makeApp(mod.default)
  })

  it('reports the probed CLI status', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockDb.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ run: vi.fn() }) })
    probeGitTriggerCliMock.mockResolvedValue({
      provider: 'glab',
      installed: true,
      authenticated: true,
      account: 'octocat',
    })

    const res = await app.request(
      '/agents/agt_1/git-trigger/status?provider=glab&host=gitlab.example.com',
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { authenticated: boolean; account: string } }
    expect(body.data.authenticated).toBe(true)
    expect(body.data.account).toBe('octocat')
    expect(probeGitTriggerCliMock).toHaveBeenCalledWith('glab', 'gitlab.example.com')
  })

  it('surfaces an uninstalled CLI rather than failing the request', async () => {
    // The dialog must be able to render "not installed" — a 500 here would
    // leave the user with no explanation for why polling never fires.
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))
    mockDb.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ run: vi.fn() }) })
    probeGitTriggerCliMock.mockResolvedValue({
      provider: 'gh',
      installed: false,
      authenticated: false,
      detail: 'gh is not installed or not on PATH',
    })

    const res = await app.request('/agents/agt_1/git-trigger/status?provider=gh')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { installed: boolean } }
    expect(body.data.installed).toBe(false)
  })

  it('rejects an unknown provider', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(DRAFT_AGENT))

    const res = await app.request('/agents/agt_1/git-trigger/status?provider=gitea')

    expect(res.status).toBe(400)
    expect(probeGitTriggerCliMock).not.toHaveBeenCalled()
  })
})
