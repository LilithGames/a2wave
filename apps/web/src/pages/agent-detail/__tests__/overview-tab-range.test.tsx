import { fireEvent, waitFor, within } from '@testing-library/react'
import dayjs, { type Dayjs } from 'dayjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen } from '@/test/render'
import { resolvePreset } from '../overview-time-range'

// Empty series do not render charts; keep this integration test focused on the range controls.
vi.mock('recharts', () => ({}))
vi.mock('antd', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DatePicker: {
    RangePicker: ({ onChange }: { onChange: (dates: [Dayjs, Dayjs]) => void }) => (
      <button type="button" onClick={() => onChange([dayjs('2026-06-01'), dayjs('2026-06-14')])}>
        Apply custom dates
      </button>
    ),
  },
}))

const { mockStats, mockTimeseries } = vi.hoisted(() => ({
  mockStats: vi.fn(),
  mockTimeseries: vi.fn(),
}))
vi.mock('@/hooks/use-runs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAgentStats: mockStats,
  useAgentTimeseries: mockTimeseries,
  useAgentQueueStats: () => ({ data: undefined, isLoading: false }),
}))

const { OverviewTab } = await import('../overview-tab')

beforeEach(() => {
  vi.clearAllMocks()
  mockStats.mockReturnValue({ data: undefined, isLoading: false, isError: false })
  mockTimeseries.mockReturnValue({ data: undefined, isLoading: false, isError: false })
})

describe('<OverviewTab /> shared time range', () => {
  it('keeps lifetime audience cards above trends and filters only the lower cards', async () => {
    mockStats.mockImplementation((_agentId, range) => ({
      isLoading: false,
      isError: false,
      data: {
        total: 100,
        byStatus: {},
        askerCount: range ? (range.bucket === 'hour' ? 2 : 7) : 42,
        topAskers: [{ name: range ? 'Recent caller' : 'Lifetime caller', count: range ? 3 : 80 }],
        channelBreakdown: [
          { source: 'feishu', count: range ? (range.bucket === 'hour' ? 3 : 10) : 100 },
        ],
      },
    }))
    renderWithProviders(<OverviewTab agentId="agt_1" />)
    const trends = await screen.findByRole('heading', { name: '趋势分析' })
    const lifetime = screen.getByTestId('lifetime-audience-stats')
    const filtered = screen.getByTestId('range-audience-stats')
    expect(
      screen.getByText('总运行数').compareDocumentPosition(lifetime) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(lifetime.compareDocumentPosition(trends) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(trends.compareDocumentPosition(filtered) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(lifetime).getByText('42')).toBeInTheDocument()
    expect(within(lifetime).getByText('Lifetime caller')).toBeInTheDocument()
    expect(within(lifetime).getByText('100 · 100%')).toBeInTheDocument()
    expect(within(filtered).getByText('7')).toBeInTheDocument()
    expect(within(filtered).getByText('Recent caller')).toBeInTheDocument()
    expect(within(filtered).getByText('10 · 100%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '今天' }))
    expect(within(lifetime).getByText('42')).toBeInTheDocument()
    expect(within(lifetime).getByText('100 · 100%')).toBeInTheDocument()
    expect(within(filtered).getByText('2')).toBeInTheDocument()
    expect(within(filtered).getByText('3 · 100%')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部时间' })).not.toBeInTheDocument()
  })

  it('filters statistics and trends by the same default and preset ranges', async () => {
    renderWithProviders(<OverviewTab agentId="agt_1" />)
    await screen.findByRole('button', { name: '近 7 天' })
    expect(mockStats).toHaveBeenLastCalledWith('agt_1', resolvePreset('7d'))
    expect(mockTimeseries).toHaveBeenLastCalledWith('agt_1', resolvePreset('7d'))

    for (const [label, preset] of [
      ['近 30 天', '30d'],
      ['今天', 'today'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(mockStats).toHaveBeenLastCalledWith('agt_1', resolvePreset(preset))
      expect(mockTimeseries).toHaveBeenLastCalledWith('agt_1', resolvePreset(preset))
    }
  })

  it('applies completed custom dates to statistics and trends together', async () => {
    renderWithProviders(<OverviewTab agentId="agt_1" />)
    fireEvent.click(await screen.findByRole('button', { name: '自定义' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply custom dates' }))

    const range = { from: '2026-06-01', to: '2026-06-14', bucket: 'day' }
    await waitFor(() => expect(mockTimeseries).toHaveBeenLastCalledWith('agt_1', range))
    expect(mockStats).toHaveBeenLastCalledWith('agt_1', range)
  })

  it('preserves the custom selector and dates after a statistics error recovers', async () => {
    const { rerender } = renderWithProviders(<OverviewTab agentId="agt_1" />)
    fireEvent.click(await screen.findByRole('button', { name: '自定义' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply custom dates' }))

    mockStats.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    rerender(<OverviewTab agentId="agt_1" />)
    expect(screen.queryByRole('button', { name: '自定义' })).toBeNull()

    mockStats.mockReturnValue({ data: undefined, isLoading: false, isError: false })
    rerender(<OverviewTab agentId="agt_1" />)
    expect(await screen.findByRole('button', { name: '自定义' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Apply custom dates' })).toBeInTheDocument()
    const range = { from: '2026-06-01', to: '2026-06-14', bucket: 'day' }
    expect(mockStats).toHaveBeenLastCalledWith('agt_1', range)
    expect(mockTimeseries).toHaveBeenLastCalledWith('agt_1', range)
  })
})
