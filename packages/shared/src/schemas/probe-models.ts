import { z } from 'zod'
import { authHeaderStyleEnum, authModeEnum, reasoningEffortValueSchema } from './agent.js'
import { type ProviderKind, providerKindSchema } from './provider.js'

// The transport schema is provider-agnostic. Provider-specific auth and
// credential rules are owned by ProviderCatalog so adding a provider does not
// require another shared discriminated union.
export const probeModelsRequestSchema = z
  .object({
    kind: providerKindSchema.optional(),
    engineType: providerKindSchema.optional(),
    authMode: authModeEnum,
    authHeaderStyle: authHeaderStyleEnum.optional(),
    apiKey: z.string().min(1, 'apiKey cannot be empty').optional(),
    oauthToken: z.string().min(1, 'oauthToken cannot be empty').optional(),
    baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
  })
  .superRefine((request, ctx) => {
    if (!request.kind && !request.engineType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'kind is required',
      })
    }
    if (request.kind && request.engineType && request.kind !== request.engineType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['engineType'],
        message: 'kind and engineType must match',
      })
    }
  })
  .transform((request) => ({
    kind: (request.kind ?? request.engineType) as ProviderKind,
    authMode: request.authMode,
    ...(request.authHeaderStyle ? { authHeaderStyle: request.authHeaderStyle } : {}),
    ...(request.apiKey ? { apiKey: request.apiKey } : {}),
    ...(request.oauthToken ? { oauthToken: request.oauthToken } : {}),
    ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
  }))

/** Request body accepted from clients, including the legacy `engineType` alias. */
export type ProbeModelsRequest = z.input<typeof probeModelsRequestSchema>

/** Normalized request used by the API and ProviderAdapter. */
export type ResolvedProbeModelsRequest = z.output<typeof probeModelsRequestSchema>

/** One reasoning-effort level a model accepts, with the CLI's own wording for it. */
export const reasoningEffortOptionSchema = z.object({
  value: reasoningEffortValueSchema,
  description: z.string().max(200).optional(),
})
export type ReasoningEffortOption = z.infer<typeof reasoningEffortOptionSchema>

/**
 * What discovery learned about ONE model, beyond its id.
 *
 * Every field is optional because a source may simply not report it: a proxy
 * standing in for the vendor endpoint typically returns bare model ids. An
 * absent `reasoningEfforts` therefore means "unknown", which is not the same as
 * an empty array — that is a model discovery positively said accepts no effort.
 * Callers must keep the two apart; collapsing them would make an unprobeable
 * credential look like a model with no levels.
 */
export const modelCapabilitiesSchema = z.object({
  reasoningEfforts: z.array(reasoningEffortOptionSchema).optional(),
  defaultReasoningEffort: reasoningEffortValueSchema.optional(),
})
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>

/**
 * Whether these credentials may actually use fast mode, as answered by the
 * vendor rather than guessed from the model name.
 *
 * `available` is only ever reported when the vendor answered. A missing object
 * means "not asked, or the answer did not arrive" — the control then stays
 * usable, because refusing a feature on the strength of a failed probe is worse
 * than letting a run report the outcome itself.
 */
export const fastModeAvailabilitySchema = z.object({
  available: z.boolean(),
  /** Vendor's machine-readable reason when unavailable, e.g. `extra_usage_disabled`. */
  reason: z.string().max(64).optional(),
})
export type FastModeAvailability = z.infer<typeof fastModeAvailabilitySchema>

export const probeModelsResponseSchema = z.object({
  models: z.array(z.string()),
  fastMode: fastModeAvailabilitySchema.optional(),
  /**
   * Keyed by model id rather than positional, so the form can look up the entry
   * for whichever model is selected without re-deriving an index. Absent
   * entirely when the source reported nothing usable.
   */
  modelCapabilities: z.record(modelCapabilitiesSchema).optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  details: z.record(z.unknown()).optional(),
})

export type ProbeModelsResponse = z.infer<typeof probeModelsResponseSchema>

/** Compatibility alias for clients that still call the field `engineType`. */
export type ProbeEngineType = ProviderKind
