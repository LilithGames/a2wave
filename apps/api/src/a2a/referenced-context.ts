import type { Message } from '@a2a-js/sdk'
import type { ServerCallContext } from '@a2a-js/sdk/server'
import { z } from 'zod'
import type { ReferencedPromptContext } from '../engine/types.js'

/** Optional A2A v1 extension for explicitly forwarding bounded quoted material. */
export const A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI =
  'https://github.com/LilithGames/a2wave/blob/main/docs/extensions/referenced-context-v1.md'

export const A2WAVE_REFERENCED_CONTEXT_ENV = 'A2WAVE_REFERENCED_CONTEXT_B64'
export const A2WAVE_REFERENCED_CONTEXT_MAX_CHARS = 12_000
// JSON escaping plus base64url can expand a schema-valid 12K UTF-16 payload far
// beyond its visible character count. This bound covers the worst-case escaped
// text and four maximum-length metadata fields while still rejecting an
// unexpectedly large environment value before decoding it.
const MAX_ENCODED_CONTEXT_BYTES = 112 * 1024

const metadataValueSchema = z.string().trim().min(1).max(256)

export const a2aReferencedContextSchema = z
  .object({
    source: metadataValueSchema,
    text: z.string().trim().min(1).max(A2WAVE_REFERENCED_CONTEXT_MAX_CHARS),
    messageId: metadataValueSchema.optional(),
    messageType: metadataValueSchema.optional(),
    senderType: metadataValueSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict()

/** Decode the context placed in the router process environment by the platform. */
export function buildOutboundA2AReferencedContext(
  env: NodeJS.ProcessEnv = process.env,
): ReferencedPromptContext | undefined {
  const encoded = env[A2WAVE_REFERENCED_CONTEXT_ENV]
  if (!encoded || encoded.length > MAX_ENCODED_CONTEXT_BYTES) return undefined
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
    const parsed = a2aReferencedContextSchema.safeParse(JSON.parse(decoded))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * Read referenced material only when the A2A v1 transport and message both
 * activate the extension. Its body remains untrusted prompt context.
 */
export function extractA2AReferencedContext(
  message: Pick<Message, 'extensions' | 'metadata'>,
  context: Pick<ServerCallContext, 'requestedExtensions' | 'requestedVersion'>,
): ReferencedPromptContext | undefined {
  if (context.requestedVersion !== '1.0') return undefined
  if (!context.requestedExtensions?.includes(A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI)) {
    return undefined
  }
  if (!message.extensions.includes(A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI)) return undefined

  const parsed = a2aReferencedContextSchema.safeParse(
    message.metadata?.[A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI],
  )
  return parsed.success ? parsed.data : undefined
}

/** Convert the wire model to the durable run-context naming convention. */
export function toPersistedReferencedMessage(
  referenced: ReferencedPromptContext,
): Record<string, unknown> {
  return {
    source: referenced.source,
    text: referenced.text,
    ...(referenced.messageId ? { message_id: referenced.messageId } : {}),
    ...(referenced.messageType ? { message_type: referenced.messageType } : {}),
    ...(referenced.senderType ? { sender_type: referenced.senderType } : {}),
    ...(referenced.truncated !== undefined ? { truncated: referenced.truncated } : {}),
  }
}
