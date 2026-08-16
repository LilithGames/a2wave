import { describe, expect, it } from 'vitest'
import {
  CHAT_APP_SUGGESTED_QUESTIONS_MAX,
  a2aRouteTargetSchema,
  agentSchema,
  chatAppConfigSchema,
  createAgentInput,
  discordConfigSchema,
  feishuConfigSchema,
  providerChainItemSchema,
  providerChainSchema,
  publishChannelEnum,
  scheduleConfigSchema,
  slackConfigSchema,
  updateAgentInput,
} from '../schemas/agent.js'

describe('A2A route target compatibility', () => {
  it('keeps legacy remote endpoints valid without discovery fields', () => {
    const target = {
      type: 'remote',
      name: 'legacy-agent',
      url: 'https://example.com/a2a',
      apiKey: 'secret',
    }

    expect(a2aRouteTargetSchema.parse(target)).toEqual(target)
  })

  it('accepts Agent Card discovery and versioned direct endpoints', () => {
    expect(
      a2aRouteTargetSchema.parse({
        type: 'remote',
        name: 'standard-agent',
        url: 'https://example.com/.well-known/agent-card.json',
        connectionMode: 'agent_card',
      }),
    ).toMatchObject({ connectionMode: 'agent_card' })

    expect(
      a2aRouteTargetSchema.parse({
        type: 'remote',
        name: 'direct-agent',
        url: 'https://example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
        callerProvenance: true,
      }),
    ).toMatchObject({
      connectionMode: 'direct',
      protocolVersion: '1.0',
      callerProvenance: true,
    })
  })

  it('rejects unknown connection modes and protocol versions', () => {
    expect(
      a2aRouteTargetSchema.safeParse({
        type: 'remote',
        name: 'future-agent',
        url: 'https://example.com/a2a',
        connectionMode: 'grpc',
      }).success,
    ).toBe(false)
    expect(
      a2aRouteTargetSchema.safeParse({
        type: 'remote',
        name: 'future-agent',
        url: 'https://example.com/a2a',
        protocolVersion: '2.0',
      }).success,
    ).toBe(false)
    expect(
      a2aRouteTargetSchema.safeParse({
        type: 'remote',
        name: 'future-agent',
        url: 'https://example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
        callerProvenance: 'yes',
      }).success,
    ).toBe(false)
  })
})

describe('agent config schema compatibility', () => {
  it('accepts arbitrary config values like main branch', () => {
    const config = {
      engineType: 123,
      model: null,
      timeoutMinutes: '30',
      customFlag: true,
      nested: { value: ['kept'] },
    }

    const parsed = createAgentInput.parse({
      name: 'Compat Agent',
      config,
    })

    expect(parsed.config).toEqual(config)
  })

  it('keeps updateAgentInput config as a broad record', () => {
    const config = {
      model: '',
      extraEngineFlags: ['--compact-history'],
    }

    const parsed = updateAgentInput.parse({ config })

    expect(parsed.config).toEqual(config)
  })
})

// providerChain is the one config key that IS validated: it drives runtime
// provider fallback, where a malformed or oversized chain turns into wasted
// subprocess launches that only surface at execution time.
describe('providerChain validation', () => {
  const entry = (providerId: string) => ({ providerId, authMode: 'apiKey', enabled: true })

  it('accepts a chain at the 5-provider limit', () => {
    const providerChain = ['a', 'b', 'c', 'd', 'e'].map(entry)

    const parsed = createAgentInput.parse({ name: 'Chain Agent', config: { providerChain } })

    expect((parsed.config as { providerChain: unknown[] }).providerChain).toHaveLength(5)
  })

  it('accepts explicit Claude auth header styles while preserving legacy entries', () => {
    for (const authHeaderStyle of ['x-api-key', 'bearer'] as const) {
      const result = createAgentInput.safeParse({
        name: 'Chain Agent',
        config: { providerChain: [{ ...entry('claude'), authHeaderStyle }] },
      })
      expect(result.success).toBe(true)
    }

    expect(
      createAgentInput.safeParse({
        name: 'Legacy Chain Agent',
        config: { providerChain: [entry('claude')] },
      }).success,
    ).toBe(true)
  })

  it('rejects an unknown auth header style', () => {
    const result = createAgentInput.safeParse({
      name: 'Chain Agent',
      config: { providerChain: [{ ...entry('claude'), authHeaderStyle: 'auto' }] },
    })

    expect(result.success).toBe(false)
  })

  it('rejects a chain longer than 5 providers', () => {
    const providerChain = ['a', 'b', 'c', 'd', 'e', 'f'].map(entry)

    const result = createAgentInput.safeParse({ name: 'Chain Agent', config: { providerChain } })

    expect(result.success).toBe(false)
  })

  // Everything below stays ACCEPTED on purpose. A draft Agent is saved before a
  // Provider is picked, and the web client persists exactly these shapes for it.
  // Rejecting them would brick existing drafts and block the save that repairs
  // them; whether a chain resolves to a usable Provider is settled at execution
  // time instead (UnusableProviderChainError), since Providers are deleted
  // independently of this config.
  it('accepts an empty chain — a draft Agent has no provider yet', () => {
    const result = createAgentInput.safeParse({
      name: 'Chain Agent',
      config: { providerChain: [] },
    })

    expect(result.success).toBe(true)
  })

  it('accepts a fully disabled chain', () => {
    const providerChain = [
      { providerId: 'a', authMode: 'apiKey', enabled: false },
      { providerId: 'b', authMode: 'apiKey', enabled: false },
    ]

    const result = createAgentInput.safeParse({ name: 'Chain Agent', config: { providerChain } })

    expect(result.success).toBe(true)
  })

  it('accepts an entry whose provider has not been chosen yet', () => {
    const result = createAgentInput.safeParse({
      name: 'Chain Agent',
      config: { providerChain: [{ providerId: null, authMode: 'apiKey', enabled: true }] },
    })

    expect(result.success).toBe(true)
  })

  it('leaves an omitted auth mode for the Provider manifest to resolve', () => {
    const parsed = createAgentInput.parse({
      name: 'Manifest Default Agent',
      config: { providerChain: [{ providerId: 'prv_pi', enabled: true }] },
    })

    expect(parsed.config?.providerChain?.[0]).not.toHaveProperty('authMode')
  })

  it('rejects a malformed chain entry', () => {
    const result = createAgentInput.safeParse({
      name: 'Chain Agent',
      config: { providerChain: [{ authMode: 'apiKey' }] },
    })

    expect(result.success).toBe(false)
  })

  it('leaves a config without providerChain untouched', () => {
    const config = { model: 'gpt-5', somethingElse: { nested: true } }

    const parsed = createAgentInput.parse({ name: 'No Chain', config })

    expect(parsed.config).toEqual(config)
  })

  it('applies the same limit on update', () => {
    const providerChain = ['a', 'b', 'c', 'd', 'e', 'f'].map(entry)

    expect(updateAgentInput.safeParse({ config: { providerChain } }).success).toBe(false)
  })
})

describe('agent pinnedAt field', () => {
  it('agentSchema accepts a pinnedAt date and coerces ISO strings', () => {
    const parsed = agentSchema.parse({
      id: 'agt_1',
      name: 'Pinned',
      type: 'cursor',
      status: 'active',
      pinnedAt: '2025-07-08T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    })
    expect(parsed.pinnedAt).toBeInstanceOf(Date)
  })

  it('agentSchema allows pinnedAt to be null/omitted (un-pinned)', () => {
    const parsed = agentSchema.parse({
      id: 'agt_1',
      name: 'Unpinned',
      type: 'cursor',
      status: 'active',
      pinnedAt: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    })
    expect(parsed.pinnedAt).toBeNull()
  })

  it('createAgentInput does NOT accept pinnedAt (server-only via pin route)', () => {
    // pinnedAt must be server-stamped; a client-supplied value is silently dropped,
    // never letting a create/PATCH pin an agent (mirrors scheduleRunAsOwner).
    const parsed = createAgentInput.parse({
      name: 'X',
      pinnedAt: new Date('2025-07-08'),
    } as Record<string, unknown>)
    expect('pinnedAt' in parsed).toBe(false)
  })

  it('updateAgentInput does NOT accept pinnedAt', () => {
    const parsed = updateAgentInput.parse({
      pinnedAt: new Date('2025-07-08'),
    } as Record<string, unknown>)
    expect('pinnedAt' in parsed).toBe(false)
  })
})

describe('agent publishStatus field', () => {
  it('createAgentInput does NOT accept publishStatus (server-only via lifecycle routes)', () => {
    const parsed = createAgentInput.parse({
      name: 'Lifecycle Agent',
      publishStatus: 'published',
    } as Record<string, unknown>)

    expect('publishStatus' in parsed).toBe(false)
  })

  it('updateAgentInput does NOT accept publishStatus', () => {
    const parsed = updateAgentInput.parse({
      publishStatus: 'published',
    } as Record<string, unknown>)

    expect('publishStatus' in parsed).toBe(false)
  })
})

describe('schedule config schema compatibility', () => {
  it('accepts the legacy single schedule config object', () => {
    const parsed = scheduleConfigSchema.parse({
      cron: '0 9 * * *',
      intent: 'daily report',
      timezone: 'Asia/Shanghai',
    })

    expect(parsed).toMatchObject({ cron: '0 9 * * *', intent: 'daily report' })
  })

  it('accepts multiple schedule configs', () => {
    const parsed = scheduleConfigSchema.parse([
      { id: 'sch_morning', cron: '0 9 * * *', intent: 'morning report', timezone: 'Asia/Shanghai' },
      {
        id: 'sch_evening',
        cron: '0 18 * * *',
        intent: 'evening report',
        timezone: 'Asia/Shanghai',
      },
    ])

    expect(parsed).toHaveLength(2)
    if (!Array.isArray(parsed)) throw new Error('expected multiple schedule configs')
    expect(parsed[0]).toMatchObject({ id: 'sch_morning' })
  })
})

describe('native chat channel schemas', () => {
  it('accepts Slack and Discord as publish channels', () => {
    expect(publishChannelEnum.parse('slack')).toBe('slack')
    expect(publishChannelEnum.parse('discord')).toBe('discord')
  })

  it('applies safe Slack trigger defaults', () => {
    expect(
      slackConfigSchema.parse({
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
      }),
    ).toMatchObject({
      groupTriggerOnAt: true,
      groupTriggerOnNewMessage: false,
      groupReplyMode: 'thread',
      p2pReplyMode: 'new',
      sendArtifactsAsFile: true,
    })
  })

  it('applies safe Discord trigger defaults', () => {
    expect(
      discordConfigSchema.parse({
        applicationId: '1234567890',
        botToken: 'discord-test',
      }),
    ).toMatchObject({
      guildTriggerOnMention: true,
      guildTriggerOnNewMessage: false,
      guildReplyMode: 'reply',
      dmReplyMode: 'reply',
      sendArtifactsAsFile: true,
    })
  })
})

describe('feishuConfigSchema topic settings', () => {
  it('默认关闭根消息注入并 @ 当前触发者', () => {
    const parsed = feishuConfigSchema.parse({ appId: 'cli_x', appSecret: 's' })
    expect(parsed.topicInjectRootMessage).toBe(false)
    expect(parsed.topicReplyMentionTarget).toBe('trigger_sender')
  })

  it.each(['trigger_sender', 'topic_creator', 'none'] as const)(
    '保留合法的 topicReplyMentionTarget=%s',
    (topicReplyMentionTarget) => {
      const parsed = feishuConfigSchema.parse({
        appId: 'cli_x',
        appSecret: 's',
        topicReplyMentionTarget,
      })
      expect(parsed.topicReplyMentionTarget).toBe(topicReplyMentionTarget)
    },
  )

  it('拒绝未知的话题回复提醒对象', () => {
    expect(() =>
      feishuConfigSchema.parse({
        appId: 'cli_x',
        appSecret: 's',
        topicReplyMentionTarget: 'second_mention',
      }),
    ).toThrow()
  })

  it('显式开启 topicInjectRootMessage 时保留 true', () => {
    const parsed = feishuConfigSchema.parse({
      appId: 'cli_x',
      appSecret: 's',
      topicInjectRootMessage: true,
    })
    expect(parsed.topicInjectRootMessage).toBe(true)
  })

  it('agentSchema 解析后 feishuConfig 保留 topicInjectRootMessage', () => {
    const parsed = agentSchema.parse({
      id: 'agt_test',
      name: 'Agent A',
      type: 'cursor',
      status: 'active',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      publishChannels: ['feishu'],
      feishuConfig: {
        appId: 'cli_x',
        appSecret: 's',
        topicInjectRootMessage: true,
        topicReplyMentionTarget: 'topic_creator',
      },
    })
    expect(parsed.feishuConfig?.topicInjectRootMessage).toBe(true)
    expect(parsed.feishuConfig?.topicReplyMentionTarget).toBe('topic_creator')
  })
})

describe('chat app channel schema', () => {
  it('accepts chat_app as a publish channel', () => {
    expect(publishChannelEnum.parse('chat_app')).toBe('chat_app')
  })

  it('applies defaults for an empty config', () => {
    expect(chatAppConfigSchema.parse({})).toEqual({
      suggestedQuestions: [],
      showCreator: true,
      allowAttachments: true,
      showThinking: true,
    })
  })

  it('rejects more suggested questions than the cap', () => {
    const tooMany = Array.from({ length: CHAT_APP_SUGGESTED_QUESTIONS_MAX + 1 }, (_, i) => `q${i}`)
    expect(chatAppConfigSchema.safeParse({ suggestedQuestions: tooMany }).success).toBe(false)
    expect(
      chatAppConfigSchema.safeParse({ suggestedQuestions: tooMany.slice(0, -1) }).success,
    ).toBe(true)
  })

  it('rejects an empty suggested question', () => {
    expect(chatAppConfigSchema.safeParse({ suggestedQuestions: [''] }).success).toBe(false)
  })

  it('round-trips through the agent schema', () => {
    const parsed = agentSchema.partial().parse({
      chatAppConfig: { welcomeMessage: 'hi', suggestedQuestions: ['a'] },
    })
    expect(parsed.chatAppConfig).toMatchObject({
      welcomeMessage: 'hi',
      suggestedQuestions: ['a'],
      showCreator: true,
    })
  })
})

describe('provider chain item reasoning controls', () => {
  const base = { providerId: 'prv_1', model: 'claude-opus-4-8' }

  it('keeps a chain item valid when neither control is configured', () => {
    const parsed = providerChainItemSchema.parse(base)

    expect(parsed.reasoningEffort).toBeUndefined()
    expect(parsed.fastMode).toBeUndefined()
  })

  it('stores both controls beside the model they belong to', () => {
    const parsed = providerChainItemSchema.parse({
      ...base,
      reasoningEffort: 'xhigh',
      fastMode: true,
    })

    expect(parsed.reasoningEffort).toBe('xhigh')
    expect(parsed.fastMode).toBe(true)
  })

  it('rejects an effort value that could not have come from discovery', () => {
    expect(
      providerChainItemSchema.safeParse({ ...base, reasoningEffort: '--effort' }).success,
    ).toBe(false)
  })

  it('rejects a non-boolean fast mode', () => {
    expect(providerChainItemSchema.safeParse({ ...base, fastMode: 'on' }).success).toBe(false)
  })

  it('lets each entry in one chain carry its own controls', () => {
    const parsed = providerChainSchema.parse([
      { providerId: 'prv_codex', model: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
      {
        providerId: 'prv_claude',
        model: 'claude-opus-4-8',
        reasoningEffort: 'xhigh',
        fastMode: true,
      },
    ])

    expect(parsed.map((entry) => entry.reasoningEffort)).toEqual(['ultra', 'xhigh'])
    expect(parsed.map((entry) => entry.fastMode)).toEqual([undefined, true])
  })
})
