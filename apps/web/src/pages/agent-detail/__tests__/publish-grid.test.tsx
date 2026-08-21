/**
 * Publish tab → channel card grid.
 *
 * The grid replaced a secondary tab strip, which changes two things these
 * tests pin down: every channel's switch is now in the DOM at once (so each
 * needs a distinct accessible name), and a channel's config form only renders
 * once its dialog is open.
 */

import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen, userEvent, waitFor, within } from '@/test/render'

vi.mock('@/hooks/use-agents', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-agents')>('@/hooks/use-agents')
  return {
    ...actual,
    useRegenerateApiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useRegenerateA2aApiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSaveChannelConfig: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  }
})

vi.mock('@/lib/antd-static', () => ({
  message: { error: vi.fn(), success: vi.fn() },
  modal: { confirm: vi.fn() },
}))

import { PublishTab } from '../publish-tab'

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

const ALL_CHANNELS = [
  'api',
  'oauth',
  'a2a',
  'feishu',
  'slack',
  'discord',
  'qq_official',
  'schedule',
  'chat_app',
  'glab',
  'gh',
] as const

function card(key: string) {
  return screen.getByTestId(`channel-card-${key}`)
}

async function openConfig(user: ReturnType<typeof userEvent.setup>, key: string) {
  await user.click(within(card(key)).getByRole('button', { name: '配置' }))
}

describe('PublishTab — 渠道卡片网格', () => {
  it('默认渲染全部 11 个渠道卡片', () => {
    renderWithProviders(<PublishTab {...baseProps()} />)

    for (const key of ALL_CHANNELS) {
      expect(screen.getByTestId(`channel-card-${key}`)).toBeInTheDocument()
    }
  })

  it('筛选「聊天机器人」只保留飞书 / Slack / Discord / QQ 官方机器人', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    await user.click(screen.getByText('聊天机器人'))

    for (const key of ['feishu', 'slack', 'discord', 'qq_official']) {
      expect(screen.getByTestId(`channel-card-${key}`)).toBeInTheDocument()
    }
    for (const key of ['api', 'oauth', 'a2a', 'schedule', 'chat_app', 'glab', 'gh']) {
      expect(screen.queryByTestId(`channel-card-${key}`)).not.toBeInTheDocument()
    }
  })

  it('筛选回「全部」恢复全部渠道卡片', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    await user.click(screen.getByText('定时'))
    expect(screen.queryByTestId('channel-card-feishu')).not.toBeInTheDocument()

    await user.click(screen.getByText('全部'))
    for (const key of ALL_CHANNELS) {
      expect(screen.getByTestId(`channel-card-${key}`)).toBeInTheDocument()
    }
  })

  it('switching Agents clears QQ Official credentials and resets channel defaults', async () => {
    const user = userEvent.setup()
    const configuredAgent = {
      id: 'agt_qq_1',
      publishStatus: 'draft',
      publishChannels: ['qq_official'],
      qqOfficialConfig: {
        appId: '102000000',
        appSecret: 'secret-from-first-agent',
        groupTriggerOnAt: false,
        groupReplyMode: 'none',
        c2cReplyMode: 'none',
        sendArtifactsAsFile: false,
      },
    }
    const unconfiguredAgent = {
      id: 'agt_qq_2',
      publishStatus: 'draft',
      publishChannels: [],
      qqOfficialConfig: null,
    }
    const firstProps = { ...baseProps(), agentId: configuredAgent.id }
    const { rerender } = renderWithProviders(
      <PublishTab {...firstProps} agent={configuredAgent as never} />,
    )
    await openConfig(user, 'qq_official')

    expect(screen.getByLabelText('App ID')).toHaveValue('102000000')
    expect(screen.getByLabelText('App Secret')).toHaveValue('secret-from-first-agent')
    expect(screen.queryByText('群聊中的所有新消息均触发')).not.toBeInTheDocument()

    rerender(
      <PublishTab
        {...baseProps()}
        agentId={unconfiguredAgent.id}
        agent={unconfiguredAgent as never}
      />,
    )

    await waitFor(() => {
      expect(screen.getByLabelText('App ID')).toHaveValue('')
      expect(screen.getByLabelText('App Secret')).toHaveValue('')
    })
    const switches = within(screen.getByRole('dialog')).getAllByRole('switch')
    expect(switches.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'true'])
  })

  it('REST API 卡片没有开关，只显示「始终启用」', () => {
    renderWithProviders(<PublishTab {...baseProps()} />)

    // buildChannels() 永远 push 'api'，给它开关等于让用户拨一个不生效的状态。
    expect(within(card('api')).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(card('api')).getByText('始终启用')).toBeInTheDocument()
  })

  it('未配置凭据时飞书开关禁用', () => {
    renderWithProviders(<PublishTab {...baseProps()} />)

    // 禁用态的可访问名会附带原因（tooltip 只有 hover 能看到，键盘用户看不到），
    // 所以用前缀匹配。
    expect(within(card('feishu')).getByRole('switch', { name: /启用飞书机器人/ })).toBeDisabled()
  })

  it('无需凭据的渠道开关可直接拨动', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    const chatAppSwitch = within(card('chat_app')).getByRole('switch', { name: '启用对话网页' })
    expect(chatAppSwitch).not.toBeDisabled()

    await user.click(chatAppSwitch)
    await waitFor(() => expect(chatAppSwitch).toBeChecked())
  })

  it('启用状态进入发布 payload', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    renderWithProviders(<PublishTab {...props} />)

    await user.click(within(card('a2a')).getByRole('switch', { name: '启用 A2A 协议' }))
    await user.click(screen.getByRole('button', { name: /发布/ }))

    await waitFor(() => expect(props.onPublishConfirm).toHaveBeenCalled())
    const config = props.onPublishConfirm.mock.calls[0][0]
    expect(config.channels).toContain('a2a')
  })

  it.each([
    ['glab', '启用 GitLab 触发'],
    ['gh', '启用 GitHub 触发'],
  ])('%s 开关进入发布 payload 的 channels', async (key, switchName) => {
    // Regression: the switch, its config column and the API's start/stop wiring
    // were all in place, but buildChannels() never appended these two keys — so
    // publishing persisted the config while publishChannels omitted the
    // provider, and the API (which starts a poll only when the channel is in
    // that array) silently started nothing. The headline feature was
    // unreachable from the normal publish flow, and no test noticed.
    const user = userEvent.setup()
    const props = baseProps()
    renderWithProviders(<PublishTab {...props} />)

    // The switch is gated until the channel is configured. The intent arrives
    // prefilled, so the repository URL is the only field left to supply.
    await openConfig(user, key)
    await user.type(
      screen.getByPlaceholderText(
        key === 'glab'
          ? 'https://gitlab.example.com/group/subgroup/repo'
          : 'https://github.com/owner/repo',
      ),
      'https://git.example.com/group/repo',
    )
    await user.click(screen.getByRole('button', { name: '取消' }))

    const toggle = within(card(key)).getByRole('switch', { name: switchName })
    expect(toggle).not.toBeDisabled()
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: /发布/ }))

    await waitFor(() => expect(props.onPublishConfirm).toHaveBeenCalled())
    const config = props.onPublishConfirm.mock.calls[0][0]
    expect(config.channels).toContain(key)
    // The config must ride along in the same payload, or publish would enable a
    // channel the API then refuses to start for lack of a config. The pasted
    // URL must reach it already split into the host and project the CLI needs,
    // and the prefilled intent must survive as a non-empty template.
    const saved = config[key === 'glab' ? 'glabConfig' : 'ghConfig']
    expect(saved).toMatchObject({
      provider: key,
      repos: [{ host: 'git.example.com', project: 'group/repo' }],
    })
    expect(saved.intent).toContain('{{url}}')
  })

  it('点「配置」打开对应渠道的弹窗', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    // 配置表单在弹窗打开前不渲染。
    expect(screen.queryByText('App ID')).not.toBeInTheDocument()

    await openConfig(user, 'feishu')
    await waitFor(() => expect(screen.getByText('App ID')).toBeInTheDocument())
  })

  it('弹窗内不再有渠道启用开关（避免与卡片开关重名）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    await openConfig(user, 'chat_app')
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    // 卡片上那个仍在，但弹窗里不能再出现同名开关——否则 Playwright 严格模式直接报错。
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('switch', { name: '启用对话网页' })).not.toBeInTheDocument()
  })

  it('弹窗提示哪些设置必须走发布才生效', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PublishTab {...baseProps()} />)

    // 「以当前登录身份运行」是 Agent 上的扁平列，不属于 scheduleConfig，
    // 按渠道保存写不了它——必须提示用户，而不是让保存悄悄丢掉这次改动。
    await openConfig(user, 'schedule')
    expect(screen.queryByText(/需点击「发布」后才会生效/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: '以当前登录身份运行' }))
    await waitFor(() => expect(screen.getByText(/需点击「发布」后才会生效/)).toBeInTheDocument())
  })

  it('关掉「以当前登录身份运行」同样提示需要发布', async () => {
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
            publishChannels: ['api', 'schedule'],
            endpointApiKey: '********',
            // 服务端原值为 true——用户此时的意图是「关掉」。
            scheduleRunAsOwner: true,
            scheduleConfig: [{ id: 's1', cron: '0 9 * * *', intent: '每日巡检', timezone: 'UTC' }],
          } as never
        }
      />,
    )

    await openConfig(user, 'schedule')
    expect(screen.queryByText(/需点击「发布」后才会生效/)).not.toBeInTheDocument()

    // 之前只判断「当前值为 true」，于是关掉开关反而让提示消失——恰恰是最该提示的时候。
    await user.click(screen.getByRole('switch', { name: '以当前登录身份运行' }))
    await waitFor(() => expect(screen.getByText(/需点击「发布」后才会生效/)).toBeInTheDocument())
  })

  it('URL 带 publishTab 时自动打开对应弹窗', async () => {
    // 新手引导与 chat-app E2E 都靠这个深链拿到表单里的输入框。
    renderWithProviders(<PublishTab {...baseProps()} />, {
      routerProps: { initialEntries: ['/agents/agt_test1?tab=publish&publishTab=feishu'] },
    })

    await waitFor(() => expect(screen.getByText('App ID')).toBeInTheDocument())
  })

  it('深链打开飞书弹窗时新手引导的 data-tour 锚点均存在', async () => {
    renderWithProviders(<PublishTab {...baseProps()} />, {
      routerProps: { initialEntries: ['/agents/agt_test1?tab=publish&publishTab=feishu'] },
    })

    await waitFor(() => expect(screen.getByText('App ID')).toBeInTheDocument())

    // onboarding-tour.tsx 按选择器驱动整个 FTUE；锚点丢了引导会静默卡住。
    expect(document.querySelector('[data-tour="feishu-enable"]')).not.toBeNull()
    expect(document.querySelector('[data-tour="feishu-app-id"]')).not.toBeNull()
    expect(document.querySelector('[data-tour="feishu-app-secret"]')).not.toBeNull()
    expect(document.querySelector('[data-tour="publish-btn"]')).not.toBeNull()
  })

  describe('首帧即反映已保存配置', () => {
    /**
     * Regression: every toggle started at `false` and was corrected by an
     * effect, which runs *after* the first paint. Refreshing a published agent
     * therefore rendered the whole grid switched off and greyed out, then
     * flipped it on a frame later — reading as the page turning the user's
     * channels off and back on. These assertions run synchronously, with no
     * `waitFor`, so they only pass if the first render is already correct.
     */
    const publishedAgent = {
      id: 'agt_test1',
      publishStatus: 'published',
      publishChannels: ['feishu', 'schedule', 'glab', 'chat_app'],
      feishuConfig: { appId: 'cli_demo', appSecret: 'secret-value' },
      scheduleConfig: [
        { id: 'sch_1', cron: '0 9 * * *', intent: '每日巡检', timezone: 'Asia/Shanghai' },
      ],
      glabConfig: {
        provider: 'glab',
        repos: [{ project: 'group/repo', host: 'gitlab.example.com' }],
        events: ['opened'],
        intervalSeconds: 60,
        intent: 'review {{url}}',
        targetBranches: [],
        ignoreDrafts: true,
      },
    }

    it('已启用的渠道开关在首帧即为开启', () => {
      renderWithProviders(<PublishTab {...baseProps()} agent={publishedAgent as never} />)

      for (const [key, name] of [
        ['feishu', /启用飞书机器人/],
        ['schedule', /启用定时触发/],
        ['glab', /启用 GitLab 触发/],
      ] as const) {
        const toggle = within(card(key)).getByRole('switch', { name })
        expect(toggle, `${key} 首帧未开启`).toBeChecked()
      }
    })

    it('已配置的渠道开关在首帧即为可用（不是禁用态）', () => {
      renderWithProviders(<PublishTab {...baseProps()} agent={publishedAgent as never} />)

      // 禁用态会把「请先完成该渠道的配置」拼进 aria-label，因此这里用精确名匹配：
      // 名字带后缀即说明首帧是灰的。
      expect(within(card('feishu')).getByRole('switch', { name: '启用飞书机器人' })).toBeEnabled()
      expect(within(card('glab')).getByRole('switch', { name: '启用 GitLab 触发' })).toBeEnabled()
    })

    it('未配置的渠道首帧仍为关闭且禁用', () => {
      // gh 没有任何配置，禁用是正确结果——种子化不能把「未配置」也点亮。
      renderWithProviders(<PublishTab {...baseProps()} agent={publishedAgent as never} />)
      const toggle = within(card('gh')).getByRole('switch', {
        name: /启用 GitHub 触发/,
      })
      expect(toggle).not.toBeChecked()
      expect(toggle).toBeDisabled()
    })
  })
})
