/**
 * Shared helpers for the per-model metadata that model discovery returns
 * alongside the model ids.
 *
 * a2wave deliberately keeps no model catalog: which reasoning-effort levels a
 * model accepts is asked of the CLI (or the vendor endpoint) per credential and
 * never written down, so it cannot drift from what the account can really run.
 * These helpers exist so every engine reports that answer in one shape, and so
 * one distinction is preserved everywhere: **absent means "not discovered",
 * empty means "discovered, and there are none"**. Collapsing the two would make
 * a proxy that returns bare model ids look identical to a model that genuinely
 * takes no effort setting, and the UI has to tell them apart.
 */
import type { ModelCapabilities, ReasoningEffortOption } from '@a2wave/shared'
import { REASONING_EFFORT_DESCRIPTION_MAX, reasoningEffortValueSchema } from '@a2wave/shared'

/**
 * Whether a token is shaped like a level a CLI could be handed as an argument.
 *
 * Discovery output is third-party text, and the value ends up in an argv entry,
 * so anything that is not a plain lowercase word is dropped rather than
 * forwarded. This validates the shape only — the legal SET is whatever the
 * source reported, which is the whole point of discovering it.
 */
export function isReasoningEffortValue(value: unknown): value is string {
  return reasoningEffortValueSchema.safeParse(value).success
}

/**
 * Build the option list for one model, dropping tokens that fail the shape check.
 *
 * Returns `undefined` — not `[]` — when the source offered levels but none of
 * them survived. An empty array is the positive claim "this model takes no
 * effort setting", and the picker says so to the operator; a source whose
 * vocabulary this code simply could not read has made no such claim, and
 * "unknown" is the honest answer. Only a genuinely empty input yields `[]`.
 */
export function toReasoningEffortOptions(
  levels: Array<{ value: unknown; description?: unknown }>,
): ReasoningEffortOption[] | undefined {
  const options: ReasoningEffortOption[] = []
  for (const level of levels) {
    if (!isReasoningEffortValue(level.value)) continue
    options.push(
      typeof level.description === 'string' && level.description
        ? {
            value: level.value,
            description: level.description.slice(0, REASONING_EFFORT_DESCRIPTION_MAX),
          }
        : { value: level.value },
    )
  }
  if (options.length === 0 && levels.length > 0) return undefined
  return options
}

/** A model entry only earns a place in the response if it actually reports something. */
function saysSomething(capabilities: ModelCapabilities): boolean {
  return (
    capabilities.reasoningEfforts !== undefined || capabilities.defaultReasoningEffort !== undefined
  )
}

/**
 * Collapse the per-model entries into the response field, or `undefined` when
 * discovery learned nothing about any model — the "unknown" signal the UI needs
 * in order to disable the control and say why instead of offering an empty list.
 */
export function finalizeModelCapabilities(
  entries: Map<string, ModelCapabilities>,
): Record<string, ModelCapabilities> | undefined {
  const result: Record<string, ModelCapabilities> = {}
  for (const [modelId, capabilities] of entries) {
    if (saysSomething(capabilities)) result[modelId] = capabilities
  }
  return Object.keys(result).length > 0 ? result : undefined
}
