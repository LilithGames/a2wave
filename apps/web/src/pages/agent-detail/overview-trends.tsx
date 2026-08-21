import dayjs from 'dayjs'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  type AgentTimeseries,
  type AgentTimeseriesPoint,
  type TimeseriesRange,
  useAgentTimeseries,
} from '@/hooks/use-runs'
import { formatTokens, sumTokenUsage } from '@/lib/format-tokens'
import { formatDuration } from '@/lib/utils'
import {
  ACTIVE_DOT_PROPS,
  AXIS_PROPS,
  GRID_PROPS,
  RUN_STATUS_COLORS,
  RUN_STATUS_LABEL_KEYS,
  RUN_STATUS_STACK_ORDER,
  type RunStatusKey,
  SERIES_COLORS,
} from './chart-theme'
import { OverviewTimeRange, type RangePreset, resolvePreset } from './overview-time-range'

/** A point plus the flattened, chart-addressable copies of its nested series. */
type ChartRow = AgentTimeseriesPoint &
  Record<RunStatusKey, number> & {
    label: string
    tokenInput: number
    tokenOutput: number
  }

/** Tooltip rows are `[label, formattedValue, swatchColor?]`. */
type TooltipRow = [string, string, string?]

/**
 * Recharts computes tooltip styling in JS, where `var(--color-*)` does not
 * resolve — so the tooltip is a plain Tailwind element using token classes
 * rather than inline colors. Values wear text tokens; the series color appears
 * only as a small swatch.
 */
function TrendTooltip({
  active,
  label,
  rows,
}: {
  active?: boolean
  label?: string
  rows: TooltipRow[]
}) {
  if (!active) return null
  return (
    // `bg-card`, not `bg-popover`: no `--color-popover` token exists, so that class
    // was inert and the tooltip had no fill at all — chart marks showed straight
    // through the text. A tooltip sits over the plot and must be opaque.
    <div className="rounded-md border border-border bg-card px-3 py-2 shadow-md">
      <div className="mb-1 text-xs font-medium text-foreground">{label}</div>
      <ul className="space-y-0.5">
        {rows.map(([name, value, color]) => (
          <li key={name} className="flex items-center gap-2 text-xs text-muted-foreground">
            {color && (
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ background: color }}
              />
            )}
            <span className="flex-1">{name}</span>
            <span className="tabular-nums text-foreground">{value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A `<Line>` needs two adjacent non-null points to draw a segment, so a bucket
 * whose neighbours are both empty produces no visible mark at all — the chart
 * reads as "no data" while the headline above it shows a real number. This
 * renders a dot for exactly those isolated points and nothing elsewhere, so
 * connected runs keep their clean dot-free line.
 */
function renderIsolatedDot(
  rows: ChartRow[],
  key: 'avgDurationMs' | 'askers',
  color: string,
  isEmpty: (value: number | null) => boolean = (v) => v == null,
) {
  return (props: unknown) => {
    const { key: dotKey, cx, cy, index } = props as ReactDotProps
    const value = rows[index]?.[key] ?? null
    const isolated =
      !isEmpty(value) &&
      isEmpty(rows[index - 1]?.[key] ?? null) &&
      isEmpty(rows[index + 1]?.[key] ?? null)
    if (!isolated || cx == null || cy == null) return <g key={dotKey} />
    return (
      <circle
        key={dotKey}
        cx={cx}
        cy={cy}
        r={4}
        fill={color}
        stroke="var(--color-card)"
        strokeWidth={2}
      />
    )
  }
}

type ReactDotProps = { key?: string; cx?: number; cy?: number; index: number }

// recharts types dataKey as string | number | accessor-function; we only ever
// declare string keys, so a non-string simply never matches.
type TooltipPayload =
  | readonly { dataKey?: string | number | ((obj: never) => unknown); value?: unknown }[]
  | undefined

/**
 * Read a tooltip value by series key rather than by position.
 *
 * recharts reorders payload entries and omits ones whose value is null, so
 * `payload[0]` is not reliably the first series declared — indexing positionally
 * silently mislabels one series with another's number. Returns null when the
 * series is absent or null, which callers distinguish from a real zero.
 */
function seriesValue(payload: TooltipPayload, key: string): number | null {
  const hit = payload?.find((p) => p.dataKey === key)
  return hit?.value == null ? null : Number(hit.value)
}

function TrendCard({
  title,
  total,
  hint,
  legend,
  children,
}: {
  title: ReactNode
  total: string
  hint?: string
  /** `[label, color]` per series. Required for multi-series charts, where the
      tooltip alone leaves identity carried by color until the user hovers. */
  legend?: ReadonlyArray<readonly [string, string]>
  children: ReactNode
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <div className="mt-1 text-[28px] font-semibold leading-none tabular-nums text-foreground">
          {total}
        </div>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        {legend && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {legend.map(([label, color]) => (
              <span key={label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
                {label}
              </span>
            ))}
          </div>
        )}
        {/* ResponsiveContainer measures its parent, so the height must be
            explicit — inside a grid child it would otherwise collapse to 0. */}
        <div className="mt-4 h-[200px] w-full">{children}</div>
      </CardContent>
    </Card>
  )
}

export function OverviewTrends({ agentId }: { agentId: string | undefined }) {
  const { t } = useTranslation()
  const [preset, setPreset] = useState<RangePreset>('7d')
  const [range, setRange] = useState<TimeseriesRange>(() => resolvePreset('7d'))

  const { data, isLoading, isError } = useAgentTimeseries(agentId, range)

  const rows = useMemo<ChartRow[]>(() => {
    const format = range.bucket === 'hour' ? 'HH:mm' : 'MM-DD'
    // Series values are flattened to top-level keys: recharts resolves a dotted
    // dataKey for the *value* but derives no geometry for a stacked bar from it,
    // which renders empty <g> wrappers and a silently blank chart.
    return (data?.points ?? []).map((p) => ({
      ...p,
      label: dayjs(p.ts).format(format),
      completed: p.runs.completed,
      failed: p.runs.failed,
      running: p.runs.running,
      queued: p.runs.queued,
      pending: p.runs.pending,
      cancelled: p.runs.cancelled,
      tokenInput: p.tokens.input,
      tokenOutput: p.tokens.output,
    }))
  }, [data, range.bucket])

  const totals = useMemo(() => summarize(data), [data])

  function handlePresetChange(next: RangePreset) {
    setPreset(next)
    if (next !== 'custom') setRange(resolvePreset(next))
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">{t('agentOverview.trendsTitle')}</h2>
        <OverviewTimeRange
          preset={preset}
          range={range}
          onPresetChange={handlePresetChange}
          onRangeChange={setRange}
        />
      </div>

      {isError ? (
        <div className="info-panel px-3 py-2.5 text-sm text-muted-foreground">
          {t('agentOverview.trendsLoadFailed')}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <TrendCard title={t('agentOverview.chartRunsTitle')} total={String(totals.runs)}>
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : totals.runs === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="label" {...AXIS_PROPS} />
                  <YAxis allowDecimals={false} {...AXIS_PROPS} />
                  <Tooltip
                    cursor={{ fill: 'var(--color-surface-hover)' }}
                    content={({ active, label, payload }) => (
                      <TrendTooltip
                        active={active}
                        label={label as string}
                        rows={RUN_STATUS_STACK_ORDER.filter((s) =>
                          payload?.some((p) => p.dataKey === s && Number(p.value) > 0),
                        ).map((s) => [
                          t(RUN_STATUS_LABEL_KEYS[s]),
                          String(payload?.find((p) => p.dataKey === s)?.value ?? 0),
                          RUN_STATUS_COLORS[s],
                        ])}
                      />
                    )}
                  />
                  {RUN_STATUS_STACK_ORDER.map((status) => (
                    <Bar
                      key={status}
                      dataKey={status}
                      stackId="runs"
                      fill={RUN_STATUS_COLORS[status]}
                      maxBarSize={24}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </TrendCard>

          <TrendCard
            title={t('agentOverview.chartAskersTitle')}
            total={String(totals.peakAskers)}
            hint={t('agentOverview.askersHint')}
          >
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : !totals.hasAskerData ? (
              // "Nobody identifiable asked" is a different claim from "there is
              // no data" — an API-key-only agent has plenty of runs and zero
              // askers, and saying "no data" next to a populated Runs chart
              // reads as a bug.
              <EmptyChart message={totals.runs > 0 ? 'agentOverview.noAskerIdentity' : undefined} />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="label" {...AXIS_PROPS} />
                  <YAxis allowDecimals={false} {...AXIS_PROPS} />
                  <Tooltip
                    content={({ active, label, payload }) => (
                      <TrendTooltip
                        active={active}
                        label={label as string}
                        rows={[
                          [
                            t('agentOverview.chartAskersTitle'),
                            String(seriesValue(payload, 'askers') ?? 0),
                            SERIES_COLORS.askers,
                          ],
                        ]}
                      />
                    )}
                  />
                  <Line
                    dataKey="askers"
                    stroke={SERIES_COLORS.askers}
                    strokeWidth={2}
                    // Askers use 0 for "nobody asked", so an isolated day is one
                    // surrounded by zeroes rather than by nulls.
                    dot={renderIsolatedDot(rows, 'askers', SERIES_COLORS.askers, (v) => !v)}
                    activeDot={ACTIVE_DOT_PROPS}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </TrendCard>

          <TrendCard
            title={t('agentOverview.chartTokensTitle')}
            total={formatTokens(totals.tokens)}
            legend={[
              [t('agentOverview.tokenInput'), SERIES_COLORS.tokenInput],
              [t('agentOverview.tokenOutput'), SERIES_COLORS.tokenOutput],
            ]}
          >
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : totals.plottedTokens === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="label" {...AXIS_PROPS} />
                  <YAxis tickFormatter={(v) => formatTokens(Number(v))} {...AXIS_PROPS} />
                  <Tooltip
                    content={({ active, label, payload }) => (
                      <TrendTooltip
                        active={active}
                        label={label as string}
                        // Resolve by dataKey, never by position: recharts
                        // reorders and drops payload entries for hidden or null
                        // series, which would silently swap the Input and
                        // Output labels.
                        rows={[
                          [
                            t('agentOverview.tokenInput'),
                            formatTokens(seriesValue(payload, 'tokenInput') ?? 0),
                            SERIES_COLORS.tokenInput,
                          ],
                          [
                            t('agentOverview.tokenOutput'),
                            formatTokens(seriesValue(payload, 'tokenOutput') ?? 0),
                            SERIES_COLORS.tokenOutput,
                          ],
                        ]}
                      />
                    )}
                  />
                  {/* Deliberately NOT stacked. Output runs a few percent of input, so
                      stacked it became a band 0.5-3px tall riding on the input line —
                      unreadable on its own, and its upper edge looked like a second
                      series shadowing the first. Unstacked, each line is measured from
                      zero, which is also what the tooltip's two numbers imply. The card
                      header still carries the combined total. */}
                  <Area
                    dataKey="tokenInput"
                    stroke={SERIES_COLORS.tokenInput}
                    fill={SERIES_COLORS.tokenInput}
                    fillOpacity={0.16}
                    strokeWidth={2}
                  />
                  <Area
                    dataKey="tokenOutput"
                    stroke={SERIES_COLORS.tokenOutput}
                    fill={SERIES_COLORS.tokenOutput}
                    fillOpacity={0.16}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </TrendCard>

          <TrendCard
            title={t('agentOverview.chartDurationTitle')}
            total={formatDuration(totals.avgDuration)}
            hint={t('agentOverview.durationHint')}
          >
            {isLoading ? (
              <Skeleton className="h-full w-full" />
            ) : totals.durationSamples === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="label" {...AXIS_PROPS} />
                  <YAxis tickFormatter={(v) => formatDuration(Number(v))} {...AXIS_PROPS} />
                  <Tooltip
                    content={({ active, label, payload }) => (
                      <TrendTooltip
                        active={active}
                        label={label as string}
                        rows={[
                          [
                            t('agentOverview.chartDurationTitle'),
                            // A null bucket means "no completed turns", not
                            // "0ms". Coercing it to zero reintroduced exactly
                            // the confusion the null was there to prevent.
                            formatDuration(seriesValue(payload, 'avgDurationMs') ?? undefined),
                            SERIES_COLORS.duration,
                          ],
                        ]}
                      />
                    )}
                  />
                  {/* Empty buckets carry null, so the line breaks instead of
                      diving to zero and implying instant responses. A day whose
                      neighbours are both null has no segment to belong to, so it
                      gets an explicit dot — otherwise a lone measurement renders
                      as a completely blank chart under a non-zero headline. */}
                  <Line
                    dataKey="avgDurationMs"
                    stroke={SERIES_COLORS.duration}
                    strokeWidth={2}
                    connectNulls={false}
                    dot={renderIsolatedDot(rows, 'avgDurationMs', SERIES_COLORS.duration)}
                    activeDot={ACTIVE_DOT_PROPS}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </TrendCard>
        </div>
      )}
    </div>
  )
}

function EmptyChart({ message }: { message?: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
      {t(message ?? 'agentOverview.noTrendData')}
    </div>
  )
}

function summarize(data: AgentTimeseries | undefined) {
  const points = data?.points ?? []
  let runs = 0
  let tokens = 0
  let plottedTokens = 0
  let hasAskerData = false
  let peakAskers = 0
  let durationTotal = 0
  let durationSamples = 0

  for (const p of points) {
    runs += p.total
    // The headline must agree with the Token Usage KPI card directly above,
    // which sums all five counters via sumTokenUsage(). Counting only
    // input+output here made a cache-heavy agent read ~18x lower on the same
    // screen. `plottedTokens` stays input+output because that is what the two
    // stacked areas actually draw, and it alone decides the empty state.
    tokens += sumTokenUsage(p.tokens)
    plottedTokens += p.tokens.input + p.tokens.output
    hasAskerData ||= p.askers > 0
    peakAskers = Math.max(peakAskers, p.askers)
    if (p.avgDurationMs != null && p.durationSamples > 0) {
      // Weight by sample count so a quiet day with one slow turn does not skew
      // the headline the way a plain mean-of-means would.
      durationTotal += p.avgDurationMs * p.durationSamples
      durationSamples += p.durationSamples
    }
  }

  return {
    runs,
    tokens,
    plottedTokens,
    hasAskerData,
    peakAskers,
    durationSamples,
    avgDuration: durationSamples > 0 ? Math.round(durationTotal / durationSamples) : 0,
  }
}
