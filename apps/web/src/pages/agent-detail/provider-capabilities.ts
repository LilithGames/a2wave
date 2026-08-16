import type {
  AuthHeaderStyle,
  AuthMode,
  ModelCapabilities,
  ProbeModelsRequest,
  ProviderCapabilities,
  ProviderCredentialField,
  ProviderDto,
  ReasoningEffortOption,
} from '@a2wave/shared'

const MASKED_SECRET = '********'

export type ModelProbePolicy = 'autoOnMount' | 'manualButton'

export interface ProviderCredentialValues {
  authMode: AuthMode
  authHeaderStyle?: AuthHeaderStyle
  providerApiKey?: string
  providerBaseUrl?: string
  providerOauthToken?: string
}

export interface ModelProbeErrorTranslation {
  key:
    | 'agentDetail.probeNoAccountHint'
    | 'agentDetail.probeLocalSessionNotLoggedIn'
    | 'agentDetail.probeLocalSessionInvalidFormat'
    | 'agentDetail.probeLocalSessionReadFailed'
    | 'agentDetail.probeModelsError'
  values: Record<string, string>
}

/**
 * A2A routing is enabled exactly when it has targets — there is no separate
 * persisted flag, and the save path drops `a2aRouteTargets` to null when the
 * list is empty. Shared by `RouteSection` (which reports it upward) and the
 * Provider/MCP compatibility warning, so the warning cannot disagree with what
 * actually gets saved. The remote predicate requires BOTH fields, matching
 * `use-agent-form`'s save filter.
 */
export function hasConfiguredRouteTargets(input: {
  localAgentIds: readonly string[]
  remoteEntries: ReadonlyArray<{ name: string; url: string }>
}): boolean {
  return (
    input.localAgentIds.length > 0 ||
    input.remoteEntries.some((entry) => Boolean(entry.name.trim() && entry.url.trim()))
  )
}

export function hasConfiguredMcpBackedCapabilities(input: {
  mcpServerIds: readonly string[]
  routeEnabled: boolean
  localAgentIds: readonly string[]
  remoteEntries: ReadonlyArray<{ name: string; url: string }>
}): boolean {
  if (input.mcpServerIds.length > 0) return true
  if (!input.routeEnabled) return false
  return (
    input.localAgentIds.length > 0 ||
    input.remoteEntries.some((entry) => Boolean(entry.name.trim() && entry.url.trim()))
  )
}

export function providersWithoutMcpDelivery(
  chainEntries: ReadonlyArray<{ providerId: string | null; enabled: boolean }>,
  providers: ReadonlyArray<Pick<ProviderDto, 'id' | 'name' | 'capabilities'>> | undefined,
  hasMcpBackedCapabilities: boolean,
): string[] {
  if (!hasMcpBackedCapabilities || !providers) return []

  const providersById = new Map(providers.map((provider) => [provider.id, provider]))
  const names = new Set<string>()
  for (const entry of chainEntries) {
    if (!entry.enabled || !entry.providerId) continue
    const provider = providersById.get(entry.providerId)
    if (provider?.capabilities.mcpDelivery.mode === 'none') {
      names.add(provider.name)
    }
  }
  return [...names]
}

export function resolveModelProbeErrorTranslation(input: {
  providerName: string
  capabilities: ProviderCapabilities | undefined
  authMode: AuthMode
  code: string | undefined
  error: string
}): ModelProbeErrorTranslation {
  const command = input.capabilities?.localSessionLoginCommand ?? ''

  if (input.code === 'no_account_models') {
    return {
      key: 'agentDetail.probeNoAccountHint',
      values: { cli: command },
    }
  }

  if (input.authMode === 'localSession') {
    const values = {
      provider: input.providerName,
      command,
      error: input.error,
    }
    if (input.code === 'local_session_not_logged_in') {
      return { key: 'agentDetail.probeLocalSessionNotLoggedIn', values }
    }
    if (input.code === 'local_session_invalid_format') {
      return { key: 'agentDetail.probeLocalSessionInvalidFormat', values }
    }
    if (input.code === 'local_session_read_failed') {
      return { key: 'agentDetail.probeLocalSessionReadFailed', values }
    }
  }

  return {
    key: 'agentDetail.probeModelsError',
    values: { error: input.error },
  }
}

/**
 * Every Provider can enumerate models — that is a hard onboarding requirement —
 * so the only question is whether the probe runs on mount or waits for the
 * operator to supply credentials. An auth mode with no declared strategy falls
 * back to the manual button rather than hiding the model list entirely.
 */
export function modelProbePolicy(
  capabilities: ProviderCapabilities | undefined,
  authMode: AuthMode,
): ModelProbePolicy {
  // Resolved against the mode the Provider would actually run, so a persisted
  // entry naming a dropped mode still gets a sensible button shape. The probe
  // itself is NOT normalized (see buildProbeModelsRequest): it reports the stale
  // mode as `unsupportedAuthMode` so the operator is told to re-pick, rather than
  // silently probing under a mode they never selected.
  const effectiveAuthMode = normalizeAuthMode(capabilities, authMode)
  return capabilities?.modelDiscovery[effectiveAuthMode] === 'automatic'
    ? 'autoOnMount'
    : 'manualButton'
}

export function normalizeAuthMode(
  capabilities: ProviderCapabilities | undefined,
  current: AuthMode,
): AuthMode {
  if (!capabilities) return current
  return capabilities.authModes.includes(current) ? current : capabilities.defaultAuthMode
}

function credentialFieldDescriptorsFor(
  capabilities: ProviderCapabilities | undefined,
  authMode: AuthMode,
): Array<{ field: ProviderCredentialField; required: boolean }> {
  return capabilities?.credentialFields[authMode] ?? []
}

export function visibleCredentialFieldsFor(
  capabilities: ProviderCapabilities | undefined,
  authMode: AuthMode,
): ProviderCredentialField[] {
  return credentialFieldDescriptorsFor(capabilities, authMode).map(({ field }) => field)
}

export function credentialFieldIsRequired(
  capabilities: ProviderCapabilities | undefined,
  authMode: AuthMode,
  field: ProviderCredentialField,
): boolean {
  return (
    credentialFieldDescriptorsFor(capabilities, authMode).find(
      (descriptor) => descriptor.field === field,
    )?.required ?? false
  )
}

function requiredCredentialFieldsFor(
  capabilities: ProviderCapabilities | undefined,
  authMode: AuthMode,
): ProviderCredentialField[] {
  return credentialFieldDescriptorsFor(capabilities, authMode)
    .filter(({ required }) => required)
    .map(({ field }) => field)
}

function credentialValue(
  input: ProviderCredentialValues,
  field: ProviderCredentialField,
): string | undefined {
  if (field === 'apiKey') return input.providerApiKey
  if (field === 'baseUrl') return input.providerBaseUrl
  return input.providerOauthToken
}

export function buildProbeModelsRequest(
  provider: Pick<ProviderDto, 'kind' | 'capabilities'>,
  input: ProviderCredentialValues,
): {
  request?: ProbeModelsRequest
  missingFields: ProviderCredentialField[]
  maskedFields?: ProviderCredentialField[]
  unsupportedAuthMode?: boolean
} {
  // Deliberately NOT normalized: the probe must run under the mode the operator
  // sees selected. config-tab renders the auth-mode label and the credential
  // inputs from the raw entry mode (a stale mode is kept visible in the radio
  // group on purpose), so silently probing under the manifest default would send
  // credentials the user never entered and drop the ones they did — failing
  // against a field the UI never rendered. A stale mode is surfaced as
  // `unsupportedAuthMode` instead, so the caller can tell the user to re-pick.
  const authMode = input.authMode
  const requiredFields = requiredCredentialFieldsFor(provider.capabilities, authMode)
  const missingFields = requiredFields.filter((field) => !credentialValue(input, field)?.trim())
  // A persisted entry can name a mode the manifest has since dropped. Probing it
  // would fail with `unsupported_mode` on every attempt, so report it as its own
  // condition rather than emitting a request that cannot succeed.
  if (normalizeAuthMode(provider.capabilities, authMode) !== authMode) {
    return { missingFields, unsupportedAuthMode: true }
  }
  const visibleFields = new Set(visibleCredentialFieldsFor(provider.capabilities, authMode))
  const normalizedValues = {
    apiKey: input.providerApiKey?.trim(),
    baseUrl: input.providerBaseUrl?.trim(),
    oauthToken: input.providerOauthToken?.trim(),
  }
  const maskedFields = Array.from(visibleFields).filter(
    (field) => normalizedValues[field] === MASKED_SECRET,
  )
  if (maskedFields.length > 0) return { missingFields, maskedFields }
  if (missingFields.length > 0) return { missingFields }

  return {
    request: {
      kind: provider.kind,
      authMode,
      ...(provider.kind === 'claude-code' && authMode === 'apiKey'
        ? { authHeaderStyle: input.authHeaderStyle === 'bearer' ? 'bearer' : 'x-api-key' }
        : {}),
      ...(visibleFields.has('apiKey') && normalizedValues.apiKey
        ? { apiKey: normalizedValues.apiKey }
        : {}),
      ...(visibleFields.has('baseUrl') && normalizedValues.baseUrl
        ? { baseUrl: normalizedValues.baseUrl }
        : {}),
      ...(visibleFields.has('oauthToken') && normalizedValues.oauthToken
        ? { oauthToken: normalizedValues.oauthToken }
        : {}),
    },
    missingFields: [],
  }
}

/**
 * What the reasoning-effort control should render for one provider chain entry.
 *
 * Four states, because collapsing any pair of them produces a lie:
 * - `unsupported` — the CLI has no such setting; there is nothing to show.
 * - `options` — discovery reported the levels this model accepts.
 * - `none` — discovery reported that this model accepts no level. Real: Haiku
 *   4.5 and Sonnet 4.5 answer exactly this.
 * - `unknown` — nothing was discovered. A proxy standing in for the vendor
 *   endpoint returns bare model ids, and so does an entry that has not been
 *   probed yet.
 *
 * `none` and `unknown` both end up as an empty dropdown, but only one of them is
 * something the operator can act on, so they must not share a message.
 */
export type ReasoningEffortSelectState =
  | { kind: 'unsupported' }
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'options'; options: ReasoningEffortOption[]; defaultValue?: string }

export function reasoningEffortSelectState(
  capabilities: ProviderCapabilities | undefined,
  modelCapabilities: Record<string, ModelCapabilities> | undefined,
  model: string,
): ReasoningEffortSelectState {
  if (!capabilities?.reasoningEffort) return { kind: 'unsupported' }

  const discovered = model ? modelCapabilities?.[model] : undefined
  const options = discovered?.reasoningEfforts
  if (!options) return { kind: 'unknown' }
  if (options.length === 0) return { kind: 'none' }

  return {
    kind: 'options',
    options,
    ...(discovered.defaultReasoningEffort
      ? { defaultValue: discovered.defaultReasoningEffort }
      : {}),
  }
}

/**
 * The level to keep after the entry's model changed.
 *
 * The dropdown's OPTIONS follow the model on their own, but the selected value
 * does not — leaving a level the new model rejects both shows a value missing
 * from its own dropdown and saves a setting the CLI will refuse.
 *
 * The value is carried over whenever the new model still offers it — the same
 * level means the same thing across models, so switching should not disturb it.
 * It is given up only on positive evidence: a discovered level list that does
 * not contain it. The value then falls back to that model's own **discovered
 * default**, so the field keeps stating what the run will use rather than going
 * blank.
 *
 * Two cases have no default to fall back to and therefore clear — which passes
 * no flag and leaves the CLI's own default in force, the same outcome just not
 * spelled out in the field: a model that accepts no level at all, and one whose
 * discovery lists levels without naming a default (Anthropic's model endpoint
 * reports the levels only; codex reports `default_reasoning_level` per model).
 *
 * `unknown` keeps the value untouched. Behind a proxy nothing is ever
 * discovered, so treating that as evidence would drop a working setting on every
 * model switch.
 */
export function reasoningEffortAfterModelChange(
  capabilities: ProviderCapabilities | undefined,
  modelCapabilities: Record<string, ModelCapabilities> | undefined,
  nextModel: string,
  currentEffort: string | undefined,
): string | undefined {
  if (!currentEffort) return undefined

  const state = reasoningEffortSelectState(capabilities, modelCapabilities, nextModel)
  if (state.kind === 'none') return undefined
  if (state.kind === 'options') {
    return state.options.some((option) => option.value === currentEffort)
      ? currentEffort
      : state.defaultValue
  }
  return currentEffort
}
