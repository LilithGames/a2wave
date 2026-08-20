import { describe, expect, it } from 'vitest'
import {
  CLI_TOKEN_PREFIX,
  generateCliToken,
  hashCliToken,
  isCliToken,
  tokenPrefixOf,
} from '../cli-token.js'

describe('generateCliToken', () => {
  it('is recognisable at a glance and url-safe', () => {
    const token = generateCliToken()
    expect(token.startsWith(CLI_TOKEN_PREFIX)).toBe(true)
    expect(token.slice(CLI_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('carries at least 256 bits of entropy', () => {
    expect(generateCliToken().length - CLI_TOKEN_PREFIX.length).toBeGreaterThanOrEqual(43)
  })

  it('is unique per call', () => {
    expect(generateCliToken()).not.toBe(generateCliToken())
  })
})

describe('isCliToken', () => {
  it('separates a CLI token from a session JWT', () => {
    // The auth path branches on this: misrouting a JWT into the CLI-token lookup
    // would cost a database read on every request.
    expect(isCliToken(generateCliToken())).toBe(true)
    expect(isCliToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig')).toBe(false)
    expect(isCliToken('')).toBe(false)
  })
})

describe('hashCliToken', () => {
  it('is a stable hex sha256', () => {
    expect(hashCliToken('abc')).toBe(hashCliToken('abc'))
    expect(hashCliToken('abc')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates distinct tokens', () => {
    expect(hashCliToken('abc')).not.toBe(hashCliToken('abd'))
  })
})

describe('tokenPrefixOf', () => {
  it('shows enough to tell two tokens apart', () => {
    const token = generateCliToken()
    expect(token.startsWith(tokenPrefixOf(token))).toBe(true)
  })

  it('withholds enough that the token cannot be reconstructed', () => {
    // The prefix is rendered in a list every admin can read; it must stay far
    // short of the 256-bit secret.
    const token = generateCliToken()
    expect(tokenPrefixOf(token).length).toBeLessThan(token.length / 2)
  })
})
