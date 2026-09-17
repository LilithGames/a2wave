import type { RunStatus, RunTriggerSource } from '@a2wave/shared'
import { Drawer } from 'antd'
import { CircleAlert, ExternalLink, Loader2, MessageSquare, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatMessageWithAttachments } from '@/hooks/use-chat-history'
import { useRunSession } from '@/hooks/use-runs'
import { formatRelativeTime } from '@/lib/utils'
import { RunCallerPrefix } from './run-caller-prefix'
import { RunChatContent, RunDetailDrawer } from './run-detail-drawer'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

const STATUS_BADGE: Record<
  RunStatus,
  { variant: 'secondary' | 'destructive' | 'success' | 'warning'; label: string }
> = {
  running: { variant: 'warning', label: 'dashboard.statusRunning' },
  completed: { variant: 'success', label: 'dashboard.statusCompleted' },
  failed: { variant: 'destructive', label: 'dashboard.statusFailed' },
  pending: { variant: 'secondary', label: 'dashboard.statusPending' },
  queued: { variant: 'secondary', label: 'dashboard.statusQueued' },
  cancelled: { variant: 'secondary', label: 'dashboard.statusCancelled' },
}

export function RunSessionDetailDrawer({
  runId,
  open,
  onClose,
}: {
  runId: string | null
  open: boolean
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const { data: session, isLoading, isError, refetch } = useRunSession(runId ?? '')
  const [detailRunId, setDetailRunId] = useState<string | null>(null)
  const positionedRunIdRef = useRef<string | null>(null)
  const sessionRuns = session?.runs

  const orderedRuns = useMemo(
    () =>
      [...(sessionRuns ?? [])].sort((a, b) => {
        const byCreatedAt =
          new Date(a.run.createdAt).getTime() - new Date(b.run.createdAt).getTime()
        return byCreatedAt || a.run.id.localeCompare(b.run.id)
      }),
    [sessionRuns],
  )

  useEffect(() => {
    if (!open) positionedRunIdRef.current = null
  }, [open])

  const positionRequestedRun = (element: HTMLElement | null, requestedRunId: string) => {
    if (
      !element ||
      !open ||
      requestedRunId !== runId ||
      positionedRunIdRef.current === requestedRunId
    ) {
      return
    }
    element.scrollIntoView?.({ block: 'center' })
    positionedRunIdRef.current = requestedRunId
  }

  const handleClose = () => {
    setDetailRunId(null)
    onClose()
  }

  const summaryStatus = session?.summary.status
  const summaryBadge = summaryStatus ? STATUS_BADGE[summaryStatus] : undefined

  return (
    <>
      <Drawer
        open={open}
        onClose={handleClose}
        placement="right"
        size={560}
        zIndex={900}
        closable={false}
        destroyOnHidden
        aria-label={t('runDetail.conversationDetails')}
        styles={{
          body: { padding: 0, overflowX: 'hidden' },
          mask: { backgroundColor: 'rgba(0, 0, 0, 0.15)' },
        }}
      >
        <section
          className="flex h-full flex-col bg-card"
          aria-label={t('runDetail.conversationDetails')}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <MessageSquare
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span
                className="truncate text-sm font-medium text-foreground"
                title={session?.summary.latestRun.intent}
              >
                {isLoading
                  ? t('common.loading')
                  : (session?.summary.latestRun.intent ?? t('runDetail.conversationDetails'))}
              </span>
              {session?.summary && (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {t('runs.turnCount', { count: session.summary.turnCount })}
                </Badge>
              )}
              {summaryBadge && summaryStatus && (
                <Badge
                  variant={summaryBadge.variant}
                  className="shrink-0 text-[10px]"
                  aria-live="polite"
                  data-testid="session-status"
                >
                  {t(summaryBadge.label)}
                </Badge>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={handleClose}
              aria-label={t('runDetail.close')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto overflow-x-hidden bg-muted/20 p-4">
            {isLoading ? (
              <div
                className="flex h-full items-center justify-center text-muted-foreground"
                aria-live="polite"
              >
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                <span className="sr-only">{t('common.loading')}</span>
              </div>
            ) : isError && !session ? (
              <div
                className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
                role="alert"
              >
                <CircleAlert className="h-6 w-6 text-destructive" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">
                  {t('runDetail.loadConversationFailed')}
                </p>
                <Button variant="outline" size="sm" onClick={() => void refetch()}>
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('runDetail.retryLoad')}
                </Button>
              </div>
            ) : !session || orderedRuns.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t('runDetail.noConversation')}
              </div>
            ) : (
              <div className="space-y-4">
                {orderedRuns.map((entry, index) => {
                  const { run } = entry
                  const badge = STATUS_BADGE[run.status] ?? STATUS_BADGE.pending
                  const isRequested = run.id === runId
                  return (
                    <section
                      key={run.id}
                      ref={(element) => positionRequestedRun(element, run.id)}
                      data-testid="session-run"
                      data-run-id={run.id}
                      data-session-run-id={run.id}
                      aria-current={isRequested ? 'true' : undefined}
                      className={`overflow-hidden rounded-xl border bg-card ${
                        isRequested ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border'
                      }`}
                    >
                      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
                        <span className="shrink-0 text-xs font-medium text-foreground">
                          {t('runDetail.runLabel', { number: index + 1 })}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          <RunCallerPrefix
                            name={run.triggerUserName}
                            callerAgentName={run.triggerAgentName}
                            source={run.triggerSource as RunTriggerSource | null}
                          />
                          {run.intent}
                        </span>
                        <Badge variant={badge.variant} className="shrink-0 text-[10px]">
                          {t(badge.label)}
                        </Badge>
                        <span className="hidden shrink-0 text-2xs text-muted-foreground sm:block">
                          {formatRelativeTime(run.createdAt)}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0"
                          onClick={() => setDetailRunId(run.id)}
                          aria-label={t('runDetail.openRunDetails', { number: index + 1 })}
                          title={t('runDetail.openRunDetails', { number: index + 1 })}
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                      <RunChatContent
                        run={{
                          ...run,
                          messages: entry.messages as ChatMessageWithAttachments[],
                        }}
                        isLoading={false}
                        t={t}
                        language={i18n.language}
                      />
                    </section>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      </Drawer>

      <RunDetailDrawer
        runId={detailRunId}
        open={!!detailRunId}
        onClose={() => setDetailRunId(null)}
      />
    </>
  )
}
