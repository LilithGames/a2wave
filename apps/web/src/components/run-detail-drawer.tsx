import { Drawer } from 'antd'
import {
  Bot,
  Loader2,
  MessageSquare,
  RotateCcw,
  ScrollText,
  StopCircle,
  User,
  X,
  XCircle,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AttachmentChip } from '@/components/attachment-chip'
import { LinkifiedText } from '@/components/linkified-text'
import { MarkdownContent } from '@/components/markdown-content'
import { RunLogContent } from '@/components/run-log-content'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ChatMessageWithAttachments } from '@/hooks/use-chat-history'
import { useCancelRun, useRerunRun, useRun } from '@/hooks/use-runs'
import { historyRefToSentAttachment } from '@/lib/attachments'
import { formatTokens } from '@/lib/format-tokens'
import { cn } from '@/lib/utils'

const statusVariant = {
  pending: 'secondary' as const,
  queued: 'secondary' as const,
  running: 'warning' as const,
  completed: 'success' as const,
  failed: 'destructive' as const,
  cancelled: 'secondary' as const,
}

const statusLabelKey: Record<string, string> = {
  pending: 'dashboard.statusPending',
  queued: 'run.queued',
  running: 'dashboard.statusRunning',
  completed: 'dashboard.statusCompleted',
  failed: 'dashboard.statusFailed',
  cancelled: 'dashboard.statusCancelled',
}

export function RunDetailDrawer({
  runId,
  open,
  onClose,
}: {
  runId: string | null
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [showLogs, setShowLogs] = useState(false)
  const { data: run, isLoading } = useRun(runId ?? '')
  const cancelRun = useCancelRun()
  const rerunRun = useRerunRun()

  const handleClose = () => {
    setShowLogs(false)
    onClose()
  }

  return (
    <>
      {/* 运行日志 Drawer - 左侧 */}
      <Drawer
        open={!!runId && open && showLogs}
        onClose={() => setShowLogs(false)}
        placement="right"
        size={400}
        zIndex={1001}
        rootClassName="no-close-animation"
        styles={{
          wrapper: { boxShadow: '-2px 0 8px rgba(0,0,0,0.08)', right: 480 },
          body: { padding: 0 },
          mask: { backgroundColor: 'transparent' },
        }}
        closable={false}
        mask={false}
      >
        <div className="flex flex-col h-full bg-card">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ScrollText className="h-4 w-4" aria-hidden="true" />
              {t('runDetail.runLog')}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => setShowLogs(false)}
              aria-label={t('runDetail.closeLog')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
            {runId && <RunLogContent runId={runId} />}
          </div>
        </div>
      </Drawer>

      {/* 聊天记录 Drawer - 右侧 */}
      <Drawer
        open={open}
        onClose={handleClose}
        placement="right"
        size={480}
        zIndex={1000}
        closable={false}
        destroyOnHidden
        styles={{
          body: { padding: 0, overflowX: 'hidden' },
          mask: { backgroundColor: 'rgba(0, 0, 0, 0.15)' },
        }}
      >
        <div className="flex flex-col h-full bg-card">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <MessageSquare
                className="h-4 w-4 text-muted-foreground shrink-0"
                aria-hidden="true"
              />
              <span className="text-sm font-medium text-foreground truncate" title={run?.intent}>
                {isLoading ? t('common.loading') : (run?.intent ?? t('runDetail.runDetails'))}
              </span>
              {run && (
                <Badge
                  variant={statusVariant[run.status as keyof typeof statusVariant] ?? 'secondary'}
                  className="shrink-0"
                >
                  {statusLabelKey[run.status] ? t(statusLabelKey[run.status]) : run.status}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              {run && (run.status === 'running' || run.status === 'queued') && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive"
                  onClick={() => cancelRun.mutate(run.id)}
                  disabled={cancelRun.isPending}
                  aria-label={t('runDetail.cancel')}
                  title={t('runDetail.cancel')}
                >
                  <StopCircle className="h-4 w-4" />
                </Button>
              )}
              {run && ['completed', 'failed', 'cancelled'].includes(run.status) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => rerunRun.mutate(run.id, { onSuccess: handleClose })}
                  disabled={rerunRun.isPending}
                  aria-label={t('runDetail.rerun')}
                  title={t('runDetail.rerun')}
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn('size-8', showLogs && 'bg-muted')}
                onClick={() => setShowLogs((v) => !v)}
                aria-label={t('runDetail.toggleLog')}
                title={t('runDetail.runLog')}
              >
                <ScrollText className="h-4 w-4" />
              </Button>
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
          </div>

          {/* Run-level token usage — only when the run carries any usage field */}
          {run &&
          (run.inputTokens != null ||
            run.outputTokens != null ||
            run.reasoningTokens != null ||
            run.cacheReadTokens != null ||
            run.cacheWriteTokens != null) ? (
            <div className="px-4 py-1.5 border-b border-border shrink-0 text-xs text-muted-foreground">
              {t('runs.tokenUsage')}: {t('runs.tokenIn')} {formatTokens(run.inputTokens)} ·{' '}
              {t('runs.tokenOut')} {formatTokens(run.outputTokens)}
              {run.reasoningTokens != null &&
                ` · ${t('runs.tokenReasoning')} ${formatTokens(run.reasoningTokens)}`}
              {run.cacheReadTokens != null &&
                ` · ${t('runs.tokenCacheRead')} ${formatTokens(run.cacheReadTokens)}`}
              {run.cacheWriteTokens != null &&
                ` · ${t('runs.tokenCacheWrite')} ${formatTokens(run.cacheWriteTokens)}`}
            </div>
          ) : null}

          {/* Content */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            {!runId ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                {t('runDetail.selectRun')}
              </div>
            ) : (
              <ChatContent run={run} isLoading={isLoading} t={t} />
            )}
          </div>
        </div>
      </Drawer>
    </>
  )
}

// ─── Chat Messages ────────────────────────────────────────────
function ChatContent({
  run,
  isLoading,
  t,
}: {
  run: ReturnType<typeof useRun>['data']
  isLoading: boolean
  t: (key: string) => string
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!run) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        {t('runDetail.runNotFound')}
      </div>
    )
  }

  // 附件回显：服务端 GET /runs/:id 已把附件配到各 message.attachments（复用后端 pairing，
  // 不在前端重复配对，避免序号漂移）。图片走 GET 端点预览，暂存过期则降级文件 chip。
  const messages = (run.messages ?? []) as (ChatMessageWithAttachments & { id: string })[]

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-muted mb-4">
          <MessageSquare className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-sm text-muted-foreground">{t('runDetail.noChat')}</p>
      </div>
    )
  }

  const isRunning = run.status === 'running' || run.status === 'pending' || run.status === 'queued'
  const lastMessage = messages[messages.length - 1]
  const showThinking = isRunning && lastMessage?.role === 'user'

  return (
    <div className="p-4 space-y-3">
      {messages.map((message) => {
        if (message.role === 'agent' && !message.content?.trim()) {
          return null
        }
        return (
          <div
            key={message.id}
            className={`flex flex-col w-full ${message.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`flex gap-2 w-full ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {message.role === 'agent' && (
                <div className="flex-shrink-0 size-6 rounded-full bg-muted flex items-center justify-center mt-1">
                  <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                </div>
              )}
              <div
                className={`rounded-2xl px-3.5 py-2 ${
                  message.role === 'user'
                    ? 'max-w-[80%] bg-primary text-primary-foreground'
                    : 'flex-1 min-w-0 bg-card text-foreground border border-border'
                }`}
              >
                {message.role === 'user' ? (
                  <>
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {message.attachments.map((ref, i) => {
                          const att = historyRefToSentAttachment(ref)
                          return (
                            <AttachmentChip
                              key={`${att.name}-${i}`}
                              name={att.name}
                              previewUrl={att.previewUrl}
                              className="flex items-center gap-1.5 rounded-md border border-primary-foreground/20 bg-primary-foreground/10 px-2 py-1 text-xs"
                            />
                          )
                        })}
                      </div>
                    )}
                    <LinkifiedText className="block text-sm" text={message.content} />
                  </>
                ) : (
                  <MarkdownContent content={message.content} />
                )}
              </div>
              {message.role === 'user' && (
                <div className="flex-shrink-0 size-6 rounded-full bg-primary flex items-center justify-center mt-1">
                  <User className="h-3.5 w-3.5 text-primary-foreground" aria-hidden="true" />
                </div>
              )}
            </div>
            <span
              className={`text-2xs text-muted-foreground/50 mt-0.5 ${message.role === 'user' ? 'mr-8' : 'ml-8'}`}
            >
              {new Date(message.createdAt).toLocaleTimeString('zh-CN')}
            </span>
          </div>
        )
      })}
      {showThinking && (
        <div className="flex flex-col items-start">
          <div className="flex gap-2 justify-start">
            <div className="flex-shrink-0 size-6 rounded-full bg-muted flex items-center justify-center mt-1">
              <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="max-w-[80%] rounded-2xl px-3.5 py-2.5 bg-card text-foreground border border-border">
              <div className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{t('runDetail.agentThinking')}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      {run.status === 'failed' && (
        <div className="flex items-start gap-2 px-1 py-1">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0 flex-1 break-all rounded-2xl border border-destructive/30 bg-destructive-subtle px-3.5 py-2 text-sm text-destructive">
            {(() => {
              const err = (run.result as { error?: unknown } | null)?.error
              if (typeof err === 'string') return err
              if (err && typeof err === 'object' && 'message' in err)
                return (err as { message: string }).message
              return t('runDetail.executionFailed')
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
