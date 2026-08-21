/**
 * /agents/:id/chat_app — the shareable conversation page.
 *
 * A link to this page can be handed to anyone in the company, but it is NOT
 * anonymous: the route sits behind the normal auth guard, so a signed-out visitor
 * is bounced to login and every turn is attributed to a real a2wave user
 * (Iron Rule 5). What the link buys is a focused, product-quality chat surface
 * without the surrounding admin console.
 *
 * Layout: agent profile on the left, conversation on the right; the profile
 * collapses into a header strip on narrow screens.
 */

import { AlertCircle, ArrowLeft, MessageSquare, Plus, Sparkles, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { ChatComposer } from '@/components/chat/chat-composer'
import { ChatMessageList } from '@/components/chat/chat-message-list'
import { InlineArtifactList } from '@/components/chat/inline-artifact-list'
import { MarkdownContent } from '@/components/markdown-content'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgentChat } from '@/hooks/use-agent-chat'
import { useChatAppProfile } from '@/hooks/use-chat-app'
import { cn } from '@/lib/utils'

export function ChatAppPage() {
  const { t } = useTranslation()
  const { id: agentId } = useParams<{ id: string }>()

  const { data: profile, isLoading, isError } = useChatAppProfile(agentId)

  // The agent must be active to take a turn; publishStatus is surfaced separately
  // so a stopped agent explains itself rather than silently failing to reply.
  const isStopped = profile?.publishStatus === 'stopped'
  const canChat = !!profile && profile.status === 'active' && !isStopped
  const disabledReason = !profile
    ? null
    : isStopped
      ? t('chatApp.agentStopped')
      : profile.status !== 'active'
        ? t('chatApp.agentInactive')
        : null

  const chat = useAgentChat({
    agentId,
    canChat,
    disabledReason,
    channel: 'chat_app',
    // Start clean: a shared link should open on a fresh conversation rather than
    // dropping the visitor into whatever they last said.
    loadHistory: false,
  })

  if (isLoading) return <ChatAppSkeleton />
  if (isError || !profile) return <ChatAppUnavailable />

  const hasMessages = chat.messages.length > 0

  return (
    <div className="flex h-screen flex-col bg-background lg:flex-row">
      {/* ── Profile sidebar ───────────────────────────────────────────── */}
      <aside className="flex shrink-0 flex-col gap-5 border-b border-border bg-card px-5 py-4 lg:h-full lg:w-80 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-6 lg:py-7">
        <div className="flex items-start gap-3">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted text-2xl select-none"
            aria-hidden="true"
          >
            {profile.icon}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-foreground" title={profile.name}>
              {profile.name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusBadge status={profile.status} isStopped={isStopped} />
            </div>
          </div>
          {/* Below lg the sidebar collapses to this strip and the footer actions are
              hidden, so the reset affordance has to live here or a phone visitor has
              no way out of a derailed conversation short of reloading the page. */}
          {hasMessages && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={chat.startNewConversation}
              className="shrink-0 lg:hidden"
              aria-label={t('chatApp.newConversation')}
              title={t('chatApp.newConversation')}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>

        {profile.description && (
          <p className="text-sm leading-relaxed text-muted-foreground lg:line-clamp-none line-clamp-3">
            {profile.description}
          </p>
        )}

        <div className="hidden space-y-3 lg:block">
          {profile.showCreator && profile.creator && (
            <div className="flex items-center gap-2 text-sm">
              <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="text-muted-foreground">{t('chatApp.creator')}</span>
              <span className="truncate font-medium text-foreground">{profile.creator.name}</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm">
            <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">{t('chatApp.poweredBy')}</span>
          </div>
        </div>

        <div className="mt-auto hidden gap-2 lg:flex lg:flex-col">
          {hasMessages && (
            <Button
              type="button"
              variant="outline"
              onClick={chat.startNewConversation}
              className="w-full justify-center"
            >
              <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {t('chatApp.newConversation')}
            </Button>
          )}
          <Link
            to={`/agents/${profile.id}`}
            className="inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden="true" />
            {t('chatApp.backToConsole')}
          </Link>
        </div>
      </aside>

      {/* ── Conversation ──────────────────────────────────────────────── */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {disabledReason && (
          <div className="flex items-start gap-2 border-b border-border bg-warning-subtle px-4 py-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <p className="text-xs text-warning">{disabledReason}</p>
          </div>
        )}

        {chat.chatError && (
          <div className="flex items-start gap-2 border-b border-border bg-destructive/10 px-4 py-3 animate-chat-message-in">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <p className="text-xs text-destructive">{chat.chatError}</p>
          </div>
        )}

        <ChatMessageList
          messages={chat.messages}
          streamLogs={chat.streamLogs}
          isStreaming={chat.isStreaming}
          showThinking={profile.showThinking}
          agentIcon={profile.icon}
          className="mx-auto w-full max-w-3xl"
          emptyState={
            <ChatAppWelcome
              icon={profile.icon}
              name={profile.name}
              welcomeMessage={profile.welcomeMessage}
              suggestedQuestions={profile.suggestedQuestions}
              disabled={!canChat}
              onPick={(question) => void chat.sendMessage(question)}
            />
          }
          footer={
            chat.currentRunId && !chat.isStreaming ? (
              <InlineArtifactList runId={chat.currentRunId} />
            ) : null
          }
        />

        {/* The composer is a self-contained card the width of the conversation,
            so it carries its own rounded border instead of a full-width rule. */}
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
          <ChatComposer
            className="rounded-2xl border border-border p-3 shadow-sm"
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
            allowAttachments={profile.allowAttachments}
            allowedExtensions={chat.attachmentConfig.allowedExtensions}
            placeholder={t('chatApp.inputPlaceholder', { name: profile.name })}
            rows={2}
            autoFocus
          />
        </div>
      </main>
    </div>
  )
}

function StatusBadge({ status, isStopped }: { status: string; isStopped: boolean }) {
  const { t } = useTranslation()
  const online = status === 'active' && !isStopped
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        online ? 'bg-success-subtle text-success' : 'bg-muted text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          online ? 'bg-success animate-pulse' : 'bg-muted-foreground/50',
        )}
        aria-hidden="true"
      />
      {online ? t('chatApp.statusOnline') : t('chatApp.statusOffline')}
    </span>
  )
}

interface ChatAppWelcomeProps {
  icon: string
  name: string
  welcomeMessage: string | null
  suggestedQuestions: string[]
  disabled: boolean
  onPick: (question: string) => void
}

function ChatAppWelcome({
  icon,
  name,
  welcomeMessage,
  suggestedQuestions,
  disabled,
  onPick,
}: ChatAppWelcomeProps) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-xl space-y-6 text-center">
        <div className="space-y-3 animate-chat-message-in">
          <div
            className="mx-auto flex size-16 items-center justify-center rounded-3xl bg-muted text-4xl select-none"
            aria-hidden="true"
          >
            {icon}
          </div>
          <h2 className="text-xl font-semibold text-foreground">
            {t('chatApp.welcomeTitle', { name })}
          </h2>
        </div>

        {welcomeMessage ? (
          <div className="rounded-2xl border border-border bg-card px-5 py-4 text-left animate-chat-message-in">
            <MarkdownContent content={welcomeMessage} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('chatApp.welcomeHint')}</p>
        )}

        {suggestedQuestions.length > 0 && (
          <div className="space-y-2">
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {t('chatApp.suggestedQuestions')}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {suggestedQuestions.map((question, index) => (
                <button
                  // Index-keyed on purpose: two identical starter questions are
                  // valid config, and keying by text made them collide so only
                  // one chip rendered.
                  key={`${index}-${question}`}
                  type="button"
                  disabled={disabled}
                  onClick={() => onPick(question)}
                  style={{ animationDelay: `${index * 60}ms` }}
                  className="animate-chat-chip-in rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-foreground transition-all hover:border-primary/40 hover:bg-surface-hover hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {question}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ChatAppSkeleton() {
  return (
    <div className="flex h-screen flex-col bg-background lg:flex-row">
      <aside className="shrink-0 space-y-5 border-b border-border bg-card px-6 py-7 lg:h-full lg:w-80 lg:border-b-0 lg:border-r">
        <div className="flex items-start gap-3">
          <Skeleton className="size-12 rounded-2xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </aside>
      <main className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-xl space-y-4 px-6">
          <Skeleton className="mx-auto size-16 rounded-3xl" />
          <Skeleton className="mx-auto h-6 w-48" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
      </main>
    </div>
  )
}

function ChatAppUnavailable() {
  const { t } = useTranslation()
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
        <MessageSquare className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold text-foreground">{t('chatApp.unavailableTitle')}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{t('chatApp.unavailableDesc')}</p>
      </div>
      <Button asChild variant="outline">
        <Link to="/agents">{t('chatApp.backToAgents')}</Link>
      </Button>
    </div>
  )
}
