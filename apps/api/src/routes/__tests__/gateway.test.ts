import { GatewayErrorCode } from '@a2wave/shared'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

type Json = Record<string, unknown>
type ErrorJson = { error: { code: string; message: string; details?: unknown } }

vi.mock('../../db/client.js', () => {
  const database = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi
      .fn()
      .mockReturnValue({ where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }),
    transaction: vi.fn(),
  }
  database.transaction.mockImplementation((fn: (tx: typeof database) => unknown) => fn(database))
  return { db: database }
})

vi.mock('../../middleware/gateway-auth.js', () => ({
  validateGatewayAuth: vi.fn(),
  normalizeAuthType: (v: string | null | undefined) =>
    v === 'none' || v === 'oauth' ? v : 'api_key',
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
  // buildAgentConfig is ASYNC in production, so this stand-in must resolve
  // rather than return. A sync mock silently changes the failure mode of the
  // route's try/catch: a sync throw is caught, whereas the real rejection is
  // not unless the call is awaited inside the try. That drift is exactly how a
  // green `expect(424)` ended up guarding behaviour production no longer had.
  buildAgentConfig: vi.fn().mockResolvedValue({ engineType: 'cursor' }),
}))

vi.mock('../../lib/git-workspace.js', () => ({
  WorktreeBranchLockedError: class extends Error {
    constructor(b: string, l: string) {
      super(`locked: ${b} by ${l}`)
      this.name = 'WorktreeBranchLockedError'
    }
  },
}))

vi.mock('../../engine/index.js', () => ({
  engineRegistry: {
    get: vi.fn().mockReturnValue({}),
    cancel: vi.fn().mockResolvedValue(false),
  },
}))

vi.mock('../../engine/execution-lease-registry.js', () => ({
  bindExecutionLeaseTask: vi.fn().mockReturnValue({
    signal: new AbortController().signal,
    finish: vi.fn(),
  }),
  cancelExecutionLease: vi.fn().mockResolvedValue(undefined),
  completeExecutionLease: vi.fn(),
  getExecutionAbortSignal: vi.fn(),
  hasExecutionLease: vi.fn().mockReturnValue(false),
}))

vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: vi.fn().mockReturnValue('acquired'),
  scheduleNext: vi.fn(),
}))

vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {},
}))

vi.mock('@a2wave/shared', async () => {
  const actual = await vi.importActual<typeof import('@a2wave/shared')>('@a2wave/shared')
  return {
    ...actual,
  }
})

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
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

function makeDbChain(result: unknown) {
  const terminal = {
    get: vi.fn().mockReturnValue(result),
    all: vi.fn().mockReturnValue(result ? [result] : []),
    limit: vi.fn().mockReturnValue(
      asyncQuery({
        get: vi.fn().mockReturnValue(result),
      }),
    ),
    orderBy: vi.fn().mockReturnValue(
      asyncQuery({
        limit: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(result),
          }),
        ),
        get: vi.fn().mockReturnValue(result),
      }),
    ),
  }
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(terminal),
    }),
  }
}

function makeInsertChain() {
  return {
    values: vi.fn().mockReturnValue(
      asyncQuery({
        run: vi.fn(),
      }),
    ),
  }
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        asyncQuery({
          run: vi.fn().mockReturnValue({ changes: 1 }),
        }),
      ),
    }),
  }
}

import { db } from '../../db/client.js'
import { engineRegistry } from '../../engine/index.js'
import { scheduleNext, tryAcquireSlot } from '../../engine/task-queue.js'
import { buildAgentConfig, resolveWorkDir, WorktreeOccupiedError } from '../../lib/agent-helpers.js'
import { ProviderConfigurationError } from '../../lib/errors.js'
import { WorktreeBranchLockedError } from '../../lib/git-workspace.js'
import { validateGatewayAuth } from '../../middleware/gateway-auth.js'
import { executeInWorker } from '../../worker/index.js'

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

const publishedAgent = {
  id: 'agt_test1',
  name: 'Test Agent',
  description: 'A test agent',
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
  maxConcurrency: 1,
}

describe('Gateway routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    ;(validateGatewayAuth as Mock).mockResolvedValue({})
    ;(db.insert as Mock).mockReturnValue(makeInsertChain())
    ;(db.update as Mock).mockReturnValue(makeUpdateChain())
    // tryAcquireSlot is a per-test knob; reset to default 'acquired' so a queued
    // override in one test doesn't bleed into the next (vi.clearAllMocks does
    // not reset .mockReturnValue implementations).
    ;(tryAcquireSlot as Mock).mockReturnValue('acquired')
    ;(buildAgentConfig as Mock).mockResolvedValue({ engineType: 'cursor' })

    const mod = await import('../gateway.js')
    app = new Hono()
    app.route('/api/gateway', mod.default)
  })

  function invokeRequest(
    body: Record<string, unknown>,
    headers?: Record<string, string>,
    remoteAddress?: string,
  ) {
    return app.request(
      '/api/gateway/agt_test1/invoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined,
    )
  }

  describe('POST /:agentId/invoke — reserved worktree namespace', () => {
    it("rejects an explicit worktree using the reserved 'agent-' prefix (400)", async () => {
      // Without this gate a caller could address an Agent's long-lived
      // workspace and hand its branch to run-end removal.
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))

      const res = await invokeRequest({
        message: 'hi',
        worktree: { name: 'agent-abc123def456ghi7', cleanup: 'ephemeral' },
      })

      expect(res.status).toBe(400)
      const json = (await res.json()) as Json
      expect(JSON.stringify(json.error)).toContain('agent-')
      expect(executeInWorker as Mock).not.toHaveBeenCalled()
    })
  })

  describe('POST /:agentId/invoke — sync mode', () => {
    it('returns durationMs in sync response', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(executeInWorker as Mock).mockResolvedValue({
        success: true,
        output: 'Hello!',
        chatId: 'chat_1',
        durationMs: 1234,
      })

      const res = await invokeRequest({ message: 'hi', stream: false, async: false })

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      const data = json.data as Json
      expect(data.reply).toBe('Hello!')
      expect(data.runId).toBeDefined()
      expect(typeof data.durationMs).toBe('number')
    })

    it('returns ENGINE_NOT_FOUND when engine type is unknown', async () => {
      const { engineRegistry } = await import('../../engine/index.js')
      ;(engineRegistry.get as Mock).mockReturnValueOnce(undefined)
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))

      const res = await invokeRequest({ message: 'hi', async: false })

      expect(res.status).toBe(400)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.ENGINE_NOT_FOUND)
    })

    it('returns EXECUTION_ERROR when execution fails', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(executeInWorker as Mock).mockResolvedValue({
        success: false,
        output: '',
        error: 'Model timeout',
      })

      const res = await invokeRequest({ message: 'hi', async: false })

      expect(res.status).toBe(500)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.EXECUTION_ERROR)
      expect(json.error.message).toBe('Model timeout')
    })

    it('returns EXECUTION_ERROR when execution throws', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(executeInWorker as Mock).mockRejectedValue(new Error('Worker crashed'))

      const res = await invokeRequest({ message: 'hi', async: false })

      expect(res.status).toBe(500)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.EXECUTION_ERROR)
      expect(json.error.message).toBe('Execution failed. Check server logs for details.')
    })

    it('reclaims the run and advances the queue when turn persistence fails', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(db.insert as Mock)
        .mockReturnValueOnce(makeInsertChain())
        .mockReturnValueOnce(makeInsertChain())
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue(
            asyncQuery({
              run: vi.fn(() => {
                throw new Error('message insert failed')
              }),
            }),
          ),
        })

      const res = await invokeRequest({ message: 'hi', async: false })

      expect(res.status).toBe(500)
      expect(db.delete).toHaveBeenCalled()
      expect(scheduleNext).toHaveBeenCalled()
      expect(executeInWorker).not.toHaveBeenCalled()
    })
  })

  describe('POST /:agentId/invoke — async mode', () => {
    it('attributes an unsupported Provider kind to Agent configuration', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      // REJECTS, matching production. buildAgentConfig is async, so the route's
      // catch only sees this if the call is awaited inside the try; an
      // unawaited call lets ProviderConfigurationError escape to Hono as a bare
      // 500 instead of the documented 424.
      ;(buildAgentConfig as Mock).mockRejectedValueOnce(
        new ProviderConfigurationError('prv_legacy', 'legacy:prv_legacy'),
      )

      const res = await invokeRequest({ message: 'do work', async: true })

      expect(res.status).toBe(424)
      const json = (await res.json()) as ErrorJson
      expect(json.error).toMatchObject({
        code: GatewayErrorCode.AGENT_CONFIGURATION_ERROR,
        details: { providerId: 'prv_legacy', providerKind: 'legacy:prv_legacy' },
      })
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('handles async execution errors gracefully', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(executeInWorker as Mock).mockRejectedValue(new Error('Worker crashed'))

      // Should not throw unhandled rejection, should return 202 immediately
      const res = await invokeRequest({ message: 'do work', async: true })
      expect(res.status).toBe(202)
      expect(executeInWorker).toHaveBeenCalled()
    })

    it('returns 202 with runId when async=true', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(executeInWorker as Mock).mockResolvedValue({
        success: true,
        output: 'Done',
        durationMs: 500,
      })

      const res = await invokeRequest({ message: 'do work', async: true })

      expect(res.status).toBe(202)
      const json = (await res.json()) as Json
      const data = json.data as Json
      expect(data.runId).toBeDefined()
      expect(data.reply).toBeUndefined()
    })

    it('fires executeInWorker without awaiting in async mode', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      let resolveExecution: (v: unknown) => void
      const executionPromise = new Promise((resolve) => {
        resolveExecution = resolve
      })
      ;(executeInWorker as Mock).mockReturnValue(executionPromise)

      const res = await invokeRequest({ message: 'do work', async: true })

      expect(res.status).toBe(202)
      expect(executeInWorker).toHaveBeenCalled()

      resolveExecution!({
        success: true,
        output: 'Done',
        durationMs: 500,
      })
    })

    it('returns 400 with INVALID_REQUEST for invalid body', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))

      const res = await invokeRequest({ async: true })

      expect(res.status).toBe(400)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.INVALID_REQUEST)
      expect(json.error.details).toBeDefined()
    })

    it('当 tryAcquireSlot 返回 queued 时返回 202 且 status 为 queued', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(tryAcquireSlot as Mock).mockReturnValueOnce('queued')

      const res = await invokeRequest({ message: 'do work', async: true })

      expect(res.status).toBe(202)
      const json = (await res.json()) as Json
      const data = json.data as Json
      expect(data.runId).toBeDefined()
      expect(data.status).toBe('queued')
      // 不应该调用 executeInWorker（任务尚未执行）
      expect(executeInWorker).not.toHaveBeenCalled()
    })

    it('X-Idempotency-Key：命中已存在的 completed run 时返回缓存结果', async () => {
      // First db.select → agent (published). Second db.select → existing run.
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(publishedAgent))
        .mockReturnValueOnce(
          makeDbChain({ id: 'run_existing', status: 'completed', result: { output: 'prev' } }),
        )

      const res = await invokeRequest(
        { message: 'do work', async: true },
        { 'x-idempotency-key': 'key-abc' },
      )

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      const data = json.data as Json
      expect(data.runId).toBe('run_existing')
      expect(data.status).toBe('completed')
      expect(data.result).toEqual({ output: 'prev' })
      expect(data.dedup).toBe(true)
      // Short-circuit: no new INSERT, no slot acquisition, no execution.
      expect(db.insert).not.toHaveBeenCalled()
      expect(tryAcquireSlot).not.toHaveBeenCalled()
      expect(executeInWorker).not.toHaveBeenCalled()
    })

    it('X-Idempotency-Key：无匹配的已有 run 时正常新建并把 key 写入 triggerSessionId', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(publishedAgent)) // agent lookup
        .mockReturnValueOnce(makeDbChain(undefined)) // no existing run

      const res = await invokeRequest({ message: 'fresh' }, { 'x-idempotency-key': 'key-new' })

      expect(res.status).toBe(202)
      const insertCall = (db.insert as Mock).mock.results[0].value.values.mock.calls[0][0]
      expect(insertCall.triggerSessionId).toBe('key-new')
      expect(insertCall.triggerSource).toBe('api')
    })

    it('X-Idempotency-Key：并发插入撞唯一索引时回读已有 run', async () => {
      const constraint = new Error(
        'UNIQUE constraint failed: runs.initiator_agent_id, runs.trigger_source, runs.trigger_session_id',
      )
      const insertRun = vi.fn(() => {
        throw constraint
      })
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(publishedAgent))
        .mockReturnValueOnce(makeDbChain(undefined))
        .mockReturnValueOnce(makeDbChain({ id: 'run_raced', status: 'running', result: null }))
      ;(db.insert as Mock).mockReturnValueOnce({
        values: vi.fn().mockReturnValue(asyncQuery({ run: insertRun })),
      })

      const res = await invokeRequest({ message: 'race' }, { 'x-idempotency-key': 'key-race' })

      expect(res.status).toBe(202)
      const json = (await res.json()) as Json
      expect(json.data).toMatchObject({ runId: 'run_raced', status: 'running', dedup: true })
      expect(tryAcquireSlot).not.toHaveBeenCalled()
    })

    it('当 tryAcquireSlot 返回 queue_full 时返回 429', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(tryAcquireSlot as Mock).mockReturnValueOnce('queue_full')

      const res = await invokeRequest({ message: 'do work', async: true })

      expect(res.status).toBe(429)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.EXECUTION_ERROR)
      // 不应该调用 executeInWorker
      expect(executeInWorker).not.toHaveBeenCalled()
      // 应该删除已创建的 run
      expect(db.delete).toHaveBeenCalled()
    })

    it('returns 404 with AGENT_NOT_FOUND when agent not found', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await invokeRequest({ message: 'hi', async: true })

      expect(res.status).toBe(404)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_FOUND)
      expect(json.error.message).toBe('Agent not found')
    })

    it('returns 403 with AGENT_NOT_PUBLISHED when agent is not published', async () => {
      const draftAgent = { ...publishedAgent, publishStatus: 'draft' }
      ;(db.select as Mock).mockReturnValue(makeDbChain(draftAgent))

      const res = await invokeRequest({ message: 'hi', async: true })

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_PUBLISHED)
      expect(json.error.message).toBe('Agent is not published')
    })

    it('returns AUTH_FAILED when authorization header is missing', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        error: { error: 'Missing Authorization header', status: 401 },
      })

      const res = await invokeRequest({ message: 'hi', async: true })

      expect(res.status).toBe(401)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AUTH_FAILED)
      expect(json.error.message).toBe('Missing Authorization header')
    })

    it('returns IP_NOT_ALLOWED when IP is blocked', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        error: { error: 'IP not allowed', status: 403 },
      })

      const res = await invokeRequest({ message: 'hi', async: true })

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.IP_NOT_ALLOWED)
      expect(json.error.message).toBe('IP not allowed')
    })

    it('uses the TCP peer for the IP whitelist when an untrusted caller spoofs X-Forwarded-For', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))

      const res = await invokeRequest(
        { message: 'hi', async: true },
        { 'X-Forwarded-For': '203.0.113.99' },
        '198.51.100.40',
      )

      expect(res.status).toBe(202)
      expect(validateGatewayAuth).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ clientIp: '198.51.100.40' }),
      )
    })

    it('persists external IdP user identity into runSteps.input.context.channel when oauth caller is present', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        caller: {
          kind: 'idaas_user',
          userInfo: {
            sub: 'sub-eve',
            issuer: 'https://idp.example.com/',
            userId: 'eve-uuid',
            email: 'eve@example.com',
            username: 'eve',
            tenantId: 't-1',
            mobile: '13800000000',
            unionId: 'u-1',
            raw: {},
          },
        },
      })
      ;(executeInWorker as Mock).mockResolvedValue({ success: true, output: 'ok', durationMs: 1 })

      // Capture every db.insert(...).values(arg) call
      const insertedValues: unknown[] = []
      ;(db.insert as Mock).mockImplementation(() => ({
        values: vi.fn().mockImplementation((v: unknown) => {
          insertedValues.push(v)
          return { run: vi.fn() }
        }),
      }))

      // Use sync mode (async: false) so the request fully awaits executeInWorker.
      // Async fire-and-forget would race the assertion against the microtask queue.
      const res = await invokeRequest({ message: 'do work', async: false })
      expect(res.status).toBe(200)

      // Find the runSteps insert (id starts with 'rst_')
      const stepInsert = insertedValues.find(
        (v): v is { id: string; input: { context: { channel: unknown } } } =>
          typeof v === 'object' &&
          v !== null &&
          'id' in v &&
          typeof (v as { id: string }).id === 'string' &&
          (v as { id: string }).id.startsWith('rst_'),
      )
      expect(stepInsert, 'expected a runSteps insert').toBeDefined()
      const channel = stepInsert!.input.context.channel as {
        channel_type: string
        channel_info: {
          auth: string
          oauth: { issuer: string; sub: string; tenant_id?: string; union_id?: string }
        }
        user_info: {
          email: string
          name?: string
          mobile?: string
          source: string
          source_id?: string
        }
      }
      expect(channel.channel_type).toBe('api')
      expect(channel.channel_info.auth).toBe('oauth')
      expect(channel.channel_info.oauth).toMatchObject({
        issuer: 'https://idp.example.com/',
        sub: 'sub-eve',
        tenant_id: 't-1',
        union_id: 'u-1',
      })
      expect(channel.user_info).toMatchObject({
        email: 'eve@example.com',
        name: 'eve',
        mobile: '13800000000',
        source: 'idaas',
        source_id: 'sub-eve',
      })

      // Critical: channel must also reach the executor via payload.context — not
      // just live in the audit log. Otherwise the agent code can't act on identity.
      expect(executeInWorker).toHaveBeenCalled()
      // Signature is executeInWorker(taskId, payload, options) — payload is arg index 1.
      const payload = (executeInWorker as Mock).mock.calls[0][1] as {
        context?: Record<string, unknown>
      }
      const payloadChannel = payload.context?.channel as
        | { user_info: { email: string } }
        | undefined
      expect(payloadChannel).toBeDefined()
      expect(payloadChannel!.user_info.email).toBe('eve@example.com')
    })

    it('forwards oauth caller to pending-context registry when run is queued', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        caller: {
          kind: 'idaas_user',
          userInfo: {
            sub: 'sub-q',
            issuer: 'https://idp.example.com/',
            userId: 'queued-user',
            email: 'q@example.com',
            raw: {},
          },
        },
      })
      ;(tryAcquireSlot as Mock).mockReturnValue('queued')

      // Spy on registry to see what was registered
      const registry = await import('../../lib/pending-job-registry.js')
      const registerSpy = vi.spyOn(registry, 'registerPendingContext')

      const res = await invokeRequest({ message: 'hi', async: true })
      expect(res.status).toBe(202)
      const json = (await res.json()) as Json
      expect((json.data as Json).status).toBe('queued')

      expect(registerSpy).toHaveBeenCalledTimes(1)
      const [runId, ctx] = registerSpy.mock.calls[0]
      expect(runId).toMatch(/^run_/)
      const ch = (
        ctx as {
          channel: {
            user_info: { email: string; source_id: string }
            channel_info: { oauth: { sub: string } }
          }
        }
      ).channel
      expect(ch.user_info.email).toBe('q@example.com')
      expect(ch.channel_info.oauth.sub).toBe('sub-q')

      registerSpy.mockRestore()
    })

    it('registers a queued channel even with no oauth caller (channel always built; user_info is null)', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({})
      ;(tryAcquireSlot as Mock).mockReturnValue('queued')

      const registry = await import('../../lib/pending-job-registry.js')
      const registerSpy = vi.spyOn(registry, 'registerPendingContext')

      const res = await invokeRequest({ message: 'hi', async: true })
      expect(res.status).toBe(202)
      expect(registerSpy).toHaveBeenCalledTimes(1)
      const [, ctx] = registerSpy.mock.calls[0]
      const channel = (ctx as { channel: { channel_type: string; user_info: unknown } }).channel
      expect(channel.channel_type).toBe('api')
      expect(channel.user_info).toBeNull()
      registerSpy.mockRestore()
    })

    it('writes a channel even when no oauth caller is present (auth=none/api_key path)', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({}) // no caller
      ;(executeInWorker as Mock).mockResolvedValue({ success: true, output: 'ok', durationMs: 1 })

      const insertedValues: unknown[] = []
      ;(db.insert as Mock).mockImplementation(() => ({
        values: vi.fn().mockImplementation((v: unknown) => {
          insertedValues.push(v)
          return { run: vi.fn() }
        }),
      }))

      const res = await invokeRequest({ message: 'do work', async: true })
      expect(res.status).toBe(202)
      const stepInsert = insertedValues.find(
        (v): v is { id: string; input: { context: Record<string, unknown> } } =>
          typeof v === 'object' &&
          v !== null &&
          'id' in v &&
          typeof (v as { id: string }).id === 'string' &&
          (v as { id: string }).id.startsWith('rst_'),
      )
      expect(stepInsert).toBeDefined()
      const channel = stepInsert!.input.context.channel as {
        channel_type: string
        channel_info: { auth: string }
        user_info: unknown
      }
      expect(channel.channel_type).toBe('api')
      // No oauth caller → user_info is null but channel still records auth method
      expect(channel.user_info).toBeNull()
      expect(['none', 'api_key']).toContain(channel.channel_info.auth)
    })

    it('strips client-injected caller/channel/receive_id keys before spreading into context', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      // No OAuth caller — api_key / none path; server has no trusted caller to
      // install, so a naive spread would let the client forge `context.caller`.
      ;(validateGatewayAuth as Mock).mockResolvedValue({})
      ;(executeInWorker as Mock).mockResolvedValue({ success: true, output: 'ok', durationMs: 1 })

      const insertedValues: unknown[] = []
      ;(db.insert as Mock).mockImplementation(() => ({
        values: vi.fn().mockImplementation((v: unknown) => {
          insertedValues.push(v)
          return { run: vi.fn() }
        }),
      }))

      const res = await invokeRequest({
        message: 'pwn',
        async: false,
        context: {
          safe: 'ok',
          caller: { idaasUser: { sub: 'admin', email: 'attacker@evil.test' } },
          channel: { channel_type: 'forged', user_info: { email: 'forged@evil.test' } },
          // Feishu DM-injection vector: a hostile gateway caller must not be able to
          // direct the agent's bot reply-by-context to an arbitrary target.
          // finishRun* read these from runSteps.input.context to reply-by-context.
          receive_id_type: 'open_id',
          receive_id: 'ou_arbitrary_target',
        },
      })
      expect(res.status).toBe(200)

      const stepInsert = insertedValues.find(
        (v): v is { id: string; input: { context: Record<string, unknown> } } =>
          typeof v === 'object' &&
          v !== null &&
          'id' in v &&
          typeof (v as { id: string }).id === 'string' &&
          (v as { id: string }).id.startsWith('rst_'),
      )
      expect(stepInsert, 'expected a runSteps insert').toBeDefined()
      const ctx = stepInsert!.input.context
      // Client-supplied safe field survives.
      expect(ctx.safe).toBe('ok')
      // Client-supplied `caller` must NOT be persisted — downstream readers
      // (audit, gateway-auth) treat context.caller as server-set and trusted.
      expect(ctx.caller).toBeUndefined()
      // Client-supplied receive_id* must NOT be persisted — finishRun* reply-by-context
      // would otherwise DM the agent's bot output to this attacker-chosen target.
      expect(ctx.receive_id_type).toBeUndefined()
      expect(ctx.receive_id).toBeUndefined()
      // Client-supplied `channel` must be overwritten by the server-built one.
      const channel = ctx.channel as { channel_type: string; user_info: unknown }
      expect(channel.channel_type).toBe('api')
      expect(channel.user_info).toBeNull()

      // Same guard must apply on the executor payload.
      const payload = (executeInWorker as Mock).mock.calls[0][1] as {
        context?: Record<string, unknown>
      }
      expect(payload.context?.caller).toBeUndefined()
      expect(payload.context?.receive_id_type).toBeUndefined()
      expect(payload.context?.receive_id).toBeUndefined()
      expect((payload.context?.channel as { channel_type: string }).channel_type).toBe('api')
    })
  })

  describe('POST /:agentId/invoke — worktree 409', () => {
    beforeEach(() => {
      ;(resolveWorkDir as Mock).mockResolvedValue('/tmp/work')
    })

    it('returns 409 and deletes run when resolveWorkDir throws WorktreeOccupiedError', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(resolveWorkDir as Mock).mockRejectedValueOnce(new WorktreeOccupiedError('/tmp/wt-a'))

      const res = await invokeRequest({
        message: 'hi',
        async: false,
        worktree: { name: 'wt-a', cleanup: 'ephemeral' },
      })
      expect(res.status).toBe(409)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.EXECUTION_ERROR)
      expect(json.error.message).toContain('occupied')

      expect(db.delete).toHaveBeenCalled()
      expect(scheduleNext).toHaveBeenCalled()
      expect(executeInWorker).not.toHaveBeenCalled()
    })

    it('returns 409 on WorktreeBranchLockedError and triggers scheduleNext', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(resolveWorkDir as Mock).mockRejectedValueOnce(
        new WorktreeBranchLockedError('feature-x', 'owner-run'),
      )

      const res = await invokeRequest({
        message: 'hi',
        async: false,
        worktree: { name: 'wt-locked', cleanup: 'persistent' },
      })
      expect(res.status).toBe(409)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.EXECUTION_ERROR)
      expect(json.error.message).toContain('locked')

      expect(db.delete).toHaveBeenCalled()
      expect(scheduleNext).toHaveBeenCalled()
      expect(executeInWorker).not.toHaveBeenCalled()
    })

    it('rethrows non-worktree errors (not captured as 409)', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(resolveWorkDir as Mock).mockRejectedValueOnce(new Error('disk exploded'))

      const res = await invokeRequest({
        message: 'hi',
        async: false,
        worktree: { name: 'wt-a', cleanup: 'ephemeral' },
      })
      expect(res.status).not.toBe(409)
    })

    it('reclaims the run row on an untyped resolveWorkDir failure', async () => {
      // The run already counts against maxConcurrency. Leaving it behind on the
      // rethrow path pins the Agent at its concurrency limit permanently —
      // recoverable only by editing the database.
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(resolveWorkDir as Mock).mockRejectedValueOnce(new Error('workDir bookkeeping failed'))

      await invokeRequest({
        message: 'hi',
        async: false,
        worktree: { name: 'wt-a', cleanup: 'ephemeral' },
      })

      expect(db.delete).toHaveBeenCalled()
      expect(scheduleNext).toHaveBeenCalled()
      expect(executeInWorker).not.toHaveBeenCalled()
    })
  })

  describe('GET /:agentId/runs/:runId', () => {
    function runQuery(agentId: string, runId: string, headers?: Record<string, string>) {
      return app.request(`/api/gateway/${agentId}/runs/${runId}`, {
        method: 'GET',
        headers: { ...headers },
      })
    }

    it('returns run status and result for a completed run', async () => {
      const completedRun = {
        id: 'run_test1',
        status: 'completed',
        result: { output: 'Done', durationMs: 1234 },
        initiatorAgentId: 'agt_test1',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        return makeDbChain(completedRun)
      })

      const res = await runQuery('agt_test1', 'run_test1')

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      const data = json.data as Json
      expect(data.runId).toBe('run_test1')
      expect(data.status).toBe('completed')
      expect(data.result).toEqual({ output: 'Done', durationMs: 1234 })
    })

    it('returns run with status running (in-progress)', async () => {
      const runningRun = {
        id: 'run_test2',
        status: 'running',
        result: null,
        initiatorAgentId: 'agt_test1',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        return makeDbChain(runningRun)
      })

      const res = await runQuery('agt_test1', 'run_test2')

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      const data = json.data as Json
      expect(data.status).toBe('running')
      expect(data.result).toBeNull()
    })

    it('returns 404 with AGENT_NOT_FOUND when agent not found', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await runQuery('agt_missing', 'run_test1')

      expect(res.status).toBe(404)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_FOUND)
      expect(json.error.message).toBe('Agent not found')
    })

    it('returns 403 with AGENT_NOT_PUBLISHED when agent is not published', async () => {
      const draftAgent = { ...publishedAgent, publishStatus: 'draft' }
      ;(db.select as Mock).mockReturnValue(makeDbChain(draftAgent))

      const res = await runQuery('agt_test1', 'run_test1')

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_PUBLISHED)
      expect(json.error.message).toBe('Agent is not published')
    })

    it('returns AUTH_FAILED when token is invalid', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        error: { error: 'Invalid token', status: 403 },
      })

      const res = await runQuery('agt_test1', 'run_test1')

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AUTH_FAILED)
      expect(json.error.message).toBe('Invalid token')
    })

    it('returns 404 with RUN_NOT_FOUND when run not found', async () => {
      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        return makeDbChain(undefined)
      })

      const res = await runQuery('agt_test1', 'run_missing')

      expect(res.status).toBe(404)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.RUN_NOT_FOUND)
      expect(json.error.message).toBe('Run not found')
    })

    it('returns 403 with RUN_OWNERSHIP_MISMATCH when run belongs to a different agent', async () => {
      const otherAgentRun = {
        id: 'run_other',
        status: 'completed',
        result: { output: 'Done' },
        initiatorAgentId: 'agt_other',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        return makeDbChain(otherAgentRun)
      })

      const res = await runQuery('agt_test1', 'run_other')

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.RUN_OWNERSHIP_MISMATCH)
      expect(json.error.message).toBe('Run does not belong to this agent')
    })
  })

  describe('POST /:agentId/runs/:runId/cancel', () => {
    function cancelRequest(agentId: string, runId: string, headers?: Record<string, string>) {
      return app.request(`/api/gateway/${agentId}/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { ...headers },
      })
    }

    it('returns 404 with AGENT_NOT_FOUND when agent not found', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await cancelRequest('agt_missing', 'run_test1')

      expect(res.status).toBe(404)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_FOUND)
    })

    it('returns 403 with AGENT_NOT_PUBLISHED when agent is not published', async () => {
      const draftAgent = { ...publishedAgent, publishStatus: 'draft' }
      ;(db.select as Mock).mockReturnValue(makeDbChain(draftAgent))

      const res = await cancelRequest('agt_test1', 'run_test1')

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AGENT_NOT_PUBLISHED)
    })

    it('returns AUTH_FAILED when authorization fails', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(validateGatewayAuth as Mock).mockResolvedValue({
        error: { error: 'Missing Authorization header', status: 401 },
      })

      const res = await cancelRequest('agt_test1', 'run_test1')

      expect(res.status).toBe(401)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.AUTH_FAILED)
    })

    it('returns 404 with RUN_NOT_FOUND when run not found', async () => {
      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        return makeDbChain(undefined)
      })

      const res = await cancelRequest('agt_test1', 'run_missing')

      expect(res.status).toBe(404)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.RUN_NOT_FOUND)
    })

    it('returns 403 with RUN_OWNERSHIP_MISMATCH when run belongs to different agent', async () => {
      const otherAgentRun = {
        id: 'run_other',
        status: 'running',
        initiatorAgentId: 'agt_other',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        return makeDbChain(otherAgentRun)
      })

      const res = await cancelRequest('agt_test1', 'run_other')

      expect(res.status).toBe(403)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.RUN_OWNERSHIP_MISMATCH)
    })

    it('returns 400 with RUN_NOT_CANCELLABLE when run is completed', async () => {
      const completedRun = {
        id: 'run_done',
        status: 'completed',
        result: { output: 'Done' },
        initiatorAgentId: 'agt_test1',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        return makeDbChain(completedRun)
      })

      const res = await cancelRequest('agt_test1', 'run_done')

      expect(res.status).toBe(400)
      const json = (await res.json()) as ErrorJson
      expect(json.error.code).toBe(GatewayErrorCode.RUN_NOT_CANCELLABLE)
    })

    it('returns 200 and cancels a running run', async () => {
      const runningRun = {
        id: 'run_running',
        status: 'running',
        initiatorAgentId: 'agt_test1',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }
      const latestStep = { id: 'rst_step1', runId: 'run_running', order: 1 }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        if (selectCallCount === 2) return makeDbChain(runningRun)
        return makeDbChain(latestStep)
      })

      const res = await cancelRequest('agt_test1', 'run_running')

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      const data = json.data as Json
      expect(data.runId).toBe('run_running')
      expect(data.status).toBe('cancelled')
      expect(db.update).toHaveBeenCalled()
      expect(engineRegistry.cancel).toHaveBeenCalledWith('invoke/run_running/rst_step1')
    })

    it('returns 200 and cancels a queued run', async () => {
      const queuedRun = {
        id: 'run_queued',
        status: 'queued',
        initiatorAgentId: 'agt_test1',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        return makeDbChain(queuedRun)
      })

      const res = await cancelRequest('agt_test1', 'run_queued')

      expect(res.status).toBe(200)
      const json = (await res.json()) as Json
      const data = json.data as Json
      expect(data.runId).toBe('run_queued')
      expect(data.status).toBe('cancelled')
    })

    it('cancelling a queued run also clears any pending oauth-caller context (no in-process leak)', async () => {
      const queuedRun = {
        id: 'run_to_cancel',
        status: 'queued',
        initiatorAgentId: 'agt_test1',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        return makeDbChain(queuedRun)
      })

      const registry = await import('../../lib/pending-job-registry.js')
      registry.registerPendingContext('run_to_cancel', {
        caller: { type: 'client', idaasUser: { sub: 's' } },
      })
      // Pre-condition: context is registered
      const peekBefore = registry.takePendingContext('run_to_cancel')
      expect(peekBefore).toBeDefined()
      // Re-register because takePendingContext is destructive
      registry.registerPendingContext('run_to_cancel', {
        caller: { type: 'client', idaasUser: { sub: 's' } },
      })

      const takeSpy = vi.spyOn(registry, 'takePendingContext')
      const res = await cancelRequest('agt_test1', 'run_to_cancel')
      expect(res.status).toBe(200)

      // The cancel handler must have called takePendingContext('run_to_cancel')
      expect(takeSpy).toHaveBeenCalledWith('run_to_cancel')
      // And the registry entry is gone
      expect(registry.takePendingContext('run_to_cancel')).toBeUndefined()

      takeSpy.mockRestore()
    })

    it('advances the queue immediately after cancelling a queued run', async () => {
      const queuedRun = {
        id: 'run_queued',
        status: 'queued',
        initiatorAgentId: 'agt_test1',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        return makeDbChain(queuedRun)
      })

      await cancelRequest('agt_test1', 'run_queued')

      expect(scheduleNext).toHaveBeenCalled()
    })

    it('advances the queue after a running process cancellation settles', async () => {
      const runningRun = {
        id: 'run_running',
        status: 'running',
        initiatorAgentId: 'agt_test1',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }
      const latestStep = { id: 'rst_step1', runId: 'run_running', order: 1 }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        if (selectCallCount === 2) return makeDbChain(runningRun)
        return makeDbChain(latestStep)
      })

      await cancelRequest('agt_test1', 'run_running')

      expect(scheduleNext).toHaveBeenCalledOnce()
    })

    it('cancels globally without resolving the configured engine', async () => {
      const runningRun = {
        id: 'run_running',
        status: 'running',
        initiatorAgentId: 'agt_test1',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      }
      const latestStep = { id: 'rst_step1', runId: 'run_running', order: 1 }

      let selectCallCount = 0
      ;(db.select as Mock).mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return makeDbChain(publishedAgent)
        if (selectCallCount === 2) return makeDbChain(runningRun)
        return makeDbChain(latestStep)
      })
      const res = await cancelRequest('agt_test1', 'run_running')

      expect(res.status).toBe(200)
      expect(buildAgentConfig).not.toHaveBeenCalled()
      expect(engineRegistry.get).not.toHaveBeenCalled()
      expect(engineRegistry.cancel).toHaveBeenCalledWith('chat/run_running/rst_step1')
    })
  })

  describe('POST /:agentId/invoke — stream mode', () => {
    it('returns SSE done event on successful stream execution', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(executeInWorker as Mock).mockResolvedValue({
        success: true,
        output: 'Stream result',
        chatId: 'chat_s1',
        durationMs: 500,
      })

      const res = await invokeRequest({ message: 'hi', stream: true, async: false })
      const text = await res.text()

      expect(text).toContain('event: done')
      expect(text).toContain('"reply":"Stream result"')
    })

    it('returns SSE error event when execution returns success=false', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(executeInWorker as Mock).mockResolvedValue({
        success: false,
        output: '',
        error: 'Model error',
        durationMs: 100,
      })

      const res = await invokeRequest({ message: 'hi', stream: true, async: false })
      const text = await res.text()

      expect(text).toContain('event: error')
      expect(text).toContain('Model error')
    })

    it('returns SSE error event when execution throws', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(executeInWorker as Mock).mockRejectedValue(new Error('Worker crashed'))

      const res = await invokeRequest({ message: 'hi', stream: true, async: false })
      const text = await res.text()

      expect(text).toContain('event: error')
    })

    it('forwards log entries as SSE log events', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(publishedAgent))
      ;(executeInWorker as Mock).mockImplementation(
        (
          _taskId: string,
          _payload: unknown,
          options?: { onLogEntry?: (entry: unknown) => void },
        ) => {
          options?.onLogEntry?.({ type: 'system', subtype: 'init', model: 'gpt-4', ts: Date.now() })
          return Promise.resolve({ success: true, output: 'ok', durationMs: 100 })
        },
      )

      const res = await invokeRequest({ message: 'hi', stream: true, async: false })
      const text = await res.text()

      expect(text).toContain('event: log')
      expect(text).toContain('"type":"system"')
    })
  })
})
