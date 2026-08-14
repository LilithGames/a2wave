import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTimeseries, AgentTimeseriesPoint } from '@/hooks/use-runs'
import { renderWithProviders, screen } from '@/test/render'

/**
 * recharts is mocked because `ResponsiveContainer` measures its parent, and in
 * jsdom that is 0×0 — the real components render nothing at all, so DOM
 * assertions on axes or marks would pass while asserting nothing. Stubbing lets
 * us assert on the data actually handed to each chart, which is what matters.
 */
vi.mock('recharts', () => {
  const passthrough =
    (testId: string) =>
    ({ children }: { children?: ReactNode }) => <div data-testid={testId}>{children}</div>

  return {
    ResponsiveContainer: passthrough('responsive-container'),
    BarChart: ({ data, children }: { data?: unknown[]; children?: ReactNode }) => (
      <div data-testid="bar-chart" data-rows={JSON.stringify(data)}>
        {children}
      </div>
    ),
    LineChart: ({ data, children }: { data?: unknown[]; children?: ReactNode }) => (
      <div data-testid="line-chart" data-rows={JSON.stringify(data)}>
        {children}
      </div>
    ),
    AreaChart: ({ data, children }: { data?: unknown[]; children?: ReactNode }) => (
      <div data-testid="area-chart" data-rows={JSON.stringify(data)}>
        {children}
      </div>
    ),
    Bar: ({ dataKey }: { dataKey?: string }) => <div data-testid="bar" data-key={dataKey} />,
    Line: ({
      dataKey,
      connectNulls,
      dot,
    }: {
      dataKey?: string
      connectNulls?: boolean
      dot?: unknown
    }) => (
      <div
        data-testid="line"
        data-key={dataKey}
        data-connect-nulls={String(connectNulls)}
        data-has-dot-renderer={String(typeof dot === 'function')}
      />
    ),
    Area: ({ dataKey }: { dataKey?: string }) => <div data-testid="area" data-key={dataKey} />,
    CartesianGrid: () => <div data-testid="grid" />,
    XAxis: () => <div data-testid="x-axis" />,
    YAxis: () => <div data-testid="y-axis" />,
    Tooltip: () => <div data-testid="tooltip" />,
  }
})

const mockUseAgentTimeseries = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-runs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAgentTimeseries: mockUseAgentTimeseries,
}))

const { OverviewTrends } = await import('../overview-trends')

function point(overrides: Partial<AgentTimeseriesPoint> = {}): AgentTimeseriesPoint {
  return {
    ts: '2026-07-01T00:00:00.000Z',
    runs: { completed: 0, failed: 0, running: 0, pending: 0, queued: 0, cancelled: 0 },
    total: 0,
    askers: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    avgDurationMs: null,
    durationSamples: 0,
    ...overrides,
  }
}

function series(points: AgentTimeseriesPoint[]): AgentTimeseries {
  return { bucket: 'day', from: '2026-07-01', to: '2026-07-02', points }
}

function mockResult(over: Partial<ReturnType<typeof mockUseAgentTimeseries>> = {}) {
  mockUseAgentTimeseries.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    ...over,
  })
}

const POPULATED = series([
  point({
    ts: '2026-07-01T00:00:00.000Z',
    runs: { completed: 5, failed: 1, running: 0, pending: 0, queued: 0, cancelled: 0 },
    total: 6,
    askers: 3,
    tokens: { input: 800, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    avgDurationMs: 4200,
    durationSamples: 6,
  }),
  point({ ts: '2026-07-02T00:00:00.000Z' }),
])

beforeEach(() => {
  vi.clearAllMocks()
})

describe('<OverviewTrends />', () => {
  it('renders the section heading and the range presets', () => {
    mockResult({ data: series([point()]) })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)
    expect(screen.getByText('趋势分析')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '近 7 天' })).toBeInTheDocument()
  })

  it('surfaces a failure instead of an empty chart', () => {
    mockResult({ isError: true })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)
    expect(screen.getByText('趋势数据加载失败')).toBeInTheDocument()
    expect(screen.queryByTestId('bar-chart')).toBeNull()
  })

  it('shows the empty state for an all-zero range', () => {
    mockResult({ data: series([point(), point()]) })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)
    // One per chart card.
    expect(screen.getAllByText('所选时间范围内暂无数据')).toHaveLength(4)
  })

  it('stacks every run status in a stable order', () => {
    mockResult({ data: POPULATED })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)
    const keys = screen.getAllByTestId('bar').map((el) => el.getAttribute('data-key'))
    // Flat keys, not `runs.completed`: recharts resolves a dotted dataKey for
    // the value but computes no bar geometry from it, so the chart silently
    // renders empty <g> wrappers.
    expect(keys).toEqual(['completed', 'failed', 'running', 'queued', 'pending', 'cancelled'])
  })

  it('flattens nested series onto the row handed to each chart', () => {
    mockResult({ data: POPULATED })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)
    const rows = JSON.parse(
      screen.getByTestId('bar-chart').getAttribute('data-rows') ?? '[]',
    ) as Record<string, number>[]
    expect(rows[0].completed).toBe(5)
    expect(rows[0].failed).toBe(1)
    expect(rows[0].tokenInput).toBe(800)
    expect(rows[0].tokenOutput).toBe(200)
  })

  it('totals runs and tokens across the range', () => {
    mockResult({ data: POPULATED })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)
    expect(screen.getByText('6')).toBeInTheDocument() // 6 runs
    expect(screen.getByText('1.0K')).toBeInTheDocument() // 800 in + 200 out
  })

  it('counts cache and reasoning tokens in the headline, like the KPI card', () => {
    // The Token Usage StatCard directly above uses sumTokenUsage() over all five
    // counters. Summing only input+output here read ~18x low for a cache-heavy
    // agent — two contradictory numbers on one screen.
    mockResult({
      data: series([
        point({
          tokens: {
            input: 200_000,
            output: 100_000,
            reasoning: 0,
            cacheRead: 4_500_000,
            cacheWrite: 500_000,
          },
        }),
      ]),
    })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)
    expect(screen.getByText('5.3M')).toBeInTheDocument()
    expect(screen.queryByText('300.0K')).toBeNull()
  })

  it('still renders the token chart when only cache tokens were consumed', () => {
    // The empty-state gate keys off the plotted input+output series, but a range
    // with cache-only usage is not "no data".
    mockResult({
      data: series([
        point({
          total: 1,
          runs: { completed: 1, failed: 0, running: 0, pending: 0, queued: 0, cancelled: 0 },
          tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 900_000, cacheWrite: 0 },
        }),
      ]),
    })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)
    expect(screen.getByTestId('area-chart')).toBeInTheDocument()
  })

  it('distinguishes "no identifiable asker" from "no data" when runs exist', () => {
    // An API-key-only agent has plenty of runs and zero askers; claiming "no
    // data" beside a populated Runs chart reads as a bug.
    mockResult({
      data: series([
        point({
          total: 5,
          runs: { completed: 5, failed: 0, running: 0, pending: 0, queued: 0, cancelled: 0 },
          askers: 0,
        }),
      ]),
    })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)
    expect(screen.getByText('这些运行不携带调用者身份，无法统计提问人数')).toBeInTheDocument()
  })

  it('passes null-gapped duration data through with connectNulls disabled', () => {
    mockResult({ data: POPULATED })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)

    const durationLine = screen
      .getAllByTestId('line')
      .find((el) => el.getAttribute('data-key') === 'avgDurationMs')
    // A break in the line is the whole point: 0 would read as "instant".
    expect(durationLine).toHaveAttribute('data-connect-nulls', 'false')

    const rows = JSON.parse(
      screen.getAllByTestId('line-chart')[1]?.getAttribute('data-rows') ?? '[]',
    ) as AgentTimeseriesPoint[]
    expect(rows[1].avgDurationMs).toBeNull()
  })

  it('gives the gapped lines a dot renderer so isolated points stay visible', () => {
    // A single day of data surrounded by empty ones has no neighbour to draw a
    // segment to, so with dot={false} the chart renders completely blank while
    // the headline above it shows a real average.
    mockResult({ data: POPULATED })
    renderWithProviders(<OverviewTrends agentId="agt_1" />)
    for (const line of screen.getAllByTestId('line')) {
      expect(line).toHaveAttribute('data-has-dot-renderer', 'true')
    }
  })

  it('renders skeletons while loading', () => {
    mockResult({ isLoading: true })
    const { container } = renderWithProviders(<OverviewTrends agentId="agt_1" />)
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
  })
})
