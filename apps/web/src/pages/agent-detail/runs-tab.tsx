import { RunCallerPrefix } from '@/components/run-caller-prefix'
import { RunDetailDrawer } from '@/components/run-detail-drawer'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { useRuns } from '@/hooks/use-runs'
import { formatRelativeTime } from '@/lib/utils'
import type { RunStatus, RunTriggerSource } from '@a2wave/shared'
import { Activity, CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

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

function RunStatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-4 w-4 text-amber-500 animate-spin shrink-0" aria-hidden="true" />
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" aria-hidden="true" />
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500 shrink-0" aria-hidden="true" />
    default:
      return <Circle className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
  }
}

const PAGE_SIZE = 15

interface RunsTabProps {
  agentId: string | undefined
  refetchRef?: React.MutableRefObject<(() => void) | undefined>
  onFetchingChange?: (isFetching: boolean) => void
}

export function RunsTab({ agentId, refetchRef, onFetchingChange }: RunsTabProps) {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(1, Number.parseInt(searchParams.get('runsPage') ?? '1') || 1)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams)
    if (nextPage <= 1) {
      next.delete('runsPage')
    } else {
      next.set('runsPage', String(nextPage))
    }
    setSearchParams(next)
  }

  useEffect(() => {
    const runId = searchParams.get('runId')
    if (runId) {
      setSelectedRunId(runId)
    }
  }, [searchParams])

  const handleCloseDetail = () => {
    setSelectedRunId(null)
    const newParams = new URLSearchParams(searchParams)
    newParams.delete('runId')
    setSearchParams(newParams, { replace: true })
  }

  const {
    data: runsData,
    isLoading,
    isFetching,
    refetch,
  } = useRuns({
    agentId,
    page,
    pageSize: PAGE_SIZE,
  })

  useEffect(() => {
    if (refetchRef) refetchRef.current = refetch
  }, [refetch, refetchRef])

  useEffect(() => {
    onFetchingChange?.(isFetching)
  }, [isFetching, onFetchingChange])

  const runs = runsData?.data
  const pagination = runsData?.pagination

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder, fixed count
            key={i}
            className="flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-b-0"
          >
            <Skeleton className="h-4 w-4 rounded-full shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-5 w-16 rounded-md" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    )
  }

  if (!runs || runs.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-20 px-8">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-gradient-subtle text-interactive-foreground mb-5">
            <Activity className="h-7 w-7" aria-hidden="true" />
          </div>
          <h3 className="font-semibold text-base mb-1 text-foreground">{t('runs.empty')}</h3>
          <p className="text-sm text-muted-foreground text-center max-w-xs">
            {t('runs.emptyDesc')}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {runs.map((run, idx) => {
          const badgeCfg = STATUS_BADGE[run.status as RunStatus] ?? STATUS_BADGE.pending
          const showBorder = idx < runs.length - 1
          return (
            <div
              key={run.id}
              className={`flex items-center gap-3 px-4 py-3 hover:bg-surface-hover cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${showBorder ? 'border-b border-border/50' : ''}`}
              // biome-ignore lint/a11y/useSemanticElements: a <button> would impose its own
              // display/typography reset on this full-width list row and break the flex layout
              // the surrounding rounded list depends on.
              role="button"
              tabIndex={0}
              onClick={() => setSelectedRunId(run.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedRunId(run.id)
                }
              }}
            >
              <RunStatusIcon status={run.status as RunStatus} />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-foreground truncate block">
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
              <span className="text-xs text-muted-foreground shrink-0">
                {formatRelativeTime(run.createdAt)}
              </span>
            </div>
          )
        })}
      </div>

      {pagination && (
        <Pagination
          className="mt-4"
          pagination={pagination}
          onPageChange={setPage}
          totalLabel={t('runs.paginationTotal', { total: pagination.total })}
          previousLabel={t('runs.prevPage')}
          nextLabel={t('runs.nextPage')}
        />
      )}

      <RunDetailDrawer runId={selectedRunId} open={!!selectedRunId} onClose={handleCloseDetail} />
    </>
  )
}
