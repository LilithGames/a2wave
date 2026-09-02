import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, buildLoginRedirect, isAuthRedirectExempt } from '../api'

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

describe('401 redirect', () => {
  const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')

  function stubLocation(pathname: string, search = '') {
    const location = { pathname, search, href: `http://localhost${pathname}${search}` }
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: location,
    })
    return location
  }

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation)
  })

  // Without returnTo this full-page navigation silently overrides the
  // `<Navigate to="/login?returnTo=…">` AuthGuard renders, so a shared deep link
  // always lands on the dashboard after signing in.
  it('carries the current deep link as returnTo', async () => {
    const location = stubLocation('/agents/agt_1', '?tab=runs')

    await expect(api.get('/agents/agt_1')).rejects.toThrow('UNAUTHORIZED')

    expect(location.href).toBe(`/login?returnTo=${encodeURIComponent('/agents/agt_1?tab=runs')}`)
  })

  it('carries the current deep link as returnTo from api.text', async () => {
    const location = stubLocation('/runs/run_1', '?log=1')

    await expect(api.text('/runs/run_1/log')).rejects.toThrow('HTTP_401')

    expect(location.href).toBe(`/login?returnTo=${encodeURIComponent('/runs/run_1?log=1')}`)
  })

  // api.text carried its own copy of the exemption list and missed the /invite/
  // prefix, so an invitee hitting a text endpoint was bounced off the page the
  // invitation link exists to reach.
  it.each(['/login', '/setup', '/share-login', '/invite/abc123'])(
    'does not redirect away from the public route %s',
    async (pathname) => {
      const location = stubLocation(pathname)
      const { href } = location

      await expect(api.get('/auth/me')).rejects.toThrow('UNAUTHORIZED')
      await expect(api.text('/auth/me')).rejects.toThrow('HTTP_401')

      expect(location.href).toBe(href)
    },
  )
})

// One construction, two call sites: the 401 handler here and AuthGuard's
// `<Navigate>`. When they were written separately, a difference between them
// meant a shared deep link landed somewhere other than where it was sent.
describe('buildLoginRedirect', () => {
  it('encodes the pathname and query into returnTo', () => {
    expect(buildLoginRedirect('/agents/agt_1', '?tab=runs')).toBe(
      `/login?returnTo=${encodeURIComponent('/agents/agt_1?tab=runs')}`,
    )
  })

  it('omits an absent query string rather than encoding a bare "?"', () => {
    expect(buildLoginRedirect('/runs/run_1')).toBe(
      `/login?returnTo=${encodeURIComponent('/runs/run_1')}`,
    )
  })
})
