import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockDrizzleDb, type MockDrizzleDb, makeSelectChain } from '../../test/index.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../db/client.js', () => ({ db: createMockDrizzleDb() }))

const runExclusive = vi.fn(async (fn: () => Promise<unknown>) => await fn())
vi.mock('../../db/transaction.js', () => ({
  runExclusive: (fn: () => Promise<unknown>) => runExclusive(fn),
}))

import { db } from '../../db/client.js'
import { generateAgentApiKey, hashAgentApiKey, keyPrefixOf } from '../agent-api-key.js'
import { verifyAgentApiKey } from '../agent-api-key-verify.js'

const mockDb = db as unknown as MockDrizzleDb

const PLAINTEXT = 'ak_livekeyplaintextvalue'

/** A stored row for PLAINTEXT, live unless overridden. */
function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aak_1',
    agentId: 'agt_1',
    channel: 'api',
    keyHash: hashAgentApiKey(PLAINTEXT),
    keyPrefix: keyPrefixOf(PLAINTEXT),
    name: 'CI pipeline',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  }
}

describe('verifyAgentApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runExclusive.mockClear()
  })

  it('accepts a live key and returns the identity the run record needs', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([keyRow()]))

    const result = await verifyAgentApiKey('agt_1', 'api', PLAINTEXT)

    expect(result).toMatchObject({ ok: true, keyId: 'aak_1', keyName: 'CI pipeline' })
  })

  // Consumers partition per-key state (A2A task owner scope, run idempotency) by
  // key id. A migrated key IS the Agent's pre-existing legacy credential, so it
  // must stay on the pre-migration scope or an upgrade orphans everything in
  // flight. The verdict is derived from the key hash, never the row's name — a
  // name is an editable label, and keying on it would let a rename silently
  // re-scope a live credential.
  it("flags a key that is the agent's migrated legacy credential", async () => {
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([keyRow({ name: 'anything at all' })]))
      // The agent's legacy plaintext column still holds this same key.
      .mockReturnValueOnce(makeSelectChain([{ key: PLAINTEXT }]))

    const result = await verifyAgentApiKey('agt_1', 'api', PLAINTEXT)

    expect(result).toMatchObject({ ok: true, isLegacyMigrated: true })
  })

  it('does not flag an ordinary key, whatever it is named', async () => {
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([keyRow({ name: 'Migrated key' })]))
      // A different credential sits in the legacy column.
      .mockReturnValueOnce(makeSelectChain([{ key: 'ak_someothervalue' }]))

    const result = await verifyAgentApiKey('agt_1', 'api', PLAINTEXT)

    expect(result).toMatchObject({ ok: true, isLegacyMigrated: false })
  })

  it('rejects a key whose plaintext prefix does not match the channel, without touching the database', async () => {
    const result = await verifyAgentApiKey('agt_1', 'api', 'a2ak_wrongchannelprefix')

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    // The prefix check is the cheap short-circuit; a mismatched key must never cost a query.
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('rejects an unknown key', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]))

    const result = await verifyAgentApiKey('agt_1', 'api', generateAgentApiKey('api'))

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('reports expiry distinctly, so an integrator is not sent hunting for a credential bug', async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([keyRow({ expiresAt: new Date('2020-01-01T00:00:00Z') })]),
    )

    const result = await verifyAgentApiKey('agt_1', 'api', PLAINTEXT)

    expect(result).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('reports a revoked key as merely invalid — revoked must be indistinguishable from never-existed', async () => {
    mockDb.select.mockReturnValue(
      makeSelectChain([keyRow({ revokedAt: new Date('2026-01-01T00:00:00Z') })]),
    )

    const result = await verifyAgentApiKey('agt_1', 'api', PLAINTEXT)

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('stamps lastUsedAt on a successful verification', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([keyRow()]))

    await verifyAgentApiKey('agt_1', 'api', PLAINTEXT, { clientIp: '10.0.0.4' })

    expect(mockDb.update).toHaveBeenCalled()
  })

  it('does not stamp again within the throttle window — a hot endpoint must not write per request', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([keyRow({ lastUsedAt: new Date() })]))

    await verifyAgentApiKey('agt_1', 'api', PLAINTEXT)

    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('never fails the request when the last-used stamp fails: it is best-effort telemetry', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([keyRow()]))
    mockDb.update.mockImplementation(() => {
      throw new Error('database is locked')
    })

    await expect(verifyAgentApiKey('agt_1', 'api', PLAINTEXT)).resolves.toMatchObject({ ok: true })
  })
})
