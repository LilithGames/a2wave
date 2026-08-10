import { OnboardingWelcome } from '@/components/onboarding-welcome'
import { RunCallerPrefix } from '@/components/run-caller-prefix'
import { StatCard } from '@/components/stat-card'
import { TokenUsageCoverageHelp } from '@/components/token-usage-coverage-help'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgents } from '@/hooks/use-agents'
import {
  type AgentLeaderboardEntry,
  useAgentRunLeaderboard,
  useRunStats,
  useRuns,
} from '@/hooks/use-runs'
import { formatTokens, sumTokenUsage } from '@/lib/format-tokens'
import { formatDuration, formatRelativeTime } from '@/lib/utils'
import type { RunStatus, RunTriggerSource } from '@a2wave/shared'
import {
  Activity,
  CalendarDays,
  CheckCircle2,
  Circle,
  Clock,
  Coins,
  Loader2,
  Timer,
  TrendingUp,
  Users,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

const STATUS_BADGE: Record<
  RunStatus,
  { variant: 'default' | 'secondary' | 'destructive' | 'success' | 'warning'; label: string }
> = {
  running: { variant: 'warning', label: 'dashboard.statusRunning' },
  completed: { variant: 'success', label: 'dashboard.statusCompleted' },
  failed: { variant: 'destructive', label: 'dashboard.statusFailed' },
  pending: { variant: 'secondary', label: 'dashboard.statusPending' },
  queued: { variant: 'secondary', label: 'dashboard.statusQueued' },
  cancelled: { variant: 'secondary', label: 'dashboard.statusCancelled' },
}

export function DashboardPage() {
  const { t } = useTranslation()
  const { data: agentsResult, isLoading: agentsLoading } = useAgents()
  const { data: runsData, isLoading: runsLoading } = useRuns({ pageSize: 5 })
  const { data: stats, isLoading: statsLoading } = useRunStats()
  const { data: leaderboard, isLoading: leaderboardLoading } = useAgentRunLeaderboard()

  const recentRuns = runsData?.data ?? []
  const publishedAgents = agentsResult?.data.filter((a) => a.publishStatus === 'published') ?? []

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div>
        <h2
          className="text-2xl font-semibold tracking-tight text-foreground"
          style={{ textWrap: 'balance' }}
        >
          {t('dashboard.title')}
        </h2>
        <p className="text-sm text-muted-foreground mt-1.5" style={{ textWrap: 'pretty' }}>
          {t('dashboard.subtitle')}
        </p>
      </div>

      {/* Stats row */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <StatCard
          title={t('dashboard.totalRuns')}
          icon={<Activity className="h-4 w-4 text-interactive-foreground" aria-hidden="true" />}
          iconTileClass="bg-brand-gradient-subtle"
          value={stats?.total ?? 0}
          hint={t('dashboard.runningCount', { count: stats?.byStatus.running ?? 0 })}
          loading={statsLoading}
          to="/runs"
        />
        <StatCard
          title={t('dashboard.successRate')}
          icon={<TrendingUp className="h-4 w-4 text-success" aria-hidden="true" />}
          iconTileClass="bg-success-subtle"
          value={`${stats?.successRate ?? 0}%`}
          hint={t('dashboard.completedCount', { count: stats?.byStatus.completed ?? 0 })}
          loading={statsLoading}
        />
        <StatCard
          title={t('dashboard.avgDuration')}
          icon={<Timer className="h-4 w-4 text-interactive-foreground" aria-hidden="true" />}
          iconTileClass="bg-primary-subtle"
          value={formatDuration(stats?.avgDuration)}
          hint={t('dashboard.failedCount', { count: stats?.byStatus.failed ?? 0 })}
          loading={statsLoading}
        />
        <StatCard
          title={t('dashboard.todayRuns')}
          icon={<CalendarDays className="h-4 w-4 text-warning" aria-hidden="true" />}
          iconTileClass="bg-warning-subtle"
          value={stats?.todayRuns ?? 0}
          hint={t('dashboard.todayQueuedCount', { count: stats?.todayByStatus.queued ?? 0 })}
          loading={statsLoading}
        />
        <StatCard
          title={
            <span className="inline-flex items-center gap-1">
              {t('dashboard.todayTokens')}
              <TokenUsageCoverageHelp />
            </span>
          }
          icon={<Coins className="h-4 w-4 text-interactive-foreground" aria-hidden="true" />}
          iconTileClass="bg-primary-subtle"
          value={formatTokens(sumTokenUsage(stats?.todayTokens ?? {}))}
          hint={`${t('runs.tokenIn')} ${formatTokens(stats?.todayTokens?.input)} / ${t('runs.tokenOut')} ${formatTokens(stats?.todayTokens?.output)}`}
          loading={statsLoading}
        />
        <StatCard
          title={t('dashboard.askerCount')}
          icon={<Users className="h-4 w-4 text-interactive-foreground" aria-hidden="true" />}
          iconTileClass="bg-primary-subtle"
          value={stats?.askerCount ?? 0}
          hint={t('dashboard.askerTodayCount', { count: stats?.todayAskerCount ?? 0 })}
          loading={statsLoading}
        />
      </div>

      {/* Agent leaderboards — runs, unique users & token usage, side by side */}
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        <LeaderboardCard
          title={t('dashboard.leaderboardByRuns')}
          entries={leaderboard?.byRuns ?? []}
          loading={leaderboardLoading}
          unit={(count) => t('dashboard.leaderboardCount', { count })}
        />
        <LeaderboardCard
          title={t('dashboard.leaderboardByUsers')}
          entries={leaderboard?.byUsers ?? []}
          loading={leaderboardLoading}
          unit={(count) => t('dashboard.leaderboardUsers', { count })}
        />
        <LeaderboardCard
          title={t('dashboard.leaderboardByTokens')}
          entries={leaderboard?.byTokens ?? []}
          loading={leaderboardLoading}
          unit={(count) => t('dashboard.leaderboardTokens', { tokens: formatTokens(count) })}
          emptyText={t('dashboard.tokenLeaderboardEmpty')}
        />
      </div>

      {/* Published Agents */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">
            {t('dashboard.publishedAgentsSection')}
          </h3>
          <Link
            to="/agents"
            className="text-xs font-medium text-interactive-foreground hover:underline underline-offset-4 transition-colors"
          >
            {t('dashboard.viewAll')}
          </Link>
        </div>

        {agentsLoading ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder, fixed count
              <Card key={`skeleton-agent-${i}`}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-10 rounded-lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : publishedAgents.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-6 text-sm text-muted-foreground text-center">
            {t('dashboard.noPublishedAgents')}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {publishedAgents.map((agent) => (
              <Link key={agent.id} to={`/agents/${agent.id}`} className="group">
                <Card className="group-hover:border-primary/15 group-hover:shadow-md transition-all h-full">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60 text-lg shrink-0">
                        {agent.icon || '🤖'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground truncate">
                            {agent.name}
                          </span>
                          <StatusDot status={agent.status} />
                        </div>
                        <div className="flex items-center gap-2 mt-1.5">
                          <Badge
                            variant={agent.status === 'active' ? 'success' : 'secondary'}
                            className="text-[10px] px-1.5 py-0"
                          >
                            {agent.status === 'active'
                              ? t('dashboard.active')
                              : t('dashboard.inactive')}
                          </Badge>
                        </div>
                        {agent.publishedAt && (
                          <p className="text-[11px] text-muted-foreground mt-1.5 flex items-center gap-1">
                            <Clock className="h-3 w-3" aria-hidden="true" />
                            {formatRelativeTime(agent.publishedAt)}
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Recent Runs */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">{t('dashboard.recentRuns')}</h3>
          <Link
            to="/runs"
            className="text-xs font-medium text-interactive-foreground hover:underline underline-offset-4 transition-colors"
          >
            {t('dashboard.viewAll')}
          </Link>
        </div>

        {runsLoading ? (
          <Card>
            <CardContent className="p-0">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder, fixed count
                  key={`skeleton-run-${i}`}
                  className="flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-b-0"
                >
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-5 w-16" />
                  <div className="flex-1" />
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </CardContent>
          </Card>
        ) : recentRuns.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-6 text-sm text-muted-foreground text-center">
            {t('dashboard.noRecentRuns')}
          </div>
        ) : (
          <Card>
            <CardContent className="p-0">
              {recentRuns.map((run, idx) => {
                const badgeCfg = STATUS_BADGE[run.status] ?? STATUS_BADGE.pending
                const step = (run as unknown as { steps?: { durationMs?: number | null }[] })
                  .steps?.[0]
                const duration = step?.durationMs
                return (
                  <Link
                    key={run.id}
                    to={
                      run.initiatorAgentId
                        ? `/agents/${run.initiatorAgentId}?tab=runs&runId=${run.id}`
                        : `/runs?runId=${run.id}`
                    }
                    className="flex items-center gap-3 px-4 py-3 hover:bg-surface-hover transition-colors border-b border-border/50 last:border-b-0"
                  >
                    <RunStatusIcon status={run.status} />
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-foreground truncate block">
                        {run.agentName ?? t('runs.noAgent')}
                      </span>
                      <span className="text-xs text-muted-foreground truncate block">
                        <RunCallerPrefix
                          name={run.triggerUserName}
                          callerAgentName={run.triggerAgentName}
                          source={run.triggerSource as RunTriggerSource | null}
                        />
                        {run.intent}
                      </span>
                    </div>
                    <Badge variant={badgeCfg.variant} className="text-[10px] shrink-0">
                      {t(badgeCfg.label)}
                    </Badge>
                    {duration != null && (
                      <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                        {formatDuration(duration)}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatRelativeTime(run.createdAt)}
                    </span>
                  </Link>
                )
              })}
            </CardContent>
          </Card>
        )}
      </div>

      <OnboardingWelcome />
    </div>
  )
}

function LeaderboardCard({
  title,
  entries,
  loading,
  unit,
  emptyText,
}: {
  title: string
  entries: AgentLeaderboardEntry[]
  loading: boolean
  unit: (count: number) => string
  emptyText?: string
}) {
  const { t } = useTranslation()
  const max = entries[0]?.count ?? 0

  return (
    <Card className="h-full">
      <CardContent className="p-5">
        <h3 className="mb-4 text-sm font-medium text-foreground">{title}</h3>
        {loading ? (
          <div className="space-y-3.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder, fixed count
                key={`skeleton-rank-${i}`}
                className="flex items-center gap-3"
              >
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-8" />
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {emptyText ?? t('dashboard.leaderboardEmpty')}
          </p>
        ) : (
          <ul className="space-y-2.5">
            {entries.map((agent, idx) => {
              const pct = max > 0 ? Math.round((agent.count / max) * 100) : 0
              return (
                <li key={agent.agentId}>
                  <Link to={`/agents/${agent.agentId}`} className="group flex items-center gap-2.5">
                    <span className="w-4 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                      {idx + 1}
                    </span>
                    <span className="shrink-0 text-sm" aria-hidden="true">
                      {agent.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground transition-colors group-hover:text-interactive-foreground">
                      {agent.name}
                    </span>
                    <span className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted sm:block lg:w-28 2xl:w-24">
                      <span
                        className="block h-full rounded-full bg-primary transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="w-14 shrink-0 truncate text-right text-xs tabular-nums text-muted-foreground">
                      {unit(agent.count)}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'active' ? 'bg-success' : 'bg-muted-foreground/30'
  return (
    <span className={`inline-block size-2 rounded-full shrink-0 ${color}`} aria-label={status} />
  )
}

function RunStatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-warning" aria-hidden="true" />
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
    case 'failed':
      return <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
    default:
      return <Circle className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
  }
}
