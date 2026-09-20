import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

// ─── Mocks（须在 import 路由模块前 hoist）──────────────────────────────
const settingsStore: Record<string, Record<string, string>> = {}

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () =>
        asyncQuery({
          where: () => asyncQuery({ get: () => undefined, all: () => [] }),
          all: () => [],
        }),
    }),
    insert: () => ({
      values: (row: { category: string; key: string; value: string }) =>
        asyncQuery({
          run: () => {
            settingsStore[row.category] ??= {}
            settingsStore[row.category][row.key] = row.value
          },
        }),
    }),
    update: () => ({
      set: () => asyncQuery({ where: () => asyncQuery({ run: () => {} }) }),
    }),
    transaction: (fn: () => unknown) => fn(),
  },
  // `db/transaction.js` reads these at module load to pick a backend, and its
  // SQLite branch drives BEGIN/COMMIT on the raw handle. Without a stand-in
  // handle every transactional route throws before its own mocks are consulted.
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../db/schema.js', () => ({
  settings: { category: 'category', key: 'key' },
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../middleware/auth-middleware.js', () => ({
  requireAdmin: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  isAdmin: () => true,
}))
vi.mock('../../lib/auth-settings.js', () => ({
  resetAuthSettingsCache: vi.fn(),
  loadAuthSettings: vi.fn(),
  isEmailDomainAllowed: vi.fn(),
}))
vi.mock('../../lib/webhook-notifier.js', () => ({ sendWebhookTest: vi.fn() }))
vi.mock('../../lib/server-url.js', () => ({
  getServerUrl: () => 'https://a2wave.test',
  getSsoCallbackOrigin: () => 'https://a2wave.test',
  isSsoCallbackOriginUsable: () => true,
  clearDetectedServerUrl: vi.fn(),
  isLocalhostOrLoopback: () => false,
  // 这些用例不测按方式覆盖回调 origin：一律视作未填，走 publicBaseUrl 回落。
  normalizeCallbackOriginOverride: () => null,
}))

const mockEncrypt = vi.fn((plain: string) => `enc(${plain})`)
vi.mock('../../lib/secret-box.js', () => ({
  encryptSecret: (plain: string) => mockEncrypt(plain),
  decryptSecret: (enc: string) => enc.replace(/^enc\(|\)$/g, ''),
}))

const mockGetOtelRuntime = vi.fn()
const mockSendOtelTestSpan = vi.fn()
const mockExportStats = vi.fn(() => ({
  active: false,
  lastExportAt: null as string | null,
  lastError: null as string | null,
  droppedSpans: 0,
}))
vi.mock('../../lib/otel/provider.js', () => ({
  getOtelRuntime: () => mockGetOtelRuntime(),
  getOtelExportStats: () => mockExportStats(),
  sendOtelTestSpan: (...args: unknown[]) => mockSendOtelTestSpan(...args),
}))

vi.mock('../../lib/settings.js', () => ({
  getSettingsVersions: () => ({}),
  isNonAdminReadableSetting: () => true,
  getAllSettings: () => ({ ...settingsStore }),
  getCategorySettings: (category: string) => ({ ...(settingsStore[category] ?? {}) }),
  redactSettingsForViewer: (map: unknown) => map,
  redactCategoryForViewer: (_c: string, entries: unknown) => entries,
  // The write path refreshes the settings cache so a change applies without a
  // restart; stubbed here because the db mock has no real query chain.
  refreshSettingsCache: vi.fn().mockResolvedValue(undefined),
}))

const mockGetOidcEnv = vi.fn<() => unknown>(() => null)
const mockProbeOidcDiscovery = vi.fn()
vi.mock('../../lib/oidc.js', () => ({
  getOidcEnv: () => mockGetOidcEnv(),
  isOidcConfigured: () => mockGetOidcEnv() !== null,
  isOauthChannelConfigured: () => mockGetOidcEnv() !== null,
  oauthChannelAudiences: () => [],
  invalidateOidcEnvCache: () => mockInvalidateOidcEnvCache(),
  probeOidcDiscovery: (...args: unknown[]) => mockProbeOidcDiscovery(...args),
}))

const mockInvalidateOidcEnvCache = vi.fn()
const mockGetSamlEnv = vi.fn<() => unknown>(() => null)
vi.mock('../../lib/saml-config.js', () => ({
  getSamlEnv: () => mockGetSamlEnv(),
  isSamlConfigured: () => mockGetSamlEnv() !== null,
}))

const mockGenerateMetadata = vi.fn(() => '<EntityDescriptor/>')
vi.mock('../../lib/saml.js', () => ({
  getSaml: () => ({ generateServiceProviderMetadata: mockGenerateMetadata }),
}))

import { logAudit } from '../../lib/audit.js'

const HEADERS = JSON.stringify({ Authorization: 'Bearer collector-token' })

describe('settings OpenTelemetry endpoints', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    for (const k of Object.keys(settingsStore)) delete settingsStore[k]
    const mod = await import('../settings.js')
    app = new Hono()
    app.route('/api/settings', mod.default)
  })

  const patch = (otel: Record<string, string>) =>
    app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otel }),
    })

  describe('PATCH / — otel', () => {
    it('encrypts otel.headers and never stores the plaintext key', async () => {
      const res = await patch({ endpoint: 'http://localhost:4318', headers: HEADERS })
      expect(res.status).toBe(200)
      expect(settingsStore.otel.headersEnc).toBe(`enc(${HEADERS})`)
      expect(settingsStore.otel.headers).toBeUndefined()
      expect(settingsStore.otel.endpoint).toBe('http://localhost:4318')
    })

    it('clears the stored headers on an empty string', async () => {
      await patch({ headers: HEADERS })
      await patch({ headers: '' })
      expect(settingsStore.otel.headersEnc).toBe('')
    })

    it.each([
      ['INVALID_OTEL_HEADERS', { headers: '{"bad name":"v"}' }],
      ['INVALID_OTEL_HEADERS', { headersEnc: 'forged' }],
      ['INVALID_OTEL_ENDPOINT', { endpoint: 'grpc://collector:4317' }],
      ['OTEL_ENDPOINT_BLOCKED', { endpoint: 'http://169.254.169.254' }],
      ['OTEL_ENDPOINT_REQUIRED', { enabled: 'true' }],
      ['INVALID_OTEL_SETTING', { captureContent: 'maybe' }],
    ])('rejects with %s and stores nothing', async (code, otel) => {
      const res = await patch(otel as Record<string, string>)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe(code)
      expect(settingsStore.otel).toBeUndefined()
    })

    it('audits the change with key names and the capture flag only', async () => {
      await patch({
        enabled: 'true',
        endpoint: 'http://localhost:4318',
        headers: HEADERS,
        captureContent: 'true',
      })
      const otelAudit = (logAudit as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[1] as { action: string; details: Record<string, unknown> })
        .find((entry) => entry.action === 'settings.otel.updated')
      expect(otelAudit?.details).toEqual({
        changedKeys: ['enabled', 'endpoint', 'captureContent', 'headersEnc'],
        captureContent: true,
      })
      expect(JSON.stringify((logAudit as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
        'collector-token',
      )
    })

    it('applies the new config immediately', async () => {
      await patch({ endpoint: 'http://localhost:4318' })
      expect(mockGetOtelRuntime).toHaveBeenCalled()
    })

    it('does not touch otel when the patch has no otel section', async () => {
      await app.request('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook: { enabled: 'false' } }),
      })
      expect(mockGetOtelRuntime).not.toHaveBeenCalled()
    })
  })

  describe('GET /otel/status', () => {
    it('reports an unconfigured instance', async () => {
      const res = await app.request('/api/settings/otel/status')
      expect(res.status).toBe(200)
      expect(((await res.json()) as { data: unknown }).data).toEqual({
        enabled: false,
        endpoint: '',
        tracesUrl: '',
        serviceName: '',
        captureContent: false,
        headersSet: false,
        headerNames: [],
        active: false,
        lastExportAt: null,
        lastError: null,
        droppedSpans: 0,
        scope: 'this-instance',
      })
    })

    it('returns header names but never header values', async () => {
      await patch({ enabled: 'true', endpoint: 'http://localhost:4318', headers: HEADERS })
      mockExportStats.mockReturnValue({
        active: true,
        lastExportAt: '2026-01-01T00:00:00.000Z',
        lastError: null,
        droppedSpans: 3,
      })
      const res = await app.request('/api/settings/otel/status')
      const text = await res.text()
      expect(text).not.toContain('collector-token')
      expect(JSON.parse(text).data).toMatchObject({
        enabled: true,
        tracesUrl: 'http://localhost:4318/v1/traces',
        headersSet: true,
        headerNames: ['Authorization'],
        active: true,
        droppedSpans: 3,
      })
    })
  })

  describe('POST /otel/test', () => {
    it('tests the saved endpoint even while export is disabled', async () => {
      await patch({ endpoint: 'http://localhost:4318', headers: HEADERS })
      mockSendOtelTestSpan.mockResolvedValue({ ok: true })
      const res = await app.request('/api/settings/otel/test', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { data: unknown }).data).toEqual({ ok: true })
      expect(mockSendOtelTestSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          tracesUrl: 'http://localhost:4318/v1/traces',
          headers: { Authorization: 'Bearer collector-token' },
        }),
      )
    })

    it('always answers 200 and carries the verdict in the body', async () => {
      mockSendOtelTestSpan.mockResolvedValue({ ok: false, reason: 'OTEL_NOT_CONFIGURED' })
      const res = await app.request('/api/settings/otel/test', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(mockSendOtelTestSpan).toHaveBeenCalledWith(null)
      expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(false)
    })
  })
})
