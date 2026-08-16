/**
 * Reasoning effort and fast mode travel with the provider binding.
 *
 * `applyProviderBinding` is the single switch point for both provider fallback
 * (execute-with-retry) and evaluation snapshot restore, so whatever it fails to
 * carry — or fails to clear — is what a run silently executes with. These tests
 * pin both directions.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({ db: {} }))
vi.mock('../../env.js', () => ({ env: {} }))

import {
  type AgentConfig,
  type ResolvedProviderBinding,
  applyProviderBinding,
  clearProviderBinding,
} from '../agent-helpers.js'

function binding(overrides: Partial<ResolvedProviderBinding> = {}): ResolvedProviderBinding {
  return {
    id: 'pc_1',
    providerId: 'prv_claude',
    providerName: 'Claude Code',
    providerKind: 'claude-code',
    engineType: 'claude-code',
    authMode: 'apiKey',
    mcpDelivery: { mode: 'workspace-file', defaultPath: '.mcp.json' },
    ...overrides,
  }
}

describe('provider binding reasoning controls', () => {
  it('carries both controls onto the config the engine reads', () => {
    const config: AgentConfig = {}

    applyProviderBinding(
      config,
      binding({ model: 'claude-opus-4-8', reasoningEffort: 'xhigh', fastMode: true }),
    )

    expect(config.model).toBe('claude-opus-4-8')
    expect(config.reasoningEffort).toBe('xhigh')
    expect(config.fastMode).toBe(true)
  })

  it('leaves both unset when the binding configures neither', () => {
    const config: AgentConfig = {}

    applyProviderBinding(config, binding({ model: 'claude-opus-4-8' }))

    expect(config.reasoningEffort).toBeUndefined()
    expect(config.fastMode).toBeUndefined()
  })

  it('does not carry the previous entry’s effort across a provider fallback', () => {
    const config: AgentConfig = {}

    applyProviderBinding(
      config,
      binding({ model: 'gpt-5.6-sol', providerKind: 'codex', reasoningEffort: 'ultra' }),
    )
    // `ultra` exists for codex and for no Claude model. Leaking it onto the next
    // binding would hand the Claude CLI a level it rejects, turning a graceful
    // fallback into a hard failure on the entry that was supposed to rescue the run.
    applyProviderBinding(config, binding({ model: 'claude-opus-4-8' }))

    expect(config.reasoningEffort).toBeUndefined()
    expect(config.model).toBe('claude-opus-4-8')
  })

  it('does not leave fast mode on after falling back to a binding that never asked for it', () => {
    const config: AgentConfig = {}

    applyProviderBinding(config, binding({ model: 'claude-opus-4-8', fastMode: true }))
    applyProviderBinding(config, binding({ providerKind: 'cursor', engineType: 'cursor' }))

    expect(config.fastMode).toBeUndefined()
  })

  it('clears both when the binding is cleared', () => {
    const config: AgentConfig = { reasoningEffort: 'high', fastMode: true }

    clearProviderBinding(config)

    expect(config.reasoningEffort).toBeUndefined()
    expect(config.fastMode).toBeUndefined()
  })
})
