import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockAgentGet = vi.hoisted(() => vi.fn())
const mockFilesInfo = vi.hoisted(() => vi.fn())
const mockSafeFetch = vi.hoisted(() => vi.fn())
const mockStageAttachment = vi.hoisted(() => vi.fn())

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({ from: () => asyncQuery({ where: () => asyncQuery({ get: mockAgentGet }) }) }),
  },
}))
vi.mock('../../db/schema.js', () => ({
  agents: { id: {}, slackConfig: {}, discordConfig: {} },
}))
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({})) }))
vi.mock('@slack/web-api', () => ({
  WebClient: class {
    files = { info: mockFilesInfo }
  },
}))
vi.mock('../settings.js', () => ({
  getAttachmentSettings: () => ({
    stagingPath: './data/attachments',
    stagingTtlHours: 168,
    maxFileSizeBytes: 1024,
    maxFilesPerRequest: 10,
    allowedExtensions: new Set(['png', 'pdf']),
  }),
}))
vi.mock('../url-safety-core.js', async () => {
  const actual =
    await vi.importActual<typeof import('../url-safety-core.js')>('../url-safety-core.js')
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  }
})
vi.mock('../attachment-storage.js', () => ({
  stageAttachment: (...args: unknown[]) => mockStageAttachment(...args),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { asyncQuery } from '../../test/async-query.js'
import { resolveNativeChatAttachments } from '../native-chat-attachments.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockAgentGet.mockReturnValue({
    slackConfig: {
      appId: 'A123',
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
    },
    discordConfig: {
      applicationId: 'APP123',
      botToken: 'discord-test',
    },
  })
  mockStageAttachment.mockImplementation(
    (bytes: Buffer, name: string, mimeType: string, uploaderId: string) => ({
      token: 'att_staged',
      storedPath: `/tmp/${name}`,
      meta: { name, mimeType, size: bytes.length, uploaderId },
    }),
  )
})

describe('resolveNativeChatAttachments', () => {
  it('refreshes Slack file metadata and downloads private bytes with the bot token', async () => {
    mockFilesInfo.mockResolvedValue({
      file: {
        name: 'report.pdf',
        mimetype: 'application/pdf',
        size: 4,
        url_private_download: 'https://files.slack.com/files-pri/T-F/download/report.pdf',
      },
    })
    mockSafeFetch.mockResolvedValue(
      new Response(Buffer.from('file'), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '4' },
      }),
    )

    const refs = await resolveNativeChatAttachments('agt_1', [
      {
        source: 'slack',
        remoteId: 'F123',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 4,
      },
    ])

    expect(mockFilesInfo).toHaveBeenCalledWith({ file: 'F123' })
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://files.slack.com/files-pri/T-F/download/report.pdf',
      expect.objectContaining({
        maxRedirects: 0,
        headers: { Authorization: 'Bearer xoxb-test' },
      }),
    )
    expect(mockStageAttachment).toHaveBeenCalledWith(
      Buffer.from('file'),
      'report.pdf',
      'application/pdf',
      'agent:agt_1',
    )
    expect(refs).toEqual([
      {
        token: 'att_staged',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 4,
      },
    ])
  })

  it('refetches a Discord message before downloading its refreshed signed CDN URL', async () => {
    mockSafeFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            attachments: [
              {
                id: 'ATT123',
                filename: 'diagram.png',
                content_type: 'image/png',
                size: 3,
                url: 'https://cdn.discordapp.com/attachments/C123/ATT123/diagram.png?ex=fresh',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('png'), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '3' },
        }),
      )

    const refs = await resolveNativeChatAttachments('agt_1', [
      {
        source: 'discord',
        remoteId: 'ATT123',
        channelId: 'C123',
        messageId: 'M123',
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 3,
      },
    ])

    expect(mockSafeFetch.mock.calls[0]?.[0]).toBe(
      'https://discord.com/api/v10/channels/C123/messages/M123',
    )
    expect(mockSafeFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ headers: { Authorization: 'Bot discord-test' } }),
    )
    expect(mockSafeFetch.mock.calls[1]?.[0]).toBe(
      'https://cdn.discordapp.com/attachments/C123/ATT123/diagram.png?ex=fresh',
    )
    expect(refs).toHaveLength(1)
  })

  it('rejects a Slack files.info response that points outside Slack file hosting', async () => {
    mockFilesInfo.mockResolvedValue({
      file: {
        name: 'report.pdf',
        mimetype: 'application/pdf',
        size: 4,
        url_private_download: 'https://attacker.example/report.pdf',
      },
    })

    await expect(
      resolveNativeChatAttachments('agt_1', [
        {
          source: 'slack',
          remoteId: 'F123',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          size: 4,
        },
      ]),
    ).resolves.toEqual([])
    expect(mockSafeFetch).not.toHaveBeenCalled()
    expect(mockStageAttachment).not.toHaveBeenCalled()
  })

  it('downloads a QQ Official attachment from a public HTTPS URL', async () => {
    mockSafeFetch.mockResolvedValue(
      new Response(Buffer.from('png'), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '3' },
      }),
    )

    const refs = await resolveNativeChatAttachments('agt_1', [
      {
        source: 'qq_official',
        remoteUrl: 'https://multimedia.nt.qq.com.cn/download/example.png',
        name: 'example.png',
        mimeType: 'image/png',
        size: 3,
      },
    ])

    expect(mockSafeFetch).toHaveBeenCalledOnce()
    expect(mockStageAttachment).toHaveBeenCalledOnce()
    expect(refs).toHaveLength(1)
  })

  it.each([
    'https://127.0.0.1/private.png',
    'https://169.254.169.254/latest/meta-data/credentials.png',
  ])('rejects a QQ Official attachment URL targeting a reserved address: %s', async (remoteUrl) => {
    await expect(
      resolveNativeChatAttachments('agt_1', [
        {
          source: 'qq_official',
          remoteUrl,
          name: 'private.png',
          mimeType: 'image/png',
          size: 3,
        },
      ]),
    ).resolves.toEqual([])

    expect(mockSafeFetch).not.toHaveBeenCalled()
    expect(mockStageAttachment).not.toHaveBeenCalled()
  })
})
