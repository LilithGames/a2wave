import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockDrizzleDb,
  type MockDrizzleDb,
  makeInsertChain,
  makeSelectChain,
} from '../../test/index.js'

vi.mock('../../db/client.js', () => ({ db: createMockDrizzleDb() }))

const requireAgentWrite = vi.fn(async (_c: unknown, _id: string) => ({
  agent: { id: 'agt_1' },
  permission: 'owner',
}))
vi.mock('../../lib/agent-access.js', () => ({
  requireAgentWrite: (c: unknown, id: string) => requireAgentWrite(c, id),
}))

const logAudit = vi.fn()
vi.mock('../../lib/audit.js', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }))

vi.mock('../../db/transaction.js', () => ({
  runExclusive: (fn: () => Promise<unknown>) => fn(),
}))

import { db } from '../../db/client.js'
import agentApiKeyRoutes from '../agent-api-keys.js'

const mockDb = db as unknown as MockDrizzleDb

function makeApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, 'usr_1' as never)
    await next()
  })
  app.route('/api/agents', agentApiKeyRoutes)
  return app
}

const storedRow = {
  id: 'aak_1',
  name: 'CI pipeline',
  channel: 'api',
  keyPrefix: 'ak_9f3a2b1',
  expiresAt: null,
  lastUsedAt: null,
  lastUsedIp: null,
  revokedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
}

describe('GET /:id/api-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAgentWrite.mockResolvedValue({ agent: { id: 'agt_1' }, permission: 'owner' })
  })

  it('lists the Agent keys without ever returning a credential', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([storedRow]))

    const res = await makeApp().request('/api/agents/agt_1/api-keys?channel=api')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<Record<string, unknown>> }

    expect(body.data[0]).toMatchObject({ id: 'aak_1', name: 'CI pipeline' })
    // The whole point of hashing: nothing here can reconstruct a key.
    expect(JSON.stringify(body)).not.toContain('keyHash')
    expect(JSON.stringify(body)).not.toContain('key_hash')
  })

  it('requires write access — key metadata is operational, not viewer-visible', async () => {
    requireAgentWrite.mockRejectedValue(new Error('forbidden'))

    const res = await makeApp().request('/api/agents/agt_1/api-keys?channel=api')
    expect(res.status).not.toBe(200)
    expect(requireAgentWrite).toHaveBeenCalledWith(expect.anything(), 'agt_1')
  })

  it('rejects an unknown channel rather than silently listing the wrong one', async () => {
    const res = await makeApp().request('/api/agents/agt_1/api-keys?channel=telepathy')
    expect(res.status).toBe(400)
  })
})

describe('POST /:id/api-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAgentWrite.mockResolvedValue({ agent: { id: 'agt_1' }, permission: 'owner' })
    mockDb.select.mockReturnValue(makeSelectChain([]))
    mockDb.insert.mockReturnValue(makeInsertChain(storedRow))
  })

  async function post(body: unknown) {
    return makeApp().request('/api/agents/agt_1/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns the plaintext exactly once, on creation', async () => {
    const res = await post({ channel: 'api', name: 'CI pipeline' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { key: string; id: string } }

    expect(body.data.key.startsWith('ak_')).toBe(true)
    expect(body.data.id.startsWith('aak_')).toBe(true)
  })

  it('mints an a2a-prefixed key for the a2a channel', async () => {
    const res = await post({ channel: 'a2a', name: 'Sibling agent' })
    const body = (await res.json()) as { data: { key: string } }

    expect(body.data.key.startsWith('a2ak_')).toBe(true)
  })

  it('requires a name — an unnamed key is indistinguishable from another later', async () => {
    expect((await post({ channel: 'api' })).status).toBe(400)
    expect((await post({ channel: 'api', name: '   ' })).status).toBe(400)
  })

  it('accepts an optional expiry', async () => {
    const res = await post({ channel: 'api', name: 'Temp', expiresInDays: 30 })
    expect(res.status).toBe(200)
  })

  it('rejects a name longer than the limit — it has to fit the key list and the run-history source column', async () => {
    expect((await post({ channel: 'api', name: 'x'.repeat(24) })).status).toBe(200)
    expect((await post({ channel: 'api', name: 'x'.repeat(25) })).status).toBe(400)
  })

  it('rejects an expiry beyond a year — past that a key should be re-minted deliberately', async () => {
    expect((await post({ channel: 'api', name: 'Forever', expiresInDays: 400 })).status).toBe(400)
  })

  it('refuses once the Agent is at the active-key cap for that channel', async () => {
    mockDb.select.mockReturnValue(makeSelectChain(Array.from({ length: 20 }, () => storedRow)))

    const res = await post({ channel: 'api', name: 'One too many' })
    expect(res.status).toBe(409)
  })

  it('audits creation without recording the key', async () => {
    const res = await post({ channel: 'api', name: 'CI pipeline' })
    const { data } = (await res.json()) as { data: { key: string } }

    expect(logAudit).toHaveBeenCalled()
    const entry = JSON.stringify(logAudit.mock.calls[0]?.[1] ?? {})
    expect(entry).toContain('CI pipeline')
    // The minted credential, and its hash, must never reach the audit log — it is
    // stored as plaintext JSON and rendered verbatim to every admin.
    expect(entry).not.toContain(data.key)
    expect(entry).not.toContain('keyHash')
  })
})

describe('PATCH /:id/api-keys/:keyId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAgentWrite.mockResolvedValue({ agent: { id: 'agt_1' }, permission: 'owner' })
  })

  it('renames a key so a note can be corrected without rotating the credential', async () => {
    mockDb.update.mockReturnValue({
      set: () => ({
        where: () => ({ returning: async () => [{ ...storedRow, name: 'Renamed' }] }),
      }),
    } as never)

    const res = await makeApp().request('/api/agents/agt_1/api-keys/aak_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })

    expect(res.status).toBe(200)
  })

  it('404s for a key that belongs to another Agent', async () => {
    mockDb.update.mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    } as never)

    const res = await makeApp().request('/api/agents/agt_1/api-keys/aak_other', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    })

    expect(res.status).toBe(404)
  })
})

describe('DELETE /:id/api-keys/:keyId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAgentWrite.mockResolvedValue({ agent: { id: 'agt_1' }, permission: 'owner' })
  })

  it('revokes a key and audits it', async () => {
    mockDb.update.mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [storedRow] }) }),
    } as never)

    const res = await makeApp().request('/api/agents/agt_1/api-keys/aak_1', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalled()
  })

  it('404s on a repeat revoke, so it cannot be re-audited', async () => {
    mockDb.update.mockReturnValue({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
    } as never)

    const res = await makeApp().request('/api/agents/agt_1/api-keys/aak_1', { method: 'DELETE' })

    expect(res.status).toBe(404)
    expect(logAudit).not.toHaveBeenCalled()
  })
})
