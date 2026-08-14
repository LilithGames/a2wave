import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPost = vi.fn()
const mockPostFormData = vi.fn()
const mockResolveAgentId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    post: mockPost,
    postFormData: mockPostFormData,
    resolveAgentId: mockResolveAgentId,
  }),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn(() => Buffer.from('file-bytes')),
    existsSync: vi.fn(() => true),
  }
})

const { chatSendCommand } = await import('../chat.js')

describe('chat send --attach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveAgentId.mockResolvedValue('agt_1')
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('stages each file and forwards the returned refs on the chat body', async () => {
    mockPostFormData
      .mockResolvedValueOnce({
        data: { token: 'att_a', name: 'a.png', mimeType: 'image/png', size: 10 },
      })
      .mockResolvedValueOnce({
        data: { token: 'att_b', name: 'b.md', mimeType: 'text/markdown', size: 4 },
      })
    mockPost.mockResolvedValueOnce({ data: { reply: 'ok', chatId: 'c1', runId: 'run_1' } })

    await chatSendCommand.run?.({
      args: {
        agent: 'bot',
        message: 'look',
        attach: ['./a.png', './b.md'],
        stream: false,
      },
    } as never)

    expect(mockPostFormData).toHaveBeenCalledTimes(2)
    expect(mockPostFormData.mock.calls[0][0]).toBe('/api/attachments')
    expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/chat', {
      message: 'look',
      stream: false,
      attachments: [
        { token: 'att_a', name: 'a.png', mimeType: 'image/png', size: 10 },
        { token: 'att_b', name: 'b.md', mimeType: 'text/markdown', size: 4 },
      ],
    })
  })

  it('sends no attachments key when none are given', async () => {
    mockPost.mockResolvedValueOnce({ data: { reply: 'ok' } })
    await chatSendCommand.run?.({
      args: { agent: 'bot', message: 'hi', stream: false },
    } as never)
    expect(mockPostFormData).not.toHaveBeenCalled()
    expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/chat', {
      message: 'hi',
      stream: false,
    })
  })

  it('rejects more attachments than the server accepts, before uploading any', async () => {
    await expect(
      chatSendCommand.run?.({
        args: {
          agent: 'bot',
          message: 'hi',
          stream: false,
          attach: Array.from({ length: 11 }, (_, i) => `./f${i}.md`),
        },
      } as never),
    ).rejects.toThrow(/10/)
    expect(mockPostFormData).not.toHaveBeenCalled()
  })

  it('rejects --attach without a message (an interactive session has no single turn)', async () => {
    // A TTY, so the check under test is the --attach guard and not the earlier
    // "interactive chat needs a TTY" precondition.
    const isTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    try {
      await expect(
        chatSendCommand.run?.({
          args: { agent: 'bot', attach: ['./a.md'], stream: false },
        } as never),
      ).rejects.toThrow(/--attach/)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true })
    }
  })
})
