import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ jwk: { kty: 'RSA' } as JWK }))
vi.mock('jose', async (original) => {
  const actual = await original<typeof import('jose')>()
  return { ...actual, createRemoteJWKSet: () => actual.createLocalJWKSet({ keys: [state.jwk] }) }
})

import { exchangeProviderOauthCode } from '../provider-oauth-protocol.js'

let keys: Awaited<ReturnType<typeof generateKeyPair>>
beforeAll(async () => {
  keys = await generateKeyPair('RS256')
  state.jwk = await exportJWK(keys.publicKey)
})
describe('SIWC identity validation with real JWT signatures', () => {
  it.each(['exp', 'sub', 'nonce', 'iss', 'aud'])(
    'rejects a signed identity token without %s',
    async (claim) => {
      const claims: Record<string, unknown> = {
        sub: 'person',
        nonce: 'nonce',
        iss: 'https://auth.openai.com',
        aud: 'oaiapp_example',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }
      delete claims[claim]
      const idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .sign(keys.privateKey)
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async (url: string) =>
            new Response(
              JSON.stringify(
                url.includes('openid-configuration')
                  ? { issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks' }
                  : {
                      access_token: 'a',
                      refresh_token: 'r',
                      id_token: idToken,
                      token_type: 'Bearer',
                      expires_in: 3600,
                      scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct',
                    },
              ),
            ),
        ),
      )
      await expect(
        exchangeProviderOauthCode({
          clientId: 'oaiapp_example',
          hostId: 'host',
          redirectUri: 'http://127.0.0.1:4567/auth/callback',
          verifier: 'v',
          state: 's',
          nonce: 'nonce',
          code: 'c',
        }),
      ).rejects.toThrow()
    },
  )
})
