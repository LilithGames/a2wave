import { ListRestart } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useRerunRuns } from '@/hooks/use-runs'
import { message } from '@/lib/antd-static'
import { confirm } from '@/lib/confirm'

/**
 * Bulk replay of the failed Runs on the current Runs page.
 *
 * A Provider credential that lapses fails every Run triggered while it was
 * down, all for the same reason and all recoverable by the same action. The
 * per-Run rerun in the detail drawer is the wrong tool for that shape of
 * outage — this is the bulk path, deliberately scoped to the page the operator
 * is looking at rather than to "all failed Runs ever", so what gets replayed is
 * exactly what is on screen.
 */

export interface RunsRetryAllController {
  /** Failed Runs on screen that this recovery has not already replayed. */
  pendingRunIds: string[]
  replaying: boolean
  canRetry: boolean
  retryAll: () => void
}

/**
 * Owns the recovery state, deliberately apart from the button.
 *
 * The button lives in the Runs tab bar and unmounts the moment the operator
 * switches tabs — including while a batch is still in flight. Holding "already
 * replayed" and "still running" in the button would reset both on the way
 * back, re-offering Runs that were just submitted. So the caller keeps this
 * hook mounted for the whole page and hands the button the result.
 */
export function useRunsRetryAll(failedRunIds: string[], canRetry: boolean): RunsRetryAllController {
  const { t } = useTranslation()
  const rerunRuns = useRerunRuns()
  const [replaying, setReplaying] = useState(false)
  // A rerun creates a new Run and leaves the original `failed`, so the Runs a
  // click just replayed get pushed onto the following pages. Remembering them
  // for as long as this recovery lasts is what keeps "page through and click
  // again" from replaying the same work twice.
  const alreadyReplayed = useRef(new Set<string>())
  const [replayedCount, setReplayedCount] = useState(0)
  const pendingRunIds = useMemo(
    () => failedRunIds.filter((runId) => !alreadyReplayed.current.has(runId)),
    // `replayedCount` is the dependency that re-derives this after a replay:
    // the ref itself never changes identity.
    [failedRunIds, replayedCount],
  )

  const retryAll = useCallback(() => {
    if (pendingRunIds.length === 0 || !canRetry || replaying) return
    confirm({
      title: t('agentDetail.runsRetryAllConfirmTitle'),
      content: t('agentDetail.runsRetryAllConfirmContent', { total: pendingRunIds.length }),
      okText: t('agentDetail.runsRetryAllFailed'),
      onOk: async () => {
        setReplaying(true)
        try {
          // Oldest first: the list is newest-first, so replaying in reverse
          // re-queues the Runs in the order they originally happened.
          const batch = [...pendingRunIds].reverse()
          for (const runId of batch) alreadyReplayed.current.add(runId)
          setReplayedCount((count) => count + batch.length)
          const { succeeded, failed, failedRunIds: rejected } = await rerunRuns.mutateAsync(batch)
          // A rejected replay never ran, so it goes back on offer.
          for (const runId of rejected) alreadyReplayed.current.delete(runId)
          setReplayedCount((count) => count - rejected.length)
          if (failed > 0) {
            message.error(t('agentDetail.runsRetryAllPartial', { succeeded, failed }))
          } else {
            message.success(t('agentDetail.runsRetryAllDone', { total: succeeded }))
          }
        } finally {
          setReplaying(false)
        }
      },
    })
  }, [canRetry, pendingRunIds, replaying, rerunRuns, t])

  return { pendingRunIds, replaying, canRetry, retryAll }
}

export function RunsRetryAllButton({ controller }: { controller: RunsRetryAllController }) {
  const { t } = useTranslation()
  const { pendingRunIds, replaying, canRetry, retryAll } = controller

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
      disabled={pendingRunIds.length === 0 || replaying || !canRetry}
      onClick={retryAll}
      data-testid="runs-retry-all"
      title={
        !canRetry
          ? t('agentDetail.members.readOnlyHint')
          : pendingRunIds.length === 0
            ? t('agentDetail.runsRetryAllEmpty')
            : t('agentDetail.runsRetryAllFailed')
      }
    >
      {/* Not a circular arrow: sitting next to the tab's refresh it would read
          as a second refresh button rather than a bulk action on the list. */}
      <ListRestart
        className={`h-3.5 w-3.5 ${replaying ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {t('agentDetail.runsRetryAllFailed')}
    </Button>
  )
}
