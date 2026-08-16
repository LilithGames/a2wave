import { type EvaluationTaskStatus, REVIEWABLE_RESULT_STATUSES } from '@a2wave/shared'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Clock, Loader2, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  type EvaluationResultRow,
  useEvaluationTask,
  useReviewEvaluationResult,
} from '@/hooks/use-evaluation'
import { CopyButton } from '../copy-button'
import { isTaskPending, TaskStatusBadge } from './task-status-badge'

interface TaskDetailProps {
  agentId: string
  taskId: string
  canWrite: boolean
  onBack: () => void
}

export function TaskDetail({ agentId, taskId, canWrite, onBack }: TaskDetailProps) {
  const { t } = useTranslation()
  const { data: task, isLoading, isError } = useEvaluationTask(agentId, taskId)
  const [promptOpen, setPromptOpen] = useState(false)

  if (isLoading) return <Skeleton className="h-64 w-full" />

  // The task id lives in the URL so a task can be linked and survive a refresh,
  // which means a link to a since-deleted task is a normal thing to open. Left
  // as a skeleton it would spin forever with no way back — the back arrow lives
  // in the body that never renders.
  if (isError || !task) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-[10px] border border-border/60 px-6 py-16 text-center">
        <p className="text-sm text-muted-foreground">{t('agentEvaluation.task.notFound')}</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          {t('agentEvaluation.task.backToList')}
        </Button>
      </div>
    )
  }

  const summary = task.summary
  const prompt = task.configSnapshot?.systemPrompt?.trim() ?? ''
  // While the task is still executing the list keeps its execution order, so
  // the progress visibly walks down the page. Re-sorting unreviewed-first at
  // that point would make rows jump around under the user on every poll; that
  // ordering only helps once the work is done and review begins.
  const results = isTaskPending(task.status)
    ? [...task.results].sort((a, b) => a.sortOrder - b.sortOrder)
    : [...task.results].sort((a, b) => {
        // Unreviewed first: the remaining work stays at the top of the list.
        const aDone = a.review?.verdict && a.review.verdict !== 'unreviewed' ? 1 : 0
        const bDone = b.review?.verdict && b.review.verdict !== 'unreviewed' ? 1 : 0
        return aDone - bDone || a.sortOrder - b.sortOrder
      })

  const reviewed = (summary?.passed ?? 0) + (summary?.failed ?? 0)

  return (
    <div className="space-y-5">
      {/* Detail header, matching the shape used by the standalone detail pages
          (mcp-server, provider): icon-only back arrow, icon tile, title with the
          run's identity beneath. This is what tells the user they navigated
          rather than switched a filter. */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('agentEvaluation.task.backToList')}
          title={t('agentEvaluation.task.backToList')}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold tracking-tight text-foreground">
            {task.name || task.setName}
          </h2>
          <p className="truncate text-xs text-muted-foreground">{task.setName}</p>
        </div>

        <TaskStatusBadge status={task.status} />
      </div>

      {/* Execution progress. Shown only while the task is unfinished: once every
          case has run, the pass rate below is the number that matters and a
          full bar is just noise. */}
      {isTaskPending(task.status) && (
        <ExecutionProgress status={task.status} results={task.results} />
      )}

      {/* Meta region — tinted inset so it reads as information *about* the run,
          visually distinct from the reviewable cases below. */}
      <div className="rounded-[10px] bg-muted/30 p-4">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <p className="text-xs text-muted-foreground">{t('agentEvaluation.task.passRate')}</p>
            {/* Colour-coded, because the whole run exists to produce this number
                and "100%" in plain grey reads no differently from "40%". */}
            <p
              className={`mt-0.5 text-2xl font-semibold tabular-nums leading-none ${passRateTone(
                summary?.passRate ?? null,
              )}`}
            >
              {summary?.passRate == null ? '—' : `${Math.round(summary.passRate * 100)}%`}
            </p>
          </div>
          <Stat
            label={t('agentEvaluation.task.passed')}
            value={summary?.passed ?? 0}
            tone={summary?.passed ? 'text-emerald-600' : undefined}
          />
          <Stat
            label={t('agentEvaluation.task.failed')}
            value={summary?.failed ?? 0}
            tone={summary?.failed ? 'text-destructive' : undefined}
          />
          <Stat label={t('agentEvaluation.task.unreviewed')} value={summary?.unreviewed ?? 0} />
        </div>

        {/* The snapshot is the point of the whole feature — it is what lets one
            run be compared against another — so provider and model sit in the
            open rather than behind a disclosure. The prompt is the one field
            too long to inline, so it gets copy + view affordances instead. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border/60 pt-3 text-xs">
          <SnapshotRow
            label={t('agentEvaluation.task.snapshotProvider')}
            value={task.configSnapshot?.providerName ?? '—'}
          />
          <SnapshotRow
            label={t('agentEvaluation.task.snapshotModel')}
            value={task.configSnapshot?.model ?? '—'}
          />
          {/* Shown only when frozen: they are optional controls, and a row from
              before they existed carries null for both. Rendering "—" for every
              historical task would add two permanent empty columns. */}
          {task.configSnapshot?.reasoningEffort ? (
            <SnapshotRow
              label={t('agentEvaluation.task.snapshotReasoningEffort')}
              value={task.configSnapshot.reasoningEffort}
            />
          ) : null}
          {typeof task.configSnapshot?.fastMode === 'boolean' ? (
            <SnapshotRow
              label={t('agentEvaluation.task.snapshotFastMode')}
              value={t(
                task.configSnapshot.fastMode
                  ? 'agentEvaluation.task.snapshotFastModeOn'
                  : 'agentEvaluation.task.snapshotFastModeOff',
              )}
            />
          ) : null}
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">
              {t('agentEvaluation.task.snapshotPrompt')}
            </span>
            {/* View only: copying lives inside the dialog, since anyone
                copying a prompt has necessarily just read it there. */}
            {prompt ? (
              <button
                type="button"
                onClick={() => setPromptOpen(true)}
                className="rounded px-1.5 py-0.5 text-xs text-interactive-foreground transition-colors hover:bg-surface-hover"
              >
                {t('agentEvaluation.task.viewPrompt')}
              </button>
            ) : (
              <span className="text-foreground">—</span>
            )}
          </div>
        </div>
      </div>

      <Dialog open={promptOpen} onOpenChange={setPromptOpen} width={720}>
        <DialogContent>
          <DialogHeader>
            <div className="flex items-center gap-1.5">
              <DialogTitle>{t('agentEvaluation.task.snapshotPrompt')}</DialogTitle>
              <CopyButton text={prompt} label={t('agentEvaluation.task.copyPrompt')} />
            </div>
          </DialogHeader>
          <pre className="mt-4 max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs text-foreground">
            {prompt}
          </pre>
        </DialogContent>
      </Dialog>

      {/* Case list — the work area, under its own heading so it is clearly a
          different kind of thing from the meta block above. */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            {t('agentEvaluation.task.resultsTitle')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t('agentEvaluation.task.reviewProgress', {
              reviewed,
              total: summary?.total ?? results.length,
            })}
          </p>
        </div>

        {results.map((result) => (
          <ResultCard
            key={result.id}
            agentId={agentId}
            taskId={taskId}
            result={result}
            canWrite={canWrite}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * How far through its cases a task is, plus which one is running right now.
 *
 * The page already had a "reviewed x / y" counter, but that measures *human*
 * progress; while a task is executing the user is asking a different question —
 * is it moving, and how much is left. Derived from the result rows rather than
 * a server-side counter, so it costs nothing beyond the poll already in flight.
 */
function ExecutionProgress({
  status,
  results,
}: {
  status: EvaluationTaskStatus
  results: EvaluationResultRow[]
}) {
  const { t } = useTranslation()

  const total = results.length
  const done = results.filter((r) => r.status === 'completed' || r.status === 'failed').length
  const current = results.find((r) => r.status === 'running')
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)

  // Queued means nothing is executing yet, so a progress bar at 0% would imply
  // stalled work. The wait itself is the message.
  if (status === 'queued' || status === 'pending') {
    return (
      <div className="flex items-center gap-2 rounded-[10px] bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <Clock aria-hidden="true" className="h-3.5 w-3.5" />
        <span>{t('agentEvaluation.task.queuedHint')}</span>
      </div>
    )
  }

  return (
    <div className="rounded-[10px] bg-muted/30 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Loader2
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin text-interactive-foreground"
          />
          {t('agentEvaluation.task.executing')}
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {t('agentEvaluation.task.executionProgress', { done, total })}
        </p>
      </div>

      {/* Presentational: the "3/10" counter above already states the progress in
          text, so announcing it a second time as a progressbar role would just
          make screen readers repeat themselves. */}
      <div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/60">
        {/* Transitioned so each completed case slides the bar forward instead of
            snapping — the movement is what reads as "still alive". */}
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>

      {current && (
        <p className="mt-2 truncate text-xs text-muted-foreground">
          {t('agentEvaluation.task.currentCase', { name: current.caseName })}
        </p>
      )}
    </div>
  )
}

/**
 * Pass-rate colour. Thresholds are deliberately coarse — this is a "glance and
 * know" signal, not a grade. Nothing reviewed yet stays neutral rather than
 * green, so an unreviewed run is never mistaken for a perfect one.
 */
function passRateTone(rate: number | null): string {
  if (rate == null) return 'text-muted-foreground'
  if (rate >= 0.9) return 'text-emerald-600'
  if (rate >= 0.6) return 'text-amber-600'
  return 'text-destructive'
}

/** Secondary counter: label above, figure below, aligned to the pass-rate baseline. */
function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-0.5 text-base font-medium tabular-nums leading-none ${tone ?? 'text-foreground'}`}
      >
        {value}
      </p>
    </div>
  )
}

/**
 * One half of the verdict toggle. The selected segment uses a soft tint rather
 * than a solid fill: a page of a dozen cases with saturated green and red
 * buttons reads as a wall of traffic lights. A tint is enough to identify the
 * verdict without competing with the case names for attention.
 */
function VerdictButton({
  active,
  activeClass,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  activeClass: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
        active ? activeClass : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <p className="min-w-0">
      <span className="text-muted-foreground">{label} </span>
      <span className="text-foreground">{value}</span>
    </p>
  )
}

type VerdictValue = 'pass' | 'fail' | 'unreviewed'

const VERDICT_DOT_CLASS: Record<VerdictValue, string> = {
  pass: 'bg-emerald-600',
  fail: 'bg-destructive',
  unreviewed: 'bg-border',
}

/**
 * The single place a case's execution state becomes visuals.
 *
 * Execution state and review verdict compete for the same slot: while a case is
 * still executing the verdict dot has nothing to say yet, so the slot carries
 * execution state instead. Keeping every branch here means a new result status
 * is one edit rather than five scattered `result.status === …` checks that
 * silently fall through to a grey "unreviewed" dot.
 */
function caseMarker(
  status: EvaluationResultRow['status'],
  verdict: VerdictValue,
): { icon: 'spinner' | 'ring' | 'dot'; dotClass: string; labelKey: string | null; muted: boolean } {
  switch (status) {
    case 'running':
      return { icon: 'spinner', dotClass: '', labelKey: 'caseRunning', muted: false }
    case 'pending':
      return { icon: 'ring', dotClass: '', labelKey: 'caseWaiting', muted: true }
    case 'cancelled':
      return { icon: 'dot', dotClass: 'bg-border', labelKey: 'caseCancelled', muted: true }
    default:
      return { icon: 'dot', dotClass: VERDICT_DOT_CLASS[verdict], labelKey: null, muted: false }
  }
}

function ResultCard({
  agentId,
  taskId,
  result,
  canWrite,
}: {
  agentId: string
  taskId: string
  result: EvaluationResultRow
  canWrite: boolean
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const review = useReviewEvaluationResult(agentId, taskId)

  const verdict = result.review?.verdict ?? 'unreviewed'
  const marker = caseMarker(result.status, verdict)
  // A case with no answer yet has nothing to judge, and the API rejects the
  // verdict anyway — showing the buttons would only offer a guaranteed error.
  const reviewable = REVIEWABLE_RESULT_STATUSES.includes(result.status)
  const turns =
    result.actualTurns ?? result.turnsSnapshot.map((turn) => ({ ...turn, actualResponse: null }))

  return (
    // Keeps an outline rather than a tint like the other lists: expanding a
    // result reveals tinted expected/actual panes, and a tinted container
    // behind them would wash the two together.
    <div className="rounded-[10px] border border-border/60 p-4 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          {marker.icon === 'spinner' ? (
            <Loader2
              aria-hidden="true"
              className="h-3 w-3 shrink-0 animate-spin text-interactive-foreground"
            />
          ) : marker.icon === 'ring' ? (
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full border border-border"
            />
          ) : (
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${marker.dotClass}`}
            />
          )}
          <span
            className={`truncate text-sm font-medium ${
              marker.muted ? 'text-muted-foreground' : 'text-foreground'
            }`}
          >
            {result.caseName}
          </span>
          {marker.labelKey && (
            <span
              className={`shrink-0 text-xs ${
                marker.icon === 'spinner' ? 'text-interactive-foreground' : 'text-muted-foreground'
              }`}
            >
              {t(`agentEvaluation.task.${marker.labelKey}`)}
            </span>
          )}
          {/* Execution failure is a different fact from a failed verdict: the
              run never produced an answer to judge. */}
          {result.status === 'failed' && (
            <Badge variant="destructive">{t('agentEvaluation.task.execFailed')}</Badge>
          )}
        </button>

        {/* Pass and fail are one mutually exclusive choice, so they are one
            control. The old version showed a verdict badge *and* a highlighted
            tick *and* a cross — three elements asserting the same fact, with the
            cross reading as "delete" rather than "mark as failed". The selected
            segment is the verdict, so no separate badge is needed. */}
        {canWrite && reviewable ? (
          <fieldset
            aria-label={t('agentEvaluation.task.verdictGroup')}
            className="flex shrink-0 overflow-hidden rounded-md border border-border/60"
          >
            <VerdictButton
              active={verdict === 'pass'}
              activeClass="bg-emerald-50 text-emerald-700"
              disabled={review.isPending}
              onClick={() => review.mutate({ resultId: result.id, verdict: 'pass' })}
            >
              <Check className="h-3.5 w-3.5" />
              {t('agentEvaluation.task.verdict.pass')}
            </VerdictButton>
            <div className="w-px bg-border/60" />
            <VerdictButton
              active={verdict === 'fail'}
              activeClass="bg-red-50 text-red-700"
              disabled={review.isPending}
              onClick={() => review.mutate({ resultId: result.id, verdict: 'fail' })}
            >
              <X className="h-3.5 w-3.5" />
              {t('agentEvaluation.task.verdict.fail')}
            </VerdictButton>
          </fieldset>
        ) : (
          verdict !== 'unreviewed' && (
            <Badge variant={verdict === 'pass' ? 'default' : 'destructive'}>
              {t(`agentEvaluation.task.verdict.${verdict}`)}
            </Badge>
          )
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          {result.error && (
            <p className="rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
              {result.error}
            </p>
          )}

          {turns.map((turn, index) => (
            <div key={`${result.id}-turn-${index}`} className="rounded-md border border-border p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {t('agentEvaluation.case.turnLabel', { index: index + 1 })}
              </p>
              <p className="mb-2 text-xs text-foreground">
                <span className="text-muted-foreground">
                  {t('agentEvaluation.case.requestLabel')}:{' '}
                </span>
                {turn.request}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-md bg-muted/30 p-2.5">
                  <p className="mb-1 text-xs text-muted-foreground">
                    {t('agentEvaluation.case.expectedLabel')}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                    {turn.expectedResponse || '—'}
                  </p>
                </div>
                <div className="rounded-md bg-muted/30 p-2.5">
                  <p className="mb-1 text-xs text-muted-foreground">
                    {t('agentEvaluation.task.actualLabel')}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                    {turn.actualResponse ?? '—'}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
