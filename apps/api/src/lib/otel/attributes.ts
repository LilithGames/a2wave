import type { Attributes } from '@opentelemetry/api'
import type { TokenUsage } from '../../engine/types.js'
import type { AgentConfig } from '../agent-helpers.js'

/**
 * Span attribute names. `gen_ai.*` follows the OpenTelemetry GenAI semantic conventions; they are
 * plain strings rather than an `@opentelemetry/semantic-conventions` import because that package
 * still ships them as unstable/incubating exports.
 */
export const ATTR = {
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  AGENT_ID: 'gen_ai.agent.id',
  AGENT_NAME: 'gen_ai.agent.name',
  CONVERSATION_ID: 'gen_ai.conversation.id',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  USAGE_CACHE_READ_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
  USAGE_CACHE_CREATION_TOKENS: 'gen_ai.usage.cache_creation.input_tokens',
  USAGE_REASONING_TOKENS: 'a2wave.usage.reasoning_tokens',
  INPUT_MESSAGES: 'gen_ai.input.messages',
  OUTPUT_MESSAGES: 'gen_ai.output.messages',
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  TOOL_CALL_ARGUMENTS: 'gen_ai.tool.call.arguments',
  ERROR_TYPE: 'error.type',
  RUN_ID: 'a2wave.run.id',
  TASK_ID: 'a2wave.task.id',
  TRIGGER_SOURCE: 'a2wave.trigger.source',
  RUN_OUTCOME: 'a2wave.run.outcome',
  ATTEMPT_COUNT: 'a2wave.attempt.count',
  RETRY_COUNT: 'a2wave.retry.count',
  ATTEMPT_NUMBER: 'a2wave.attempt.number',
  PROVIDER_INDEX: 'a2wave.provider.index',
  PROVIDER_ID: 'a2wave.provider.id',
  PROVIDER_DISPLAY_NAME: 'a2wave.provider.name',
  CHAT_RESET: 'a2wave.chat.reset',
  /** Set on every span of the settings page's "test connection" trace; never on a real run. */
  TEST: 'a2wave.test',
  // OpenInference mirror. Backends that speak it (Phoenix, Arize, Langfuse) translate gen_ai.*
  // into their own llm.* keys, but never derive these — and their input / output / kind columns
  // read exactly these.
  OI_SPAN_KIND: 'openinference.span.kind',
  OI_SESSION_ID: 'session.id',
  OI_INPUT_VALUE: 'input.value',
  OI_INPUT_MIME_TYPE: 'input.mime_type',
  OI_OUTPUT_VALUE: 'output.value',
  OI_OUTPUT_MIME_TYPE: 'output.mime_type',
  TOOL_UNPAIRED: 'a2wave.tool.unpaired',
  TOOL_INCOMPLETE: 'a2wave.tool.incomplete',
} as const

export const CONTENT_MAX_LENGTH = 4096
const REDACTED = '[REDACTED]'
/** Shorter values are too likely to be ordinary words; masking them would shred the text. */
const MIN_SECRET_LENGTH = 8

export function truncate(value: string, max = CONTENT_MAX_LENGTH): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…[truncated ${value.length - max}]`
}

type SecretSource = Pick<
  AgentConfig,
  'providerApiKey' | 'providerOauthToken' | 'agentEnv' | 'resolvedMcpServers'
>

/**
 * Every credential value the platform injected into this execution. An Agent can echo any of them
 * back in its output or tool arguments, so captured content is scrubbed against this list.
 */
export function collectSecretValues(agentConfig: SecretSource | undefined): string[] {
  if (!agentConfig) return []
  const values: Array<string | undefined> = [
    agentConfig.providerApiKey,
    agentConfig.providerOauthToken,
    ...Object.values(agentConfig.agentEnv ?? {}),
  ]
  for (const server of agentConfig.resolvedMcpServers ?? []) {
    values.push(...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {}))
  }
  const unique = new Set<string>()
  for (const value of values) {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) unique.add(value)
  }
  return [...unique]
}

const CREDENTIAL_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${REDACTED}`],
  [/\b(?:sk|a2ak|ak)[-_][A-Za-z0-9_-]{12,}/g, REDACTED],
]

export function maskSecrets(value: string, secrets: readonly string[]): string {
  let out = value
  // Longest first: masking a contained shorter secret first would leave the longer one's tail.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(REDACTED)
  }
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Mask first, truncate second: a secret straddling the cut must not leak its head. */
export function toContentAttribute(value: string, secrets: readonly string[]): string {
  return truncate(maskSecrets(value, secrets))
}

/**
 * Only reported fields are mapped. A provider that does not report tokens (kimi, qoder) yields no
 * usage attributes at all — `0` would claim a measurement that never happened.
 */
export function usageAttributes(usage: TokenUsage | undefined): Attributes {
  const attrs: Attributes = {}
  if (!usage) return attrs
  if (usage.inputTokens !== undefined) attrs[ATTR.USAGE_INPUT_TOKENS] = usage.inputTokens
  if (usage.outputTokens !== undefined) attrs[ATTR.USAGE_OUTPUT_TOKENS] = usage.outputTokens
  if (usage.reasoningTokens !== undefined)
    attrs[ATTR.USAGE_REASONING_TOKENS] = usage.reasoningTokens
  if (usage.cacheReadTokens !== undefined)
    attrs[ATTR.USAGE_CACHE_READ_TOKENS] = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) {
    attrs[ATTR.USAGE_CACHE_CREATION_TOKENS] = usage.cacheWriteTokens
  }
  return attrs
}

/** Injected by execute-with-retry so this module does not import it back (cycle). */
export interface ErrorClassifiers {
  isPermanent?: (error: string | undefined) => boolean
  isHardQuota?: (error: string | undefined) => boolean
}

export type RunErrorType = 'timeout' | 'quota' | 'permanent' | '_OTHER'

/** Low-cardinality `error.type`; the error text itself is content and is gated separately. */
export function classifyError(
  error: string | undefined,
  classifiers: ErrorClassifiers = {},
): RunErrorType {
  if (error && /timeout|timed out/i.test(error)) return 'timeout'
  if (classifiers.isHardQuota?.(error)) return 'quota'
  if (classifiers.isPermanent?.(error)) return 'permanent'
  return '_OTHER'
}
