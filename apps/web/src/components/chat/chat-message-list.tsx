/**
 * Shared conversation transcript, used by both the agent test drawer and the chat
 * app page so message rendering, streaming placeholders and empty states stay
 * identical across surfaces.
 */

import { AlertCircle, Bot, User } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { AttachmentChip } from '@/components/attachment-chip'
import { LinkifiedText } from '@/components/linkified-text'
import { MarkdownContent } from '@/components/markdown-content'
import { StreamingStatus } from '@/components/streaming-status'
import type { ChatMessageItem } from '@/hooks/use-agent-chat'
import type { StreamLogEntry } from '@/hooks/use-agents'
import { cn } from '@/lib/utils'

interface ChatMessageListProps {
  messages: ChatMessageItem[]
  streamLogs: StreamLogEntry[]
  isStreaming: boolean
  /** Hide the tool-call timeline; the chat app can opt for a purely conversational view. */
  showThinking?: boolean
  /** Agent avatar; falls back to the generic bot glyph. */
  agentIcon?: string
  /** Rendered in place of the transcript when there are no messages yet. */
  emptyState?: ReactNode
  /** Rendered after the last message (artifact lists, etc). */
  footer?: ReactNode
  className?: string
}

function AgentAvatar({ icon }: { icon?: string }) {
  return (
    <div className="flex-shrink-0 size-6 rounded-full bg-muted flex items-center justify-center mt-1 select-none">
      {icon ? (
        <span className="text-sm leading-none" aria-hidden="true">
          {icon}
        </span>
      ) : (
        <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  )
}

export function ChatMessageList({
  messages,
  streamLogs,
  isStreaming,
  showThinking = true,
  agentIcon,
  emptyState,
  footer,
  className,
}: ChatMessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is the trigger for re-scrolling
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className={cn('flex-1 overflow-y-auto overscroll-contain bg-background', className)}>
        {emptyState}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-3 overscroll-contain bg-background',
        className,
      )}
    >
      {messages.map((message, index) => {
        const isLastAgent = message.role === 'agent' && index === messages.length - 1
        // The tool-call timeline only ever attaches to the final agent message.
        const showStatus = isLastAgent && showThinking && streamLogs.length > 0
        const isEmptyAgent = message.role === 'agent' && !message.content?.trim()

        // A finished, contentless agent bubble carries nothing to show.
        if (isEmptyAgent && !showStatus && !isStreaming) return null

        // Pure streaming placeholder: the reply hasn't started arriving yet.
        if (isEmptyAgent && isLastAgent && isStreaming) {
          return (
            <div
              key={`${message.role}-${index}`}
              className="flex flex-col items-start animate-chat-message-in"
            >
              <div className="flex gap-2 justify-start w-full min-w-0">
                <AgentAvatar icon={agentIcon} />
                <div className="max-w-[85%] min-w-[200px] rounded-2xl px-3.5 py-2 bg-card text-foreground border border-border">
                  {showThinking ? (
                    <StreamingStatus logs={streamLogs} isStreaming={isStreaming} />
                  ) : (
                    <TypingDots />
                  )}
                </div>
              </div>
            </div>
          )
        }

        return (
          <div
            key={`${message.role}-${index}`}
            className={cn(
              'flex flex-col animate-chat-message-in',
              message.role === 'user' ? 'items-end' : 'items-start',
            )}
          >
            <div
              className={cn(
                'flex gap-2 w-full min-w-0',
                message.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              {message.role === 'agent' && <AgentAvatar icon={agentIcon} />}
              <div
                className={cn(
                  'max-w-[80%] overflow-hidden rounded-2xl px-3.5 py-2 transition-colors',
                  message.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : message.failed
                      ? 'bg-destructive/5 text-foreground border border-destructive/30'
                      : 'bg-card text-foreground border border-border',
                )}
              >
                {showStatus && (
                  <div className="mb-2 pb-2 border-b border-border">
                    <StreamingStatus logs={streamLogs} isStreaming={isStreaming} />
                  </div>
                )}
                {message.role === 'user' ? (
                  <>
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {message.attachments.map((att, i) => (
                          <AttachmentChip
                            key={`${att.name}-${i}`}
                            name={att.name}
                            previewUrl={att.previewUrl}
                            className="flex items-center gap-1.5 rounded-md border border-primary-foreground/20 bg-primary-foreground/10 px-2 py-1 text-xs"
                          />
                        ))}
                      </div>
                    )}
                    <LinkifiedText className="block text-sm" text={message.content} />
                  </>
                ) : message.failed ? (
                  <div className="flex items-start gap-2">
                    <AlertCircle
                      className="h-4 w-4 mt-0.5 shrink-0 text-destructive"
                      aria-hidden="true"
                    />
                    <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                  </div>
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
          </div>
        )
      })}
      {footer}
      <div ref={messagesEndRef} />
    </div>
  )
}

/**
 * Three-dot typing indicator for surfaces that hide the tool-call timeline.
 * `<output>` carries the `status` role natively, so screen readers announce the
 * label politely without an explicit role attribute.
 */
export function TypingDots() {
  const { t } = useTranslation()
  return (
    <output className="flex items-center gap-1 py-1" aria-live="polite">
      <span className="sr-only">{t('streaming.thinking')}</span>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1.5 rounded-full bg-muted-foreground/60 animate-chat-typing-dot"
          style={{ animationDelay: `${delay}ms` }}
          aria-hidden="true"
        />
      ))}
    </output>
  )
}
