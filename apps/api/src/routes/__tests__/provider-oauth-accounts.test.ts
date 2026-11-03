import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../test/test-app.js'

const m = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  login: vi.fn(),
  status: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  audit: vi.fn(),
}))
vi.mock('../../db/client.js', () => ({
  db: { select: m.select, update: m.update, delete: m.remove },
}))
vi.mock('../../db/transaction.js', () => ({
  runExclusive: async (fn: () => unknown) => fn(),
  withTransaction: async (fn: (tx: unknown) => unknown) =>
    fn({ select: m.select, delete: m.remove }),
}))
vi.mock('../../lib/provider-oauth-store.js', () => ({
  listOauthAccounts: m.list,
  getOauthAccount: m.get,
}))
vi.mock('../../lib/provider-oauth-accounts.js', async (original) => ({
  ...(await original<typeof import('../../lib/provider-oauth-accounts.js')>()),
  createProviderOauthLogin: m.login,
  getProviderOauthLoginStatus: m.status,
  startProviderOauthLogin: m.start,
  completeProviderOauthLogin: m.complete,
}))
vi.mock('../../lib/audit.js', () => ({ logAudit: m.audit, logBackgroundAudit: m.audit }))

import {
  providerOauthAccountsRoutes,
  providerOauthLoginRoutes,
} from '../provider-oauth-accounts.js'

function app(userId = 'owner', role: 'admin' | 'user' = 'user') {
  return createTestApp({ userId, role }).route('/api/providers', providerOauthAccountsRoutes)
}
function post(body: unknown) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  m.select.mockReturnValue({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve([{ id: 'prv_codex', kind: 'codex' }]) }),
    }),
  })
  m.get.mockResolvedValue({ id: 'poa_account', providerId: 'prv_codex', createdByUserId: 'owner' })
  m.login.mockResolvedValue({ loginId: 'pol_login', loginToken: 'one-time', expiresAt: 'date' })
})
describe('Provider OAuth account HTTP routes', () => {
  it('allows an authenticated colleague to create a new shared account login', async () => {
    const res = await app().request(
      '/api/providers/prv_codex/oauth-accounts/login',
      post({ label: 'Team' }),
    )
    expect(res.status).toBe(201)
    expect((await res.json()).data.loginId).toBe('pol_login')
    expect(m.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'provider_oauth_account.login_create' }),
    )
  })
  it('requires a signed-in user before exposing account metadata', async () => {
    const res = await createTestApp({ noAuth: true })
      .route('/api/providers', providerOauthAccountsRoutes)
      .request('/api/providers/prv_codex/oauth-accounts')
    expect(res.status).toBe(401)
    expect(m.list).not.toHaveBeenCalled()
  })
  it('refuses another colleague renaming an account', async () => {
    const res = await app('other').request('/api/providers/prv_codex/oauth-accounts/poa_account', {
      ...post({ label: 'Changed' }),
      method: 'PATCH',
    })
    expect(res.status).toBe(403)
    expect(m.update).not.toHaveBeenCalled()
  })
  it('uses a separate bearer login token, without an a2wave browser session', async () => {
    const cliApp = createTestApp({ noAuth: true }).route(
      '/api/provider-oauth-logins',
      providerOauthLoginRoutes,
    )
    m.start.mockResolvedValue({ authorizationUrl: 'https://auth.openai.com/example' })
    expect(
      (
        await cliApp.request(
          '/api/provider-oauth-logins/pol_login/start',
          post({ redirectUri: 'http://127.0.0.1:4567/auth/callback' }),
        )
      ).status,
    ).toBe(401)
    const response = await cliApp.request('/api/provider-oauth-logins/pol_login/start', {
      ...post({ redirectUri: 'http://127.0.0.1:4567/auth/callback' }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer short-token' },
    })
    expect(response.status).toBe(200)
    expect(m.start).toHaveBeenCalledWith(
      'pol_login',
      'short-token',
      'http://127.0.0.1:4567/auth/callback',
    )
  })
  it('passes a denied callback and state to the one-use completion service', async () => {
    m.complete.mockResolvedValue({ accountId: 'poa_account' })
    const res = await createTestApp({ noAuth: true })
      .route('/api/provider-oauth-logins', providerOauthLoginRoutes)
      .request('/api/provider-oauth-logins/pol_login/complete', {
        ...post({ error: 'access_denied', state: 'state' }),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer short-token' },
      })
    expect(res.status).toBe(200)
    expect(m.complete).toHaveBeenCalledWith('pol_login', 'short-token', {
      error: 'access_denied',
      state: 'state',
    })
  })
})
