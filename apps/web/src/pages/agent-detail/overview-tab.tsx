import { Activity, CalendarDays, Coins, Hourglass, Timer, TrendingUp, Users } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { SOURCE_LABEL } from '@/components/run-caller-prefix'
import { StatCard } from '@/components/stat-card'
import { TokenUsageCoverageHelp } from '@/components/token-usage-coverage-help'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgentQueueStats, useAgentStats } from '@/hooks/use-runs'
import { formatTokens, sumTokenUsage } from '@/lib/format-tokens'
import { formatDuration } from '@/lib/utils'

/** recharts pulls in d3 sub-packages, so only overview visitors pay for it. */
const OverviewTrends = lazy(() =>
  import('./overview-trends').then((m) => ({ default: m.OverviewTrends })),
)

/** Reuses the canonical trigger-source labels, plus the API's `unknown` bucket for
 *  legacy runs with a NULL triggerSource. Keeping a second hand-maintained copy is
 *  how slack/discord went missing from this breakdown. */
const SOURCE_KEY: Record<string, string> = {
  ...SOURCE_LABEL,
  unknown: 'agentOverview.channelUnknown',
}

export function OverviewTab({ agentId }: { agentId: string | undefined }) {
  const { t } = useTranslation()
  const { data: stats, isLoading, isError } = useAgentStats(agentId)
  const { data: queue, isLoading: queueLoading } = useAgentQueueStats(agentId)

  if (isError) {
    return (
      <div className="info-panel px-3 py-2.5 text-sm text-muted-foreground">
        {t('agentOverview.loadFailed')}
      </div>
    )
  }

  const channelTotal = (stats?.channelBreakdown ?? []).reduce((sum, c) => sum + c.count, 0)

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          title={t('dashboard.totalRuns')}
          icon={<Activity className="h-4 w-4 text-interactive-foreground" aria-hidden="true" />}
          iconTileClass="bg-brand-gradient-subtle"
          value={stats?.total ?? 0}
          hint={t('dashboard.runningCount', { count: stats?.byStatus.running ?? 0 })}
          loading={isLoading}
        />
        <StatCard
          title={t('dashboard.successRate')}
          icon={<TrendingUp className="h-4 w-4 text-success" aria-hidden="true" />}
          iconTileClass="bg-success-subtle"
          value={`${stats?.successRate ?? 0}%`}
          hint={t('dashboard.completedCount', { count: stats?.byStatus.completed ?? 0 })}
          loading={isLoading}
        />
        <StatCard
          title={t('dashboard.avgDuration')}
          icon={<Timer className="h-4 w-4 text-interactive-foreground" aria-hidden="true" />}
          iconTileClass="bg-primary-subtle"
          value={formatDuration(stats?.avgDuration)}
          hint={t('dashboard.failedCount', { count: stats?.byStatus.failed ?? 0 })}
          loading={isLoading}
        />
        <StatCard
          title={t('dashboard.todayRuns')}
          icon={<CalendarDays className="h-4 w-4 text-warning" aria-hidden="true" />}
          iconTileClass="bg-warning-subtle"
          value={stats?.todayRuns ?? 0}
          loading={isLoading}
        />
        <StatCard
          title={
            <span className="inline-flex items-center gap-1">
              {t('agentDetail.statTokens')}
              <TokenUsageCoverageHelp />
            </span>
          }
          icon={<Coins className="h-4 w-4 text-interactive-foreground" aria-hidden="true" />}
          iconTileClass="bg-primary-subtle"
          value={formatTokens(sumTokenUsage(stats?.tokens ?? {}))}
          hint={`${t('runs.tokenIn')} ${formatTokens(stats?.tokens?.input)} / ${t('runs.tokenOut')} ${formatTokens(stats?.tokens?.output)}`}
          loading={isLoading}
        />
        <StatCard
          title={t('agentOverview.queueTitle')}
          icon={<Hourglass className="h-4 w-4 text-warning" aria-hidden="true" />}
          iconTileClass="bg-warning-subtle"
          value={queue?.queued ?? 0}
          hint={`${t('agentOverview.queueSlots', {
            occupied: queue?.occupied ?? 0,
            max: queue?.maxConcurrency ?? 1,
          })} · ${
            queue?.oldestWaitMs != null
              ? t('agentOverview.queueOldestWait', {
                  duration: formatDuration(queue.oldestWaitMs),
                })
              : t('agentOverview.queueIdle')
          }`}
          loading={queueLoading}
        />
      </div>

      {/* Time-range selector + trend charts */}
      <Suspense fallback={<Skeleton className="h-[520px] w-full" />}>
        <OverviewTrends agentId={agentId} />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Askers + Top askers */}
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <Users className="h-4 w-4 text-interactive-foreground" aria-hidden="true" />
              <h3 className="text-sm font-medium text-foreground">
                {t('agentOverview.askerCountTitle')}
              </h3>
            </div>
            <div className="text-[28px] font-semibold tabular-nums text-foreground leading-none mb-4">
              {stats?.askerCount ?? 0}
            </div>
            <div className="text-xs font-medium text-muted-foreground mb-2">
              {t('agentOverview.topAskersTitle')}
            </div>
            {stats && stats.topAskers.length > 0 ? (
              <ul className="space-y-1.5">
                {stats.topAskers.map((a, idx) => (
                  <li key={a.name} className="flex items-center gap-2 text-sm">
                    <span className="w-4 text-xs tabular-nums text-muted-foreground">
                      {idx + 1}
                    </span>
                    <span className="flex-1 truncate text-foreground">{a.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t('agentOverview.timesUnit', { count: a.count })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('agentOverview.noAskers')}</p>
            )}
          </CardContent>
        </Card>

        {/* Channel breakdown */}
        <Card>
          <CardContent className="p-5">
            <h3 className="text-sm font-medium text-foreground mb-4">
              {t('agentOverview.channelBreakdownTitle')}
            </h3>
            {stats && stats.channelBreakdown.length > 0 ? (
              <ul className="space-y-3">
                {stats.channelBreakdown
                  .slice()
                  .sort((a, b) => b.count - a.count)
                  .map((ch) => {
                    const pct = channelTotal > 0 ? Math.round((ch.count / channelTotal) * 100) : 0
                    return (
                      <li key={ch.source}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-foreground">
                            {SOURCE_KEY[ch.source] ? t(SOURCE_KEY[ch.source]) : ch.source}
                          </span>
                          <span className="tabular-nums text-muted-foreground">
                            {ch.count} · {pct}%
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    )
                  })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('agentOverview.noChannels')}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
