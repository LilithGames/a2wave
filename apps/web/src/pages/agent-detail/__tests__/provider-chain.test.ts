import { describe, expect, it } from 'vitest'
import {
  applyProviderEntryPatch,
  buildProviderChainSubmission,
  serializeProviderChainEntries,
  validateProviderChain,
  validateProviderChainSubmission,
} from '../provider-chain'
import type { FormData, ProviderChainEntry } from '../types'

const baseFormData: FormData = {
  name: 'Agent',
  description: '',
  systemPrompt: '',
  icon: '🤖',
  providerApiKey: '',
  providerBaseUrl: '',
  providerOauthToken: '',
  authMode: 'apiKey',
  providerId: null,
  model: '',
  readOnly: false,
  force: true,
  cleanResult: false,
  maxConcurrency: 1,
  timeoutMinutes: 10,
  totalTimeoutMinutes: null,
  maxRetries: 2,
}

function chainEntry(overrides: Partial<ProviderChainEntry> = {}): ProviderChainEntry {
  return {
    id: 'chain_1',
    providerId: 'prv_1',
    model: 'claude-sonnet',
    authMode: 'apiKey',
    authHeaderStyle: 'x-api-key',
    providerApiKey: '',
    providerBaseUrl: '',
    providerOauthToken: '',
    enabled: true,
    expanded: false,
    ...overrides,
  }
}

describe('provider-chain submission helpers', () => {
  it('serializes provider chain entries as the source of truth for top-level compatibility fields', () => {
    const submission = buildProviderChainSubmission(
      [
        chainEntry({
          authMode: 'oauth',
          providerOauthToken: 'fresh-oauth-token',
          providerApiKey: 'ignored-api-key',
        }),
      ],
      { ...baseFormData, authMode: 'oauth', providerOauthToken: '' },
    )

    expect(submission.providerChain).toEqual([
      expect.objectContaining({
        providerId: 'prv_1',
        authMode: 'oauth',
        authHeaderStyle: 'x-api-key',
        providerOauthToken: 'fresh-oauth-token',
        providerApiKey: 'ignored-api-key',
      }),
    ])
    expect(submission.providerId).toBe('prv_1')
    expect(submission.model).toBe('claude-sonnet')
    expect(submission.authMode).toBe('oauth')
    expect(submission.providerOauthToken).toBe('fresh-oauth-token')
  })

  it('does not fall back to the form model when the primary entry has none', () => {
    // The Provider-change handler clears the entry's model but leaves the
    // react-hook-form field holding the OLD Provider's model. A `|| data.model`
    // fallback here therefore persisted the previous Provider's model against
    // the new binding, which then fails at spawn time.
    const submission = buildProviderChainSubmission([chainEntry({ model: '' })], {
      ...baseFormData,
      model: 'model-of-the-previous-provider',
    })

    expect(submission.model).toBeUndefined()
  })

  it('serializes missing header styles as backward-compatible x-api-key', () => {
    const [serialized] = serializeProviderChainEntries([
      chainEntry({ authHeaderStyle: undefined, providerApiKey: 'opaque-legacy-key' }),
    ])

    expect(serialized?.authHeaderStyle).toBe('x-api-key')
  })

  it('preserves legacy top-level secrets only when the primary chain entry is masked', () => {
    const submission = buildProviderChainSubmission(
      [
        chainEntry({
          providerApiKey: '********',
          providerBaseUrl: '********',
          providerOauthToken: '********',
        }),
      ],
      {
        ...baseFormData,
        providerApiKey: 'existing-api-key',
        providerBaseUrl: 'https://existing.example.com',
        providerOauthToken: 'existing-oauth-token',
      },
    )

    expect(submission.providerApiKey).toBe('existing-api-key')
    expect(submission.providerBaseUrl).toBe('https://existing.example.com')
    expect(submission.providerOauthToken).toBe('existing-oauth-token')
  })

  it('uses real provider chain credentials instead of legacy top-level values', () => {
    const submission = buildProviderChainSubmission(
      [
        chainEntry({
          providerApiKey: 'chain-api-key',
          providerBaseUrl: 'https://chain.example.com',
          providerOauthToken: 'chain-oauth-token',
        }),
      ],
      {
        ...baseFormData,
        providerApiKey: 'legacy-api-key',
        providerBaseUrl: 'https://legacy.example.com',
        providerOauthToken: 'legacy-oauth-token',
      },
    )

    expect(submission.providerApiKey).toBe('chain-api-key')
    expect(submission.providerBaseUrl).toBe('https://chain.example.com')
    expect(submission.providerOauthToken).toBe('chain-oauth-token')
  })

  it('treats cleared provider chain credentials as an explicit credential clear', () => {
    const submission = buildProviderChainSubmission(
      [
        chainEntry({
          providerApiKey: '',
          providerBaseUrl: '',
          providerOauthToken: '',
        }),
      ],
      {
        ...baseFormData,
        providerApiKey: 'legacy-api-key',
        providerBaseUrl: 'https://legacy.example.com',
        providerOauthToken: 'legacy-oauth-token',
      },
    )

    expect(submission.providerApiKey).toBeNull()
    expect(submission.providerBaseUrl).toBeNull()
    expect(submission.providerOauthToken).toBeNull()
  })

  it('falls back to legacy top-level fields when no provider chain entry is selected', () => {
    const submission = buildProviderChainSubmission([chainEntry({ providerId: null })], {
      ...baseFormData,
      providerId: 'prv_legacy',
      model: 'legacy-model',
      authMode: 'apiKey',
      providerApiKey: 'legacy-api-key',
    })

    expect(submission.providerChain).toEqual([])
    expect(submission.providerId).toBe('prv_legacy')
    expect(submission.model).toBe('legacy-model')
    expect(submission.authMode).toBe('apiKey')
    expect(submission.providerApiKey).toBe('legacy-api-key')
  })

  it('validates enabled OAuth entries from the serialized chain instead of hidden top-level fields', () => {
    const chain = serializeProviderChainEntries([
      chainEntry({ authMode: 'oauth', providerOauthToken: '', enabled: true }),
    ])

    expect(validateProviderChain(chain)).toEqual({ code: 'oauthTokenRequired', index: 0 })
  })

  it('ignores disabled OAuth entries during credential validation', () => {
    const chain = serializeProviderChainEntries([
      chainEntry({ authMode: 'oauth', providerOauthToken: '', enabled: false }),
    ])

    expect(validateProviderChain(chain)).toBeNull()
  })

  it('validates the final OAuth projection even when no provider chain entry remains', () => {
    const submission = buildProviderChainSubmission([chainEntry({ providerId: null })], {
      ...baseFormData,
      authMode: 'oauth',
      providerOauthToken: '',
    })

    expect(validateProviderChainSubmission(submission)).toEqual({
      code: 'oauthTokenRequired',
      index: 0,
    })
  })

  it('validates disabled primary OAuth entries before submission', () => {
    const submission = buildProviderChainSubmission(
      [chainEntry({ authMode: 'oauth', providerOauthToken: '', enabled: false })],
      baseFormData,
    )

    expect(validateProviderChainSubmission(submission)).toEqual({
      code: 'oauthTokenRequired',
      index: 0,
    })
  })
})

describe('reasoning controls survive serialization', () => {
  it('keeps each entry’s own effort and fast mode', () => {
    const chain = serializeProviderChainEntries([
      chainEntry({ id: 'chain_codex', model: 'gpt-5.6-sol', reasoningEffort: 'ultra' }),
      chainEntry({
        id: 'chain_claude',
        model: 'claude-opus-4-8',
        reasoningEffort: 'xhigh',
        fastMode: true,
      }),
    ])

    expect(chain.map((entry) => entry.reasoningEffort)).toEqual(['ultra', 'xhigh'])
    expect(chain.map((entry) => entry.fastMode)).toEqual([undefined, true])
  })

  it('omits an unset effort rather than serializing an empty string', () => {
    // An empty string would fail the schema's token check and reject the save;
    // "not configured" has to reach the API as an absent field.
    const [entry] = serializeProviderChainEntries([chainEntry({ reasoningEffort: '' })])

    expect(entry.reasoningEffort).toBeUndefined()
  })

  it('omits fast mode when it is off', () => {
    const [entry] = serializeProviderChainEntries([chainEntry({ fastMode: false })])

    expect(entry.fastMode).toBeUndefined()
  })
})

/**
 * Switching a chain entry's credential invalidates everything the previous one
 * owned. The rule is easy to state and was easy to get wrong: it lived as a
 * closure inside a `useCallback`, and the field it forgot (`fastMode`) survived
 * a Provider swap into the saved config, where the run then dropped it silently
 * and `diagnose` warned about a control the operator could no longer see.
 */
describe('applyProviderEntryPatch', () => {
  const probed = chainEntry({
    reasoningEffort: 'ultra',
    fastMode: true,
    dynamicModels: ['a', 'b'],
    modelCapabilities: { a: { reasoningEfforts: [{ value: 'ultra' }] } },
    fastModeAvailability: { available: true },
    probeError: 'stale',
  })

  it('discards both controls when the Provider changes', () => {
    const next = applyProviderEntryPatch(probed, { providerId: 'prv_2' })

    expect(next.providerId).toBe('prv_2')
    expect(next.reasoningEffort).toBeUndefined()
    expect(next.fastMode).toBeUndefined()
  })

  it('discards everything the previous credential produced', () => {
    const next = applyProviderEntryPatch(probed, { providerId: 'prv_2' })

    expect(next.dynamicModels).toBeUndefined()
    expect(next.modelCapabilities).toBeUndefined()
    expect(next.fastModeAvailability).toBeUndefined()
    expect(next.probeError).toBeUndefined()
  })

  it('treats a changed auth mode as a credential change', () => {
    const next = applyProviderEntryPatch(probed, { authMode: 'localSession' })

    expect(next.fastMode).toBeUndefined()
    expect(next.reasoningEffort).toBeUndefined()
  })

  it('keeps both when the patch touches something unrelated', () => {
    const next = applyProviderEntryPatch(probed, { model: 'other-model' })

    expect(next.reasoningEffort).toBe('ultra')
    expect(next.fastMode).toBe(true)
  })

  it('keeps both when the patch re-sets the same Provider', () => {
    // `providerId in patch` is not enough — re-rendering the select with the
    // current value must not wipe the operator's choices.
    const next = applyProviderEntryPatch(probed, { providerId: probed.providerId })

    expect(next.reasoningEffort).toBe('ultra')
    expect(next.fastMode).toBe(true)
  })

  it('leaves a probe writing its own results back alone', () => {
    // The probe patch carries the new credential AND its answer; resetting here
    // would erase the answer at the moment it arrived.
    const next = applyProviderEntryPatch(probed, {
      providerId: 'prv_2',
      dynamicModels: ['fresh'],
    })

    expect(next.dynamicModels).toEqual(['fresh'])
  })
})
