export const NATIVE_CHAT_CHANNELS = ['slack', 'discord', 'qq_official'] as const

export type NativeChatSource = (typeof NATIVE_CHAT_CHANNELS)[number]

export function isNativeChatChannel(value: unknown): value is NativeChatSource {
  return NATIVE_CHAT_CHANNELS.some((channel) => channel === value)
}
