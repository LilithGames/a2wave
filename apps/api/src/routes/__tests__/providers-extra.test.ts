/**
 * Fills the gap in providers.test.ts: GET /login-status/:engineType plus the
 * seedPresetProviders helper.
 */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
const dbInsertRun = vi.fn()
const dbUpdateRun = vi.fn()
const insertChain = { values: vi.fn().mockReturnThis(), run: dbInsertRun }
const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  run: dbUpdateRun,
}
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    insert: () => insertChain,
    update: () => updateChain,
  },
}))

vi.mock('../../db/schema.js', () => ({
  providers: { id: 'providers.id', kind: 'providers.kind', name: 'providers.name' },
  agents: {
    id: 'agents.id',
    name: 'agents.name',
    providerId: 'agents.providerId',
    config: 'agents.config',
  },
}))

const providerCatalogGetMock = vi.fn()
vi.mock('../../engine/index.js', () => ({
  providerCatalog: {
    get: (kind: string) => providerCatalogGetMock(kind),
    toProviderDto: (provider: unknown) => provider,
  },
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn((p?: string) => `${p}_test`),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../middleware/auth-middleware.js', () => ({
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

const presetProvidersMock = vi.hoisted(() => ({
  PRESET_PROVIDERS: [
    {
      kind: 'cursor',
      name: 'OpenAI',
      description: 'd',
      initScript: 'init',
      checkScript: 'check',
      skillsDir: null,
      mcpConfigPath: '.cursor/mcp.json',
    },
    {
      kind: 'claude-code',
      name: 'Anthropic',
      description: 'd2',
      initScript: 'init2',
      checkScript: 'check2',
      mcpConfigPath: '.mcp.json',
    },
  ],
}))

vi.mock('@a2wave/shared', () => presetProvidersMock)

import providersApp, { seedPresetProviders } from '../providers.js'

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const k of [
    'from',
    'where',
    'limit',
    'orderBy',
    'offset',
    'groupBy',
    'having',
    'returning',
  ]) {
    c[k] = vi.fn((): unknown => __chain)
  }
  c.get = vi.fn()
  c.all = vi.fn()

  // Awaiting the chain yields what `.get()`/`.all()` was configured to return,
  // as an array — production code destructures `[row]` from `.limit(1)` now.
  // The original mock fns stay reachable, so existing assertions are unaffected.
  let __settled: Promise<unknown[]> | undefined
  const __rows = (): unknown[] => {
    // `get` before `all`: mocks often define both, with `all` a placeholder.
    const get = c.get as undefined | (() => unknown)
    if (get) {
      const row = get()
      if (row != null) return [row]
    }
    const all = c.all as undefined | (() => unknown)
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    if (get) return []
    const run = c.run as undefined | (() => unknown)
    if (run) {
      const res = run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 1
      return Array.from({ length: changes }, () => ({}))
    }
    return []
  }
  const __chain = Object.assign(
    {
      // Lazy: resolving eagerly would consume a queued `get` per intermediate
      // node while the chain is still being built.
      // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable — it stands in for drizzle's awaitable query builder.
      then: (f?: (v: unknown[]) => unknown, r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.then(f, r)
      },
      catch: (r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.catch(r)
      },
    },
    c,
  )
  for (const k of Object.keys(c)) {
    const fn = c[k] as unknown
    if (typeof fn === 'function' && !['get', 'all', 'run'].includes(k)) {
      ;(__chain as Record<string, unknown>)[k] = fn
    }
  }
  return __chain as unknown as typeof c
}

function queueSelects(...returns: Array<{ get?: unknown; all?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => {
    const cfg = returns[i++] ?? {}
    const c = makeChain()
    if ('get' in cfg) c.get.mockReturnValue(cfg.get)
    if ('all' in cfg) c.all.mockReturnValue(cfg.all)
    return c
  })
}

beforeEach(() => {
  dbSelect.mockReset()
  dbInsertRun.mockReset()
  dbUpdateRun.mockReset()
  insertChain.values.mockClear()
  updateChain.set.mockClear()
  updateChain.where.mockClear()
  providerCatalogGetMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /login-status/:engineType', () => {
  function buildApp() {
    return new Hono().route('/providers', providersApp)
  }

  it('returns 404 when the engine is unknown', async () => {
    providerCatalogGetMock.mockReturnValue(undefined)
    const res = await buildApp().request('/providers/login-status/unknown')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toContain('Unknown engine type')
  })

  it('returns 501 when the engine has no checkLoginStatus', async () => {
    providerCatalogGetMock.mockReturnValue({
      getEngine: () => ({ type: 'cursor' }),
    })
    const res = await buildApp().request('/providers/login-status/cursor')
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: string }).error).toMatch(/does not support login-status/)
  })

  it('returns the engine status on success', async () => {
    providerCatalogGetMock.mockReturnValue({
      getEngine: () => ({ checkLoginStatus: vi.fn() }),
      checkLoginStatus: async () => ({ installed: true, loggedIn: true }),
    })
    const res = await buildApp().request('/providers/login-status/cursor')
    expect(res.status).toBe(200)
    expect(
      ((await res.json()) as { data: { installed: boolean; loggedIn: boolean } }).data,
    ).toEqual({ installed: true, loggedIn: true })
  })

  it('returns a soft-failure body when checkLoginStatus throws', async () => {
    providerCatalogGetMock.mockReturnValue({
      getEngine: () => ({ checkLoginStatus: vi.fn() }),
      checkLoginStatus: async () => {
        throw new Error('cli missing')
      },
    })
    const res = await buildApp().request('/providers/login-status/cursor')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { installed: boolean; loggedIn: boolean; error: string; code: string }
    }
    // `code` is what separates "the probe itself broke" from the engine's own
    // verdict that the CLI is absent: both shapes carry installed:false, and
    // the config page must not report an internal failure as a missing CLI.
    expect(body.data).toEqual({
      installed: false,
      loggedIn: false,
      error: 'cli missing',
      code: 'PROBE_FAILED',
    })
  })
})

describe('seedPresetProviders', () => {
  it('inserts a row for each new preset', async () => {
    queueSelects({ get: undefined }, { get: undefined })
    await seedPresetProviders()
    expect(insertChain.values).toHaveBeenCalledTimes(2)
    const first = insertChain.values.mock.calls[0][0]
    expect(first).toMatchObject({ kind: 'cursor', name: 'OpenAI', isPreset: true })
    // Providers persist no model catalog: the list is probed from the CLI per
    // Agent credential, so seeding must not write one.
    expect(first).not.toHaveProperty('models')
    expect(first).not.toHaveProperty('enabledModels')
  })

  it('updates metadata only when the preset already exists', async () => {
    queueSelects(
      { get: { id: 'prv_1', name: 'OpenAI' } },
      { get: { id: 'prv_2', name: 'Anthropic' } },
    )
    await seedPresetProviders()
    expect(insertChain.values).not.toHaveBeenCalled()
    expect(updateChain.set).toHaveBeenCalledTimes(2)
    const updatePayload = updateChain.set.mock.calls[0][0]
    expect(updatePayload).not.toHaveProperty('name')
    expect(updatePayload).not.toHaveProperty('models')
    expect(updatePayload).not.toHaveProperty('enabledModels')
  })
})

describe('DELETE /providers/:id (preset cannot be deleted)', () => {
  it('returns 404 when missing', async () => {
    queueSelects({ get: undefined })
    const res = await new Hono()
      .route('/providers', providersApp)
      .request('/providers/prv_x', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('returns 403 because preset providers cannot be deleted', async () => {
    queueSelects({ get: { id: 'prv_1', isPreset: true } })
    const res = await new Hono()
      .route('/providers', providersApp)
      .request('/providers/prv_1', { method: 'DELETE' })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toMatch(/preset/i)
  })
})
