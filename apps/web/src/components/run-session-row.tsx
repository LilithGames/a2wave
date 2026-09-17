import type { RunSessionSummary, RunStatus, RunTriggerSource } from '@a2wave/shared'
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '@/lib/utils'
import { RunCallerPrefix } from './run-caller-prefix'
import { Badge } from './ui/badge'

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

function SessionStatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-warning" aria-hidden="true" />
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
    case 'failed':
      return <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
    default:
      return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  }
}

export function RunSessionRow({
  session,
  showAgent = false,
  showBorder = false,
  onSelect,
}: {
  session: RunSessionSummary
  showAgent?: boolean
  showBorder?: boolean
  onSelect: (runId: string) => void
}) {
  const { t } = useTranslation()
  const badgeCfg = STATUS_BADGE[session.status] ?? STATUS_BADGE.pending
  const status = t(badgeCfg.label)
  const turns = t('runs.turnCount', { count: session.turnCount })
  const failures = t('runs.failedTurnCount', { count: session.failedCount })

  return (
    <button
      type="button"
      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${showBorder ? 'border-b border-border/50' : ''}`}
      onClick={() => onSelect(session.id)}
      aria-label={t('runs.openSession', {
        intent: session.latestRun.intent,
        turns,
        failures,
        status,
      })}
    >
      <SessionStatusIcon status={session.status} />
      <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
        <div className="min-w-0 flex-1">
          {showAgent && (
            <span className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
              {session.latestRun.agentIcon && (
                <span aria-hidden="true">{session.latestRun.agentIcon}</span>
              )}
              <span className="truncate">{session.latestRun.agentName || t('runs.noAgent')}</span>
            </span>
          )}
          <span
            className={`${showAgent ? 'text-xs text-muted-foreground' : 'text-sm font-medium text-foreground'} block truncate`}
          >
            <RunCallerPrefix
              name={session.latestRun.triggerUserName}
              callerAgentName={session.latestRun.triggerAgentName}
              source={session.latestRun.triggerSource as RunTriggerSource | null}
            />
            {session.latestRun.intent}
          </span>
        </div>
        <div className="mt-1.5 flex shrink-0 flex-wrap items-center gap-1.5 sm:mt-0 sm:flex-nowrap">
          <Badge variant="outline" className="text-[10px]">
            {turns}
          </Badge>
          {session.failedCount > 0 && (
            <Badge variant="destructive" className="text-[10px]">
              {failures}
            </Badge>
          )}
          <Badge variant={badgeCfg.variant} className="shrink-0 text-[10px]" aria-live="polite">
            {status}
          </Badge>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelativeTime(session.updatedAt)}
          </span>
        </div>
      </div>
    </button>
  )
}
