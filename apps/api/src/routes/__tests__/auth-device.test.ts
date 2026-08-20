/**
 * Device authorization grant (RFC 8628) — the state machine behind a headless
 * `a2wave login`. The interesting cases are all about a code being used more
 * than once, later than it should be, or by the wrong party.
 */
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
const dbInsert = vi.fn()
const dbUpdate = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    insert: (...a: unknown[]) => dbInsert(...a),
    update: (...a: unknown[]) => dbUpdate(...a),
  },
}))

vi.mock('../../db/schema.js', () => ({
  deviceAuthorizations: {
    id: 'device_authorizations.id',
    deviceCodeHash: 'device_authorizations.device_code_hash',
    userCode: 'device_authorizations.user_code',
    status: 'device_authorizations.status',
    userId: 'device_authorizations.user_id',
    expiresAt: 'device_authorizations.expires_at',
    lastPolledAt: 'device_authorizations.last_polled_at',
  },
  users: { id: 'users.id' },
}))

const logAuditMock = vi.fn()
vi.mock('../../lib/audit.js', () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }))

vi.mock('../../lib/audit-actions.js', () => ({
  AUDIT_ACTIONS: {
    AUTH_DEVICE_REQUESTED: 'auth.device.requested',
    AUTH_DEVICE_APPROVED: 'auth.device.approved',
    AUTH_DEVICE_DENIED: 'auth.device.denied',
    AUTH_DEVICE_CLAIMED: 'auth.device.claimed',
  },
}))

const signTokenMock = vi.fn(async () => 'TOKEN')
vi.mock('../../lib/auth.js', () => ({ signToken: () => signTokenMock() }))

vi.mock('../../lib/id.js', () => ({ createId: (p?: string) => `${p}_test` }))

vi.mock('../../lib/client-ip.js', () => ({ resolveClientIp: () => '10.0.0.9' }))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../env.js', () => ({
  env: { TRUSTED_PROXY: false, TRUSTED_PROXY_ADDRESSES: '', PUBLIC_BASE_URL: 'https://a2w.test' },
}))

const getServerUrlMock = vi.fn(async () => 'https://a2w.test')
vi.mock('../../lib/server-url.js', () => ({
  getServerUrl: () => getServerUrlMock(),
}))

import deviceRoutes from '../auth-device.js'

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn<(...a: unknown[]) => unknown>>> = {}
  for (const k of ['from', 'where', 'set', 'values', 'returning', 'limit', 'orderBy']) {
    c[k] = vi.fn((): unknown => chain)
  }
  c.get = vi.fn<(...a: unknown[]) => unknown>()
  c.run = vi.fn<(...a: unknown[]) => unknown>()
  const chain = Object.assign(
    Promise.resolve().then(() => {
      const row = c.get()
      if (row !== undefined) return row === null ? [] : [row]
      const res = c.run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 0
      return Array.from({ length: changes }, () => ({ id: 'dev_test' }))
    }),
    c,
  )
  return chain as unknown as typeof c
}

function queueSelects(...returns: Array<{ get?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => {
    const cfg = returns[i++] ?? {}
    const c = makeChain()
    if ('get' in cfg) c.get.mockReturnValue(cfg.get)
    return c
  })
}

/** Mounted the way index.ts does: the CLI half public, the browser half authenticated. */
function makeApp(userId: string | null = 'usr_1') {
  const app = new Hono()
  app.use('/api/auth/device/*', async (c, next) => {
    if (userId) c.set('userId' as never, userId as never)
    await next()
  })
  app.route('/api/auth/device', deviceRoutes)
  return app
}

const future = () => new Date(Date.now() + 300_000)
const past = () => new Date(Date.now() - 1000)

function pendingRow(over: Record<string, unknown> = {}) {
  return {
    id: 'dev_test',
    deviceCodeHash: 'hash',
    userCode: 'WDJB-MJHT',
    status: 'pending',
    userId: null,
    clientIp: '10.0.0.9',
    userAgent: 'a2wave-cli/1.0',
    expiresAt: future(),
    lastPolledAt: null,
    approvedAt: null,
    createdAt: new Date(),
    ...over,
  }
}

beforeEach(() => {
  dbSelect.mockReset()
  dbInsert.mockReset().mockImplementation(() => makeChain())
  dbUpdate.mockReset().mockImplementation(() => {
    const chain = makeChain()
    chain.run.mockReturnValue({ changes: 1 })
    return chain
  })
  logAuditMock.mockReset()
  signTokenMock.mockClear()
})

afterEach(() => vi.restoreAllMocks())

describe('POST /device/code', () => {
  it('issues both codes and tells the client how to proceed', async () => {
    queueSelects({ get: null })
    const res = await makeApp(null).request('/api/auth/device/code', {
      method: 'POST',
      headers: { 'User-Agent': 'a2wave-cli/1.0' },
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: Record<string, unknown> }
    expect(data.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(String(data.deviceCode).length).toBeGreaterThanOrEqual(43)
    expect(data.verificationUri).toBe('https://a2w.test/device')
    expect(data.verificationUriComplete).toBe(`https://a2w.test/device?code=${data.userCode}`)
    expect(data.interval).toBe(5)
    expect(data.expiresIn).toBe(600)
  })

  it('never persists the device code in the clear', async () => {
    queueSelects({ get: null })
    const res = await makeApp(null).request('/api/auth/device/code', { method: 'POST' })
    const { data } = (await res.json()) as { data: { deviceCode: string } }
    const inserted = dbInsert.mock.results[0]?.value.values.mock.calls[0][0]
    expect(inserted.deviceCodeHash).not.toBe(data.deviceCode)
    expect(JSON.stringify(inserted)).not.toContain(data.deviceCode)
  })

  it('audits the request without leaking either code', async () => {
    queueSelects({ get: null })
    await makeApp(null).request('/api/auth/device/code', { method: 'POST' })
    const [, entry] = logAuditMock.mock.calls[0]
    expect(entry.action).toBe('auth.device.requested')
    const details = JSON.stringify(entry.details ?? {})
    expect(details).not.toMatch(/WDJB/)
    expect(details).not.toContain('deviceCode')
  })
})

describe('POST /device/token', () => {
  it('reports authorization_pending while nobody has approved', async () => {
    queueSelects({ get: pendingRow() })
    const res = await makeApp(null).request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: 'dc' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('authorization_pending')
  })

  it('answers slow_down when the client polls inside the interval', async () => {
    queueSelects({ get: pendingRow({ lastPolledAt: new Date(Date.now() - 500) }) })
    const res = await makeApp(null).request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: 'dc' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('slow_down')
  })

  it('issues a token once approved', async () => {
    queueSelects(
      { get: pendingRow({ status: 'approved', userId: 'usr_1', approvedAt: new Date() }) },
      { get: { id: 'usr_1', username: 'ada', role: 'user', tokenVersion: 1, isActive: true } },
    )
    const res = await makeApp(null).request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: 'dc' }),
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { token: string } }
    expect(data.token).toBe('TOKEN')
    expect(logAuditMock.mock.calls.at(-1)?.[1].action).toBe('auth.device.claimed')
  })

  it('refuses a device code that already produced a token', async () => {
    // The CLI has its token; a second presentation of the same code is a replay,
    // not a retry, and must not mint a second one.
    queueSelects({ get: pendingRow({ status: 'claimed', userId: 'usr_1' }) })
    const res = await makeApp(null).request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: 'dc' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('expired_token')
    expect(signTokenMock).not.toHaveBeenCalled()
  })

  it('reports expired_token past the deadline even if it was approved', async () => {
    queueSelects({ get: pendingRow({ status: 'approved', userId: 'usr_1', expiresAt: past() }) })
    const res = await makeApp(null).request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: 'dc' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('expired_token')
    expect(signTokenMock).not.toHaveBeenCalled()
  })

  it('reports access_denied after a refusal', async () => {
    queueSelects({ get: pendingRow({ status: 'denied' }) })
    const res = await makeApp(null).request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: 'dc' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('access_denied')
  })

  it('treats an unknown device code as expired rather than confirming it is unknown', async () => {
    queueSelects({ get: null })
    const res = await makeApp(null).request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: 'nope' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('expired_token')
  })

  it('refuses to issue a token for an account that has since been disabled', async () => {
    queueSelects(
      { get: pendingRow({ status: 'approved', userId: 'usr_1' }) },
      { get: { id: 'usr_1', username: 'ada', role: 'user', tokenVersion: 1, isActive: false } },
    )
    const res = await makeApp(null).request('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: 'dc' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('access_denied')
    expect(signTokenMock).not.toHaveBeenCalled()
  })
})

describe('GET /device/pending', () => {
  it('shows the approver what they are about to authorize', async () => {
    queueSelects({ get: pendingRow() })
    const res = await makeApp().request('/api/auth/device/pending?userCode=wdjb-mjht')
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: Record<string, unknown> }
    expect(data.userCode).toBe('WDJB-MJHT')
    expect(data.clientIp).toBe('10.0.0.9')
    expect(data.userAgent).toBe('a2wave-cli/1.0')
    expect(data.requestedAt).toBeTruthy()
  })

  it('never returns the device code to the browser', async () => {
    queueSelects({ get: pendingRow() })
    const res = await makeApp().request('/api/auth/device/pending?userCode=WDJB-MJHT')
    expect(await res.text()).not.toContain('hash')
  })

  it('rejects a malformed code before it reaches the database', async () => {
    queueSelects({ get: pendingRow() })
    const res = await makeApp().request('/api/auth/device/pending?userCode=zzz')
    expect(res.status).toBe(400)
    expect(dbSelect).not.toHaveBeenCalled()
  })

  it('404s an expired request instead of offering it for approval', async () => {
    queueSelects({ get: pendingRow({ expiresAt: past() }) })
    const res = await makeApp().request('/api/auth/device/pending?userCode=WDJB-MJHT')
    expect(res.status).toBe(404)
  })
})

describe('POST /device/approve', () => {
  it('binds the request to the approving user', async () => {
    queueSelects({ get: pendingRow() })
    const res = await makeApp('usr_7').request('/api/auth/device/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: 'WDJB-MJHT' }),
    })
    expect(res.status).toBe(200)
    const setArg = dbUpdate.mock.results[0]?.value.set.mock.calls[0][0]
    expect(setArg.status).toBe('approved')
    expect(setArg.userId).toBe('usr_7')
    expect(logAuditMock.mock.calls.at(-1)?.[1].action).toBe('auth.device.approved')
  })

  it('refuses to approve an expired request', async () => {
    queueSelects({ get: pendingRow({ expiresAt: past() }) })
    const res = await makeApp().request('/api/auth/device/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: 'WDJB-MJHT' }),
    })
    expect(res.status).toBe(400)
    expect(dbUpdate).not.toHaveBeenCalled()
  })

  it('refuses to re-approve a request that was already decided', async () => {
    // Otherwise a denied request could be flipped back open by replaying the page.
    queueSelects({ get: pendingRow({ status: 'denied' }) })
    const res = await makeApp().request('/api/auth/device/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: 'WDJB-MJHT' }),
    })
    expect(res.status).toBe(400)
    expect(dbUpdate).not.toHaveBeenCalled()
  })

  it('loses the race rather than overwriting a concurrent decision', async () => {
    queueSelects({ get: pendingRow() })
    dbUpdate.mockImplementation(() => {
      const chain = makeChain()
      chain.run.mockReturnValue({ changes: 0 })
      return chain
    })
    const res = await makeApp().request('/api/auth/device/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: 'WDJB-MJHT' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /device/deny', () => {
  it('marks the request denied and audits who refused it', async () => {
    queueSelects({ get: pendingRow() })
    const res = await makeApp('usr_7').request('/api/auth/device/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: 'WDJB-MJHT' }),
    })
    expect(res.status).toBe(200)
    expect(dbUpdate.mock.results[0]?.value.set.mock.calls[0][0].status).toBe('denied')
    expect(logAuditMock.mock.calls.at(-1)?.[1].action).toBe('auth.device.denied')
  })
})
