/** QQ Official conversations intentionally expire after a period of inactivity. */
export const QQ_C2C_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000
export const QQ_GROUP_SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000

/**
 * Return the inactivity limit encoded by a durable QQ channel context.
 * Other native chat transports have no server-side timeout.
 */
export function resolveQQOfficialSessionTimeoutMs(context: unknown): number | undefined {
  if (!context || typeof context !== 'object') return undefined
  const channel = (context as { channel?: unknown }).channel
  if (!channel || typeof channel !== 'object') return undefined
  const info = (channel as { channel_info?: unknown }).channel_info
  if (!info || typeof info !== 'object') return undefined
  const scene = (info as { scene?: unknown }).scene
  if (scene === 'c2c') return QQ_C2C_SESSION_TIMEOUT_MS
  if (scene === 'group') return QQ_GROUP_SESSION_TIMEOUT_MS
  return undefined
}
