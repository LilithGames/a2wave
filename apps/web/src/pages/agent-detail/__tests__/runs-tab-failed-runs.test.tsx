import userEvent from '@testing-library/user-event'
import { useSearchParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen, waitFor } from '@/test/render'

/**
 * The "retry all failed" action lives next to the tab's refresh button, outside
 * this tab, so the page it acts on can only come from here. Reporting the wrong
 * set would replay Runs the operator never saw — hence the pin on which Runs of
 * the current page are handed up.
 */

const useRunsMock = vi.fn()

vi.mock('@/hooks/use-runs', () => ({
  useRunSessions: (...args: unknown[]) => useRunsMock(...args),
  useRunSession: () => ({ data: undefined, isLoading: false }),
}))

vi.mock('@/components/run-session-detail-drawer', () => ({
  RunSessionDetailDrawer: ({ runId, open }: { runId: string | null; open: boolean }) =>
    open ? <div data-testid="session-drawer">{runId}</div> : null,
}))

const { RunsTab } = await import('../runs-tab')

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

function session(id: string, status: string, failedRunIds: string[] = []) {
  return {
    id,
    conversationId: `cvs_${id}`,
    status,
    latestRun: {
      id,
      status,
      intent: `intent ${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      triggerUserName: null,
      triggerAgentName: null,
      triggerSource: null,
    },
    runCount: 1,
    turnCount: 1,
    failedCount: failedRunIds.length,
    failedRunIds,
    hasActiveRun: status === 'running',
    activeRunId: status === 'running' ? id : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('RunsTab failed-run reporting', () => {
  beforeEach(() => {
    useRunsMock.mockReset()
  })

  it('hands up only the failed Runs of the current page', async () => {
    useRunsMock.mockReturnValue({
      data: {
        data: [
          session('run_3', 'failed', ['run_3', 'run_2']),
          session('run_1', 'completed', ['run_1']),
        ],
        pagination: { page: 1, pageSize: 15, total: 3, totalPages: 1 },
      },
      dataUpdatedAt: 1_700_000_000_000,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    })
    const onFailedRunIdsChange = vi.fn()

    renderWithProviders(<RunsTab agentId="agt_1" onFailedRunIdsChange={onFailedRunIdsChange} />)

    await waitFor(() =>
      expect(onFailedRunIdsChange).toHaveBeenCalledWith(
        ['run_3', 'run_2', 'run_1'],
        expect.any(Number),
      ),
    )
  })

  it('reports an empty set while the page is still loading', async () => {
    useRunsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      refetch: vi.fn(),
    })
    const onFailedRunIdsChange = vi.fn()

    renderWithProviders(<RunsTab agentId="agt_1" onFailedRunIdsChange={onFailedRunIdsChange} />)

    await waitFor(() => expect(onFailedRunIdsChange).toHaveBeenCalledWith([], expect.any(Number)))
  })

  it('closes a deep-linked drawer when browser state removes runId', async () => {
    const user = userEvent.setup()
    useRunsMock.mockReturnValue({
      data: { data: [session('run_1', 'completed')], pagination: undefined },
      dataUpdatedAt: 1,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    })
    renderWithProviders(
      <>
        <RunsTab agentId="agt_1" />
        <ClearRunId />
      </>,
      { routerProps: { initialEntries: ['/?runId=run_old'] } },
    )

    await screen.findByTestId('session-drawer')
    await user.click(screen.getByRole('button', { name: 'clear run id' }))
    await waitFor(() => expect(screen.queryByTestId('session-drawer')).not.toBeInTheDocument())
  })

  it('shows a retryable error instead of the empty state when sessions fail to load', async () => {
    const user = userEvent.setup()
    const refetch = vi.fn()
    useRunsMock.mockReturnValue({
      data: undefined,
      dataUpdatedAt: 0,
      isLoading: false,
      isFetching: false,
      isError: true,
      refetch,
    })

    renderWithProviders(<RunsTab agentId="agt_1" />)
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('runs.loadFailed'))
    await user.click(screen.getByRole('button', { name: i18n.t('runs.retryLoad') }))
    expect(refetch).toHaveBeenCalledOnce()
  })
})
