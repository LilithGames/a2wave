import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
const dbInsert = vi.fn()
const dbDelete = vi.fn()
const dbUpdate = vi.fn()

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    insert: (...a: unknown[]) => dbInsert(...a),
    delete: (...a: unknown[]) => dbDelete(...a),
    update: (...a: unknown[]) => dbUpdate(...a),
  },
}))

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'users.id',
    username: 'users.username',
    role: 'users.role',
    tokenVersion: 'users.tokenVersion',
  },
}))

const logAuditMock = vi.fn()
vi.mock('../../lib/audit.js', () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}))

vi.mock('../../lib/audit-actions.js', () => ({
  AUDIT_ACTIONS: { USER_ROLE_UPDATED: 'user.role-updated' },
}))

const validatePasswordMock = vi.fn()
const hashPasswordMock = vi.fn(async (_p?: unknown) => 'hashed')
vi.mock('../../lib/auth.js', () => ({
  validatePassword: (p: string) => validatePasswordMock(p),
  hashPassword: (p: string) => hashPasswordMock(p),
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn((p?: string) => `${p}_test`),
}))

import usersApp from '../users.js'

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
    'groupBy',
    'having',
  ]) {
    c[k] = vi.fn((): unknown => __chain)
  }
  c.get = vi.fn()
  c.all = vi.fn()
  c.run = vi.fn()

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
function queueInsertReturning(v: unknown) {
  dbInsert.mockImplementation(() => {
    const c = makeChain()
    c.get.mockReturnValue(v)
    return c
  })
}
function queueDelete(returning: unknown[] = []) {
  dbDelete.mockImplementation(() => {
    const c = makeChain()
    c.returning.mockResolvedValue(returning)
    return c
  })
}
function queueUpdate() {
  dbUpdate.mockImplementation(() => makeChain())
}

beforeEach(() => {
  dbSelect.mockReset()
  dbInsert.mockReset()
  dbDelete.mockReset()
  dbUpdate.mockReset()
  logAuditMock.mockReset()
  validatePasswordMock.mockReset()
  hashPasswordMock.mockReset().mockImplementation(async () => 'hashed')
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, 'usr_admin' as never)
    c.set('userRole' as never, 'admin' as never)
    await next()
  })
  app.route('/users', usersApp)
  return app
}

describe('DELETE /users/:id', () => {
  it('rejects deleting self', async () => {
    const res = await buildApp().request('/users/usr_admin', { method: 'DELETE' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('CANNOT_DELETE_SELF')
  })

  it('returns 404 when missing', async () => {
    queueSelects({ get: undefined })
    const res = await buildApp().request('/users/usr_x', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('deletes and audits with the username detail', async () => {
    // A plain user, so the last-admin guard does not apply. The delete now reports its
    // outcome through `.returning()` rows (an empty result means the guard blocked it),
    // so the mock has to yield the deleted row rather than the generic empty chain.
    queueSelects({ get: { id: 'usr_x', username: 'bob', role: 'user', isActive: true } })
    queueDelete([{ id: 'usr_x' }])
    const res = await buildApp().request('/users/usr_x', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data).toEqual({ id: 'usr_x' })
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.delete',
        details: { username: 'bob' },
      }),
    )
  })
})

describe('POST /users/:id/reset-password', () => {
  it('rejects an invalid body', async () => {
    const res = await buildApp().request('/users/usr_x/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('rejects passwords that fail the policy', async () => {
    validatePasswordMock.mockReturnValue({ valid: false, message: 'PASSWORD_TOO_SHORT' })
    const res = await buildApp().request('/users/usr_x/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: 'weak' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('PASSWORD_TOO_SHORT')
  })

  it('returns 404 when user not found', async () => {
    validatePasswordMock.mockReturnValue({ valid: true })
    queueSelects({ get: undefined })
    const res = await buildApp().request('/users/usr_x/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: 'Aa1aaaaa' }),
    })
    expect(res.status).toBe(404)
  })

  it('hashes, bumps tokenVersion, and audits', async () => {
    validatePasswordMock.mockReturnValue({ valid: true })
    queueSelects({ get: { id: 'usr_x', username: 'bob' } })
    queueUpdate()
    const res = await buildApp().request('/users/usr_x/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: 'Aa1aaaaa' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).data).toEqual({ message: 'ok' })
    expect(hashPasswordMock).toHaveBeenCalledWith('Aa1aaaaa')
    expect(logAuditMock).toHaveBeenCalled()
  })
})
