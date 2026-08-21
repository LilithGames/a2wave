/**
 * Pick the language for a programmatic command reply.
 *
 * A command reply never reaches the LLM, so it cannot pick up the language of
 * the conversation the way a run's output does — the Agent's
 * `commandReplyLanguage` setting is what decides it.
 *
 * `auto` reads the invoking message, which is the only locale signal available
 * at every interception point: no channel plumbs a per-user locale through to
 * the run context today (Feishu's `locale` keys describe outbound post payloads,
 * not the sender). Deliberately a hint, not detection — `en` is the fallback.
 */
import type { CommandReplyLanguage } from '@a2wave/shared'

export type ResolvedCommandReplyLanguage = Exclude<CommandReplyLanguage, 'auto'>

/** CJK Unified Ideographs; enough to separate a Chinese message from an English one. */
const HAN = /[一-鿿]/

export function resolveCommandReplyLanguage(
  setting: CommandReplyLanguage | null | undefined,
  hint: { text: string },
): ResolvedCommandReplyLanguage {
  if (setting === 'en' || setting === 'zh') return setting
  return HAN.test(hint.text) ? 'zh' : 'en'
}
