import { renderWithProviders, screen, userEvent, waitFor, within } from '@/test/render'
import {
  CHAT_APP_SUGGESTED_QUESTIONS_MAX,
  CHAT_APP_SUGGESTED_QUESTION_MAX_LENGTH,
} from '@a2wave/shared'
/**
 * 渲染测试：确认 Publish 页 API tab 只剩 none / api_key 两种鉴权方式，
 * 且 OAuth 作为独立渠道 tab 出现。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-agents', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-agents')>('@/hooks/use-agents')
  return {
    ...actual,
    useRegenerateApiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})

vi.mock('@/lib/antd-static', () => ({
  message: { error: vi.fn(), success: vi.fn() },
  modal: { confirm: vi.fn() },
}))

import {
  PublishTab,
  normalizeSchedulePublishConfigs,
  oauthEnvErrorKey,
  parseSuggestedQuestions,
  shouldSubmitFeishuConfigForPublish,
} from '../publish-tab'

function baseProps() {
  return {
    agentId: 'agt_test1',
    agent: undefined,
    onPublishConfirm: vi.fn().mockResolvedValue(undefined),
    isPublishing: false,
    onStop: vi.fn(),
    onResume: vi.fn().mockResolvedValue(undefined),
    isStopPending: false,
    isResumePending: false,
  }
}

/**
 * Channels are cards now, and their forms live in a dialog. Opening one is
 * "click Configure on that card" — scoped to the card, because all eight cards
 * render an identically-labelled Configure button.
 */
async function openChannelConfig(user: ReturnType<typeof userEvent.setup>, key: string) {
  const card = screen.getByTestId(`channel-card-${key}`)
  await user.click(within(card).getByRole('button', { name: '配置' }))
}

/** Flips a channel's enable switch on its card (the dialog no longer has one). */
async function toggleChannel(
  user: ReturnType<typeof userEvent.setup>,
  key: string,
  switchLabel: string,
) {
  const card = screen.getByTestId(`channel-card-${key}`)
  await user.click(within(card).getByRole('switch', { name: switchLabel }))
}

describe('PublishTab — API 渠道鉴权', () => {
  it('API 弹窗只渲染 none 和 api_key 两种鉴权选项（不含 oauth）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    await openChannelConfig(user, 'api')

    await waitFor(() => {
      expect(screen.getByText('鉴权方式')).toBeInTheDocument()
    })

    // 断言限定在弹窗内：卡片描述里也含「API Key」等字样，全局查询会命中多个节点。
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText(/无鉴权/)).toBeInTheDocument()
    expect(dialog.getByText(/API Key/)).toBeInTheDocument()
    // OAuth 是独立渠道，不在 API 的 Radio.Group 中
    expect(dialog.queryByRole('radio', { name: /OAuth 授权/ })).not.toBeInTheDocument()
  })
})

describe('PublishTab — OAuth 渠道卡片', () => {
  it('渲染 OAuth 渠道卡片', async () => {
    renderWithProviders(<PublishTab {...baseProps()} />)

    await waitFor(() => {
      expect(screen.getByText('OAuth 授权')).toBeInTheDocument()
    })
  })

  it('OAuth 弹窗展示访问范围选项', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    // 启用与否不再影响表单渲染——配置可以先于启用。
    await openChannelConfig(user, 'oauth')

    expect(screen.getByText('访问范围')).toBeInTheDocument()
    expect(screen.getByText('全体企业用户')).toBeInTheDocument()
    expect(screen.getByText('指定企业用户')).toBeInTheDocument()
  })

  // The allowlist editor is the whole point of specified_users, so it must appear with the
  // mode rather than hiding behind another click.
  it('选择「指定企业用户」后展示邮箱名单编辑器', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    await openChannelConfig(user, 'oauth')
    expect(screen.queryByTestId('oauth-allowed-emails')).not.toBeInTheDocument()

    await user.click(screen.getByText('指定企业用户'))
    expect(await screen.findByTestId('oauth-allowed-emails')).toBeInTheDocument()
    // Empty list denies everyone, so the warning must be visible immediately.
    expect(screen.getByTestId('oauth-allowed-emails-empty')).toBeInTheDocument()
  })

  // The copied cURL is the first thing an integrator runs, so its placeholder is documentation.
  // `<SSO_JWT>` was wrong twice over: "SSO" spans OIDC *and* SAML while this channel verifies
  // OIDC-issued JWTs only, and SAML mints nothing that can sit in an Authorization header.
  it('uses an OIDC JWT placeholder in the OAuth cURL snippet, not the ambiguous SSO_JWT', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    // `navigator.clipboard` is getter-only in jsdom, so it has to be redefined rather than assigned.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    renderWithProviders(<PublishTab {...baseProps()} />)
    await openChannelConfig(user, 'oauth')

    await user.click(screen.getByRole('button', { name: '复制 cURL' }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toContain('/api/oauth/agt_test1/invoke')
    expect(copied).toContain('Authorization: Bearer <OIDC_JWT>')
    expect(copied).not.toContain('SSO_JWT')
  })

  it('从已发布 Agent 初始化全体企业用户访问范围', async () => {
    const user = userEvent.setup()
    const onPublishConfirm = vi.fn().mockResolvedValue(undefined)
    renderWithProviders(
      <PublishTab
        {...baseProps()}
        onPublishConfirm={onPublishConfirm}
        agent={
          {
            id: 'agt_test1',
            name: 'Agent',
            publishStatus: 'published' as const,
            publishAuthType: 'api_key' as const,
            publishIpWhitelist: [],
            publishDescription: '',
            publishChannels: ['api', 'oauth'],
            oauthAccessMode: 'all_idaas_users',
            endpointApiKey: '********',
            feishuConfig: null,
          } as any
        }
      />,
    )

    await user.click(await screen.findByRole('button', { name: /更新发布/ }))

    await waitFor(() => expect(onPublishConfirm).toHaveBeenCalled())
    expect(onPublishConfirm.mock.calls[0][0].oauthAccessMode).toBe('all_idaas_users')
  })
})

describe('PublishTab — Slack and Discord channels', () => {
  it('renders dedicated Slack and Discord cards', async () => {
    renderWithProviders(<PublishTab {...baseProps()} />)

    expect(await screen.findByText('Slack')).toBeInTheDocument()
    expect(screen.getByText('Discord')).toBeInTheDocument()
  })

  it('shows the required Slack setup steps and separates event subscriptions from OAuth scopes', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    await openChannelConfig(user, 'slack')

    expect(screen.getByText('1. 启用 Socket Mode')).toBeInTheDocument()
    expect(screen.getByText('2. 配置 OAuth 权限')).toBeInTheDocument()
    expect(screen.getByText('3. 订阅消息事件')).toBeInTheDocument()
    expect(screen.getByText('必须开启 Enable Events')).toBeInTheDocument()
    expect(screen.getByText('app_mention')).toBeInTheDocument()
    expect(screen.getByText('message.im')).toBeInTheDocument()
    expect(screen.getByText('files:read')).toBeInTheDocument()
    expect(screen.getByText('files:write')).toBeInTheDocument()
    expect(screen.getByText(/仅在勾选“频道内所有新消息均触发”时需要/)).toBeInTheDocument()
  })

  it('shows Discord attachment and thread permissions', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    await openChannelConfig(user, 'discord')

    expect(screen.getAllByText(/Attach Files/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Send Messages in Threads/)).toBeInTheDocument()
    expect(screen.getByText(/Privileged Gateway Intents/)).toBeInTheDocument()
    expect(screen.getByText(/Bot\/Webhook 消息会被忽略/)).toBeInTheDocument()
  })

  it('round-trips saved native channel settings and masked tokens', async () => {
    const user = userEvent.setup()
    const onPublishConfirm = vi.fn().mockResolvedValue(undefined)
    renderWithProviders(
      <PublishTab
        {...baseProps()}
        onPublishConfirm={onPublishConfirm}
        agent={
          {
            id: 'agt_test1',
            name: 'Agent',
            publishStatus: 'published',
            publishAuthType: 'api_key',
            publishIpWhitelist: [],
            publishDescription: '',
            publishChannels: ['api', 'slack', 'discord'],
            endpointApiKey: '********',
            slackConfig: {
              appId: 'A123',
              appToken: '********',
              botToken: '********',
              groupTriggerOnAt: true,
              groupTriggerOnNewMessage: false,
              groupReplyMode: 'thread',
              p2pReplyMode: 'new',
              sendArtifactsAsFile: false,
            },
            discordConfig: {
              applicationId: 'D123',
              botToken: '********',
              guildTriggerOnMention: true,
              guildTriggerOnNewMessage: false,
              guildReplyMode: 'reply',
              dmReplyMode: 'reply',
              sendArtifactsAsFile: false,
            },
          } as any
        }
      />,
    )

    await user.click(await screen.findByRole('button', { name: /更新发布/ }))

    await waitFor(() => expect(onPublishConfirm).toHaveBeenCalled())
    const sent = onPublishConfirm.mock.calls[0][0]
    expect(sent.channels).toEqual(expect.arrayContaining(['slack', 'discord']))
    expect(sent.slackConfig).toEqual(
      expect.objectContaining({
        appId: 'A123',
        appToken: '********',
        botToken: '********',
        sendArtifactsAsFile: false,
      }),
    )
    expect(sent.discordConfig).toEqual(
      expect.objectContaining({
        applicationId: 'D123',
        botToken: '********',
        sendArtifactsAsFile: false,
      }),
    )
  })
})

describe('PublishTab — 定时 Cron 校验', () => {
  it('normalizes malformed persisted schedule entries without throwing', () => {
    const malformedConfig = ['bad-entry', null, ['nested-array']] as unknown as Parameters<
      typeof normalizeSchedulePublishConfigs
    >[0]

    expect(normalizeSchedulePublishConfigs(null)).toEqual([])
    expect(() => normalizeSchedulePublishConfigs(malformedConfig)).not.toThrow()

    const configs = normalizeSchedulePublishConfigs(malformedConfig)
    expect(configs).toHaveLength(3)
    for (const config of configs) {
      expect(config.id).toMatch(/^sch_/)
      expect(config.cron).toBe('0 9 * * *')
      expect(config.intent).toBe('')
      expect(config.timezone).toBe('Asia/Shanghai')
    }
  })

  it('高级模式展示 Cron tips 入口', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    await openChannelConfig(user, 'schedule')
    await user.click(screen.getByText('高级模式'))

    expect(screen.getByLabelText('查看支持的 Cron 示例')).toBeInTheDocument()
  })

  it('不支持的 Cron 显示无效格式，并让启用开关保持禁用', async () => {
    const user = userEvent.setup()
    const onPublishConfirm = vi.fn().mockResolvedValue(undefined)

    renderWithProviders(<PublishTab {...baseProps()} onPublishConfirm={onPublishConfirm} />)

    await openChannelConfig(user, 'schedule')
    await user.click(screen.getByText('高级模式'))
    await user.type(screen.getByPlaceholderText('例如 0 9 * * * (每天 9:00)'), '0 7/12 * * *')

    expect(screen.getByText('无效格式')).toBeInTheDocument()
    expect(screen.queryByText('当前生效:')).not.toBeInTheDocument()

    // 卡片开关取代了原来的「发布时报错」拦截：cron 非法 ⇒ 渠道未就绪 ⇒ 开关禁用，
    // 用户根本无法把它启用到一个后端会拒绝的状态。
    await user.click(screen.getByRole('button', { name: '取消' }))
    const scheduleCard = screen.getByTestId('channel-card-schedule')
    expect(within(scheduleCard).getByRole('switch', { name: /启用定时触发/ })).toBeDisabled()

    // 渠道没启用，非法 cron 不会写进 payload，也不该拦住其它渠道的发布。
    await user.click(screen.getByRole('button', { name: /发布/ }))
    await waitFor(() => expect(onPublishConfirm).toHaveBeenCalled())
    expect(onPublishConfirm.mock.calls[0][0].channels).not.toContain('schedule')
  })

  it('支持的 Cron 在当前生效中正常展示', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    await openChannelConfig(user, 'schedule')
    await user.click(screen.getByText('高级模式'))
    await user.type(screen.getByPlaceholderText('例如 0 9 * * * (每天 9:00)'), '0 7,19 * * *')

    expect(screen.getAllByText('0 7,19 * * *').length).toBeGreaterThan(0)
    expect(screen.queryByText('无效格式')).not.toBeInTheDocument()
  })
})

describe("PublishTab — feishuConfig.appSecret '********' masking", () => {
  /**
   * Backend redacts appSecret to '********' on GET /agents/:id. When the user hits
   * "Update" without touching the secret field, the frontend must send '********'
   * back verbatim so the backend falls back to the stored real secret
   * (see apps/api/src/routes/agents.ts publish handler).
   *
   * If the frontend ever starts sending '' / omitting / regenerating the
   * field when it sees '********', production feishu bots would silently lose
   * their credentials on the next publish.
   */
  it('forwards masked appSecret verbatim when user updates without editing the field', async () => {
    const user = userEvent.setup()
    const onPublishConfirm = vi.fn().mockResolvedValue(undefined)
    const props = {
      ...baseProps(),
      onPublishConfirm,
      agent: {
        id: 'agt_test1',
        name: 'Agent',
        publishStatus: 'published' as const,
        publishAuthType: 'api_key' as const,
        publishIpWhitelist: [],
        publishDescription: '',
        publishChannels: ['api', 'feishu'],
        endpointApiKey: '********',
        feishuConfig: {
          appId: 'cli_xyz',
          appSecret: '********',
          groupTriggerOnAt: true,
          groupTriggerOnNewMessage: false,
          groupReplyMode: 'quote' as const,
          topicTriggerOnAt: true,
          topicTriggerOnNewTopic: false,
          topicTriggerOnNewComment: false,
          topicReplyMode: 'topic_reply' as const,
          replyContentType: 'text' as const,
          sendArtifactsAsFile: true,
        },
      } as any,
    }
    renderWithProviders(<PublishTab {...props} />)

    // Click the top-level "Update" button (edit mode since publishStatus=published)
    const updateBtn = await screen.findByRole('button', { name: /更新发布/ })
    await user.click(updateBtn)

    await waitFor(() => expect(onPublishConfirm).toHaveBeenCalled())
    const sent = onPublishConfirm.mock.calls[0][0]
    expect(sent.feishuConfig).toBeTruthy()
    expect(sent.feishuConfig.appSecret).toBe('********')
    expect(sent.feishuConfig.appId).toBe('cli_xyz')
  })

  // The OAuth channel authorizes against its own allowlist now, so enabling it must not drag
  // Feishu credentials into the publish payload of an Agent that has no Feishu channel.
  it('sends Feishu config only for the Feishu channel itself', () => {
    expect(shouldSubmitFeishuConfigForPublish({ feishuEnabled: true })).toBe(true)
    expect(shouldSubmitFeishuConfigForPublish({ feishuEnabled: false })).toBe(false)
  })

  it('omits feishuConfig when the OAuth channel is on but Feishu is not', async () => {
    const user = userEvent.setup()
    const onPublishConfirm = vi.fn().mockResolvedValue(undefined)
    const props = {
      ...baseProps(),
      onPublishConfirm,
      agent: {
        id: 'agt_test1',
        name: 'Agent',
        publishStatus: 'published' as const,
        publishAuthType: 'api_key' as const,
        publishIpWhitelist: [],
        publishDescription: '',
        publishChannels: ['api', 'oauth'],
        oauthAccessMode: 'all_idaas_users',
        endpointApiKey: '********',
        feishuConfig: {
          appId: 'cli_xyz',
          appSecret: '********',
          groupTriggerOnAt: true,
          groupTriggerOnNewMessage: false,
          groupReplyMode: 'quote' as const,
          topicTriggerOnAt: true,
          topicTriggerOnNewTopic: false,
          topicTriggerOnNewComment: false,
          topicReplyMode: 'topic_reply' as const,
          replyContentType: 'text' as const,
          sendArtifactsAsFile: true,
        },
      } as any,
    }
    renderWithProviders(<PublishTab {...props} />)

    await user.click(screen.getByText('OAuth 授权'))
    await user.click(await screen.findByRole('button', { name: /更新发布/ }))

    await waitFor(() => expect(onPublishConfirm).toHaveBeenCalled())
    const sent = onPublishConfirm.mock.calls[0][0]
    expect(sent.oauthAccessMode).toBe('all_idaas_users')
    expect(sent.feishuConfig).toBeUndefined()
  })
})

describe('PublishTab — 开场白字段 round-trip', () => {
  it('feishuConfig 里的 welcome 字段 load 后提交时原样透传', async () => {
    const user = userEvent.setup()
    const onPublishConfirm = vi.fn().mockResolvedValue(undefined)
    const props = {
      ...baseProps(),
      onPublishConfirm,
      agent: {
        id: 'agt_test1',
        name: 'Agent',
        publishStatus: 'published' as const,
        publishAuthType: 'api_key' as const,
        publishIpWhitelist: [],
        publishDescription: '',
        publishChannels: ['feishu'],
        endpointApiKey: '********',
        feishuConfig: {
          appId: 'cli_xyz',
          appSecret: '********',
          groupTriggerOnAt: true,
          groupTriggerOnNewMessage: false,
          groupReplyMode: 'quote' as const,
          topicTriggerOnAt: true,
          topicTriggerOnNewTopic: false,
          topicTriggerOnNewComment: false,
          topicReplyMode: 'topic_reply' as const,
          replyContentType: 'text' as const,
          sendArtifactsAsFile: true,
          welcomeMessage: '👋 hi',
          welcomeOnP2pEnabled: true,
          welcomeP2pIdleDays: 3,
          welcomeOnGroupAddedEnabled: false,
        },
      } as any,
    }
    renderWithProviders(<PublishTab {...props} />)

    const updateBtn = await screen.findByRole('button', { name: /更新发布/ })
    await user.click(updateBtn)

    await waitFor(() => expect(onPublishConfirm).toHaveBeenCalled())
    const sent = onPublishConfirm.mock.calls[0][0]
    expect(sent.feishuConfig.welcomeMessage).toBe('👋 hi')
    expect(sent.feishuConfig.welcomeOnP2pEnabled).toBe(true)
    expect(sent.feishuConfig.welcomeP2pIdleDays).toBe(3)
    expect(sent.feishuConfig.welcomeOnGroupAddedEnabled).toBe(false)
  })

  it('feishuConfig 里的话题根消息设置 load 后提交时原样透传', async () => {
    const user = userEvent.setup()
    const onPublishConfirm = vi.fn().mockResolvedValue(undefined)
    const props = {
      ...baseProps(),
      onPublishConfirm,
      agent: {
        id: 'agt_test1',
        name: 'Agent',
        publishStatus: 'published' as const,
        publishAuthType: 'api_key' as const,
        publishIpWhitelist: [],
        publishDescription: '',
        publishChannels: ['feishu'],
        endpointApiKey: '********',
        feishuConfig: {
          appId: 'cli_xyz',
          appSecret: '********',
          groupTriggerOnAt: true,
          groupTriggerOnNewMessage: false,
          groupReplyMode: 'quote' as const,
          topicTriggerOnAt: true,
          topicTriggerOnNewTopic: false,
          topicTriggerOnNewComment: false,
          topicReplyMode: 'topic_reply' as const,
          topicInjectRootMessage: true,
          topicReplyMentionTarget: 'topic_creator' as const,
          replyContentType: 'text' as const,
          sendArtifactsAsFile: true,
        },
      } as any,
    }
    renderWithProviders(<PublishTab {...props} />)

    const updateBtn = await screen.findByRole('button', { name: /更新发布/ })
    await user.click(updateBtn)

    await waitFor(() => expect(onPublishConfirm).toHaveBeenCalled())
    const sent = onPublishConfirm.mock.calls[0][0]
    expect(sent.feishuConfig.topicInjectRootMessage).toBe(true)
    expect(sent.feishuConfig.topicReplyMentionTarget).toBe('topic_creator')
  })

  it('persists P2P reply mode changes in the publish draft', async () => {
    localStorage.clear()
    const user = userEvent.setup()
    renderWithProviders(
      <PublishTab
        {...baseProps()}
        agent={
          {
            id: 'agt_test1',
            name: 'Agent',
            publishStatus: 'published',
            publishAuthType: 'api_key',
            publishIpWhitelist: [],
            publishDescription: '',
            publishChannels: ['feishu'],
            endpointApiKey: '********',
            feishuConfig: {
              appId: 'cli_xyz',
              appSecret: '********',
              groupTriggerOnAt: true,
              groupTriggerOnNewMessage: false,
              groupReplyMode: 'quote',
              topicTriggerOnAt: true,
              topicTriggerOnNewTopic: false,
              topicTriggerOnNewComment: false,
              topicReplyMode: 'topic_reply',
              p2pReplyMode: 'quote',
              replyContentType: 'text',
              sendArtifactsAsFile: true,
            },
          } as any
        }
      />,
    )

    await user.click(await screen.findByText('飞书机器人'))
    const p2pSection = (await screen.findByText('单聊（私聊机器人）配置')).closest('div')
    expect(p2pSection).not.toBeNull()
    const newMessageRadio = within(p2pSection as HTMLElement).getByRole('radio', {
      name: '新增消息回复',
    })
    await waitFor(() => expect(newMessageRadio).not.toBeChecked())
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    await user.click(newMessageRadio)

    await waitFor(() => {
      const draft = JSON.parse(localStorage.getItem('draft-publish:agt_test1') ?? '{}')
      expect(draft.p2pReplyMode).toBe('new')
    })
  })
})

describe('parseSuggestedQuestions', () => {
  it('splits one question per line and trims', () => {
    expect(parseSuggestedQuestions('  第一个问题  \n第二个问题')).toEqual([
      '第一个问题',
      '第二个问题',
    ])
  })

  it('drops blank lines instead of emitting empty questions', () => {
    expect(parseSuggestedQuestions('a\n\n  \nb')).toEqual(['a', 'b'])
  })

  it('returns an empty array for blank input', () => {
    expect(parseSuggestedQuestions('')).toEqual([])
    expect(parseSuggestedQuestions('\n  \n')).toEqual([])
  })

  it('caps the list so an oversized paste cannot fail the publish', () => {
    const raw = Array.from({ length: 20 }, (_, i) => `q${i}`).join('\n')
    expect(parseSuggestedQuestions(raw)).toHaveLength(CHAT_APP_SUGGESTED_QUESTIONS_MAX)
  })

  // A too-long question is rejected by Zod as a field-error object, which the UI's
  // error formatter renders as an empty toast — so it must be clamped client-side.
  it('clamps each question to the schema per-question limit', () => {
    const long = 'a'.repeat(500)
    const [only] = parseSuggestedQuestions(long)
    expect(only).toHaveLength(CHAT_APP_SUGGESTED_QUESTION_MAX_LENGTH)
  })

  it('clamps before dropping blanks, so a whitespace-only line stays dropped', () => {
    expect(parseSuggestedQuestions(`${' '.repeat(300)}\nreal`)).toEqual(['real'])
  })
})

describe('PublishTab — 对话网页渠道', () => {
  it('已开启时 load 后提交原样透传 chatAppConfig', async () => {
    const user = userEvent.setup()
    const onPublishConfirm = vi.fn().mockResolvedValue(undefined)
    const props = {
      ...baseProps(),
      onPublishConfirm,
      agent: {
        id: 'agt_test1',
        name: 'Agent',
        publishStatus: 'published' as const,
        publishAuthType: 'api_key' as const,
        publishIpWhitelist: [],
        publishDescription: '',
        publishChannels: ['api', 'chat_app'],
        endpointApiKey: '********',
        chatAppConfig: {
          displayName: '客服助手',
          welcomeMessage: '你好',
          suggestedQuestions: ['怎么重置密码？'],
          showCreator: false,
          allowAttachments: false,
          showThinking: false,
        },
      } as any,
    }
    renderWithProviders(<PublishTab {...props} />)

    const updateBtn = await screen.findByRole('button', { name: /更新发布/ })
    await user.click(updateBtn)

    await waitFor(() => expect(onPublishConfirm).toHaveBeenCalled())
    const sent = onPublishConfirm.mock.calls[0][0]
    expect(sent.channels).toContain('chat_app')
    expect(sent.chatAppConfig).toEqual({
      displayName: '客服助手',
      welcomeMessage: '你好',
      suggestedQuestions: ['怎么重置密码？'],
      showCreator: false,
      allowAttachments: false,
      showThinking: false,
    })
  })

  it('未开启渠道时提交 chatAppConfig=null 清空历史配置，且不带 chat_app', async () => {
    const user = userEvent.setup()
    const onPublishConfirm = vi.fn().mockResolvedValue(undefined)
    const props = {
      ...baseProps(),
      onPublishConfirm,
      agent: {
        id: 'agt_test1',
        name: 'Agent',
        publishStatus: 'published' as const,
        publishAuthType: 'api_key' as const,
        publishIpWhitelist: [],
        publishDescription: '',
        publishChannels: ['api'],
        endpointApiKey: '********',
      } as any,
    }
    renderWithProviders(<PublishTab {...props} />)

    const updateBtn = await screen.findByRole('button', { name: /更新发布/ })
    await user.click(updateBtn)

    await waitFor(() => expect(onPublishConfirm).toHaveBeenCalled())
    const sent = onPublishConfirm.mock.calls[0][0]
    expect(sent.channels).not.toContain('chat_app')
    // null, not undefined: the publish route only writes the column when the key is
    // present, so undefined would strand the previous welcome message in the DB.
    expect(sent.chatAppConfig).toBeNull()
  })
})

describe('PublishTab — 飞书话题提醒对象', () => {
  /** Opens the Feishu dialog for an agent already published to Feishu. */
  async function openFeishuConfig(
    user: ReturnType<typeof userEvent.setup>,
    feishuConfig: Record<string, unknown>,
  ) {
    const props = {
      ...baseProps(),
      agent: {
        id: 'agt_test1',
        name: 'Agent',
        publishStatus: 'published' as const,
        publishAuthType: 'api_key' as const,
        publishIpWhitelist: [],
        publishDescription: '',
        publishChannels: ['feishu'],
        endpointApiKey: '********',
        feishuConfig: {
          appId: 'cli_xyz',
          appSecret: '********',
          groupTriggerOnAt: true,
          groupTriggerOnNewMessage: false,
          groupReplyMode: 'quote' as const,
          topicTriggerOnAt: true,
          topicTriggerOnNewTopic: false,
          topicTriggerOnNewComment: false,
          replyContentType: 'text' as const,
          ...feishuConfig,
        },
      } as any,
    }
    renderWithProviders(<PublishTab {...props} />)
    await openChannelConfig(user, 'feishu')
    return within(await screen.findByRole('dialog'))
  }

  it('话题回复开启时显示提醒对象单选组', async () => {
    const user = userEvent.setup()
    const dialog = await openFeishuConfig(user, { topicReplyMode: 'topic_reply' })

    expect(dialog.getByText('回复时提醒')).toBeInTheDocument()
    expect(dialog.getByRole('radio', { name: '@ 话题发起人' })).toBeInTheDocument()
    expect(dialog.getByRole('radio', { name: '不 @任何人' })).toBeInTheDocument()
  })

  it('话题回复设为「无需回复」时隐藏提醒对象单选组', async () => {
    const user = userEvent.setup()
    // groupReplyMode must follow: the section mirrors group→topic 'none' coupling.
    const dialog = await openFeishuConfig(user, {
      topicReplyMode: 'none',
      groupReplyMode: 'none',
    })

    // The topic section itself is still there — only the mention picker is gone,
    // because there is no reply to attach a mention to.
    expect(dialog.getByText('话题群回复配置')).toBeInTheDocument()
    expect(dialog.queryByText('回复时提醒')).not.toBeInTheDocument()
    expect(dialog.queryByRole('radio', { name: '@ 话题发起人' })).not.toBeInTheDocument()
  })

  it('话题回复关闭但普通群回复仍开启时保留提醒对象单选组', async () => {
    const user = userEvent.setup()
    // Only reachable via API/import, not the dialog (the two radios are coupled there).
    // 「不 @任何人」still governs the group replies, so hiding it would strand a live setting.
    const dialog = await openFeishuConfig(user, {
      topicReplyMode: 'none',
      groupReplyMode: 'quote',
    })

    expect(dialog.getByText('回复时提醒')).toBeInTheDocument()
    expect(dialog.getByRole('radio', { name: '不 @任何人' })).toBeInTheDocument()
  })

  it('把话题回复切到「无需回复」会即时收起提醒对象单选组', async () => {
    const user = userEvent.setup()
    const dialog = await openFeishuConfig(user, { topicReplyMode: 'topic_reply' })

    expect(dialog.getByText('回复时提醒')).toBeInTheDocument()

    const topicSection = dialog.getByText('话题群回复配置').closest('div') as HTMLElement
    await user.click(
      within(topicSection).getByRole('radio', { name: '无需回复（由 Agent/MCP 自行处理）' }),
    )

    await waitFor(() => expect(dialog.queryByText('回复时提醒')).not.toBeInTheDocument())
  })
})

describe('oauthEnvErrorKey', () => {
  // The OIDC config resolves DB-first. Telling an admin to set environment variables when the
  // config came from Settings sends them to edit a file the server never reads — they restart
  // and nothing changes.
  // The literal must match what the API actually returns (`SsoConfigSource = 'settings' | 'env'`).
  // An earlier version of this test asserted `'db'` — the same wrong value the implementation
  // used — so both agreed with each other while the feature was dead in production.
  it('sends a Settings-sourced incomplete config back to Settings, not to env vars', () => {
    expect(
      oauthEnvErrorKey({ missing: ['A2WAVE_OIDC_CHANNEL_AUDIENCES'], source: 'settings' }),
    ).toBe('agentPublish.oauthEnvIncompleteSettings')
  })

  it('names the environment variables when the config is env-sourced or absent', () => {
    expect(oauthEnvErrorKey({ missing: ['A2WAVE_OIDC_ISSUER'], source: 'env' })).toBe(
      'agentPublish.oauthEnvMissing',
    )
    expect(oauthEnvErrorKey({ missing: ['A2WAVE_OIDC_ISSUER'], source: null })).toBe(
      'agentPublish.oauthEnvMissing',
    )
  })

  // Nothing missing but still unusable means the issuer itself does not verify.
  it('reports an unusable issuer when nothing is missing', () => {
    expect(oauthEnvErrorKey({ missing: [], source: 'settings' })).toBe(
      'agentPublish.oauthEnvInvalidPublicKey',
    )
  })
})
