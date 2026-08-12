import { GatewayErrorCode } from '@a2wave/shared'
import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayAuthErrors } from '../../lib/gateway-auth-errors.js'

type Json = Record<string, unknown>
type ErrorJson = {
  error: {
    code: string
    message: string
    source?: string
    action?: string
    retryable?: boolean
    details?: Record<string, unknown>
  }
}

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi
      .fn()
      .mockReturnValue({ where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }),
  },
}))

vi.mock('../../middleware/gateway-auth.js', () => ({
  validateGatewayAuth: vi.fn(),
  // 与真实实现一致的纯函数（gateway-auth 单点定义）。
  oauthUploaderId: (caller: { userInfo: { issuer: string; sub: string } }) =>
    `oauth:${caller.userInfo.issuer}:${caller.userInfo.sub}`,
}))

// rateLimit must be a passthrough middleware in tests
vi.mock('../../middleware/rate-limit.js', () => ({
  rateLimit: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  WorktreeOccupiedError: class WorktreeOccupiedError extends Error {},
  resolveWorkDir: vi.fn().mockReturnValue('/tmp/work'),
  // buildAgentConfig is ASYNC in production, so this stand-in must resolve
  // rather than return. A sync mock silently changes the failure mode of the
  // route's try/catch: a sync throw is caught, whereas the real rejection is
  // not unless the call is awaited inside the try. That drift is exactly how a
  // green `expect(424)` ended up guarding behaviour production no longer had.
  buildAgentConfig: vi.fn().mockResolvedValue({ engineType: 'cursor', maxRetries: 0 }),
}))

vi.mock('../../engine/index.js', () => ({
  engineRegistry: {
    get: vi.fn().mockReturnValue({}),
    cancel: vi.fn().mockResolvedValue(false),
  },
}))

vi.mock('../../engine/execution-lease-registry.js', () => ({
  cancelExecutionLease: vi.fn().mockResolvedValue(undefined),
  completeExecutionLease: vi.fn(),
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: vi.fn().mockReturnValue('acquired'),
  scheduleNext: vi.fn(),
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: { failRunSteps: vi.fn() },
}))

vi.mock('../../lib/execute-chat-run.js', () => ({
  executeChatRun: vi.fn(),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
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

vi.mock('../../lib/run-launcher.js', () => ({
  runWithLifecycle: vi.fn().mockResolvedValue({ success: true, output: 'ok', durationMs: 100 }),
}))

vi.mock('../../lib/run-channel.js', () => ({
  buildOAuthChannel: vi.fn().mockReturnValue({
    ctx: {
      channel_type: 'oauth',
      channel_info: { auth: 'oauth' },
      user_info: { email: 'user@example.com', source: 'idaas' },
    },
    displayName: 'user@example.com',
  }),
  // Real stripping behavior so the B1 security test actually validates it.
  stripReservedContextKeys: (ctx: Record<string, unknown> | undefined | null) => {
    const copy = { ...(ctx ?? {}) }
    for (const k of [
      'channel',
      'caller',
      'receive_id_type',
      'receive_id',
      '__a2wave_oauth_previous_chat_id',
    ]) {
      delete copy[k]
    }
    return copy
  },
}))

vi.mock('../../lib/pending-job-registry.js', () => ({
  registerPendingContext: vi.fn(),
  takePendingContext: vi.fn(),
}))

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDbChain(result: unknown) {
  const terminal = {
    get: vi.fn().mockReturnValue(result),
    all: vi.fn().mockReturnValue(result ? [result] : []),
    limit: vi.fn().mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue(result) })),
    orderBy: vi.fn().mockReturnValue(
      asyncQuery({
        limit: vi.fn().mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue(result) })),
        get: vi.fn().mockReturnValue(result),
      }),
    ),
  }
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(terminal) }) }
}

function makeInsertChain() {
  return { values: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn().mockReturnValue({ changes: 1 }) })),
    }),
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const oauthAgent = {
  id: 'agt_oauth1',
  name: 'OAuth Agent',
  publishStatus: 'published',
  publishAuthType: 'api_key',
  publishChannels: ['api', 'oauth'],
  publishIpWhitelist: [],
  endpointApiKey: null,
  config: {},
  maxConcurrency: 1,
}

const validCaller = {
  kind: 'idaas_user',
  userInfo: {
    sub: 'sub-test',
    issuer: 'https://idaas.example.com/',
    email: 'user@example.com',
    username: 'tester',
  },
}

// ── Imports ────────────────────────────────────────────────────────────────

import { db } from '../../db/client.js'
import { engineRegistry } from '../../engine/index.js'
import { scheduleNext, tryAcquireSlot } from '../../engine/task-queue.js'
import { WorktreeOccupiedError, buildAgentConfig, resolveWorkDir } from '../../lib/agent-helpers.js'
import { ProviderConfigurationError } from '../../lib/errors.js'
import { registerPendingContext } from '../../lib/pending-job-registry.js'
import { runWithLifecycle } from '../../lib/run-launcher.js'
import { validateGatewayAuth } from '../../middleware/gateway-auth.js'

/**
 * Local copy of src/test/async-query.ts, deliberately NOT imported.
 *
 * This file calls asyncQuery from inside a `vi.mock` factory, which vitest
 * hoists above every import. Referencing the shared module there fails at
 * runtime with "Cannot access '__vi_import_N__' before initialization" and
 * silently collects 0 tests, so the duplication is load-bearing.
 */
/**
 * Wrap a legacy sync mock terminator so it works with awaited queries.
 *
 * Production code awaits every query now, so a mock exposing only
 * `get`/`all`/`run` breaks at `.limit(1)` or at `await`. The returned value is
 * a real thenable (resolving to the row list) that also answers the builder
 * methods, while keeping the original mock fns reachable for assertions.
 */
// biome-ignore lint/suspicious/noExplicitAny: stands in for drizzle's builder across mock sites with differing terminator shapes.
function asyncQuery(term: Record<string, unknown>): any {
  const rows = (): unknown[] => {
    // `get` is consulted BEFORE `all`. Many mocks define both — a configured
    // `get` alongside a placeholder `all: () => []` — and preferring `all` made
    // every single-row lookup resolve empty, so callers saw `undefined`.
    const get = term.get as (() => unknown) | undefined
    if (get) {
      const row = get()
      if (row != null) return [row]
    }
    const all = term.all as (() => unknown[]) | undefined
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    if (get) return []
    const run = term.run as (() => unknown) | undefined
    if (run) {
      // A write mock returns better-sqlite3's `{ changes: n }`. Production now
      // counts `.returning()` rows instead, so surface n placeholder rows —
      // otherwise a successful claim looks like "0 rows affected" and every
      // compare-and-set guard reports that it lost the race.
      const res = run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 1
      return Array.from({ length: changes }, () => ({}))
    }
    return []
  }
  const make = (): any => {
    // Compose rather than choose: the test's own chain methods run first (so a
    // nested `where`/`orderBy` it defined still drives the data), and whatever
    // they return is itself wrapped — so `.limit(1)` and `await` work at every
    // depth. Picking one side or the other broke the opposite set of files.
    const wrap = (v: unknown): unknown =>
      v && typeof v === 'object' && !(v as { then?: unknown }).then
        ? asyncQuery(v as Record<string, unknown>)
        : v
    const chained: Record<string, unknown> = {}
    for (const key of [
      'limit',
      'orderBy',
      'offset',
      'groupBy',
      'having',
      'where',
      'returning',
      'onConflictDoNothing',
      'onConflictDoUpdate',
      'for',
    ]) {
      const own = term[key] as ((...a: unknown[]) => unknown) | undefined
      chained[key] = own ? (...a: unknown[]) => wrap(own(...a)) : () => make()
    }
    // Lazy: the row-resolving function must run only when the node is actually
    // awaited. `Promise.resolve().then(rows)` fires eagerly at construction, so
    // building a chain consumed a queued `get` per intermediate node and every
    // sequence-driven mock desynchronised.
    let settled: Promise<unknown[]> | undefined
    const node = Object.assign(
      {
        // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable — it stands in for drizzle's awaitable query builder.
        then: (
          onFulfilled?: (v: unknown[]) => unknown,
          onRejected?: (e: unknown) => unknown,
        ): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.then(onFulfilled, onRejected)
        },
        catch: (onRejected?: (e: unknown) => unknown): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.catch(onRejected)
        },
        finally: (onFinally?: () => void): Promise<unknown> => {
          settled ??= Promise.resolve().then(rows)
          return settled.finally(onFinally)
        },
      },
      term,
      chained,
    )
    return node
  }
  return make()
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('OAuth Gateway routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    ;(validateGatewayAuth as Mock).mockResolvedValue({ caller: validCaller })
    ;(db.insert as Mock).mockReturnValue(makeInsertChain())
    ;(db.update as Mock).mockReturnValue(makeUpdateChain())
    ;(tryAcquireSlot as Mock).mockReturnValue('acquired')
    ;(resolveWorkDir as Mock).mockReturnValue('/tmp/work')
    ;(buildAgentConfig as Mock).mockResolvedValue({ engineType: 'cursor', maxRetries: 0 })

    const mod = await import('../oauth-gateway.js')
    app = new Hono()
    app.route('/api/oauth', mod.default)
  })

  function invokeRequest(
    body: Record<string, unknown>,
    headers?: Record<string, string>,
    remoteAddress?: string,
  ) {
    return app.request(
      '/api/oauth/agt_oauth1/invoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined,
    )
  }

  // ── Channel guard ──────────────────────────────────────────────────────

  describe('OAuth channel guard', () => {
    it('uses the TCP peer for the IP whitelist when an untrusted caller spoofs X-Forwarded-For', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))

      const res = await invokeRequest(
        { message: 'hi' },
        { 'X-Forwarded-For': '203.0.113.99' },
        '198.51.100.41',
      )

      expect(res.status).toBe(202)
      expect(validateGatewayAuth).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ clientIp: '198.51.100.41' }),
      )
    })

    it('returns 403 when publishChannels does not include oauth', async () => {
      const noOauthAgent = { ...oauthAgent, publishChannels: ['api'] }
      ;(db.select as Mock).mockReturnValue(makeDbChain(noOauthAgent))

      const res = await invokeRequest({ message: 'hi' })

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.OAUTH_CHANNEL_DISABLED)
    })

    it('returns 403 when publishChannels is null', async () => {
      const nullChannelsAgent = { ...oauthAgent, publishChannels: null }
      ;(db.select as Mock).mockReturnValue(makeDbChain(nullChannelsAgent))

      const res = await invokeRequest({ message: 'hi' })

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.OAUTH_CHANNEL_DISABLED)
    })

    it('returns 404 when agent not found', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await invokeRequest({ message: 'hi' })

      expect(res.status).toBe(404)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_FOUND)
    })

    it('returns 403 when agent is not published', async () => {
      const draftAgent = { ...oauthAgent, publishStatus: 'draft' }
      ;(db.select as Mock).mockReturnValue(makeDbChain(draftAgent))

      const res = await invokeRequest({ message: 'hi' })

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_PUBLISHED)
    })
  })

  // ── Auth ───────────────────────────────────────────────────────────────

  describe('Authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        error: { error: 'Missing Authorization header', status: 401 },
      })

      const res = await invokeRequest({ message: 'hi' })

      expect(res.status).toBe(401)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message:
          "A JWT from the caller's OIDC client for the configured a2wave resource audience is required. Obtain one, then send it in the Authorization: Bearer <token> header.",
        source: 'caller',
        action: 'obtain_new_access_token',
        retryable: false,
      })
    })

    it('identifies an invalid caller token without referring to the agent provider login', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        error: { error: 'Invalid token', status: 401 },
      })

      const res = await invokeRequest({ message: 'hi' })

      expect(res.status).toBe(401)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'CALLER_TOKEN_INVALID',
        message:
          "The caller's access token is invalid, expired, or issued for the wrong audience. Obtain a new JWT from the caller's OIDC client for the configured a2wave resource audience, then retry the request.",
        source: 'caller',
        action: 'obtain_new_access_token',
      })
    })

    it('returns 403 when the user is not on the agent allowlist', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        error: { error: GatewayAuthErrors.NOT_IN_ALLOWED_USERS, status: 403 },
      })

      const res = await invokeRequest({ message: 'hi', async: true })

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'CALLER_NOT_AUTHORIZED',
        message:
          'The authenticated user is not allowed to invoke this agent. Ask the agent owner to grant access or use an authorized account.',
        source: 'caller',
        action: 'contact_agent_owner',
      })
    })

    // Driven off the shared constants rather than literals: the previous literal drifted from
    // the middleware's message and the mismatch fell through to CALLER_NOT_AUTHORIZED, telling
    // the caller to contact the agent owner about a claim its IdP had to fix.
    it.each([GatewayAuthErrors.MISSING_EMAIL_CLAIM, GatewayAuthErrors.MISSING_VERIFIED_EMAIL])(
      'maps %s to CALLER_TOKEN_CLAIMS_INVALID',
      async (message) => {
        ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
        ;(validateGatewayAuth as Mock).mockResolvedValue({ error: { error: message, status: 403 } })

        const res = await invokeRequest({ message: 'hi', async: true })

        expect(res.status).toBe(403)
        const json = (await res.json()) as ErrorJson
        expect(json.error.code).toBe(GatewayErrorCode.CALLER_TOKEN_CLAIMS_INVALID)
      },
    )

    // An IdP outage must not be reported as a caller credential failure, and must read as
    // retryable so integrators do not rotate working credentials.
    it('maps an unreachable IdP to a retryable 503, not a caller auth failure', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        error: { error: GatewayAuthErrors.IDP_UNAVAILABLE, status: 503 },
      })

      const res = await invokeRequest({ message: 'hi', async: true })

      expect(res.status).toBe(503)
      const json = (await res.json()) as ErrorJson
      expect(json.error.source).toBe('platform')
      expect(json.error.retryable).toBe(true)
      expect(json.error.message).toMatch(/identity provider/i)
    })

    it('accepts a verified caller without an email claim (email is an access-mode concern)', async () => {
      // The email requirement belongs to the authorization layer (specified_users), enforced by
      // the gateway-auth middleware — see gateway-auth.test.ts. The route does not re-check it.
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        caller: {
          kind: 'idaas_user',
          userInfo: { sub: 'sub-noemail', issuer: 'https://idaas.example.com/' },
        },
      })

      const res = await invokeRequest({ message: 'hi', async: true })

      expect(res.status).toBe(202)
    })

    it.each([
      [
        'OAuth not configured',
        503,
        'OAUTH_NOT_CONFIGURED',
        'platform',
        'contact_platform_administrator',
      ],
      ['IP not allowed', 403, 'IP_NOT_ALLOWED', 'caller', 'use_allowed_network'],
    ] as const)(
      'maps auth guard error %s to its remediation owner',
      async (upstream, status, code, source, action) => {
        ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
        ;(validateGatewayAuth as Mock).mockResolvedValue({
          error: { error: upstream, status },
        })

        const res = await invokeRequest({ message: 'hi' })

        expect(res.status).toBe(status)
        const json = (await res.json()) as ErrorJson
        expect(json.error).toMatchObject({ code, source, action })
      },
    )

    it('returns AUTH_REQUIRED when the auth guard has no caller identity', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({})

      const res = await invokeRequest({ message: 'hi' })

      expect(res.status).toBe(401)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        source: 'caller',
        action: 'obtain_new_access_token',
      })
    })
  })

  // ── Invoke ─────────────────────────────────────────────────────────────

  describe('POST /:agentId/invoke', () => {
    it('returns 202 with runId for successful async invoke', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))

      const res = await invokeRequest({ message: 'hello', async: true })

      expect(res.status).toBe(202)
      const json = (await res.json()) as Json
      expect((json.data as Json).runId).toBeDefined()
    })

    it('returns 200 with reply for sync invoke', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(runWithLifecycle as Mock).mockResolvedValue({
        success: true,
        output: 'pong',
        durationMs: 50,
      })

      const res = await invokeRequest({ message: 'ping', async: false, stream: false })

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      expect((json.data as Json).reply).toBe('pong')
    })

    it('returns 400 when message is missing', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))

      const res = await invokeRequest({ async: true })

      expect(res.status).toBe(400)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.INVALID_REQUEST)
    })

    it('returns an actionable INVALID_REQUEST for malformed JSON', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))

      const res = await app.request('/api/oauth/agt_oauth1/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'INVALID_REQUEST',
        message:
          'The request body is not valid JSON. Send a JSON object with a non-empty message field.',
        source: 'caller',
        action: 'fix_request',
      })
    })

    it('attributes a missing execution engine to agent configuration', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(engineRegistry.get as Mock).mockReturnValueOnce(undefined)

      const res = await invokeRequest({ message: 'hi', async: false })

      expect(res.status).toBe(424)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'AGENT_CONFIGURATION_ERROR',
        source: 'agent',
        action: 'contact_agent_owner',
      })
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('attributes an unsupported Provider kind to agent configuration', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      // REJECTS, matching production. buildAgentConfig is async, so the route's
      // catch only sees this if the call is awaited inside the try; an
      // unawaited call lets ProviderConfigurationError escape to Hono as a bare
      // 500 instead of the documented 424.
      ;(buildAgentConfig as Mock).mockRejectedValueOnce(
        new ProviderConfigurationError('prv_legacy', 'legacy:prv_legacy'),
      )

      const res = await invokeRequest({ message: 'hi', async: false })

      expect(res.status).toBe(424)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: GatewayErrorCode.AGENT_CONFIGURATION_ERROR,
        source: 'agent',
        action: 'contact_agent_owner',
        details: { providerId: 'prv_legacy', providerKind: 'legacy:prv_legacy' },
      })
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('returns 429 when agent queue is full', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(tryAcquireSlot as Mock).mockReturnValueOnce('queue_full')

      const res = await invokeRequest({ message: 'hi', async: true })

      expect(res.status).toBe(429)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'AGENT_QUEUE_FULL',
        message: 'This agent has reached its queue limit. Retry after an active run finishes.',
        source: 'agent',
        action: 'retry_later',
        retryable: true,
      })
      expect(db.delete).toHaveBeenCalled()
    })

    it('returns a provider re-authentication error without blaming the caller token', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(runWithLifecycle as Mock).mockResolvedValue({
        success: false,
        error:
          'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
        durationMs: 50,
      })

      const res = await invokeRequest({ message: 'ping', async: false, stream: false })

      expect(res.status).toBe(424)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'PROVIDER_REAUTH_REQUIRED',
        message:
          "The agent's Codex CLI login has expired or been revoked. Ask the agent owner to sign in to Codex CLI again, then retry the request.",
        source: 'provider',
        action: 'contact_agent_owner',
        retryable: false,
      })
      expect(json.error.message).not.toContain('your refresh token')
    })

    it('uses the same structured provider error in the SSE error event', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(runWithLifecycle as Mock).mockResolvedValue({
        success: false,
        error:
          'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
        durationMs: 50,
      })

      const res = await invokeRequest({ message: 'ping', async: false, stream: true })

      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('event: error')
      expect(body).toContain('"code":"PROVIDER_REAUTH_REQUIRED"')
      expect(body).toContain(
        "The agent's Codex CLI login has expired or been revoked. Ask the agent owner to sign in to Codex CLI again, then retry the request.",
      )
      expect(body).not.toContain('your refresh token')
    })

    it('treats stream=true as SSE even when async is omitted', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(runWithLifecycle as Mock).mockResolvedValue({
        success: true,
        output: 'streamed',
        durationMs: 50,
      })

      const res = await invokeRequest({ message: 'ping', stream: true })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const body = await res.text()
      expect(body).toContain('event: done')
      expect(body).toContain('"reply":"streamed"')
    })

    it('returns 202 with status queued when slot is queued', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(tryAcquireSlot as Mock).mockReturnValueOnce('queued')

      const res = await invokeRequest({ message: 'hi', async: true })

      expect(res.status).toBe(202)
      const json = (await res.json()) as Json
      expect((json.data as Json).status).toBe('queued')
    })

    it('strips reserved keys (caller/channel/receive_id*) from client-supplied context (B1)', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      const insertedValues: unknown[] = []
      ;(db.insert as Mock).mockImplementation(() => ({
        values: vi.fn().mockImplementation((v: unknown) => {
          insertedValues.push(v)
          return { run: vi.fn() }
        }),
      }))

      await invokeRequest({
        message: 'hi',
        async: true,
        context: {
          caller: { idaasUser: { sub: 'admin' } },
          channel: { spoofed: true },
          // Feishu DM-injection vector: a hostile OAuth caller must not be able to
          // direct the agent's bot reply-by-context to an arbitrary target.
          receive_id_type: 'open_id',
          receive_id: 'ou_arbitrary_target',
          __a2wave_oauth_previous_chat_id: 'chat_attacker',
          safe: 'ok',
        },
      })

      const stepInsert = insertedValues.find(
        (v): v is { input: { context: Record<string, unknown> } } =>
          typeof v === 'object' && v !== null && 'input' in v,
      )
      const ctx = (stepInsert?.input?.context ?? {}) as Record<string, unknown>
      expect(ctx).not.toHaveProperty('caller')
      expect(ctx).not.toHaveProperty('receive_id_type')
      expect(ctx).not.toHaveProperty('receive_id')
      expect(ctx).not.toHaveProperty('__a2wave_oauth_previous_chat_id')
      // channel is server-built — assert attacker's spoofed marker got overwritten
      expect(ctx.channel).toMatchObject({ channel_type: 'oauth' })
      expect((ctx.channel as Record<string, unknown>).spoofed).toBeUndefined()
      expect(ctx.safe).toBe('ok')
    })

    it('sets triggerSource to oauth on the run insert', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))

      const insertedValues: unknown[] = []
      ;(db.insert as Mock).mockImplementation(() => ({
        values: vi.fn().mockImplementation((v: unknown) => {
          insertedValues.push(v)
          return { run: vi.fn() }
        }),
      }))

      await invokeRequest({ message: 'hi', async: true })

      const runInsert = insertedValues.find(
        (v): v is { triggerSource: string; executionMetadata?: Record<string, unknown> } =>
          typeof v === 'object' && v !== null && 'triggerSource' in v,
      )
      expect(runInsert?.triggerSource).toBe('oauth')
      expect(runInsert?.executionMetadata).toEqual({
        oauthEngineType: 'cursor',
        // Caller identity pinned for per-caller run read/cancel authorization.
        oauthCallerId: 'oauth:https://idaas.example.com/:sub-test',
      })
    })

    it('queues OAuth session continuation through execution metadata without leaking chat id into context', async () => {
      const previousRun = {
        id: 'run_previous',
        status: 'completed',
        result: { chatId: 'chat_previous' },
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        if (selectCount === 2) return makeDbChain(undefined)
        return makeDbChain(previousRun)
      })
      ;(tryAcquireSlot as Mock).mockReturnValueOnce('queued')
      const insertedValues: unknown[] = []
      ;(db.insert as Mock).mockImplementation(() => ({
        values: vi.fn().mockImplementation((v: unknown) => {
          insertedValues.push(v)
          return { run: vi.fn() }
        }),
      }))

      const res = await invokeRequest({
        message: 'continue later',
        sessionId: 'sess_cli_123',
        async: true,
        context: { __a2wave_oauth_previous_chat_id: 'chat_attacker', safe: 'ok' },
      })

      expect(res.status).toBe(202)
      const json = (await res.json()) as Json
      expect((json.data as Json).status).toBe('queued')
      expect((json.data as Json).sessionId).toBe('sess_cli_123')
      const runInsert = insertedValues.find(
        (v): v is { executionMetadata?: Record<string, unknown>; triggerSource?: string } =>
          typeof v === 'object' && v !== null && 'triggerSource' in v,
      )
      expect(runInsert?.executionMetadata).toEqual({
        oauthEngineType: 'cursor',
        oauthCallerId: 'oauth:https://idaas.example.com/:sub-test',
        oauthPreviousChatId: 'chat_previous',
      })
      expect(registerPendingContext).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.objectContaining({ __a2wave_oauth_previous_chat_id: expect.anything() }),
      )
    })

    it('returns SESSION_BUSY when concurrent OAuth session insert hits the active-session unique index', async () => {
      const activeRun = {
        id: 'run_raced',
        status: 'running',
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        if (selectCount === 2) return makeDbChain(undefined)
        if (selectCount === 3) return makeDbChain(null)
        return makeDbChain(activeRun)
      })
      const constraint = new Error('UNIQUE constraint failed: runs_oauth_active_session_unique')
      ;(db.insert as Mock).mockReturnValueOnce({
        values: vi.fn().mockReturnValue(
          asyncQuery({
            run: vi.fn(() => {
              throw constraint
            }),
          }),
        ),
      })

      const res = await invokeRequest({
        message: 'race',
        sessionId: 'sess_cli_123',
        async: false,
      })

      expect(res.status).toBe(409)
      const json = (await res.json()) as ErrorJson & { error: { details?: { runId?: string } } }
      expect(json.error.code).toBe(GatewayErrorCode.SESSION_BUSY)
      expect(json.error.details?.runId).toBe('run_raced')
      expect(registerPendingContext).not.toHaveBeenCalled()
      expect(tryAcquireSlot).not.toHaveBeenCalled()
    })

    it('resumes a completed OAuth session without exposing the underlying chat id', async () => {
      const previousRun = {
        id: 'run_previous',
        status: 'completed',
        result: { chatId: 'chat_previous' },
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        if (selectCount === 2) return makeDbChain(undefined)
        return makeDbChain(previousRun)
      })
      ;(runWithLifecycle as Mock).mockResolvedValue({
        success: true,
        output: 'continued',
        chatId: 'chat_next',
        durationMs: 25,
      })

      const insertedValues: unknown[] = []
      ;(db.insert as Mock).mockImplementation(() => ({
        values: vi.fn().mockImplementation((v: unknown) => {
          insertedValues.push(v)
          return { run: vi.fn() }
        }),
      }))

      const res = await invokeRequest({
        message: 'continue',
        sessionId: 'sess_cli_123',
        async: false,
      })

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      expect((json.data as Json).reply).toBe('continued')
      expect((json.data as Json).sessionId).toBe('sess_cli_123')
      expect((json.data as Json).chatId).toBeUndefined()

      const runInsert = insertedValues.find(
        (v): v is { triggerSessionId?: string; triggerSource?: string } =>
          typeof v === 'object' && v !== null && 'triggerSource' in v,
      )
      expect(runInsert?.triggerSessionId).toMatch(/^oauth:[a-f0-9]{32}$/)
      expect(runWithLifecycle).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ chatId: 'chat_previous' }),
        expect.any(Object),
      )
    })

    it('does not resume the previous chat id when resetSession is true', async () => {
      const previousRun = {
        id: 'run_previous',
        status: 'completed',
        result: { chatId: 'chat_previous' },
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        if (selectCount === 2) return makeDbChain(undefined)
        return makeDbChain(previousRun)
      })

      const res = await invokeRequest({
        message: 'start over',
        sessionId: 'sess_cli_123',
        resetSession: true,
        async: false,
      })

      expect(res.status).toBe(200)
      expect(runWithLifecycle).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.objectContaining({ chatId: 'chat_previous' }),
        expect.any(Object),
      )
    })

    it('rejects a new OAuth session turn when another run in the same session is active', async () => {
      const activeRun = {
        id: 'run_busy',
        status: 'running',
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(activeRun)
      })

      const res = await invokeRequest({
        message: 'continue',
        sessionId: 'sess_cli_123',
        async: false,
      })

      expect(res.status).toBe(409)
      const json = (await res.json()) as ErrorJson & { error: { details?: { runId?: string } } }
      expect(json.error.code).toBe(GatewayErrorCode.SESSION_BUSY)
      expect(json.error.message).toBe(
        'This session already has an active run. Wait for that run to finish before sending the next message.',
      )
      expect(json.error.details?.runId).toBe('run_busy')
      expect(db.insert).not.toHaveBeenCalled()
      expect(runWithLifecycle).not.toHaveBeenCalled()
    })

    it('marks the OAuth session run failed when workdir resolution fails before lifecycle starts', async () => {
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        if (selectCount === 2) return makeDbChain(undefined)
        return makeDbChain(null)
      })
      const updateValues: unknown[] = []
      ;(db.update as Mock).mockReturnValueOnce({
        set: vi.fn().mockImplementation((value: unknown) => {
          updateValues.push(value)
          return { where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }
        }),
      })
      ;(resolveWorkDir as Mock).mockRejectedValueOnce(new Error('workspace unavailable'))

      const res = await invokeRequest({
        message: 'start',
        sessionId: 'sess_cli_123',
        async: false,
      })

      expect(res.status).toBe(424)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'AGENT_WORKSPACE_UNAVAILABLE',
        message:
          "The agent's workspace could not be prepared. Ask the agent owner to check the configured source workspace, then retry.",
        source: 'agent',
        action: 'contact_agent_owner',
      })
      expect(json.error.message).not.toContain('workspace unavailable')
      expect(updateValues).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          result: { error: 'workspace unavailable' },
        }),
      )
      expect(scheduleNext).toHaveBeenCalled()
      expect(runWithLifecycle).not.toHaveBeenCalled()
    })

    it('returns a retryable workspace error when the workspace is busy', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(resolveWorkDir as Mock).mockRejectedValueOnce(new WorktreeOccupiedError('busy'))

      const res = await invokeRequest({ message: 'start', async: false })

      expect(res.status).toBe(409)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'AGENT_WORKSPACE_UNAVAILABLE',
        source: 'agent',
        action: 'retry_later',
        retryable: true,
      })
      expect(json.error.message).not.toContain('busy')
    })

    it('returns a structured INTERNAL_ERROR for an unexpected invoke failure', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      ;(db.insert as Mock).mockReturnValueOnce({
        values: vi.fn().mockReturnValue(
          asyncQuery({
            run: vi.fn(() => {
              throw new Error('database path /secret/db.sqlite')
            }),
          }),
        ),
      })

      const res = await invokeRequest({ message: 'start', async: false })

      expect(res.status).toBe(500)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'INTERNAL_ERROR',
        source: 'platform',
        action: 'contact_platform_administrator',
        retryable: false,
      })
      expect(json.error.message).not.toContain('/secret/db.sqlite')
    })

    it('marks a run failed and releases its slot when post-acquisition setup fails', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(oauthAgent))
      const updateValues: unknown[] = []
      ;(db.update as Mock).mockImplementation(() => ({
        set: vi.fn().mockImplementation((value: unknown) => {
          updateValues.push(value)
          return { where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }
        }),
      }))
      ;(db.insert as Mock).mockReturnValueOnce(makeInsertChain()).mockReturnValueOnce({
        values: vi.fn().mockReturnValue(
          asyncQuery({
            run: vi.fn(() => {
              throw new Error('SQLITE_BUSY at /secret/database.sqlite')
            }),
          }),
        ),
      })

      const res = await invokeRequest({ message: 'start', async: false })

      expect(res.status).toBe(500)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: 'INTERNAL_ERROR',
        source: 'platform',
        action: 'contact_platform_administrator',
        retryable: false,
      })
      expect(json.error.message).not.toContain('/secret/database.sqlite')
      expect(updateValues).toContainEqual(
        expect.objectContaining({ status: 'failed', result: { error: 'Run setup failed' } }),
      )
      expect(scheduleNext).toHaveBeenCalled()
      expect(runWithLifecycle).not.toHaveBeenCalled()
    })
  })

  // ── Poll ───────────────────────────────────────────────────────────────

  describe('GET /:agentId/runs/:runId', () => {
    function pollRequest(runId: string) {
      return app.request(`/api/oauth/agt_oauth1/runs/${runId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })
    }

    it('does not expose internal chatId in completed run result', async () => {
      const completedRun = {
        id: 'run_done',
        status: 'completed',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        executionMetadata: { oauthCallerId: 'oauth:https://idaas.example.com/:sub-test' },
        result: { output: 'done', chatId: 'chat_internal', durationMs: 123 },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(completedRun)
      })

      const res = await pollRequest('run_done')

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      const result = ((json.data as Json).result ?? {}) as Json
      expect(result.output).toBe('done')
      expect(result.durationMs).toBe(123)
      expect(result.chatId).toBeUndefined()
    })

    it('converts a failed async provider login into the caller-facing error contract', async () => {
      const failedRun = {
        id: 'run_failed',
        status: 'failed',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        executionMetadata: { oauthCallerId: 'oauth:https://idaas.example.com/:sub-test' },
        result: {
          error:
            'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(failedRun)
      })

      const res = await pollRequest('run_failed')

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      const result = (json.data as Json).result as { error: ErrorJson['error'] }
      expect(result.error).toMatchObject({
        code: 'PROVIDER_REAUTH_REQUIRED',
        message:
          "The agent's Codex CLI login has expired or been revoked. Ask the agent owner to sign in to Codex CLI again, then retry the request.",
        source: 'provider',
        action: 'contact_agent_owner',
        retryable: false,
      })
      expect(result.error.details).toMatchObject({ runId: 'run_failed', provider: 'codex' })
    })

    it('uses the persisted engine type when projecting a historical failed run', async () => {
      const failedRun = {
        id: 'run_historical',
        status: 'failed',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        executionMetadata: {
          oauthEngineType: 'codex',
          oauthCallerId: 'oauth:https://idaas.example.com/:sub-test',
        },
        result: { error: '429 Too many requests' },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(failedRun)
      })
      ;(buildAgentConfig as Mock).mockResolvedValueOnce({ engineType: 'cursor' })

      const res = await pollRequest('run_historical')

      const json = (await res.json()) as Json
      const result = (json.data as Json).result as { error: ErrorJson['error'] }
      expect(result.error.message).toContain('Codex')
      expect(result.error.details).toMatchObject({
        runId: 'run_historical',
        provider: 'codex',
      })
    })

    it('uses the same cursor fallback as sync invoke for runs without engine metadata', async () => {
      const failedRun = {
        id: 'run_legacy',
        status: 'failed',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        // No oauthEngineType (tests the cursor fallback) but a valid caller pin.
        executionMetadata: { oauthCallerId: 'oauth:https://idaas.example.com/:sub-test' },
        result: { error: '429 Too many requests' },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(failedRun)
      })
      ;(buildAgentConfig as Mock).mockResolvedValueOnce({})

      const res = await pollRequest('run_legacy')

      const json = (await res.json()) as Json
      const result = (json.data as Json).result as { error: ErrorJson['error'] }
      expect(result.error.message).toContain('Cursor')
      expect(result.error.details).toMatchObject({ runId: 'run_legacy', provider: 'cursor' })
    })

    it('returns 404 when a different OAuth caller polls a run they do not own', async () => {
      // Run pinned to another IdP user; validCaller is oauth:.../sub-test.
      const othersRun = {
        id: 'run_other',
        status: 'completed',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        executionMetadata: { oauthCallerId: 'oauth:https://idaas.example.com/:someone-else' },
        result: { output: 'secret reply for the other user', durationMs: 5 },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(othersRun)
      })

      const res = await pollRequest('run_other')

      // Fails closed as NOT_FOUND — never leaks the other user's result.
      expect(res.status).toBe(404)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.RUN_NOT_FOUND)
    })

    it('returns 404 for a non-OAuth-channel run of the same agent (P4 — no cross-channel read)', async () => {
      // A Feishu/api/A2A/scheduled run lacks oauthCallerId but is NOT an OAuth run;
      // it must never be readable via the OAuth channel, even by a valid IdP caller.
      const feishuRun = {
        id: 'run_feishu',
        status: 'completed',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'feishu',
        result: { output: 'feishu conversation content' },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(feishuRun)
      })

      const res = await pollRequest('run_feishu')

      expect(res.status).toBe(404)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.RUN_NOT_FOUND)
    })

    it('returns 404 for a pre-deploy OAuth run lacking oauthCallerId (P4 — legacy fails closed)', async () => {
      const legacyOAuthRun = {
        id: 'run_legacy_oauth',
        status: 'completed',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        // No oauthCallerId — a run created before the per-caller pin shipped.
        executionMetadata: { oauthEngineType: 'cursor' },
        result: { output: 'old reply' },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(legacyOAuthRun)
      })

      const res = await pollRequest('run_legacy_oauth')

      expect(res.status).toBe(404)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.RUN_NOT_FOUND)
    })

    it('lets the owning OAuth caller poll their own pinned run', async () => {
      const ownRun = {
        id: 'run_own',
        status: 'completed',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        executionMetadata: { oauthCallerId: 'oauth:https://idaas.example.com/:sub-test' },
        result: { output: 'my reply', durationMs: 7 },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(ownRun)
      })

      const res = await pollRequest('run_own')

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      expect(((json.data as Json).result as Json).output).toBe('my reply')
    })
  })

  // ── Cancel ─────────────────────────────────────────────────────────────

  describe('POST /:agentId/runs/:runId/cancel', () => {
    function cancelRequest(runId: string) {
      return app.request(`/api/oauth/agt_oauth1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    }

    it('cancels a queued run and returns 200', async () => {
      const queuedRun = {
        id: 'run_q1',
        status: 'queued',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        executionMetadata: { oauthCallerId: 'oauth:https://idaas.example.com/:sub-test' },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(queuedRun)
      })

      const res = await cancelRequest('run_q1')

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      expect((json.data as Json).status).toBe('cancelled')
      expect(scheduleNext).toHaveBeenCalled()
    })

    it('cancelling a running run uses all task-id prefixes globally', async () => {
      const runningRun = {
        id: 'run_r1',
        status: 'running',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        executionMetadata: { oauthCallerId: 'oauth:https://idaas.example.com/:sub-test' },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const latestStep = { id: 'rst_step1', runId: 'run_r1', order: 1 }

      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        if (selectCount === 2) return makeDbChain(runningRun)
        return makeDbChain(latestStep)
      })

      const res = await cancelRequest('run_r1')

      expect(res.status).toBe(200)
      const cancelledIds = (engineRegistry.cancel as Mock).mock.calls.map(
        (call: unknown[]) => call[0] as string,
      )
      expect(cancelledIds).toContain('invoke/run_r1/rst_step1')
      expect(cancelledIds).toContain('chat/run_r1/rst_step1')
      expect(engineRegistry.get).not.toHaveBeenCalled()
    })

    it('returns 400 with RUN_NOT_CANCELLABLE for a completed run', async () => {
      const completedRun = {
        id: 'run_done',
        status: 'completed',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        executionMetadata: { oauthCallerId: 'oauth:https://idaas.example.com/:sub-test' },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(completedRun)
      })

      const res = await cancelRequest('run_done')

      expect(res.status).toBe(400)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.RUN_NOT_CANCELLABLE)
    })

    it('returns 404 when a different OAuth caller tries to cancel a run they do not own', async () => {
      const othersQueuedRun = {
        id: 'run_q_other',
        status: 'queued',
        initiatorAgentId: 'agt_oauth1',
        triggerSource: 'oauth',
        executionMetadata: { oauthCallerId: 'oauth:https://idaas.example.com/:someone-else' },
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      let selectCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCount++
        if (selectCount === 1) return makeDbChain(oauthAgent)
        return makeDbChain(othersQueuedRun)
      })

      const res = await cancelRequest('run_q_other')

      // Fails closed before any cancellation side effect runs.
      expect(res.status).toBe(404)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.RUN_NOT_FOUND)
      expect(scheduleNext).not.toHaveBeenCalled()
    })
  })
})
