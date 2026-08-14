import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  Rocket,
  Settings,
  Wrench,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StreamLogEntry } from '@/hooks/use-agents'
import { formatTokens } from '@/lib/format-tokens'

/** Format a timestamp relative to a base time */
export function formatRelativeTs(ts: number, baseTs?: number): string {
  if (!baseTs) return new Date(ts).toLocaleTimeString('zh-CN')
  const diff = Math.round((ts - baseTs) / 1000)
  if (diff < 0) return '0s'
  const min = Math.floor(diff / 60)
  const sec = diff % 60
  return min > 0 ? `${min}m${sec}s` : `${sec}s`
}

/** Truncate text for display */
export function truncateText(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

const A2A_TASK_EVENT_LABELS: Record<string, string> = {
  'a2a.task.observed': 'runLog.a2aTaskObserved',
  'a2a.task.state': 'runLog.a2aTaskState',
  'a2a.task.poll_retry': 'runLog.a2aTaskPollRetry',
  'a2a.task.reconnect': 'runLog.a2aTaskReconnect',
  'a2a.task.resubscribe_failed': 'runLog.a2aTaskResubscribeFailed',
  'a2a.task.cancel_requested': 'runLog.a2aTaskCancelRequested',
  'a2a.task.cancel_result': 'runLog.a2aTaskCancelResult',
  'a2a.task.cancel_failed': 'runLog.a2aTaskCancelFailed',
}

/** Assistant message entry with collapsible detail */
function AssistantEntry({
  entry,
  timeLabel,
}: {
  entry: Extract<StreamLogEntry, { type: 'assistant' }>
  timeLabel: string
}) {
  const [open, setOpen] = useState(false)
  const text = entry.text.trim()
  const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer select-none items-start gap-2 text-left text-2xs"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Bot className="mt-0.5 h-3 w-3 shrink-0 text-interactive-foreground" />
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground mt-0.5 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-muted-foreground font-mono shrink-0 mt-0.5">{timeLabel}</span>
        <span className="text-foreground/80 truncate">{preview}</span>
      </button>
      {open && (
        <pre className="text-2xs text-muted-foreground ml-5 pl-2 border-l border-border whitespace-pre-wrap break-all">
          {truncateText(JSON.stringify(entry, null, 2), 500)}
        </pre>
      )}
    </div>
  )
}

/** Tool call entry with collapsible detail */
function ToolCallEntry({
  entry,
  timeLabel,
}: {
  entry: Extract<StreamLogEntry, { type: 'tool_call' }>
  timeLabel: string
}) {
  const [open, setOpen] = useState(false)
  const hasInput = entry.input && Object.keys(entry.input).length > 0

  // Build detail content: show input, error, or callId fallback
  const detailText = hasInput
    ? truncateText(JSON.stringify(entry.input, null, 2), 500)
    : entry.error
      ? entry.error
      : `callId: ${entry.callId}`

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer select-none items-center gap-2 text-left text-2xs"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Wrench className="h-3 w-3 shrink-0 text-interactive-foreground" />
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-muted-foreground font-mono shrink-0">{timeLabel}</span>
        <span
          className={`truncate ${
            entry.subtype === 'completed'
              ? 'text-success'
              : entry.subtype === 'failed'
                ? 'text-destructive'
                : 'text-interactive-foreground'
          }`}
        >
          {entry.subtype === 'completed' ? '✓ ' : entry.subtype === 'failed' ? '✗ ' : '▷ '}
          {entry.toolName}
        </span>
      </button>
      {open && (
        <pre className="text-2xs text-muted-foreground ml-5 pl-2 border-l border-border whitespace-pre-wrap break-all">
          {detailText}
        </pre>
      )}
    </div>
  )
}

/** Render a single stream log entry */
export function StreamLogItem({ entry, baseTs }: { entry: StreamLogEntry; baseTs?: number }) {
  const { t } = useTranslation()
  const timeLabel = formatRelativeTs(entry.ts, baseTs)

  switch (entry.type) {
    case 'system': {
      if (entry.subtype.startsWith('a2a.task.')) {
        const labelKey = A2A_TASK_EVENT_LABELS[entry.subtype]
        const label = labelKey ? t(labelKey) : t('runLog.systemEvent', { subtype: entry.subtype })
        const metadata = [
          entry.metadata?.target,
          entry.metadata?.taskId,
          entry.metadata?.state,
          entry.metadata?.attempt != null ? `#${entry.metadata.attempt}` : undefined,
        ].filter((value): value is string => Boolean(value))
        const failed =
          entry.subtype === 'a2a.task.cancel_failed' ||
          entry.subtype === 'a2a.task.resubscribe_failed'
        return (
          <div className="flex min-w-0 items-center gap-2 text-2xs">
            {failed ? (
              <AlertCircle className="h-3 w-3 shrink-0 text-warning" />
            ) : (
              <RefreshCw className="h-3 w-3 shrink-0 text-interactive-foreground" />
            )}
            <span className="text-muted-foreground font-mono shrink-0">{timeLabel}</span>
            <span className="text-foreground/80 shrink-0">{label}</span>
            {metadata.length > 0 && (
              <span className="truncate font-mono text-muted-foreground">
                {metadata.join(' · ')}
              </span>
            )}
          </div>
        )
      }
      // 全量日志文件的写入护栏标记 —— 必须醒目展示，落入"系统初始化"兜底
      // 会恰好掩盖"日志被截断/丢弃"这个最该被看到的信息。
      if (
        entry.subtype === 'log_file_size_capped' ||
        entry.subtype === 'log_file_entries_dropped'
      ) {
        const label =
          entry.subtype === 'log_file_size_capped'
            ? entry.dropped
              ? t('runLog.logFileSizeCappedWithDropped', { dropped: entry.dropped })
              : t('runLog.logFileSizeCapped')
            : t('runLog.logFileEntriesDropped', { dropped: entry.dropped ?? 0 })
        return (
          <div className="flex items-center gap-2 text-2xs">
            <AlertCircle className="h-3 w-3 shrink-0 text-warning" />
            <span className="text-muted-foreground font-mono shrink-0">{timeLabel}</span>
            <span className="text-warning">{label}</span>
          </div>
        )
      }
      const icon =
        entry.subtype === 'preparing' || entry.subtype === 'spawned' ? (
          <Rocket className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <Settings className="h-3 w-3 shrink-0 text-muted-foreground" />
        )
      let label: string
      if (entry.subtype === 'truncated') label = t('runLog.logsTruncated')
      else if (entry.subtype === 'provider_attempt')
        label = t('runLog.providerAttempt', {
          provider: entry.providerName,
          model: entry.model ?? '',
          defaultValue: entry.model
            ? `Provider attempt · ${entry.providerName} · ${entry.model}`
            : `Provider attempt · ${entry.providerName}`,
        })
      else if (entry.subtype === 'provider_fallback')
        label = t('runLog.providerFallback', {
          provider: entry.providerName,
          nextProvider: entry.nextProviderName,
          defaultValue: `Provider fallback · ${entry.providerName} → ${entry.nextProviderName}`,
        })
      else if (entry.subtype === 'preparing')
        label = t('runLog.preparing', { defaultValue: 'Preparing runtime…' })
      else if (entry.subtype === 'spawned')
        label = t('runLog.spawned', { defaultValue: 'Process started' })
      else if (entry.model) label = t('runLog.systemInitModel', { model: entry.model })
      else if (entry.subtype === 'init' || entry.subtype === 'system')
        label = t('runLog.systemInit')
      // claude-code 引擎会透传 CLI 流里的任意 system 事件（hook/status/…）。
      // 完整日志查看器全量展示这些条目，必须显示真实 subtype——全部冒充
      // "系统初始化"会变成几十行不可区分的噪音。
      else label = t('runLog.systemEvent', { subtype: entry.subtype })
      return (
        <div className="flex items-center gap-2 text-2xs">
          {icon}
          <span className="text-muted-foreground font-mono shrink-0">{timeLabel}</span>
          <span className="text-muted-foreground">{label}</span>
        </div>
      )
    }

    case 'assistant':
      return <AssistantEntry entry={entry} timeLabel={timeLabel} />

    case 'tool_call':
      return <ToolCallEntry entry={entry} timeLabel={timeLabel} />

    case 'tool_heartbeat':
      return (
        <div className="flex items-center gap-2 text-2xs">
          <Loader2 className="h-3 w-3 shrink-0 text-muted-foreground animate-spin" />
          <span className="text-muted-foreground font-mono shrink-0">{timeLabel}</span>
          <span className="text-muted-foreground">
            {t('runLog.toolHeartbeat', {
              defaultValue: '{{tool}} still running {{seconds}}s',
              tool: entry.toolName,
              seconds: Math.round(entry.elapsedMs / 1000),
            })}
          </span>
        </div>
      )

    case 'result':
      return (
        <div className="flex items-center gap-2 text-2xs">
          <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
          <span className="text-muted-foreground font-mono shrink-0">{timeLabel}</span>
          <span className="text-success">
            {entry.durationMs != null
              ? t('runLog.completedDuration', { duration: (entry.durationMs / 1000).toFixed(1) })
              : t('runLog.completed')}
          </span>
          {entry.usage && (
            <span className="text-muted-foreground">
              {t('runs.tokenIn')} {formatTokens(entry.usage.inputTokens)} / {t('runs.tokenOut')}{' '}
              {formatTokens(entry.usage.outputTokens)}
            </span>
          )}
        </div>
      )

    case 'error':
      return (
        <div className="flex items-center gap-2 text-2xs min-w-0">
          <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
          <span className="text-muted-foreground font-mono shrink-0">{timeLabel}</span>
          <span className="truncate text-destructive">{truncateText(entry.message, 300)}</span>
        </div>
      )

    case 'retry':
      return (
        <div className="flex items-center gap-2 text-2xs">
          <RefreshCw className="h-3 w-3 shrink-0 text-warning" />
          <span className="text-muted-foreground font-mono shrink-0">{timeLabel}</span>
          <span className="text-warning">
            {t('runLog.retryInStream', {
              attempt: entry.attempt,
              seconds: (entry.nextAttemptIn / 1000).toFixed(1),
            })}
          </span>
        </div>
      )

    default:
      return null
  }
}

/** Render the structured stream logs timeline (collapsible) */
export function StreamLogsTimeline({
  logs,
  defaultOpen = false,
}: {
  logs: StreamLogEntry[]
  defaultOpen?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)

  // When the parent transitions the step from pending → running, ensure the
  // timeline auto-expands without clobbering a manual user collapse that
  // happened AFTER the step became running.
  const [lastAutoDefault, setLastAutoDefault] = useState(defaultOpen)
  useEffect(() => {
    if (defaultOpen && !lastAutoDefault) {
      setOpen(true)
      setLastAutoDefault(true)
    } else if (!defaultOpen && lastAutoDefault) {
      setLastAutoDefault(false)
    }
  }, [defaultOpen, lastAutoDefault])

  if (!logs || logs.length === 0) return null

  const baseTs = logs[0]?.ts

  // Filter out noisy system events and blank assistant messages, but keep
  // truncated marker + the new startup lifecycle events (preparing/spawned)
  // which are valuable when diagnosing "stuck before first LLM response".
  const visibleSystemSubtypes = new Set([
    'truncated',
    'preparing',
    'spawned',
    'provider_attempt',
    'provider_fallback',
  ])
  const filtered = logs.filter((e) => {
    if (
      e.type === 'system' &&
      !visibleSystemSubtypes.has(e.subtype) &&
      !e.subtype.startsWith('a2a.task.')
    ) {
      return false
    }
    if (e.type === 'assistant' && !e.text.trim()) return false
    return true
  })

  // Build summary
  const toolCalls = filtered.filter((e) => e.type === 'tool_call').length
  const messages = filtered.filter((e) => e.type === 'assistant').length
  const resultEntry = logs.find((e) => e.type === 'result')
  const durationMs = resultEntry && 'durationMs' in resultEntry ? resultEntry.durationMs : undefined
  const durationLabel = durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : undefined
  const model = logs.find((e) => e.type === 'system' && e.subtype === 'init' && 'model' in e)
  const modelLabel = model && 'model' in model ? (model as { model?: string }).model : undefined

  const parts = [
    toolCalls > 0 ? t('runLog.toolCallsSummary', { count: toolCalls }) : null,
    messages > 0 ? t('runLog.messagesSummary', { count: messages }) : null,
    durationLabel,
    modelLabel,
  ].filter(Boolean)

  return (
    <div className="space-y-1.5">
      <div>
        <button
          type="button"
          className="flex items-center gap-1.5 text-2xs text-muted-foreground cursor-pointer select-none hover:text-foreground/70 transition-colors"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight
            className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <span>{parts.join(' · ') || t('runLog.execLog')}</span>
        </button>
        {open && (
          <div className="space-y-1.5 mt-1.5 ml-1 pl-3 border-l border-border/50">
            {filtered.map((entry, i) => (
              <StreamLogItem key={`${entry.ts}-${i}`} entry={entry} baseTs={baseTs} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
