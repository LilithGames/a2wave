import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const reserved: Record<string, unknown>[] = []
vi.mock('../native-chat-runner.js', () => ({
  reserveNativeChatRun: async (input: Record<string, unknown>) => {
    reserved.push(input)
    return { status: 'ok', runId: 'run_x' }
  },
}))

const { TelegramConnectionManager } = await import('../telegram-service.js')

const sent: { chat_id: string; text: string; reply_parameters?: { message_id: number } }[] = []
let served = false
let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      const method = req.url?.split('/').pop() ?? ''
      const json = (o: unknown) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(o))
      }
      if (method === 'getMe') return json({ ok: true, result: { id: 4242, username: 'fake_bot' } })
      if (method === 'deleteWebhook') return json({ ok: true, result: true })
      if (method === 'sendMessage') {
        sent.push(JSON.parse(body))
        return json({ ok: true, result: {} })
      }
      if (method === 'getUpdates') {
        if (served) return json({ ok: true, result: [] })
        served = true
        return json({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 11,
                chat: { id: 555, type: 'private' },
                from: { id: 9, first_name: 'Ada' },
                text: 'hello agent',
              },
            },
            {
              update_id: 2,
              message: {
                message_id: 12,
                chat: { id: -100, type: 'supergroup' },
                from: { id: 9, first_name: 'Ada' },
                text: 'chatting',
              },
            },
            {
              update_id: 3,
              message: {
                message_id: 13,
                chat: { id: -100, type: 'supergroup' },
                from: { id: 9, first_name: 'Ada' },
                text: '@fake_bot  do   the thing',
                entities: [{ type: 'mention', offset: 0, length: 9 }],
              },
            },
            {
              update_id: 4,
              message: {
                message_id: 14,
                chat: { id: 555, type: 'private' },
                from: { id: 77, is_bot: true },
                text: 'I am a bot',
              },
            },
          ],
        })
      }
      return json({ ok: false, description: `unexpected ${method}` })
    })
  })
  await new Promise<void>((r) => server.listen(0, () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => server.close())

describe('Telegram polling loop against a Bot API server', () => {
  it('drives the whole receive -> trigger -> reply path', async () => {
    const mgr = new TelegramConnectionManager()
    await mgr.start('agt_fake', { botToken: '4242:secret', apiBaseUrl: base })
    await vi.waitFor(() => expect(reserved.length).toBe(2), { timeout: 5_000 })

    // Only the private message and the @mentioned group message start a run.
    expect(reserved[0]?.intent).toBe('hello agent')
    // The bot handle is stripped and whitespace collapsed.
    expect(reserved[1]?.intent).toBe('do the thing')
    expect(reserved[0]?.displayName).toBe('Ada')

    // Event ids are chat-scoped, because Telegram message ids repeat across chats.
    expect(reserved[0]?.eventId).toBe('telegram:4242:555:11')
    expect(reserved[1]?.eventId).toBe('telegram:4242:-100:13')

    const ctx = reserved[0]?.channel as {
      channel_info: { chat_id: string; chat_type: string; message_id: string }
    }
    expect(ctx.channel_info).toMatchObject({
      chat_id: '555',
      chat_type: 'private',
      message_id: '11',
    })

    // A long reply is split, addressed to the right chat, and quotes the original.
    await mgr.sendRunResultByContext('agt_fake', ctx as never, 'a'.repeat(9_000), [])
    expect(sent).toHaveLength(3)
    expect(sent[0]?.chat_id).toBe('555')
    expect(sent[0]?.reply_parameters?.message_id).toBe(11)
    expect(sent.map((m) => m.text.length).reduce((a, b) => a + b, 0)).toBe(9_000)

    await mgr.stop('agt_fake')
    expect(mgr.isSocketOpen('agt_fake')).toBe(false)
  })
})
