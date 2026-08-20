import {
  Check,
  Copy,
  Download,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  ScrollText,
  Trash2,
  Wrench,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FullLogViewer } from '@/components/full-log-viewer'
import { StreamLogsTimeline } from '@/components/stream-log-item'
import type { StreamLogEntry } from '@/hooks/use-agents'
import { useRun } from '@/hooks/use-runs'

/**
 * Normalize an error value into a renderable string. Failure reasons may be
 * stored either as a plain string or as a structured object
 * `{ code, message, retryable }`, which React cannot render directly.
 */
function formatError(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (typeof err === 'object' && 'message' in err)
    return String((err as { message: unknown }).message)
  return JSON.stringify(err)
}

/**
 * Find the tool call that is currently executing in a running step.
 * Scans logs and returns the last `tool_call:started` whose callId never
 * appears again as `completed` / `failed`. Returns null when no tool is
 * currently in flight.
 */
function findCurrentTool(
  logs: StreamLogEntry[] | undefined,
): { toolName: string; startedAt: number } | null {
  if (!logs || logs.length === 0) return null
  const settled = new Set<string>()
  for (const e of logs) {
    if (
      e.type === 'tool_call' &&
      (e.subtype === 'completed' || e.subtype === 'failed') &&
      e.callId
    ) {
      settled.add(e.callId)
    }
  }
  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i]
    if (e.type === 'tool_call' && e.subtype === 'started' && e.callId && !settled.has(e.callId)) {
      return { toolName: e.toolName, startedAt: e.ts }
    }
  }
  return null
}

/**
 * "Now: <tool> 45s" badge rendered in a running step header. Uses a
 * setInterval so the elapsed counter ticks up every second while the step
 * is still live, without waiting for the next poll cycle to refresh logs.
 */
function CurrentToolBadge({ toolName, startedAt }: { toolName: string; startedAt: number }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const elapsedSec = Math.max(0, Math.round((now - startedAt) / 1000))
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-primary-subtle px-1.5 py-0.5 text-2xs font-medium text-interactive-foreground"
      title={t('runLog.currentToolHint', { defaultValue: 'Tool currently executing' })}
    >
      <Wrench className="h-3 w-3 shrink-0" />
      <span className="truncate max-w-[160px]">{toolName}</span>
      <span className="font-mono">{elapsedSec}s</span>
    </span>
  )
}

import { Button } from '@/components/ui/button'
import type { Artifact } from '@/hooks/use-artifacts'
import { getArtifactDownloadUrl, useArtifacts, useDeleteArtifact } from '@/hooks/use-artifacts'
import { copyText } from '@/lib/clipboard'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  const { t } = useTranslation()
  const deleteArtifact = useDeleteArtifact()

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {t('artifacts.title')}
      </h4>
      <div className="space-y-1.5">
        {artifacts.map((artifact) => (
          <div
            key={artifact.id}
            className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2"
          >
            {artifact.kind === 'directory' ? (
              <Folder className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
            ) : (
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-mono truncate">{artifact.filename}</p>
              {artifact.size != null && (
                <p className="text-xs text-muted-foreground">{formatBytes(artifact.size)}</p>
              )}
            </div>
            <a
              href={getArtifactDownloadUrl(artifact.id)}
              download={
                artifact.kind === 'directory' ? `${artifact.filename}.zip` : artifact.filename
              }
              aria-label={t('artifacts.download')}
              title={
                artifact.kind === 'directory' ? t('artifacts.downloadZip') : t('artifacts.download')
              }
              className="shrink-0 inline-flex items-center justify-center size-7 rounded-md hover:bg-surface-hover hover:text-foreground transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
            </a>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => deleteArtifact.mutate(artifact.id)}
              disabled={deleteArtifact.isPending}
              aria-label={t('artifacts.delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

type StatusKey = 'pending' | 'queued' | 'running' | 'completed' | 'failed'

const statusColor: Record<StatusKey, string> = {
  pending: 'text-muted-foreground bg-muted',
  queued: 'text-muted-foreground bg-muted',
  running: 'text-warning bg-warning-subtle',
  completed: 'text-success bg-success-subtle',
  failed: 'text-destructive bg-destructive-subtle',
}

const statusLabelKey: Record<string, string> = {
  pending: 'dashboard.statusPending',
  queued: 'run.queued',
  running: 'dashboard.statusRunning',
  completed: 'dashboard.statusCompleted',
  failed: 'dashboard.statusFailed',
  cancelled: 'dashboard.statusCancelled',
}

export function RunLogContent({ runId }: { runId: string }) {
  const { t, i18n } = useTranslation()
  const { data: run, isLoading } = useRun(runId)
  const { data: artifacts } = useArtifacts(runId)
  const [copied, setCopied] = useState(false)
  const [fullLogOpen, setFullLogOpen] = useState(false)
  const locale = i18n.language === 'zh' ? 'zh-CN' : 'en-US'

  const handleCopy = async () => {
    if (!run) return
    // Intent alone is untraceable; lead with the id so pasted text names its run.
    const payload = run.intent ? `${run.id}\n\n${run.intent}` : run.id
    if (!(await copyText(payload))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!run) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">{t('runLog.notFound')}</div>
    )
  }

  return (
    <div className="space-y-4 select-text">
      {/* Run overview */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground font-mono">{run.id}</span>
            <button
              type="button"
              onClick={handleCopy}
              className="p-0.5 rounded hover:bg-surface-hover transition-colors"
              title={t('runLog.copyRunId')}
              aria-label={t('runLog.copyRunId')}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </button>
          </div>
          <span
            className={`text-2xs px-2 py-0.5 rounded-full font-medium ${statusColor[run.status as StatusKey] ?? statusColor.pending}`}
          >
            {statusLabelKey[run.status] ? t(statusLabelKey[run.status]) : run.status}
          </span>
        </div>
        <p className="text-sm text-foreground">{run.intent}</p>
        <div className="text-2xs text-muted-foreground">
          {new Date(run.createdAt).toLocaleString(locale)}
        </div>
      </div>

      {/* Steps */}
      {run.steps && run.steps.length > 0 && (
        <div className="space-y-3 pt-2 border-t border-border">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('runLog.steps')}
          </h4>
          {run.steps.map(
            (step: {
              id: string
              order: number
              status: string
              durationMs?: number | null
              input?: Record<string, unknown> | null
              output?: Record<string, unknown> | null
            }) => {
              const output = step.output as {
                result?: string
                chatId?: string
                logs?: StreamLogEntry[]
                error?: unknown
                retries?: Array<{ attempt: number; error?: unknown; durationMs?: number }>
              } | null
              const logs = output?.logs
              const hasLogs = logs && logs.length > 0
              const isRunning = step.status === 'running'
              const currentTool = isRunning ? findCurrentTool(logs) : null
              const execParamsEntry = logs?.find(
                (e): e is Extract<StreamLogEntry, { type: 'exec_params' }> =>
                  e.type === 'exec_params',
              )

              return (
                <div
                  key={step.id}
                  className="rounded-lg border border-border bg-card p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">Step #{step.order}</span>
                    <div className="flex items-center gap-2">
                      {currentTool && (
                        <CurrentToolBadge
                          toolName={currentTool.toolName}
                          startedAt={currentTool.startedAt}
                        />
                      )}
                      {step.durationMs != null && (
                        <span className="text-2xs text-muted-foreground">
                          {(step.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                      <span
                        className={`text-2xs px-1.5 py-0.5 rounded font-medium ${statusColor[step.status as StatusKey] ?? statusColor.pending}`}
                      >
                        {statusLabelKey[step.status] ? t(statusLabelKey[step.status]) : step.status}
                      </span>
                    </div>
                  </div>
                  {execParamsEntry && (
                    <details className="group">
                      <summary className="text-2xs text-muted-foreground cursor-pointer select-none list-none flex items-center gap-1 mb-1">
                        <span className="inline-block transition-transform group-open:rotate-90">
                          ▶
                        </span>
                        <span>{t('runLog.execParams')}</span>
                        <span className="ml-1 text-muted-foreground/60">
                          {execParamsEntry.engine}
                        </span>
                      </summary>
                      <pre className="text-2xs bg-muted/50 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                        {JSON.stringify(execParamsEntry.params, null, 2)}
                      </pre>
                    </details>
                  )}

                  {step.input && (
                    <div>
                      <div className="text-2xs text-muted-foreground mb-1">{t('runLog.input')}</div>
                      <pre className="text-2xs bg-muted/50 rounded p-2 overflow-auto max-h-32 whitespace-pre-wrap break-all">
                        {JSON.stringify(step.input, null, 2)}
                      </pre>
                    </div>
                  )}

                  {/* Error banner */}
                  {step.status === 'failed' && Boolean(output?.error) && (
                    <div className="overflow-hidden break-all rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-xs text-destructive">
                      <span className="font-medium">{t('runLog.error')}: </span>
                      {formatError(output?.error)}
                    </div>
                  )}

                  {/* Retry history */}
                  {output?.retries && output.retries.length > 0 && (
                    <div>
                      <div className="text-2xs text-muted-foreground mb-1.5">
                        {t('runLog.retries')}
                      </div>
                      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1.5">
                        {/* `attempt` is a PER-PROVIDER counter, so it repeats across a
                            provider chain (1,2,1,2). Index-based keys keep it unique. */}
                        {output.retries.map((r, retryIndex) => (
                          <div
                            key={`${retryIndex}-${r.attempt}`}
                            className="flex items-center gap-2 text-2xs"
                          >
                            <RefreshCw className="h-3 w-3 shrink-0 text-warning" />
                            <span>
                              {t('runLog.retryAttempt', { attempt: r.attempt })}
                              {Boolean(r.error) && (
                                <span className="ml-1 text-destructive">
                                  : {formatError(r.error)}
                                </span>
                              )}
                              {r.durationMs != null && (
                                <span className="text-muted-foreground ml-1">
                                  ({(r.durationMs / 1000).toFixed(1)}s)
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Stream logs timeline — auto-expanded while running so the
                    user can see progress without an extra click. */}
                  {(hasLogs || run.hasFullLog) && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-2xs text-muted-foreground">
                          {t('runLog.execLog')}
                        </span>
                        {/* DB 内 logs 受条数截断（保头丢尾）；NDJSON 旁路文件存在时
                          提供站内全量查看 + 下载入口 */}
                        {run.hasFullLog && (
                          <div className="flex items-center gap-2.5">
                            <button
                              type="button"
                              onClick={() => setFullLogOpen(true)}
                              className="inline-flex items-center gap-1 text-2xs text-interactive-foreground hover:underline"
                            >
                              <ScrollText className="h-3 w-3" />
                              {t('runLog.viewFullLog')}
                            </button>
                            <a
                              href={`/api/runs/${runId}/logs/download`}
                              download={`${runId}.ndjson`}
                              className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                              <Download className="h-3 w-3" />
                              {t('runLog.downloadFullLog')}
                            </a>
                          </div>
                        )}
                      </div>
                      {hasLogs && (
                        <div className="bg-muted/30 rounded p-2 overflow-auto max-h-64">
                          <StreamLogsTimeline logs={logs} defaultOpen={isRunning} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Output: show raw output JSON (excluding logs to avoid duplication) */}
                  {step.output &&
                    (() => {
                      const { logs: _l, ...rest } = step.output as Record<string, unknown>
                      return Object.keys(rest).length > 0 ? (
                        <div>
                          <div className="text-2xs text-muted-foreground mb-1">
                            {t('runLog.output')}
                          </div>
                          <pre className="text-2xs bg-muted/50 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                            {JSON.stringify(rest, null, 2)}
                          </pre>
                        </div>
                      ) : null
                    })()}
                </div>
              )
            },
          )}
        </div>
      )}

      {/* Run result */}
      {run.result && (
        <div className="space-y-2 pt-2 border-t border-border">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('runLog.result')}
          </h4>
          {run.status === 'failed' && (run.result as { error?: unknown }).error ? (
            <div className="overflow-hidden break-all rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-xs text-destructive">
              <span className="font-medium">{t('runLog.error')}: </span>
              {formatError((run.result as { error?: unknown }).error)}
            </div>
          ) : (
            <pre className="text-2xs bg-muted/50 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap break-all">
              {JSON.stringify(run.result, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Artifacts */}
      {artifacts && artifacts.length > 0 && <ArtifactList artifacts={artifacts} />}

      {/* Full log viewer (NDJSON sidecar, run-level) */}
      {run.hasFullLog && (
        <FullLogViewer runId={runId} open={fullLogOpen} onOpenChange={setFullLogOpen} />
      )}
    </div>
  )
}
