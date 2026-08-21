import type { GatewayAuth, GatewayChannelInfo, RunChannelContext, UserInfo } from '@a2wave/shared'
import { runChannelContextSchema } from '@a2wave/shared'
/**
 * Builders for the unified `RunChannelContext` shape.
 *
 * Every channel that triggers an Agent (OAuth/REST gateway, A2A, Feishu, schedule
 * cron, web debug) constructs its `RunChannelContext` through one of these
 * functions. Centralising the shape here keeps:
 *   - `user_info` resolution rules consistent (e.g. "no email → null + warn")
 *   - the channel-specific raw inputs out of the hot paths
 *   - the audit trail on `runSteps.input.context.channel` and the worker payload
 *     `context.channel` byte-identical
 *
 * If you're adding a new channel, add a builder here, do NOT inline the object
 * shape at the call site.
 */
import type { Context } from 'hono'
import { extractCallerAgentFromHeaders, X_A2WAVE_CHANNEL_B64_HEADER } from '../a2a/caller.js'
import type { GatewayCaller, NormalizedAuthType } from '../middleware/gateway-auth.js'
import { resolveClientIp } from './client-ip.js'
import { logger } from './logger.js'

/**
 * Server-reserved context keys a client must NEVER be able to inject — they are
 * set server-side from authenticated request state. Stripping them on every
 * public ingress endpoint prevents:
 *   - `channel` / `caller`: spoofing the audit trail / caller identity that
 *     downstream consumers trust;
 *   - `receive_id_type` / `receive_id`: weaponizing the agent's Feishu bot into a
 *     DM-to-arbitrary-target vector — finishRunSuccess / finishRunError read these
 *     to reply-by-context, so a hostile caller could push the agent's output (or
 *     the run_id fallback) to any open_id/chat_id the bot can reach.
 */
export const RESERVED_CONTEXT_KEYS = ['channel', 'caller', 'receive_id_type', 'receive_id'] as const

const INTERNAL_RESERVED_CONTEXT_KEYS = [
  '__a2wave_oauth_previous_chat_id',
  // 排队路径把附件 refs 藏在 pending-context 里带到出队处 materialize；调用方
  // 绝不能注入，且不得落进持久化的 context。
  '__attachments',
] as const

/**
 * Return a shallow copy of user-supplied context with all server-reserved keys
 * removed. Single source of truth for every ingress endpoint (gateway /
 * oauth-gateway / agents chat) so a newly-added endpoint can't silently reopen
 * the injection vector.
 */
export function stripReservedContextKeys(
  context: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  const copy = { ...(context ?? {}) }
  for (const key of [...RESERVED_CONTEXT_KEYS, ...INTERNAL_RESERVED_CONTEXT_KEYS]) {
    delete copy[key]
  }
  return copy
}

/**
 * Decode an `X-A2WAVE-Channel-B64` header (base64url JSON of a serialized
 * RunChannelContext). Sub-agent calls forward this so the downstream Agent's
 * `user_info` reflects the original upstream user, not whoever's making the
 * a2a-to-a2a HTTP request right now.
 *
 * Validates the decoded payload with the full discriminatedUnion schema, not
 * just a string check, so a forged header cannot inject fields the schema
 * forbids.
 *
 * Returns undefined on any parse/decode/validation error — caller falls back
 * to building a fresh context from the current request.
 */
export function decodeUpstreamChannelHeader(c: Context): RunChannelContext | undefined {
  const raw = c.req.header(X_A2WAVE_CHANNEL_B64_HEADER)
  if (!raw) return undefined
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = JSON.parse(json)
    const result = runChannelContextSchema.safeParse(parsed)
    if (!result.success) {
      logger.warn(
        { issues: result.error.issues.slice(0, 3) },
        'X-A2WAVE-Channel-B64 failed schema validation, ignoring',
      )
      return undefined
    }
    return result.data
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to decode X-A2WAVE-Channel-B64 header')
    return undefined
  }
}

// ── ChannelBuildResult ────────────────────────────────────────────────────────
//
// Every builder returns this tuple instead of a bare `RunChannelContext` so that
// the denormalized `runs.trigger_user_name` column can be written at insert time
// without re-running channel-specific identity logic at the call site.
//
// `displayName` is intentionally *more lax* than `ctx.user_info.name`:
//   - Feishu surfaces the user.name field even when the email-scope is missing
//     (`contact:contact:readonly` in the tenant-app namespace), so `ctx.user_info`
//     stays `null` but the list still shows the sender's name.
//   - api / a2a / oauth / debug / schedule simply mirror what their ctx already has.
export interface ChannelBuildResult {
  ctx: RunChannelContext
  /** Cross-channel display name for `runs.trigger_user_name`. `null` when no human identity available (schedule, api_key-only). */
  displayName: string | null
}

// ── Gateway: api / a2a ────────────────────────────────────────────────────────

export interface BuildGatewayChannelOpts {
  channel: 'api' | 'a2a'
  authType: NormalizedAuthType
  oauthCaller?: GatewayCaller
  callerAgent?: { agentId?: string; agentName?: string }
  /**
   * Remote A2A message assertion used only for display/audit. Unlike a trusted
   * forwarded channel, it never creates or modifies authoritative user_info.
   */
  assertedDisplayName?: string
  /**
   * Caller Agent asserted through the negotiated A2A provenance extension.
   * It remains audit-only even when this hop authenticates an OAuth user.
   */
  assertedCallerAgent?: { agentId?: string; agentName?: string }
  /**
   * Receiving agent's opt-in to trust the upstream-forwarded user identity
   * (X-A2WAVE-Channel-B64). Only meaningful on a2a hops. Combined with
   * `authType === 'api_key'` this is the trust anchor for cross-hop identity
   * propagation — see `isTrustedHop` below.
   */
  trustForwardedIdentity?: boolean
  /** Optional explicit request id; falls back to common headers when omitted. */
  requestId?: string
}

export function buildGatewayChannel(c: Context, opts: BuildGatewayChannelOpts): ChannelBuildResult {
  // Sub-agent flows: prefer the upstream's pre-built channel context (forwarded
  // via X-A2WAVE-Channel-B64) so the downstream Agent sees the original user
  // identity instead of getting blanked out at every hop.
  //
  // TRUST MODEL — the forwarded user_info crosses a real authorization boundary
  // (it becomes the identity the downstream agent runs and audits under). So
  // acceptance is gated on
  // an EXPLICIT, OWNER-CONTROLLED trust decision, not a self-asserted header:
  //   1. channel === 'a2a' (api channel has no internal hops)
  //   2. authType === 'api_key' — the caller proved possession of this agent's
  //      A2A endpoint key (a shared secret). Excludes 'none' (no secret → anyone
  //      could forge identity) and 'oauth' (an external end-user token must NOT
  //      be able to override its own user_info).
  //   3. opts.trustForwardedIdentity — the receiving agent's owner explicitly
  //      opted in to "callers holding my A2A key may assert user identity on my
  //      behalf to the gateway". Defaults false.
  // The trust anchor is therefore "possession of the A2A endpoint key + owner
  // opt-in". `caller_agent` is recorded for audit but is no longer a gate (a
  // legitimate remote-instance caller won't exist in the local registry).
  // Without all three, we ignore the header and build a fresh context from
  // the request's own credentials.
  const isTrustedHop =
    opts.channel === 'a2a' && opts.authType === 'api_key' && opts.trustForwardedIdentity === true
  const upstream = isTrustedHop ? decodeUpstreamChannelHeader(c) : undefined
  if (
    upstream &&
    (upstream.channel_type === 'api' ||
      upstream.channel_type === 'a2a' ||
      upstream.channel_type === 'feishu' ||
      upstream.channel_type === 'slack' ||
      upstream.channel_type === 'discord' ||
      upstream.channel_type === 'qq_official' ||
      upstream.channel_type === 'debug' ||
      upstream.channel_type === 'chat_app' ||
      upstream.channel_type === 'oauth' ||
      // schedule: a cron run that opted into scheduleRunAsOwner carries a
      // server-pinned real SSO identity (resolved from DB, not self-reported),
      // so it's as trustworthy as the other whitelisted channels. Preserving it
      // lets `schedule → agent1 →(A2A)→ agent2` keep the identity across the hop.
      // Still double-gated by isTrustedHop (a2a + api_key + trustForwardedIdentity).
      //
      // Defense-in-depth: a schedule identity is only legitimate when it is a
      // bound SSO user (buildScheduleChannel always pins source='idaas'). The
      // upstream context arrives via a schema-validated header, but the schema
      // permits any `source` enum value — so without this guard a forged
      // `channel_type='schedule'` header with a non-idaas source would enter the
      // forwarding context and the cross-hop audit log. Reject it here so the bad
      // identity never propagates.
      (upstream.channel_type === 'schedule' && upstream.user_info?.source === 'idaas'))
  ) {
    // Preserve upstream user identity, but the channel_type/channel_info
    // reflect the CURRENT hop (we are now an a2a request), and we layer the
    // hop's caller_agent on top so the downstream can see the immediate caller.
    // Note: `feishu_scope` is intentionally NOT copied from upstream — it
    // represents the upstream hop's visibility-scope decision, which belongs
    // to that hop's auth, not the current a2a hop (which by the isTrustedHop
    // gate is authType !== 'oauth' and has bypassed the visibility check).
    const callerAgent = opts.callerAgent
    const channelInfo: GatewayChannelInfo = { auth: opts.authType }
    // caller_agent is audit-only here; only record it when we actually have an
    // immediate-caller identity (omit the empty object otherwise).
    if (callerAgent?.agentId || callerAgent?.agentName) {
      channelInfo.caller_agent = {
        ...(callerAgent.agentId ? { agent_id: callerAgent.agentId } : {}),
        ...(callerAgent.agentName ? { agent_name: callerAgent.agentName } : {}),
      }
    }
    // If the upstream itself was a Gateway channel with oauth metadata, record
    // the upstream oauth issuer/sub so audits can trace the chain — but do NOT
    // overwrite channel_info.auth. `auth` always reflects the CURRENT hop's
    // real inbound auth method (api_key/none/oauth). Changing it to 'oauth'
    // here would imply "the OAuth user made this call directly", hiding the
    // fact that an api_key-holding intermediate agent forwarded the request.
    if (
      (upstream.channel_type === 'api' || upstream.channel_type === 'a2a') &&
      upstream.channel_info.oauth
    ) {
      channelInfo.oauth = upstream.channel_info.oauth
    }
    // Multi-hop displayName: prefer the upstream's explicit `display_name`
    // (added to the channel-context schema for exactly this case — Feishu
    // without email scope sets it even though `user_info` is null). Fall back
    // to user_info.name for older upstreams that haven't been redeployed yet.
    const upstreamDisplayName = upstream.display_name || upstream.user_info?.name || null
    return {
      ctx: {
        channel_type: 'a2a',
        channel_info: channelInfo,
        user_info: upstream.user_info,
        ...(upstreamDisplayName ? { display_name: upstreamDisplayName } : {}),
      },
      displayName: upstreamDisplayName,
    }
  }

  const auth: GatewayAuth = opts.authType
  const channelInfo: GatewayChannelInfo = { auth }

  const ip = resolveClientIp(c)
  if (ip) channelInfo.client_ip = ip

  const requestId =
    opts.requestId ?? c.req.header('X-Request-Id') ?? c.req.header('X-Request-ID') ?? undefined
  if (requestId) channelInfo.request_id = requestId

  // OAuth: pull oauth metadata + email-derived user_info.
  let userInfo: UserInfo | null = null
  // `displayName` is set even when `userInfo` stays null (api_key-only or oauth
  // without email claim) — for OAuth that means we still surface the IdP
  // username in the runs list, which is the common case the feature was built for.
  let displayName: string | null = null
  if (opts.oauthCaller && opts.oauthCaller.kind === 'idaas_user') {
    const u = opts.oauthCaller.userInfo
    channelInfo.auth = 'oauth'
    channelInfo.oauth = {
      issuer: u.issuer,
      sub: u.sub,
      ...(u.tenantId ? { tenant_id: u.tenantId } : {}),
      ...(u.unionId ? { union_id: u.unionId } : {}),
    }
    if (u.email) {
      userInfo = {
        email: u.email,
        ...(u.username ? { name: u.username } : {}),
        ...(u.mobile ? { mobile: u.mobile } : {}),
        source: 'idaas',
        ...(u.sub ? { source_id: u.sub } : {}),
      }
    } else {
      logger.warn(
        { sub: u.sub, issuer: u.issuer },
        'OAuth user has no email claim — user_info will be null',
      )
    }
    displayName = u.username || null
  } else if (opts.channel === 'a2a' && opts.assertedDisplayName) {
    displayName = opts.assertedDisplayName
  }
  // caller_agent is audit provenance on A2A hops, never an authorization input.
  if (opts.channel === 'a2a') {
    // Private caller headers are accepted only without OAuth. The standards
    // extension is separate: it is explicitly marked as an assertion and may
    // coexist with an independently authenticated OAuth user for display.
    const effectiveCallerAgent =
      opts.assertedCallerAgent ?? (!opts.oauthCaller ? opts.callerAgent : undefined)
    if (effectiveCallerAgent) {
      channelInfo.caller_agent = {
        ...(effectiveCallerAgent.agentId ? { agent_id: effectiveCallerAgent.agentId } : {}),
        ...(effectiveCallerAgent.agentName ? { agent_name: effectiveCallerAgent.agentName } : {}),
      }
    }
  }

  return {
    ctx: {
      channel_type: opts.channel,
      channel_info: channelInfo,
      user_info: userInfo,
      ...(displayName ? { display_name: displayName } : {}),
    },
    displayName,
  }
}

// ── OAuth (independent channel) ───────────────────────────────────────────────

export interface BuildOAuthChannelOpts {
  oauthCaller: GatewayCaller
  requestId?: string
}

export function buildOAuthChannel(c: Context, opts: BuildOAuthChannelOpts): ChannelBuildResult {
  const channelInfo: GatewayChannelInfo = { auth: 'oauth' }

  const ip = resolveClientIp(c)
  if (ip) channelInfo.client_ip = ip

  const requestId =
    opts.requestId ?? c.req.header('X-Request-Id') ?? c.req.header('X-Request-ID') ?? undefined
  if (requestId) channelInfo.request_id = requestId

  let userInfo: UserInfo | null = null
  let displayName: string | null = null
  if (opts.oauthCaller.kind === 'idaas_user') {
    const u = opts.oauthCaller.userInfo
    channelInfo.oauth = {
      issuer: u.issuer,
      sub: u.sub,
      ...(u.tenantId ? { tenant_id: u.tenantId } : {}),
      ...(u.unionId ? { union_id: u.unionId } : {}),
    }
    if (u.email) {
      userInfo = {
        email: u.email,
        ...(u.username ? { name: u.username } : {}),
        ...(u.mobile ? { mobile: u.mobile } : {}),
        source: 'idaas',
        ...(u.sub ? { source_id: u.sub } : {}),
      }
    } else {
      logger.warn(
        { sub: u.sub, issuer: u.issuer },
        'OAuth channel user has no email claim — user_info will be null',
      )
    }
    displayName = u.username || null
  }
  return {
    ctx: {
      channel_type: 'oauth',
      channel_info: channelInfo,
      user_info: userInfo,
      ...(displayName ? { display_name: displayName } : {}),
    },
    displayName,
  }
}

// ── Feishu ────────────────────────────────────────────────────────────────────

export interface BuildFeishuChannelOpts {
  appId: string
  sender: {
    sender_type?: string
    sender_id?: { open_id?: string; union_id?: string; user_id?: string }
  }
  message: {
    message_id: string
    chat_id: string
    chat_type: string
    thread_id?: string
  }
  fetchedUserInfo: {
    name?: string
    en_name?: string
    email?: string
    open_id?: string
    user_id?: string
    union_id?: string
  } | null
}

export function buildFeishuChannel(opts: BuildFeishuChannelOpts): ChannelBuildResult {
  const senderOpenId = opts.sender.sender_id?.open_id ?? ''
  const senderUnionId = opts.sender.sender_id?.union_id
  const senderUserId = opts.sender.sender_id?.user_id

  const channel_info = {
    app_id: opts.appId,
    chat_id: opts.message.chat_id,
    chat_type: opts.message.chat_type,
    message_id: opts.message.message_id,
    ...(opts.message.thread_id ? { thread_id: opts.message.thread_id } : {}),
    sender_type: opts.sender.sender_type ?? 'user',
    // Drop sender_open_id entirely when empty (some bot/system events lack it);
    // schema enforces .min(1).optional() so '' would fail validation.
    ...(senderOpenId ? { sender_open_id: senderOpenId } : {}),
    ...(senderUnionId ? { sender_union_id: senderUnionId } : {}),
    ...(senderUserId ? { sender_user_id: senderUserId } : {}),
  }

  let user_info: UserInfo | null = null
  const email = opts.fetchedUserInfo?.email
  if (email) {
    const name = opts.fetchedUserInfo?.name || opts.fetchedUserInfo?.en_name
    user_info = {
      email,
      ...(name ? { name } : {}),
      source: 'feishu',
      ...(senderOpenId ? { source_id: senderOpenId } : {}),
    }
  } else if (opts.fetchedUserInfo) {
    // We *did* fetch user info but it lacked email — typically a permission
    // misconfig: the Feishu app has the base scope `contact:contact.base:readonly`
    // (so the API call succeeds) but is missing the field-level scope
    // `contact:user.email:readonly` that gates returning the email field.
    // Both scope namespaces apply to tenant_access_token; contact:user.* is
    // *not* OAuth-only.
    logger.warn(
      { open_id: senderOpenId, app_id: opts.appId },
      'Feishu user has no email — user_info will be null (check contact:user.email:readonly field-level scope on the tenant app)',
    )
  }
  // If fetchedUserInfo is null altogether (fetchUserInfo disabled or API failed)
  // we silently leave user_info null; the channel_info still carries open_id so
  // the agent can resolve identity itself if it wants.

  // displayName surfaces the Feishu user.name *independently of email* so the
  // runs list shows "@飞书用户名 · 飞书" even when the bot lacks email scope.
  // It's mirrored onto ctx.display_name so downstream a2a hops can preserve
  // it even when user_info had to be nulled out.
  const displayName = opts.fetchedUserInfo?.name || opts.fetchedUserInfo?.en_name || null

  return {
    ctx: {
      channel_type: 'feishu',
      channel_info,
      user_info,
      ...(displayName ? { display_name: displayName } : {}),
    },
    displayName,
  }
}

// ── Slack ─────────────────────────────────────────────────────────────────────

export interface BuildSlackChannelOpts {
  appId: string
  teamId: string
  channelId: string
  messageTs: string
  threadTs?: string
  senderUserId: string
  senderName?: string
  chatType: 'p2p' | 'channel'
}

export function buildSlackChannel(opts: BuildSlackChannelOpts): ChannelBuildResult {
  const displayName = opts.senderName?.trim() || null
  return {
    ctx: {
      channel_type: 'slack',
      channel_info: {
        app_id: opts.appId,
        team_id: opts.teamId,
        channel_id: opts.channelId,
        chat_type: opts.chatType,
        message_ts: opts.messageTs,
        ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
        sender_user_id: opts.senderUserId,
      },
      // Native chat profile data is audit-only until an explicit identity binding exists.
      user_info: null,
      ...(displayName ? { display_name: displayName } : {}),
    },
    displayName,
  }
}

// ── Discord ───────────────────────────────────────────────────────────────────

export interface BuildDiscordChannelOpts {
  applicationId: string
  guildId?: string
  channelId: string
  messageId: string
  threadId?: string
  senderUserId: string
  senderName?: string
  chatType: 'dm' | 'guild'
}

export function buildDiscordChannel(opts: BuildDiscordChannelOpts): ChannelBuildResult {
  const displayName = opts.senderName?.trim() || null
  return {
    ctx: {
      channel_type: 'discord',
      channel_info: {
        application_id: opts.applicationId,
        ...(opts.guildId ? { guild_id: opts.guildId } : {}),
        channel_id: opts.channelId,
        chat_type: opts.chatType,
        message_id: opts.messageId,
        ...(opts.threadId ? { thread_id: opts.threadId } : {}),
        sender_user_id: opts.senderUserId,
      },
      user_info: null,
      ...(displayName ? { display_name: displayName } : {}),
    },
    displayName,
  }
}

// ── QQ Official ──────────────────────────────────────────────────────────────

export type BuildQQOfficialChannelOpts = {
  appId: string
  messageId: string
  senderOpenId: string
  senderName?: string
} & ({ scene: 'group'; groupOpenId: string } | { scene: 'c2c' })

export function buildQQOfficialChannel(opts: BuildQQOfficialChannelOpts): ChannelBuildResult {
  const displayName = opts.senderName?.trim() || null
  const common = {
    app_id: opts.appId,
    message_id: opts.messageId,
    sender_open_id: opts.senderOpenId,
  }
  const channelInfo =
    opts.scene === 'group'
      ? {
          ...common,
          scene: opts.scene,
          group_open_id: opts.groupOpenId,
          member_openid: opts.senderOpenId,
          ...(displayName ? { username: displayName } : {}),
        }
      : { ...common, scene: opts.scene }
  return {
    ctx: {
      channel_type: 'qq_official',
      channel_info: channelInfo,
      user_info: null,
      ...(displayName ? { display_name: displayName } : {}),
    },
    displayName,
  }
}

// ── Schedule ──────────────────────────────────────────────────────────────────

export interface BuildScheduleChannelOpts {
  scheduleId?: string
  cron?: string
  /**
   * Authorized run-as identity for an agent that opted into scheduleRunAsOwner.
   * Resolved server-side from the agent owner's bound SSO profile at trigger time.
   * Omitted / null → anonymous schedule (user_info stays null, gateway access still rejected).
   */
  user?: { email: string; name?: string; sourceId?: string } | null
}

export function buildScheduleChannel(opts: BuildScheduleChannelOpts): ChannelBuildResult {
  let user_info: UserInfo | null = null
  let displayName: string | null = null
  if (opts.user?.email) {
    user_info = {
      email: opts.user.email,
      ...(opts.user.name ? { name: opts.user.name } : {}),
      source: 'idaas',
      ...(opts.user.sourceId ? { source_id: opts.user.sourceId } : {}),
    }
    displayName = opts.user.name ?? null
  }
  return {
    ctx: {
      channel_type: 'schedule',
      channel_info: {
        ...(opts.scheduleId ? { schedule_id: opts.scheduleId } : {}),
        ...(opts.cron ? { cron: opts.cron } : {}),
      },
      user_info,
      ...(displayName ? { display_name: displayName } : {}),
    },
    displayName,
  }
}

// ── Git repository trigger (glab / gh) ────────────────────────────────────────

export interface BuildGitTriggerChannelOpts {
  provider: 'glab' | 'gh'
  event: string
  project: string
  host?: string
  number: number
  url?: string
  sha?: string
  /**
   * Request author as reported by the forge. Carried as `display_name` only —
   * never promoted to `user_info`, which requires a verified a2wave/IDaaS
   * identity. A forge username is an unrelated namespace: treating it as an
   * identity would let a repository's commit metadata name any user it liked.
   */
  authorName?: string | null
}

export function buildGitTriggerChannel(opts: BuildGitTriggerChannelOpts): ChannelBuildResult {
  const displayName = opts.authorName?.trim() || null
  return {
    ctx: {
      channel_type: opts.provider,
      channel_info: {
        provider: opts.provider,
        event: opts.event,
        project: opts.project,
        ...(opts.host ? { host: opts.host } : {}),
        number: opts.number,
        ...(opts.url ? { url: opts.url } : {}),
        ...(opts.sha ? { sha: opts.sha } : {}),
      },
      user_info: null,
      ...(displayName ? { display_name: displayName } : {}),
    },
    displayName,
  }
}

// ── Debug (web debug entry) ───────────────────────────────────────────────────

export interface BuildDebugChannelOpts {
  triggeredByUserId: string
  userEmail?: string
  userName?: string
}

export function buildDebugChannel(opts: BuildDebugChannelOpts): ChannelBuildResult {
  const channel_info = { triggered_by_user_id: opts.triggeredByUserId }

  let user_info: UserInfo | null = null
  if (opts.userEmail) {
    user_info = {
      email: opts.userEmail,
      ...(opts.userName ? { name: opts.userName } : {}),
      source: 'a2wave',
      source_id: opts.triggeredByUserId,
    }
  } else {
    logger.warn(
      { triggeredByUserId: opts.triggeredByUserId },
      'Debug user has no email — user_info will be null',
    )
  }

  const displayName = opts.userName || null
  return {
    ctx: {
      channel_type: 'debug',
      channel_info,
      user_info,
      ...(displayName ? { display_name: displayName } : {}),
    },
    displayName,
  }
}

// ── Chat app (shareable chat web page) ────────────────────────────────────────

export type BuildChatAppChannelOpts = BuildDebugChannelOpts

/**
 * The chat app page authenticates against the platform session, so the identity
 * resolution is identical to debug — only the channel_type differs, keeping
 * chat-app traffic separable from in-product test conversations.
 */
export function buildChatAppChannel(opts: BuildChatAppChannelOpts): ChannelBuildResult {
  const { ctx, displayName } = buildDebugChannel(opts)
  // Rebuild rather than spread: `ctx` is typed as the full discriminated union, so
  // overriding channel_type on a spread leaves channel_info unnarrowed.
  return {
    ctx: {
      channel_type: 'chat_app',
      channel_info: { triggered_by_user_id: opts.triggeredByUserId },
      user_info: ctx.user_info,
      ...(displayName ? { display_name: displayName } : {}),
    },
    displayName,
  }
}

/**
 * Encode a RunChannelContext into a base64url string suitable for the
 * X-A2WAVE-Channel-B64 header (sub-agent transport).
 */
export function encodeChannelContextHeader(ctx: RunChannelContext): string {
  return Buffer.from(JSON.stringify(ctx), 'utf8').toString('base64url')
}
