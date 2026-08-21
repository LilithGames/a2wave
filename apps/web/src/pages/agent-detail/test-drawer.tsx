import { Drawer } from 'antd'
import { AlertCircle, MessageSquare, Plus, ScrollText, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatComposer } from '@/components/chat/chat-composer'
import { ChatMessageList } from '@/components/chat/chat-message-list'
import { InlineArtifactList } from '@/components/chat/inline-artifact-list'
import { RunLogContent } from '@/components/run-log-content'
import { Button } from '@/components/ui/button'
import { useAgentChat } from '@/hooks/use-agent-chat'
import { cn } from '@/lib/utils'

interface TestDrawerProps {
  open: boolean
  onClose: () => void
  agentId: string | undefined
  agentStatus: string | undefined
  agentIcon: string
}

export function TestDrawer({ open, onClose, agentId, agentStatus, agentIcon }: TestDrawerProps) {
  const { t } = useTranslation()
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  const canChat = agentStatus === 'active'
  const chatDisabledReason = !canChat ? t('agentDetail.agentInactive') : null

  const chat = useAgentChat({
    agentId,
    canChat,
    disabledReason: chatDisabledReason,
    channel: 'debug',
  })

  // The drawer stays mounted for the whole page, so reopening it must re-read the
  // session list — otherwise it resumes whatever was newest at page load.
  const { refreshHistory } = chat
  useEffect(() => {
    if (open) refreshHistory()
  }, [open, refreshHistory])

  const handleNewConversation = () => {
    chat.startNewConversation()
    setSelectedRunId(null)
  }

  const firstUserMessage = chat.messages.find((m) => m.role === 'user')?.content

  return (
    <>
      <Drawer
        open={!!selectedRunId}
        onClose={() => setSelectedRunId(null)}
        placement="right"
        size={400}
        zIndex={1001}
        rootClassName="no-close-animation"
        styles={{
          wrapper: { boxShadow: '-2px 0 8px rgba(0,0,0,0.08)', right: 520 },
          body: { padding: 0 },
          mask: { backgroundColor: 'transparent' },
        }}
        closable={false}
        mask={false}
      >
        <div className="flex flex-col h-full bg-card">
          <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border shrink-0">
            <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <ScrollText className="h-4 w-4" aria-hidden="true" />
              {t('runDetail.runLog')}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => setSelectedRunId(null)}
              aria-label={t('runDetail.closeLog')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 flex flex-col gap-4">
            {selectedRunId && <RunLogContent runId={selectedRunId} />}
          </div>
        </div>
      </Drawer>
      <Drawer
        open={open}
        onClose={onClose}
        placement="right"
        size={520}
        zIndex={1000}
        closable={false}
        styles={{
          body: { padding: 0 },
          wrapper: { boxShadow: '-4px 0 12px rgba(0,0,0,0.08)' },
        }}
        destroyOnClose={false}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0 bg-card">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="text-lg">{agentIcon}</span>
              {t('agentDetail.testChat')}
            </div>
            <div className="flex items-center gap-1">
              {chat.currentRunId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn('size-8', selectedRunId && 'bg-muted')}
                  onClick={() =>
                    setSelectedRunId(selectedRunId ? null : (chat.currentRunId ?? null))
                  }
                  aria-label={t('runDetail.toggleLog')}
                  title={t('runDetail.runLog')}
                >
                  <ScrollText className="h-4 w-4" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleNewConversation}
                className="size-8"
                aria-label={t('agentDetail.newConversation')}
                title={t('agentDetail.newConversation')}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="size-8"
                aria-label={t('common.close')}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Conversation indicator */}
          {chat.currentRunId && chat.messages.length > 0 && (
            <div className="px-5 py-2 flex items-center gap-2 text-xs text-muted-foreground border-b border-border bg-card">
              <MessageSquare className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {firstUserMessage?.slice(0, 40) ?? t('agentDetail.session')}
                {(firstUserMessage?.length ?? 0) > 40 ? '…' : ''}
              </span>
            </div>
          )}

          {chatDisabledReason && (
            <div className="px-4 py-3 border-b border-border bg-warning-subtle">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-xs text-warning">{chatDisabledReason}</p>
              </div>
            </div>
          )}

          {chat.chatError && (
            <div className="px-4 py-3 border-b border-border bg-destructive/10 animate-chat-message-in">
              <div className="flex items-start gap-2">
                <AlertCircle
                  className="h-4 w-4 text-destructive shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <p className="text-xs text-destructive">{chat.chatError}</p>
              </div>
            </div>
          )}

          <ChatMessageList
            messages={chat.messages}
            streamLogs={chat.streamLogs}
            isStreaming={chat.isStreaming}
            emptyState={
              <div className="flex items-center justify-center h-full">
                <div className="text-center space-y-2">
                  <MessageSquare
                    className="h-10 w-10 mx-auto text-muted-foreground/20"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-muted-foreground">{t('agentDetail.sendToStart')}</p>
                </div>
              </div>
            }
            footer={
              chat.currentRunId && !chat.isStreaming ? (
                <InlineArtifactList runId={chat.currentRunId} />
              ) : null
            }
          />

          <ChatComposer
            value={chat.chatInput}
            onChange={chat.setChatInput}
            onSend={() => void chat.sendMessage()}
            onStop={chat.stopStreaming}
            isStreaming={chat.isStreaming}
            canSend={chat.canSend}
            disabled={!canChat}
            pendingAttachments={chat.pendingAttachments}
            onFilesSelected={chat.addFiles}
            onRemoveAttachment={chat.removeAttachment}
            allowedExtensions={chat.attachmentConfig.allowedExtensions}
          />
        </div>
      </Drawer>
    </>
  )
}
