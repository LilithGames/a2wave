import type { Message } from '@a2a-js/sdk'
import type { ServerCallContext } from '@a2a-js/sdk/server'
import { z } from 'zod'

/**
 * Optional A2A v1 extension for display/audit provenance across instances.
 *
 * The values are assertions made by the immediate remote caller. They are
 * deliberately limited to display names and must never be treated as an
 * authenticated user identity or authorization input.
 */
export const A2WAVE_CALLER_PROVENANCE_EXTENSION_URI =
  'https://github.com/LilithGames/a2wave/blob/main/docs/extensions/caller-provenance-v1.md'

const displayValueSchema = z.string().trim().min(1).max(256)

const callerAgentSchema = z
  .object({
    id: displayValueSchema.optional(),
    name: displayValueSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.id || value.name), {
    message: 'callerAgent requires an id or name',
  })

export const a2aCallerProvenanceSchema = z
  .object({
    userName: displayValueSchema.optional(),
    callerAgent: callerAgentSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.userName || value.callerAgent), {
    message: 'caller provenance requires a user or Agent display value',
  })

export type A2ACallerProvenance = z.infer<typeof a2aCallerProvenanceSchema>

const forwardedDisplaySchema = z
  .object({
    display_name: displayValueSchema.optional(),
    user_info: z
      .object({
        name: displayValueSchema.optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

function decodeForwardedDisplayName(encoded: string | undefined): string | undefined {
  if (!encoded || encoded.length > 64 * 1024) return undefined
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
    const parsed = forwardedDisplaySchema.safeParse(JSON.parse(decoded))
    if (!parsed.success) return undefined
    return parsed.data.display_name ?? parsed.data.user_info?.name
  } catch {
    return undefined
  }
}

/** Build the minimal outbound assertion without forwarding the channel payload or PII. */
export function buildOutboundA2AProvenance(
  env: NodeJS.ProcessEnv = process.env,
): A2ACallerProvenance | undefined {
  const callerAgentId = env.A2WAVE_CALLER_AGENT_ID
  const callerAgentName = env.A2WAVE_CALLER_AGENT_NAME
  const candidate = {
    userName: decodeForwardedDisplayName(env.A2WAVE_CHANNEL_B64),
    ...(callerAgentId || callerAgentName
      ? {
          callerAgent: {
            ...(callerAgentId ? { id: callerAgentId } : {}),
            ...(callerAgentName ? { name: callerAgentName } : {}),
          },
        }
      : {}),
  }
  const parsed = a2aCallerProvenanceSchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}

/**
 * Read provenance only when both the HTTP-level extension activation and the
 * message-level contribution marker are present on an A2A v1 request.
 */
export function extractA2ACallerProvenance(
  message: Pick<Message, 'extensions' | 'metadata'>,
  context: Pick<ServerCallContext, 'requestedExtensions' | 'requestedVersion'>,
): A2ACallerProvenance | undefined {
  if (context.requestedVersion !== '1.0') return undefined
  if (!context.requestedExtensions?.includes(A2WAVE_CALLER_PROVENANCE_EXTENSION_URI)) {
    return undefined
  }
  if (!message.extensions.includes(A2WAVE_CALLER_PROVENANCE_EXTENSION_URI)) return undefined

  const parsed = a2aCallerProvenanceSchema.safeParse(
    message.metadata?.[A2WAVE_CALLER_PROVENANCE_EXTENSION_URI],
  )
  return parsed.success ? parsed.data : undefined
}
