import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const mockCardCreate = vi.fn()
const mockCardSettings = vi.fn()
const mockElementContent = vi.fn()
const mockElementCreate = vi.fn()
const mockImMessageReply = vi.fn()
const mockImMessageCreate = vi.fn()

function makeFakeClient() {
  return {
    cardkit: {
      v1: {
        card: {
          create: mockCardCreate,
          settings: mockCardSettings,
        },
        cardElement: {
          content: mockElementContent,
          create: mockElementCreate,
        },
      },
    },
    im: {
      message: {
        reply: mockImMessageReply,
        create: mockImMessageCreate,
      },
    },
  } as any
}

import { FeishuStreamingCard } from '../feishu-card-streaming.js'

describe('FeishuStreamingCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('create', () => {
    it('调用 cardkit.v1.card.create 并返回实例', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_1' } })

      const card = await FeishuStreamingCard.create(client)

      expect(mockCardCreate).toHaveBeenCalledOnce()
      const callData = mockCardCreate.mock.calls[0][0].data
      expect(callData.type).toBe('card_json')
      const json = JSON.parse(callData.data)
      expect(json.schema).toBe('2.0')
      expect(json.config.streaming_mode).toBe(true)
      expect(json.body.elements[0].content).toBe('思考中...')
      expect(card.getCardId()).toBe('card_1')
    })

    it('响应中无 card_id 时抛异常', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({})

      await expect(FeishuStreamingCard.create(client)).rejects.toThrow('no card_id')
    })
  })

  describe('send', () => {
    it('replyMode=quote 时调用 reply 并记录 message_id', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_1' } })
      mockImMessageReply.mockResolvedValue({ data: { message_id: 'om_card1' } })
      const card = await FeishuStreamingCard.create(client)

      await card.send('chat_1', 'msg_1', 'quote')

      expect(mockImMessageReply).toHaveBeenCalledOnce()
      expect(mockImMessageCreate).not.toHaveBeenCalled()
      const callArgs = mockImMessageReply.mock.calls[0][0]
      expect(callArgs.path.message_id).toBe('msg_1')
      expect(callArgs.data.msg_type).toBe('interactive')
      const content = JSON.parse(callArgs.data.content)
      expect(content.type).toBe('card')
      expect(content.data.card_id).toBe('card_1')
      expect(card.getMessageId()).toBe('om_card1')
    })

    it('sends the streaming card inside the triggering message topic', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_topic' } })
      mockImMessageReply.mockResolvedValue({ data: { message_id: 'om_card' } })
      const card = await FeishuStreamingCard.create(client)
      await card.send('oc_group', 'om_root', 'thread')
      expect(mockImMessageReply).toHaveBeenCalledWith({
        path: { message_id: 'om_root' },
        data: { content: expect.any(String), msg_type: 'interactive', reply_in_thread: true },
      })
      expect(mockImMessageCreate).not.toHaveBeenCalled()
    })

    it('requires an anchor to send in thread mode', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_topic' } })
      const card = await FeishuStreamingCard.create(client)
      await expect(card.send('oc_group', undefined, 'thread')).rejects.toThrow('message anchor')
      expect(mockImMessageReply).not.toHaveBeenCalled()
      expect(mockImMessageCreate).not.toHaveBeenCalled()
    })

    it('replyMode=new 时调用 create', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_2' } })
      mockImMessageCreate.mockResolvedValue({ data: { message_id: 'om_card2' } })
      const card = await FeishuStreamingCard.create(client)

      await card.send('chat_1', undefined, 'new')

      expect(mockImMessageCreate).toHaveBeenCalledOnce()
      expect(mockImMessageReply).not.toHaveBeenCalled()
      const callArgs = mockImMessageCreate.mock.calls[0][0]
      expect(callArgs.data.receive_id).toBe('chat_1')
      expect(card.getMessageId()).toBe('om_card2')
    })

    it('响应中无 message_id 时抛异常', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_3' } })
      mockImMessageCreate.mockResolvedValue({})
      const card = await FeishuStreamingCard.create(client)

      await expect(card.send('chat_1', undefined, 'new')).rejects.toThrow('no message_id')
    })
  })

  describe('updateContent + 节流', () => {
    it('150ms 节流：连续调用只发送最新内容', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_t1' } })
      mockElementContent.mockResolvedValue({})
      const card = await FeishuStreamingCard.create(client)

      card.updateContent('hello')
      card.updateContent('hello world')
      card.updateContent('hello world!')

      expect(mockElementContent).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(150)

      expect(mockElementContent).toHaveBeenCalledOnce()
      const callArgs = mockElementContent.mock.calls[0][0]
      expect(callArgs.path.card_id).toBe('card_t1')
      expect(callArgs.path.element_id).toBe('main')
      expect(callArgs.data.content).toBe('hello world!')
      expect(callArgs.data.sequence).toBe(1)
    })

    it('重复内容不重新推送', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_t2' } })
      mockElementContent.mockResolvedValue({})
      const card = await FeishuStreamingCard.create(client)

      card.updateContent('same')
      await vi.advanceTimersByTimeAsync(150)
      expect(mockElementContent).toHaveBeenCalledOnce()

      card.updateContent('same')
      await vi.advanceTimersByTimeAsync(150)
      expect(mockElementContent).toHaveBeenCalledOnce()
    })

    it('sequence 递增', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_t3' } })
      mockElementContent.mockResolvedValue({})
      const card = await FeishuStreamingCard.create(client)

      card.updateContent('first')
      await vi.advanceTimersByTimeAsync(150)

      card.updateContent('second')
      await vi.advanceTimersByTimeAsync(150)

      expect(mockElementContent).toHaveBeenCalledTimes(2)
      expect(mockElementContent.mock.calls[0][0].data.sequence).toBe(1)
      expect(mockElementContent.mock.calls[1][0].data.sequence).toBe(2)
    })
  })

  describe('finish', () => {
    it('先 flush 最终内容再关闭 streaming_mode', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_f1' } })
      mockElementContent.mockResolvedValue({})
      mockCardSettings.mockResolvedValue({})
      const card = await FeishuStreamingCard.create(client)

      card.updateContent('final content')
      await card.finish()

      // flush 调用 element.content
      expect(mockElementContent).toHaveBeenCalledOnce()
      expect(mockElementContent.mock.calls[0][0].data.content).toBe('final content')

      // finish 调用 card.settings 关闭 streaming_mode
      expect(mockCardSettings).toHaveBeenCalledOnce()
      const settingsArgs = mockCardSettings.mock.calls[0][0]
      expect(settingsArgs.path.card_id).toBe('card_f1')
      const settings = JSON.parse(settingsArgs.data.settings)
      expect(settings.config.streaming_mode).toBe(false)
      // sequence 递增：flush 用 1，settings 用 2
      expect(settingsArgs.data.sequence).toBe(2)
    })
  })

  describe('child section', () => {
    it('addChildSection 追加分隔线和 markdown 元素', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_child1' } })
      mockElementCreate.mockResolvedValue({})
      const card = await FeishuStreamingCard.create(client)

      await card.addChildSection('task_1', 'Sub Agent')

      expect(mockElementCreate).toHaveBeenCalledOnce()
      const callArgs = mockElementCreate.mock.calls[0][0]
      expect(callArgs.path.card_id).toBe('card_child1')
      expect(callArgs.data.type).toBe('append')
      const elements = JSON.parse(callArgs.data.elements)
      expect(elements).toHaveLength(2)
      expect(elements[0].tag).toBe('hr')
      expect(elements[1].tag).toBe('markdown')
      expect(elements[1].element_id).toMatch(/^c\d+$/)
      expect(elements[1].content).toContain('Sub Agent')
    })

    it('addChildSection 重复调用不创建第二个', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_child2' } })
      mockElementCreate.mockResolvedValue({})
      const card = await FeishuStreamingCard.create(client)

      await card.addChildSection('task_1')
      await card.addChildSection('task_1')

      expect(mockElementCreate).toHaveBeenCalledOnce()
    })

    it('updateChildContent 节流并以引用块格式更新子区域', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_child3' } })
      mockElementCreate.mockResolvedValue({})
      mockElementContent.mockResolvedValue({})
      const card = await FeishuStreamingCard.create(client)

      await card.addChildSection('task_1', 'Test Agent')

      card.updateChildContent('task_1', 'hello')
      card.updateChildContent('task_1', 'hello world')

      expect(mockElementContent).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(150)

      const childCalls = mockElementContent.mock.calls.filter((c: any) =>
        c[0].path.element_id?.match(/^c\d+$/),
      )
      expect(childCalls).toHaveLength(1)
      // Content should be wrapped in blockquote with agent name header
      const sentContent = childCalls[0][0].data.content
      expect(sentContent).toContain('**🧩 Test Agent**')
      expect(sentContent).toContain('> hello world')
    })

    it('父子 sequence 共享递增', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_child4' } })
      mockElementCreate.mockResolvedValue({})
      mockElementContent.mockResolvedValue({})
      const card = await FeishuStreamingCard.create(client)

      // seq 1: addChildSection
      await card.addChildSection('task_1')
      expect(mockElementCreate.mock.calls[0][0].data.sequence).toBe(1)

      // seq 2: parent updateContent
      card.updateContent('parent output')
      await vi.advanceTimersByTimeAsync(150)
      expect(mockElementContent.mock.calls[0][0].data.sequence).toBe(2)

      // seq 3: child updateChildContent
      card.updateChildContent('task_1', 'child output')
      await vi.advanceTimersByTimeAsync(150)
      const childCalls = mockElementContent.mock.calls.filter((c: any) =>
        c[0].path.element_id?.match(/^c\d+$/),
      )
      expect(childCalls[0][0].data.sequence).toBe(3)
    })

    it('finish 时 flush 所有子区域并替换为折叠面板', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_child5' } })
      mockImMessageCreate.mockResolvedValue({ data: { message_id: 'om_test' } })
      mockElementCreate.mockResolvedValue({})
      mockElementContent.mockResolvedValue({})
      mockCardSettings.mockResolvedValue({})
      const mockImMessagePatch = vi.fn().mockResolvedValue({})
      ;(client.im.message as any).patch = mockImMessagePatch
      const card = await FeishuStreamingCard.create(client)
      await card.send('chat_1', undefined, 'new')

      await card.addChildSection('task_1', 'Sub Agent')
      card.updateContent('parent output')
      card.updateChildContent('task_1', 'final child')

      // finish() has an internal STREAMING_CLOSE_SETTLE_MS (500ms) delay before patch
      const finishPromise = card.finish()
      await vi.advanceTimersByTimeAsync(600)
      await finishPromise

      // Child content should be flushed with blockquote format
      const childCalls = mockElementContent.mock.calls.filter((c: any) =>
        c[0].path.element_id?.match(/^c\d+$/),
      )
      expect(childCalls).toHaveLength(1)
      expect(childCalls[0][0].data.content).toContain('**🧩 Sub Agent**')
      expect(mockCardSettings).toHaveBeenCalledOnce()

      // im.message.patch should be called with collapsible_panel
      expect(mockImMessagePatch).toHaveBeenCalledOnce()
      const patchArgs = mockImMessagePatch.mock.calls[0][0]
      expect(patchArgs.path.message_id).toBe('om_test')
      const patchContent = JSON.parse(patchArgs.data.content)
      expect(patchContent.schema).toBe('2.0')
      expect(patchContent.body.elements).toHaveLength(3) // markdown + hr + collapsible_panel
      const panel = patchContent.body.elements[2]
      expect(panel.tag).toBe('collapsible_panel')
      expect(panel.expanded).toBe(false)
      expect(panel.header.title.content).toBe('🧩 Sub Agent')
      expect(panel.elements[0].content).toBe('final child')
    })
  })

  describe('API 失败容错', () => {
    it('element.content 失败时不抛异常', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_e1' } })
      mockElementContent.mockRejectedValue(new Error('API error'))
      const card = await FeishuStreamingCard.create(client)

      card.updateContent('content')
      await vi.advanceTimersByTimeAsync(150)
      expect(mockElementContent).toHaveBeenCalledOnce()
    })

    it('finish 中 settings 失败时不抛异常', async () => {
      const client = makeFakeClient()
      mockCardCreate.mockResolvedValue({ data: { card_id: 'card_e2' } })
      mockCardSettings.mockRejectedValue(new Error('API error'))
      const card = await FeishuStreamingCard.create(client)

      await expect(card.finish()).resolves.toBeUndefined()
    })
  })
})
