import { describe, expect, it } from 'vitest'
import {
  buildTelegramConversationId,
  chunkTelegramText,
  extractTelegramMessage,
  extractTelegramNativeAttachments,
  parseTelegramBotId,
  shouldTriggerTelegramMessage,
  stripTelegramBotMention,
  type TelegramMessageSnapshot,
  telegramApiBase,
  telegramMessageText,
  telegramSenderName,
} from '../telegram-service.js'

const config = {
  groupTriggerOnMention: true,
  groupTriggerOnNewMessage: false,
}

const BOT_ID = '4242'
const BOT_USERNAME = 'a2wave_bot'

function message(overrides: Partial<TelegramMessageSnapshot> = {}): TelegramMessageSnapshot {
  return {
    message_id: 7,
    from: { id: 99, is_bot: false, first_name: 'Ada' },
    chat: { id: -100200, type: 'supergroup' },
    text: 'hello',
    ...overrides,
  }
}

describe('parseTelegramBotId', () => {
  it('derives the bot id from the token prefix', () => {
    expect(parseTelegramBotId('4242:AAH-secret')).toBe('4242')
  })

  it('rejects a token without a numeric bot id', () => {
    expect(() => parseTelegramBotId('not-a-token')).toThrow(/numeric bot id/)
  })
})

describe('telegramApiBase', () => {
  it('falls back to the public Bot API and strips a trailing slash', () => {
    expect(telegramApiBase({ apiBaseUrl: undefined })).toBe('https://api.telegram.org')
    expect(telegramApiBase({ apiBaseUrl: 'https://tg.internal/' })).toBe('https://tg.internal')
  })
})

describe('shouldTriggerTelegramMessage', () => {
  it('always accepts human private messages', () => {
    expect(
      shouldTriggerTelegramMessage(
        config,
        message({ chat: { id: 99, type: 'private' } }),
        BOT_ID,
        BOT_USERNAME,
      ),
    ).toBe(true)
  })

  it('ignores messages authored by any bot, to prevent reply loops', () => {
    expect(
      shouldTriggerTelegramMessage(
        config,
        message({ chat: { id: 99, type: 'private' }, from: { id: 5, is_bot: true } }),
        BOT_ID,
        BOT_USERNAME,
      ),
    ).toBe(false)
  })

  it('ignores the bot talking to itself even when is_bot is absent', () => {
    expect(
      shouldTriggerTelegramMessage(
        config,
        message({ chat: { id: 99, type: 'private' }, from: { id: Number(BOT_ID) } }),
        BOT_ID,
        BOT_USERNAME,
      ),
    ).toBe(false)
  })

  it('requires an @mention in groups by default', () => {
    expect(shouldTriggerTelegramMessage(config, message(), BOT_ID, BOT_USERNAME)).toBe(false)
    expect(
      shouldTriggerTelegramMessage(
        config,
        message({
          text: `@${BOT_USERNAME} ship it`,
          entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
        }),
        BOT_ID,
        BOT_USERNAME,
      ),
    ).toBe(true)
  })

  it('does not fire on a mention of a different bot', () => {
    expect(
      shouldTriggerTelegramMessage(
        config,
        message({
          text: '@someone_else ship it',
          entities: [{ type: 'mention', offset: 0, length: 14 }],
        }),
        BOT_ID,
        BOT_USERNAME,
      ),
    ).toBe(false)
  })

  it('treats a reply to the bot as addressing it', () => {
    expect(
      shouldTriggerTelegramMessage(
        config,
        message({ reply_to_message: { message_id: 1, from: { id: Number(BOT_ID) } } }),
        BOT_ID,
        BOT_USERNAME,
      ),
    ).toBe(true)
  })

  it('accepts every group message once groupTriggerOnNewMessage is on', () => {
    expect(
      shouldTriggerTelegramMessage(
        { groupTriggerOnMention: false, groupTriggerOnNewMessage: true },
        message(),
        BOT_ID,
        BOT_USERNAME,
      ),
    ).toBe(true)
  })

  it('recognises a mention carried by a media caption', () => {
    expect(
      shouldTriggerTelegramMessage(
        config,
        message({
          text: undefined,
          caption: `@${BOT_USERNAME} review this`,
          caption_entities: [{ type: 'mention', offset: 0, length: BOT_USERNAME.length + 1 }],
        }),
        BOT_ID,
        BOT_USERNAME,
      ),
    ).toBe(true)
  })
})

describe('stripTelegramBotMention', () => {
  it('removes the bot handle and collapses whitespace', () => {
    expect(stripTelegramBotMention(`@${BOT_USERNAME}  ship   it`, BOT_USERNAME)).toBe('ship it')
  })

  it('leaves other handles intact', () => {
    expect(stripTelegramBotMention('@someone ship it', BOT_USERNAME)).toBe('@someone ship it')
  })
})

describe('telegramMessageText', () => {
  it('falls back to the caption so a media-only message still carries intent', () => {
    expect(telegramMessageText(message({ text: undefined, caption: ' look ' }))).toBe('look')
  })
})

describe('extractTelegramNativeAttachments', () => {
  it('maps a document to a persistable descriptor without a download URL', () => {
    const attachments = extractTelegramNativeAttachments(
      message({
        document: {
          file_id: 'FILE1',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
          file_size: 12,
        },
      }),
    )
    expect(attachments).toEqual([
      {
        source: 'telegram',
        remoteId: 'FILE1',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 12,
      },
    ])
  })

  it('keeps only the highest-resolution entry of a photo ladder', () => {
    const attachments = extractTelegramNativeAttachments(
      message({
        photo: [
          { file_id: 'SMALL', file_size: 1 },
          { file_id: 'LARGE', file_size: 900 },
        ],
      }),
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.remoteId).toBe('LARGE')
  })

  it('returns nothing for a plain text message', () => {
    expect(extractTelegramNativeAttachments(message())).toEqual([])
  })
})

describe('buildTelegramConversationId', () => {
  it('keys a private chat on the chat itself', () => {
    expect(
      buildTelegramConversationId(BOT_ID, {
        chat: { id: 99, type: 'private' },
        from: { id: 99 },
      }),
    ).toBe(`${BOT_ID}:99`)
  })

  it('separates two senders sharing one group', () => {
    const base = { chat: { id: -100200, type: 'supergroup' as const } }
    expect(buildTelegramConversationId(BOT_ID, { ...base, from: { id: 1 } })).not.toBe(
      buildTelegramConversationId(BOT_ID, { ...base, from: { id: 2 } }),
    )
  })

  it('separates forum topics within one supergroup', () => {
    const base = { chat: { id: -100200, type: 'supergroup' as const }, from: { id: 1 } }
    expect(buildTelegramConversationId(BOT_ID, { ...base, message_thread_id: 5 })).not.toBe(
      buildTelegramConversationId(BOT_ID, { ...base, message_thread_id: 6 }),
    )
  })
})

describe('telegramSenderName', () => {
  it('prefers the full name and falls back to the username', () => {
    expect(telegramSenderName({ id: 1, first_name: 'Ada', last_name: 'Lovelace' })).toBe(
      'Ada Lovelace',
    )
    expect(telegramSenderName({ id: 1, username: 'ada' })).toBe('ada')
    expect(telegramSenderName(undefined)).toBeUndefined()
  })
})

describe('extractTelegramMessage', () => {
  it('reads both message and channel_post updates', () => {
    expect(extractTelegramMessage({ update_id: 1, message: message() })?.message_id).toBe(7)
    expect(extractTelegramMessage({ update_id: 1, channel_post: message() })?.message_id).toBe(7)
    expect(extractTelegramMessage({ update_id: 1 })).toBeUndefined()
  })
})

describe('chunkTelegramText', () => {
  it('keeps a short reply in one piece', () => {
    expect(chunkTelegramText('hi')).toEqual(['hi'])
  })

  it('splits a reply that would exceed the Telegram message limit', () => {
    const chunks = chunkTelegramText('x'.repeat(9_000))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true)
    expect(chunks.join('')).toHaveLength(9_000)
  })
})
