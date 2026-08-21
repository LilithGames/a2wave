import { describe, expect, it } from 'vitest'
import {
  CHANNEL_TRANSPORTS,
  type ChatConnectionMaps,
  channelConnectionTone,
  resolveChannelConnectionUi,
} from '../channel-connection-ui'

const emptyMaps: ChatConnectionMaps = {
  feishu: new Map(),
  slack: new Map(),
  discord: new Map(),
  qq_official: new Map(),
}

function maps(
  channel: 'feishu' | 'slack' | 'discord' | 'qq_official',
  entries: [string, boolean][],
) {
  return { ...emptyMaps, [channel]: new Map(entries) }
}

/** A configured, enabled, published, healthy channel — the all-green baseline. */
const baseline = {
  channel: 'slack' as const,
  persistedEnabled: true,
  formEnabled: true,
  configured: true,
  publishStatus: 'published',
  agentId: 'a1',
  connections: maps('slack', [['a1', true]]),
  isLoading: false,
}

function resolve(overrides: Partial<Parameters<typeof resolveChannelConnectionUi>[0]> = {}) {
  return resolveChannelConnectionUi({ ...baseline, ...overrides })
}

describe('CHANNEL_TRANSPORTS', () => {
  it('describes a long-lived socket for every native chat channel', () => {
    expect(CHANNEL_TRANSPORTS.feishu.kind).toBe('socket')
    expect(CHANNEL_TRANSPORTS.slack.kind).toBe('socket')
    expect(CHANNEL_TRANSPORTS.discord.kind).toBe('socket')
    expect(CHANNEL_TRANSPORTS.qq_official.kind).toBe('socket')
  })

  it('gives each channel its own protocol label so the cards read differently', () => {
    const labels = Object.values(CHANNEL_TRANSPORTS).map((t) => t.labelKey)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('resolveChannelConnectionUi', () => {
  it('returns null for a channel with no long connection', () => {
    expect(resolve({ channel: 'api' })).toBeNull()
  })

  it('returns null for a never-configured, never-enabled channel', () => {
    // A fresh draft Agent must not advertise three "not connected" pills for
    // channels nobody ever set up.
    expect(resolve({ configured: false, persistedEnabled: false, formEnabled: false })).toBeNull()
  })

  it('reports connected when the socket is open', () => {
    expect(resolve()).toBe('connected')
  })

  it('reports reconnecting when registered but the socket is closed', () => {
    expect(resolve({ connections: maps('slack', [['a1', false]]) })).toBe('reconnecting')
  })

  it('reports absent when published but unregistered on this instance', () => {
    expect(resolve({ connections: maps('slack', [['other', true]]) })).toBe('absent')
  })

  it('reports not_published for a draft agent', () => {
    expect(resolve({ publishStatus: 'draft' })).toBe('not_published')
  })

  it('reports not_published for a stopped agent — stopping closes the connection', () => {
    expect(resolve({ publishStatus: 'stopped' })).toBe('not_published')
  })

  it('reports disabled when the channel is off in the persisted config', () => {
    expect(resolve({ persistedEnabled: false, formEnabled: false })).toBe('disabled')
  })

  it('reports loading before the status query resolves', () => {
    expect(resolve({ isLoading: true, connections: undefined })).toBe('loading')
  })

  it('reports error rather than spinning forever when the query failed', () => {
    // Regression: a failed query used to collapse into `loading`, leaving the
    // card on a permanent spinner that hid a down socket.
    expect(resolve({ isLoading: false, isError: true })).toBe('error')
  })

  it('reports error when connections are missing without an explicit error flag', () => {
    expect(resolve({ isLoading: false, connections: undefined })).toBe('error')
  })

  describe('unsaved switch toggles', () => {
    it('reports pending when switched off but not yet published', () => {
      // Regression: this used to report `connected` under a visibly-off switch.
      expect(resolve({ persistedEnabled: true, formEnabled: false })).toBe('pending')
    })

    it('reports pending when switched on but not yet published', () => {
      // Regression: this used to be indistinguishable from a credential error.
      expect(resolve({ persistedEnabled: false, formEnabled: true, connections: emptyMaps })).toBe(
        'pending',
      )
    })

    it('prefers pending over a stale socket reading in either direction', () => {
      expect(resolve({ persistedEnabled: true, formEnabled: false, isLoading: true })).toBe(
        'pending',
      )
    })
  })

  it('reads each channel from its own registry rather than a shared one', () => {
    const connections: ChatConnectionMaps = {
      feishu: new Map([['a1', true]]),
      slack: new Map(),
      discord: new Map(),
      qq_official: new Map(),
    }
    expect(resolve({ channel: 'slack', connections })).toBe('absent')
  })
})

describe('channelConnectionTone', () => {
  it('marks a healthy socket as success', () => {
    expect(channelConnectionTone('connected')).toBe('success')
  })

  it.each(['absent', 'reconnecting', 'error', 'pending'] as const)(
    'marks %s as warning so it is not mistaken for a switched-off channel',
    (kind) => {
      expect(channelConnectionTone(kind)).toBe('warning')
    },
  )

  it.each(['loading', 'disabled', 'not_published'] as const)('marks %s as muted', (kind) => {
    expect(channelConnectionTone(kind)).toBe('muted')
  })
})
