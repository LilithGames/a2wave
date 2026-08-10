import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reserveNativeChatRun = vi.hoisted(() => vi.fn())

vi.mock('../native-chat-runner.js', () => ({
  reserveNativeChatRun,
}))

// The Slack SDK must never reach the network: `start()` calls `auth.test()`,
// which would hang indefinitely under fake timers.
const socketStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: class {
    on = vi.fn()
    start = socketStart
    disconnect = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    auth = { test: vi.fn().mockResolvedValue({ user_id: 'UBOT', team_id: 'T123' }) }
    chat = { postMessage: vi.fn().mockResolvedValue(undefined) }
    filesUploadV2 = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('../artifact-links.js', () => ({
  buildArtifactLinkLinesSync: (
    artifacts: Array<{
      id: string
      filename: string
    }>,
  ) =>
    artifacts
      .map(
        (artifact) =>
          `- [${artifact.filename}](https://a2wave.example.com/api/artifacts/${artifact.id}/download)`,
      )
      .join('\n'),
}))

import {
  SlackConnectionManager,
  buildSlackConversationId,
  extractSlackNativeAttachments,
  shouldTriggerSlackEvent,
  stripSlackBotMention,
} from '../slack-service.js'

const config = {
  groupTriggerOnAt: true,
  groupTriggerOnNewMessage: false,
}

describe('Slack service helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('always accepts human direct messages', async () => {
    expect(
      shouldTriggerSlackEvent(config, {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: 'hello',
        ts: '1710000000.000001',
      }),
    ).toBe(true)
  })

  it('requires a bot mention in channels by default', async () => {
    const event = {
      type: 'message',
      channel: 'C123',
      channel_type: 'channel',
      user: 'U123',
      text: 'hello',
      ts: '1710000000.000001',
    }
    expect(shouldTriggerSlackEvent(config, event, 'UBOT')).toBe(false)
    expect(shouldTriggerSlackEvent(config, { ...event, text: '<@UBOT> hello' }, 'UBOT')).toBe(true)
  })

  it('ignores bot and edited/deleted message events', async () => {
    const event = {
      type: 'message',
      channel: 'C123',
      channel_type: 'channel',
      user: 'U123',
      text: '<@UBOT> hello',
      ts: '1710000000.000001',
    }
    expect(shouldTriggerSlackEvent(config, { ...event, bot_id: 'B123' }, 'UBOT')).toBe(false)
    expect(shouldTriggerSlackEvent(config, { ...event, subtype: 'message_changed' }, 'UBOT')).toBe(
      false,
    )
  })

  it('accepts Slack file_share events and extracts durable file ids without private URLs', async () => {
    const event = {
      type: 'message',
      channel: 'D123',
      channel_type: 'im',
      user: 'U123',
      text: '',
      ts: '1710000000.000001',
      subtype: 'file_share',
      files: [
        {
          id: 'F123',
          name: 'report.pdf',
          mimetype: 'application/pdf',
          size: 42,
          url_private_download: 'https://files.slack.com/files-pri/T-F/download/report.pdf',
        },
      ],
    }

    expect(shouldTriggerSlackEvent(config, event)).toBe(true)
    expect(extractSlackNativeAttachments(event)).toEqual([
      {
        source: 'slack',
        remoteId: 'F123',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 42,
      },
    ])
  })

  it('keeps direct messages together and scopes channel threads separately', async () => {
    expect(
      buildSlackConversationId('T123', {
        channel: 'D123',
        channel_type: 'im',
        ts: '1710000000.000001',
      }),
    ).toBe('T123:D123')
    expect(
      buildSlackConversationId('T123', {
        channel: 'C123',
        channel_type: 'channel',
        ts: '1710000000.000001',
        thread_ts: '1700000000.000001',
      }),
    ).toBe('T123:C123:1700000000.000001')
  })

  it('removes only the receiving bot mention from the prompt', async () => {
    expect(stripSlackBotMention('<@UBOT> ask <@UOTHER> for help', 'UBOT')).toBe(
      'ask <@UOTHER> for help',
    )
  })

  it('derives one dedup key per message so a doubly-delivered mention runs once', async () => {
    reserveNativeChatRun.mockReset()
    reserveNativeChatRun.mockResolvedValue({ status: 'started', runId: 'run_1' })
    const manager = new SlackConnectionManager()
    const connection = {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: true,
        groupReplyMode: 'new',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      botUserId: 'UBOT',
      teamId: 'T123',
    }
    const handleEnvelope = (
      manager as unknown as {
        handleEnvelope: (agentId: string, connection: unknown, envelope: unknown) => Promise<void>
      }
    ).handleEnvelope.bind(manager)

    // One user @-mention in a channel that also subscribes message.channels:
    // Slack delivers an app_mention envelope and a message envelope, each with
    // its own event_id, but both describe the same message ts.
    const event = {
      channel: 'C123',
      channel_type: 'channel',
      user: 'U123',
      text: '<@UBOT> hello',
      ts: '1710000000.000001',
    }
    await handleEnvelope('agt_1', connection, {
      ack: vi.fn().mockResolvedValue(undefined),
      body: { event_id: 'Ev_APP_MENTION', team_id: 'T123' },
      event: { ...event, type: 'app_mention' },
    })
    await handleEnvelope('agt_1', connection, {
      ack: vi.fn().mockResolvedValue(undefined),
      body: { event_id: 'Ev_MESSAGE', team_id: 'T123' },
      event: { ...event, type: 'message' },
    })

    await vi.advanceTimersByTimeAsync(5_000)

    // The message envelope supersedes the deferred mention, so only one
    // reservation is made — and it is keyed by message identity, not by the
    // per-envelope event_id, so any redelivery collapses onto it too.
    expect(reserveNativeChatRun).toHaveBeenCalledTimes(1)
    const { eventId } = reserveNativeChatRun.mock.calls[0]?.[0] as { eventId: string }
    expect(eventId).toBe('slack:T123:C123:1710000000.000001')
  })

  it('prefers the message envelope so a mentioned file upload keeps its attachments', async () => {
    reserveNativeChatRun.mockReset()
    reserveNativeChatRun.mockResolvedValue({ status: 'started', runId: 'run_1' })
    const manager = new SlackConnectionManager()
    const connection = {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: true,
        groupReplyMode: 'new',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      botUserId: 'UBOT',
      teamId: 'T123',
    }
    const handleEnvelope = (
      manager as unknown as {
        handleEnvelope: (agentId: string, connection: unknown, envelope: unknown) => Promise<void>
      }
    ).handleEnvelope.bind(manager)

    // Slack's app_mention payload carries no `files` array, so if that envelope
    // wins the dedup race the upload is silently dropped.
    await handleEnvelope('agt_1', connection, {
      ack: vi.fn().mockResolvedValue(undefined),
      body: { event_id: 'Ev_APP_MENTION', team_id: 'T123' },
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@UBOT> review this',
        ts: '1710000000.000001',
      },
    })

    expect(reserveNativeChatRun).not.toHaveBeenCalled()

    await handleEnvelope('agt_1', connection, {
      ack: vi.fn().mockResolvedValue(undefined),
      body: { event_id: 'Ev_MESSAGE', team_id: 'T123' },
      event: {
        type: 'message',
        channel: 'C123',
        channel_type: 'channel',
        user: 'U123',
        text: '<@UBOT> review this',
        ts: '1710000000.000001',
        subtype: 'file_share',
        files: [{ id: 'F123', name: 'report.pdf', mimetype: 'application/pdf', size: 42 }],
      },
    })

    await vi.advanceTimersByTimeAsync(5_000)

    expect(reserveNativeChatRun).toHaveBeenCalledTimes(1)
    const reserved = reserveNativeChatRun.mock.calls[0]?.[0] as {
      nativeAttachments: unknown[]
    }
    expect(reserved.nativeAttachments).toHaveLength(1)
  })

  it('still triggers on app_mention when message.channels is not subscribed', async () => {
    reserveNativeChatRun.mockReset()
    reserveNativeChatRun.mockResolvedValue({ status: 'started', runId: 'run_1' })
    const manager = new SlackConnectionManager()
    const connection = {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: false,
        groupReplyMode: 'new',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      botUserId: 'UBOT',
      teamId: 'T123',
    }
    const handleEnvelope = (
      manager as unknown as {
        handleEnvelope: (agentId: string, connection: unknown, envelope: unknown) => Promise<void>
      }
    ).handleEnvelope.bind(manager)

    // The documented default workspace setup subscribes app_mention only, so no
    // message envelope ever follows. Dropping it outright would break every
    // existing channel deployment.
    await handleEnvelope('agt_1', connection, {
      ack: vi.fn().mockResolvedValue(undefined),
      body: { event_id: 'Ev_APP_MENTION', team_id: 'T123' },
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@UBOT> hello',
        ts: '1710000000.000001',
      },
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(reserveNativeChatRun).toHaveBeenCalledTimes(1)
  })

  it('drops deferred mentions when the Agent connection stops', async () => {
    reserveNativeChatRun.mockReset()
    reserveNativeChatRun.mockResolvedValue({ status: 'started', runId: 'run_1' })
    const manager = new SlackConnectionManager()
    const config = {
      appId: 'A123',
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      groupTriggerOnAt: true,
      groupTriggerOnNewMessage: false,
      groupReplyMode: 'new',
      p2pReplyMode: 'new',
      sendArtifactsAsFile: true,
    }
    const connection = { config, botUserId: 'UBOT', teamId: 'T123' }
    ;(manager as unknown as { connections: Map<string, unknown> }).connections.set('agt_1', {
      ...connection,
      socket: { disconnect: vi.fn().mockResolvedValue(undefined) },
    })
    const handleEnvelope = (
      manager as unknown as {
        handleEnvelope: (agentId: string, connection: unknown, envelope: unknown) => Promise<void>
      }
    ).handleEnvelope.bind(manager)

    await handleEnvelope('agt_1', connection, {
      ack: vi.fn().mockResolvedValue(undefined),
      body: { event_id: 'Ev_APP_MENTION', team_id: 'T123' },
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@UBOT> hello',
        ts: '1710000000.000001',
      },
    })
    const pending = manager as unknown as {
      pendingMentions: Map<string, unknown>
      connections: Map<string, unknown>
    }
    expect([...pending.pendingMentions.keys()]).toEqual(['agt_1 slack:T123:C123:1710000000.000001'])
    expect(pending.connections.has('agt_1')).toBe(true)

    await manager.stop('agt_1')
    expect([...pending.pendingMentions.keys()]).toEqual([])

    await vi.advanceTimersByTimeAsync(5_000)
    expect(reserveNativeChatRun).not.toHaveBeenCalled()
  })

  it('leaves a failed deferred mention un-acked so Slack redelivers it', async () => {
    reserveNativeChatRun.mockReset()
    reserveNativeChatRun.mockRejectedValue(new Error('database unavailable'))
    const manager = new SlackConnectionManager()
    const connection = {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: false,
        groupReplyMode: 'new',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      botUserId: 'UBOT',
      teamId: 'T123',
    }
    const handleEnvelope = (
      manager as unknown as {
        handleEnvelope: (agentId: string, connection: unknown, envelope: unknown) => Promise<void>
      }
    ).handleEnvelope.bind(manager)

    const ack = vi.fn().mockResolvedValue(undefined)
    await handleEnvelope('agt_1', connection, {
      ack,
      body: { event_id: 'Ev_APP_MENTION', team_id: 'T123' },
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@UBOT> hello',
        ts: '1710000000.000001',
      },
    })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(reserveNativeChatRun).toHaveBeenCalledTimes(1)
    // Acking here would tell Slack the mention was handled and lose it forever.
    expect(ack).not.toHaveBeenCalled()
  })

  it('acks a superseded mention and drops timers when the connection is replaced', async () => {
    reserveNativeChatRun.mockReset()
    reserveNativeChatRun.mockResolvedValue({ status: 'started', runId: 'run_1' })
    const manager = new SlackConnectionManager()
    const connection = {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: true,
        groupReplyMode: 'new',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      botUserId: 'UBOT',
      teamId: 'T123',
    }
    const handleEnvelope = (
      manager as unknown as {
        handleEnvelope: (agentId: string, connection: unknown, envelope: unknown) => Promise<void>
      }
    ).handleEnvelope.bind(manager)

    const mentionAck = vi.fn().mockResolvedValue(undefined)
    const event = {
      channel: 'C123',
      channel_type: 'channel',
      user: 'U123',
      text: '<@UBOT> hello',
      ts: '1710000000.000001',
    }
    await handleEnvelope('agt_1', connection, {
      ack: mentionAck,
      body: { event_id: 'Ev_APP_MENTION', team_id: 'T123' },
      event: { ...event, type: 'app_mention' },
    })
    await handleEnvelope('agt_1', connection, {
      ack: vi.fn().mockResolvedValue(undefined),
      body: { event_id: 'Ev_MESSAGE', team_id: 'T123' },
      event: { ...event, type: 'message' },
    })

    // The message envelope took over, so the mention must be acknowledged
    // rather than left for Slack to redeliver.
    expect(mentionAck).toHaveBeenCalledTimes(1)

    const pending = manager as unknown as { pendingMentions: Map<string, unknown> }
    expect([...pending.pendingMentions.keys()]).toEqual([])
  })

  it('drops deferred mentions belonging to a replaced connection', async () => {
    reserveNativeChatRun.mockReset()
    reserveNativeChatRun.mockResolvedValue({ status: 'started', runId: 'run_1' })
    const manager = new SlackConnectionManager()
    const config = {
      appId: 'A123',
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      groupTriggerOnAt: true,
      groupTriggerOnNewMessage: false,
      groupReplyMode: 'new',
      p2pReplyMode: 'new',
      sendArtifactsAsFile: true,
    }
    const connection = { config, botUserId: 'UBOT', teamId: 'T123' }
    const internals = manager as unknown as {
      connections: Map<string, unknown>
      pendingMentions: Map<string, unknown>
      handleEnvelope: (agentId: string, connection: unknown, envelope: unknown) => Promise<void>
    }
    internals.connections.set('agt_1', {
      ...connection,
      socket: { disconnect: vi.fn().mockResolvedValue(undefined) },
    })

    await internals.handleEnvelope.call(manager, 'agt_1', connection, {
      ack: vi.fn().mockResolvedValue(undefined),
      body: { event_id: 'Ev_APP_MENTION', team_id: 'T123' },
      event: {
        type: 'app_mention',
        channel: 'C123',
        user: 'U123',
        text: '<@UBOT> hello',
        ts: '1710000000.000001',
      },
    })
    expect([...internals.pendingMentions.keys()]).toHaveLength(1)

    // Restarting the Agent replaces the connection; the old timer closes over a
    // disconnected socket and must not fire against it.
    await manager.start('agt_1', config).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(reserveNativeChatRun).not.toHaveBeenCalled()
    expect([...internals.pendingMentions.keys()]).toEqual([])
  })

  it('drops deferred mentions when startup fails', async () => {
    reserveNativeChatRun.mockReset()
    reserveNativeChatRun.mockResolvedValue({ status: 'started', runId: 'run_1' })
    const manager = new SlackConnectionManager()
    const config = {
      appId: 'A123',
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      groupTriggerOnAt: true,
      groupTriggerOnNewMessage: false,
      groupReplyMode: 'new',
      p2pReplyMode: 'new',
      sendArtifactsAsFile: true,
    }
    const internals = manager as unknown as {
      pendingMentions: Map<string, unknown>
      handleEnvelope: (agentId: string, connection: unknown, envelope: unknown) => Promise<void>
    }

    // Socket listeners are attached before start() resolves, so an event can be
    // deferred against a connection whose startup then fails.
    await internals.handleEnvelope.call(
      manager,
      'agt_1',
      { config, botUserId: 'UBOT', teamId: 'T123' },
      {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: 'Ev_APP_MENTION', team_id: 'T123' },
        event: {
          type: 'app_mention',
          channel: 'C123',
          user: 'U123',
          text: '<@UBOT> hello',
          ts: '1710000000.000001',
        },
      },
    )
    expect([...internals.pendingMentions.keys()]).toHaveLength(1)

    socketStart.mockRejectedValueOnce(new Error('socket refused'))
    await expect(manager.start('agt_1', config)).rejects.toThrow('socket refused')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(reserveNativeChatRun).not.toHaveBeenCalled()
    expect([...internals.pendingMentions.keys()]).toEqual([])
  })

  it('neutralizes outbound Slack mentions without changing ordinary links', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const manager = new SlackConnectionManager()
    ;(
      manager as unknown as {
        connections: Map<string, unknown>
      }
    ).connections.set('agt_1', {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: false,
        groupReplyMode: 'new',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      web: { chat: { postMessage }, filesUploadV2: vi.fn() },
    })

    await manager.sendMessageByContext(
      'agt_1',
      {
        channel_type: 'slack',
        channel_info: {
          app_id: 'A123',
          team_id: 'T123',
          channel_id: 'C123',
          chat_type: 'channel',
          message_ts: '1710000000.000001',
          sender_user_id: 'U123',
        },
        user_info: null,
      },
      'Review <!channel> <!here> <!everyone> <@U123> <!subteam^S123> <https://example.com|link>',
    )

    const message = postMessage.mock.calls[0]?.[0] as {
      text: string
      blocks: Array<{ text: string }>
    }
    for (const rendered of [message.text, message.blocks[0]?.text]) {
      expect(rendered).not.toContain('<!channel>')
      expect(rendered).not.toContain('<!here>')
      expect(rendered).not.toContain('<!everyone>')
      expect(rendered).not.toContain('<@U123>')
      expect(rendered).not.toContain('<!subteam^S123>')
      expect(rendered).toContain('<https://example.com|link>')
    }
  })

  it('renders standard Markdown and uploads Agent artifacts into the configured Slack thread', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const filesUploadV2 = vi.fn().mockResolvedValue(undefined)
    const manager = new SlackConnectionManager()
    ;(
      manager as unknown as {
        connections: Map<string, unknown>
      }
    ).connections.set('agt_1', {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: false,
        groupReplyMode: 'thread',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      web: { chat: { postMessage }, filesUploadV2 },
    })

    const output = [
      '### Gold price table',
      '',
      '| Date | Price |',
      '| --- | --- |',
      '| **July 23** | **$4,123.47** |',
      '',
      '[Download report](sandbox:/tmp/a2wave-sandbox/artifacts/report.pdf)',
      '',
      '---',
      '**产物下载**',
      '- [report.pdf](http://localhost:3502/api/artifacts/art_1/download)',
    ].join('\n')

    await manager.sendRunResultByContext(
      'agt_1',
      {
        channel_type: 'slack',
        channel_info: {
          app_id: 'A123',
          team_id: 'T123',
          channel_id: 'C123',
          chat_type: 'channel',
          message_ts: '1710000000.000001',
          sender_user_id: 'U123',
        },
        user_info: null,
      },
      output,
      [
        {
          id: 'art_1',
          filename: 'report.pdf',
          storagePath: '/artifacts/report.pdf',
          kind: 'file',
          mimeType: 'application/pdf',
          agentId: 'agt_1',
        },
      ],
    )

    const message = postMessage.mock.calls[0]?.[0] as {
      text: string
      blocks: Array<{ type: string; text: string }>
      channel: string
      thread_ts: string
    }
    expect(message.channel).toBe('C123')
    expect(message.thread_ts).toBe('1710000000.000001')
    expect(message.text).not.toContain('###')
    expect(message.blocks).toHaveLength(1)
    expect(message.blocks[0]).toEqual({
      type: 'markdown',
      text: expect.stringContaining('### Gold price table'),
    })
    expect(message.blocks[0]?.text).toContain('| **July 23** | **$4,123.47** |')
    expect(message.blocks[0]?.text).not.toContain('sandbox:')
    expect(message.blocks[0]?.text).not.toContain('产物下载')
    expect(message.blocks[0]?.text).not.toContain('localhost:3502')
    expect(filesUploadV2).toHaveBeenCalledWith({
      channel_id: 'C123',
      thread_ts: '1710000000.000001',
      file: '/artifacts/report.pdf',
      filename: 'report.pdf',
      title: 'report.pdf',
    })
  })

  it('keeps a download fallback when a Slack artifact upload fails', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const filesUploadV2 = vi.fn().mockRejectedValue(new Error('upload failed'))
    const manager = new SlackConnectionManager()
    ;(
      manager as unknown as {
        connections: Map<string, unknown>
      }
    ).connections.set('agt_1', {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: false,
        groupReplyMode: 'thread',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      web: { chat: { postMessage }, filesUploadV2 },
    })

    await manager.sendRunResultByContext(
      'agt_1',
      {
        channel_type: 'slack',
        channel_info: {
          app_id: 'A123',
          team_id: 'T123',
          channel_id: 'C123',
          chat_type: 'channel',
          message_ts: '1710000000.000001',
          sender_user_id: 'U123',
        },
        user_info: null,
      },
      [
        'Done',
        '',
        '---',
        '**产物下载**',
        '- [report.pdf](https://a2wave.example.com/api/artifacts/art_1/download)',
      ].join('\n'),
      [
        {
          id: 'art_1',
          filename: 'report.pdf',
          storagePath: '/artifacts/report.pdf',
          kind: 'file',
          mimeType: 'application/pdf',
          agentId: 'agt_1',
        },
      ],
    )

    expect(postMessage).toHaveBeenCalledTimes(2)
    const fallback = postMessage.mock.calls[1]?.[0] as {
      blocks: Array<{ type: string; text: string }>
    }
    expect(fallback.blocks[0]?.text).toContain('report.pdf')
    expect(fallback.blocks[0]?.text).toContain('/api/artifacts/art_1/download')
  })
})
