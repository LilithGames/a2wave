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
