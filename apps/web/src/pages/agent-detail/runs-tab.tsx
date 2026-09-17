import { Activity, CircleAlert, RefreshCw } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { RunSessionDetailDrawer } from '@/components/run-session-detail-drawer'
import { RunSessionRow } from '@/components/run-session-row'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { useRunSessions } from '@/hooks/use-runs'

const PAGE_SIZE = 15

interface RunsTabProps {
  agentId: string | undefined
  refetchRef?: React.MutableRefObject<(() => void) | undefined>
  onFetchingChange?: (isFetching: boolean) => void
  /**
   * Reports the failed Runs of the page currently on screen, in display order.
   * The bulk-retry action lives in the tab bar (outside this component), and it
   * must act on exactly the Runs the operator can see.
   */
  onFailedRunIdsChange?: (runIds: string[], listUpdatedAt: number) => void
}

export function RunsTab({
  agentId,
  refetchRef,
  onFetchingChange,
  onFailedRunIdsChange,
}: RunsTabProps) {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(1, Number.parseInt(searchParams.get('runsPage') ?? '1', 10) || 1)
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
    setSelectedRunId(searchParams.get('runId'))
  }, [searchParams])

  const handleCloseDetail = () => {
    setSelectedRunId(null)
    const newParams = new URLSearchParams(searchParams)
    newParams.delete('runId')
    setSearchParams(newParams, { replace: true })
  }

  const {
    data: runsData,
    dataUpdatedAt,
    isLoading,
    isFetching,
    isError,
    refetch,
  } = useRunSessions({
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

  const sessions = runsData?.data
  const pagination = runsData?.pagination

  // Joined into a string so the effect below compares by value: `filter()`
  // returns a fresh array on every render and would otherwise re-notify the
  // parent forever.
  const failedRunIdsKey = useMemo(
    () =>
      (sessions ?? [])
        .flatMap((session) => session.failedRunIds)
        .filter((runId, index, all) => all.indexOf(runId) === index)
        .join(','),
    [sessions],
  )

  useEffect(() => {
    // `dataUpdatedAt` travels with the ids on purpose: an unchanged set of
    // failed Runs is still news when it comes from a fresher fetch — that is
    // how the bulk retry tells "failed again" from "not refreshed yet".
    onFailedRunIdsChange?.(failedRunIdsKey ? failedRunIdsKey.split(',') : [], dataUpdatedAt ?? 0)
  }, [failedRunIdsKey, dataUpdatedAt, onFailedRunIdsChange])

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

  if (isError && !runsData) {
    return (
      <Card>
        <CardContent
          className="flex flex-col items-center justify-center gap-3 px-8 py-20 text-center"
          role="alert"
        >
          <CircleAlert className="h-7 w-7 text-destructive" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t('runs.loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('runs.retryLoad')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!sessions || sessions.length === 0) {
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
        {sessions.map((session, idx) => (
          <RunSessionRow
            key={session.id}
            session={session}
            showBorder={idx < sessions.length - 1}
            onSelect={setSelectedRunId}
          />
        ))}
      </div>

      {pagination && (
        <Pagination
          className="mt-4"
          pagination={pagination}
          onPageChange={setPage}
          totalLabel={t('runs.sessionPaginationTotal', { total: pagination.total })}
          previousLabel={t('runs.prevPage')}
          nextLabel={t('runs.nextPage')}
        />
      )}

      <RunSessionDetailDrawer
        runId={selectedRunId}
        open={!!selectedRunId}
        onClose={handleCloseDetail}
      />
    </>
  )
}
