import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen } from '@/test/render'

/** Trends pull in recharts; the queue card under test does not need them. */
vi.mock('../overview-trends', () => ({
  OverviewTrends: () => <div data-testid="trends-stub" />,
}))

const mockUseAgentStats = vi.hoisted(() => vi.fn())
const mockUseAgentQueueStats = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-runs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAgentStats: mockUseAgentStats,
  useAgentQueueStats: mockUseAgentQueueStats,
}))

const { OverviewTab } = await import('../overview-tab')

beforeEach(() => {
  vi.clearAllMocks()
  mockUseAgentStats.mockReturnValue({ data: undefined, isLoading: false, isError: false })
})

describe('<OverviewTab /> queue card', () => {
  it('shows queue depth, slot occupancy, and the head wait', () => {
    mockUseAgentQueueStats.mockReturnValue({
      data: { queued: 3, occupied: 1, maxConcurrency: 1, oldestWaitMs: 252_000 },
      isLoading: false,
    })
    renderWithProviders(<OverviewTab agentId="agt_1" />)

    expect(screen.getByText('排队任务')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText(/并发 1\/1/)).toBeInTheDocument()
    expect(screen.getByText(/队首已等待 4m 12s/)).toBeInTheDocument()
  })

  it('reads as idle when nothing is queued', () => {
    mockUseAgentQueueStats.mockReturnValue({
      data: { queued: 0, occupied: 0, maxConcurrency: 2, oldestWaitMs: null },
      isLoading: false,
    })
    renderWithProviders(<OverviewTab agentId="agt_1" />)

    expect(screen.getByText(/并发 0\/2/)).toBeInTheDocument()
    expect(screen.getByText(/当前无排队/)).toBeInTheDocument()
  })
})
