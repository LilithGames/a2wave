/**
 * CLI tokens authenticate through the same entry point as session JWTs, so the
 * interesting cases are the ways a token must stop working: revoked, expired,
 * or belonging to an account that has since been disabled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
const dbUpdate = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    update: (...a: unknown[]) => dbUpdate(...a),
  },
}))

vi.mock('../../db/schema.js', () => ({
  users: { id: 'users.id' },
  cliTokens: { id: 'cli_tokens.id', tokenHash: 'cli_tokens.token_hash' },
}))

const verifyTokenMock = vi.fn()
vi.mock('../auth.js', () => ({ verifyToken: (t: string) => verifyTokenMock(t) }))

const { authenticateSessionToken } = await import('../session-auth.js')
const { generateCliToken } = await import('../cli-token.js')

/**
 * Every builder method must return the *thenable*, not a bare object — otherwise
 * awaiting the end of the chain yields something non-iterable and the production
 * try/catch swallows it as an auth failure.
 */
function chain(rows: unknown[]) {
  const thenable = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>
  for (const k of ['from', 'where', 'limit', 'innerJoin', 'set']) {
    thenable[k] = vi.fn(() => thenable)
  }
  return thenable
}

/** Mirrors the flat projection the join selects, not the table shapes. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'clt_1',
    expiresAt: null,
    revokedAt: null,
    userId: 'usr_1',
    role: 'user',
    isActive: true,
    ...over,
  }
}

beforeEach(() => {
  dbSelect.mockReset()
  dbUpdate.mockReset().mockImplementation(() => chain([]))
  verifyTokenMock.mockReset()
})

describe('authenticateSessionToken with a CLI token', () => {
  it('authenticates a live token without touching JWT verification', async () => {
    dbSelect.mockImplementation(() => chain([row()]))
    const result = await authenticateSessionToken(generateCliToken())
    // authMethod is what lets a route refuse an action a long-lived credential
    // must not perform on its own — minting another token.
    expect(result).toEqual({ id: 'usr_1', role: 'user', authMethod: 'cli_token' })
    // A CLI token is opaque, not a JWT; verifying it as one would always throw.
    expect(verifyTokenMock).not.toHaveBeenCalled()
  })

  it('rejects a revoked token', async () => {
    dbSelect.mockImplementation(() => chain([row({ revokedAt: new Date() })]))
    expect(await authenticateSessionToken(generateCliToken())).toBeNull()
  })

  it('rejects an expired token', async () => {
    dbSelect.mockImplementation(() => chain([row({ expiresAt: new Date(Date.now() - 1000) })]))
    expect(await authenticateSessionToken(generateCliToken())).toBeNull()
  })

  it('accepts a token whose expiry has not arrived', async () => {
    dbSelect.mockImplementation(() => chain([row({ expiresAt: new Date(Date.now() + 60_000) })]))
    expect(await authenticateSessionToken(generateCliToken())).not.toBeNull()
  })

  it('accepts a token with no expiry at all', async () => {
    dbSelect.mockImplementation(() => chain([row({ expiresAt: null })]))
    expect(await authenticateSessionToken(generateCliToken())).not.toBeNull()
  })

  it('rejects a token whose owner was disabled', async () => {
    // Disabling an account must cut off its automation too, not just its browser.
    dbSelect.mockImplementation(() => chain([row({ isActive: false })]))
    expect(await authenticateSessionToken(generateCliToken())).toBeNull()
  })

  it('rejects an unknown token', async () => {
    dbSelect.mockImplementation(() => chain([]))
    expect(await authenticateSessionToken(generateCliToken())).toBeNull()
  })

  it('records use so an unused token can be identified and revoked', async () => {
    dbSelect.mockImplementation(() => chain([row()]))
    await authenticateSessionToken(generateCliToken())
    expect(dbUpdate).toHaveBeenCalled()
  })

  it('still authenticates a session JWT unchanged', async () => {
    verifyTokenMock.mockResolvedValue({ sub: 'usr_1', tv: 3 })
    dbSelect.mockImplementation(() =>
      chain([{ id: 'usr_1', role: 'admin', tokenVersion: 3, isActive: true }]),
    )
    expect(await authenticateSessionToken('not-a-cli-token')).toEqual({
      id: 'usr_1',
      role: 'admin',
      authMethod: 'session',
    })
  })
})
