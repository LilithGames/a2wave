/**
 * 历史附件回显的配对逻辑（纯函数，可测）。
 *
 * 附件 refs 存在 runSteps.input.attachments；每个 chat turn 顺序插一条 step + 一条 user
 * 消息，所以按顺序把第 N 个 step 的附件配到第 N 条 user 消息上。agent 消息不带附件。
 */

interface RoledMessage {
  role: string
}

export interface PublicHistoryAttachmentRef extends Record<string, unknown> {
  token?: string
  name: string
  mimeType: string
  size?: number
}

function toPublicHistoryAttachment(value: unknown): PublicHistoryAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.name !== 'string' || typeof raw.mimeType !== 'string') return undefined
  if (raw.token !== undefined && typeof raw.token !== 'string') return undefined
  if (
    raw.size !== undefined &&
    (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0)
  ) {
    return undefined
  }
  return {
    name: raw.name,
    mimeType: raw.mimeType,
    ...(typeof raw.token === 'string' ? { token: raw.token } : {}),
    ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
  }
}

/** 从有序 steps 抽出各自的公开 attachment records（可能为空）。 */
export function extractStepAttachments(
  steps: { input: unknown }[],
): (PublicHistoryAttachmentRef[] | undefined)[] {
  return steps.map((s) => {
    const input = s.input as { attachments?: unknown } | null
    const a = input?.attachments
    if (!Array.isArray(a)) return undefined
    const records = a.flatMap((value) => {
      const attachment = toPublicHistoryAttachment(value)
      return attachment ? [attachment] : []
    })
    return records.length > 0 ? records : undefined
  })
}

/**
 * 按顺序把 step 附件配到 user 消息，返回与 messages 等长的数组：user 消息位置是其
 * 附件（无则 undefined），非 user 位置恒为 undefined。
 */
export function pairAttachmentsToMessages(
  messages: RoledMessage[],
  stepAttachments: (PublicHistoryAttachmentRef[] | undefined)[],
): (PublicHistoryAttachmentRef[] | undefined)[] {
  let userIdx = 0
  return messages.map((m) => {
    if (m.role !== 'user') return undefined
    const refs = stepAttachments[userIdx]
    userIdx += 1
    return refs
  })
}
