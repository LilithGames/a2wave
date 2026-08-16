import type { ProviderChainItem } from '@a2wave/shared'
import type { FormData, ProviderChainEntry } from './types'

const MASKED_SECRET = '********'

type SerializedProviderChainItem = Omit<ProviderChainItem, 'authMode'> & {
  id: string
  providerId: string
  authMode: ProviderChainEntry['authMode']
}

export type ProviderChainValidationIssue = {
  code: 'oauthTokenRequired'
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
    ('providerOauthToken' in patch && patch.providerOauthToken !== entry.providerOauthToken)
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
  }
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
      providerOauthToken: valueOrNull(entry.providerOauthToken),
      enabled: entry.enabled,
    }))
}

export function validateProviderChain(
  providerChain: SerializedProviderChainItem[],
): ProviderChainValidationIssue | null {
  const invalidOauthIndex = providerChain.findIndex(
    (entry) =>
      entry.enabled !== false &&
      entry.authMode === 'oauth' &&
      !valueOrNull(entry.providerOauthToken),
  )
  if (invalidOauthIndex >= 0) {
    return { code: 'oauthTokenRequired', index: invalidOauthIndex }
  }
  return null
}

export function validateProviderChainSubmission(
  submission: ProviderChainSubmission,
): ProviderChainValidationIssue | null {
  const chainIssue = validateProviderChain(submission.providerChain)
  if (chainIssue) return chainIssue

  if (submission.authMode === 'oauth' && !valueOrNull(submission.providerOauthToken)) {
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
      providerOauthToken: valueOrNull(data.providerOauthToken),
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
    providerOauthToken: projectedCredential(
      primaryProvider.providerOauthToken,
      data.providerOauthToken,
    ),
  }
}
