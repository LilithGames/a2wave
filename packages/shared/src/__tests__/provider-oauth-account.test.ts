import { describe, expect, it } from 'vitest'
import { createAgentInput, providerChainItemSchema } from '../schemas/agent.js'
import { probeModelsRequestSchema } from '../schemas/probe-models.js'

describe('Provider OAuth account references', () => {
  it('preserves an account reference in legacy and chain bindings', () => {
    expect(
      createAgentInput.parse({ name: 'Agent', providerOauthAccountId: 'poa_account' })
        .providerOauthAccountId,
    ).toBe('poa_account')
    expect(
      providerChainItemSchema.parse({
        providerId: 'prv_codex',
        authMode: 'oauth',
        providerOauthAccountId: 'poa_account',
      }).providerOauthAccountId,
    ).toBe('poa_account')
  })
  it('lets model probes reference stored credentials without exposing tokens', () => {
    expect(
      probeModelsRequestSchema.parse({
        kind: 'codex',
        authMode: 'oauth',
        oauthAccountId: 'poa_account',
      }),
    ).toEqual({ kind: 'codex', authMode: 'oauth', oauthAccountId: 'poa_account' })
  })
})
