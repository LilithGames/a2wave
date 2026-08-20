import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbDelete = vi.fn()
vi.mock('../../db/client.js', () => ({ db: { delete: (...a: unknown[]) => dbDelete(...a) } }))

vi.mock('../../db/schema.js', () => ({
  deviceAuthorizations: { expiresAt: 'device_authorizations.expires_at' },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { sweepExpiredDeviceAuthorizations, startDeviceAuthorizationSweeper } = await import(
  '../device-authorization-sweep.js'
)

function deleteChain(rows: number) {
  const chain = {
    where: vi.fn(() => chain),
    returning: vi.fn(async () => Array.from({ length: rows }, (_, i) => ({ id: `dev_${i}` }))),
  }
  return chain
}

beforeEach(() => {
  dbDelete.mockReset()
})

describe('sweepExpiredDeviceAuthorizations', () => {
  it('deletes rows past their deadline and reports the count', async () => {
    dbDelete.mockReturnValue(deleteChain(3))
    expect(await sweepExpiredDeviceAuthorizations(new Date())).toBe(3)
  })

  it('deletes an expired row regardless of how it ended', async () => {
    // Retention here is not a policy choice: an approved-but-unclaimed row is as
    // dead as a denied one once the deadline passes, and keeping either only
    // grows the table.
    const chain = deleteChain(1)
    dbDelete.mockReturnValue(chain)
    await sweepExpiredDeviceAuthorizations(new Date())
    // A status filter would leave the other terminal states behind forever.
    expect(chain.where).toHaveBeenCalledTimes(1)
  })

  it('does not throw when there is nothing to delete', async () => {
    dbDelete.mockReturnValue(deleteChain(0))
    expect(await sweepExpiredDeviceAuthorizations(new Date())).toBe(0)
  })
})

describe('startDeviceAuthorizationSweeper', () => {
  it('sweeps on a timer and stops cleanly', async () => {
    vi.useFakeTimers()
    dbDelete.mockReturnValue(deleteChain(1))
    const stop = startDeviceAuthorizationSweeper(1000)
    await vi.advanceTimersByTimeAsync(2500)
    expect(dbDelete).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(dbDelete).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('keeps sweeping after a failed tick instead of dying silently', async () => {
    vi.useFakeTimers()
    dbDelete.mockImplementationOnce(() => {
      throw new Error('db down')
    })
    dbDelete.mockReturnValue(deleteChain(1))
    const stop = startDeviceAuthorizationSweeper(1000)
    await vi.advanceTimersByTimeAsync(2500)
    expect(dbDelete).toHaveBeenCalledTimes(2)
    stop()
    vi.useRealTimers()
  })
})
