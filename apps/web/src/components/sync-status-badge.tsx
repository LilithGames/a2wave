import { useTranslation } from 'react-i18next'

const syncStatusColors = {
  synced: 'bg-success',
  syncing: 'bg-warning animate-pulse',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground/50',
} as const

const syncStatusLabelKeys = {
  synced: 'kbDocuments.synced',
  syncing: 'kbDocuments.syncing',
  error: 'kbDocuments.error',
  idle: 'kbDocuments.idle',
} as const

export function SyncStatusBadge({ syncStatus }: { syncStatus: string }) {
  const { t } = useTranslation()
  const status = (
    syncStatus in syncStatusColors ? syncStatus : 'idle'
  ) as keyof typeof syncStatusColors
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`size-2 rounded-full ${syncStatusColors[status]}`} />
      {t(syncStatusLabelKeys[status])}
    </span>
  )
}
