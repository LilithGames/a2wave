import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen } from '@/test/render'

const selectedRunIds: Array<string | null> = []
const useRunSessionMock = vi.fn()
const scrollIntoViewMock = vi.fn()

vi.mock('@/hooks/use-runs', () => ({
  useRunSession: (...args: unknown[]) => useRunSessionMock(...args),
}))

vi.mock('@/components/run-detail-drawer', () => ({
  RunDetailDrawer: ({ runId }: { runId: string | null }) => {
    selectedRunIds.push(runId)
    return runId ? <div data-testid="run-detail">{runId}</div> : null
  },
  RunChatContent: ({ run }: { run: { messages?: Array<{ content: string }> } }) => (
    <div>{run.messages?.map((message) => message.content).join(' / ')}</div>
  ),
}))

const { RunSessionDetailDrawer } = await import('../run-session-detail-drawer')

const baseSummary = {
  id: 'run_2',
  conversationId: 'cvs_1',
  status: 'running' as const,
  latestRun: {
    id: 'run_2',
    intent: 'second question',
    status: 'completed' as const,
    createdAt: '2026-08-14T00:02:00.000Z',
    updatedAt: '2026-08-14T00:02:30.000Z',
  },
  runCount: 2,
  turnCount: 2,
  failedCount: 1,
  failedRunIds: ['run_1'],
  hasActiveRun: false,
  activeRunId: null,
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:02:00.000Z',
}

describe('RunSessionDetailDrawer', () => {
  beforeEach(() => {
    selectedRunIds.length = 0
    scrollIntoViewMock.mockReset()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    })
    useRunSessionMock.mockReset()
    useRunSessionMock.mockReturnValue({
      data: {
        summary: baseSummary,
        runs: [
          {
            run: {
              id: 'run_2',
              intent: 'second question',
              status: 'completed',
              createdAt: '2026-08-14T00:02:00.000Z',
              updatedAt: '2026-08-14T00:02:30.000Z',
            },
            messages: [
              { id: 'm3', runId: 'run_2', role: 'user', content: 'second question' },
              { id: 'm4', runId: 'run_2', role: 'agent', content: 'second answer' },
            ],
            steps: [],
            hasFullLog: false,
          },
          {
            run: {
              id: 'run_1',
              intent: 'first question',
              status: 'failed',
              result: { error: 'first turn failed' },
              createdAt: '2026-08-14T00:00:00.000Z',
              updatedAt: '2026-08-14T00:01:00.000Z',
            },
            messages: [{ id: 'm1', runId: 'run_1', role: 'user', content: 'first question' }],
            steps: [],
            hasFullLog: false,
          },
        ],
      },
      isLoading: false,
    })
  })

  it('renders every Run in chronological order and marks the deep-linked Run', () => {
    renderWithProviders(<RunSessionDetailDrawer runId="run_1" open onClose={vi.fn()} />)

    const sections = screen.getAllByTestId('session-run')
    expect(sections.map((section) => section.getAttribute('data-run-id'))).toEqual([
      'run_1',
      'run_2',
    ])
    expect(sections[0]).toHaveAttribute('aria-current', 'true')
    expect(screen.getAllByText('first question')).toHaveLength(2)
    expect(screen.getByText('second question / second answer')).toBeInTheDocument()
    expect(screen.getByTestId('session-status')).toHaveTextContent(
      i18n.t('dashboard.statusRunning'),
    )
  })

  it('opens the existing Run drawer for the chosen round', async () => {
    const user = userEvent.setup()
    renderWithProviders(<RunSessionDetailDrawer runId="run_1" open onClose={vi.fn()} />)

    await user.click(
      screen.getByRole('button', {
        name: i18n.t('runDetail.openRunDetails', { number: 2 }),
      }),
    )

    expect(await screen.findByTestId('run-detail')).toHaveTextContent('run_2')
  })

  it('positions a deep link once without jumping again when polling updates the session', () => {
    const { rerender } = renderWithProviders(
      <RunSessionDetailDrawer runId="run_1" open onClose={vi.fn()} />,
    )
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)

    const current = useRunSessionMock.mock.results.at(-1)?.value.data
    useRunSessionMock.mockReturnValue({
      data: {
        ...current,
        runs: current.runs.map((entry: unknown) => ({ ...(entry as object) })),
      },
      isLoading: false,
    })
    rerender(<RunSessionDetailDrawer runId="run_1" open onClose={vi.fn()} />)
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)

    rerender(<RunSessionDetailDrawer runId="run_2" open onClose={vi.fn()} />)
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(2)
  })

  it('shows a retryable error instead of an empty conversation on request failure', async () => {
    const user = userEvent.setup()
    const refetch = vi.fn()
    useRunSessionMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    })

    renderWithProviders(<RunSessionDetailDrawer runId="run_1" open onClose={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('runDetail.loadConversationFailed'))
    await user.click(screen.getByRole('button', { name: i18n.t('runDetail.retryLoad') }))
    expect(refetch).toHaveBeenCalledOnce()
  })
})
