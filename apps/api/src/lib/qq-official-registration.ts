import { createDecipheriv, randomBytes } from 'node:crypto'

const QQ_BIND_ORIGIN = 'https://q.qq.com'
const DEFAULT_POLL_INTERVAL_MS = 2_000
const REQUEST_TIMEOUT_MS = 10_000

type FetchLike = typeof fetch

interface QQBindEnvelope {
  data?: Record<string, unknown>
}

async function postQQBind(
  path: string,
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${QQ_BIND_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`QQ registration request failed with HTTP ${response.status}`)
  }
  const envelope = (await response.json()) as QQBindEnvelope
  if (!envelope.data || typeof envelope.data !== 'object') {
    throw new Error('QQ registration response is missing data')
  }
  return envelope.data
}

export interface QQOfficialRegistrationTask {
  taskId: string
  bindKey: string
  qrCodeUrl: string
  intervalMs: number
}

export async function createQQOfficialRegistration(
  options: { fetchImpl?: FetchLike } = {},
): Promise<QQOfficialRegistrationTask> {
  const fetchImpl = options.fetchImpl ?? fetch
  const bindKey = randomBytes(32).toString('base64')
  const data = await postQQBind('/lite/create_bind_task', { key: bindKey }, fetchImpl)
  const taskId = typeof data.task_id === 'string' ? data.task_id.trim() : ''
  if (!taskId) throw new Error('QQ registration response is missing task_id')

  return {
    taskId,
    bindKey,
    qrCodeUrl: `${QQ_BIND_ORIGIN}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`,
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
  }
}

function decryptSecret(encryptedSecret: string, bindKey: string): string {
  const key = Buffer.from(bindKey, 'base64')
  const payload = Buffer.from(encryptedSecret, 'base64')
  if (key.length !== 32 || payload.length < 29) {
    throw new Error('QQ registration returned malformed encrypted credentials')
  }
  const nonce = payload.subarray(0, 12)
  const tag = payload.subarray(payload.length - 16)
  const ciphertext = payload.subarray(12, payload.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export type QQOfficialRegistrationResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'completed'; appId: string; appSecret: string }

export async function pollQQOfficialRegistration(options: {
  taskId: string
  bindKey: string
  fetchImpl?: FetchLike
}): Promise<QQOfficialRegistrationResult> {
  const taskId = options.taskId.trim()
  if (!taskId || !options.bindKey) throw new Error('QQ registration task credentials are required')
  const data = await postQQBind(
    '/lite/poll_bind_result',
    { task_id: taskId },
    options.fetchImpl ?? fetch,
  )
  if (data.status === 3) return { status: 'expired' }
  if (data.status !== 2) return { status: 'pending' }

  const appId = typeof data.bot_appid === 'string' ? data.bot_appid.trim() : ''
  const encryptedSecret = typeof data.bot_encrypt_secret === 'string' ? data.bot_encrypt_secret : ''
  if (!appId || !encryptedSecret) {
    throw new Error('QQ registration result is missing bot credentials')
  }
  return {
    status: 'completed',
    appId,
    appSecret: decryptSecret(encryptedSecret, options.bindKey),
  }
}
