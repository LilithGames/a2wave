import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@/components/theme-provider'
import { renderWithProviders, screen, waitFor, within } from '@/test/render'
import { CLI_INSTALL_COMMAND, UserMenu } from '../user-menu'

const { messageSuccess, messageError } = vi.hoisted(() => ({
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
}))

vi.mock('@/lib/antd-static', () => ({
  message: { success: messageSuccess, error: messageError },
  AntdStaticBridge: () => null,
}))

const { authState, logout } = vi.hoisted(() => ({
  authState: {
    user: { username: 'testadmin', role: 'admin', locale: 'zh' } as Record<string, unknown>,
    oauthConfig: { enabled: false } as Record<string, unknown>,
  },
  logout: vi.fn(),
}))

vi.mock('@/hooks/use-auth', () => ({
  useCurrentUser: () => ({ data: authState.user }),
  useOauthConfig: () => ({ data: authState.oauthConfig }),
  useLogout: () => logout,
  useUpdateLocale: () => ({ mutate: vi.fn() }),
  useChangePassword: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

const { copyText } = vi.hoisted(() => ({ copyText: vi.fn() }))

vi.mock('@/lib/clipboard', () => ({ copyText: (text: string) => copyText(text) }))

beforeEach(() => {
  authState.user = { username: 'testadmin', role: 'admin', locale: 'zh' }
  authState.oauthConfig = { enabled: false }
  logout.mockReset()
})

describe('UserMenu — menu chrome', () => {
  it('rings the popover panel so its edge is visible against the sidebar', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )
    await user.click(screen.getByRole('button', { name: /testadmin/ }))

    const panel = (await screen.findByTestId('user-menu-popover')).closest('.ant-popover')
    expect(panel?.className).toContain('[&_.ant-popover-container]:ring-1')

    // The ring must land on the node that carries the radius. `.ant-popover-content`
    // is a transparent, square wrapper around it, so ringing that one drew a hard
    // rectangle inside the rounded panel. Assert the target has a radius so a
    // future antd upgrade that moves it fails here instead of shipping visibly wrong.
    const surface = panel?.querySelector('.ant-popover-container')
    expect(surface).not.toBeNull()
    const styles = getComputedStyle(surface as Element)
    expect(styles.borderRadius).not.toBe('')
    expect(
      getComputedStyle(panel?.querySelector('.ant-popover-content') as Element).borderRadius,
    ).toBe('')
  })

  it('renders the manual link in the default text color, not link-blue', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )
    await user.click(screen.getByRole('button', { name: /testadmin/ }))

    // As an <a> it inherits the global link-blue `a` reset, which made it the only
    // tinted row among otherwise identical-looking menu entries.
    const manual = await screen.findByRole('link', { name: /使用手册/ })
    expect(manual.className).toContain('text-foreground')
  })

  it('separates account actions from the resource links with a divider', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )
    await user.click(screen.getByRole('button', { name: /testadmin/ }))

    const panel = await screen.findByTestId('user-menu-popover')
    const rows = Array.from(panel.children)
    const changePw = rows.findIndex((el) => el.textContent === '修改密码')
    const getCli = rows.findIndex((el) => el.textContent === '获取 CLI')

    expect(changePw).toBeGreaterThanOrEqual(0)
    expect(getCli).toBeGreaterThan(changePw)
    // Scoped to the gap between the two rows: the menu has other dividers
    // (below the identity header, above logout), so a global search would
    // pass on one of those and assert nothing about this separation.
    const between = rows.slice(changePw + 1, getCli)
    expect(between.some((el) => el.className.includes('h-px'))).toBe(true)
  })
})

describe('UserMenu — get CLI', () => {
  beforeEach(() => {
    messageSuccess.mockReset()
    messageError.mockReset()
    copyText.mockReset()
    copyText.mockResolvedValue(true)
  })

  it('copies the CLI install command and toasts on success', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    await user.click(screen.getByRole('button', { name: /testadmin/ }))
    await user.click(await screen.findByRole('button', { name: '获取 CLI' }))

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith(CLI_INSTALL_COMMAND)
    })
    // Exact, not a substring: `toContain('a2wave')` would still pass if the
    // package name regressed to the old `a2wave-cli`.
    expect(CLI_INSTALL_COMMAND).toBe('npm i -g a2wave')
    // The command is copied straight into a user's terminal, so it must never
    // carry an internal scope or registry host.
    expect(CLI_INSTALL_COMMAND).not.toMatch(/@lilith|lilithgame|cnpm|--registry/i)
    expect(messageSuccess).toHaveBeenCalledWith('已复制 CLI 安装命令')
  })

  it('toasts an error when the clipboard write fails', async () => {
    copyText.mockResolvedValue(false)
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    await user.click(screen.getByRole('button', { name: /testadmin/ }))
    await user.click(await screen.findByRole('button', { name: '获取 CLI' }))

    await waitFor(() => {
      expect(messageError).toHaveBeenCalledWith('复制失败，请手动复制安装命令')
    })
    expect(messageSuccess).not.toHaveBeenCalled()
  })

  it('opens the personal theme picker from the user menu', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    await user.click(screen.getByRole('button', { name: /testadmin/ }))
    await user.click(await screen.findByRole('button', { name: '外观与主题' }))

    expect(await screen.findByRole('heading', { name: '外观与主题' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Neo Yellow/ })).toBeInTheDocument()
  })

  it('keeps the collapsed trigger discoverable by its user name', () => {
    renderWithProviders(
      <ThemeProvider>
        <UserMenu collapsed />
      </ThemeProvider>,
    )

    expect(screen.getByRole('button', { name: 'testadmin' })).toBeInTheDocument()
  })

  it('keeps the language submenu inside a narrow viewport', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu collapsed />
      </ThemeProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'testadmin' }))
    const englishOption = await screen.findByRole('button', { name: 'English' })
    const languageSubmenu = englishOption.parentElement

    expect(languageSubmenu).toHaveClass('right-0', 'bottom-full')
    expect(languageSubmenu).toHaveClass('sm:left-full', 'sm:bottom-0')
    expect(languageSubmenu).not.toHaveClass('left-full')
  })
})

describe('UserMenu — user manual entry', () => {
  it('links to the manual and sits directly above About', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    await user.click(screen.getByRole('button', { name: /testadmin/ }))

    // A real link, so cmd/middle-click can open the manual in a new tab.
    const manual = await screen.findByRole('link', { name: '使用手册' })
    expect(manual).toHaveAttribute('href', '/wiki')

    // Placement requirement: the manual sits above "关于".
    const about = screen.getByRole('button', { name: '关于' })
    expect(manual.compareDocumentPosition(about)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})

describe('UserMenu — enterprise identity', () => {
  const ssoConfig = {
    enabled: true,
    ssoUrl: 'https://idp.example.com/authorize',
    methods: [{ type: 'oidc', loginUrl: '/api/auth/oidc/login' }],
  }

  const boundUser = (idaasProtocol: string | null) => ({
    username: 'testadmin',
    role: 'admin',
    locale: 'zh',
    idaasBound: true,
    idaasProtocol,
  })

  it('names the protocol the server recorded for the binding', async () => {
    authState.user = boundUser('oidc')
    authState.oauthConfig = ssoConfig
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    expect(screen.getByRole('button', { name: /testadmin/ })).toHaveAccessibleDescription(
      '企业身份已绑定（OIDC）',
    )

    await user.click(screen.getByRole('button', { name: /testadmin/ }))
    await screen.findByRole('button', { name: '关于' })
    expect(screen.queryByRole('button', { name: '企业身份已绑定' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '绑定企业身份' })).not.toBeInTheDocument()
  })

  it('renders SAML from the stored value, not from the enabled login methods', () => {
    // The deployment advertises OIDC only, but this identity was bound via SAML.
    // Inferring from `methods` would mislabel it — the whole reason the protocol
    // is persisted server-side.
    authState.user = boundUser('saml')
    authState.oauthConfig = ssoConfig
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    expect(screen.getByRole('button', { name: /testadmin/ })).toHaveAccessibleDescription(
      '企业身份已绑定（SAML）',
    )
    expect(screen.getByText('saml')).toBeInTheDocument()
  })

  it('shows the generic badge for rows predating the column', () => {
    // Null protocol = bound before the column existed: still bound, protocol
    // unknown, so the compact SSO glyph rather than a guessed name.
    authState.user = boundUser(null)
    authState.oauthConfig = ssoConfig
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    const trigger = screen.getByRole('button', { name: /testadmin/ })
    expect(trigger).toHaveAccessibleDescription('企业身份已绑定')
    expect(screen.getByText('SSO')).toBeInTheDocument()
  })

  it('keeps the badge out of the trigger button’s accessible name', () => {
    // A role="img" descendant contributes its aria-label to the button's
    // name-from-contents, turning the control's name into an enumeration of state
    // ("A · Name · 企业身份已绑定（OIDC） · admin") instead of an action.
    authState.user = boundUser('oidc')
    authState.oauthConfig = ssoConfig
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    const trigger = screen.getByRole('button', { name: /testadmin/ })
    expect(trigger).not.toHaveAccessibleName(/企业身份已绑定/)
    // ...but the state is still announced — as a description, after the name.
    expect(trigger).toHaveAccessibleDescription('企业身份已绑定（OIDC）')
  })

  it('offers the bind row on an OIDC-only deployment (no jwt-redirect ssoUrl)', async () => {
    // Regression: gating on the top-level `ssoUrl` hid this entry entirely on
    // OIDC-only / SAML-only deployments, since the server only publishes that
    // field for jwt-redirect — even though it handles purpose=bind for all three.
    authState.oauthConfig = {
      enabled: true,
      ssoUrl: null,
      methods: [{ type: 'oidc', loginUrl: '/api/auth/oidc/login' }],
    }
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    await user.click(screen.getByRole('button', { name: /testadmin/ }))
    expect(await screen.findByRole('button', { name: '绑定企业身份' })).toBeInTheDocument()
  })

  it('hides the bind row when no SSO method is configured at all', async () => {
    authState.oauthConfig = { enabled: false }
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    await user.click(screen.getByRole('button', { name: /testadmin/ }))
    await screen.findByRole('button', { name: '关于' })
    expect(screen.queryByRole('button', { name: '绑定企业身份' })).not.toBeInTheDocument()
  })

  it('keeps the actionable bind row while the identity is unbound', async () => {
    authState.oauthConfig = ssoConfig
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    expect(screen.queryByLabelText(/企业身份已绑定/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /testadmin/ }))
    expect(await screen.findByRole('button', { name: '绑定企业身份' })).toBeInTheDocument()
  })

  it('keeps the bind state reachable when the sidebar is collapsed', async () => {
    // Below 640px the sidebar is force-collapsed with no way to expand, so a
    // badge that only rendered on the trigger would make the bind state
    // completely unreachable on mobile.
    authState.user = boundUser('oidc')
    authState.oauthConfig = ssoConfig
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu collapsed />
      </ThemeProvider>,
    )

    // The status node renders outside the trigger and regardless of `collapsed`,
    // so the bind state is announced even on the mobile icon rail where the name
    // and badge glyph are hidden.
    expect(screen.getByRole('button', { name: 'testadmin' })).toHaveAccessibleDescription(
      '企业身份已绑定（OIDC）',
    )

    // The visible glyph is still reachable by opening the menu.
    await user.click(screen.getByRole('button', { name: 'testadmin' }))
    expect(await screen.findByText('oidc')).toBeInTheDocument()
  })

  it('announces the bind state once when expanded', async () => {
    // The badge renders on both the trigger and the menu header; only one may
    // carry the accessible name or assistive tech reads it twice. The name stays
    // on the always-visible trigger so it is reachable without opening the menu.
    authState.user = boundUser('oidc')
    authState.oauthConfig = ssoConfig
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )

    await user.click(screen.getByRole('button', { name: /testadmin/ }))
    await screen.findByRole('button', { name: '关于' })

    // Two badge glyphs render (trigger + menu header) but both are aria-hidden,
    // so the state reaches assistive tech exactly once — via the description.
    expect(screen.getAllByText('企业身份已绑定（OIDC）')).toHaveLength(1)
  })
})

describe('UserMenu — logout confirmation', () => {
  async function openLogoutConfirm() {
    const user = userEvent.setup()
    renderWithProviders(
      <ThemeProvider>
        <UserMenu />
      </ThemeProvider>,
    )
    await user.click(screen.getByRole('button', { name: /testadmin/ }))
    await user.click(await screen.findByRole('button', { name: '退出登录' }))
    return user
  }

  it('does not sign out until the confirmation is accepted', async () => {
    const user = await openLogoutConfirm()

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: '确认退出登录？' })).toBeInTheDocument()
    expect(logout).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: '退出登录' }))
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('cancelling leaves the session signed in', async () => {
    const user = await openLogoutConfirm()

    await screen.findByRole('heading', { name: '确认退出登录？' })
    // antd v6 spaces out two-character CJK labels ("取 消"), so match loosely.
    await user.click(screen.getByRole('button', { name: /取\s*消/ }))

    expect(logout).not.toHaveBeenCalled()
  })
})
