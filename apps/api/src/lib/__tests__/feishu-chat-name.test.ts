import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchFeishuChatName } from '../feishu-chat-name.js'
import { logger } from '../logger.js'

vi.mock('../logger.js', () => ({ logger: { warn: vi.fn() } }))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('fetchFeishuChatName', () => {
  it('looks up the group by chat ID and refreshes a cached name after ten minutes', async () => {
    vi.useFakeTimers()
    const request = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, data: { name: 'Design' } })
      .mockResolvedValueOnce({ code: 0, data: { name: 'Product Design' } })
    const client = { request }
    expect(await fetchFeishuChatName(client, 'oc_design', 'cli_app')).toBe('Design')
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/im/v1/chats/oc_design',
      timeout: 3000,
    })
    expect(await fetchFeishuChatName(client, 'oc_design', 'cli_app')).toBe('Design')
    expect(request).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10 * 60_000)
    expect(await fetchFeishuChatName(client, 'oc_design', 'cli_app')).toBe('Product Design')
  })

  it('keeps names separate across apps and chats', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { name: 'First' } })
      .mockResolvedValueOnce({ data: { name: 'Second' } })
      .mockResolvedValueOnce({ data: { name: 'Third' } })
    const client = { request }
    expect(await fetchFeishuChatName(client, 'oc_a', 'cli_one')).toBe('First')
    expect(await fetchFeishuChatName(client, 'oc_a', 'cli_two')).toBe('Second')
    expect(await fetchFeishuChatName(client, 'oc_b', 'cli_one')).toBe('Third')
  })

  it.each([
    ['missing name', { code: 0, data: {} }],
    ['empty name', { code: 0, data: { name: ' ' } }],
    ['permission error', { code: 99991672, msg: 'Access denied', data: { name: 'Ignored' } }],
  ])('omits the name and retries on the next message for %s', async (caseName, response) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ code: 0, data: { name: 'Recovered' } })
    const client = { request }
    expect(await fetchFeishuChatName(client, 'oc_retry', String(caseName))).toBeUndefined()
    expect(await fetchFeishuChatName(client, 'oc_retry', String(caseName))).toBe('Recovered')
  })

  it('omits the name on SDK errors and logs only the safe error summary', async () => {
    const request = vi.fn().mockRejectedValue({
      response: { status: 403, data: { code: 99991672 } },
      config: { headers: { Authorization: 'sensitive' } },
    })
    expect(await fetchFeishuChatName({ request }, 'oc_denied', 'cli_app')).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      {
        appId: 'cli_app',
        chatId: 'oc_denied',
        err: { status: 403, feishuCode: 99991672 },
      },
      expect.any(String),
    )
  })

  it('evicts old entries when the cache exceeds 500 chats', async () => {
    const request = vi.fn().mockResolvedValue({ code: 0, data: { name: 'Group' } })
    const client = { request }
    for (let i = 0; i <= 500; i++) {
      await fetchFeishuChatName(client, `oc_${i}`, 'cli_many')
    }
    await fetchFeishuChatName(client, 'oc_500', 'cli_many')
    expect(request).toHaveBeenCalledTimes(501)
    await fetchFeishuChatName(client, 'oc_0', 'cli_many')
    expect(request).toHaveBeenCalledTimes(502)
  })
})
