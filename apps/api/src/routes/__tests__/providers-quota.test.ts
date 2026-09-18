import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authMiddleware } from '../../middleware/auth-middleware.js'
import { createTestApp } from '../../test/test-app.js'

const { select, getCodexQuota } = vi.hoisted(() => ({
  select: vi.fn(),
  getCodexQuota: vi.fn(),
}))

vi.mock('../../db/client.js', () => ({ db: { select } }))
vi.mock('../../engine/codex-quota.js', () => ({ getCodexQuota }))
vi.mock('../../engine/index.js', () => ({ providerCatalog: {} }))
vi.mock('../../env.js', () => ({ env: { CODEX_PATH: '/opt/provider-clis/codex' } }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import providersApp from '../providers.js'

function providerRows(rows: unknown[]) {
  select.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  })
}

function request(role: 'admin' | 'user' = 'admin') {
  return createTestApp({ role })
    .route('/api/providers', providersApp)
    .request('/api/providers/prv_codex/quota')
}

beforeEach(() => {
  vi.clearAllMocks()
  providerRows([{ id: 'prv_codex', kind: 'codex' }])
})

describe('GET /api/providers/:id/quota', () => {
  it('returns the server Codex account quota using the configured executable', async () => {
    const data = {
      status: 'available',
      windows: [
        {
          id: 'codex:primary',
          label: null,
          usedPercent: 22,
          windowDurationMins: 10080,
          resetsAt: 1790259062,
        },
      ],
    }
    getCodexQuota.mockResolvedValue(data)
    const res = await request()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data })
    expect(getCodexQuota).toHaveBeenCalledWith('/opt/provider-clis/codex')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects non-admins before querying the account or database', async () => {
    expect((await request('user')).status).toBe(403)
    expect(select).not.toHaveBeenCalled()
    expect(getCodexQuota).not.toHaveBeenCalled()
  })

  it('requires an authenticated session at the providers mount', async () => {
    const app = createTestApp({ noAuth: true })
    app.use('/api/providers/*', authMiddleware)
    app.route('/api/providers', providersApp)
    expect((await app.request('/api/providers/prv_codex/quota')).status).toBe(401)
    expect(select).not.toHaveBeenCalled()
    expect(getCodexQuota).not.toHaveBeenCalled()
  })

  it('returns 404 for a missing provider', async () => {
    providerRows([])
    expect((await request()).status).toBe(404)
    expect(getCodexQuota).not.toHaveBeenCalled()
  })

  it('does not query Codex for another provider', async () => {
    providerRows([{ id: 'prv_codex', kind: 'cursor' }])
    expect((await request()).status).toBe(400)
    expect(getCodexQuota).not.toHaveBeenCalled()
  })

  it.each(['not_logged_in', 'unsupported', 'unavailable'])(
    'returns %s without fabricating quota',
    async (status) => {
      getCodexQuota.mockResolvedValue({ status, windows: [] })
      const res = await request()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ data: { status, windows: [] } })
    },
  )

  it('does not expose unexpected probe errors', async () => {
    getCodexQuota.mockRejectedValue(new Error('sensitive upstream details'))
    const res = await request()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { status: 'unavailable', windows: [] } })
  })
})
