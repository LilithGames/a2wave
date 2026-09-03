import { describe, expect, it } from 'vitest'
import {
  extractFeishuCardText,
  FEISHU_REFERENCED_MESSAGE_MAX_CHARS,
  getFeishuReferencedPromptContext,
  getPersistedReferencedPromptContext,
  normalizeFeishuReferencedText,
  resolveFeishuReferencedMessageId,
  toFeishuReferencedPromptContext,
} from '../feishu-referenced-message.js'

describe('resolveFeishuReferencedMessageId', () => {
  it('prefers the immediate parent for an ordinary group reply', () => {
    expect(
      resolveFeishuReferencedMessageId(true, {
        chat_type: 'group',
        message_id: 'om_reply',
        parent_id: 'om_parent',
        root_id: 'om_root',
      }),
    ).toBe('om_parent')
  })

  it('falls back to the root when Feishu omits the immediate parent', () => {
    expect(
      resolveFeishuReferencedMessageId(true, {
        chat_type: 'group',
        message_id: 'om_reply',
        root_id: 'om_root',
      }),
    ).toBe('om_root')
  })

  it.each([
    ['disabled', false, { chat_type: 'group', parent_id: 'om_parent' }],
    ['direct message', true, { chat_type: 'p2p', parent_id: 'om_parent' }],
    ['topic reply', true, { chat_type: 'group', thread_id: 'omt_topic', parent_id: 'om_parent' }],
    ['self reference', true, { chat_type: 'group', message_id: 'om_same', parent_id: 'om_same' }],
  ])('does not inject for %s', (_case, enabled, message) => {
    expect(resolveFeishuReferencedMessageId(enabled, message)).toBeUndefined()
  })
})

describe('extractFeishuCardText', () => {
  it('extracts Card 2.0 headings and content without action payloads', () => {
    const content = JSON.stringify({
      schema: '2.0',
      header: {
        title: { tag: 'plain_text', content: 'Grafana alert analysis' },
        subtitle: { tag: 'plain_text', content: 'prod · account-service' },
      },
      body: {
        elements: [
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                elements: [
                  { tag: 'markdown', content: '**Conclusion**\nPayment dependency timed out.' },
                ],
              },
            ],
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Investigate' },
            value: { internalAction: 'must-not-enter-the-prompt' },
          },
        ],
      },
    })

    const text = extractFeishuCardText(content)

    expect(text).toContain('Grafana alert analysis')
    expect(text).toContain('prod · account-service')
    expect(text).toContain('Payment dependency timed out.')
    expect(text).not.toContain('Investigate')
    expect(text).not.toContain('must-not-enter-the-prompt')
  })

  it('extracts visible Card 2.0 header status tags', () => {
    expect(
      extractFeishuCardText(
        JSON.stringify({
          schema: '2.0',
          header: {
            title: { tag: 'plain_text', content: 'Grafana alert analysis' },
            text_tag_list: [
              {
                tag: 'text_tag',
                text: { tag: 'plain_text', content: 'Root cause located' },
              },
              {
                tag: 'text_tag',
                text: { tag: 'plain_text', content: 'Downstream cause pending' },
              },
            ],
          },
          body: { elements: [] },
        }),
      ),
    ).toBe('Grafana alert analysis\nRoot cause located\nDownstream cause pending')
  })

  it('keeps legacy interactive card text readable', () => {
    expect(
      extractFeishuCardText(
        JSON.stringify({
          header: {
            title: { tag: 'plain_text', content: 'Legacy card' },
          },
          elements: [
            {
              tag: 'div',
              text: { tag: 'lark_md', content: 'Legacy body' },
            },
          ],
        }),
      ),
    ).toBe('Legacy card\nLegacy body')
  })

  it('extracts legacy field groups used for side-by-side alert evidence', () => {
    expect(
      extractFeishuCardText(
        JSON.stringify({
          header: {
            title: { tag: 'plain_text', content: 'Alert' },
          },
          elements: [
            {
              tag: 'div',
              fields: [
                {
                  is_short: true,
                  text: { tag: 'lark_md', content: 'Queue size: 233' },
                },
                {
                  is_short: true,
                  text: { tag: 'lark_md', content: 'Retry: 29' },
                },
              ],
            },
          ],
        }),
      ),
    ).toBe('Alert\nQueue size: 233\nRetry: 29')
  })

  it('extracts the platform single-content template card contract', () => {
    expect(
      extractFeishuCardText(
        JSON.stringify({
          type: 'template',
          data: {
            template_id: 'ctp_alert',
            template_variable: {
              content: '**Conclusion**\nPayment dependency timed out.\nRetry budget exhausted.',
            },
          },
        }),
      ),
    ).toBe('**Conclusion**\nPayment dependency timed out.\nRetry budget exhausted.')
  })

  it('skips custom template variables whose visible fields cannot be established', () => {
    expect(
      extractFeishuCardText(
        JSON.stringify({
          type: 'template',
          data: {
            template_id: 'ctp_custom',
            template_variable: {
              visible_title: 'Alert',
              visible_count: 233,
              action_token: 'secret-token',
            },
          },
        }),
      ),
    ).toBe('')
  })

  it('leaves CardKit references unsupported instead of treating the id as content', () => {
    expect(
      extractFeishuCardText(
        JSON.stringify({ type: 'card', data: { card_id: 'card_streaming_1' } }),
      ),
    ).toBe('')
  })

  it('returns an empty string for malformed card JSON', () => {
    expect(extractFeishuCardText('{')).toBe('')
  })
})

describe('referenced message normalization', () => {
  it('preserves text that is already within the limit', () => {
    expect(normalizeFeishuReferencedText('  alert context  ')).toEqual({
      text: 'alert context',
      truncated: false,
    })
  })

  it('truncates oversized text without rejecting the message', () => {
    const normalized = normalizeFeishuReferencedText(
      'x'.repeat(FEISHU_REFERENCED_MESSAGE_MAX_CHARS + 10),
    )

    expect(normalized.text).toHaveLength(FEISHU_REFERENCED_MESSAGE_MAX_CHARS)
    expect(normalized.truncated).toBe(true)
  })

  it('maps a fetched message to the generic referenced prompt context', () => {
    expect(
      toFeishuReferencedPromptContext({
        messageId: 'om_alert',
        messageType: 'interactive',
        senderType: 'app',
        text: 'Alert conclusion',
        truncated: false,
      }),
    ).toEqual({
      source: 'feishu',
      messageId: 'om_alert',
      messageType: 'interactive',
      senderType: 'app',
      text: 'Alert conclusion',
      truncated: false,
    })
  })

  it('restores referenced prompt context from persisted Feishu run context', () => {
    expect(
      getFeishuReferencedPromptContext({
        referenced_message: {
          message_id: 'om_alert',
          message_type: 'interactive',
          sender_type: 'app',
          text: 'Alert conclusion',
          truncated: false,
        },
      }),
    ).toEqual({
      source: 'feishu',
      messageId: 'om_alert',
      messageType: 'interactive',
      senderType: 'app',
      text: 'Alert conclusion',
      truncated: false,
    })
  })

  it('rejects persisted referenced context without readable text', () => {
    expect(
      getFeishuReferencedPromptContext({
        referenced_message: { message_id: 'om_empty', message_type: 'text', text: '  ' },
      }),
    ).toBeUndefined()
  })

  it('preserves the original source when restoring A2A-forwarded context', () => {
    expect(
      getPersistedReferencedPromptContext(
        {
          referenced_message: {
            source: 'feishu',
            text: 'Forwarded alert',
          },
        },
        'a2a',
      ),
    ).toEqual({
      source: 'feishu',
      text: 'Forwarded alert',
      truncated: false,
    })
  })
})
