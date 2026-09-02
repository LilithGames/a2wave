import { EventEmitter } from 'node:events'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qqOfficialConfigSchema } from '@a2wave/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'

const mockPreflightNativeChatRun = vi.hoisted(() => vi.fn())
const mockReserveNativeChatRun = vi.hoisted(() => vi.fn())
const mockResolveNativeChatAttachments = vi.hoisted(() => vi.fn())
const mockDeleteStagedAttachment = vi.hoisted(() => vi.fn())
const mockIsNativeChatRunReservedError = vi.hoisted(() => vi.fn())

vi.mock('../native-chat-runner.js', () => ({
  isNativeChatRunReservedError: mockIsNativeChatRunReservedError,
  preflightNativeChatRun: mockPreflightNativeChatRun,
  reserveNativeChatRun: mockReserveNativeChatRun,
}))
vi.mock('../native-chat-attachments.js', () => ({
  resolveNativeChatAttachments: mockResolveNativeChatAttachments,
}))
vi.mock('../attachment-storage.js', () => ({
  deleteStagedAttachment: mockDeleteStagedAttachment,
}))

import {
  buildQQOfficialConversationId,
  buildQQOfficialIntents,
  classifyQQGatewayClose,
  computeQQReconnectDelay,
  MAX_QQ_CONSECUTIVE_RECONNECT_FAILURES,
  normalizeQQOfficialMessage,
  planQQShardStarts,
  QQ_MAX_ARTIFACT_UPLOAD_BYTES,
  QQIdentifyLimiter,
  QQOfficialApiClient,
  QQOfficialConnectionManager,
  shouldTriggerQQOfficialMessage,
} from '../qq-official-service.js'

const config = qqOfficialConfigSchema.parse({ appId: '102000000', appSecret: 'secret' })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('QQ Official Gateway messages', () => {
  it('deduplicates a replay before downloading its attachments', async () => {
    mockPreflightNativeChatRun.mockResolvedValue({ status: 'duplicate' })
    const manager = new QQOfficialConnectionManager()
    const internals = manager as unknown as {
      handleDispatch: (...args: unknown[]) => Promise<void>
      sendMessageByContext: (...args: unknown[]) => Promise<void>
    }
    internals.sendMessageByContext = vi.fn().mockResolvedValue(undefined)

    await internals.handleDispatch('agent-1', { config }, 'C2C_MESSAGE_CREATE', {
      id: 'message-1',
      content: 'review',
      author: { user_openid: 'user-1' },
      attachments: [{ url: 'https://example.qq.com/a.png', filename: 'a.png' }],
    })

    expect(mockResolveNativeChatAttachments).not.toHaveBeenCalled()
    expect(mockReserveNativeChatRun).not.toHaveBeenCalled()
  })

  it('deletes staged attachments when a concurrent delivery wins the reservation race', async () => {
    mockPreflightNativeChatRun.mockResolvedValue({ status: 'ready' })
    mockResolveNativeChatAttachments.mockResolvedValue([
      { token: 'att_internal', name: 'a.png', mimeType: 'image/png', size: 42 },
    ])
    mockReserveNativeChatRun.mockResolvedValue({ status: 'duplicate' })
    const manager = new QQOfficialConnectionManager()
    const internals = manager as unknown as {
      handleDispatch: (...args: unknown[]) => Promise<void>
    }

    await internals.handleDispatch('agent-1', { config }, 'C2C_MESSAGE_CREATE', {
      id: 'message-1',
      content: 'review',
      author: { user_openid: 'user-1' },
      attachments: [{ url: 'https://example.qq.com/a.png', filename: 'a.png' }],
    })

    expect(mockDeleteStagedAttachment).toHaveBeenCalledWith('att_internal')
  })

  it('preserves staged attachments when a durable Run exists despite a later failure', async () => {
    mockPreflightNativeChatRun.mockResolvedValue({ status: 'ready' })
    mockResolveNativeChatAttachments.mockResolvedValue([
      { token: 'att_internal', name: 'a.png', mimeType: 'image/png', size: 42 },
    ])
    const reservedError = Object.assign(new Error('queue database unavailable'), {
      nativeChatRunReserved: true,
    })
    mockReserveNativeChatRun.mockRejectedValue(reservedError)
    mockIsNativeChatRunReservedError.mockReturnValue(true)
    const manager = new QQOfficialConnectionManager()
    const internals = manager as unknown as {
      handleDispatch: (...args: unknown[]) => Promise<void>
    }

    await expect(
      internals.handleDispatch('agent-1', { config }, 'C2C_MESSAGE_CREATE', {
        id: 'message-1',
        content: 'review',
        author: { user_openid: 'user-1' },
        attachments: [{ url: 'https://example.qq.com/a.png', filename: 'a.png' }],
      }),
    ).rejects.toBe(reservedError)

    expect(mockDeleteStagedAttachment).not.toHaveBeenCalled()
  })

  it('preserves staged attachments for rerunning a queue-saturated failed Run', async () => {
    mockPreflightNativeChatRun.mockResolvedValue({ status: 'ready' })
    mockResolveNativeChatAttachments.mockResolvedValue([
      { token: 'att_internal', name: 'a.png', mimeType: 'image/png', size: 42 },
    ])
    mockReserveNativeChatRun.mockResolvedValue({ status: 'queue_full', runId: 'run_failed' })
    const manager = new QQOfficialConnectionManager()
    const internals = manager as unknown as {
      handleDispatch: (...args: unknown[]) => Promise<void>
      sendMessageByContext: (...args: unknown[]) => Promise<void>
    }
    internals.sendMessageByContext = vi.fn().mockResolvedValue(undefined)

    await internals.handleDispatch('agent-1', { config }, 'C2C_MESSAGE_CREATE', {
      id: 'message-1',
      content: 'review',
      author: { user_openid: 'user-1' },
      attachments: [{ url: 'https://example.qq.com/a.png', filename: 'a.png' }],
    })

    expect(mockDeleteStagedAttachment).not.toHaveBeenCalled()
  })

  it('preserves staged attachments for rerunning a scheduling-failed Run', async () => {
    mockPreflightNativeChatRun.mockResolvedValue({ status: 'ready' })
    mockResolveNativeChatAttachments.mockResolvedValue([
      { token: 'att_internal', name: 'a.png', mimeType: 'image/png', size: 42 },
    ])
    mockReserveNativeChatRun.mockResolvedValue({
      status: 'scheduling_failed',
      runId: 'run_failed',
    })
    const manager = new QQOfficialConnectionManager()
    const internals = manager as unknown as {
      handleDispatch: (...args: unknown[]) => Promise<void>
      sendMessageByContext: (...args: unknown[]) => Promise<void>
    }
    internals.sendMessageByContext = vi.fn().mockResolvedValue(undefined)

    await internals.handleDispatch('agent-1', { config }, 'C2C_MESSAGE_CREATE', {
      id: 'message-1',
      content: 'review',
      author: { user_openid: 'user-1' },
      attachments: [{ url: 'https://example.qq.com/a.png', filename: 'a.png' }],
    })

    expect(mockDeleteStagedAttachment).not.toHaveBeenCalled()
    expect(internals.sendMessageByContext).toHaveBeenCalledWith(
      'agent-1',
      expect.anything(),
      'Agent could not schedule this message.',
    )
  })

  it('requests only the group and C2C gateway intent', () => {
    expect(buildQQOfficialIntents()).toBe(1 << 25)
  })

  it('clears invalid sessions and refreshes an invalid gateway token', () => {
    expect(classifyQQGatewayClose(9001)).toEqual({ clearSession: true, invalidateToken: false })
    expect(classifyQQGatewayClose(9005)).toEqual({ clearSession: true, invalidateToken: false })
    expect(classifyQQGatewayClose(4004)).toEqual({ clearSession: true, invalidateToken: true })
    expect(classifyQQGatewayClose(4006)).toEqual({ clearSession: true, invalidateToken: false })
    expect(classifyQQGatewayClose(4007)).toEqual({ clearSession: true, invalidateToken: false })
    expect(classifyQQGatewayClose(1000)).toEqual({ clearSession: false, invalidateToken: false })
  })

  it('batches shard identification by the official concurrency window', () => {
    expect(planQQShardStarts(5, { remaining: 5, max_concurrency: 2 })).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ])
    expect(() => planQQShardStarts(2, { remaining: 1, max_concurrency: 1 })).toThrow(
      'has 1 remaining, but 2 shards are required',
    )
  })

  it('limits every Identify sequence to the official five-second window', async () => {
    let now = 100
    const waits: number[] = []
    const limiter = new QQIdentifyLimiter(
      2,
      () => now,
      async (milliseconds) => {
        waits.push(milliseconds)
        now += milliseconds
      },
    )

    await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()))

    expect(waits).toEqual([5_000, 5_000])
  })

  it('normalizes and triggers an at-mentioned QQ group message', () => {
    const message = normalizeQQOfficialMessage('GROUP_AT_MESSAGE_CREATE', {
      id: 'msg-1',
      content: '<@!bot-open-id> hello',
      group_openid: 'group-1',
      author: { member_openid: 'member-1' },
      attachments: [{ url: 'https://example.qq.com/a.png', filename: 'a.png' }],
    })

    expect(message).toMatchObject({
      scene: 'group',
      id: 'msg-1',
      senderOpenId: 'member-1',
      groupOpenId: 'group-1',
      content: 'hello',
    })
    expect(message?.attachments).toHaveLength(1)
    expect(message && shouldTriggerQQOfficialMessage(config, message)).toBe(true)
    expect(message && buildQQOfficialConversationId(config.appId, message)).toBe(
      '102000000:group:group-1',
    )
  })

  it('ignores ordinary group message events', () => {
    expect(
      normalizeQQOfficialMessage('GROUP_MESSAGE_CREATE', {
        id: 'msg-2',
        content: 'hello',
        group_openid: 'group-1',
        author: { member_openid: 'member-1' },
      }),
    ).toBeNull()
  })

  it.each([
    ['/new', '新会话已开始'],
    ['/new review the repository', 'review the repository'],
    ['  /new\t review the repository', 'review the repository'],
  ])('resets a C2C session for %j and sends %j as the intent', async (content, intent) => {
    mockPreflightNativeChatRun.mockResolvedValue({ status: 'ready' })
    mockResolveNativeChatAttachments.mockResolvedValue([])
    mockReserveNativeChatRun.mockResolvedValue({ status: 'started', runId: 'run-new' })
    const manager = new QQOfficialConnectionManager()
    const internals = manager as unknown as {
      handleDispatch: (...args: unknown[]) => Promise<void>
    }

    await internals.handleDispatch('agent-1', { config }, 'C2C_MESSAGE_CREATE', {
      id: 'message-new',
      content,
      author: { user_openid: 'user-1' },
    })

    expect(mockReserveNativeChatRun).toHaveBeenCalledWith(
      expect.objectContaining({ intent, resetSession: true }),
    )
  })

  it('treats /new as ordinary text in an at-mentioned group message', async () => {
    mockPreflightNativeChatRun.mockResolvedValue({ status: 'ready' })
    mockResolveNativeChatAttachments.mockResolvedValue([])
    mockReserveNativeChatRun.mockResolvedValue({ status: 'started', runId: 'run-group' })
    const manager = new QQOfficialConnectionManager()
    const internals = manager as unknown as {
      handleDispatch: (...args: unknown[]) => Promise<void>
    }

    await internals.handleDispatch('agent-1', { config }, 'GROUP_AT_MESSAGE_CREATE', {
      id: 'message-group',
      content: '<@!bot-open-id> /new keep this literal',
      group_openid: 'group-1',
      author: { member_openid: 'member-1', username: 'Alice' },
    })

    expect(mockReserveNativeChatRun).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '102000000:group:group-1',
        intent:
          '[QQ group sender metadata]\n{"member_openid":"member-1","username":"Alice"}\n\n/new keep this literal',
        channel: expect.objectContaining({
          channel_info: expect.objectContaining({
            member_openid: 'member-1',
            username: 'Alice',
          }),
        }),
      }),
    )
    expect(mockReserveNativeChatRun.mock.calls[0]?.[0]).not.toHaveProperty('resetSession')
  })

  it('normalizes a C2C message', () => {
    expect(
      normalizeQQOfficialMessage('C2C_MESSAGE_CREATE', {
        id: 'msg',
        content: 'hello',
        author: { user_openid: 'user-1' },
      }),
    ).toMatchObject({ scene: 'c2c', senderOpenId: 'user-1' })
  })

  it.each(['AT_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE'])(
    'ignores the unsupported QQ guild event %s',
    (eventType) => {
      expect(
        normalizeQQOfficialMessage(eventType, {
          id: 'msg',
          content: 'hello',
          author: { id: 'user-1' },
          channel_id: 'channel-1',
          guild_id: 'guild-1',
        }),
      ).toBeNull()
    },
  )

  it('rejects malformed gateway payloads', () => {
    expect(normalizeQQOfficialMessage('C2C_MESSAGE_CREATE', { id: 'msg' })).toBeNull()
    expect(normalizeQQOfficialMessage('UNRELATED_EVENT', { id: 'msg' })).toBeNull()
  })

  it('releases the application reservation when credential validation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    )
    const manager = new QQOfficialConnectionManager()

    await expect(manager.start('agent-1', config)).rejects.toThrow('access token request failed')
    await expect(manager.start('agent-2', config)).rejects.toThrow('access token request failed')
  })

  it('cancels a pending connection start when the Agent is stopped', async () => {
    const tokenResponse = deferred<Response>()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => tokenResponse.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'bot' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const manager = new QQOfficialConnectionManager()

    const starting = manager.start('agent-1', config)
    await manager.stop('agent-1')
    tokenResponse.resolve(
      new Response(JSON.stringify({ access_token: 'access', expires_in: 7200 }), { status: 200 }),
    )

    await expect(starting).rejects.toThrow('connection start was cancelled')
    expect(manager.isRegistered('agent-1')).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refuses to start more shards than the official session limit allows', async () => {
    const responses = [
      new Response(JSON.stringify({ access_token: 'access', expires_in: 7200 }), { status: 200 }),
      new Response(JSON.stringify({ id: 'bot' }), { status: 200 }),
      new Response(
        JSON.stringify({
          url: 'wss://gateway.example',
          shards: 2,
          session_start_limit: { remaining: 1, max_concurrency: 1 },
        }),
        { status: 200 },
      ),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift() as Response),
    )
    const manager = new QQOfficialConnectionManager()

    await expect(manager.start('agent-1', config)).rejects.toThrow(
      'has 1 remaining, but 2 shards are required',
    )
    expect(manager.isRegistered('agent-1')).toBe(false)
  })

  it('identifies after Hello and becomes ready on the official Gateway', async () => {
    class FakeSocket extends EventEmitter {
      readyState = 1
      readonly sent: Record<string, unknown>[] = []

      constructor() {
        super()
        queueMicrotask(() =>
          this.emit(
            'message',
            Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
          ),
        )
      }

      send(raw: string): void {
        const payload = JSON.parse(raw) as Record<string, unknown>
        this.sent.push(payload)
        if (payload.op === 2) {
          queueMicrotask(() =>
            this.emit(
              'message',
              Buffer.from(
                JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } }),
              ),
            ),
          )
        }
      }

      close(code = 1000): void {
        this.readyState = 3
        this.emit('close', code)
      }
    }

    const responses = [
      new Response(JSON.stringify({ access_token: 'access', expires_in: 7200 }), { status: 200 }),
      new Response(JSON.stringify({ id: 'bot' }), { status: 200 }),
      new Response(
        JSON.stringify({
          url: 'wss://gateway.example',
          shards: 1,
          session_start_limit: { remaining: 1, max_concurrency: 1 },
        }),
        { status: 200 },
      ),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift() as Response),
    )
    let socket: FakeSocket | undefined
    const manager = new QQOfficialConnectionManager(() => {
      socket = new FakeSocket()
      return socket as unknown as WebSocket
    })

    await manager.start('agent-1', config)

    expect(socket?.sent).toContainEqual({
      op: 2,
      d: { token: 'QQBot access', intents: 1 << 25, shard: [0, 1] },
    })
    expect(manager.isSocketOpen('agent-1')).toBe(true)
    await manager.stop('agent-1')
  })

  it('commits dispatch sequences in durable processing order', async () => {
    class DispatchSocket extends EventEmitter {
      readyState = 1

      constructor() {
        super()
        queueMicrotask(() =>
          this.emit(
            'message',
            Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
          ),
        )
      }

      send(raw: string): void {
        if ((JSON.parse(raw) as { op?: number }).op === 2) {
          queueMicrotask(() =>
            this.emit(
              'message',
              Buffer.from(
                JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session' } }),
              ),
            ),
          )
        }
      }

      close(code = 1000): void {
        this.readyState = 3
        this.emit('close', code)
      }
    }
    const responses = [
      new Response(JSON.stringify({ access_token: 'access', expires_in: 7200 }), { status: 200 }),
      new Response(JSON.stringify({ id: 'bot' }), { status: 200 }),
      new Response(
        JSON.stringify({
          url: 'wss://gateway.example',
          shards: 1,
          session_start_limit: { remaining: 1, max_concurrency: 1 },
        }),
        { status: 200 },
      ),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift() as Response),
    )
    let socket: DispatchSocket | undefined
    const manager = new QQOfficialConnectionManager(() => {
      socket = new DispatchSocket()
      return socket as unknown as WebSocket
    })
    await manager.start('agent-1', config)

    const firstDispatch = deferred<void>()
    const internals = manager as unknown as {
      handleDispatch: (...args: unknown[]) => Promise<void>
      connections: Map<string, { shards: Map<number, { sequence: number | null }> }>
    }
    const dispatch = vi.fn(async (...args: unknown[]) => {
      if (args[2] === 'FIRST') await firstDispatch.promise
    })
    internals.handleDispatch = dispatch
    socket?.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'FIRST', s: 2, d: {} })))
    socket?.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'SECOND', s: 3, d: {} })))

    await Promise.resolve()
    await Promise.resolve()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(internals.connections.get('agent-1')?.shards.get(0)?.sequence).toBe(1)

    firstDispatch.resolve(undefined)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(internals.connections.get('agent-1')?.shards.get(0)?.sequence).toBe(3)
    await manager.stop('agent-1')
  })

  it('releases the old application when an Agent switches App ID', async () => {
    class ReadySocket extends EventEmitter {
      readyState = 1

      constructor() {
        super()
        queueMicrotask(() =>
          this.emit(
            'message',
            Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })),
          ),
        )
      }

      send(raw: string): void {
        const payload = JSON.parse(raw) as { op?: number }
        if (payload.op === 2) {
          queueMicrotask(() =>
            this.emit(
              'message',
              Buffer.from(
                JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session' } }),
              ),
            ),
          )
        }
      }

      close(code = 1000): void {
        this.readyState = 3
        this.emit('close', code)
      }
    }
    const responses = Array.from({ length: 2 }, () => [
      new Response(JSON.stringify({ access_token: 'access', expires_in: 7200 }), { status: 200 }),
      new Response(JSON.stringify({ id: 'bot' }), { status: 200 }),
      new Response(
        JSON.stringify({
          url: 'wss://gateway.example',
          shards: 1,
          session_start_limit: { remaining: 1, max_concurrency: 1 },
        }),
        { status: 200 },
      ),
    ]).flat()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift() as Response),
    )
    const manager = new QQOfficialConnectionManager(() => new ReadySocket() as unknown as WebSocket)

    await manager.start('agent-1', config)
    await manager.start('agent-1', { ...config, appId: '102000001' })

    const internals = manager as unknown as { applicationHolders: Map<string, string> }
    expect(internals.applicationHolders.get(config.appId)).toBeUndefined()
    expect(internals.applicationHolders.get('102000001')).toBe('agent-1')
    await manager.stop('agent-1')
  })

  it('uses official token authentication and falls back from an expired reply anchor', async () => {
    const responses = [
      new Response(JSON.stringify({ access_token: 'access', expires_in: 7200 }), { status: 200 }),
      new Response(JSON.stringify({ code: 304026, message: 'invalid reply message id' }), {
        status: 400,
      }),
      new Response(JSON.stringify({ id: 'sent' }), { status: 200 }),
    ]
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      const response = responses.shift()
      if (!response) throw new Error('Unexpected fetch')
      return response
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new QQOfficialApiClient(config)

    await client.sendText(
      {
        app_id: config.appId,
        scene: 'group',
        message_id: 'message-1',
        sender_open_id: 'member-1',
        group_open_id: 'group-1',
      },
      'hello',
      true,
      7,
    )

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://bots.qq.com/app/getAppAccessToken')
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.sgroup.qq.com/v2/groups/group-1/messages',
    )
    const firstSend = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(firstSend.headers).toMatchObject({
      Authorization: 'QQBot access',
      'X-Union-Appid': config.appId,
    })
    expect(JSON.parse(String(firstSend.body))).toMatchObject({
      content: 'hello',
      msg_type: 0,
      msg_id: 'message-1',
      msg_seq: 7,
    })
    const retry = fetchMock.mock.calls[2]?.[1] as RequestInit
    expect(JSON.parse(String(retry.body))).not.toHaveProperty('msg_id')
  })

  it('uploads file artifact bytes and filename instead of its local path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qq-artifact-'))
    const path = join(dir, 'report.txt')
    await writeFile(path, 'artifact contents')
    const responses = [
      new Response(JSON.stringify({ access_token: 'access', expires_in: 7200 }), { status: 200 }),
      new Response(JSON.stringify({ file_info: 'uploaded-file' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'sent' }), { status: 200 }),
    ]
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(responses.shift() as Response),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new QQOfficialApiClient(config)

    try {
      await client.sendArtifact(
        {
          app_id: config.appId,
          scene: 'c2c',
          message_id: 'message-1',
          sender_open_id: 'user-1',
        },
        {
          id: 'artifact-1',
          kind: 'file',
          filename: 'report.txt',
          storagePath: path,
          mimeType: 'text/plain',
          agentId: 'agent-1',
        },
        false,
        8,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }

    const upload = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))
    expect(upload).toMatchObject({
      file_type: 4,
      file_name: 'report.txt',
      file_data: Buffer.from('artifact contents').toString('base64'),
    })
    expect(upload.file_data).not.toContain(path)
  })

  it('rejects oversized artifacts before reading or encoding them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qq-large-artifact-'))
    const path = join(dir, 'large.bin')
    await writeFile(path, '')
    await truncate(path, QQ_MAX_ARTIFACT_UPLOAD_BYTES + 1)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new QQOfficialApiClient(config)

    try {
      await expect(
        client.sendArtifact(
          {
            app_id: config.appId,
            scene: 'c2c',
            message_id: 'message-1',
            sender_open_id: 'user-1',
          },
          {
            id: 'artifact-large',
            kind: 'file',
            filename: 'large.bin',
            storagePath: path,
            mimeType: 'application/octet-stream',
            agentId: 'agent-1',
          },
          false,
          9,
        ),
      ).rejects.toThrow('exceeds QQ')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('QQ Gateway reconnect backoff', () => {
  /** A socket that fails the handshake, the shape a token-fetch outage produces. */
  class ClosingSocket extends EventEmitter {
    readyState = 1

    constructor() {
      super()
      queueMicrotask(() => {
        this.readyState = 3
        this.emit('close', 1006)
      })
    }

    send(): void {}

    close(code = 1006): void {
      this.readyState = 3
      this.emit('close', code)
    }
  }

  type ShardInternals = {
    id: number
    sequence: number | null
    ready: boolean
    consecutiveFailures: number
  }
  type ConnectionInternals = {
    stopping: boolean
    shards: Map<number, ShardInternals>
    shardCount: number
    failureReason?: string
    [key: string]: unknown
  }
  type ManagerInternals = {
    connectShard: (agentId: string, connection: unknown, shard: unknown) => void
    handleGatewayPayload: (
      agentId: string,
      connection: unknown,
      shard: unknown,
      raw: string,
    ) => Promise<void>
    connections: Map<string, ConnectionInternals>
  }

  function buildManager(onSocket: () => void) {
    const manager = new QQOfficialConnectionManager(() => {
      onSocket()
      return new ClosingSocket() as unknown as WebSocket
    })
    const internals = manager as unknown as ManagerInternals
    const shard: ShardInternals = { id: 0, sequence: null, ready: false, consecutiveFailures: 0 }
    const connection: ConnectionInternals = {
      generation: 1,
      config,
      client: { invalidateToken: vi.fn(), getToken: vi.fn() },
      gatewayUrl: 'wss://gateway.example',
      shardCount: 1,
      identifyLimiter: { acquire: async () => {} },
      readyTimeoutMs: 1_000,
      shards: new Map([[0, shard]]),
      stopping: false,
    }
    internals.connections.set('agent-1', connection)
    return { manager, internals, connection, shard }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('backs off exponentially with jitter and caps at 60s', () => {
    expect(computeQQReconnectDelay(1, () => 0)).toBeGreaterThanOrEqual(500)
    expect(computeQQReconnectDelay(1, () => 1)).toBeLessThanOrEqual(1_000)
    expect(computeQQReconnectDelay(2, () => 1)).toBeLessThanOrEqual(2_000)
    expect(computeQQReconnectDelay(2, () => 0)).toBeGreaterThan(computeQQReconnectDelay(1, () => 1))
    // Cap: without one, attempt 20 would ask for ~6 days.
    expect(computeQQReconnectDelay(20, () => 1)).toBeLessThanOrEqual(60_000)
    expect(computeQQReconnectDelay(20, () => 0)).toBeGreaterThan(30_000)
    // Jitter: two draws from the same attempt must not be identical.
    expect(computeQQReconnectDelay(5, () => 0)).not.toBe(computeQQReconnectDelay(5, () => 1))
  })

  it('spaces retries instead of hammering the Gateway once a second', async () => {
    vi.useFakeTimers()
    let created = 0
    const { internals, connection, shard } = buildManager(() => {
      created += 1
    })

    internals.connectShard('agent-1', connection, shard)
    await vi.advanceTimersByTimeAsync(0)
    expect(created).toBe(1)
    expect(shard.consecutiveFailures).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(created).toBe(2)
    expect(shard.consecutiveFailures).toBe(2)

    // The second retry must wait longer than the first: at 700ms the old fixed
    // 1s delay would already have fired again.
    await vi.advanceTimersByTimeAsync(700)
    expect(created).toBe(2)
    await vi.advanceTimersByTimeAsync(1_300)
    expect(created).toBe(3)
  })

  it('stops reconnecting after the failure budget and reports the connection as failed', async () => {
    vi.useFakeTimers()
    let created = 0
    const { manager, internals, connection, shard } = buildManager(() => {
      created += 1
    })

    internals.connectShard('agent-1', connection, shard)
    for (let i = 0; i < MAX_QQ_CONSECUTIVE_RECONNECT_FAILURES + 5; i++) {
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(created).toBe(MAX_QQ_CONSECUTIVE_RECONNECT_FAILURES)
    expect(connection.failureReason).toBeTruthy()
    expect(manager.getConnectionStatuses()).toEqual([
      { agentId: 'agent-1', socketOpen: false, failed: true, lastError: connection.failureReason },
    ])
  })

  it('resets the failure budget once the shard is READY again', async () => {
    const { internals, connection, shard } = buildManager(() => {})
    shard.consecutiveFailures = 7
    connection.failureReason = 'previous outage'

    await internals.handleGatewayPayload(
      'agent-1',
      connection,
      shard,
      JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } }),
    )

    expect(shard.consecutiveFailures).toBe(0)
    expect(connection.failureReason).toBeUndefined()
  })
})
