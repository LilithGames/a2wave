import type { ProviderChainItem } from '@a2wave/shared'
import type { FormData, ProviderChainEntry } from './types'

const MASKED_SECRET = '********'

type SerializedProviderChainItem = Omit<ProviderChainItem, 'authMode'> & {
  id: string
  providerId: string
  authMode: ProviderChainEntry['authMode']
}

export type ProviderChainValidationIssue = {
  code: 'oauthTokenRequired' | 'oauthAccountRequired'
  index: number
}

export type ProviderChainSubmission = {
  providerChain: SerializedProviderChainItem[]
  primaryProvider?: SerializedProviderChainItem
  providerId: string | null
  model: string | undefined
  authMode: FormData['authMode']
  providerApiKey: string | null
  providerBaseUrl: string | null
  providerOauthToken: string | null
  providerOauthAccountId: string | null
}

function valueOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function projectedCredential(
  chainValue: string | null | undefined,
  legacyValue: string,
): string | null {
  if (chainValue === MASKED_SECRET) return valueOrNull(legacyValue)
  return valueOrNull(chainValue)
}

/**
 * Apply one patch to a chain entry, discarding what the previous credential
 * owned when the patch switches credentials.
 *
 * The discarded set is everything a probe produced or a probe result made valid:
 * the model list, the per-model levels, the fast-mode entitlement, and BOTH
 * chosen controls. Keeping a level would offer, and save, a token the new
 * Provider may not accept; keeping fast mode would leave a switch turned on
 * behind a Provider whose CLI has no such setting and whose UI therefore no
 * longer renders it.
 *
 * A patch that itself carries `dynamicModels` / `probeError` / `probing` is
 * exempt: that is the probe flow writing its own results back, and resetting
 * them here would erase the answer as it arrived.
 *
 * Extracted from the component so the discard rule is testable — it was
 * previously a closure inside a `useCallback`, and the one field it forgot
 * (`fastMode`) went unnoticed because nothing could assert on it.
 */
export function applyProviderEntryPatch(
  entry: ProviderChainEntry,
  patch: Partial<ProviderChainEntry>,
): ProviderChainEntry {
  const credChanged =
    ('providerId' in patch && patch.providerId !== entry.providerId) ||
    ('authMode' in patch && patch.authMode !== entry.authMode) ||
    ('authHeaderStyle' in patch && patch.authHeaderStyle !== entry.authHeaderStyle) ||
    ('providerBaseUrl' in patch && patch.providerBaseUrl !== entry.providerBaseUrl) ||
    ('providerApiKey' in patch && patch.providerApiKey !== entry.providerApiKey) ||
    ('providerOauthToken' in patch && patch.providerOauthToken !== entry.providerOauthToken) ||
    ('providerOauthAccountId' in patch &&
      patch.providerOauthAccountId !== entry.providerOauthAccountId)
  const isProbeWriteback = 'dynamicModels' in patch || 'probeError' in patch || 'probing' in patch

  if (!credChanged || isProbeWriteback) return { ...entry, ...patch }

  return {
    ...entry,
    ...patch,
    dynamicModels: undefined,
    modelCapabilities: undefined,
    fastModeAvailability: undefined,
    reasoningEffort: undefined,
    fastMode: undefined,
    probeError: undefined,
    probeErrorCode: undefined,
    probing: undefined,
  }
}

/** Ignore model discovery completed for credentials the user has already replaced. */
export function applyProviderProbeResult(
  current: ProviderChainEntry,
  requested: ProviderChainEntry,
  result: Partial<ProviderChainEntry>,
): ProviderChainEntry {
  const credentials = [
    'providerId',
    'authMode',
    'authHeaderStyle',
    'providerBaseUrl',
    'providerApiKey',
    'providerOauthToken',
    'providerOauthAccountId',
  ] as const
  if (credentials.some((field) => current[field] !== requested[field])) return current
  return { ...current, ...result }
}

export function serializeProviderChainEntries(
  entries: ProviderChainEntry[],
): SerializedProviderChainItem[] {
  return entries
    .filter((entry) => entry.providerId)
    .map((entry) => ({
      id: entry.id,
      providerId: entry.providerId as string,
      model: entry.model || undefined,
      // Absent, never empty: the shared schema validates the effort token's
      // shape, so an empty string would reject the whole save rather than
      // reading as "not configured".
      reasoningEffort: entry.reasoningEffort || undefined,
      fastMode: entry.fastMode ? true : undefined,
      authMode: entry.authMode,
      authHeaderStyle: entry.authHeaderStyle === 'bearer' ? 'bearer' : 'x-api-key',
      providerApiKey: valueOrNull(entry.providerApiKey),
      providerBaseUrl: valueOrNull(entry.providerBaseUrl),
      providerOauthToken:
        entry.authMode === 'oauth' && entry.providerOauthAccountId
          ? null
          : valueOrNull(entry.providerOauthToken),
      providerOauthAccountId:
        entry.authMode === 'oauth' ? valueOrNull(entry.providerOauthAccountId) : null,
      enabled: entry.enabled,
    }))
}

export function validateProviderChain(
  providerChain: SerializedProviderChainItem[],
  codexProviderIds: ReadonlySet<string> = new Set(),
): ProviderChainValidationIssue | null {
  const missingAccountIndex = providerChain.findIndex(
    (entry) =>
      entry.enabled !== false &&
      entry.authMode === 'oauth' &&
      codexProviderIds.has(entry.providerId) &&
      !valueOrNull(entry.providerOauthAccountId),
  )
  if (missingAccountIndex >= 0) return { code: 'oauthAccountRequired', index: missingAccountIndex }
  const invalidOauthIndex = providerChain.findIndex(
    (entry) =>
      entry.enabled !== false &&
      entry.authMode === 'oauth' &&
      !valueOrNull(entry.providerOauthAccountId) &&
      !valueOrNull(entry.providerOauthToken),
  )
  if (invalidOauthIndex >= 0) {
    return { code: 'oauthTokenRequired', index: invalidOauthIndex }
  }
  return null
}

export function validateProviderChainSubmission(
  submission: ProviderChainSubmission,
  codexProviderIds: ReadonlySet<string> = new Set(),
): ProviderChainValidationIssue | null {
  const chainIssue = validateProviderChain(submission.providerChain, codexProviderIds)
  if (chainIssue) return chainIssue

  if (
    submission.authMode === 'oauth' &&
    !valueOrNull(submission.providerOauthAccountId) &&
    submission.providerId &&
    codexProviderIds.has(submission.providerId)
  ) {
    return { code: 'oauthAccountRequired', index: 0 }
  }

  if (
    submission.authMode === 'oauth' &&
    !valueOrNull(submission.providerOauthToken) &&
    !valueOrNull(submission.providerOauthAccountId)
  ) {
    const primaryIndex =
      submission.primaryProvider !== undefined
        ? submission.providerChain.findIndex((entry) => entry.id === submission.primaryProvider?.id)
        : -1
    return { code: 'oauthTokenRequired', index: primaryIndex >= 0 ? primaryIndex : 0 }
  }

  return null
}

export function buildProviderChainSubmission(
  entries: ProviderChainEntry[],
  data: FormData,
): ProviderChainSubmission {
  const providerChain = serializeProviderChainEntries(entries)
  const primaryProvider = providerChain.find((entry) => entry.enabled !== false) ?? providerChain[0]

  if (!primaryProvider) {
    return {
      providerChain,
      primaryProvider,
      providerId: data.providerId,
      model: data.model || undefined,
      authMode: data.authMode,
      providerApiKey: valueOrNull(data.providerApiKey),
      providerBaseUrl: valueOrNull(data.providerBaseUrl),
      providerOauthToken:
        data.authMode === 'oauth' && data.providerOauthAccountId
          ? null
          : valueOrNull(data.providerOauthToken),
      providerOauthAccountId:
        data.authMode === 'oauth' ? valueOrNull(data.providerOauthAccountId) : null,
    }
  }

  return {
    providerChain,
    primaryProvider,
    providerId: primaryProvider.providerId,
    // The primary entry is authoritative once a chain exists: an empty model
    // means "not chosen yet", not "reuse the form field". Falling back to
    // data.model persisted the PREVIOUS Provider's model after a switch, because
    // the change handler clears the entry's model but not the form field.
    model: primaryProvider.model || undefined,
    authMode: primaryProvider.authMode,
    providerApiKey: projectedCredential(primaryProvider.providerApiKey, data.providerApiKey),
    providerBaseUrl: projectedCredential(primaryProvider.providerBaseUrl, data.providerBaseUrl),
    providerOauthAccountId: valueOrNull(primaryProvider.providerOauthAccountId),
    providerOauthToken: primaryProvider.providerOauthAccountId
      ? null
      : projectedCredential(primaryProvider.providerOauthToken, data.providerOauthToken),
  }
}
