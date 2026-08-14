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
  users: {
    id: 'users.id',
    username: 'users.username',
    displayName: 'users.displayName',
    email: 'users.email',
    role: 'users.role',
    tokenVersion: 'users.tokenVersion',
  },
  userInvitations: {
    id: 'userInvitations.id',
    code: 'userInvitations.code',
    email: 'userInvitations.email',
    role: 'userInvitations.role',
    note: 'userInvitations.note',
    invitedBy: 'userInvitations.invitedBy',
    acceptedUserId: 'userInvitations.acceptedUserId',
    acceptedAt: 'userInvitations.acceptedAt',
    revokedAt: 'userInvitations.revokedAt',
    expiresAt: 'userInvitations.expiresAt',
    createdAt: 'userInvitations.createdAt',
    updatedAt: 'userInvitations.updatedAt',
  },
}))

const logAuditMock = vi.fn()
vi.mock('../../lib/audit.js', () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}))

vi.mock('../../lib/audit-actions.js', () => ({
  AUDIT_ACTIONS: {
    USER_INVITATION_CREATED: 'user_invitation.created',
    USER_INVITATION_REVOKED: 'user_invitation.revoked',
    USER_INVITATION_ACCEPTED: 'user_invitation.accepted',
    USER_INVITATION_ACCEPT_FAILED: 'user_invitation.accept_failed',
  },
}))

const validatePasswordMock = vi.fn()
const hashPasswordMock = vi.fn(async (_p?: unknown) => 'hashed')
const signTokenMock = vi.fn(async (_u?: unknown) => 'signed-token')
vi.mock('../../lib/auth.js', () => ({
  validatePassword: (p: string) => validatePasswordMock(p),
  hashPassword: (p: string) => hashPasswordMock(p),
  signToken: (u: unknown) => signTokenMock(u),
}))

const setAuthCookieMock = vi.fn()
vi.mock('../../lib/auth-cookie.js', () => ({
  setAuthCookie: (...a: unknown[]) => setAuthCookieMock(...a),
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn((p?: string) => `${p}_test`),
}))

const withTransactionMock = vi.fn(async (fn: (tx: unknown) => unknown) => fn(txHandle))
vi.mock('../../db/transaction.js', () => ({
  withTransaction: (fn: (tx: unknown) => unknown) => withTransactionMock(fn),
}))

import { DEFAULT_INVITATION_TTL_HOURS } from '@a2wave/shared'
import { adminInvitationRoutes, publicInvitationRoutes } from '../user-invitations.js'

/** The `tx` handle handed to the `withTransaction` callback. */
const txUpdate = vi.fn()
const txInsert = vi.fn()
const txHandle = {
  update: (...a: unknown[]) => txUpdate(...a),
  insert: (...a: unknown[]) => txInsert(...a),
}

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const k of [
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'values',
    'returning',
    'set',
    'leftJoin',
    'groupBy',
    'having',
  ]) {
    c[k] = vi.fn((): unknown => __chain)
  }
  c.get = vi.fn()
  c.all = vi.fn()
  c.run = vi.fn()

  let __settled: Promise<unknown[]> | undefined
  const __rows = (): unknown[] => {
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
    return []
  }
  const __chain = Object.assign(
    {
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

function queueInsertReturning(v: unknown) {
  dbInsert.mockImplementation(() => {
    const c = makeChain()
    c.get.mockReturnValue(v)
    return c
  })
}

/** Each queued entry is the `.returning()` result of one successive `db.update()`. */
function queueUpdates(...returns: unknown[][]) {
  let i = 0
  dbUpdate.mockImplementation(() => {
    const rows = returns[i++] ?? []
    const c = makeChain()
    c.all.mockReturnValue(rows)
    return c
  })
}

function queueTxUpdate(rows: unknown[]) {
  txUpdate.mockImplementation(() => {
    const c = makeChain()
    c.all.mockReturnValue(rows)
    return c
  })
}

function queueTxInsert(v: unknown) {
  txInsert.mockImplementation(() => {
    const c = makeChain()
    c.get.mockReturnValue(v)
    return c
  })
}

const FUTURE = new Date(Date.now() + 3_600_000)
const PAST = new Date(Date.now() - 3_600_000)

function invitationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv_1',
    code: 'the-code',
    email: 'invitee@example.com',
    role: 'user',
    note: null,
    invitedBy: 'usr_admin',
    acceptedUserId: null,
    acceptedAt: null,
    revokedAt: null,
    expiresAt: FUTURE,
    createdAt: PAST,
    ...overrides,
  }
}

const createdUser = {
  id: 'usr_test',
  username: 'invitee',
  displayName: 'Invitee',
  email: 'invitee@example.com',
  role: 'user',
  tokenVersion: 1,
  onboarding: {},
}

beforeEach(() => {
  dbSelect.mockReset()
  dbInsert.mockReset()
  dbUpdate.mockReset()
  txUpdate.mockReset()
  txInsert.mockReset()
  logAuditMock.mockReset()
  setAuthCookieMock.mockReset()
  validatePasswordMock.mockReset().mockReturnValue({ valid: true })
  hashPasswordMock.mockReset().mockImplementation(async () => 'hashed')
  signTokenMock.mockReset().mockImplementation(async () => 'signed-token')
  withTransactionMock
    .mockReset()
    .mockImplementation(async (fn: (tx: unknown) => unknown) => fn(txHandle))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function adminApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, 'usr_admin' as never)
    c.set('userRole' as never, 'admin' as never)
    await next()
  })
  app.route('/users/invitations', adminInvitationRoutes)
  return app
}

function publicApp() {
  const app = new Hono()
  app.route('/auth/invitations', publicInvitationRoutes)
  return app
}

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Envelope every route here returns, so assertions read fields without an `any` cast. */
interface Envelope {
  data?: Record<string, unknown> & { data?: unknown }
  error?: unknown
}
async function json(res: Response): Promise<Envelope> {
  return (await res.json()) as Envelope
}
/** `data` as a record — the shape every success path returns. */
async function jsonData(res: Response): Promise<Record<string, unknown>> {
  return ((await json(res)).data ?? {}) as Record<string, unknown>
}
async function jsonError(res: Response): Promise<unknown> {
  return (await json(res)).error
}
/** The audit payload of the n-th `logAudit` call. */
function auditCall(n = 0): Record<string, unknown> {
  return logAuditMock.mock.calls[n][1] as Record<string, unknown>
}

describe('GET /users/invitations', () => {
  it('lists invitations, serialized', async () => {
    queueSelects({
      all: [invitationRow({ invitedByName: 'Alice', invitedByUsername: 'alice' })],
    })
    const res = await adminApp().request('/users/invitations')
    expect(res.status).toBe(200)
    const list = (await jsonData(res)) as unknown as Record<string, unknown>[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'inv_1',
      code: 'the-code',
      status: 'pending',
      invitedByName: 'Alice',
    })
  })
})

describe('POST /users/invitations', () => {
  it('rejects a malformed body', async () => {
    const res = await postJson(adminApp(), '/users/invitations', { email: 'not-an-email' })
    expect(res.status).toBe(400)
  })

  it('rejects an invalid expiry window', async () => {
    const res = await postJson(adminApp(), '/users/invitations', { expiresInHours: 0 })
    expect(res.status).toBe(400)
  })

  it('returns 409 when the email already has an account', async () => {
    queueSelects({ get: { id: 'usr_existing' } })
    const res = await postJson(adminApp(), '/users/invitations', { email: 'taken@example.com' })
    expect(res.status).toBe(409)
    expect(await jsonError(res)).toBe('EMAIL_ALREADY_REGISTERED')
  })

  it('creates an invitation, returns 201 with the code, and audits without it', async () => {
    queueSelects({ get: undefined })
    queueUpdates([])
    queueInsertReturning(invitationRow({ id: 'inv_test', code: 'brand-new-code' }))

    const res = await postJson(adminApp(), '/users/invitations', {
      email: 'invitee@example.com',
      role: 'admin',
      expiresInHours: 24,
      note: 'contractor',
    })

    expect(res.status).toBe(201)
    const body = await jsonData(res)
    expect(body.code).toBe('brand-new-code')
    expect(body.status).toBe('pending')

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user_invitation.created',
        resource: 'user_invitation',
        resourceId: 'inv_test',
      }),
    )
    const details = auditCall().details
    expect(details).toEqual({ role: 'admin', expiresInHours: 24, hasEmail: true })
    // Iron Rule 5: the code is a bearer credential and must never reach `details`,
    // which renders verbatim to every admin.
    expect(JSON.stringify(details)).not.toContain('brand-new-code')
    expect(JSON.stringify(details)).not.toContain('code')
  })

  it('creates an unpinned invitation without probing the users table', async () => {
    queueSelects()
    queueUpdates([])
    queueInsertReturning(invitationRow({ id: 'inv_test', email: null }))

    const res = await postJson(adminApp(), '/users/invitations', {})
    expect(res.status).toBe(201)
    expect(dbSelect).not.toHaveBeenCalled()
    // Asserted against the shared constant, not a literal: the default TTL has one home,
    // and a copy here would quietly go stale the next time it is tuned.
    expect(auditCall().details).toEqual({
      role: 'user',
      expiresInHours: DEFAULT_INVITATION_TTL_HOURS,
      hasEmail: false,
    })
  })

  it('supersedes the pending invitation the same address already holds', async () => {
    queueSelects({ get: undefined })
    queueUpdates([{ id: 'inv_old' }])
    queueInsertReturning(invitationRow({ id: 'inv_test' }))

    const res = await postJson(adminApp(), '/users/invitations', {
      email: 'invitee@example.com',
    })
    expect(res.status).toBe(201)
    expect(dbUpdate).toHaveBeenCalledTimes(1)
    expect(auditCall().details).toMatchObject({
      supersededInvitationId: 'inv_old',
    })
  })
})

describe('POST /users/invitations/:id/revoke', () => {
  it('returns 404 for an unknown invitation', async () => {
    queueSelects({ get: undefined })
    const res = await postJson(adminApp(), '/users/invitations/inv_x/revoke', {})
    expect(res.status).toBe(404)
    expect(await jsonError(res)).toBe('INVITATION_NOT_FOUND')
  })

  it('returns 409 when it was already accepted', async () => {
    queueSelects({ get: invitationRow({ acceptedAt: PAST, acceptedUserId: 'usr_x' }) })
    const res = await postJson(adminApp(), '/users/invitations/inv_1/revoke', {})
    expect(res.status).toBe(409)
    expect(await jsonError(res)).toBe('INVITATION_ALREADY_ACCEPTED')
    expect(dbUpdate).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it('returns 409 when the compare-and-set matches no row', async () => {
    queueSelects({ get: invitationRow() })
    queueUpdates([])
    const res = await postJson(adminApp(), '/users/invitations/inv_1/revoke', {})
    expect(res.status).toBe(409)
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it('revokes and audits', async () => {
    queueSelects({ get: invitationRow() })
    queueUpdates([{ id: 'inv_1' }])
    const res = await postJson(adminApp(), '/users/invitations/inv_1/revoke', {})
    expect(res.status).toBe(200)
    expect(await jsonData(res)).toEqual({ id: 'inv_1', status: 'revoked' })
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user_invitation.revoked',
        resourceId: 'inv_1',
        details: { role: 'user', hasEmail: true },
      }),
    )
  })
})

describe('GET /auth/invitations/:code', () => {
  it('returns 404 for an unknown code', async () => {
    queueSelects({ get: undefined })
    const res = await publicApp().request('/auth/invitations/nope')
    expect(res.status).toBe(404)
    expect(await jsonError(res)).toBe('INVITATION_NOT_FOUND')
  })

  it('returns pending with the pinned email', async () => {
    queueSelects({ get: invitationRow() })
    const res = await publicApp().request('/auth/invitations/the-code')
    expect(res.status).toBe(200)
    const body = await jsonData(res)
    expect(body.status).toBe('pending')
    expect(body.email).toBe('invitee@example.com')
  })

  it.each([
    ['expired', invitationRow({ expiresAt: PAST })],
    ['revoked', invitationRow({ revokedAt: PAST })],
    ['accepted', invitationRow({ acceptedAt: PAST, acceptedUserId: 'usr_x' })],
  ])('reports %s without echoing the address', async (status, row) => {
    queueSelects({ get: row })
    const res = await publicApp().request('/auth/invitations/the-code')
    expect(res.status).toBe(200)
    const body = await jsonData(res)
    expect(body.status).toBe(status)
    // Not an address oracle: a spent or dead code reveals nothing about who was invited.
    expect(body.email).toBeNull()
  })
})

describe('POST /auth/invitations/:code/accept', () => {
  const validBody = {
    username: 'invitee',
    displayName: 'Invitee',
    email: 'invitee@example.com',
    password: 'Aa1aaaaa',
    confirmPassword: 'Aa1aaaaa',
  }

  it('rejects a malformed body', async () => {
    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', { username: 'ab' })
    expect(res.status).toBe(400)
  })

  it('rejects a password confirmation mismatch', async () => {
    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', {
      ...validBody,
      confirmPassword: 'Aa1bbbbb',
    })
    expect(res.status).toBe(400)
    expect(dbSelect).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown code', async () => {
    queueSelects({ get: undefined })
    const res = await postJson(publicApp(), '/auth/invitations/nope/accept', validBody)
    expect(res.status).toBe(404)
  })

  it.each([
    ['expired', invitationRow({ expiresAt: PAST }), 'INVITATION_EXPIRED'],
    ['revoked', invitationRow({ revokedAt: PAST }), 'INVITATION_REVOKED'],
    [
      'accepted',
      invitationRow({ acceptedAt: PAST, acceptedUserId: 'usr_x' }),
      'INVITATION_ALREADY_ACCEPTED',
    ],
  ])('returns 409 for a %s invitation and audits the refusal', async (_s, row, error) => {
    queueSelects({ get: row })
    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', validBody)
    expect(res.status).toBe(409)
    expect(await jsonError(res)).toBe(error)
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user_invitation.accept_failed',
        details: { reason: error, status: 409 },
      }),
    )
    expect(txInsert).not.toHaveBeenCalled()
  })

  it('returns 400 INVITATION_EMAIL_MISMATCH when pinned to another address', async () => {
    queueSelects({ get: invitationRow({ email: 'someone.else@example.com' }) })
    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', validBody)
    expect(res.status).toBe(400)
    expect(await jsonError(res)).toBe('INVITATION_EMAIL_MISMATCH')
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user_invitation.accept_failed' }),
    )
  })

  it('rejects a password that fails the server-side policy', async () => {
    validatePasswordMock.mockReturnValue({ valid: false, message: 'PASSWORD_TOO_SHORT' })
    queueSelects({ get: invitationRow() })
    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', validBody)
    expect(res.status).toBe(400)
    expect(await jsonError(res)).toBe('PASSWORD_TOO_SHORT')
  })

  it('returns 409 USERNAME_EXISTS', async () => {
    queueSelects({ get: invitationRow() }, { get: { id: 'usr_taken' } })
    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', validBody)
    expect(res.status).toBe(409)
    expect(await jsonError(res)).toBe('USERNAME_EXISTS')
    expect(txInsert).not.toHaveBeenCalled()
  })

  it('returns 409 EMAIL_ALREADY_REGISTERED', async () => {
    queueSelects({ get: invitationRow() }, { get: undefined }, { get: { id: 'usr_taken' } })
    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', validBody)
    expect(res.status).toBe(409)
    expect(await jsonError(res)).toBe('EMAIL_ALREADY_REGISTERED')
    expect(txInsert).not.toHaveBeenCalled()
  })

  it('creates the account with the invitation role, sets a cookie, and audits as the new user', async () => {
    queueSelects({ get: invitationRow({ role: 'admin' }) }, { get: undefined }, { get: undefined })
    queueTxUpdate([{ id: 'inv_1' }])
    queueTxInsert({ ...createdUser, role: 'admin' })

    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', validBody)

    expect(res.status).toBe(201)
    const body = await jsonData(res)
    expect(body.token).toBe('signed-token')
    expect(body.user).toEqual({
      id: 'usr_test',
      username: 'invitee',
      displayName: 'Invitee',
      role: 'admin',
      email: 'invitee@example.com',
      onboarding: {},
    })

    // The role comes from the invitation, never from the request body.
    const insertChain = txInsert.mock.results[0].value as {
      values: { mock: { calls: unknown[][] } }
    }
    const insertedValues = insertChain.values.mock.calls[0][0] as Record<string, unknown>
    expect(insertedValues.role).toBe('admin')
    expect(insertedValues.passwordHash).toBe('hashed')

    expect(setAuthCookieMock).toHaveBeenCalledWith(expect.anything(), 'signed-token')
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user_invitation.accepted',
        resourceId: 'inv_1',
        userId: 'usr_test',
        details: { userId: 'usr_test', username: 'invitee', role: 'admin' },
      }),
    )
  })

  it('accepts an unpinned invitation with the caller-supplied address', async () => {
    queueSelects({ get: invitationRow({ email: null }) }, { get: undefined }, { get: undefined })
    queueTxUpdate([{ id: 'inv_1' }])
    queueTxInsert(createdUser)

    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', validBody)
    expect(res.status).toBe(201)
  })

  // The user row is inserted *before* the claim, because `accepted_user_id` is a
  // non-deferrable FK to `users` and writing it first references a row that does not exist
  // yet (see the accept handler, and the real-database proof in
  // src/db/__tests__/invitation-accept-fk-order.test.ts). So a lost race can no longer be
  // asserted as "no insert happened" — what matters is that the transaction is *aborted*,
  // which is what discards the inserted row.
  it('aborts the transaction when the claim matches no row, so no account survives', async () => {
    queueSelects({ get: invitationRow() }, { get: undefined }, { get: undefined })
    queueTxInsert(createdUser)
    queueTxUpdate([])

    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', validBody)
    expect(res.status).toBe(409)
    expect(await jsonError(res)).toBe('INVITATION_ALREADY_ACCEPTED')
    // Rolled back rather than committed: the handler must not return the inserted user.
    expect(setAuthCookieMock).not.toHaveBeenCalled()
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user_invitation.accept_failed' }),
    )
    expect(logAuditMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'user_invitation.accepted' }),
    )
  })

  // Ordering is load-bearing, not incidental: reversing it is the production 500 this
  // regression pins, so the sequence itself is asserted.
  it('inserts the user before claiming the invitation', async () => {
    queueSelects({ get: invitationRow() }, { get: undefined }, { get: undefined })
    queueTxInsert(createdUser)
    queueTxUpdate([{ id: 'inv_1' }])

    const res = await postJson(publicApp(), '/auth/invitations/the-code/accept', validBody)
    expect(res.status).toBe(201)
    expect(txInsert).toHaveBeenCalled()
    expect(txUpdate).toHaveBeenCalled()
    expect(txInsert.mock.invocationCallOrder[0]).toBeLessThan(txUpdate.mock.invocationCallOrder[0])
  })
})
