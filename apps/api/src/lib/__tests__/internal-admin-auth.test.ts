import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The internal credentials are handed to MCP processes through the workspace
 * MCP config file, which lives on storage every API replica shares. A random
 * per-process secret therefore makes the router MCP spawned by replica A
 * present a token replica B rejects with 403 (and vice versa) as soon as the
 * later sync overwrites the shared file. Deriving both from `AUTH_SECRET` — a
 * value every replica of one deployment already shares — makes every replica
 * accept every replica's token while keeping the secret out of the database.
 */
async function loadWithAuthSecret(secret: string) {
  vi.resetModules()
  process.env.AUTH_SECRET = secret
  return await import('../internal-admin-auth.js')
}

const originalAuthSecret = process.env.AUTH_SECRET

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = originalAuthSecret
  vi.resetModules()
})

const SECRET_A = 'a'.repeat(48)
const SECRET_B = 'b'.repeat(48)

describe('internal process credentials', () => {
  it('derives the same tokens in every process sharing AUTH_SECRET', async () => {
    const replicaOne = await loadWithAuthSecret(SECRET_A)
    const replicaTwo = await loadWithAuthSecret(SECRET_A)

    expect(replicaTwo.getInternalToken()).toBe(replicaOne.getInternalToken())
    expect(replicaTwo.getInternalAdminToken()).toBe(replicaOne.getInternalAdminToken())
  })

  it('accepts the peer replica token it did not generate itself', async () => {
    const replicaOne = await loadWithAuthSecret(SECRET_A)
    const peerToken = replicaOne.getInternalToken()
    const peerAdminToken = replicaOne.getInternalAdminToken()

    const replicaTwo = await loadWithAuthSecret(SECRET_A)

    expect(replicaTwo.verifyInternalToken(peerToken)).toBe(true)
    expect(replicaTwo.verifyInternalAdminToken(peerAdminToken)).toBe(true)
  })

  it('keeps the admin credential separate from the router credential', async () => {
    const auth = await loadWithAuthSecret(SECRET_A)

    expect(auth.getInternalToken()).not.toBe(auth.getInternalAdminToken())
    expect(auth.verifyInternalAdminToken(auth.getInternalToken())).toBe(false)
    expect(auth.verifyInternalToken(auth.getInternalAdminToken())).toBe(false)
  })

  it('rejects a token derived from a different AUTH_SECRET', async () => {
    const foreignDeployment = await loadWithAuthSecret(SECRET_B)
    const foreignToken = foreignDeployment.getInternalToken()

    const deployment = await loadWithAuthSecret(SECRET_A)

    expect(deployment.verifyInternalToken(foreignToken)).toBe(false)
    expect(deployment.verifyInternalToken(undefined)).toBe(false)
    expect(deployment.verifyInternalAdminToken('')).toBe(false)
  })
})
