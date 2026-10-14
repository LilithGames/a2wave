import type { AuthMode } from '@a2wave/shared'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { type agents, providers } from '../db/schema.js'
import { providerCatalog } from '../engine/provider-catalog.js'

type AgentRow = typeof agents.$inferSelect

/**
 * Resolve the effective auth mode from an already-fetched provider kind.
 *
 * Split from the async entry point below so the chain walk in
 * `preserveProviderChainSecrets` can stay synchronous: it compares provider
 * identity inside a `.map()`, and awaiting per element would serialise a
 * loop that only ever needs one batched lookup.
 */
function authModeFromKind(kind: string | undefined, authMode: unknown): AuthMode {
  if (authMode === 'apiKey' || authMode === 'oauth' || authMode === 'localSession') {
    return authMode
  }
  return providerCatalog.get(kind ?? '')?.manifest.capabilities.defaultAuthMode ?? 'apiKey'
}

export async function effectiveProviderAuthMode(
  providerId: unknown,
  authMode: unknown,
): Promise<AuthMode> {
  if (authMode === 'apiKey' || authMode === 'oauth' || authMode === 'localSession') {
    return authMode
  }
  if (typeof providerId !== 'string') return 'apiKey'
  const [provider] = await db
    .select({ kind: providers.kind })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1)
  return authModeFromKind(provider?.kind, authMode)
}

export function maskProviderChainConfig(
  config: AgentRow['config'],
  replacement: string | null = '********',
  opts?: { revealOauth?: boolean },
): AgentRow['config'] {
  if (!config || !Array.isArray((config as Record<string, unknown>).providerChain)) return config
  const raw = config as Record<string, unknown>
  const providerChain = (raw.providerChain as Array<Record<string, unknown>>).map((item) => ({
    ...item,
    ...(replacement === null && item.providerOauthAccountId
      ? { providerOauthAccountId: null }
      : {}),
    ...(item.providerApiKey ? { providerApiKey: replacement } : {}),
    ...(item.providerBaseUrl ? { providerBaseUrl: replacement } : {}),
    // OAuth tokens remain revealable only on the dedicated Agent detail path.
    ...(item.providerOauthToken && !opts?.revealOauth ? { providerOauthToken: replacement } : {}),
  }))
  return { ...raw, providerChain } as AgentRow['config']
}

export async function preserveProviderChainSecrets(
  nextConfig: Record<string, unknown> | null | undefined,
  existingAgent: AgentRow,
): Promise<Record<string, unknown> | null | undefined> {
  if (!nextConfig || !Array.isArray(nextConfig.providerChain)) return nextConfig

  // One batched lookup for every provider id the comparison below touches,
  // rather than a query per chain element.
  const referencedIds = new Set<string>()
  const collectId = (value: unknown) => {
    if (typeof value === 'string') referencedIds.add(value)
  }
  collectId(existingAgent.providerId)
  for (const item of nextConfig.providerChain as Array<Record<string, unknown>>) {
    collectId(item.providerId)
  }
  const existingChainForIds = (existingAgent.config as Record<string, unknown> | null | undefined)
    ?.providerChain
  if (Array.isArray(existingChainForIds)) {
    for (const item of existingChainForIds as Array<Record<string, unknown>>) {
      collectId(item.providerId)
    }
  }
  const kindById = new Map<string, string>()
  if (referencedIds.size > 0) {
    const rows = await db
      .select({ id: providers.id, kind: providers.kind })
      .from(providers)
      .where(inArray(providers.id, [...referencedIds]))
    for (const row of rows) kindById.set(row.id, row.kind)
  }
  const modeOf = (providerId: unknown, authMode: unknown): AuthMode =>
    authModeFromKind(
      typeof providerId === 'string' ? kindById.get(providerId) : undefined,
      authMode,
    )

  const existingConfig = existingAgent.config as Record<string, unknown> | null | undefined
  const existingChain = Array.isArray(existingConfig?.providerChain)
    ? (existingConfig.providerChain as Array<Record<string, unknown>>)
    : null
  const existingById = new Map<string, { item: Record<string, unknown>; index: number }>()
  existingChain?.forEach((item, index) => {
    if (typeof item.id === 'string') existingById.set(item.id, { item, index })
  })
  const sameProviderIdentity = (next: Record<string, unknown>, existing: Record<string, unknown>) =>
    next.providerId === existing.providerId &&
    modeOf(next.providerId, next.authMode) === modeOf(existing.providerId, existing.authMode)
  const restoreMasked = (nextValue: unknown, existingValue: unknown) =>
    nextValue === '********' ? (existingValue ?? null) : nextValue

  return {
    ...nextConfig,
    providerChain: (nextConfig.providerChain as Array<Record<string, unknown>>).map(
      (item, index) => {
        const existingByStableId =
          typeof item.id === 'string' ? existingById.get(item.id)?.item : undefined
        const existingByPosition = existingChain?.[index]
        const existing =
          existingByStableId && sameProviderIdentity(item, existingByStableId)
            ? existingByStableId
            : existingByPosition && sameProviderIdentity(item, existingByPosition)
              ? existingByPosition
              : null
        const legacy =
          !existingChain &&
          index === 0 &&
          item.providerId === existingAgent.providerId &&
          modeOf(item.providerId, item.authMode) ===
            modeOf(existingAgent.providerId, existingAgent.authMode)
            ? {
                providerApiKey: existingAgent.providerApiKey,
                providerBaseUrl: existingAgent.providerBaseUrl,
                providerOauthToken: existingAgent.providerOauthToken,
              }
            : null
        const source = existing ?? legacy
        return {
          ...item,
          providerApiKey: restoreMasked(item.providerApiKey, source?.providerApiKey),
          providerBaseUrl: restoreMasked(item.providerBaseUrl, source?.providerBaseUrl),
          providerOauthToken: restoreMasked(item.providerOauthToken, source?.providerOauthToken),
        }
      },
    ),
  }
}
