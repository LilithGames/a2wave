import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen } from '@/test/render'
import { ProviderDetailPage } from '../provider-detail'

/**
 * The Agent CLI card on this page replaced the standalone Agent CLI page as the
 * place an admin manages a Provider's execution engine, so it carries that
 * page's obligations: say when the CLI catalog cannot be read, rather than
 * folding the failure into "this Provider has no CLI".
 */

const {
  useProviderMock,
  useProviderDependentsMock,
  useUpdateProviderMock,
  useProviderClisMock,
  useCurrentUserMock,
} = vi.hoisted(() => ({
  useProviderMock: vi.fn(),
  useProviderDependentsMock: vi.fn(),
  useUpdateProviderMock: vi.fn(),
  useProviderClisMock: vi.fn(),
  useCurrentUserMock: vi.fn(),
}))

vi.mock('@/hooks/use-providers', () => ({
  useProvider: useProviderMock,
  useProviderDependents: useProviderDependentsMock,
  useUpdateProvider: useUpdateProviderMock,
}))

vi.mock('@/hooks/use-auth', () => ({ useCurrentUser: useCurrentUserMock }))

vi.mock('@/hooks/use-provider-clis', () => ({
  useProviderClis: useProviderClisMock,
  useInstallProviderCli: () => ({ mutate: vi.fn(), isPending: false }),
  useUninstallProviderCli: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/components/codex-quota', () => ({
  CodexQuotaDisplay: ({ providerId }: { providerId: string }) => (
    <div data-testid="codex-quota">{providerId}</div>
  ),
}))

vi.mock('@/lib/antd-static', () => ({ message: { success: vi.fn(), error: vi.fn() } }))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useParams: () => ({ id: 'prv_codex' }) }
})

function cliState(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'codex',
    binary: 'codex',
    lockedVersion: '0.144.5',
    installType: 'npm',
    installed: true,
    installedVersion: '0.144.5',
    matchesLock: true,
    lockDrift: 'match',
    status: 'idle',
    lastError: null,
    lastOutput: null,
    ...overrides,
  }
}

describe('ProviderDetailPage — Agent CLI card', () => {
  beforeEach(() => {
    useProviderMock.mockReturnValue({
      data: {
        id: 'prv_codex',
        kind: 'codex',
        name: 'Codex CLI',
        description: 'OpenAI Codex CLI',
        isPreset: true,
        initScript: '',
        checkScript: '',
      },
      isLoading: false,
    })
    useProviderDependentsMock.mockReturnValue({ data: [] })
    useUpdateProviderMock.mockReturnValue({ mutate: vi.fn(), isPending: false })
    useCurrentUserMock.mockReturnValue({ data: { role: 'admin' } })
    useProviderClisMock.mockReturnValue({
      data: { data: [cliState()], meta: {} },
      isError: false,
      refetch: vi.fn(),
    })
  })

  it('shows account quota only for Codex administrators', () => {
    const { unmount } = renderWithProviders(<ProviderDetailPage />)
    expect(screen.getByTestId('codex-quota')).toHaveTextContent('prv_codex')
    unmount()
    useCurrentUserMock.mockReturnValue({ data: { role: 'user' } })
    renderWithProviders(<ProviderDetailPage />)
    expect(screen.queryByTestId('codex-quota')).not.toBeInTheDocument()
  })

  it('does not query Codex quota for other providers', () => {
    useProviderMock.mockReturnValue({
      data: { id: 'prv_claude', kind: 'claude-code', name: 'Claude Code' },
    })
    useProviderClisMock.mockReturnValue({ data: { data: [cliState({ kind: 'claude-code' })] } })
    renderWithProviders(<ProviderDetailPage />)
    expect(screen.queryByTestId('codex-quota')).not.toBeInTheDocument()
  })

  it('shows the pinned and installed versions for the bound CLI', () => {
    renderWithProviders(<ProviderDetailPage />)

    expect(screen.getByText('codex')).toBeInTheDocument()
    expect(screen.getByText(/0\.144\.5/)).toBeInTheDocument()
  })

  /**
   * Regression: reading only `data` folded a failed request into `cli ===
   * undefined`, which renders identically to a healthy Provider — no card, no
   * error, no way to install — while its Agents fail at spawn time with ENOENT.
   */
  it('reports a failed CLI status read instead of hiding the card', () => {
    useProviderClisMock.mockReturnValue({
      data: undefined,
      isError: true,
      refetch: vi.fn(),
    })

    renderWithProviders(<ProviderDetailPage />)

    expect(screen.getByText('无法获取 Agent CLI 状态，请重试。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('omits the card entirely for a non-admin, who cannot act on it anyway', () => {
    useCurrentUserMock.mockReturnValue({ data: { role: 'user' } })
    useProviderClisMock.mockReturnValue({ data: undefined, isError: false, refetch: vi.fn() })

    renderWithProviders(<ProviderDetailPage />)

    expect(screen.queryByText('Agent CLI')).not.toBeInTheDocument()
    expect(screen.queryByText('无法获取 Agent CLI 状态，请重试。')).not.toBeInTheDocument()
  })
})
