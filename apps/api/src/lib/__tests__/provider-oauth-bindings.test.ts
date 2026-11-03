import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({ db: {} }))

import { createTestAgent } from '../../test/factories.js'
import { sanitizeAgent } from '../agent-export.js'
import { maskProviderChainConfig } from '../agent-provider-config.js'

describe('OAuth account binding serialization', () => {
  const config = {
    providerChain: [
      { providerId: 'prv_codex', authMode: 'oauth', providerOauthAccountId: 'poa_account' },
    ],
  }
  it('keeps an account reference for normal authenticated reads', () => {
    expect(maskProviderChainConfig(config)).toEqual(config)
  })
  it('clears the account reference when cloning credentials', () => {
    expect(maskProviderChainConfig(config, null)).toEqual({
      providerChain: [{ providerId: 'prv_codex', authMode: 'oauth', providerOauthAccountId: null }],
    })
  })
  it('preserves the top-level OAuth mode without exporting its account reference', () => {
    const exported = sanitizeAgent(
      createTestAgent({ authMode: 'oauth', providerOauthAccountId: 'poa_account' }) as Parameters<
        typeof sanitizeAgent
      >[0],
    )
    expect(exported).toHaveProperty('authMode', 'oauth')
    expect(exported).not.toHaveProperty('providerOauthAccountId')
  })
  it('does not export an instance-local account binding', () => {
    const exported = sanitizeAgent(
      createTestAgent({ config }) as Parameters<typeof sanitizeAgent>[0],
    )
    expect(exported.config).toEqual({
      providerChain: [{ providerId: 'prv_codex', authMode: 'oauth', providerOauthAccountId: null }],
    })
  })
})
