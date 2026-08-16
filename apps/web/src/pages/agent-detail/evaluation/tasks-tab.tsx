import { Select } from 'antd'
import { AlertTriangle, FlaskConical, Play, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgent } from '@/hooks/use-agents'
import {
  type EvaluationTaskRow,
  useCancelEvaluationTask,
  useCreateEvaluationTask,
  useDeleteEvaluationTask,
  useEvaluationSets,
  useEvaluationTasks,
} from '@/hooks/use-evaluation'
import { useScmSources } from '@/hooks/use-scm-sources'
import { confirm } from '@/lib/confirm'
import { formatRelativeTime } from '@/lib/utils'
import { TaskDetail } from './task-detail'
import { isTaskPending, TaskStatusBadge } from './task-status-badge'

interface TasksTabProps {
  agentId: string
  canWrite: boolean
}

export function TasksTab({ agentId, canWrite }: TasksTabProps) {
  const { t } = useTranslation()
  const { data: tasks, isLoading } = useEvaluationTasks(agentId)
  const [searchParams, setSearchParams] = useSearchParams()
  const [createOpen, setCreateOpen] = useState(false)

  // Which task is open lives in the URL, like the tab params around it, so the
  // view survives a refresh and can be linked to or shared.
  const openTaskId = searchParams.get('evalTask')

  const setOpenTaskId = (taskId: string | null) => {
    const next = new URLSearchParams(searchParams)
    if (taskId) next.set('evalTask', taskId)
    else next.delete('evalTask')
    setSearchParams(next, { replace: true })
  }

  if (openTaskId) {
    return (
      <TaskDetail
        agentId={agentId}
        taskId={openTaskId}
        canWrite={canWrite}
        onBack={() => setOpenTaskId(null)}
      />
    )
  }

  if (isLoading) return <Skeleton className="h-48 w-full" />

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('agentEvaluation.task.count', { count: tasks?.length ?? 0 })}
        </p>
        {canWrite && (
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
            <Play className="h-4 w-4" />
            {t('agentEvaluation.task.create')}
          </Button>
        )}
      </div>

      {!tasks?.length ? (
        <div className="flex flex-col items-center justify-center rounded-[10px] border border-dashed border-border py-16 text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-muted">
            <FlaskConical className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="mb-1.5 text-sm font-semibold text-foreground">
            {t('agentEvaluation.task.emptyTitle')}
          </h3>
          <p className="max-w-xs text-sm text-muted-foreground">
            {t('agentEvaluation.task.emptyDesc')}
          </p>
        </div>
      ) : (
        // Tinted rows, matching the case list: each run is its own clickable
        // surface that lifts on hover, rather than a line inside one slab.
        <div className="space-y-1">
          {tasks.map((task, index) => (
            <TaskRow
              key={task.id}
              agentId={agentId}
              task={task}
              previous={tasks[index + 1]}
              canWrite={canWrite}
              onOpen={() => setOpenTaskId(task.id)}
            />
          ))}
        </div>
      )}

      <CreateTaskDialog
        agentId={agentId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(taskId) => setOpenTaskId(taskId)}
      />
    </div>
  )
}

/**
 * Flags what changed against the previous (older) task's snapshot.
 *
 * Without this a user reads a pass-rate drop as a model regression when the
 * prompt is what actually changed. Derived from the snapshots — no extra state.
 */
function snapshotDelta(
  task: EvaluationTaskRow,
  previous: EvaluationTaskRow | undefined,
): 'model' | 'prompt' | null {
  if (!previous) return null
  const a = task.configSnapshot
  const b = previous.configSnapshot
  if (!a || !b) return null
  // Reasoning effort and fast mode ride with the model, and a change to either
  // moves the result as surely as swapping the model does — two tasks differing
  // only in reasoning depth are exactly the pair this flag exists to separate.
  //
  // Compared through `?? null`, because a task frozen before these fields
  // existed carries `undefined` while a new one carries `null`. Comparing those
  // directly flags every boundary pair as "config changed" — a warning about a
  // difference that is entirely in the storage format.
  if (
    a.model !== b.model ||
    a.providerId !== b.providerId ||
    (a.reasoningEffort ?? null) !== (b.reasoningEffort ?? null) ||
    (a.fastMode ?? null) !== (b.fastMode ?? null)
  ) {
    return 'model'
  }
  if (a.systemPrompt !== b.systemPrompt) return 'prompt'
  return null
}

function TaskRow({
  agentId,
  task,
  previous,
  canWrite,
  onOpen,
}: {
  agentId: string
  task: EvaluationTaskRow
  previous: EvaluationTaskRow | undefined
  canWrite: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const cancelTask = useCancelEvaluationTask(agentId)
  const deleteTask = useDeleteEvaluationTask(agentId)

  const summary = task.summary
  const delta = snapshotDelta(task, previous)
  const isActive = isTaskPending(task.status)

  const confirmDelete = () => {
    confirm({
      title: t('agentEvaluation.task.deleteTitle'),
      content: t('agentEvaluation.task.deleteDesc'),
      okText: t('common.delete'),
      danger: true,
      onOk: () => deleteTask.mutate(task.id),
    })
  }

  return (
    <div className="flex items-center gap-4 rounded-lg bg-muted/40 px-3 py-2.5 transition-colors hover:bg-surface-hover">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">
            {task.name || task.setName}
          </span>
          <TaskStatusBadge status={task.status} />
          {delta && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t(`agentEvaluation.task.changed.${delta}`)}
            </span>
          )}
        </div>
        {/* Only the config snapshot lives here — provider and model answer one
            question ("what was run"), so they read as a phrase rather than as
            two more links in a chain of unrelated facts. The pass count is
            gone: the percentage on the right already says it. */}
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {[task.configSnapshot?.providerName, task.configSnapshot?.model]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </button>

      {/* "When" is a different kind of fact from "what", so it gets its own
          column against the row's empty middle instead of being appended to
          the config line. Hidden on narrow viewports, where the space it needs
          would squeeze the name it sits next to. */}
      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block">
        {formatRelativeTime(task.createdAt)}
      </span>

      {/* Pass rate is the number people scan this list for, so it gets its own
          column with tabular figures. Fixed width so the percentages stack into
          a straight edge down the list rather than jittering with digit count. */}
      <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-foreground">
        {summary?.passRate != null ? `${Math.round(summary.passRate * 100)}%` : ''}
      </span>

      {canWrite && (
        <div className="flex shrink-0 items-center gap-1">
          {isActive ? (
            <Button variant="outline" size="sm" onClick={() => cancelTask.mutate(task.id)}>
              {t('common.cancel')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('common.delete')}
              onClick={confirmDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Whether this Agent's evaluations run in a workspace others can mutate.
 *
 * Local Agents get a per-task directory and git SCM Agents a per-task worktree.
 * P4 has neither: a client spec is server-side state bound to one Root, so
 * every execution on that source — evaluation, chat, sync — shares the single
 * checkout.
 */
function useSharesEvaluationWorkspace(agentId: string): boolean {
  const { data: agentSelection } = useAgent(agentId)
  const { data: scmSources } = useScmSources()

  const agent = agentSelection?.data
  if (!agent || agent.workspaceType !== 'scm' || !agent.scmSourceId) return false
  return scmSources?.data?.find((source) => source.id === agent.scmSourceId)?.type === 'p4'
}

function CreateTaskDialog({
  agentId,
  open,
  onOpenChange,
  onCreated,
}: {
  agentId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (taskId: string) => void
}) {
  const { t } = useTranslation()
  const { data: sets } = useEvaluationSets(agentId)
  const createTask = useCreateEvaluationTask(agentId)
  const sharesWorkspace = useSharesEvaluationWorkspace(agentId)
  const [setId, setSetId] = useState<string>('')
  const [name, setName] = useState('')

  const handleCreate = () => {
    if (!setId || createTask.isPending) return
    createTask.mutate(
      { setId, name: name.trim() || null },
      {
        onSuccess: (res) => {
          onOpenChange(false)
          setName('')
          onCreated(res.data.id)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('agentEvaluation.task.createTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="task-set">{t('agentEvaluation.task.setLabel')}</Label>
            <Select
              id="task-set"
              className="w-full"
              value={setId || undefined}
              onChange={setSetId}
              placeholder={t('agentEvaluation.task.setPlaceholder')}
              options={sets?.map((set) => ({ value: set.id, label: set.name })) ?? []}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-name">{t('agentEvaluation.task.nameLabel')}</Label>
            <Input
              id="task-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('agentEvaluation.task.namePlaceholder')}
            />
          </div>

          <p className="text-xs text-muted-foreground">{t('agentEvaluation.task.createHint')}</p>

          {sharesWorkspace && (
            <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <p className="text-xs text-muted-foreground">
                {t('agentEvaluation.task.sharedWorkspaceWarning')}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={!setId || createTask.isPending}>
            {t('agentEvaluation.task.run')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
