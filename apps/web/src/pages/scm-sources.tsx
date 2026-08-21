import type { ScmSource } from '@a2wave/shared'
import { AlertCircle, Clock, FolderGit2, GitBranch, Loader2, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScmSourceFormModal } from '@/components/scm/scm-source-form-modal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useScmSources, useSyncScmSource } from '@/hooks/use-scm-sources'
import { useUrlRecord } from '@/hooks/use-url-state'
// Not `from 'antd'`: the static instance renders outside our StyleProvider
// layer, so its unlayered reset outranks every layered rule and repaints the
// sidebar links link-blue. See lib/antd-static.
import { message } from '@/lib/antd-static'
import { formatApiError } from '@/lib/api-error'
import { cn } from '@/lib/utils'

/** 将时间格式化为相对时间（如 "3 分钟前"） */
function formatRelativeTime(
  date: Date | string | null | undefined,
  t: (key: string, opts?: { count?: number }) => string,
): string | null {
  if (!date) return null
  const d = typeof date === 'string' ? new Date(date) : date
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 0) return t('time.justNow')

  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return t('time.justNow')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('time.daysAgo', { count: days })
  return d.toLocaleDateString()
}

function formatSyncStatus(status: string) {
  switch (status) {
    case 'idle':
      return { labelKey: 'common.syncIdle', variant: 'outline' as const }
    case 'syncing':
      return { labelKey: 'common.syncSyncing', variant: 'secondary' as const }
    case 'error':
      return { labelKey: 'common.syncError', variant: 'destructive' as const }
    default:
      return { labelKey: 'common.syncIdle', variant: 'outline' as const }
  }
}

export function ScmSourcesPage() {
  const { t } = useTranslation()
  const { data: sourcesResult, isLoading } = useScmSources()
  const sources = sourcesResult?.data
  const syncMutation = useSyncScmSource()
  // Create/edit modal (undefined sourceId = create).
  // Modal state lives in the URL so an editor is linkable and survives a reload.
  const sourceModal = useUrlRecord('source')
  const openSource = (source: ScmSource) => sourceModal.openEdit(source.id)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2
            className="text-2xl font-semibold tracking-tight text-foreground"
            style={{ textWrap: 'balance' }}
          >
            {t('scmSources.title')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1.5">{t('scmSources.subtitle')}</p>
        </div>
        <Button onClick={() => sourceModal.openCreate()}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('scmSources.createSource')}
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-live="polite">
          <span className="sr-only">{t('common.loading')}</span>
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder, fixed count
            <Card key={i}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Skeleton className="size-10 rounded-xl" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-full mb-2" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : sources?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20 px-8">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-gradient-subtle text-interactive-foreground mb-5">
              <FolderGit2 className="h-7 w-7" aria-hidden="true" />
            </div>
            <h3 className="font-semibold text-base mb-1 text-foreground">
              {t('scmSources.emptyTitle')}
            </h3>
            <p
              className="text-sm text-muted-foreground text-center max-w-xs"
              style={{ textWrap: 'pretty' }}
            >
              {t('scmSources.emptyDesc')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sources?.map((source) => {
            const syncStatus = formatSyncStatus(source.syncStatus ?? 'idle')
            return (
              <Card
                key={source.id}
                // biome-ignore lint/a11y/useSemanticElements: the card body holds a nested sync
                // <button> and an <h3> title, neither of which is valid inside a <button>.
                role="button"
                tabIndex={0}
                onClick={() => openSource(source)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openSource(source)
                  }
                }}
                className="group h-full cursor-pointer hover:border-primary/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground shrink-0">
                        {source.type === 'git' ? (
                          <GitBranch className="h-5 w-5" aria-hidden="true" />
                        ) : (
                          <FolderGit2 className="h-5 w-5" aria-hidden="true" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-base truncate font-semibold">
                          {source.name}
                        </CardTitle>
                        {/* Same type marker as the one inside the source
                            detail — icon + mixed-case label on the same tint.
                            It used to render as a bare uppercase "GIT" chip,
                            which read as a different component entirely. */}
                        <span
                          className={cn(
                            'mt-0.5 inline-flex w-fit items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                            source.type === 'git'
                              ? 'border-warning/30 bg-warning-subtle text-warning'
                              : 'border-blue-200/80 bg-blue-50 text-blue-700',
                          )}
                        >
                          {source.type === 'git' ? (
                            <GitBranch className="h-2.5 w-2.5" aria-hidden="true" />
                          ) : (
                            <FolderGit2 className="h-2.5 w-2.5" aria-hidden="true" />
                          )}
                          {source.type === 'git' ? 'Git' : 'P4'}
                        </span>
                      </div>
                    </div>
                    {/* Only the enabled state lives up here. A sync failure is
                        already stated in full on the last-sync line at the
                        bottom of the card, so a second "错误" badge beside
                        "已启用" was the same fact twice. Syncing still shows,
                        since that is transient and has no bottom-line echo. */}
                    <div className="flex items-center gap-2 shrink-0">
                      {source.syncStatus === 'syncing' && (
                        <Badge variant={syncStatus.variant}>{t(syncStatus.labelKey)}</Badge>
                      )}
                      <Badge variant={source.isEnabled ? 'success' : 'outline'}>
                        {source.isEnabled ? t('common.enabled') : t('common.disabled')}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p
                    className="text-sm text-muted-foreground line-clamp-2 leading-relaxed"
                    style={{ textWrap: 'pretty' }}
                  >
                    {source.description || t('common.noDescription')}
                  </p>
                  <div className="mt-3 pt-3 border-t border-border/50 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <code className="text-xs text-muted-foreground/60 font-mono truncate">
                        {source.localPath}
                      </code>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          // The endpoint is fire-and-forget (202), so this
                          // confirms the sync *started*; the result lands via
                          // polling. Without it the button just spun and the
                          // user had no idea whether anything happened.
                          syncMutation.mutate(source.id, {
                            onSuccess: () =>
                              message.success(t('scmSources.syncStarted', { name: source.name })),
                            onError: (error) => message.error(formatApiError(error, t)),
                          })
                        }}
                        // Keep keyboard activation from bubbling to the card's
                        // onKeyDown (which would also open the edit modal).
                        onKeyDown={(e) => e.stopPropagation()}
                        disabled={syncMutation.isPending || source.syncStatus === 'syncing'}
                      >
                        {syncMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        {t('common.sync')}
                      </Button>
                    </div>
                    {/* One line for the last sync. A failure is stated as an
                        outcome ("failed") rather than dumping the raw git/p4
                        stderr into the card — the full message lives on the
                        detail page, which is one click away. */}
                    {(source.lastSyncAt || source.syncStatus === 'error') && (
                      <div
                        className={cn(
                          'flex items-center gap-1.5 text-xs',
                          source.syncStatus === 'error'
                            ? 'text-destructive'
                            : 'text-muted-foreground/60',
                        )}
                      >
                        {source.syncStatus === 'error' ? (
                          <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                        ) : (
                          <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                        )}
                        <span
                          className="truncate"
                          title={
                            source.lastSyncAt
                              ? new Date(source.lastSyncAt).toLocaleString()
                              : undefined
                          }
                        >
                          {source.syncStatus === 'error'
                            ? t('scmSources.lastSyncValue', { time: t('common.syncError') })
                            : t('scmSources.lastSyncValue', {
                                time: formatRelativeTime(source.lastSyncAt, t),
                              })}
                        </span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <ScmSourceFormModal
        open={sourceModal.open}
        onOpenChange={(open) => !open && sourceModal.close()}
        sourceId={sourceModal.id}
      />
    </div>
  )
}
