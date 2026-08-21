/**
 * Live connection state for the native chat channels, resolved for the publish
 * grid's channel cards.
 *
 * Generalises the old Feishu-only `resolveFeishuWsUi`: Slack and Discord hold a
 * long-lived socket exactly like Feishu does, so the card should say so for all
 * three rather than singling Feishu out. Channels that are plain inbound HTTP
 * (`api`, `oauth`, `a2a`, `chat_app`) and the scheduler hold no connection at
 * all and resolve to `null` — a card with no socket must not claim a status.
 */
import type { ChannelKey } from '@/pages/agent-detail/publish/channel-registry'

/** Channels this module knows how to report a connection for. */
export type ConnectedChannelKey = 'feishu' | 'slack' | 'discord' | 'qq_official'

export type ChannelConnectionUiKind =
  | 'loading'
  | 'error'
  | 'pending'
  | 'disabled'
  | 'not_published'
  | 'absent'
  | 'reconnecting'
  | 'connected'

/**
 * How a channel reaches a2wave. All three chat channels are long-lived sockets
 * today, but each speaks a different protocol, and operators debug them with
 * different tools — so the card names the protocol instead of a generic
 * "connected". `kind` is what varies the presentation; when a future channel
 * arrives over inbound HTTP it gets `kind: 'webhook'` and no socket status.
 */
export interface ChannelTransport {
  kind: 'socket'
  /** i18n key naming the protocol, e.g. "WebSocket" / "Socket Mode". */
  labelKey: string
  /** i18n key for the one-line explanation shown in the status tooltip. */
  hintKey: string
}

export const CHANNEL_TRANSPORTS: Record<ConnectedChannelKey, ChannelTransport> = {
  feishu: {
    kind: 'socket',
    labelKey: 'agentPublish.transportFeishuWs',
    hintKey: 'agentPublish.transportFeishuWsHint',
  },
  slack: {
    kind: 'socket',
    labelKey: 'agentPublish.transportSlackSocketMode',
    hintKey: 'agentPublish.transportSlackSocketModeHint',
  },
  discord: {
    kind: 'socket',
    labelKey: 'agentPublish.transportDiscordGateway',
    hintKey: 'agentPublish.transportDiscordGatewayHint',
  },
  qq_official: {
    kind: 'socket',
    labelKey: 'agentPublish.transportQQOfficialGateway',
    hintKey: 'agentPublish.transportQQOfficialGatewayHint',
  },
}

/**
 * Accepts a bare `string` as well as a `ChannelKey`: `agent.publishChannels` is
 * typed `string[]`, and requiring a cast at every call site would just move the
 * narrowing this guard exists to perform.
 */
export function isConnectedChannel(channel: string): channel is ConnectedChannelKey {
  return (
    channel === 'feishu' ||
    channel === 'slack' ||
    channel === 'discord' ||
    channel === 'qq_official'
  )
}

/** Per-channel `agentId -> socketOpen` registries of the current API instance. */
export type ChatConnectionMaps = Record<ConnectedChannelKey, Map<string, boolean>>

/**
 * Resolve what a channel card should show.
 *
 * The pill always reports the **live socket**, never the form. Two state
 * sources feed in and they mean different things:
 *
 * - `persistedEnabled` (from `agent.publishChannels`) is what the server acted
 *   on, so it alone decides whether a connection should exist right now.
 * - `formEnabled` (the card's switch) is the operator's *unsaved intent*. When
 *   the two disagree the change has not been published yet, so the pill says
 *   `pending` rather than reporting a socket state that contradicts the switch
 *   sitting directly above it.
 *
 * Returning `null` for a channel that was never configured keeps a fresh draft
 * Agent from advertising three "not connected" pills for channels nobody set up.
 */
export function resolveChannelConnectionUi(params: {
  channel: ChannelKey
  /** Whether the channel is enabled in the persisted `publishChannels`. */
  persistedEnabled: boolean
  /** Whether the card's switch is currently on (may be unsaved). */
  formEnabled: boolean
  /** Whether the channel has saved credentials — an unconfigured card shows nothing. */
  configured: boolean
  publishStatus?: string | null
  agentId: string
  connections: ChatConnectionMaps | undefined
  isLoading: boolean
  /** A connection query failed; the true socket state is unknown. */
  isError?: boolean
}): ChannelConnectionUiKind | null {
  const {
    channel,
    persistedEnabled,
    formEnabled,
    configured,
    publishStatus,
    agentId,
    connections,
    isLoading,
    isError,
  } = params
  if (!isConnectedChannel(channel)) return null
  // Never configured and never enabled — there is no connection to report on.
  if (!configured && !persistedEnabled && !formEnabled) return null
  // An unsaved toggle in either direction: the socket has not been touched yet.
  if (formEnabled !== persistedEnabled) return 'pending'
  if (!persistedEnabled) return 'disabled'
  if (isLoading) return 'loading'
  // Distinct from `loading`: a failed query means we cannot know, and saying
  // "checking…" forever would hide a down socket behind a permanent spinner.
  if (isError || connections === undefined) return 'error'
  if (publishStatus !== 'published') return 'not_published'

  const byId = connections[channel]
  if (!byId.has(agentId)) return 'absent'
  if (!byId.get(agentId)) return 'reconnecting'
  return 'connected'
}

/** i18n key for the short status label rendered on the card. */
export function channelConnectionLabelKey(kind: ChannelConnectionUiKind): string {
  return {
    loading: 'agentPublish.connLoading',
    error: 'agentPublish.connError',
    pending: 'agentPublish.connPending',
    disabled: 'agentPublish.connDisabled',
    not_published: 'agentPublish.connNotPublished',
    absent: 'agentPublish.connAbsent',
    reconnecting: 'agentPublish.connReconnecting',
    connected: 'agentPublish.connConnected',
  }[kind]
}

/** Semantic tone driving the dot / text colour of the status pill. */
export type ChannelConnectionTone = 'success' | 'warning' | 'muted'

export function channelConnectionTone(kind: ChannelConnectionUiKind): ChannelConnectionTone {
  if (kind === 'connected') return 'success'
  // `error` is amber, not muted: an unknown socket state is a thing to act on,
  // and greying it out would read as "nothing to see here".
  if (kind === 'absent' || kind === 'reconnecting' || kind === 'error' || kind === 'pending') {
    return 'warning'
  }
  return 'muted'
}
