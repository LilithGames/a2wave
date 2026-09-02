import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { createLarkSdkLogger, summarizeFeishuError } from '../feishu-error-log.js'
import { logger } from '../logger.js'

/** The AxiosError the Feishu SDK hands to its own logger verbatim. */
function buildSdkAxiosError(): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    name: 'AxiosError',
    code: 'ERR_BAD_REQUEST',
    config: {
      url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      data: '{"app_id":"cli_a1b2","app_secret":"SUPER_SECRET_APP_SECRET"}',
      headers: { Authorization: 'Bearer t-LEAKED_TENANT_TOKEN' },
    },
    response: {
      status: 400,
      headers: { 'x-tt-logid': 'logid-1' },
      data: { code: 99991663, msg: 'app ticket invalid' },
    },
  })
}

describe('summarizeFeishuError', () => {
  it('keeps the fields that make a Feishu failure diagnosable', () => {
    expect(summarizeFeishuError(buildSdkAxiosError())).toEqual({
      netCode: 'ERR_BAD_REQUEST',
      status: 400,
      feishuCode: 99991663,
      feishuMsg: 'app ticket invalid',
      logId: 'logid-1',
    })
  })

  it('falls back to the message when nothing Feishu-shaped is present', () => {
    expect(summarizeFeishuError(new Error('socket hang up'))).toEqual({ message: 'socket hang up' })
  })
})

describe('createLarkSdkLogger', () => {
  it('summarises the error instead of letting the SDK print it to stderr', () => {
    vi.mocked(logger.error).mockClear()

    createLarkSdkLogger().error('http request failed', buildSdkAxiosError())

    expect(logger.error).toHaveBeenCalledTimes(1)
    const [bindings, message] = vi.mocked(logger.error).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ]
    const dumped = JSON.stringify(bindings)
    expect(dumped).not.toContain('SUPER_SECRET_APP_SECRET')
    expect(dumped).not.toContain('Bearer t-LEAKED_TENANT_TOKEN')
    expect(bindings.larkDetails).toEqual([
      expect.objectContaining({ status: 400, feishuCode: 99991663 }),
    ])
    expect(message).toContain('http request failed')
  })

  it('demotes SDK info/trace chatter to debug', () => {
    vi.mocked(logger.debug).mockClear()
    vi.mocked(logger.info).mockClear()

    const sdkLogger = createLarkSdkLogger()
    sdkLogger.info('token cache hit')
    sdkLogger.trace('raw payload')

    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledTimes(2)
  })
})
