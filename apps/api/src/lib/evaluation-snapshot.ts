/**
 * Evaluation config snapshot.
 *
 * Freezes the config variables a task depends on: provider + model + system
 * prompt. Provider and model are the primary variables under test; the prompt
 * is kept as a secondary one, because otherwise a historical score becomes
 * impossible to explain once the prompt has been edited.
 *
 * `engineType` is deliberately not stored: it is derived from the provider name
 * via getProviderEngineType(), and the providers table has no such column, so a
 * second copy would only drift. Derive it on demand instead.
 */
import type { agents } from '../db/schema.js'
import {
  type AgentConfig,
  applyProviderBinding,
  buildAgentConfig,
  type ResolvedProviderBinding,
} from './agent-helpers.js'

type AgentRow = typeof agents.$inferSelect

export interface EvaluationConfigSnapshot {
  providerId: string | null
  /** Denormalised: still shows which provider was used after it is deleted. */
  providerName: string | null
  model: string | null
  /**
   * The reasoning controls of the binding that will run. They belong in the
   * snapshot for the same reason the model does: both change what a run costs
   * and how it answers, so replaying a set at a different level and filing the
   * results under the same task would move a variable the comparison assumes is
   * fixed. `null` means the task did not configure one — including tasks created
   * before these fields existed.
   */
  reasoningEffort: string | null
  fastMode: boolean | null
  systemPrompt: string
  capturedAt: Date
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * The task's frozen provider is no longer available on the Agent.
 *
 * Surfaced as the task's error text, so the user is told which provider went
 * missing rather than being handed results from a substitute.
 */
export class EvaluationProviderUnavailableError extends Error {
  constructor(providerId: string) {
    super(
      `Evaluation provider ${providerId} is no longer configured on this agent. Re-add it, or create a new task to evaluate the current configuration.`,
    )
    this.name = 'EvaluationProviderUnavailableError'
  }
}

/**
 * Overlays a frozen snapshot onto a freshly built live config.
 *
 * The snapshot is what the task promises to have run, and it is captured at
 * creation time while execution can begin minutes later after queueing — so
 * driving the run from the live config lets an Agent edited in between silently
 * diverge from the configuration the detail page attributes the results to.
 *
 * All three snapshotted variables are restored, provider included: it is the
 * primary variable under test, so a run attributed to the snapshot's provider
 * while actually executing on a newly swapped one is exactly the comparison
 * this feature exists to make trustworthy.
 *
 * Credentials are deliberately *not* frozen — the snapshot stores none by
 * design. The provider is re-resolved by id against the live `providers` table,
 * so a key rotated after the task was created is picked up without changing
 * what the task measures.
 *
 * If that provider has since been deleted the live config is kept and the
 * mismatch is logged: failing the task would be worse than running it, but it
 * must not pass silently as though the snapshot had been honoured.
 */
export function applyEvaluationSnapshot(
  liveConfig: AgentConfig,
  snapshot:
    | (Pick<EvaluationConfigSnapshot, 'providerId' | 'model' | 'systemPrompt'> &
        Partial<Pick<EvaluationConfigSnapshot, 'reasoningEffort' | 'fastMode'>>)
    | null
    | undefined,
  agent?: AgentRow,
): AgentConfig {
  if (!snapshot) return liveConfig

  const config: AgentConfig = { ...liveConfig, systemPrompt: snapshot.systemPrompt }

  // Provider and model are restored as one unit or not at all. A model name is
  // only meaningful to the provider that serves it, so pinning the snapshot's
  // model onto a different provider would send that provider a name it does not
  // recognise — turning a graceful fallback into a task that fails outright.
  const pinnedChain =
    snapshot.providerId && agent
      ? (Array.isArray(liveConfig.providerChain) ? liveConfig.providerChain : [])
          .filter((item): item is ResolvedProviderBinding => !!item && typeof item === 'object')
          .filter((item) => item.providerId === snapshot.providerId)
      : []

  if (pinnedChain.length > 0) {
    // The chain must be pinned, not just the top-level binding: executeWithRetry
    // re-reads `providerChain` and reapplies its first entry over whatever the
    // caller set, so leaving the live chain in place would silently undo this.
    //
    // Reuse the Agent's own resolved binding: it already carries the right
    // authMode and the credentials belonging to *this* provider. Never
    // synthesize one from the agent's legacy secret columns — after a provider
    // swap those hold the replacement's credential, and sending it to the
    // snapshot provider's endpoint would disclose it to the wrong host.
    applyProviderBinding(config, pinnedChain[0])

    // After applyProviderBinding, which sets these from the binding.
    const model = snapshot.model ?? pinnedChain[0].model
    if (model) config.model = model

    // KEY PRESENCE, not value, decides whether this snapshot has an opinion.
    //
    // `null` is a real answer here — "captured while the control was unset" —
    // and `??` cannot tell it apart from a row written before these fields
    // existed. Reading both as "inherit the live value" is a silent drift in the
    // one direction the snapshot exists to prevent: a task queued with fast mode
    // OFF would run WITH it if the operator flipped the Agent in between, and the
    // results would be filed as though nothing changed. A pre-change row carries
    // neither key and still inherits, which is what keeps those tasks running.
    const hasEffort = 'reasoningEffort' in snapshot
    const hasFastMode = 'fastMode' in snapshot
    const reasoningEffort = hasEffort ? snapshot.reasoningEffort : pinnedChain[0].reasoningEffort
    const fastMode = hasFastMode ? snapshot.fastMode : pinnedChain[0].fastMode

    // Assigned rather than deleted: every consumer reads the VALUE
    // (`typeof … === 'string'`, `=== true`), so `undefined` overrides what
    // applyProviderBinding just set, and the key staying present is invisible.
    config.reasoningEffort = reasoningEffort || undefined
    config.fastMode = fastMode === true ? true : undefined

    config.providerChain = pinnedChain.map((item) => ({
      ...item,
      model: model ?? item.model,
      // `undefined`, never null: the binding is what the engine reads, and an
      // unset control there means "pass nothing and take the CLI's default".
      reasoningEffort: reasoningEffort ?? undefined,
      fastMode: fastMode === true ? true : undefined,
    }))
  } else if (snapshot.providerId && snapshot.providerId !== liveConfig.providerId) {
    // The snapshot provider is no longer bound to this Agent — it was unbound
    // or disabled while the task sat in the queue.
    //
    // Fail rather than substitute the live provider. The task row permanently
    // records the snapshot's provider and model, and the detail page presents
    // results as having come from them, so running on a different provider
    // would publish a comparison that quietly attributes one provider's answers
    // to another. A failed task with a stated reason is recoverable; a
    // plausible-looking wrong one silently corrupts the evaluation history.
    throw new EvaluationProviderUnavailableError(snapshot.providerId)
  } else if (snapshot.model) {
    // Same provider as the snapshot — only the model may have drifted.
    config.model = snapshot.model
  }

  return config
}

/**
 * Build the evaluation config snapshot.
 *
 * Security constraint: the object returned by buildAgentConfig() carries
 * plaintext credentials (providerApiKey / providerOauthToken / providerBaseUrl)
 * both at the top level and inside providerChain entries. A snapshot is stored
 * long-term and is readable by every agent viewer, so this picks an explicit
 * allowlist of fields — never a wholesale copy or a blacklist removal. That way
 * a newly added field cannot leak credentials by accident.
 */
export async function buildEvaluationSnapshot(agent: AgentRow): Promise<EvaluationConfigSnapshot> {
  const config = (await buildAgentConfig(agent)) as Record<string, unknown>

  const systemPrompt =
    typeof config.systemPrompt === 'string' ? config.systemPrompt : (agent.systemPrompt ?? '')

  return {
    providerId: asNullableString(config.providerId),
    providerName: asNullableString(config.providerName),
    model: asNullableString(config.model),
    reasoningEffort: asNullableString(config.reasoningEffort),
    fastMode: asNullableBoolean(config.fastMode),
    systemPrompt,
    capturedAt: new Date(),
  }
}

/**
 * The snapshot as it is persisted in the `config_snapshot` JSON column.
 *
 * `capturedAt` is an ISO string rather than a `Date`: the column is JSON, so a
 * `Date` would be serialised to a string on write and read back as one anyway.
 * Modelling that explicitly keeps the insert type-checked — the mismatch used to
 * be hidden behind an `as never` cast at the call site, which also concealed the
 * missing `await` that made every task persist an empty snapshot.
 */
export type StoredEvaluationConfigSnapshot = Omit<EvaluationConfigSnapshot, 'capturedAt'> & {
  capturedAt: string
}

export async function buildStoredEvaluationSnapshot(
  agent: AgentRow,
): Promise<StoredEvaluationConfigSnapshot> {
  const snapshot = await buildEvaluationSnapshot(agent)
  return { ...snapshot, capturedAt: snapshot.capturedAt.toISOString() }
}
