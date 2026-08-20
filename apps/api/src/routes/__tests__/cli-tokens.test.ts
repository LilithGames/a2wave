/**
 * CLI token management. The credential is shown once and never again, so the
 * interesting cases are about what must NOT come back out of the API, and about
 * one user being unable to touch another's tokens.
 */
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  cliTokens: {
    id: 'cli_tokens.id',
    userId: 'cli_tokens.user_id',
    revokedAt: 'cli_tokens.revoked_at',
    createdAt: 'cli_tokens.created_at',
  },
}))

const logAuditMock = vi.fn()
vi.mock('../../lib/audit.js', () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }))

vi.mock('../../lib/audit-actions.js', () => ({
  AUDIT_ACTIONS: {
    CLI_TOKEN_CREATED: 'cli_token.created',
    CLI_TOKEN_REVOKED: 'cli_token.revoked',
  },
}))

vi.mock('../../lib/id.js', () => ({ createId: (p?: string) => `${p}_test` }))

vi.mock('../../env.js', () => ({ env: { AUTH_SESSION_TTL_DAYS: 1 } }))

import cliTokenRoutes from '../cli-tokens.js'

function makeChain(rows: unknown[] = []) {
  const thenable = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>
  for (const k of ['from', 'where', 'set', 'values', 'returning', 'limit', 'orderBy']) {
    thenable[k] = vi.fn(() => thenable)
  }
  return thenable
}

function makeApp(userId = 'usr_1', authMethod: 'session' | 'cli_token' = 'session') {
  const app = new Hono()
  const seed = async (c: { set: (k: never, v: never) => void }, next: () => Promise<void>) => {
    c.set('userId' as never, userId as never)
    c.set('authMethod' as never, authMethod as never)
    await next()
  }
  app.use('/api/cli-tokens/*', seed)
  app.use('/api/cli-tokens', seed)
  app.route('/api/cli-tokens', cliTokenRoutes)
  return app
}

/** The values passed to the mocked builder method, without unsafe optional chaining. */
function callArg(
  mock: ReturnType<typeof vi.fn>,
  method: string,
  index = 0,
): Record<string, unknown> {
  const chain = mock.mock.results[0]?.value as Record<string, ReturnType<typeof vi.fn>> | undefined
  if (!chain) throw new Error(`no ${method} chain recorded`)
  return chain[method].mock.calls[index][0] as Record<string, unknown>
}

const storedRow = {
  id: 'clt_1',
  name: 'CI runner',
  tokenPrefix: 'a2wc_abc123',
  userId: 'usr_1',
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: new Date(),
}

beforeEach(() => {
  dbSelect.mockReset().mockImplementation(() => makeChain([storedRow]))
  dbInsert.mockReset().mockImplementation(() => makeChain([storedRow]))
  dbUpdate.mockReset().mockImplementation(() => makeChain([storedRow]))
  logAuditMock.mockReset()
})

describe('POST /cli-tokens', () => {
  it('returns the plaintext token exactly once, at creation', async () => {
    const res = await makeApp().request('/api/cli-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CI runner' }),
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { token: string } }
    expect(data.token).toMatch(/^a2wc_/)
  })

  it('stores only the hash, never the plaintext', async () => {
    const res = await makeApp().request('/api/cli-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CI runner' }),
    })
    const { data } = (await res.json()) as { data: { token: string } }
    const inserted = callArg(dbInsert, 'values')
    expect(JSON.stringify(inserted)).not.toContain(data.token)
    expect(inserted.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('honours an explicit lifetime', async () => {
    await makeApp().request('/api/cli-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CI', expiresInDays: 30 }),
    })
    const expiresAt = callArg(dbInsert, 'values').expiresAt as Date
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)
  })

  it('treats an omitted lifetime as no expiry', async () => {
    await makeApp().request('/api/cli-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CI' }),
    })
    const inserted = callArg(dbInsert, 'values')
    expect(inserted.expiresAt).toBeNull()
  })

  it('rejects a nameless token, which could never be told apart later', async () => {
    const res = await makeApp().request('/api/cli-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('audits creation without recording the credential', async () => {
    await makeApp().request('/api/cli-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CI runner' }),
    })
    const [, entry] = logAuditMock.mock.calls[0]
    expect(entry.action).toBe('cli_token.created')
    expect(JSON.stringify(entry.details)).not.toMatch(/a2wc_[A-Za-z0-9_-]{20}/)
  })
})

describe('POST /cli-tokens — containment', () => {
  it('refuses to mint a token when the caller is itself using a CLI token', async () => {
    // Otherwise a leaked token can mint a replacement, and revoking the stolen one
    // contains nothing — which is exactly what the docs promise it does.
    const res = await makeApp('usr_1', 'cli_token').request('/api/cli-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'second' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('SESSION_REQUIRED')
    expect(dbInsert).not.toHaveBeenCalled()
  })

  it('still lets a CLI token list and delete, so automation can clean up after itself', async () => {
    const list = await makeApp('usr_1', 'cli_token').request('/api/cli-tokens')
    expect(list.status).toBe(200)
    const del = await makeApp('usr_1', 'cli_token').request('/api/cli-tokens/clt_1', {
      method: 'DELETE',
    })
    expect(del.status).toBe(200)
  })
})

describe('GET /cli-tokens', () => {
  it('lists tokens without ever returning a usable credential', async () => {
    const res = await makeApp().request('/api/cli-tokens')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('CI runner')
    expect(body).not.toContain('tokenHash')
  })
})

describe('DELETE /cli-tokens/:id', () => {
  it('revokes the caller’s own token and audits it', async () => {
    const res = await makeApp().request('/api/cli-tokens/clt_1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const setArg = callArg(dbUpdate, 'set')
    expect(setArg.revokedAt).toBeInstanceOf(Date)
    expect(logAuditMock.mock.calls.at(-1)?.[1].action).toBe('cli_token.revoked')
  })

  it('cannot revoke a token belonging to someone else', async () => {
    // The compare-and-set is scoped by userId, so another user's id matches nothing.
    dbUpdate.mockImplementation(() => makeChain([]))
    const res = await makeApp('usr_other').request('/api/cli-tokens/clt_1', { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it('is idempotent rather than double-auditing an already-revoked token', async () => {
    dbUpdate.mockImplementation(() => makeChain([]))
    const res = await makeApp().request('/api/cli-tokens/clt_1', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('GET /cli-tokens/session-policy', () => {
  it('reports the session lifetime so the UI need not read .env', async () => {
    const res = await makeApp().request('/api/cli-tokens/session-policy')
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { sessionTtlDays: number } }
    expect(data.sessionTtlDays).toBe(1)
  })
})
