import userEvent from '@testing-library/user-event'
import { useSearchParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen, waitFor } from '@/test/render'

const useRunSessionsMock = vi.fn()

vi.mock('@/hooks/use-runs', () => ({
  useRunSessions: (...args: unknown[]) => useRunSessionsMock(...args),
}))

vi.mock('@/hooks/use-agents', () => ({
  useAllAgents: () => ({ data: { data: [] } }),
}))

vi.mock('@/components/run-session-detail-drawer', () => ({
  RunSessionDetailDrawer: ({ runId, open }: { runId: string | null; open: boolean }) =>
    open ? <div data-testid="session-drawer">{runId}</div> : null,
}))

const { RunsPage } = await import('../runs')

function ClearRunId() {
  const [searchParams, setSearchParams] = useSearchParams()
  return (
    <button
      type="button"
      onClick={() => {
        const next = new URLSearchParams(searchParams)
        next.delete('runId')
        setSearchParams(next)
      }}
    >
      clear run id
    </button>
  )
}

const session = {
  id: 'run_latest',
  conversationId: 'cvs_1',
  status: 'completed' as const,
  latestRun: {
    id: 'run_latest',
    intent: 'latest question in this conversation',
    status: 'completed' as const,
    agentName: 'Support Agent',
    agentIcon: '🤖',
    createdAt: new Date('2026-08-14T00:02:00.000Z'),
    updatedAt: new Date('2026-08-14T00:02:30.000Z'),
  },
  runCount: 2,
  turnCount: 2,
  failedCount: 0,
  failedRunIds: [],
  hasActiveRun: false,
  activeRunId: null,
  createdAt: new Date('2026-08-14T00:00:00.000Z'),
  updatedAt: new Date(),
}

describe('RunsPage session list', () => {
  beforeEach(() => {
    useRunSessionsMock.mockReset()
    useRunSessionsMock.mockReturnValue({
      data: {
        data: [session],
        pagination: { total: 21, page: 1, pageSize: 20, totalPages: 2 },
      },
      isLoading: false,
    })
  })

  it('renders one row per session and opens the session transcript', async () => {
    const user = userEvent.setup()
    renderWithProviders(<RunsPage />)

    const row = screen.getByRole('button', {
      name: i18n.t('runs.openSession', {
        intent: session.latestRun.intent,
        turns: i18n.t('runs.turnCount', { count: session.turnCount }),
        failures: i18n.t('runs.failedTurnCount', { count: session.failedCount }),
        status: i18n.t('dashboard.statusCompleted'),
      }),
    })
    await user.click(row)

    expect(screen.getByTestId('session-drawer')).toHaveTextContent('run_latest')
    expect(
      screen.getByText(i18n.t('runs.sessionPaginationTotal', { total: 21 })),
    ).toBeInTheDocument()
  })

  it('keeps an old runId deep link as the session detail anchor', async () => {
    renderWithProviders(<RunsPage />, { routerProps: { initialEntries: ['/runs?runId=run_old'] } })

    await waitFor(() => expect(screen.getByTestId('session-drawer')).toHaveTextContent('run_old'))
  })

  it('closes a deep-linked drawer when browser state removes runId', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <RunsPage />
        <ClearRunId />
      </>,
      { routerProps: { initialEntries: ['/runs?runId=run_old'] } },
    )

    await screen.findByTestId('session-drawer')
    await user.click(screen.getByRole('button', { name: 'clear run id' }))
    await waitFor(() => expect(screen.queryByTestId('session-drawer')).not.toBeInTheDocument())
  })

  it('shows a retryable error instead of an empty list when sessions fail to load', async () => {
    const user = userEvent.setup()
    const refetch = vi.fn()
    useRunSessionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    })

    renderWithProviders(<RunsPage />)
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('runs.loadFailed'))
    await user.click(screen.getByRole('button', { name: i18n.t('runs.retryLoad') }))
    expect(refetch).toHaveBeenCalledOnce()
  })
})
