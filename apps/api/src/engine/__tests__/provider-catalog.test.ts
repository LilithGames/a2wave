import { PRESET_PROVIDERS, type ProviderManifest } from '@a2wave/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_PROVIDER_MANIFESTS,
  ProviderCatalog,
  createProviderAdapter,
  evaluateProviderVersion,
} from '../provider-catalog.js'
import type { AgentEngine } from '../types.js'

function fakeEngine(overrides: Partial<AgentEngine> = {}): AgentEngine {
  return {
    type: 'cursor',
    executeStream: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as AgentEngine
}

const cursorManifest = BUILTIN_PROVIDER_MANIFESTS.cursor

describe('ProviderCatalog', () => {
  it('defines one manifest for every supported Provider kind', async () => {
    expect(Object.keys(BUILTIN_PROVIDER_MANIFESTS)).toEqual([
      'cursor',
      'claude-code',
      'codex',
      'opencode',
      'qoder',
      'trae',
      'kimi',
      'pi',
    ])
    for (const preset of PRESET_PROVIDERS) {
      expect(BUILTIN_PROVIDER_MANIFESTS[preset.kind]).toMatchObject({
        displayName: preset.name,
        minVersion: preset.minVersion,
      })
    }
  })

  it('enriches a persisted Provider with non-persisted capabilities', async () => {
    const catalog = new ProviderCatalog()
    catalog.register(createProviderAdapter(cursorManifest))

    const dto = catalog.toProviderDto({ id: 'prv_1', kind: 'cursor', name: 'Renamed Engine' })

    expect(dto.name).toBe('Renamed Engine')
    expect(dto.minVersion).toBe(cursorManifest.minVersion)
    expect(dto.capabilities).toEqual(cursorManifest.capabilities)
  })

  it('exposes Agent-scoped API keys and optional proxy URLs for Codex and Pi', () => {
    expect(BUILTIN_PROVIDER_MANIFESTS.codex.capabilities.credentialFields.apiKey).toEqual([
      { field: 'apiKey', required: true },
      { field: 'baseUrl', required: false },
    ])
    expect(BUILTIN_PROVIDER_MANIFESTS.pi.capabilities).toMatchObject({
      authModes: ['apiKey', 'localSession'],
      defaultAuthMode: 'localSession',
      modelDiscovery: { apiKey: 'manual', localSession: 'automatic' },
      credentialFields: {
        apiKey: [
          { field: 'apiKey', required: true },
          { field: 'baseUrl', required: false },
        ],
      },
    })
  })

  it('rejects duplicate adapter registration', () => {
    const catalog = new ProviderCatalog()
    catalog.register(createProviderAdapter(cursorManifest))

    expect(() => catalog.register(createProviderAdapter(cursorManifest))).toThrow(
      /Provider adapter already registered: cursor/,
    )
  })
})

describe('ProviderAdapter', () => {
  it('validates auth mode and required credentials before probing models', async () => {
    const listAvailableModels = vi.fn().mockResolvedValue({ models: ['composer-1.5'] })
    const adapter = createProviderAdapter(cursorManifest)
    adapter.attachEngine(fakeEngine({ listAvailableModels }))

    await expect(adapter.probeModels({ authMode: 'apiKey' })).resolves.toMatchObject({
      code: 'invalid_input',
      models: [],
    })
    await expect(
      adapter.probeModels({ authMode: 'oauth', oauthToken: 'token' }),
    ).resolves.toMatchObject({ code: 'unsupported_mode', models: [] })
    await expect(
      adapter.probeModels({ authMode: 'apiKey', apiKey: 'cursor-key' }),
    ).resolves.toEqual({ models: ['composer-1.5'] })
    expect(listAvailableModels).toHaveBeenCalledTimes(1)
  })

  it('validates required credentials independently from the discovery strategy', async () => {
    const listAvailableModels = vi.fn().mockResolvedValue({ models: ['gpt-5.4'] })
    const adapter = createProviderAdapter(BUILTIN_PROVIDER_MANIFESTS.codex)
    adapter.attachEngine(fakeEngine({ type: 'codex', listAvailableModels }))

    await expect(adapter.probeModels({ authMode: 'apiKey' })).resolves.toMatchObject({
      code: 'invalid_input',
      models: [],
      error: expect.stringContaining('apiKey'),
    })
    expect(listAvailableModels).not.toHaveBeenCalled()
  })

  it('does not require optional credentials when probing models', async () => {
    const listAvailableModels = vi.fn().mockResolvedValue({ models: ['auto'] })
    const adapter = createProviderAdapter(BUILTIN_PROVIDER_MANIFESTS.trae)
    adapter.attachEngine(fakeEngine({ type: 'trae', listAvailableModels }))

    await expect(
      adapter.probeModels({ authMode: 'apiKey', apiKey: 'trae-token' }),
    ).resolves.toEqual({ models: ['auto'] })
    expect(listAvailableModels).toHaveBeenCalledWith({ authMode: 'apiKey', apiKey: 'trae-token' })
  })

  it('delegates login status to its attached engine', async () => {
    const checkLoginStatus = vi.fn().mockResolvedValue({ installed: true, loggedIn: true })
    const adapter = createProviderAdapter(cursorManifest)
    adapter.attachEngine(fakeEngine({ checkLoginStatus }))

    await expect(adapter.checkLoginStatus()).resolves.toEqual({ installed: true, loggedIn: true })
  })

  it('checks login status and version in parallel and reports an outdated CLI', async () => {
    const checkLoginStatus = vi.fn().mockResolvedValue({ installed: true, loggedIn: true })
    const getVersion = vi.fn().mockResolvedValue('qodercli 0.2.8')
    const adapter = createProviderAdapter(BUILTIN_PROVIDER_MANIFESTS.qoder)
    adapter.attachEngine(fakeEngine({ type: 'qoder', checkLoginStatus, getVersion }))

    await expect(adapter.checkLoginStatus()).resolves.toMatchObject({
      installed: true,
      loggedIn: true,
      version: 'qodercli 0.2.8',
      minVersion: '1.0.0',
      versionOk: false,
      error: expect.stringContaining('CLI version too old'),
    })
    expect(checkLoginStatus).toHaveBeenCalledOnce()
    expect(getVersion).toHaveBeenCalledOnce()
  })

  it('keeps login status when the best-effort version probe fails', async () => {
    const checkLoginStatus = vi.fn().mockResolvedValue({ installed: true, loggedIn: true })
    const getVersion = vi.fn().mockRejectedValue(new Error('version probe failed'))
    const adapter = createProviderAdapter(BUILTIN_PROVIDER_MANIFESTS.qoder)
    adapter.attachEngine(fakeEngine({ type: 'qoder', checkLoginStatus, getVersion }))

    await expect(adapter.checkLoginStatus()).resolves.toEqual({ installed: true, loggedIn: true })
  })

  it('fails clearly when no runtime engine has been attached', async () => {
    const manifest = structuredClone(cursorManifest) as ProviderManifest
    const adapter = createProviderAdapter(manifest)

    await expect(adapter.checkLoginStatus()).rejects.toThrow(/has no attached engine/)
  })
})

describe('evaluateProviderVersion', () => {
  it('returns nothing when no minVersion is configured', () => {
    expect(evaluateProviderVersion('1.2.3', null)).toEqual({})
  })

  it('returns only minVersion when the comparison is undecidable', () => {
    expect(evaluateProviderVersion('not-a-version', '1.0.0')).toEqual({ minVersion: '1.0.0' })
  })

  it('reports versionOk: false below the floor', () => {
    expect(evaluateProviderVersion('0.2.8', '1.0.0')).toEqual({
      minVersion: '1.0.0',
      versionOk: false,
    })
  })

  it('reports versionOk: true at or above the floor', () => {
    expect(evaluateProviderVersion('1.0.0', '1.0.0')).toEqual({
      minVersion: '1.0.0',
      versionOk: true,
    })
  })
})

describe('reasoning capability declaration', () => {
  it('declares reasoning effort only for the CLIs that accept one', () => {
    const declaring = Object.entries(BUILTIN_PROVIDER_MANIFESTS)
      .filter(([, manifest]) => manifest.capabilities.reasoningEffort)
      .map(([kind]) => kind)

    expect(declaring).toEqual(['claude-code', 'codex'])
  })

  it('declares fast mode only for the CLIs that accept one', () => {
    const declaring = Object.entries(BUILTIN_PROVIDER_MANIFESTS)
      .filter(([, manifest]) => manifest.capabilities.fastMode)
      .map(([kind]) => kind)

    expect(declaring).toEqual(['claude-code', 'codex'])
  })

  it('keeps the two dimensions separate from the boolean execution options', () => {
    // executionOptions drives the Agent-wide advanced switches; effort and fast
    // mode belong to a single provider chain entry and must not leak into it.
    for (const manifest of Object.values(BUILTIN_PROVIDER_MANIFESTS)) {
      expect(manifest.capabilities.executionOptions).not.toContain('reasoningEffort')
      expect(manifest.capabilities.executionOptions).not.toContain('fastMode')
    }
  })
})
