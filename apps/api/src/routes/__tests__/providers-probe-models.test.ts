/** Integration tests for POST /api/providers/probe-models. */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dnsLookupMock = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => dnsLookupMock(...args),
}))

vi.mock('../../env.js', () => ({
  env: {
    TRUSTED_IMPORT_HOSTS: '',
    TRUSTED_PROVIDER_HOSTS: 'trusted-provider.example.com',
  },
}))

const dbSelect = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: { select: (...args: unknown[]) => dbSelect(...args) },
}))

vi.mock('../../db/schema.js', () => ({
  providers: { id: 'providers.id', name: 'providers.name' },
  agents: { id: 'agents.id', providerId: 'agents.providerId' },
}))

const providerCatalogGetMock = vi.fn()
vi.mock('../../engine/index.js', () => ({
  providerCatalog: {
    get: (kind: string) => providerCatalogGetMock(kind),
    toProviderDto: (provider: unknown) => provider,
  },
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/id.js', () => ({ createId: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../middleware/auth-middleware.js', () => ({
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}))

// The route allows 20 probes per minute per user, and every test here shares the
// one 'anonymous' key. Left live, the limiter makes a test's verdict depend on
// how many tests happen to run before it — this file was already at 16 requests,
// so the next one added would have 429'd for a reason having nothing to do with
// what it asserts. Rate limiting has its own tests; here it is noise.
vi.mock('../../middleware/rate-limit.js', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

import providersApp from '../providers.js'

function buildApp() {
  return new Hono().route('/providers', providersApp)
}

async function postProbe(body: unknown) {
  return buildApp().request('/providers/probe-models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  providerCatalogGetMock.mockReset()
  dnsLookupMock.mockReset()
  dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /probe-models — generic request validation', () => {
  it('returns 400 on invalid JSON', async () => {
    const res = await buildApp().request('/providers/probe-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when both kind and legacy engineType are missing', async () => {
    expect((await postProbe({ authMode: 'apiKey' })).status).toBe(400)
  })

  it('returns 400 when kind conflicts with legacy engineType', async () => {
    const res = await postProbe({ kind: 'cursor', engineType: 'codex', authMode: 'apiKey' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid optional baseUrl', async () => {
    const res = await postProbe({
      kind: 'claude-code',
      authMode: 'apiKey',
      baseUrl: 'not-a-url',
    })
    expect(res.status).toBe(400)
  })

  it('rejects credentials that are not declared for the selected Provider mode', async () => {
    const probeModels = vi.fn()
    providerCatalogGetMock.mockReturnValue({
      manifest: { capabilities: { credentialFields: { apiKey: [{ field: 'apiKey' }] } } },
      probeModels,
    })

    const res = await postProbe({
      kind: 'cursor',
      authMode: 'apiKey',
      apiKey: 'cursor-key',
      baseUrl: 'https://unexpected.example.com',
    })

    expect(res.status).toBe(400)
    expect(probeModels).not.toHaveBeenCalled()
  })

  it('blocks private Provider base URLs before dispatch', async () => {
    const probeModels = vi.fn()
    providerCatalogGetMock.mockReturnValue({
      manifest: {
        capabilities: {
          credentialFields: {
            apiKey: [{ field: 'apiKey' }, { field: 'baseUrl' }],
          },
        },
      },
      probeModels,
    })

    const res = await postProbe({
      kind: 'claude-code',
      authMode: 'apiKey',
      apiKey: 'sk-test',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
    })

    expect(res.status).toBe(400)
    expect(probeModels).not.toHaveBeenCalled()
  })

  it('blocks Provider base URL hostnames that resolve to a private address', async () => {
    const probeModels = vi.fn().mockResolvedValue({ models: ['should-not-run'] })
    providerCatalogGetMock.mockReturnValue({
      manifest: {
        capabilities: {
          credentialFields: {
            apiKey: [{ field: 'apiKey' }, { field: 'baseUrl' }],
          },
        },
      },
      probeModels,
    })
    dnsLookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])

    const res = await postProbe({
      kind: 'claude-code',
      authMode: 'apiKey',
      apiKey: 'sk-test',
      baseUrl: 'https://provider-proxy.example.com',
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      data: {
        code: 'invalid_input',
        error: expect.stringMatching(/private or reserved.*TRUSTED_PROVIDER_HOSTS/),
      },
    })
    expect(probeModels).not.toHaveBeenCalled()
  })

  it('allows a configured trusted Provider hostname that resolves to a private address', async () => {
    const probeModels = vi.fn().mockResolvedValue({ models: ['private-model'] })
    providerCatalogGetMock.mockReturnValue({
      manifest: {
        capabilities: {
          credentialFields: {
            apiKey: [{ field: 'apiKey' }, { field: 'baseUrl' }],
          },
        },
      },
      probeModels,
    })
    dnsLookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])

    const res = await postProbe({
      kind: 'claude-code',
      authMode: 'apiKey',
      apiKey: 'sk-test',
      baseUrl: 'https://trusted-provider.example.com',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { models: ['private-model'] } })
    expect(probeModels).toHaveBeenCalledWith({
      authMode: 'apiKey',
      apiKey: 'sk-test',
      baseUrl: 'https://trusted-provider.example.com',
    })
  })

  it('leaves provider-specific credential validation to the adapter', async () => {
    const probeModels = vi.fn().mockResolvedValue({
      models: [],
      error: 'Missing required credentials: apiKey',
      code: 'invalid_input',
    })
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const res = await postProbe({ kind: 'cursor', authMode: 'apiKey' })

    expect(res.status).toBe(400)
    expect(probeModels).toHaveBeenCalledWith({ authMode: 'apiKey' })
  })
})

describe('POST /probe-models — ProviderAdapter dispatch', () => {
  it('returns 404 when provider kind is unknown', async () => {
    providerCatalogGetMock.mockReturnValue(undefined)
    const res = await postProbe({ kind: 'codex', authMode: 'apiKey' })
    expect(res.status).toBe(404)
  })

  it('accepts the legacy engineType field', async () => {
    const probeModels = vi.fn().mockResolvedValue({ models: ['gpt-5.4'] })
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const res = await postProbe({ engineType: 'codex', authMode: 'apiKey' })

    expect(res.status).toBe(200)
    expect(providerCatalogGetMock).toHaveBeenCalledWith('codex')
  })

  it('passes normalized credentials to the adapter', async () => {
    const probeModels = vi.fn().mockResolvedValue({ models: ['claude-opus-4-7'] })
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const res = await postProbe({
      kind: 'claude-code',
      authMode: 'apiKey',
      authHeaderStyle: 'bearer',
      baseUrl: 'https://llm-proxy.example.com',
      apiKey: 'sk-xxx',
    })

    expect(res.status).toBe(200)
    expect(probeModels).toHaveBeenCalledWith({
      authMode: 'apiKey',
      authHeaderStyle: 'bearer',
      apiKey: 'sk-xxx',
      baseUrl: 'https://llm-proxy.example.com',
    })
  })

  it('rejects masked credentials before dispatching to an adapter', async () => {
    const probeModels = vi.fn()
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const res = await postProbe({
      kind: 'claude-code',
      authMode: 'apiKey',
      authHeaderStyle: 'bearer',
      apiKey: 'real-key',
      baseUrl: '********',
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ data: { code: 'masked_credentials' } })
    expect(probeModels).not.toHaveBeenCalled()
  })

  it('returns 502 when adapter reports an upstream error', async () => {
    const probeModels = vi.fn().mockResolvedValue({
      models: [],
      error: 'HTTP 401',
      code: 'http_error',
      details: { status: 401 },
    })
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const res = await postProbe({ kind: 'claude-code', authMode: 'localSession' })
    expect(res.status).toBe(502)
  })

  it('returns 400 for unsupported modes reported by the adapter', async () => {
    const probeModels = vi.fn().mockResolvedValue({
      models: [],
      error: 'oauth not supported',
      code: 'unsupported_mode',
    })
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const res = await postProbe({ kind: 'codex', authMode: 'oauth', oauthToken: 'token' })
    expect(res.status).toBe(400)
  })

  it('returns 500 on an unexpected adapter exception', async () => {
    const probeModels = vi.fn().mockRejectedValue(new Error('boom'))
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const res = await postProbe({ kind: 'codex', authMode: 'apiKey' })
    expect(res.status).toBe(500)
  })
})

/**
 * The route hands the adapter's answer back verbatim, and JSON is where the one
 * distinction the UI depends on could quietly die: **absent means "not
 * discovered", empty means "discovered, and there are none"**. A level list that
 * arrives as `[]` must not reach the browser as a missing key, and vice versa —
 * the picker greys out for one and stays open for the other.
 */
describe('POST /probe-models — per-model capabilities and fast mode', () => {
  it('carries the discovered levels, their defaults and the fast-mode verdict', async () => {
    const probeModels = vi.fn().mockResolvedValue({
      models: ['claude-opus-4-8', 'claude-haiku-4-5'],
      modelCapabilities: {
        'claude-opus-4-8': {
          reasoningEfforts: [{ value: 'low' }, { value: 'high', description: 'Deeper reasoning' }],
          defaultReasoningEffort: 'low',
        },
      },
      fastMode: { available: true },
    })
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const res = await postProbe({ kind: 'claude-code', authMode: 'localSession' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: {
        models: ['claude-opus-4-8', 'claude-haiku-4-5'],
        modelCapabilities: {
          'claude-opus-4-8': {
            reasoningEfforts: [
              { value: 'low' },
              { value: 'high', description: 'Deeper reasoning' },
            ],
            defaultReasoningEffort: 'low',
          },
        },
        fastMode: { available: true },
      },
    })
  })

  it('keeps an empty level list distinct from an absent one across the wire', async () => {
    const probeModels = vi.fn().mockResolvedValue({
      models: ['claude-haiku-4-5', 'proxy-model'],
      // haiku answered "none"; proxy-model was never asked.
      modelCapabilities: { 'claude-haiku-4-5': { reasoningEfforts: [] } },
    })
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const body = (await (
      await postProbe({ kind: 'claude-code', authMode: 'localSession' })
    ).json()) as {
      data: { modelCapabilities: Record<string, { reasoningEfforts?: unknown }> }
    }

    expect(body.data.modelCapabilities['claude-haiku-4-5'].reasoningEfforts).toEqual([])
    expect(body.data.modelCapabilities['proxy-model']).toBeUndefined()
  })

  it('carries the refusal reason, which is what disables the switch in the UI', async () => {
    const probeModels = vi.fn().mockResolvedValue({
      models: ['claude-opus-4-8'],
      fastMode: { available: false, reason: 'extra_usage_disabled' },
    })
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const body = (await (
      await postProbe({ kind: 'claude-code', authMode: 'localSession' })
    ).json()) as {
      data: { fastMode: unknown }
    }

    expect(body.data.fastMode).toEqual({ available: false, reason: 'extra_usage_disabled' })
  })

  it('omits both fields entirely when discovery reported neither', async () => {
    const probeModels = vi.fn().mockResolvedValue({ models: ['deepseek-v4-flash'] })
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const body = (await (
      await postProbe({
        kind: 'claude-code',
        authMode: 'apiKey',
        apiKey: 'sk-xxx',
        baseUrl: 'https://llm-proxy.example.com',
      })
    ).json()) as { data: Record<string, unknown> }

    // Absent, not null: a null would be a discovered answer, and there was none.
    expect(Object.keys(body.data)).toEqual(['models'])
  })

  it('still carries the models when only the fast-mode probe could answer', async () => {
    const probeModels = vi.fn().mockResolvedValue({
      models: ['claude-opus-4-8'],
      fastMode: { available: true },
    })
    providerCatalogGetMock.mockReturnValue({ probeModels })

    const res = await postProbe({ kind: 'claude-code', authMode: 'localSession' })
    const body = (await res.json()) as { data: Record<string, unknown> }

    expect(res.status).toBe(200)
    expect(body.data.models).toEqual(['claude-opus-4-8'])
    expect(body.data.modelCapabilities).toBeUndefined()
  })
})
