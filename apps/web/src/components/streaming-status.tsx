import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTs, StreamLogItem } from '@/components/stream-log-item'
import type { StreamLogEntry } from '@/hooks/use-agents'

interface StreamingStatusProps {
  logs: StreamLogEntry[]
  isStreaming: boolean
}

/** Count meaningful steps (tool_call started + assistant entries) */
function countSteps(logs: StreamLogEntry[]): number {
  return logs.filter(
    (e) => (e.type === 'tool_call' && e.subtype === 'started') || e.type === 'assistant',
  ).length
}

/** Get the latest activity label for the summary line */
function getLatestActivity(
  logs: StreamLogEntry[],
  t: (key: string, opts?: { name?: string; count?: number }) => string,
): string {
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i]
    if (entry.type === 'tool_call' && entry.subtype === 'started') {
      return t('streaming.toolCalling', { name: entry.toolName })
    }
    if (entry.type === 'tool_call' && entry.subtype === 'completed') {
      return t('streaming.toolDone', { name: entry.toolName })
    }
    if (entry.type === 'assistant') {
      const text = entry.text.length > 40 ? `${entry.text.slice(0, 40)}…` : entry.text
      return text
    }
    if (entry.type === 'result') {
      return t('streaming.completed')
    }
    if (entry.type === 'error') {
      return t('streaming.error')
    }
  }
  return t('streaming.init')
}

export function StreamingStatus({ logs, isStreaming }: StreamingStatusProps) {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const prevStreamingRef = useRef(isStreaming)

  // Auto-collapse when streaming finishes
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && logs.length > 0) {
      setExpanded(false)
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming, logs.length])

  // Auto-scroll to latest log entry when expanded
  // biome-ignore lint/correctness/useExhaustiveDependencies: logs.length is the trigger for re-scrolling
  useEffect(() => {
    if (expanded && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'instant', block: 'nearest' })
    }
  }, [logs.length, expanded])

  if (logs.length === 0 && isStreaming) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">{t('streaming.thinking')}</span>
      </div>
    )
  }

  if (logs.length === 0) return null

  const baseTs = logs[0]?.ts
  const stepCount = countSteps(logs)
  const latestActivity = getLatestActivity(logs, t)
  const elapsed =
    logs.length > 0 ? formatRelativeTs(logs[logs.length - 1].ts, baseTs, i18n.language) : ''

  return (
    <div className="space-y-1.5">
      {/* Summary / toggle header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left group"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        {isStreaming && (
          <Loader2
            className="h-3 w-3 animate-spin text-muted-foreground shrink-0"
            aria-hidden="true"
          />
        )}
        <span className="text-2xs text-muted-foreground truncate">
          {isStreaming ? latestActivity : t('streaming.stepsDone', { count: stepCount })}
        </span>
        {elapsed && (
          <span className="text-2xs text-muted-foreground/60 font-mono shrink-0 ml-auto">
            {elapsed}
          </span>
        )}
      </button>

      {/* Expandable log entries */}
      {expanded && (
        <div className="overflow-x-hidden overflow-y-auto max-h-48 rounded bg-muted/30 p-2 space-y-1">
          {logs
            .filter(
              (e) =>
                (e.type !== 'system' || e.subtype === 'truncated') &&
                !(e.type === 'assistant' && !e.text.trim()),
            )
            .map((entry, i) => (
              <StreamLogItem key={`${entry.ts}-${i}`} entry={entry} baseTs={baseTs} />
            ))}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  )
}
