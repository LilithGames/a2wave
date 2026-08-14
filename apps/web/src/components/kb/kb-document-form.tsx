import { Dropdown } from 'antd'
import {
  AlertCircle,
  BookOpen,
  Check,
  ExternalLink,
  FileText,
  FileUp,
  Info,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { SyncStatusBadge } from '@/components/sync-status-badge'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModePicker } from '@/components/ui/mode-picker'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { type KbBatchState, useKbBatch } from '@/hooks/use-kb-batch'
import {
  useCreateKbDocument,
  useDeleteKbDocument,
  useKbDocument,
  useKbDocumentContent,
  useReuploadKbDocument,
  useSyncKbDocument,
  useUpdateKbDocument,
  useUploadKbDocument,
} from '@/hooks/use-kb-documents'
import { message } from '@/lib/antd-static'
import {
  isLikelySourceUrl,
  KB_BATCH_MAX,
  type KbBatchStatus,
  parseKbSourceUrls,
} from '@/lib/kb-batch'

interface FormData {
  /** Edit mode only — create derives the name from the remote title or the filename. */
  name: string
  description: string
  sourceType: 'feishu' | 'upload' | 'notion'
  /** Create mode: raw textarea text, one URL per line. */
  feishuUrls: string
  feishuAppId: string
  feishuAppSecret: string
  /** Create mode: raw textarea text, one URL per line. */
  notionUrls: string
  /** Edit mode only — the single URL of an existing Notion document. */
  notionUrl: string
  notionToken: string
  autoSync: boolean
  syncIntervalMin: number
}

interface Props {
  /** undefined = create mode; a value = edit mode */
  documentId?: string
  /** Called after a successful create or update. */
  onSaved: () => void
  /** Called after a successful delete. */
  onDeleted?: () => void
}

/** Remote data sources (support manual/auto sync) */
function isRemoteSource(sourceType?: string): boolean {
  return sourceType === 'feishu' || sourceType === 'notion'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Helper text under a batch URL textarea: how to use it, and why there is no name field. */
function BatchUrlHints({ error, overLimit }: { error?: string; overLimit: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="mt-1 space-y-1">
      <p className="text-xs text-muted-foreground">{t('kbDocuments.urlsPerLine')}</p>
      <p className="text-xs text-muted-foreground">{t('kbDocuments.nameFromRemote')}</p>
      {overLimit && (
        <p className="text-xs text-destructive">
          {t('kbDocuments.urlsMaxExceeded', { max: KB_BATCH_MAX })}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

/** Status glyph per batch item; `pending` renders a spacer so labels stay aligned. */
const BATCH_STATUS_ICON: Record<KbBatchStatus, { Icon: typeof Check; className: string } | null> = {
  pending: null,
  running: { Icon: Loader2, className: 'animate-spin text-muted-foreground' },
  // `text-success`, not `text-success-foreground` — the latter is the color to use *on* a
  // success-filled surface (#ffffff in every theme), i.e. invisible as a bare glyph.
  success: { Icon: Check, className: 'text-success' },
  error: { Icon: AlertCircle, className: 'text-destructive' },
}

/**
 * Per-source outcome of the batch currently running (or the one that just finished).
 *
 * `kind` comes from the batch itself rather than the live source-type segment: the
 * recovery hint differs (URLs are restored into the textarea, files must be re-picked),
 * and reading the segment meant switching it after a failed run relabelled the old
 * results with the wrong instruction.
 */
function BatchResults({ items, kind }: KbBatchState) {
  const { t } = useTranslation()
  const done = items.filter((i) => i.status === 'success' || i.status === 'error').length
  const succeeded = items.filter((i) => i.status === 'success').length
  const failed = items.filter((i) => i.status === 'error').length
  const running = items.some((i) => i.status === 'running')

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-foreground">{t('kbDocuments.batchResults')}</h3>
        {running && (
          <p className="text-sm text-muted-foreground">
            {t('kbDocuments.batchProgress', { done, total: items.length })}
          </p>
        )}
      </div>
      <ul className="space-y-2">
        {items.map((item) => {
          const icon = BATCH_STATUS_ICON[item.status]
          return (
            <li key={item.label} className="space-y-1">
              <div className="flex items-start gap-2">
                {icon ? (
                  <icon.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${icon.className}`} />
                ) : (
                  <span className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">
                  {item.label}
                </span>
                {item.name && <span className="shrink-0 text-xs text-foreground">{item.name}</span>}
              </div>
              {item.error && (
                <p className="ml-6 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all text-destructive/90">
                  {item.error}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      {!running && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {t('kbDocuments.batchSucceeded', { count: succeeded })}
            {failed > 0 && ` · ${t('kbDocuments.batchFailed', { count: failed })}`}
          </p>
          {failed > 0 && (
            <p>
              {kind === 'file'
                ? t('kbDocuments.batchFailedFilesHint')
                : t('kbDocuments.batchFailedHint')}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

/** Create/edit form for a Knowledge Base document. Create mode shows the source
 *  type picker + credentials; edit mode swaps in sync-status, file-info and a
 *  read-only content preview. */
export function KbDocumentForm({ documentId, onSaved, onDeleted }: Props) {
  const { t } = useTranslation()
  const isCreateMode = !documentId

  const { data: doc } = useKbDocument(documentId ?? '')
  const { data: content, isLoading: contentLoading } = useKbDocumentContent(
    !isCreateMode && doc?.sourceType === 'upload' && doc?.syncStatus === 'synced'
      ? (documentId ?? '')
      : '',
  )
  const createDoc = useCreateKbDocument()
  const updateDoc = useUpdateKbDocument()
  const deleteDoc = useDeleteKbDocument()
  const syncDoc = useSyncKbDocument()
  const reuploadDoc = useReuploadKbDocument()
  const uploadDoc = useUploadKbDocument()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const { batch, running, run: runBatch, stop: stopBatch, filesFromInput } = useKbBatch()
  const reuploadInputRef = useRef<HTMLInputElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { isDirty, errors },
  } = useForm<FormData>({
    defaultValues: {
      name: '',
      description: '',
      sourceType: 'feishu',
      feishuUrls: '',
      feishuAppId: '',
      feishuAppSecret: '',
      notionUrls: '',
      notionUrl: '',
      notionToken: '',
      autoSync: true,
      syncIntervalMin: 60,
    },
  })

  const sourceType = watch('sourceType')
  const autoSync = watch('autoSync')
  const urlsField = sourceType === 'notion' ? 'notionUrls' : 'feishuUrls'
  const urlCount = parseKbSourceUrls(watch(urlsField)).length
  const overBatchLimit = urlCount > KB_BATCH_MAX

  useEffect(() => {
    if (doc) {
      reset({
        name: doc.name,
        description: doc.description ?? '',
        sourceType: doc.sourceType as 'feishu' | 'upload' | 'notion',
        feishuUrls: '',
        feishuAppId: doc.feishuAppId ?? '',
        feishuAppSecret: '',
        notionUrls: '',
        notionUrl: doc.notionUrl ?? '',
        notionToken: '',
        autoSync: doc.autoSync ?? true,
        syncIntervalMin: doc.syncIntervalMin ?? 60,
      })
    }
  }, [doc, reset])

  /** Reports a finished batch: toast the win, close on a clean sweep, stay put otherwise. */
  const settleBatch = (succeeded: number, remaining: string[], successKey: string) => {
    if (remaining.length === 0 && succeeded > 0) {
      message.success(t(successKey, { count: succeeded }))
      onSaved()
    }
  }

  const createFromUrls = async (data: FormData, urls: string[]) => {
    const { succeeded, remaining, abandoned } = await runBatch('url', urls, async (url) => {
      // Cheap shape check first, so a typo costs no request. Everything
      // source-specific stays server side and comes back as prose.
      if (!isLikelySourceUrl(url)) throw new Error(t('kbDocuments.urlsInvalid'))
      // No `name`: the api derives it from the fetched document title, which beats
      // anything the user would type while pasting a batch of links.
      const res = await createDoc.mutateAsync({
        description: data.description || null,
        sourceType: data.sourceType,
        feishuUrl: data.sourceType === 'feishu' ? url : null,
        feishuAppId: data.sourceType === 'feishu' ? data.feishuAppId : null,
        feishuAppSecret: data.sourceType === 'feishu' ? data.feishuAppSecret : null,
        notionUrl: data.sourceType === 'notion' ? url : null,
        notionToken: data.sourceType === 'notion' ? data.notionToken : null,
        autoSync: data.autoSync,
        syncIntervalMin: data.syncIntervalMin,
      })
      return { name: res.data.name, id: res.data.id }
    })
    // The dialog was closed mid-run: the documents are created either way, but touching
    // form state or calling onSaved() now would act on a component that no longer exists.
    if (abandoned) return

    // Only what still needs doing stays in the box, so a retry submits exactly that.
    setValue(urlsField, remaining.join('\n'), { shouldDirty: true })
    settleBatch(succeeded, remaining, 'kbDocuments.batchCreated')
  }

  const onSubmit = async (data: FormData) => {
    // Upload-create has no submit button — the dropzone uploads immediately via
    // handleUploadCreate. Guard against implicit Enter-submission (a single text
    // input still triggers form submit), which would otherwise run a whole batch
    // of fileless documents through the wrong path.
    if (isCreateMode && data.sourceType === 'upload') return
    try {
      if (isCreateMode) {
        const urls = parseKbSourceUrls(data[urlsField])
        if (urls.length === 0 || urls.length > KB_BATCH_MAX) return
        await createFromUrls(data, urls)
      } else if (documentId) {
        const notionUrl = data.notionUrl.trim()
        const notionToken = data.notionToken.trim()
        await updateDoc.mutateAsync({
          id: documentId,
          name: data.name,
          description: data.description || null,
          ...(doc?.sourceType === 'notion'
            ? {
                ...(notionUrl !== doc.notionUrl ? { notionUrl } : {}),
                ...(notionToken ? { notionToken } : {}),
              }
            : {}),
          autoSync: data.autoSync,
          syncIntervalMin: data.syncIntervalMin,
        })
        onSaved()
      }
    } catch (err) {
      console.error('Save failed:', err)
    }
  }

  const handleDelete = async () => {
    if (!documentId) return
    try {
      await deleteDoc.mutateAsync(documentId)
      setDeleteOpen(false)
      onDeleted?.()
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }

  const handleSync = async () => {
    if (!documentId) return
    try {
      await syncDoc.mutateAsync(documentId)
    } catch (err) {
      console.error('Sync failed:', err)
    }
  }

  const handleReupload = async (file: File) => {
    if (!documentId) return
    try {
      await reuploadDoc.mutateAsync({ id: documentId, file })
    } catch (err) {
      console.error('Reupload failed:', err)
    }
  }

  const handleUploadCreate = async (files: File[]) => {
    const { succeeded, remaining, abandoned } = await runBatch(
      'file',
      files.map((file) => file.name),
      async (_label, index) => {
        const res = await uploadDoc.mutateAsync(files[index])
        return { name: res.data.name, id: res.data.id }
      },
    )
    if (abandoned) return
    settleBatch(succeeded, remaining, 'kbDocuments.batchUploaded')
  }

  const isSyncing = doc?.syncStatus === 'syncing' || syncDoc.isPending

  return (
    <div className="flex max-h-[70vh] flex-col">
      {/* Edit-mode header actions: sync + reupload + delete (pinned) */}
      {!isCreateMode && (
        <div className="flex shrink-0 items-center justify-end gap-2 pb-3">
          {isRemoteSource(doc?.sourceType) && (
            <Button variant="outline" size="sm" onClick={handleSync} disabled={isSyncing}>
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t('kbDocuments.sync')}
            </Button>
          )}
          <Dropdown
            menu={{
              items: [
                ...(doc?.sourceType === 'upload'
                  ? [
                      {
                        key: 'reupload',
                        label: t('kbDocuments.reupload'),
                        icon: <FileUp className="h-4 w-4" />,
                        disabled: reuploadDoc.isPending,
                        onClick: () => reuploadInputRef.current?.click(),
                      },
                    ]
                  : []),
                {
                  key: 'delete',
                  label: t('common.delete'),
                  icon: <Trash2 className="h-4 w-4" />,
                  danger: true,
                  disabled: deleteDoc.isPending,
                  onClick: () => setDeleteOpen(true),
                },
              ],
            }}
            trigger={['click']}
            placement="bottomRight"
          >
            <Button type="button" variant="ghost" size="icon" className="size-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </Dropdown>
        </div>
      )}

      {/* Sync status alerts (edit mode, remote sources) */}
      {!isCreateMode && isRemoteSource(doc?.sourceType) && doc?.syncStatus === 'syncing' && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-2.5 text-sm text-interactive-foreground">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>{t('kbDocuments.syncing')}</span>
          </div>
        </div>
      )}

      {!isCreateMode &&
        isRemoteSource(doc?.sourceType) &&
        doc?.syncStatus === 'error' &&
        doc.lastSyncError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-sm font-medium text-destructive">{t('kbDocuments.syncError')}</p>
                <p className="text-xs font-mono text-destructive/80 break-all whitespace-pre-wrap leading-relaxed rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
                  {doc.lastSyncError}
                </p>
              </div>
            </div>
          </div>
        )}

      <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
        {/* Scroll region — only the fields scroll; the save bar stays pinned. */}
        <div className="min-h-0 flex-1 overflow-y-auto -mr-5 pr-5">
          <div className="min-h-[24rem] space-y-6">
            {/* Basic Info */}
            <section className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-foreground">
                  {t('kbDocuments.basicInfo')}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {isCreateMode
                    ? t('kbDocuments.basicInfoDescCreate')
                    : t('kbDocuments.basicInfoDesc')}
                </p>
              </div>
              {/* Create mode asks for no name: remote sources take the fetched title and
                  uploads take the filename. Renaming happens here, after the fact. */}
              {!isCreateMode && (
                <div className="space-y-1.5">
                  <Label className="text-sm" required>
                    {t('kbDocuments.name')}
                  </Label>
                  <Input
                    // `required` is truthy for "   ", which the server then falls back
                    // out of — the save would report success and change nothing.
                    {...register('name', { validate: (v) => v.trim().length > 0 })}
                    placeholder={t('kbDocuments.namePlaceholder')}
                    aria-invalid={!!errors.name}
                  />
                  {errors.name && (
                    <p className="text-xs text-destructive">
                      {t('common.fieldRequired', { field: t('kbDocuments.name') })}
                    </p>
                  )}
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-sm">{t('kbDocuments.description')}</Label>
                <Textarea
                  {...register('description')}
                  placeholder={t('kbDocuments.descriptionPlaceholder')}
                  rows={2}
                />
              </div>
            </section>

            {/* Source Config (create mode only) */}
            {isCreateMode && (
              <section className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-sm">{t('kbDocuments.sourceType')}</Label>
                  <ModePicker
                    block
                    // Switching source mid-run would swap the credential fields and hide
                    // the Stop control out from under a batch that keeps creating.
                    disabled={running}
                    value={sourceType}
                    onChange={(v) =>
                      setValue('sourceType', v as 'feishu' | 'notion' | 'upload', {
                        shouldDirty: true,
                      })
                    }
                    options={[
                      {
                        value: 'feishu',
                        label: (
                          <span className="inline-flex items-center gap-1.5">
                            <FileText className="h-4 w-4" />
                            {t('kbDocuments.feishu')}
                          </span>
                        ),
                      },
                      {
                        value: 'notion',
                        label: (
                          <span className="inline-flex items-center gap-1.5">
                            <BookOpen className="h-4 w-4" />
                            {t('kbDocuments.notion')}
                          </span>
                        ),
                      },
                      {
                        value: 'upload',
                        label: (
                          <span className="inline-flex items-center gap-1.5">
                            <FileUp className="h-4 w-4" />
                            {t('kbDocuments.upload')}
                          </span>
                        ),
                      },
                    ]}
                  />
                </div>

                {sourceType === 'feishu' && (
                  <div className="space-y-3">
                    <div className="info-panel px-3 py-2.5 flex items-start gap-2">
                      <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="text-sm text-muted-foreground leading-relaxed">
                        {t('kbDocuments.feishuPermissionTip')}
                        <a
                          href="https://open.feishu.cn/app"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-interactive-foreground hover:underline ml-1"
                        >
                          {t('kbDocuments.feishuPermissionLink')}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                    <div>
                      <Label className="text-sm font-medium text-foreground" required>
                        {t('kbDocuments.feishuUrls')}
                      </Label>
                      <Textarea
                        {...register('feishuUrls', {
                          // `required` passes on a textarea holding only whitespace.
                          validate: (v) =>
                            sourceType !== 'feishu' || parseKbSourceUrls(v).length > 0,
                        })}
                        placeholder={t('kbDocuments.feishuUrlsPlaceholder')}
                        rows={4}
                        // The batch rewrites this box with whatever still needs retrying,
                        // so edits made during the run would be silently discarded.
                        readOnly={running}
                        className="mt-1.5 resize-none font-mono text-sm"
                        aria-invalid={!!errors.feishuUrls}
                      />
                      <BatchUrlHints
                        error={errors.feishuUrls ? t('kbDocuments.urlsRequired') : undefined}
                        overLimit={overBatchLimit}
                      />
                    </div>
                    <div>
                      <Label className="text-sm font-medium text-foreground" required>
                        {t('kbDocuments.feishuAppId')}
                      </Label>
                      <Input
                        {...register('feishuAppId', { required: sourceType === 'feishu' })}
                        placeholder={t('kbDocuments.feishuAppIdPlaceholder')}
                        className="mt-1.5"
                      />
                      {errors.feishuAppId && (
                        <p className="text-sm text-destructive mt-1">
                          {t('common.fieldRequired', { field: t('kbDocuments.feishuAppId') })}
                        </p>
                      )}
                    </div>
                    <div>
                      <Label className="text-sm font-medium text-foreground" required>
                        {t('kbDocuments.feishuAppSecret')}
                      </Label>
                      <Input
                        {...register('feishuAppSecret', {
                          required: sourceType === 'feishu',
                        })}
                        type="password"
                        placeholder={t('kbDocuments.feishuAppSecretPlaceholder')}
                        className="mt-1.5"
                      />
                      {errors.feishuAppSecret && (
                        <p className="text-sm text-destructive mt-1">
                          {t('common.fieldRequired', { field: t('kbDocuments.feishuAppSecret') })}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {sourceType === 'notion' && (
                  <div className="space-y-3">
                    <div className="rounded-lg bg-muted/60 px-3 py-2.5 flex items-start gap-2">
                      <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="text-sm text-muted-foreground leading-relaxed">
                        {t('kbDocuments.notionPermissionTip')}
                        <a
                          href="https://www.notion.so/my-integrations"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-interactive-foreground hover:underline ml-1"
                        >
                          {t('kbDocuments.notionPermissionLink')}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                    <div>
                      <Label className="text-sm font-medium text-foreground" required>
                        {t('kbDocuments.notionUrls')}
                      </Label>
                      <Textarea
                        {...register('notionUrls', {
                          validate: (v) =>
                            sourceType !== 'notion' || parseKbSourceUrls(v).length > 0,
                        })}
                        placeholder={t('kbDocuments.notionUrlsPlaceholder')}
                        rows={4}
                        // The batch rewrites this box with whatever still needs retrying,
                        // so edits made during the run would be silently discarded.
                        readOnly={running}
                        className="mt-1.5 resize-none font-mono text-sm"
                        aria-invalid={!!errors.notionUrls}
                      />
                      <BatchUrlHints
                        error={errors.notionUrls ? t('kbDocuments.urlsRequired') : undefined}
                        overLimit={overBatchLimit}
                      />
                    </div>
                    <div>
                      <Label className="text-sm font-medium text-foreground">
                        {t('kbDocuments.notionToken')}
                      </Label>
                      <Input
                        {...register('notionToken', {
                          required: sourceType === 'notion',
                        })}
                        type="password"
                        placeholder={t('kbDocuments.notionTokenPlaceholder')}
                        className="mt-1.5"
                      />
                      {errors.notionToken && (
                        <p className="text-sm text-destructive mt-1">
                          {t('common.fieldRequired', { field: t('kbDocuments.notionToken') })}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {sourceType === 'upload' && (
                  <div className="space-y-3">
                    <input
                      ref={uploadInputRef}
                      type="file"
                      accept=".md,.txt"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = filesFromInput(e.target.files)
                        if (files) void handleUploadCreate(files)
                        e.target.value = ''
                      }}
                    />
                    <button
                      type="button"
                      className="w-full rounded-xl border-2 border-dashed border-border/60 p-8 text-center cursor-pointer hover:border-primary/30 transition-colors"
                      onClick={() => uploadInputRef.current?.click()}
                      disabled={running}
                    >
                      {running ? (
                        <Loader2 className="mx-auto mb-3 h-8 w-8 text-muted-foreground animate-spin" />
                      ) : (
                        <Upload className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                      )}
                      <p className="text-sm font-medium text-foreground mb-1">
                        {t('kbDocuments.uploadFiles')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('kbDocuments.uploadFileTip', { max: KB_BATCH_MAX })}
                      </p>
                    </button>
                  </div>
                )}
              </section>
            )}

            {/* Batch results — also covers the upload branch, which has no save bar */}
            {batch && <BatchResults items={batch.items} kind={batch.kind} />}

            {/* Notion Config (edit mode) */}
            {!isCreateMode && doc?.sourceType === 'notion' && (
              <section className="space-y-4">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-foreground">
                    {t('kbDocuments.notionConfig')}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t('kbDocuments.notionConfigDesc')}
                  </p>
                </div>
                <div>
                  <Label htmlFor="notionUrl" className="text-sm font-medium text-foreground">
                    {t('kbDocuments.notionUrl')}
                  </Label>
                  <Input
                    id="notionUrl"
                    {...register('notionUrl', { required: true })}
                    placeholder="https://www.notion.so/..."
                    className="mt-1.5"
                  />
                  {errors.notionUrl && (
                    <p className="text-sm text-destructive mt-1">
                      {t('common.fieldRequired', { field: t('kbDocuments.notionUrl') })}
                    </p>
                  )}
                </div>
                <div>
                  <Label htmlFor="notionToken" className="text-sm font-medium text-foreground">
                    {t('kbDocuments.notionToken')}
                  </Label>
                  <Input
                    id="notionToken"
                    {...register('notionToken')}
                    type="password"
                    autoComplete="new-password"
                    className="mt-1.5"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('kbDocuments.notionTokenKeepHint')}
                  </p>
                </div>
              </section>
            )}

            {/* File Info (edit mode, upload type) */}
            {!isCreateMode && doc?.sourceType === 'upload' && (
              <section className="space-y-4">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-foreground">
                    {t('kbDocuments.fileInfo')}
                  </h3>
                </div>
                <div className="space-y-2 text-sm">
                  {doc.originalFilename && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-28">
                        {t('kbDocuments.fileName')}:
                      </span>
                      <span className="font-mono text-sm">{doc.originalFilename}</span>
                    </div>
                  )}
                  {doc.fileSize != null && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-28">
                        {t('kbDocuments.fileSize')}:
                      </span>
                      <span>{formatFileSize(doc.fileSize)}</span>
                    </div>
                  )}
                  {doc.lastSyncAt && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-28">
                        {t('kbDocuments.uploadedAt')}:
                      </span>
                      <span>{new Date(doc.lastSyncAt).toLocaleString()}</span>
                    </div>
                  )}
                  <input
                    ref={reuploadInputRef}
                    type="file"
                    accept=".md,.txt"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleReupload(file)
                      e.target.value = ''
                    }}
                  />
                </div>
              </section>
            )}

            {/* Sync Status (edit mode, remote sources) */}
            {!isCreateMode && doc && isRemoteSource(doc.sourceType) && (
              <section className="space-y-4">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-foreground">
                    {t('kbDocuments.syncStatus')}
                  </h3>
                  <p className="text-sm text-muted-foreground">{t('kbDocuments.syncStatusDesc')}</p>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-28">
                      {t('kbDocuments.syncStatusLabel')}:
                    </span>
                    <SyncStatusBadge syncStatus={doc.syncStatus} />
                  </div>

                  {doc.lastSyncAt && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-28">
                        {t('kbDocuments.lastSyncAt')}:
                      </span>
                      <span>{new Date(doc.lastSyncAt).toLocaleString()}</span>
                    </div>
                  )}

                  {(doc.feishuUrl || doc.notionUrl) && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-28">URL:</span>
                      <a
                        href={doc.feishuUrl || doc.notionUrl || ''}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-interactive-foreground hover:underline truncate flex items-center gap-1"
                      >
                        {doc.feishuUrl || doc.notionUrl}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    </div>
                  )}

                  {doc.fileSize != null && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-28">
                        {t('kbDocuments.fileSize')}:
                      </span>
                      <span>{formatFileSize(doc.fileSize)}</span>
                    </div>
                  )}

                  {doc.lastSyncError && (
                    <div className="flex items-start gap-2 mt-1">
                      <span className="text-muted-foreground w-28 shrink-0 pt-0.5 flex items-center gap-1">
                        <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                        {t('kbDocuments.lastError')}:
                      </span>
                      <div className="flex-1 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
                        <p className="text-xs font-mono text-destructive/90 break-all whitespace-pre-wrap">
                          {doc.lastSyncError}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Auto Sync Config (remote sources only) */}
            {((isCreateMode && sourceType !== 'upload') ||
              (!isCreateMode && isRemoteSource(doc?.sourceType))) && (
              <section className="space-y-4">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-foreground">
                    {t('kbDocuments.autoSyncConfig')}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t('kbDocuments.autoSyncConfigDesc')}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    aria-label={t('kbDocuments.enableAutoSync')}
                    checked={autoSync}
                    onCheckedChange={(val) => setValue('autoSync', val, { shouldDirty: true })}
                  />
                  <Label>{t('kbDocuments.enableAutoSync')}</Label>
                </div>
                {autoSync && (
                  <div className="space-y-2 max-w-xs">
                    <Label htmlFor="syncIntervalMin">{t('kbDocuments.syncIntervalMin')}</Label>
                    <Input
                      id="syncIntervalMin"
                      type="number"
                      min={1}
                      {...register('syncIntervalMin', { valueAsNumber: true, min: 1 })}
                    />
                  </div>
                )}
              </section>
            )}

            {/* Content Preview (edit mode, upload type, synced) */}
            {!isCreateMode && doc?.sourceType === 'upload' && doc?.syncStatus === 'synced' && (
              <section className="space-y-4">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-foreground">
                    {t('kbDocuments.contentPreview')}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t('kbDocuments.contentPreviewDesc')}
                  </p>
                </div>
                {contentLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-5/6" />
                  </div>
                ) : content ? (
                  <pre className="max-h-96 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm whitespace-pre-wrap break-all leading-relaxed">
                    {content}
                  </pre>
                ) : (
                  <div className="rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    {t('kbDocuments.noContent')}
                  </div>
                )}
              </section>
            )}
          </div>
        </div>

        {/* Pinned bar. Upload-create has no submit button (the dropzone uploads on pick),
            but it still needs the Stop control while a file batch is running. */}
        {(!(isCreateMode && sourceType === 'upload') || running) && (
          <div className="mt-3 flex shrink-0 items-center justify-end gap-2 border-t border-border/60 pt-3">
            {running && (
              <div className="mr-auto flex items-center gap-3">
                <Button type="button" variant="outline" onClick={stopBatch}>
                  {t('kbDocuments.batchStop')}
                </Button>
                {/* The in-flight request has no abort channel — say so, or a stopped
                    batch looks like it produced a ghost document. */}
                <span className="text-xs text-muted-foreground">
                  {t('kbDocuments.batchStopHint')}
                </span>
              </div>
            )}
            {!(isCreateMode && sourceType === 'upload') && (
              <Button
                type="submit"
                disabled={
                  (!isCreateMode && !isDirty) ||
                  running ||
                  overBatchLimit ||
                  createDoc.isPending ||
                  updateDoc.isPending
                }
              >
                {/* Driven by `running`, not the mutation: isPending flaps false between
                  sequential calls and would strobe the button. */}
                {running || updateDoc.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t('kbDocuments.saving')}
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" aria-hidden="true" />
                    {isCreateMode ? t('kbDocuments.create') : t('common.save')}
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </form>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>{t('kbDocuments.deleteConfirm')}</AlertDialogTitle>
          <AlertDialogDescription>{t('kbDocuments.deleteConfirmDesc')}</AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteDoc.isPending}>
              {deleteDoc.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('common.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
