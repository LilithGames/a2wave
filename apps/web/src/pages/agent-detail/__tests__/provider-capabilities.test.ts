import type { ProviderCapabilities, ProviderDto } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import en from '../../../locales/en.json'
import zh from '../../../locales/zh.json'
import {
  buildProbeModelsRequest,
  credentialFieldIsRequired,
  hasConfiguredMcpBackedCapabilities,
  hasConfiguredRouteTargets,
  modelProbePolicy,
  normalizeAuthMode,
  providersWithoutMcpDelivery,
  reasoningEffortAfterModelChange,
  reasoningEffortSelectState,
  resolveModelProbeErrorTranslation,
  visibleCredentialFieldsFor,
} from '../provider-capabilities'

const capabilities: ProviderCapabilities = {
  authModes: ['oauth', 'localSession'],
  defaultAuthMode: 'localSession',
  modelDiscovery: { oauth: 'manual', localSession: 'automatic' },
  credentialFields: {
    oauth: [{ field: 'oauthToken', required: true }],
    apiKey: [
      { field: 'apiKey', required: true },
      { field: 'baseUrl', required: false },
    ],
  },
  mcpDelivery: { mode: 'runtime-injection' },
  executionOptions: ['readOnly'],
  reasoningEffort: false,
  fastMode: false,
  sessionResume: true,
  sandbox: 'native',
  localSessionLoginCommand: 'custom login',
}

const provider = {
  kind: 'cursor',
  capabilities,
} as Pick<ProviderDto, 'kind' | 'capabilities'>

describe('hasConfiguredRouteTargets', () => {
  // A2A routing has no on/off switch: it is enabled exactly when targets exist.
  // `ConfigTab` derives `routeEnabled` from this helper to feed the Provider/MCP
  // compatibility warning, and `RouteSection` uses it for the card — so the two
  // cannot disagree, and neither can disagree with what the save path persists.
  it('counts a local agent as a target', () => {
    expect(hasConfiguredRouteTargets({ localAgentIds: ['agt_1'], remoteEntries: [] })).toBe(true)
  })

  it('counts a fully-filled remote as a target', () => {
    expect(
      hasConfiguredRouteTargets({
        localAgentIds: [],
        remoteEntries: [{ name: 'qa-bot', url: 'https://example.com/api/a2a/agt_x' }],
      }),
    ).toBe(true)
  })

  it.each([
    ['name without URL', { name: 'qa-bot', url: '' }],
    ['URL without name', { name: '', url: 'https://example.com/api/a2a/agt_x' }],
    ['whitespace only', { name: '  ', url: '  ' }],
  ])('ignores a half-filled remote (%s), matching the save filter', (_label, entry) => {
    expect(hasConfiguredRouteTargets({ localAgentIds: [], remoteEntries: [entry] })).toBe(false)
  })

  it('is false with nothing configured', () => {
    expect(hasConfiguredRouteTargets({ localAgentIds: [], remoteEntries: [] })).toBe(false)
  })

  it('still warns about an MCP-unsupported Provider when only route targets exist', () => {
    // Regression for the switch removal: `routeEnabled` used to be a user flag.
    // Deriving it must keep the provider-mcp-unsupported warning firing for an
    // agent whose only MCP-backed capability is A2A routing.
    const noMcpProvider = {
      id: 'prv_no_mcp',
      name: 'Pi CLI',
      capabilities: { ...capabilities, mcpDelivery: { mode: 'none' } },
    } as Pick<ProviderDto, 'id' | 'name' | 'capabilities'>

    const routeEnabled = hasConfiguredRouteTargets({
      localAgentIds: [],
      remoteEntries: [{ name: 'qa-bot', url: 'https://example.com/api/a2a/agt_x' }],
    })
    expect(routeEnabled).toBe(true)

    const mcpBacked = hasConfiguredMcpBackedCapabilities({
      mcpServerIds: [],
      routeEnabled,
      localAgentIds: [],
      remoteEntries: [{ name: 'qa-bot', url: 'https://example.com/api/a2a/agt_x' }],
    })
    expect(mcpBacked).toBe(true)

    expect(
      providersWithoutMcpDelivery(
        [{ providerId: 'prv_no_mcp', enabled: true }],
        [noMcpProvider],
        mcpBacked,
      ),
    ).toEqual(['Pi CLI'])
  })

  it('does not warn when the only route target is a half-filled draft', () => {
    const noMcpProvider = {
      id: 'prv_no_mcp',
      name: 'Pi CLI',
      capabilities: { ...capabilities, mcpDelivery: { mode: 'none' } },
    } as Pick<ProviderDto, 'id' | 'name' | 'capabilities'>

    const routeEnabled = hasConfiguredRouteTargets({
      localAgentIds: [],
      remoteEntries: [{ name: 'qa-bot', url: '' }],
    })

    const mcpBacked = hasConfiguredMcpBackedCapabilities({
      mcpServerIds: [],
      routeEnabled,
      localAgentIds: [],
      remoteEntries: [{ name: 'qa-bot', url: '' }],
    })

    expect(
      providersWithoutMcpDelivery(
        [{ providerId: 'prv_no_mcp', enabled: true }],
        [noMcpProvider],
        mcpBacked,
      ),
    ).toEqual([])
  })
})

describe('Provider capability UI helpers', () => {
  it('recognizes only MCP-backed capabilities that will be persisted', () => {
    expect(
      hasConfiguredMcpBackedCapabilities({
        mcpServerIds: ['mcp_1'],
        routeEnabled: false,
        localAgentIds: [],
        remoteEntries: [],
      }),
    ).toBe(true)
    expect(
      hasConfiguredMcpBackedCapabilities({
        mcpServerIds: [],
        routeEnabled: true,
        localAgentIds: ['agt_1'],
        remoteEntries: [],
      }),
    ).toBe(true)
    expect(
      hasConfiguredMcpBackedCapabilities({
        mcpServerIds: [],
        routeEnabled: true,
        localAgentIds: [],
        remoteEntries: [{ name: 'remote', url: 'https://example.com/a2a' }],
      }),
    ).toBe(true)
    expect(
      hasConfiguredMcpBackedCapabilities({
        mcpServerIds: [],
        routeEnabled: true,
        localAgentIds: [],
        remoteEntries: [{ name: 'incomplete', url: ' ' }],
      }),
    ).toBe(false)
    expect(
      hasConfiguredMcpBackedCapabilities({
        mcpServerIds: [],
        routeEnabled: false,
        localAgentIds: ['agt_1'],
        remoteEntries: [{ name: 'remote', url: 'https://example.com/a2a' }],
      }),
    ).toBe(false)
  })

  it('finds MCP-incompatible providers anywhere in the enabled fallback chain', () => {
    const providers = [
      { id: 'prv_cursor', name: 'Cursor Agent', capabilities },
      {
        id: 'prv_pi',
        name: 'Pi CLI',
        capabilities: { ...capabilities, mcpDelivery: { mode: 'none' as const } },
      },
    ]

    expect(
      providersWithoutMcpDelivery(
        [
          { providerId: 'prv_cursor', enabled: true },
          { providerId: 'prv_pi', enabled: true },
        ],
        providers,
        true,
      ),
    ).toEqual(['Pi CLI'])

    expect(
      providersWithoutMcpDelivery([{ providerId: 'prv_pi', enabled: true }], providers, false),
    ).toEqual([])
    expect(
      providersWithoutMcpDelivery([{ providerId: 'prv_pi', enabled: false }], providers, true),
    ).toEqual([])
    expect(en.agentDetail.providerMcpUnsupportedDescription).toContain('{{providers}}')
    expect(zh.agentDetail.providerMcpUnsupportedDescription).toContain('{{providers}}')
  })

  it('derives model discovery policy from capabilities, not kind', () => {
    expect(modelProbePolicy(capabilities, 'oauth')).toBe('manualButton')
    expect(modelProbePolicy(capabilities, 'localSession')).toBe('autoOnMount')
    // `apiKey` is absent from this manifest's authModes, so a persisted entry
    // naming it resolves against the mode the Provider would actually run
    // (defaultAuthMode = localSession -> automatic). Probing the stale mode
    // instead would fail with unsupported_mode on every click.
    expect(modelProbePolicy(capabilities, 'apiKey')).toBe('autoOnMount')
  })

  it('builds a credentialed probe request for Pi API-key models', () => {
    const piCapabilities = {
      ...capabilities,
      authModes: ['apiKey'],
      defaultAuthMode: 'apiKey',
      modelDiscovery: { apiKey: 'manual' },
      credentialFields: {
        apiKey: [
          { field: 'apiKey', required: true },
          { field: 'baseUrl', required: false },
        ],
      },
    } as ProviderCapabilities
    const piProvider = {
      kind: 'pi',
      capabilities: piCapabilities,
    } as Pick<ProviderDto, 'kind' | 'capabilities'>

    expect(modelProbePolicy(piCapabilities, 'apiKey')).toBe('manualButton')
    expect(
      buildProbeModelsRequest(piProvider, {
        authMode: 'apiKey',
        providerApiKey: 'agent-key',
        providerBaseUrl: 'https://proxy.example.com/v1',
      }),
    ).toEqual({
      request: {
        kind: 'pi',
        authMode: 'apiKey',
        apiKey: 'agent-key',
        baseUrl: 'https://proxy.example.com/v1',
      },
      missingFields: [],
    })
  })

  it('normalizes unsupported auth modes to the manifest default', () => {
    expect(normalizeAuthMode(capabilities, 'apiKey')).toBe('localSession')
    expect(normalizeAuthMode(capabilities, 'oauth')).toBe('oauth')
  })

  it('builds a generic probe request and reports missing manifest credentials', () => {
    expect(buildProbeModelsRequest(provider, { authMode: 'oauth' })).toEqual({
      missingFields: ['oauthToken'],
    })
    expect(
      buildProbeModelsRequest(provider, {
        authMode: 'oauth',
        providerOauthToken: 'token',
      }),
    ).toEqual({
      request: { kind: 'cursor', authMode: 'oauth', oauthToken: 'token' },
      missingFields: [],
    })
  })

  it('omits stale credentials that are not declared for the active auth mode', () => {
    expect(
      buildProbeModelsRequest(provider, {
        authMode: 'oauth',
        providerApiKey: 'stale-api-key',
        providerBaseUrl: 'https://stale.example.com',
        providerOauthToken: 'oauth-token',
      }),
    ).toEqual({
      request: { kind: 'cursor', authMode: 'oauth', oauthToken: 'oauth-token' },
      missingFields: [],
    })
  })

  it('trims probe credentials and sends the explicit Claude auth header style', () => {
    const claudeCapabilities: ProviderCapabilities = {
      ...capabilities,
      authModes: ['apiKey'],
      defaultAuthMode: 'apiKey',
      modelDiscovery: { apiKey: 'manual' },
    }
    const claudeProvider = {
      kind: 'claude-code',
      capabilities: claudeCapabilities,
    } as Pick<ProviderDto, 'kind' | 'capabilities'>

    expect(
      buildProbeModelsRequest(claudeProvider, {
        authMode: 'apiKey',
        authHeaderStyle: 'bearer',
        providerApiKey: '  opaque-token  ',
        providerBaseUrl: '  https://proxy.example.com/hdp/v1  ',
      }),
    ).toEqual({
      request: {
        kind: 'claude-code',
        authMode: 'apiKey',
        authHeaderStyle: 'bearer',
        apiKey: 'opaque-token',
        baseUrl: 'https://proxy.example.com/hdp/v1',
      },
      missingFields: [],
    })

    expect(
      buildProbeModelsRequest(claudeProvider, {
        authMode: 'apiKey',
        providerApiKey: 'opaque-legacy-key',
      }).request,
    ).toMatchObject({ authHeaderStyle: 'x-api-key' })
  })

  it('blocks masked saved credentials from a stateless model probe', () => {
    const claudeCapabilities: ProviderCapabilities = {
      ...capabilities,
      authModes: ['apiKey'],
      defaultAuthMode: 'apiKey',
      modelDiscovery: { apiKey: 'manual' },
    }

    expect(
      buildProbeModelsRequest(
        { kind: 'claude-code', capabilities: claudeCapabilities },
        {
          authMode: 'apiKey',
          providerApiKey: '********',
          providerBaseUrl: '********',
        },
      ),
    ).toEqual({
      missingFields: [],
      maskedFields: ['apiKey', 'baseUrl'],
    })
  })

  it('keeps optional credential fields visible without requiring them for a probe', () => {
    const optionalCredentialCapabilities: ProviderCapabilities = {
      ...capabilities,
      authModes: ['apiKey'],
      defaultAuthMode: 'apiKey',
      modelDiscovery: { apiKey: 'manual' },
    }

    expect(visibleCredentialFieldsFor(optionalCredentialCapabilities, 'apiKey')).toEqual([
      'apiKey',
      'baseUrl',
    ])
    expect(credentialFieldIsRequired(optionalCredentialCapabilities, 'apiKey', 'apiKey')).toBe(true)
    expect(credentialFieldIsRequired(optionalCredentialCapabilities, 'apiKey', 'baseUrl')).toBe(
      false,
    )
    expect(
      buildProbeModelsRequest(
        { kind: 'trae', capabilities: optionalCredentialCapabilities },
        {
          authMode: 'apiKey',
          providerApiKey: 'token',
        },
      ),
    ).toEqual({
      request: { kind: 'trae', authMode: 'apiKey', apiKey: 'token' },
      missingFields: [],
    })
  })

  it('falls back to the manual probe button when an auth mode declares no strategy', () => {
    // Enumerating models is a hard Provider requirement, so there is no longer a
    // "this Provider cannot list models" policy to degrade into. An undeclared
    // mode must still offer the probe rather than silently showing no models.
    const undeclared: ProviderCapabilities = {
      ...capabilities,
      authModes: ['localSession'],
      defaultAuthMode: 'localSession',
      modelDiscovery: {},
      credentialFields: {},
    }

    expect(modelProbePolicy(undeclared, 'localSession')).toBe('manualButton')
    expect(
      buildProbeModelsRequest(
        { kind: 'pi', capabilities: undeclared },
        { authMode: 'localSession' },
      ),
    ).toEqual({
      request: { kind: 'pi', authMode: 'localSession' },
      missingFields: [],
    })
  })

  it('drives a credential-less localSession-only Provider with no field prompts', () => {
    // Kimi's real manifest shape: localSession is the only mode, discovery is
    // automatic, and there are no credential fields at all because the CLI does
    // not read API keys from the environment.
    const kimiCapabilities: ProviderCapabilities = {
      ...capabilities,
      authModes: ['localSession'],
      defaultAuthMode: 'localSession',
      modelDiscovery: { localSession: 'automatic' },
      credentialFields: {},
      mcpDelivery: { mode: 'workspace-file', defaultPath: '.kimi-code/mcp.json' },
      executionOptions: [],
      sandbox: 'unsupported',
      localSessionLoginCommand: 'kimi login',
    }

    // Any stale mode from an older Agent row collapses to localSession.
    expect(normalizeAuthMode(kimiCapabilities, 'apiKey')).toBe('localSession')
    expect(normalizeAuthMode(kimiCapabilities, 'oauth')).toBe('localSession')
    expect(modelProbePolicy(kimiCapabilities, 'localSession')).toBe('autoOnMount')
    // No credential inputs are rendered, and none are demanded for a probe.
    expect(visibleCredentialFieldsFor(kimiCapabilities, 'localSession')).toEqual([])
    expect(
      buildProbeModelsRequest(
        { kind: 'kimi', capabilities: kimiCapabilities },
        { authMode: 'localSession' },
      ),
    ).toEqual({
      request: { kind: 'kimi', authMode: 'localSession' },
      missingFields: [],
    })
    // Even if a stale key lingers in form state it must not be sent.
    expect(
      buildProbeModelsRequest(
        { kind: 'kimi', capabilities: kimiCapabilities },
        { authMode: 'localSession', providerApiKey: 'stale', providerOauthToken: 'stale' },
      ),
    ).toEqual({
      request: { kind: 'kimi', authMode: 'localSession' },
      missingFields: [],
    })
    // The signed-out hint names Kimi's own login command.
    expect(
      resolveModelProbeErrorTranslation({
        providerName: 'Kimi Code CLI',
        capabilities: kimiCapabilities,
        authMode: 'localSession',
        code: 'local_session_not_logged_in',
        error: 'Not logged in',
      }),
    ).toEqual({
      key: 'agentDetail.probeLocalSessionNotLoggedIn',
      values: { provider: 'Kimi Code CLI', command: 'kimi login', error: 'Not logged in' },
    })
  })

  it('validates required credentials for automatic discovery', () => {
    const automaticCapabilities: ProviderCapabilities = {
      ...capabilities,
      authModes: ['apiKey'],
      defaultAuthMode: 'apiKey',
      modelDiscovery: { apiKey: 'automatic' },
      credentialFields: { apiKey: [{ field: 'apiKey', required: true }] },
    }

    expect(
      buildProbeModelsRequest(
        { kind: 'codex', capabilities: automaticCapabilities },
        { authMode: 'apiKey' },
      ),
    ).toEqual({ missingFields: ['apiKey'] })
  })

  it('renders a Provider-aware local-session error instead of Claude-specific guidance', () => {
    expect(
      resolveModelProbeErrorTranslation({
        providerName: 'Qoder CLI',
        capabilities: {
          ...capabilities,
          localSessionLoginCommand: 'qodercli login',
        },
        authMode: 'localSession',
        code: 'local_session_not_logged_in',
        error: 'Not logged in',
      }),
    ).toEqual({
      key: 'agentDetail.probeLocalSessionNotLoggedIn',
      values: {
        provider: 'Qoder CLI',
        command: 'qodercli login',
        error: 'Not logged in',
      },
    })

    expect(zh.agentDetail.probeLocalSessionNotLoggedIn).toContain('{{provider}}')
    expect(en.agentDetail.probeLocalSessionNotLoggedIn).toContain('{{provider}}')
    expect(zh.agentDetail.probeLocalSessionNotLoggedIn).not.toContain('Claude')
    expect(en.agentDetail.probeLocalSessionNotLoggedIn).not.toContain('Claude')
  })

  it('shows the backend authentication error for API-key probes with a session-shaped code', () => {
    expect(
      resolveModelProbeErrorTranslation({
        providerName: 'Qoder CLI',
        capabilities,
        authMode: 'apiKey',
        code: 'local_session_not_logged_in',
        error: 'Personal Access Token was not accepted by qodercli',
      }),
    ).toEqual({
      key: 'agentDetail.probeModelsError',
      values: { error: 'Personal Access Token was not accepted by qodercli' },
    })
  })
})

describe('reasoningEffortSelectState', () => {
  const supported = { reasoningEffort: true } as unknown as ProviderCapabilities
  const unsupported = { reasoningEffort: false } as unknown as ProviderCapabilities

  it('renders nothing for a Provider whose CLI has no such setting', () => {
    expect(reasoningEffortSelectState(unsupported, undefined, 'gpt-5.6-sol')).toEqual({
      kind: 'unsupported',
    })
  })

  it('renders nothing when the Provider is not resolved yet', () => {
    expect(reasoningEffortSelectState(undefined, undefined, '')).toEqual({ kind: 'unsupported' })
  })

  it('offers the levels discovery reported for the selected model', () => {
    const state = reasoningEffortSelectState(
      supported,
      {
        'claude-opus-4-8': {
          reasoningEfforts: [{ value: 'low' }, { value: 'xhigh' }],
          defaultReasoningEffort: 'xhigh',
        },
      },
      'claude-opus-4-8',
    )

    expect(state).toEqual({
      kind: 'options',
      options: [{ value: 'low' }, { value: 'xhigh' }],
      defaultValue: 'xhigh',
    })
  })

  it('follows the model select — a second model gets its own levels', () => {
    const capabilities = {
      'claude-opus-4-8': { reasoningEfforts: [{ value: 'xhigh' }] },
      'claude-opus-4-5-20251101': { reasoningEfforts: [{ value: 'high' }] },
    }

    expect(reasoningEffortSelectState(supported, capabilities, 'claude-opus-4-5-20251101')).toEqual(
      {
        kind: 'options',
        options: [{ value: 'high' }],
      },
    )
  })

  it('separates "this model takes no level" from "nothing was discovered"', () => {
    // A proxy that returns bare model ids reports nothing; Haiku reports an
    // empty list. Both would render an empty dropdown, but only one of them is
    // the user's fault to fix, so they must not share a message.
    expect(
      reasoningEffortSelectState(
        supported,
        { 'claude-haiku-4-5': { reasoningEfforts: [] } },
        'claude-haiku-4-5',
      ),
    ).toEqual({ kind: 'none' })

    expect(reasoningEffortSelectState(supported, undefined, 'deepseek-v4-flash')).toEqual({
      kind: 'unknown',
    })
  })

  it('reports unknown for a model missing from an otherwise populated probe result', () => {
    expect(
      reasoningEffortSelectState(
        supported,
        { 'claude-opus-4-8': { reasoningEfforts: [] } },
        'other-model',
      ),
    ).toEqual({ kind: 'unknown' })
  })

  it('reports unknown before a model has been chosen', () => {
    expect(
      reasoningEffortSelectState(supported, { 'claude-opus-4-8': { reasoningEfforts: [] } }, ''),
    ).toEqual({ kind: 'unknown' })
  })
})

describe('reasoningEffortAfterModelChange', () => {
  const supported = { reasoningEffort: true } as unknown as ProviderCapabilities
  const capabilities = {
    'claude-opus-4-8': { reasoningEfforts: [{ value: 'high' }, { value: 'xhigh' }] },
    // No default: Anthropic's model endpoint lists levels without naming one.
    'claude-sonnet-4-6': { reasoningEfforts: [{ value: 'high' }] },
    'claude-haiku-4-5': { reasoningEfforts: [] },
    // codex reports a per-model default alongside the levels.
    'gpt-5.6-sol': {
      reasoningEfforts: [{ value: 'low' }, { value: 'medium' }, { value: 'ultra' }],
      defaultReasoningEffort: 'low',
    },
  }

  it('keeps a level the new model still accepts', () => {
    expect(
      reasoningEffortAfterModelChange(supported, capabilities, 'claude-sonnet-4-6', 'high'),
    ).toBe('high')
  })

  it('falls back to the new model’s default when the level does not carry over', () => {
    // `ultra` exists on this codex model but not on every one; when a switch
    // lands on a model that reports a default, the field states that default
    // rather than going blank.
    expect(reasoningEffortAfterModelChange(supported, capabilities, 'gpt-5.6-sol', 'xhigh')).toBe(
      'low',
    )
  })

  it('clears when the new model rejects the level and names no default', () => {
    // Opus 4.8 has xhigh, Sonnet 4.6 does not, and Anthropic reports no default
    // to fall back to. Empty passes no flag, so the CLI's own default applies —
    // the same outcome, just not spelled out in the field.
    expect(
      reasoningEffortAfterModelChange(supported, capabilities, 'claude-sonnet-4-6', 'xhigh'),
    ).toBeUndefined()
  })

  it('carries the level over unchanged when the new model still offers it', () => {
    expect(reasoningEffortAfterModelChange(supported, capabilities, 'gpt-5.6-sol', 'medium')).toBe(
      'medium',
    )
  })

  it('drops any level when the new model accepts none, default or not', () => {
    expect(
      reasoningEffortAfterModelChange(supported, capabilities, 'claude-haiku-4-5', 'high'),
    ).toBeUndefined()
  })

  it('keeps the level when the new model’s levels were never discovered', () => {
    // Unknown is not evidence of invalidity — behind a proxy nothing is ever
    // discovered, and clearing here would silently drop a working setting.
    expect(
      reasoningEffortAfterModelChange(supported, capabilities, 'deepseek-v4-flash', 'high'),
    ).toBe('high')
  })

  it('keeps the level when nothing was probed at all', () => {
    expect(reasoningEffortAfterModelChange(supported, undefined, 'claude-opus-4-8', 'high')).toBe(
      'high',
    )
  })

  it('stays undefined when no level was configured', () => {
    expect(
      reasoningEffortAfterModelChange(supported, capabilities, 'claude-haiku-4-5', undefined),
    ).toBeUndefined()
  })
})
