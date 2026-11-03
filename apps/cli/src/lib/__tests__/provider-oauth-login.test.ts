import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectProviderOauth } from '../provider-oauth-login.js'

const nativeFetch = globalThis.fetch

afterEach(() => vi.restoreAllMocks())

describe('provider OAuth loopback login', () => {
  it('listens locally before opening the browser and forwards the callback without storing tokens', async () => {
    const requests: { path: string; body: Record<string, unknown>; bearer: string | null }[] = []
    let redirectUri = ''
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input)
      const body = JSON.parse(String(init?.body))
      requests.push({ path, body, bearer: new Headers(init?.headers).get('authorization') })
      if (path.endsWith('/start')) {
        redirectUri = String(body.redirectUri)
        const authorize = new URL('https://auth.openai.com/api/accounts/authorize')
        authorize.searchParams.set('redirect_uri', redirectUri)
        authorize.searchParams.set('state', 'expected-state')
        authorize.searchParams.set('id_token_hint', 'private-identity-hint')
        return Response.json({ data: { authorizationUrl: authorize.toString() } })
      }
      return Response.json({ data: { accountId: 'poa_one' } })
    })
    let opened = ''
    const result = await connectProviderOauth({
      server: 'https://a2wave.example/',
      loginId: 'pol_one',
      loginToken: 'one-time-secret',
      openBrowser: (url) => {
        opened = url
        void (async () => {
          const landing = await nativeFetch(url, { redirect: 'manual' })
          expect(landing.status).toBe(302)
          expect(landing.headers.get('location')).toContain('auth.openai.com')
          const wrong = await nativeFetch(`${redirectUri}?code=stray&state=wrong`)
          expect(wrong.status).toBe(400)
          const callback = await nativeFetch(
            `${redirectUri}?code=authorization-code&state=expected-state&client_id=oaiapp_one`,
          )
          expect(callback.status).toBe(200)
          expect(await callback.text()).not.toContain('authorization-code')
        })()
        return true
      },
    })
    expect(result).toEqual({ accountId: 'poa_one' })
    expect(new URL(redirectUri).hostname).toBe('127.0.0.1')
    expect(new URL(redirectUri).pathname).toBe('/auth/callback')
    expect(opened).not.toContain('private-identity-hint')
    expect(requests[1].body).toEqual({
      code: 'authorization-code',
      state: 'expected-state',
      clientId: 'oaiapp_one',
    })
    expect(requests.every((r) => r.bearer === 'Bearer one-time-secret')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(nativeFetch(redirectUri)).rejects.toThrow()
  })

  it('rejects a server-supplied authorization URL on an unexpected origin', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: { authorizationUrl: 'https://other.example/authorize?state=s' } }),
    )
    const openBrowser = vi.fn()
    await expect(
      connectProviderOauth({
        server: 'https://a2wave.example',
        loginId: 'pol_one',
        loginToken: 'secret',
        openBrowser,
      }),
    ).rejects.toThrow('authorization URL')
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it('reports timeout and closes its local listener', async () => {
    let callback = ''
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      callback = JSON.parse(String(init?.body)).redirectUri
      return Response.json({
        data: {
          authorizationUrl: `https://auth.openai.com/api/accounts/authorize?state=s&redirect_uri=${encodeURIComponent(callback)}`,
        },
      })
    })
    await expect(
      connectProviderOauth({
        server: 'https://a2wave.example',
        loginId: 'pol_one',
        loginToken: 'secret',
        timeoutMs: 40,
        openBrowser: () => true,
      }),
    ).rejects.toThrow('timed out')
    await expect(nativeFetch(callback)).rejects.toThrow()
  })

  it('never echoes a raw server failure containing credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('secret-token-from-upstream', { status: 502 }),
    )
    await expect(
      connectProviderOauth({
        server: 'https://a2wave.example',
        loginId: 'pol_one',
        loginToken: 'secret',
        openBrowser: () => true,
      }),
    ).rejects.toThrow('502')
    await expect(
      connectProviderOauth({
        server: 'https://a2wave.example',
        loginId: 'pol_one',
        loginToken: 'secret',
        openBrowser: () => true,
      }),
    ).rejects.not.toThrow('secret-token-from-upstream')
  })
})
