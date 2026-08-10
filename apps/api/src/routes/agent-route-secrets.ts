import type { A2ARouteTarget } from '@a2wave/shared'

const MASKED_SECRET = '********'

type RemoteA2ARouteTarget = Extract<A2ARouteTarget, { type: 'remote' }>

interface AgentEnvEntry {
  value: string
  sensitive: boolean
}

export function maskSensitiveEnv<T extends { env: Record<string, AgentEnvEntry> | null }>(
  agent: T,
): T {
  if (!agent.env) return agent
  const maskedEnv = Object.fromEntries(
    Object.entries(agent.env).map(([key, value]) => [
      key,
      value.sensitive ? { ...value, value: MASKED_SECRET } : value,
    ]),
  )
  return { ...agent, env: maskedEnv }
}

/**
 * Restore masked sensitive env values, and refuse the write when there is nothing
 * to restore — rather than persisting the placeholder as if it were the secret.
 *
 * The UI never receives a sensitive value in plaintext: it renders the masked
 * placeholder and submits the whole record back verbatim. A key is the only handle
 * on the stored value, so renaming one (fixing a typo, say) while leaving the dots
 * untouched used to look up the *new* name, find nothing, and store '********' as
 * the value. The Agent then injects that literal at every run, the Provider fails
 * to authenticate, and the original secret is gone — with the UI still showing dots,
 * so it reads as configured. Every subsequent save "preserves" the placeholder again,
 * leaving no way to notice, let alone recover.
 *
 * Rejecting mirrors `preserveA2ARouteTargetSecrets`: the user re-enters the value
 * once, which is the only way the server can learn a secret it was never sent.
 *
 * Rejection is deliberately narrow — only a key with no stored entry at all, or one
 * whose stored value is already the placeholder. Anything else that exists is restored,
 * because the alternative is blocking saves on Agents whose env is in a perfectly
 * ordinary state (a blank secret from clone/import, a variable just marked sensitive).
 */
/**
 * True when the stored env holds at least one sensitive value a rename could strand.
 *
 * A blank value and the placeholder itself are both "nothing to lose", so renaming a key
 * that only ever held one of those is harmless and must not be rejected.
 */
function hasRestorableSecret(
  existingEnv: Record<string, AgentEnvEntry> | null | undefined,
): boolean {
  return Object.values(existingEnv ?? {}).some(
    (entry) => entry.sensitive && entry.value && entry.value !== MASKED_SECRET,
  )
}

export function preserveSensitiveEnvSecrets(
  nextEnv: Record<string, AgentEnvEntry> | null | undefined,
  existingEnv: Record<string, AgentEnvEntry> | null | undefined,
): { ok: true; value: typeof nextEnv } | { ok: false; key: string } {
  if (!nextEnv) return { ok: true, value: nextEnv }

  const restored: Record<string, AgentEnvEntry> = {}
  for (const [key, entry] of Object.entries(nextEnv)) {
    // A non-sensitive value round-trips in plaintext, so '********' there is
    // the user's own text and is stored as typed.
    if (!entry.sensitive || entry.value !== MASKED_SECRET) {
      restored[key] = entry
      continue
    }
    const stored = existingEnv?.[key]
    // No entry under this key: the key is the only handle on the stored value, so the
    // placeholder can never be resolved. That is the rename case — reject, but only when
    // a real secret would actually be stranded. If nothing stored holds one, the rename
    // costs nothing, and refusing it would demand the user "re-enter" a value that never
    // existed (renaming a blank row from clone or import is exactly that).
    if (!stored) {
      if (hasRestorableSecret(existingEnv)) return { ok: false, key }
      restored[key] = { ...entry, value: '' }
      continue
    }
    // A stored placeholder is a row already corrupted by the pre-fix bug. Blank it rather
    // than reject: rejecting locks those Agents out of every unrelated edit — and they are
    // the ones this guard exists for — while blanking heals the row, stops the bad value
    // reaching the runtime, and lets the save through.
    restored[key] = { ...entry, value: stored.value === MASKED_SECRET ? '' : stored.value }
  }
  return { ok: true, value: restored }
}

export function maskProviderChainConfig<T>(
  config: T,
  replacement: string | null = MASKED_SECRET,
  opts?: { revealOauth?: boolean },
): T {
  if (!config || typeof config !== 'object') return config
  const raw = config as Record<string, unknown>
  if (!Array.isArray(raw.providerChain)) return config
  const providerChain = (raw.providerChain as Array<Record<string, unknown>>).map((item) => ({
    ...item,
    ...(item.providerApiKey ? { providerApiKey: replacement } : {}),
    ...(item.providerBaseUrl ? { providerBaseUrl: replacement } : {}),
    ...(item.providerOauthToken && !opts?.revealOauth ? { providerOauthToken: replacement } : {}),
  }))
  return { ...raw, providerChain } as T
}

export function maskA2ARouteTargetSecrets(
  targets: A2ARouteTarget[] | null | undefined,
): A2ARouteTarget[] | null | undefined {
  if (!targets) return targets
  return targets.map((target) =>
    target.type === 'remote' && target.apiKey ? { ...target, apiKey: MASKED_SECRET } : target,
  )
}

function remoteA2ATargetEndpointIdentity(target: RemoteA2ARouteTarget): string {
  const connectionMode = target.connectionMode ?? 'direct'
  const protocolVersion = connectionMode === 'direct' ? (target.protocolVersion ?? '0.3') : ''
  return JSON.stringify([target.url, connectionMode, protocolVersion])
}

export function preserveA2ARouteTargetSecrets(
  nextTargets: A2ARouteTarget[] | null | undefined,
  existingTargets: A2ARouteTarget[] | null | undefined,
): { ok: true; value: A2ARouteTarget[] | null | undefined } | { ok: false; targetName: string } {
  if (!nextTargets) return { ok: true, value: nextTargets }

  const existingRemoteTargets = new Map<
    string,
    Array<{ index: number; target: RemoteA2ARouteTarget }>
  >()
  for (const [index, target] of (existingTargets ?? []).entries()) {
    if (target.type !== 'remote') continue
    const identity = remoteA2ATargetEndpointIdentity(target)
    const matches = existingRemoteTargets.get(identity) ?? []
    matches.push({ index, target })
    existingRemoteTargets.set(identity, matches)
  }

  const maskedTargets = nextTargets.flatMap((target, index) =>
    target.type === 'remote' && target.apiKey === MASKED_SECRET ? [{ index, target }] : [],
  )
  const assigned = new Map<number, RemoteA2ARouteTarget>()
  const consumedExistingIndexes = new Set<number>()

  // Prefer stable-name matches when multiple routes intentionally share one endpoint.
  for (const { index, target } of maskedTargets) {
    const candidates = existingRemoteTargets
      .get(remoteA2ATargetEndpointIdentity(target))
      ?.filter(
        (candidate) =>
          !consumedExistingIndexes.has(candidate.index) && candidate.target.name === target.name,
      )
    if (candidates?.length !== 1) continue
    assigned.set(index, candidates[0].target)
    consumedExistingIndexes.add(candidates[0].index)
  }

  // A display name may change, but one stored credential may never be cloned.
  for (const { index, target } of maskedTargets) {
    if (assigned.has(index)) continue
    const candidates = existingRemoteTargets
      .get(remoteA2ATargetEndpointIdentity(target))
      ?.filter((candidate) => !consumedExistingIndexes.has(candidate.index))
    if (candidates?.length !== 1) return { ok: false, targetName: target.name }
    assigned.set(index, candidates[0].target)
    consumedExistingIndexes.add(candidates[0].index)
  }

  const restored: A2ARouteTarget[] = []
  for (const [index, target] of nextTargets.entries()) {
    if (target.type !== 'remote' || target.apiKey !== MASKED_SECRET) {
      restored.push(target)
      continue
    }

    const stored = assigned.get(index)?.apiKey
    if (!stored || stored === MASKED_SECRET) return { ok: false, targetName: target.name }
    restored.push({ ...target, apiKey: stored })
  }
  return { ok: true, value: restored }
}
