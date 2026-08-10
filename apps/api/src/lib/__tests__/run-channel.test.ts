import { runChannelContextSchema } from '@a2wave/shared'
import type { Context } from 'hono'
/**
 * Unit tests for the 4 RunChannelContext builders.
 *
 * Focus: each builder produces a shape that satisfies `runChannelContextSchema`,
 * the email-required-when-present rule holds, and security-sensitive paths
 * (anti-spoof on OAuth, upstream channel forward) behave correctly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub gateway-auth so jose isn't pulled in; only normalizeAuthType is read here.
vi.mock('../../middleware/gateway-auth.js', () => ({
  normalizeAuthType: (v: string | null | undefined) =>
    v === 'none' || v === 'oauth' ? v : 'api_key',
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { X_A2WAVE_CHANNEL_B64_HEADER } from '../../a2a/caller.js'
import type { GatewayCaller } from '../../middleware/gateway-auth.js'
import { logger } from '../logger.js'
import {
  RESERVED_CONTEXT_KEYS,
  buildChatAppChannel as _buildChatAppChannelRaw,
  buildDebugChannel as _buildDebugChannelRaw,
  buildDiscordChannel as _buildDiscordChannelRaw,
  buildFeishuChannel as _buildFeishuChannelRaw,
  buildGatewayChannel as _buildGatewayChannelRaw,
  buildScheduleChannel as _buildScheduleChannelRaw,
  buildSlackChannel as _buildSlackChannelRaw,
  decodeUpstreamChannelHeader,
  encodeChannelContextHeader,
  stripReservedContextKeys,
} from '../run-channel.js'

// Test sugar: builders now return `{ ctx, displayName }`. Legacy tests want the
// bare `ctx`. Wrappers below preserve original call sites; tests that care
// about `displayName` use the `_Raw` exports directly.
const buildGatewayChannel: (
  ...a: Parameters<typeof _buildGatewayChannelRaw>
) => ReturnType<typeof _buildGatewayChannelRaw>['ctx'] = (...a) => _buildGatewayChannelRaw(...a).ctx
const buildFeishuChannel: (
  ...a: Parameters<typeof _buildFeishuChannelRaw>
) => ReturnType<typeof _buildFeishuChannelRaw>['ctx'] = (...a) => _buildFeishuChannelRaw(...a).ctx
const buildScheduleChannel: (
  ...a: Parameters<typeof _buildScheduleChannelRaw>
) => ReturnType<typeof _buildScheduleChannelRaw>['ctx'] = (...a) =>
  _buildScheduleChannelRaw(...a).ctx
const buildDebugChannel: (
  ...a: Parameters<typeof _buildDebugChannelRaw>
) => ReturnType<typeof _buildDebugChannelRaw>['ctx'] = (...a) => _buildDebugChannelRaw(...a).ctx
const buildChatAppChannel: (
  ...a: Parameters<typeof _buildChatAppChannelRaw>
) => ReturnType<typeof _buildChatAppChannelRaw>['ctx'] = (...a) => _buildChatAppChannelRaw(...a).ctx
const buildSlackChannel: (
  ...a: Parameters<typeof _buildSlackChannelRaw>
) => ReturnType<typeof _buildSlackChannelRaw>['ctx'] = (...a) => _buildSlackChannelRaw(...a).ctx
const buildDiscordChannel: (
  ...a: Parameters<typeof _buildDiscordChannelRaw>
) => ReturnType<typeof _buildDiscordChannelRaw>['ctx'] = (...a) => _buildDiscordChannelRaw(...a).ctx

function makeCtx(headers: Record<string, string> = {}, remoteAddress?: string): Context {
  return {
    req: {
      header: (name: string) =>
        headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()],
    },
    env: remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined,
  } as unknown as Context
}

function makeOauthCaller(overrides: Partial<GatewayCaller['userInfo']> = {}): GatewayCaller {
  return {
    kind: 'idaas_user',
    userInfo: {
      sub: 'sub-1',
      issuer: 'https://idp.example.com/',
      userId: 'uuid-1',
      email: 'alice@example.com',
      username: 'alice',
      mobile: '13800000000',
      tenantId: 't-1',
      unionId: 'u-1',
      raw: {},
      ...overrides,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('native chat channel builders', () => {
  it('builds a Slack channel without promoting profile data to trusted user_info', () => {
    const ctx = buildSlackChannel({
      appId: 'A123',
      teamId: 'T123',
      channelId: 'C123',
      messageTs: '1710000000.000001',
      threadTs: '1710000000.000000',
      senderUserId: 'U123',
      senderName: 'Alice',
      chatType: 'channel',
    })

    expect(runChannelContextSchema.parse(ctx)).toEqual(ctx)
    expect(ctx).toMatchObject({
      channel_type: 'slack',
      user_info: null,
      display_name: 'Alice',
      channel_info: { team_id: 'T123', thread_ts: '1710000000.000000' },
    })
  })

  it('builds a Discord DM channel with optional guild fields omitted', () => {
    const ctx = buildDiscordChannel({
      applicationId: '123',
      channelId: '456',
      messageId: '789',
      senderUserId: '101',
      senderName: 'Bob',
      chatType: 'dm',
    })

    expect(runChannelContextSchema.parse(ctx)).toEqual(ctx)
    expect(ctx).toMatchObject({
      channel_type: 'discord',
      user_info: null,
      display_name: 'Bob',
      channel_info: { application_id: '123', channel_id: '456' },
    })
    if (ctx.channel_type === 'discord') expect(ctx.channel_info.guild_id).toBeUndefined()
  })
})

// ── buildGatewayChannel ─────────────────────────────────────────────────────

describe('buildGatewayChannel', () => {
  it('api channel without oauth → user_info=null + auth from authType', () => {
    const ctx = buildGatewayChannel(makeCtx({}, '10.0.0.1'), {
      channel: 'api',
      authType: 'api_key',
    })
    runChannelContextSchema.parse(ctx)
    expect(ctx.channel_type).toBe('api')
    expect(ctx.user_info).toBeNull()
    if (ctx.channel_type === 'api') {
      expect(ctx.channel_info.auth).toBe('api_key')
      expect(ctx.channel_info.client_ip).toBe('10.0.0.1')
    }
  })

  it('api channel with oauth → user_info populated + oauth metadata', () => {
    const ctx = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    runChannelContextSchema.parse(ctx)
    expect(ctx.user_info).toMatchObject({
      email: 'alice@example.com',
      name: 'alice',
      mobile: '13800000000',
      source: 'idaas',
      source_id: 'sub-1',
    })
    if (ctx.channel_type === 'api') {
      expect(ctx.channel_info.auth).toBe('oauth')
      expect(ctx.channel_info.oauth).toMatchObject({
        issuer: 'https://idp.example.com/',
        sub: 'sub-1',
        tenant_id: 't-1',
        union_id: 'u-1',
      })
    }
  })

  /**
   * `feishu_scope` was written only by the retired Feishu visibility access mode. The schema
   * field survives so historical runs stay readable, but nothing populates it any more — this
   * pins that, so a regression that starts writing it again is visible.
   */
  it('oauth → channel_info.feishu_scope is never populated', () => {
    const ctx = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    if (ctx.channel_type === 'api') {
      expect(ctx.channel_info.feishu_scope).toBeUndefined()
    }
  })

  it('oauth without email → user_info=null + WARN', () => {
    const ctx = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller({ email: undefined }),
    })
    runChannelContextSchema.parse(ctx)
    expect(ctx.user_info).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'sub-1' }),
      expect.stringContaining('no email'),
    )
  })

  it('a2a + non-oauth + caller_agent header → caller_agent recorded', () => {
    const ctx = buildGatewayChannel(makeCtx(), {
      channel: 'a2a',
      authType: 'api_key',
      callerAgent: { agentId: 'agt_router', agentName: 'Router' },
    })
    runChannelContextSchema.parse(ctx)
    if (ctx.channel_type === 'a2a') {
      expect(ctx.channel_info.caller_agent).toEqual({
        agent_id: 'agt_router',
        agent_name: 'Router',
      })
    }
  })

  it('keeps remote A2A display provenance schema-valid and audit-only', () => {
    const result = _buildGatewayChannelRaw(makeCtx(), {
      channel: 'a2a',
      authType: 'api_key',
      callerAgent: { agentId: 'agt_foreign', agentName: 'Remote Router' },
      assertedDisplayName: '张鑫',
    })

    expect(() => runChannelContextSchema.parse(result.ctx)).not.toThrow()
    expect(result).toMatchObject({
      displayName: '张鑫',
      ctx: {
        channel_type: 'a2a',
        user_info: null,
        display_name: '张鑫',
        channel_info: {
          caller_agent: { agent_id: 'agt_foreign', agent_name: 'Remote Router' },
        },
      },
    })
  })

  it('a2a + OAuth + caller_agent header → caller_agent DROPPED (anti-spoof)', () => {
    const ctx = buildGatewayChannel(makeCtx(), {
      channel: 'a2a',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
      // Even though attacker provides caller_agent header, it must not stick:
      callerAgent: { agentId: 'agt_admin', agentName: 'Admin' },
    })
    runChannelContextSchema.parse(ctx)
    if (ctx.channel_type === 'a2a') {
      expect(ctx.channel_info.caller_agent).toBeUndefined()
    }
    // user_info still wins
    expect(ctx.user_info?.email).toBe('alice@example.com')
  })

  it('keeps extension-asserted caller Agent as audit provenance on an OAuth A2A hop', () => {
    const result = _buildGatewayChannelRaw(makeCtx(), {
      channel: 'a2a',
      authType: 'oauth',
      oauthCaller: makeOauthCaller({ username: 'Authenticated Alice' }),
      assertedDisplayName: 'Spoofed Alice',
      assertedCallerAgent: { agentId: 'agt_remote', agentName: 'Remote Router' },
    })

    expect(() => runChannelContextSchema.parse(result.ctx)).not.toThrow()
    expect(result).toMatchObject({
      displayName: 'Authenticated Alice',
      ctx: {
        display_name: 'Authenticated Alice',
        user_info: { name: 'Authenticated Alice', source: 'idaas' },
        channel_info: {
          auth: 'oauth',
          caller_agent: { agent_id: 'agt_remote', agent_name: 'Remote Router' },
        },
      },
    })
  })

  it('forwards upstream channel header (sub-agent hop) and overlays current caller_agent', () => {
    const upstream = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    const headerVal = encodeChannelContextHeader(upstream)
    const ctx = buildGatewayChannel(makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: headerVal }), {
      channel: 'a2a',
      authType: 'api_key',
      trustForwardedIdentity: true,
      callerAgent: { agentId: 'agt_hop', agentName: 'Hop' },
    })
    runChannelContextSchema.parse(ctx)
    // Identity preserved from upstream:
    expect(ctx.user_info?.email).toBe('alice@example.com')
    if (ctx.channel_type === 'a2a' || ctx.channel_type === 'api') {
      // Hop's caller_agent overlay only on a2a:
      if (ctx.channel_type === 'a2a') {
        expect(ctx.channel_info.caller_agent).toEqual({ agent_id: 'agt_hop', agent_name: 'Hop' })
      }
      // auth reflects THIS hop's real inbound auth (api_key), NOT the upstream's.
      // The upstream OAuth identity is preserved in oauth/user_info for traceability.
      expect(ctx.channel_info.auth).toBe('api_key')
      if (ctx.channel_type === 'a2a') {
        expect(ctx.channel_info.oauth?.sub).toBe('sub-1')
      }
    }
  })

  it('preserves a schedule upstream identity across a trusted a2a hop', () => {
    // schedule → agent1 →(A2A trusted hop)→ agent2: the server-pinned SSO identity
    // must survive so agent2 can still sign a gateway token.
    const upstream = _buildScheduleChannelRaw({
      scheduleId: 'agt_1',
      cron: '0 9 * * *',
      user: { email: 'sched@example.com', name: 'Sched', sourceId: 'sub_sched' },
    }).ctx
    const headerVal = encodeChannelContextHeader(upstream)
    const ctx = buildGatewayChannel(makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: headerVal }), {
      channel: 'a2a',
      authType: 'api_key',
      trustForwardedIdentity: true,
      callerAgent: { agentId: 'agt_1', agentName: 'Agent1' },
    })
    runChannelContextSchema.parse(ctx)
    expect(ctx.user_info?.email).toBe('sched@example.com')
    expect(ctx.channel_type).toBe('a2a') // current hop type, identity carried over
  })

  it('preserves a chat_app upstream identity across a trusted a2a hop', () => {
    // chat page → agent1 →(A2A trusted hop)→ agent2. Without chat_app on the
    // whitelist the identity was dropped and agent2's gateway calls failed with
    // GATEWAY_NO_USER_IDENTITY, while the identical debug-originated flow worked.
    const upstream = _buildChatAppChannelRaw({
      triggeredByUserId: 'usr_7',
      userEmail: 'alice@example.com',
      userName: 'Alice',
    }).ctx
    const headerVal = encodeChannelContextHeader(upstream)
    const ctx = buildGatewayChannel(makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: headerVal }), {
      channel: 'a2a',
      authType: 'api_key',
      trustForwardedIdentity: true,
      callerAgent: { agentId: 'agt_1', agentName: 'Agent1' },
    })
    runChannelContextSchema.parse(ctx)
    expect(ctx.user_info?.email).toBe('alice@example.com')
    expect(ctx.channel_type).toBe('a2a')
  })

  it('does NOT preserve a chat_app upstream identity on an untrusted hop', () => {
    const upstream = _buildChatAppChannelRaw({
      triggeredByUserId: 'usr_7',
      userEmail: 'alice@example.com',
    }).ctx
    const headerVal = encodeChannelContextHeader(upstream)
    const ctx = buildGatewayChannel(makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: headerVal }), {
      channel: 'a2a',
      authType: 'api_key',
    })
    expect(ctx.user_info).toBeNull()
  })

  it('does NOT preserve a schedule upstream identity on an untrusted hop', () => {
    const upstream = _buildScheduleChannelRaw({
      scheduleId: 'agt_1',
      cron: '0 9 * * *',
      user: { email: 'sched@example.com', sourceId: 'sub_sched' },
    }).ctx
    const headerVal = encodeChannelContextHeader(upstream)
    // trustForwardedIdentity not set → upstream identity must be dropped
    const ctx = buildGatewayChannel(makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: headerVal }), {
      channel: 'a2a',
      authType: 'api_key',
    })
    expect(ctx.user_info).toBeNull()
  })

  it('SECURITY: a forged schedule upstream with a non-idaas source is NOT preserved', () => {
    // A schedule identity is only legitimate when source==='idaas' (server-pinned
    // from the owner's bound SSO profile). A forged X-A2WAVE-Channel-B64 header
    // claiming channel_type='schedule' but source='feishu' passes schema validation,
    // so the identity layer must reject it here — mirroring the jwt-signer invariant —
    // instead of letting the spoofed identity enter the forwarding context / audit log.
    const forged = {
      channel_type: 'schedule' as const,
      channel_info: { schedule_id: 'agt_1', cron: '0 9 * * *' },
      user_info: {
        email: 'attacker@evil.com',
        name: 'Eve',
        source: 'feishu' as const,
        source_id: 'forged',
      },
    }
    runChannelContextSchema.parse(forged) // confirms the schema *does* accept it
    const headerVal = encodeChannelContextHeader(forged)
    const ctx = buildGatewayChannel(makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: headerVal }), {
      channel: 'a2a',
      authType: 'api_key',
      trustForwardedIdentity: true,
    })
    // Spoofed identity dropped → fresh context built from the current hop's creds.
    expect(ctx.user_info).toBeNull()
  })

  it('captures X-Request-Id when present', () => {
    const ctx = buildGatewayChannel(makeCtx({ 'X-Request-Id': 'req-123' }), {
      channel: 'api',
      authType: 'none',
    })
    if (ctx.channel_type === 'api') {
      expect(ctx.channel_info.request_id).toBe('req-123')
    }
  })

  // ── SECURITY: anti-spoof on upstream channel header ───────────────────

  it('SECURITY: OAuth caller forging X-A2WAVE-Channel-B64 cannot override their own user_info', () => {
    // Attacker has a valid OAuth JWT (sub-eve) but tries to inject a forged
    // upstream channel claiming to be alice@example.com.
    const forged = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(), // alice
    })
    const forgedB64 = encodeChannelContextHeader(forged)

    const realCaller = makeOauthCaller({
      sub: 'sub-eve',
      email: 'eve@attacker.com',
      username: 'eve',
      userId: 'eve-uuid',
    })
    const ctx = buildGatewayChannel(makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: forgedB64 }), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: realCaller,
    })
    // Identity must be the REAL OAuth caller (eve), not the forged alice:
    expect(ctx.user_info?.email).toBe('eve@attacker.com')
    expect(ctx.user_info?.source_id).toBe('sub-eve')
  })

  it('SECURITY: api channel ignores upstream header even with api_key + opt-in (only a2a hops are trusted)', () => {
    const upstream = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    const ctx = buildGatewayChannel(
      makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: encodeChannelContextHeader(upstream) }),
      { channel: 'api', authType: 'api_key', trustForwardedIdentity: true },
    )
    expect(ctx.user_info).toBeNull() // upstream rejected because not a2a hop
    expect(ctx.channel_type).toBe('api')
  })

  it('SECURITY: a2a hop WITHOUT trustForwardedIdentity opt-in → upstream rejected', () => {
    // The receiving agent did not opt in, so even a valid api_key + caller_agent
    // hop must not inherit the upstream user identity.
    const upstream = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    const ctx = buildGatewayChannel(
      makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: encodeChannelContextHeader(upstream) }),
      {
        channel: 'a2a',
        authType: 'api_key',
        callerAgent: { agentId: 'agt_hop' } /* but no trustForwardedIdentity */,
      },
    )
    expect(ctx.user_info).toBeNull()
  })

  it('SECURITY: a2a hop with authType=none is rejected even with opt-in (no shared secret)', () => {
    const upstream = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    const ctx = buildGatewayChannel(
      makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: encodeChannelContextHeader(upstream) }),
      { channel: 'a2a', authType: 'none', trustForwardedIdentity: true },
    )
    expect(ctx.user_info).toBeNull()
  })

  it('cross-instance fix: a2a hop with api_key + opt-in forwards identity even WITHOUT a verified callerAgent', () => {
    // Remote-instance caller: its agent_id is not in the local registry, so
    // run-recording drops callerAgent. The opt-in + api_key gate must still
    // forward the upstream user identity (the original bug being fixed).
    const upstream = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    const ctx = buildGatewayChannel(
      makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: encodeChannelContextHeader(upstream) }),
      { channel: 'a2a', authType: 'api_key', trustForwardedIdentity: true /* no callerAgent */ },
    )
    expect(ctx.channel_type).toBe('a2a')
    expect(ctx.user_info?.email).toBe('alice@example.com')
    if (ctx.channel_type === 'a2a') {
      // No immediate-caller identity recorded (omitted, not an empty object).
      expect(ctx.channel_info.caller_agent).toBeUndefined()
    }
  })

  it('hop forwarding: a2a hop downgrades channel_type to a2a (was wrongly api before)', () => {
    const upstream = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    const ctx = buildGatewayChannel(
      makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: encodeChannelContextHeader(upstream) }),
      {
        channel: 'a2a',
        authType: 'api_key',
        trustForwardedIdentity: true,
        callerAgent: { agentId: 'agt_hop' },
      },
    )
    // channel_type reflects the CURRENT hop, not the original upstream
    expect(ctx.channel_type).toBe('a2a')
    // But user_info preserved from upstream OAuth caller
    expect(ctx.user_info?.email).toBe('alice@example.com')
    if (ctx.channel_type === 'a2a') {
      // auth reflects THIS hop's real inbound auth (api_key), not the upstream's.
      expect(ctx.channel_info.auth).toBe('api_key')
      // Audit trail: upstream oauth issuer/sub surfaced for chain traceability.
      expect(ctx.channel_info.oauth?.sub).toBe('sub-1')
      expect(ctx.channel_info.caller_agent?.agent_id).toBe('agt_hop')
    }
  })

  it('hop forwarding: auth is NEVER overwritten by upstream (audit semantics)', () => {
    // Regression: previously when upstream had an oauth claim, channel_info.auth
    // was silently switched to 'oauth' — making audit logs imply the upstream
    // user called directly, hiding the api_key-holding intermediate agent.
    const upstream = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    // Only api_key hops forward identity now (none/oauth are excluded by the gate),
    // so this regression specifically asserts auth stays 'api_key' (not 'oauth').
    const ctx = buildGatewayChannel(
      makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: encodeChannelContextHeader(upstream) }),
      {
        channel: 'a2a',
        authType: 'api_key',
        trustForwardedIdentity: true,
        callerAgent: { agentId: 'agt_hop' },
      },
    )
    if (ctx.channel_type === 'a2a') {
      expect(ctx.channel_info.auth).toBe('api_key')
      // Upstream oauth still surfaced as a trace:
      expect(ctx.channel_info.oauth?.sub).toBe('sub-1')
      // user_info identity preserved:
      expect(ctx.user_info?.email).toBe('alice@example.com')
    }
  })

  it('hop forwarding: feishu upstream → a2a hop preserves feishu user_info', () => {
    const upstream = buildFeishuChannel({
      appId: 'cli_app',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_x' } },
      message: { message_id: 'om', chat_id: 'oc', chat_type: 'p2p' },
      fetchedUserInfo: { name: 'Bob', email: 'bob@feishu.example', open_id: 'ou_x' },
    })
    const ctx = buildGatewayChannel(
      makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: encodeChannelContextHeader(upstream) }),
      {
        channel: 'a2a',
        authType: 'api_key',
        trustForwardedIdentity: true,
        callerAgent: { agentId: 'agt_hop' },
      },
    )
    expect(ctx.channel_type).toBe('a2a')
    expect(ctx.user_info?.email).toBe('bob@feishu.example')
    expect(ctx.user_info?.source).toBe('feishu')
  })

  it('hop forwarding: feishu upstream WITHOUT email scope still surfaces displayName via display_name field', () => {
    // Regression for the multi-hop display-name gap: when the upstream Feishu
    // app lacks contact:user.email:readonly, user_info is null but display_name
    // carries the resolved name. The a2a hop must read display_name and use it
    // for the run's triggerUserName.
    const upstreamResult = _buildFeishuChannelRaw({
      appId: 'cli_app',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_x' } },
      message: { message_id: 'om', chat_id: 'oc', chat_type: 'p2p' },
      // No email on fetchedUserInfo → ctx.user_info will be null but
      // ctx.display_name + displayName must still hold 'Carol'.
      fetchedUserInfo: { name: 'Carol', open_id: 'ou_x' },
    })
    expect(upstreamResult.ctx.user_info).toBeNull()
    expect(upstreamResult.displayName).toBe('Carol')
    if (upstreamResult.ctx.channel_type === 'feishu') {
      expect(upstreamResult.ctx.display_name).toBe('Carol')
    }
    const hopResult = _buildGatewayChannelRaw(
      makeCtx({
        [X_A2WAVE_CHANNEL_B64_HEADER]: encodeChannelContextHeader(upstreamResult.ctx),
      }),
      {
        channel: 'a2a',
        authType: 'api_key',
        trustForwardedIdentity: true,
        callerAgent: { agentId: 'agt_hop' },
      },
    )
    expect(hopResult.displayName).toBe('Carol')
    if (hopResult.ctx.channel_type === 'a2a') {
      expect(hopResult.ctx.display_name).toBe('Carol')
    }
  })
})

// ── buildFeishuChannel ──────────────────────────────────────────────────────

describe('buildFeishuChannel', () => {
  it('happy path with email-bearing user info', () => {
    const ctx = buildFeishuChannel({
      appId: 'cli_x',
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_1', union_id: 'on_1', user_id: 'us_1' },
      },
      message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', thread_id: 'th_1' },
      fetchedUserInfo: { name: 'Alice', email: 'alice@co.com', open_id: 'ou_1' },
    })
    runChannelContextSchema.parse(ctx)
    expect(ctx.channel_type).toBe('feishu')
    if (ctx.channel_type === 'feishu') {
      expect(ctx.channel_info).toMatchObject({
        app_id: 'cli_x',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_id: 'om_1',
        thread_id: 'th_1',
        sender_type: 'user',
        sender_open_id: 'ou_1',
        sender_union_id: 'on_1',
        sender_user_id: 'us_1',
      })
    }
    expect(ctx.user_info).toMatchObject({
      email: 'alice@co.com',
      name: 'Alice',
      source: 'feishu',
      source_id: 'ou_1',
    })
  })

  it('falls back name to en_name when name missing', () => {
    const ctx = buildFeishuChannel({
      appId: 'cli',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_2' } },
      message: { message_id: 'om', chat_id: 'oc', chat_type: 'p2p' },
      fetchedUserInfo: { en_name: 'Alice EN', email: 'alice@co.com' },
    })
    expect(ctx.user_info?.name).toBe('Alice EN')
  })

  it('user_info=null + WARN when fetched user has no email', () => {
    const ctx = buildFeishuChannel({
      appId: 'cli',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_3' } },
      message: { message_id: 'om', chat_id: 'oc', chat_type: 'p2p' },
      fetchedUserInfo: { name: 'NoEmail', open_id: 'ou_3' },
    })
    expect(ctx.user_info).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ open_id: 'ou_3', app_id: 'cli' }),
      expect.stringContaining('no email'),
    )
  })

  it('user_info=null silently when fetchedUserInfo is null (fetchUserInfo disabled)', () => {
    const ctx = buildFeishuChannel({
      appId: 'cli',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_4' } },
      message: { message_id: 'om', chat_id: 'oc', chat_type: 'p2p' },
      fetchedUserInfo: null,
    })
    expect(ctx.user_info).toBeNull()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('handles missing sender gracefully (defaults sender_type=user, omits sender_open_id)', () => {
    const ctx = buildFeishuChannel({
      appId: 'cli',
      sender: {},
      message: { message_id: 'om', chat_id: 'oc', chat_type: 'p2p' },
      fetchedUserInfo: null,
    })
    // Schema validation itself must pass even without an open_id (system / bot events).
    runChannelContextSchema.parse(ctx)
    if (ctx.channel_type === 'feishu') {
      expect(ctx.channel_info.sender_type).toBe('user')
      // Empty string would fail schema (.min(1)); the builder drops the key.
      expect(ctx.channel_info.sender_open_id).toBeUndefined()
    }
  })
})

// ── buildScheduleChannel ────────────────────────────────────────────────────

describe('buildScheduleChannel', () => {
  it('user_info is null when no authorized user is passed', () => {
    const ctx = buildScheduleChannel({ scheduleId: 'sch_1', cron: '*/5 * * * *' })
    runChannelContextSchema.parse(ctx)
    expect(ctx.channel_type).toBe('schedule')
    expect(ctx.user_info).toBeNull()
    if (ctx.channel_type === 'schedule') {
      expect(ctx.channel_info).toEqual({ schedule_id: 'sch_1', cron: '*/5 * * * *' })
    }
  })

  it('handles empty opts', () => {
    const ctx = buildScheduleChannel({})
    runChannelContextSchema.parse(ctx)
    expect(ctx.user_info).toBeNull()
  })

  it('carries the owner identity as idaas user_info + display_name when user is passed', () => {
    const ctx = buildScheduleChannel({
      scheduleId: 'agt_1',
      cron: '0 9 * * *',
      user: { email: 'owner@example.com', name: 'Owner', sourceId: 'sub_owner' },
    })
    runChannelContextSchema.parse(ctx)
    expect(ctx.user_info).toMatchObject({
      email: 'owner@example.com',
      name: 'Owner',
      source: 'idaas',
      source_id: 'sub_owner',
    })
    if (ctx.channel_type === 'schedule') {
      expect(ctx.display_name).toBe('Owner')
    }
  })

  it('stays anonymous when user has no email', () => {
    const ctx = buildScheduleChannel({
      scheduleId: 'agt_1',
      cron: '0 9 * * *',
      user: { email: '' },
    })
    runChannelContextSchema.parse(ctx)
    expect(ctx.user_info).toBeNull()
  })
})

// ── buildDebugChannel ───────────────────────────────────────────────────────

describe('buildDebugChannel', () => {
  it('happy path with email', () => {
    const ctx = buildDebugChannel({
      triggeredByUserId: 'usr_1',
      userEmail: 'dev@co.com',
      userName: 'Dev',
    })
    runChannelContextSchema.parse(ctx)
    expect(ctx.channel_type).toBe('debug')
    expect(ctx.user_info).toMatchObject({
      email: 'dev@co.com',
      name: 'Dev',
      source: 'a2wave',
      source_id: 'usr_1',
    })
  })

  it('user_info=null + WARN when email missing', () => {
    const ctx = buildDebugChannel({ triggeredByUserId: 'usr_2' })
    expect(ctx.user_info).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ── buildChatAppChannel ─────────────────────────────────────────────────────

describe('buildChatAppChannel', () => {
  it('resolves the same a2wave identity as debug under its own channel_type', () => {
    const ctx = buildChatAppChannel({
      triggeredByUserId: 'usr_1',
      userEmail: 'dev@co.com',
      userName: 'Dev',
    })
    runChannelContextSchema.parse(ctx)
    expect(ctx.channel_type).toBe('chat_app')
    expect(ctx.channel_info).toEqual({ triggered_by_user_id: 'usr_1' })
    expect(ctx.user_info).toMatchObject({
      email: 'dev@co.com',
      name: 'Dev',
      source: 'a2wave',
      source_id: 'usr_1',
    })
  })

  it('carries display_name for the asker label', () => {
    const { displayName } = _buildChatAppChannelRaw({
      triggeredByUserId: 'usr_1',
      userEmail: 'dev@co.com',
      userName: 'Dev',
    })
    expect(displayName).toBe('Dev')
  })

  it('user_info=null when email missing, same as debug', () => {
    const ctx = buildChatAppChannel({ triggeredByUserId: 'usr_2' })
    runChannelContextSchema.parse(ctx)
    expect(ctx.channel_type).toBe('chat_app')
    expect(ctx.user_info).toBeNull()
  })

  it('stays distinguishable from debug so chat-app traffic can be filtered out', () => {
    const opts = { triggeredByUserId: 'usr_1', userEmail: 'dev@co.com', userName: 'Dev' }
    expect(buildChatAppChannel(opts).channel_type).not.toBe(buildDebugChannel(opts).channel_type)
  })
})

// ── header round-trip helpers ───────────────────────────────────────────────

describe('encode/decodeUpstreamChannelHeader', () => {
  it('round-trips a full channel context losslessly', () => {
    const original = buildGatewayChannel(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    const encoded = encodeChannelContextHeader(original)
    const decoded = decodeUpstreamChannelHeader(makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: encoded }))
    expect(decoded).toEqual(original)
  })

  it('returns undefined when header is absent', () => {
    expect(decodeUpstreamChannelHeader(makeCtx())).toBeUndefined()
  })

  it('returns undefined and warns on malformed base64', () => {
    const out = decodeUpstreamChannelHeader(
      makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: '!!not-base64!!' }),
    )
    // The header content is base64url-decoded into "anything" then JSON.parse'd;
    // for a clearly invalid string, JSON.parse throws → undefined returned.
    expect(out).toBeUndefined()
  })
})

// ── displayName: covers the denormalized runs.trigger_user_name column ──
//
// The strict `user_info` field has been exercised throughout the suite above.
// This block isolates the looser `displayName` contract: when does each
// channel surface a name for the runs list, and (importantly for Feishu) when
// does it surface a name *even though* user_info is null?

describe('ChannelBuildResult.displayName', () => {
  it('debug: mirrors opts.userName', () => {
    const r = _buildDebugChannelRaw({
      triggeredByUserId: 'usr_1',
      userEmail: 'u@x.com',
      userName: 'Alice',
    })
    expect(r.displayName).toBe('Alice')
  })

  it('debug: null when userName missing', () => {
    const r = _buildDebugChannelRaw({ triggeredByUserId: 'usr_1', userEmail: 'u@x.com' })
    expect(r.displayName).toBeNull()
  })

  it('gateway api+api_key: displayName=null when no oauthCaller', () => {
    const r = _buildGatewayChannelRaw(makeCtx(), { channel: 'api', authType: 'api_key' })
    expect(r.displayName).toBeNull()
  })

  it('gateway api+oauth: displayName=oauthCaller.userInfo.username', () => {
    const r = _buildGatewayChannelRaw(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    expect(r.displayName).toBe('alice')
  })

  it('feishu: displayName surfaces user.name EVEN WHEN email is missing (no email scope)', () => {
    const r = _buildFeishuChannelRaw({
      appId: 'cli_app',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_a' } },
      message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p' },
      fetchedUserInfo: { name: '张三', open_id: 'ou_a' },
    })
    expect(r.ctx.user_info).toBeNull() // strict schema still null
    expect(r.displayName).toBe('张三') // but list shows the name
  })

  it('feishu: falls back to en_name when name absent', () => {
    const r = _buildFeishuChannelRaw({
      appId: 'cli_app',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_a' } },
      message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p' },
      fetchedUserInfo: { en_name: 'Zhang San', open_id: 'ou_a' },
    })
    expect(r.displayName).toBe('Zhang San')
  })

  it('feishu: null when fetchedUserInfo is null', () => {
    const r = _buildFeishuChannelRaw({
      appId: 'cli_app',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_a' } },
      message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p' },
      fetchedUserInfo: null,
    })
    expect(r.displayName).toBeNull()
  })

  it('schedule: always null (no human asker)', () => {
    const r = _buildScheduleChannelRaw({ scheduleId: 'agt_x', cron: '0 9 * * *' })
    expect(r.displayName).toBeNull()
  })

  it('a2a multi-hop: inherits upstream.user_info.name (D1 — no separate header field)', () => {
    const upstream = _buildGatewayChannelRaw(makeCtx(), {
      channel: 'api',
      authType: 'oauth',
      oauthCaller: makeOauthCaller(),
    })
    const r = _buildGatewayChannelRaw(
      makeCtx({ [X_A2WAVE_CHANNEL_B64_HEADER]: encodeChannelContextHeader(upstream.ctx) }),
      {
        channel: 'a2a',
        authType: 'api_key',
        trustForwardedIdentity: true,
        callerAgent: { agentId: 'agt_hop' },
      },
    )
    expect(r.displayName).toBe('alice')
  })
})

// ── stripReservedContextKeys ────────────────────────────────────────────────

describe('stripReservedContextKeys', () => {
  it('removes all server-reserved keys (channel/caller/receive_id*) from user context', () => {
    const out = stripReservedContextKeys({
      channel: { channel_type: 'feishu' },
      caller: { idaasUser: { sub: 'admin' } },
      receive_id_type: 'open_id',
      receive_id: 'ou_victim',
      userField: 'keep me',
      nested: { ok: true },
    })
    expect(out).toEqual({ userField: 'keep me', nested: { ok: true } })
    for (const key of RESERVED_CONTEXT_KEYS) {
      expect(out).not.toHaveProperty(key)
    }
  })

  it('blocks the Feishu DM-injection vector: receive_id_type/receive_id never survive', () => {
    const out = stripReservedContextKeys({
      receive_id_type: 'chat_id',
      receive_id: 'oc_arbitrary_target',
    })
    expect(out.receive_id_type).toBeUndefined()
    expect(out.receive_id).toBeUndefined()
  })

  it('handles undefined / null / empty context', () => {
    expect(stripReservedContextKeys(undefined)).toEqual({})
    expect(stripReservedContextKeys(null)).toEqual({})
    expect(stripReservedContextKeys({})).toEqual({})
  })

  it('returns a fresh copy — does not mutate the input', () => {
    const input = { caller: { sub: 'x' }, keep: 1 }
    const out = stripReservedContextKeys(input)
    expect(input).toHaveProperty('caller') // original untouched
    expect(out).not.toHaveProperty('caller')
  })
})
