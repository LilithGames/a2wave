import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAccount: vi.fn(),
  listAccounts: vi.fn(),
  getLogin: vi.fn(),
  insertLogin: vi.fn(),
  transitionLogin: vi.fn(),
  commitLogin: vi.fn(),
  claimRefresh: vi.fn(),
  finishRefresh: vi.fn(),
  exchange: vi.fn(),
  refresh: vi.fn(),
  audit: vi.fn(),
  user: vi.fn(),
  revoke: vi.fn(),
}))
vi.mock('../provider-oauth-store.js', () => ({
  getOauthAccount: mocks.getAccount,
  listOauthAccounts: mocks.listAccounts,
  getOauthLogin: mocks.getLogin,
  insertOauthLogin: mocks.insertLogin,
  transitionOauthLogin: mocks.transitionLogin,
  commitOauthLogin: mocks.commitLogin,
  claimOauthRefresh: mocks.claimRefresh,
  finishOauthRefresh: mocks.finishRefresh,
  getOauthHostId: async () => 'host',
  getOauthLoginUser: mocks.user,
}))
vi.mock('../provider-oauth-protocol.js', async (original) => ({
  ...(await original<typeof import('../provider-oauth-protocol.js')>()),
  exchangeProviderOauthCode: mocks.exchange,
  refreshProviderOauthTokens: mocks.refresh,
  revokeProviderOauthTokens: mocks.revoke,
}))
vi.mock('../secret-box.js', () => ({
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
}))
vi.mock('../audit.js', () => ({ logBackgroundAudit: mocks.audit }))

import {
  completeProviderOauthLogin,
  disconnectProviderOauthAccount,
  resolveProviderOauthAccountCredentials,
  startProviderOauthLogin,
  toProviderOauthAccountDto,
} from '../provider-oauth-accounts.js'

const account = () => ({
  id: 'poa_account',
  providerId: 'prv_codex',
  label: 'Account',
  email: null,
  subject: 'subject',
  clientId: 'client',
  hostId: 'host',
  createdByUserId: 'owner',
  tokensEnc: JSON.stringify({ accessToken: 'old', refreshToken: 'refresh', idToken: 'id' }),
  expiresAt: new Date(0),
  earliestRefreshAt: null,
  reauthRequired: false,
  revision: 0,
  refreshLeaseId: null,
  refreshLeaseExpiresAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.audit.mockResolvedValue(undefined)
  mocks.user.mockResolvedValue({ isActive: true, tokenVersion: 0 })
})
describe('stored Provider OAuth accounts', () => {
  it('never includes encrypted or plain credentials in the public DTO', () => {
    const dto = toProviderOauthAccountDto(account(), { userId: 'other', isAdmin: false })
    expect(dto.canManage).toBe(false)
    expect(dto.status).toBe('expired')
    expect(JSON.stringify(dto)).not.toMatch(/tokensEnc|refreshToken|accessToken/)
  })
  it('serializes simultaneous refreshes and stores the replacement atomically', async () => {
    let row = account()
    mocks.getAccount.mockImplementation(async () => row)
    mocks.claimRefresh.mockResolvedValue(true)
    mocks.refresh.mockImplementation(async () => ({
      accessToken: 'new',
      refreshToken: 'replacement',
      idToken: 'id',
      subject: 'subject',
      email: null,
      scopes: [],
      expiresAt: new Date(Date.now() + 3600000),
      earliestRefreshAt: null,
    }))
    mocks.finishRefresh.mockImplementation(async (_id, _lease, _revision, patch) => {
      row = { ...row, ...patch, revision: row.revision + 1 }
      return true
    })
    const [a, b] = await Promise.all([
      resolveProviderOauthAccountCredentials('poa_account'),
      resolveProviderOauthAccountCredentials('poa_account'),
    ])
    expect(a.accessToken).toBe('new')
    expect(b.accessToken).toBe('new')
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(JSON.parse(row.tokensEnc).refreshToken).toBe('replacement')
  })
  it('refuses a consumed login token before exchanging a code', async () => {
    mocks.getLogin.mockResolvedValue({
      status: 'completed',
      expiresAt: new Date(Date.now() + 10000),
    })
    await expect(
      completeProviderOauthLogin('pol_login', 'token', { code: 'code', state: 'state' }),
    ).rejects.toThrow()
    expect(mocks.exchange).not.toHaveBeenCalled()
  })
  it('does not replace a selected account with another verified identity', async () => {
    const { createHash } = await import('node:crypto')
    mocks.getLogin.mockResolvedValue({
      id: 'login',
      userTokenVersion: 0,
      status: 'started',
      tokenHash: createHash('sha256').update('token').digest('hex'),
      accountId: 'poa_account',
      providerId: 'prv_codex',
      createdByUserId: 'owner',
      expiresAt: new Date(Date.now() + 100000),
      pendingEnc: JSON.stringify({
        clientId: 'client',
        hostId: 'host',
        state: 'state',
        nonce: 'nonce',
        verifier: 'verifier',
        redirectUri: 'http://127.0.0.1:4567/auth/callback',
      }),
    })
    mocks.getAccount.mockResolvedValue(account())
    mocks.transitionLogin.mockResolvedValue(true)
    mocks.exchange.mockResolvedValue({ subject: 'different', email: null })
    await expect(
      completeProviderOauthLogin('login', 'token', { code: 'code', state: 'state' }),
    ).rejects.toThrow(/identity/i)
    expect(mocks.commitLogin).not.toHaveBeenCalled()
  })
  it('refreshes a still-valid token after an explicit upstream 401', async () => {
    mocks.getAccount.mockResolvedValue({ ...account(), expiresAt: new Date(Date.now() + 3600000) })
    mocks.claimRefresh.mockResolvedValue(true)
    mocks.finishRefresh.mockResolvedValue(true)
    mocks.refresh.mockResolvedValue({
      accessToken: 'fresh',
      refreshToken: 'new',
      idToken: 'id',
      subject: 'subject',
      scopes: [],
      expiresAt: new Date(Date.now() + 3600000),
    })
    expect(
      (
        await resolveProviderOauthAccountCredentials('poa_account', undefined, {
          forceRefresh: true,
        })
      ).accessToken,
    ).toBe('fresh')
  })
  it('respects the issuer earliest refresh time for proactive renewal', async () => {
    mocks.getAccount.mockResolvedValue({
      ...account(),
      expiresAt: new Date(Date.now() + 120000),
      earliestRefreshAt: new Date(Date.now() + 90000),
    })
    expect(
      (
        await resolveProviderOauthAccountCredentials('poa_account', undefined, {
          minimumValidityMs: 3600000,
        })
      ).accessToken,
    ).toBe('old')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
  it.each([
    { isActive: false, tokenVersion: 0 },
    { isActive: true, tokenVersion: 1 },
  ])('rejects login capabilities after user/session revocation: %j', async (user) => {
    const { createHash } = await import('node:crypto')
    mocks.getLogin.mockResolvedValue({
      id: 'login',
      userTokenVersion: 0,
      createdByUserId: 'owner',
      status: 'pending',
      tokenHash: createHash('sha256').update('token').digest('hex'),
      expiresAt: new Date(Date.now() + 100000),
    })
    mocks.user.mockResolvedValue(user)
    await expect(
      startProviderOauthLogin('login', 'token', 'http://127.0.0.1:4567/auth/callback'),
    ).rejects.toThrow(/revoked/)
    expect(mocks.transitionLogin).not.toHaveBeenCalled()
  })
  it.each([
    JSON.stringify({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      idToken: 'retained-id-token',
    }),
    'unreadable-old-credentials',
  ])(
    'starts reconnection using metadata without exposing or opening stored tokens: %s',
    async (tokensEnc) => {
      const { createHash } = await import('node:crypto')
      mocks.getLogin.mockResolvedValue({
        id: 'login',
        accountId: 'poa_account',
        userTokenVersion: 0,
        createdByUserId: 'owner',
        status: 'pending',
        tokenHash: createHash('sha256').update('token').digest('hex'),
        expiresAt: new Date(Date.now() + 100000),
      })
      mocks.getAccount.mockResolvedValue({ ...account(), email: 'person@example.com', tokensEnc })
      mocks.transitionLogin.mockResolvedValue(true)
      const result = await startProviderOauthLogin(
        'login',
        'token',
        'http://127.0.0.1:4567/auth/callback',
      )
      const url = new URL(result.authorizationUrl)
      expect(url.searchParams.get('client_id')).toBe('client')
      expect(url.searchParams.get('login_hint')).toBe('person@example.com')
      expect(url.searchParams.has('id_token_hint')).toBe(false)
      const persisted = mocks.transitionLogin.mock.calls[0][2].pendingEnc as string
      expect(persisted).not.toContain('idTokenHint')
      expect(JSON.stringify(result) + persisted).not.toMatch(
        /retained-id-token|access-secret|refresh-secret/,
      )
    },
  )
  it('keeps credentials available for a revocation retry when upstream fails', async () => {
    mocks.getAccount.mockResolvedValue(account())
    mocks.claimRefresh.mockResolvedValue(true)
    mocks.revoke.mockRejectedValue(new Error('revocation unconfirmed'))
    await expect(disconnectProviderOauthAccount('poa_account', 'owner')).rejects.toThrow(
      /unconfirmed/,
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'provider_oauth_account.disconnect_failed',
        userId: 'owner',
      }),
    )
    expect(mocks.finishRefresh).toHaveBeenCalledWith(
      'poa_account',
      expect.stringMatching(/^delete_/),
      0,
      {},
    )
  })
  it('keeps the deletion reservation after confirmed revocation until the row is removed', async () => {
    mocks.getAccount.mockResolvedValue(account())
    mocks.claimRefresh.mockResolvedValue(true)
    mocks.revoke.mockResolvedValue(undefined)
    mocks.finishRefresh.mockResolvedValue(true)
    await disconnectProviderOauthAccount('poa_account', 'owner')
    expect(mocks.finishRefresh).toHaveBeenCalledWith(
      'poa_account',
      expect.stringMatching(/^delete_/),
      0,
      { reauthRequired: true },
      true,
    )
  })
})

describe('single-use ChatGPT authorization completion', () => {
  async function pendingLogin(overrides: Record<string, unknown> = {}) {
    const { createHash } = await import('node:crypto')
    mocks.getLogin.mockResolvedValue({
      id: 'pol_login',
      accountId: null,
      providerId: 'prv_codex',
      createdByUserId: 'owner',
      userTokenVersion: 0,
      status: 'started',
      expiresAt: new Date(Date.now() + 100000),
      tokenHash: createHash('sha256').update('token').digest('hex'),
      pendingEnc: JSON.stringify({
        clientId: null,
        hostId: 'host',
        state: 'state',
        nonce: 'nonce',
        verifier: 'verifier',
        redirectUri: 'http://127.0.0.1:4567/auth/callback',
      }),
      ...overrides,
    })
    mocks.transitionLogin.mockResolvedValue(true)
    mocks.commitLogin.mockResolvedValue(undefined)
  }
  it('stores the issued client registration and returns only its account ID', async () => {
    await pendingLogin()
    mocks.exchange.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      idToken: 'identity',
      subject: 'subject',
      email: null,
      scopes: [],
      expiresAt: new Date(Date.now() + 3600000),
      earliestRefreshAt: null,
    })
    const result = await completeProviderOauthLogin('pol_login', 'token', {
      code: 'code',
      state: 'state',
      clientId: 'oaiapp_issued',
    })
    expect(result).toEqual({ accountId: expect.stringMatching(/^poa_/) })
    expect(mocks.commitLogin).toHaveBeenCalledWith(
      'pol_login',
      expect.objectContaining({
        clientId: 'oaiapp_issued',
        subject: 'subject',
        providerId: 'prv_codex',
      }),
      false,
    )
    expect(mocks.transitionLogin).toHaveBeenCalledWith('pol_login', 'started', {
      status: 'exchanging',
      tokenHash: '',
    })
  })
  it('consumes and fails a callback with the wrong state before any token exchange', async () => {
    await pendingLogin()
    await expect(
      completeProviderOauthLogin('pol_login', 'token', {
        code: 'code',
        state: 'wrong',
        clientId: 'issued',
      }),
    ).rejects.toThrow(/state/)
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.transitionLogin).toHaveBeenLastCalledWith(
      'pol_login',
      'exchanging',
      expect.objectContaining({ status: 'failed', pendingEnc: null, tokenHash: '' }),
    )
  })
  it('fails an expired authorization without accepting its capability token', async () => {
    await pendingLogin({ expiresAt: new Date(0) })
    await expect(
      completeProviderOauthLogin('pol_login', 'token', { code: 'code', state: 'state' }),
    ).rejects.toThrow(/expired/)
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.transitionLogin).not.toHaveBeenCalled()
  })
})
