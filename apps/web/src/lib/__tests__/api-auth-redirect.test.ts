import { describe, expect, it } from 'vitest'
import { isAuthRedirectExempt } from '../api'

describe('isAuthRedirectExempt', () => {
  it.each(['/login', '/setup', '/share-login'])('exempts the public route %s', (path) => {
    expect(isAuthRedirectExempt(path)).toBe(true)
  })

  // The invitee has no account yet, so a 401 on this page must not bounce them to /login —
  // that would make every invitation link dead-end before the form ever renders.
  it('exempts an invitation registration page regardless of the code', () => {
    expect(isAuthRedirectExempt('/invite/abc123')).toBe(true)
    expect(isAuthRedirectExempt('/invite/Zm9vYmFy-_9')).toBe(true)
  })

  it.each(['/', '/users', '/agents/agt_1', '/settings'])(
    'does not exempt the authenticated route %s',
    (path) => {
      expect(isAuthRedirectExempt(path)).toBe(false)
    },
  )

  // The prefix must not be loosened into a substring match: a path that merely *contains*
  // the segment is still an authenticated page and has to keep redirecting.
  it('does not exempt a route that only resembles the invite prefix', () => {
    expect(isAuthRedirectExempt('/invite')).toBe(false)
    expect(isAuthRedirectExempt('/agents/invite/abc')).toBe(false)
    expect(isAuthRedirectExempt('/invitations')).toBe(false)
  })
})
