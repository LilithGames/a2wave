import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createQQOfficialRegistration,
  pollQQOfficialRegistration,
} from '../qq-official-registration.js'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('QQ Official QR registration', () => {
  it('creates a binding task on the fixed official host', async () => {
    let requestInit: RequestInit | undefined
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestInit = init
      return jsonResponse({ data: { task_id: 'task/1' } })
    })

    const result = await createQQOfficialRegistration({ fetchImpl })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://q.qq.com/lite/create_bind_task',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(String(requestInit?.body))).toEqual({ key: result.bindKey })
    expect(Buffer.from(result.bindKey, 'base64')).toHaveLength(32)
    expect(result.qrCodeUrl).toBe(
      'https://q.qq.com/qqbot/openclaw/connect.html?task_id=task%2F1&_wv=2',
    )
  })

  it('decrypts completed credentials with AES-256-GCM', async () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    const encrypted = Buffer.concat([cipher.update('app-secret', 'utf8'), cipher.final()])
    const encryptedSecret = Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString(
      'base64',
    )
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { status: 2, bot_appid: '102000000', bot_encrypt_secret: encryptedSecret },
      }),
    )

    await expect(
      pollQQOfficialRegistration({
        taskId: 'task-1',
        bindKey: key.toString('base64'),
        fetchImpl,
      }),
    ).resolves.toEqual({ status: 'completed', appId: '102000000', appSecret: 'app-secret' })
  })

  it('maps pending and expired task statuses', async () => {
    const pendingFetch = vi.fn(async () => jsonResponse({ data: { status: 1 } }))
    const expiredFetch = vi.fn(async () => jsonResponse({ data: { status: 3 } }))
    const params = { taskId: 'task-1', bindKey: randomBytes(32).toString('base64') }

    await expect(
      pollQQOfficialRegistration({ ...params, fetchImpl: pendingFetch }),
    ).resolves.toEqual({ status: 'pending' })
    await expect(
      pollQQOfficialRegistration({ ...params, fetchImpl: expiredFetch }),
    ).resolves.toEqual({ status: 'expired' })
  })
})
