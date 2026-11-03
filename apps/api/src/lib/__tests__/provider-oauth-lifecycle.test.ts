import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  update: vi.fn(),
  select: vi.fn(),
  returning: vi.fn(),
  save: vi.fn(),
}))
vi.mock('../../db/client.js', () => ({ db: { update: m.update, select: m.select } }))
vi.mock('../../db/transaction.js', async () => {
  const { db } = await import('../../db/client.js')
  return {
    withTransaction: async (fn: (tx: typeof db) => unknown) => fn(db),
    runExclusive: async (fn: () => unknown) => fn(),
  }
})

import { db } from '../../db/client.js'
import { withProviderOauthBindings } from '../provider-oauth-binding.js'
import { claimOauthRefresh } from '../provider-oauth-store.js'

const binding = {
  providerId: 'prv_codex',
  authMode: 'oauth',
  providerOauthAccountId: 'poa_account',
}
beforeEach(() => {
  vi.clearAllMocks()
  m.update.mockReturnValue({ set: () => ({ where: () => ({ returning: m.returning }) }) })
  m.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) })
  m.returning.mockResolvedValue([{ id: 'poa_account', refreshLeaseId: null }])
  m.save.mockResolvedValue('saved')
})
describe('OAuth account lifecycle and Agent bindings', () => {
  it('locks all referenced account rows before saving in the same transaction', async () => {
    await expect(withProviderOauthBindings(binding, db, m.save)).resolves.toBe('saved')
    expect(m.returning.mock.invocationCallOrder[0]).toBeLessThan(m.save.mock.invocationCallOrder[0])
    expect(m.save).toHaveBeenCalledWith(db)
  })
  it.each([
    { rows: [], message: 'no longer exists' },
    {
      rows: [{ id: 'poa_account', refreshLeaseId: 'delete_pending' }],
      message: 'being disconnected',
    },
  ])(
    'never saves a reference after deletion won the lifecycle lock: %j',
    async ({ rows, message }) => {
      m.returning.mockResolvedValue(rows)
      await expect(
        withProviderOauthBindings({ config: { providerChain: [binding] } }, db, m.save),
      ).rejects.toThrow(message)
      expect(m.save).not.toHaveBeenCalled()
    },
  )
  it('refuses deletion when a committed Agent reference is found after acquiring the row', async () => {
    m.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'agt_bound' }] }) }),
    })
    await expect(claimOauthRefresh('poa_account', 'delete_pending', new Date(), 0)).rejects.toThrow(
      /Agent bindings/,
    )
    expect(m.returning.mock.invocationCallOrder[0]).toBeLessThan(
      m.select.mock.invocationCallOrder[0],
    )
  })
})
