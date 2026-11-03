const PREFIX = 'codex-oauth:v1:'

/** Provider chat IDs are opaque outside the engine; carry the issuing account with them. */
export function encodeCodexOAuthChatId(accountId: string, threadId: string): string {
  return `${PREFIX}${Buffer.from(JSON.stringify([accountId, threadId])).toString('base64url')}`
}

export function isCodexOAuthChatId(chatId: string | undefined): boolean {
  return !!chatId?.startsWith(PREFIX)
}

/** Untagged and foreign-account sessions must start a new thread, including crash recovery. */
export function decodeCodexOAuthChatId(
  chatId: string | undefined,
  accountId: string,
): string | undefined {
  if (!chatId?.startsWith(PREFIX)) return undefined
  try {
    const value: unknown = JSON.parse(
      Buffer.from(chatId.slice(PREFIX.length), 'base64url').toString(),
    )
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value[0] === accountId &&
      typeof value[1] === 'string' &&
      value[1]
    )
      return value[1]
  } catch {
    // Unknown or malformed identifiers have no verifiable account ownership.
  }
  return undefined
}
