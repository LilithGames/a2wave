import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, waitFor } from '@/test/render'

/**
 * The "retry all failed" action lives next to the tab's refresh button, outside
 * this tab, so the page it acts on can only come from here. Reporting the wrong
 * set would replay Runs the operator never saw — hence the pin on which Runs of
 * the current page are handed up.
 */

const useRunsMock = vi.fn()

vi.mock('@/hooks/use-runs', () => ({
  useRuns: (...args: unknown[]) => useRunsMock(...args),
  useRun: () => ({ data: undefined, isLoading: false }),
  useCancelRun: () => ({ mutate: vi.fn(), isPending: false }),
  useRerunRun: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { RunsTab } = await import('../runs-tab')

function run(id: string, status: string) {
  return {
    id,
    status,
    intent: `intent ${id}`,
    createdAt: new Date().toISOString(),
    triggerUserName: null,
    triggerAgentName: null,
    triggerSource: null,
  }
}

describe('RunsTab failed-run reporting', () => {
  beforeEach(() => {
    useRunsMock.mockReset()
  })

  it('hands up only the failed Runs of the current page', async () => {
    useRunsMock.mockReturnValue({
      data: {
        data: [run('run_1', 'failed'), run('run_2', 'completed'), run('run_3', 'failed')],
        pagination: { page: 1, pageSize: 15, total: 3, totalPages: 1 },
      },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    })
    const onFailedRunIdsChange = vi.fn()

    renderWithProviders(<RunsTab agentId="agt_1" onFailedRunIdsChange={onFailedRunIdsChange} />)

    await waitFor(() => expect(onFailedRunIdsChange).toHaveBeenCalledWith(['run_1', 'run_3']))
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

    await waitFor(() => expect(onFailedRunIdsChange).toHaveBeenCalledWith([]))
  })
})
