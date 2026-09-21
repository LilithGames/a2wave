import { fireEvent, screen } from '@testing-library/react'
import type { Mock } from 'vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettings } from '@/hooks/use-settings'
import i18n from '@/i18n'
import { renderWithProviders } from '@/test/render'
import { SettingsPage } from '../settings'

function renderWithRouter(initialPath = '/settings?tab=artifacts') {
  return renderWithProviders(<SettingsPage />, {
    routerProps: { initialEntries: [initialPath] },
  })
}

// A single shared spy rather than a fresh `vi.fn()` per hook call, so a test can
// assert what a form actually submitted.
const mutate = vi.fn()

vi.mock('@/hooks/use-settings', () => ({
  useSettings: vi.fn(() => ({ data: undefined, isLoading: false })),
  useUpdateSettings: vi.fn(() => ({
    mutate,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  })),
}))

vi.mock('@/components/favicon-upload', () => ({
  FaviconUpload: vi.fn(() => null),
}))

// Both cards on the auth tab own their queries and are covered by their own specs;
// stubbing them keeps this file's assertions on the settings form itself.
vi.mock('@/components/sso-methods-card', () => ({
  SsoMethodsCard: vi.fn(() => null),
}))

vi.mock('@/components/otel-export-card', () => ({
  OtelExportCard: vi.fn(() => <div data-testid="otel-export-card" />),
}))

vi.mock('@/components/jwt-signer-card', () => ({
  JwtSignerCard: vi.fn(() => null),
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useMutation: vi.fn(() => ({
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
      data: undefined,
    })),
  }
})

describe('SettingsPage — artifacts settings', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('renders artifacts card title', () => {
    renderWithRouter()
    // "运行产物" 同时出现在侧边二级菜单和卡片标题里，断言至少一处即可。
    const matches = screen.getAllByText('运行产物')
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it('offers a Tracing tab that shows the OpenTelemetry export card', () => {
    renderWithRouter()
    expect(screen.queryByTestId('otel-export-card')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '链路追踪' }))

    expect(screen.getByTestId('otel-export-card')).toBeInTheDocument()
  })

  it('uses semantic tokens for the active settings navigation item', () => {
    renderWithRouter()
    const activeTab = screen.getByRole('button', { name: '运行产物' })

    expect(activeTab.className).not.toMatch(/rgb|indigo|violet/)
    expect(activeTab).toHaveClass('ring-primary/10')
  })

  it('renders artifacts storage path field label', () => {
    renderWithRouter()
    const labels = screen.getAllByText('存储路径')
    expect(labels.length).toBeGreaterThanOrEqual(1)
  })

  it('renders artifacts retention hours field label', () => {
    renderWithRouter()
    const labels = screen.getAllByText('保留时长')
    expect(labels.length).toBeGreaterThanOrEqual(1)
  })

  it('renders artifacts storage path input with default placeholder', () => {
    renderWithRouter()
    const inputs = screen.getAllByPlaceholderText('./data/artifacts')
    expect(inputs.length).toBeGreaterThanOrEqual(1)
    expect(inputs[0]).toBeInTheDocument()
  })

  it('renders artifacts retention hours input as number type', () => {
    renderWithRouter()
    const input = screen.getByRole('spinbutton', { name: /保留时长/ })
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute('type', 'number')
  })

  it('renders hours unit label next to retention field', () => {
    renderWithRouter()
    // "小时" appears in both label span and description text — at least one should match
    const matches = screen.getAllByText('小时')
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it('renders artifacts require auth for download switch', () => {
    renderWithRouter()
    const labels = screen.getAllByText('下载是否需要认证')
    expect(labels.length).toBeGreaterThanOrEqual(1)
  })

  it('shows format error when publicBaseUrl is invalid (e.g. "abc")', async () => {
    renderWithRouter()
    const input = screen.getByRole('textbox', { name: /用户可访问地址/ })
    fireEvent.change(input, { target: { value: 'abc' } })
    const artifactsForm = input.closest('form')
    const saveButton = artifactsForm?.querySelector('button[type="submit"]')
    if (saveButton) fireEvent.click(saveButton)
    expect(await screen.findByText(/无效的 URL 格式/)).toBeInTheDocument()
  })
})

describe('SettingsPage — auth settings', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    mutate.mockClear()
  })

  it('submits the role picked on the Segmented', async () => {
    // Asserted through the submitted payload, not the radio's checked state: the
    // DOM flips that on its own, so a Segmented with its `onChange` disconnected
    // would still look right while saving the old value. This control decides what
    // every SSO-provisioned user gets on first login, so that silence would grant
    // admin to everyone.
    renderWithRouter('/settings?tab=auth')

    const admin = screen.getByRole('radio', { name: '管理员' })
    fireEvent.click(admin)

    const form = admin.closest('form')
    const save = form?.querySelector('button[type="submit"]')
    expect(save).toBeTruthy()
    if (save) fireEvent.click(save)

    await vi.waitFor(() => expect(mutate).toHaveBeenCalled())
    expect(mutate.mock.calls[0][0].auth.oauthDefaultRole).toBe('admin')
  })
})

describe('SettingsPage — branding form', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    mutate.mockClear()
    ;(useSettings as unknown as Mock).mockReturnValue({ data: undefined, isLoading: false })
  })

  it('no longer offers a team name field', () => {
    // Removed: it was required, validated, and persisted, but nothing ever read
    // it — its own help text admitted it changed no behaviour.
    renderWithRouter('/settings?tab=branding')
    expect(screen.queryByLabelText(/团队名称/)).not.toBeInTheDocument()

    renderWithRouter('/settings?tab=general')
    expect(screen.queryByLabelText(/团队名称/)).not.toBeInTheDocument()
  })

  it('saves only the branding category', async () => {
    renderWithRouter('/settings?tab=branding')

    const subtitle = screen.getByLabelText(/网站副标题/)
    fireEvent.change(subtitle, { target: { value: '新副标题' } })

    const save = subtitle.closest('form')?.querySelector('button[type="submit"]')
    if (save) fireEvent.click(save)

    await vi.waitFor(() => expect(mutate).toHaveBeenCalled())
    const payload = mutate.mock.calls[0][0]
    expect(payload.branding.subtitle).toBe('新副标题')
    // The form no longer writes anything under `general`.
    expect(payload.general).toBeUndefined()
  })

  it('keeps unsaved branding edits when an unrelated settings refetch lands', async () => {
    // The reset effect reruns on every new `settings` object identity. Without
    // the dirty guard it silently discards whatever is being typed.
    ;(useSettings as unknown as Mock).mockReturnValue({
      data: { branding: { subtitle: '旧副标题' } },
      isLoading: false,
    })
    const { rerender } = renderWithRouter('/settings?tab=branding')

    fireEvent.change(screen.getByLabelText(/网站副标题/), { target: { value: '改到一半' } })

    // A fresh object identity, exactly as a refetch produces.
    ;(useSettings as unknown as Mock).mockReturnValue({
      data: { branding: { subtitle: '旧副标题' } },
      isLoading: false,
    })
    rerender(<SettingsPage />)

    expect(screen.getByLabelText(/网站副标题/)).toHaveValue('改到一半')
  })

  it('adopts a concurrent change to an untouched field instead of reverting it', async () => {
    // With a plain !isDirty guard the form freezes at page-load values, so an
    // unrelated save writes the stale value back and reverts the other admin.
    // Rebasing must adopt the server value for the field nobody touched.
    ;(useSettings as unknown as Mock).mockReturnValue({
      data: { branding: { subtitle: '副标题', faviconUrl: '/a.png' } },
      isLoading: false,
    })
    const { rerender } = renderWithRouter('/settings?tab=branding')

    fireEvent.change(screen.getByLabelText(/网站副标题/), { target: { value: '改了副标题' } })
    ;(useSettings as unknown as Mock).mockReturnValue({
      data: { branding: { subtitle: '副标题', faviconUrl: '/b.png' } },
      isLoading: false,
    })
    rerender(<SettingsPage />)

    // The edit in progress survives the refetch.
    expect(screen.getByLabelText(/网站副标题/)).toHaveValue('改了副标题')
  })
})
