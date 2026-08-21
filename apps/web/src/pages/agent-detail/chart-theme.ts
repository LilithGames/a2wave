/**
 * Chart styling for the agent overview trends.
 *
 * Colors are CSS custom properties rather than literals. Recharts writes these
 * into SVG `fill`/`stroke` attributes, where `var()` resolves natively — so the
 * six themes in `themes.ts` all work with no new tokens and no re-mount on
 * theme switch.
 *
 * The one place this does NOT hold is the tooltip and legend, whose styles
 * recharts computes in JS. Those use the Tailwind token classes via a custom
 * tooltip component (see `trend-tooltip.tsx`) instead of these values.
 *
 * Run status is a *status* palette, not a categorical one — the series are
 * literally states, so they take the reserved status tokens rather than an
 * arbitrary "series N" color order.
 */

export const RUN_STATUS_COLORS = {
  completed: 'var(--color-success)',
  failed: 'var(--color-destructive)',
  running: 'var(--color-primary)',
  queued: 'var(--color-warning)',
  pending: 'var(--color-muted-foreground)',
  cancelled: 'var(--color-border)',
} as const

export type RunStatusKey = keyof typeof RUN_STATUS_COLORS

/**
 * Stack order, baseline upward. Completed and failed sit adjacent so the two
 * states a reader actually scans for share an edge and stay comparable.
 */
export const RUN_STATUS_STACK_ORDER: RunStatusKey[] = [
  'completed',
  'failed',
  'running',
  'queued',
  'pending',
  'cancelled',
]

/**
 * Status labels reuse the existing `dashboard.*` copy. A second hand-maintained
 * set is exactly how slack/discord once went missing from the channel
 * breakdown — see the note at the top of `overview-tab.tsx`.
 */
export const RUN_STATUS_LABEL_KEYS: Record<RunStatusKey, string> = {
  completed: 'dashboard.statusCompleted',
  failed: 'dashboard.statusFailed',
  running: 'dashboard.statusRunning',
  queued: 'dashboard.statusQueued',
  pending: 'dashboard.statusPending',
  cancelled: 'dashboard.statusCancelled',
}

/**
 * Chart series colors.
 *
 * Input/Output use the dedicated categorical pair rather than
 * `primary` / `interactive-foreground`: those two are one shade apart (normal-vision
 * OKLab dE 12.3, below the 15 floor), which is why the stacked token areas read as a
 * single band. Slots are assigned in fixed order and never cycled.
 *
 * `duration` keeps `warning` because it is a lone series — no adjacent hue to separate
 * from — and the amber reads as "time/attention" rather than as a status here.
 */
export const SERIES_COLORS = {
  askers: 'var(--color-chart-series-1)',
  tokenInput: 'var(--color-chart-series-1)',
  tokenOutput: 'var(--color-chart-series-2)',
  duration: 'var(--color-warning)',
  // The latency legs ARE state durations — time spent 'queued' and time spent
  // 'running' — so they take those status tokens rather than categorical
  // slots. The pair already sits adjacent in the stacked runs chart, so its
  // separation is proven on every theme.
  latencyWait: RUN_STATUS_COLORS.queued,
  latencyExec: RUN_STATUS_COLORS.running,
} as const

export const AXIS_PROPS = {
  stroke: 'var(--color-border)',
  tick: { fill: 'var(--color-muted-foreground)', fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const

/** Horizontal rules only — a recessive grid the marks sit on top of. */
export const GRID_PROPS = {
  stroke: 'var(--color-border)',
  strokeDasharray: '3 3',
  vertical: false,
} as const

/** Surface-colored ring on hover dots, matching the card behind the chart. */
export const ACTIVE_DOT_PROPS = {
  r: 4,
  strokeWidth: 2,
  stroke: 'var(--color-card)',
} as const
