import type { SkillVisibility } from '@a2wave/shared'
import { Dropdown, Select } from 'antd'
import {
  AlertTriangle,
  ChevronRight,
  File,
  Folder,
  FolderUp,
  Github,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react'
import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { RemoteSkillUpdateDialog } from '@/components/remote-skill-update-dialog'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModePicker } from '@/components/ui/mode-picker'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useCurrentUser } from '@/hooks/use-auth'
import type { SkillFileEntry } from '@/hooks/use-skills'
import {
  useCreateSkill,
  useDeleteSkill,
  useReuploadSkill,
  useSkill,
  useSkillFiles,
  useUpdateSkill,
  useUploadSkillFiles,
} from '@/hooks/use-skills'
import { toUploadEntries, type UploadEntry } from '@/lib/upload-entries'

type FormData = {
  name: string
  description: string
  content: string
  visibility: SkillVisibility
}

type PendingUploadFile = UploadEntry

const TEXT_EXT = ['md', 'txt', 'json', 'js', 'ts', 'py', 'sh', 'yaml', 'yml', 'css', 'html']

interface Props {
  /** undefined = create mode; a value = edit mode */
  skillId?: string
  /** Called after a successful create or update. */
  onSaved: () => void
  /** Called after a successful delete. */
  onDeleted?: () => void
}

/** Recursive file-tree renderer with click-to-preview (edit mode only). */
function SkillFileTree({
  entries,
  skillId,
  basePath,
  onPreview,
}: {
  entries: SkillFileEntry[]
  skillId: string
  basePath: string
  onPreview: (path: string, content: string) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const handleFileClick = async (path: string) => {
    const ext = path.split('.').pop() ?? ''
    if (TEXT_EXT.includes(ext)) {
      try {
        const res = await fetch(`/api/skills/${skillId}/files/${encodeURIComponent(path)}`, {
          credentials: 'include',
        })
        const text = await res.text()
        onPreview(path, text)
      } catch {
        onPreview(path, t('skillDetail.filePreviewLoadFailed'))
      }
    } else {
      window.open(`/api/skills/${skillId}/files/${encodeURIComponent(path)}`, '_blank')
    }
  }

  return (
    <ul className="space-y-0.5">
      {entries.map((entry) => {
        const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name
        if (entry.type === 'directory') {
          const isOpen = expanded[fullPath] ?? false
          return (
            <li key={fullPath}>
              <button
                type="button"
                onClick={() => setExpanded((s) => ({ ...s, [fullPath]: !s[fullPath] }))}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-hover"
              >
                <ChevronRight
                  className={`h-4 w-4 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                  aria-hidden
                />
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                {entry.name}
              </button>
              {isOpen && entry.entries && entry.entries.length > 0 && (
                <div className="ml-4 border-l border-border/50 pl-2">
                  <SkillFileTree
                    entries={entry.entries}
                    skillId={skillId}
                    basePath={fullPath}
                    onPreview={onPreview}
                  />
                </div>
              )}
            </li>
          )
        }
        return (
          <li key={fullPath}>
            <button
              type="button"
              onClick={() => handleFileClick(fullPath)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-hover"
            >
              <span className="w-6 shrink-0" aria-hidden />
              <File className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{entry.name}</span>
              {entry.size != null && (
                <span className="ml-auto text-xs text-muted-foreground/70">
                  {(entry.size / 1024).toFixed(1)} KB
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** Create/edit form for a Skill. In create mode only the Content tab is shown
 *  (files can't be attached until the skill exists); edit mode adds a Files tab. */
export function SkillForm({ skillId, onSaved, onDeleted }: Props) {
  const { t } = useTranslation()
  const isCreateMode = !skillId
  const { data: skill } = useSkill(skillId ?? '')
  const { data: currentUser } = useCurrentUser()
  const isAdmin = currentUser?.role === 'admin'
  const canEdit = isCreateMode || isAdmin || (!!skill?.userId && skill.userId === currentUser?.id)
  const hasFixedBuiltinVisibility = skill?.userId === null && skill.visibility === 'all-users'
  const createSkill = useCreateSkill()
  const updateSkill = useUpdateSkill()
  const deleteSkill = useDeleteSkill()
  const uploadSkillFiles = useUploadSkillFiles()
  const reuploadSkill = useReuploadSkill()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [remoteUpdateOpen, setRemoteUpdateOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'content' | 'files'>('content')
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<PendingUploadFile[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const reuploadFileInputRef = useRef<HTMLInputElement>(null)
  const reuploadFolderInputRef = useRef<HTMLInputElement>(null)

  const { data: files, isLoading: filesLoading } = useSkillFiles(skillId ?? undefined, !!skillId)
  const isSaving = isCreateMode ? createSkill.isPending : updateSkill.isPending
  const fileCount = files?.entries?.length ?? 0

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { isDirty, errors },
  } = useForm<FormData>({
    defaultValues: { name: '', description: '', content: '', visibility: 'private' },
  })

  useEffect(() => {
    if (skill) {
      reset({
        name: skill.name,
        description: skill.description ?? '',
        content: skill.content ?? '',
        visibility: skill.visibility ?? 'private',
      })
    }
  }, [skill, reset])

  const queueFiles = (fileList: FileList | null) => {
    const entries = toUploadEntries(fileList)
    if (entries.length === 0) return
    setPendingFiles((current) => {
      const map = new Map(current.map((item) => [item.path, item]))
      for (const item of entries) map.set(item.path, item)
      return Array.from(map.values())
    })
  }

  const uploadForExistingSkill = async (fileList: FileList | null) => {
    if (!skillId) return
    const entries = toUploadEntries(fileList)
    if (entries.length === 0) return
    try {
      await uploadSkillFiles.mutateAsync({
        skillId,
        files: entries.map((entry) => entry.file),
        paths: entries.map((entry) => entry.path),
      })
    } catch (error) {
      console.error('Failed to upload files:', error)
    }
  }

  const onFileInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files
    if (isCreateMode) queueFiles(fileList)
    else await uploadForExistingSkill(fileList)
    event.target.value = ''
  }

  const onReuploadFileInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!skillId || !file) return
    try {
      await reuploadSkill.mutateAsync({ skillId, file })
    } catch (error) {
      console.error('Failed to reupload skill:', error)
    }
    event.target.value = ''
  }

  const onReuploadFolderInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const entries = toUploadEntries(event.target.files)
    if (!skillId || entries.length === 0) {
      event.target.value = ''
      return
    }
    try {
      await reuploadSkill.mutateAsync({
        skillId,
        files: entries.map((entry) => entry.file),
        paths: entries.map((entry) => entry.path),
      })
    } catch (error) {
      console.error('Failed to reupload skill folder:', error)
    }
    event.target.value = ''
  }

  const onSubmit = async (data: FormData) => {
    if (!canEdit) return
    if (isCreateMode) {
      try {
        const result = await createSkill.mutateAsync({
          name: data.name,
          description: data.description || undefined,
          content: data.content || undefined,
          visibility: data.visibility,
        })
        if (pendingFiles.length > 0) {
          await uploadSkillFiles.mutateAsync({
            skillId: result.data.id,
            files: pendingFiles.map((entry) => entry.file),
            paths: pendingFiles.map((entry) => entry.path),
          })
        }
        onSaved()
      } catch (error) {
        console.error('Failed to create skill:', error)
      }
      return
    }
    if (!skillId) return
    try {
      await updateSkill.mutateAsync({
        id: skillId,
        name: data.name,
        description: data.description || null,
        content: data.content || null,
        visibility: data.visibility,
      })
      onSaved()
    } catch (error) {
      console.error('Failed to update skill:', error)
    }
  }

  const handleDelete = async () => {
    if (!skillId) return
    try {
      await deleteSkill.mutateAsync(skillId)
      setDeleteDialogOpen(false)
      onDeleted?.()
    } catch (error) {
      console.error('Failed to delete skill:', error)
    }
  }

  // Content pane — name, description, instructions (SKILL.md body).
  const contentPane = (
    <div className="space-y-4">
      {!canEdit && (
        <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm text-muted-foreground">
          {t('skillDetail.sharedReadOnly')}
        </div>
      )}
      {skill?.remoteSource ? (
        <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Github className="h-4 w-4 shrink-0" aria-hidden />
                <span>{t('skills.remote.update.sourceTitle')}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('skills.remote.update.sourceDescription')}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setRemoteUpdateOpen(true)}
              disabled={!canEdit}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              {t('skills.remote.update.checkButton')}
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{skill.remoteSource.repository}</span>
            <Badge variant="outline">{skill.remoteSource.requestedRef}</Badge>
            {skill.sourceDirty ? (
              <Badge variant="warning">{t('skills.remote.update.localModified')}</Badge>
            ) : null}
          </div>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {t('skills.remote.update.installedRevision', {
              revision: skill.remoteSource.revision,
            })}
          </p>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="skill-name" className="text-sm" required>
          {t('skillDetail.name')}
        </Label>
        <Input
          id="skill-name"
          {...register('name', { required: t('skillDetail.nameRequired') })}
          placeholder={t('skillDetail.namePlaceholder')}
          aria-invalid={!!errors.name}
          disabled={!canEdit}
        />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="skill-description" className="text-sm">
          {t('skillDetail.description')}
        </Label>
        <Textarea
          id="skill-description"
          {...register('description')}
          placeholder={t('skillDetail.descriptionPlaceholder')}
          rows={2}
          disabled={!canEdit}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="skill-visibility" className="text-sm">
          {t('skillDetail.visibility')}
        </Label>
        <Select
          id="skill-visibility"
          className="w-full"
          value={watch('visibility')}
          disabled={!canEdit || hasFixedBuiltinVisibility}
          onChange={(value) =>
            setValue('visibility', value as SkillVisibility, { shouldDirty: true })
          }
          options={[
            { value: 'private', label: t('skillDetail.visibilityPrivate') },
            {
              value: 'all-users',
              label: t('skillDetail.visibilityAllUsers'),
              disabled: !isAdmin,
            },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {hasFixedBuiltinVisibility
            ? t('skillDetail.visibilityHintBuiltin')
            : isAdmin
              ? t('skillDetail.visibilityHintAdmin')
              : t('skillDetail.visibilityHintUser')}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="skill-content" className="text-sm">
          {t('skillDetail.instructions')}
        </Label>
        <p className="text-xs text-muted-foreground">{t('skillDetail.instructionsDesc')}</p>
        <Textarea
          id="skill-content"
          {...register('content')}
          placeholder={t('skillDetail.instructionsPlaceholder')}
          rows={14}
          className="resize-none font-mono text-sm leading-relaxed"
          disabled={!canEdit}
        />
      </div>
    </div>
  )

  // Files pane — tree + click-to-preview. Only rendered in edit mode.
  const filesPane = (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('skillDetail.filesDesc')}</p>
        {canEdit && (
          <Dropdown
            menu={{
              items: [
                {
                  key: 'file',
                  label: t('skillDetail.addFile'),
                  icon: <File className="h-4 w-4" />,
                  onClick: () => fileInputRef.current?.click(),
                },
                {
                  key: 'folder',
                  label: t('skillDetail.addFolder'),
                  icon: <Folder className="h-4 w-4" />,
                  onClick: () => folderInputRef.current?.click(),
                },
              ],
            }}
            trigger={['click']}
            placement="bottomRight"
            disabled={uploadSkillFiles.isPending}
          >
            <Button type="button" variant="outline" size="sm" disabled={uploadSkillFiles.isPending}>
              {uploadSkillFiles.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="h-4 w-4" aria-hidden="true" />
              )}
              {t('skillDetail.addFiles')}
            </Button>
          </Dropdown>
        )}
      </div>
      {filesLoading ? (
        <Skeleton className="h-24 w-full rounded-lg" />
      ) : files?.entries && files.entries.length > 0 ? (
        <div className="space-y-2">
          <SkillFileTree
            entries={files.entries}
            skillId={skillId ?? ''}
            basePath=""
            onPreview={(path, content) => {
              setPreviewPath(path)
              setPreviewContent(content)
            }}
          />
          {previewPath && previewContent !== null && (
            <div className="mt-4 rounded-lg border border-border/50 bg-muted/30 p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">{previewPath}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPreviewPath(null)
                    setPreviewContent(null)
                  }}
                >
                  {t('common.close')}
                </Button>
              </div>
              <pre className="max-h-64 overflow-auto rounded bg-background p-3 text-xs font-mono leading-relaxed">
                {previewContent}
              </pre>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground/70">{t('skillDetail.noFilesYet')}</p>
      )}
    </div>
  )

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex max-h-[70vh] flex-col">
      {/* Hidden upload inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFileInputChange}
        aria-hidden
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={onFileInputChange}
        aria-hidden
      />
      <input
        ref={reuploadFileInputRef}
        type="file"
        accept=".md,.zip"
        className="hidden"
        onChange={onReuploadFileInputChange}
        aria-hidden
      />
      <input
        ref={reuploadFolderInputRef}
        type="file"
        multiple
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={onReuploadFolderInputChange}
        aria-hidden
      />

      {/* Pinned tab bar (edit mode) — stays fixed above the scroll region so it
          never scrolls out of view. Create mode has no Files tab. */}
      {!isCreateMode && (
        <div className="flex shrink-0 items-center justify-between gap-2 pb-3">
          <ModePicker
            value={activeTab}
            onChange={(v) => setActiveTab(v as 'content' | 'files')}
            options={[
              { value: 'content', label: t('skillDetail.tabContent') },
              {
                value: 'files',
                label:
                  fileCount > 0
                    ? `${t('skillDetail.tabFiles')} ${fileCount}`
                    : t('skillDetail.tabFiles'),
              },
            ]}
          />
          {canEdit && (
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'reupload',
                    label: t('skillDetail.reupload'),
                    icon: <RefreshCw className="h-4 w-4" />,
                    disabled: reuploadSkill.isPending,
                    onClick: () => reuploadFileInputRef.current?.click(),
                  },
                  {
                    key: 'reupload-folder',
                    label: t('skillDetail.reuploadFolder'),
                    icon: <FolderUp className="h-4 w-4" />,
                    disabled: reuploadSkill.isPending,
                    onClick: () => reuploadFolderInputRef.current?.click(),
                  },
                  {
                    key: 'delete',
                    label: t('skillDetail.delete'),
                    icon: <Trash2 className="h-4 w-4" />,
                    danger: true,
                    onClick: () => setDeleteDialogOpen(true),
                  },
                ],
              }}
              trigger={['click']}
              placement="bottomRight"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t('skillDetail.moreActions')}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </Dropdown>
          )}
        </div>
      )}

      {/* Scroll region — only the active pane scrolls; the tab bar and save bar
          stay pinned. -mr-5 pr-5 keeps the scrollbar at the modal's edge; the
          min-h keeps the modal a constant height across tab switches. */}
      <div className="min-h-0 flex-1 overflow-y-auto -mr-5 pr-5">
        <div className="min-h-[24rem]">
          {isCreateMode || activeTab === 'content' ? contentPane : filesPane}
        </div>
      </div>

      {/* Pinned save bar */}
      {canEdit && (
        <div className="mt-3 flex shrink-0 items-center justify-end border-t border-border/60 pt-3">
          <Button type="submit" disabled={isCreateMode ? isSaving : !isDirty || isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {isCreateMode ? t('skillDetail.creating') : t('skillDetail.saving')}
              </>
            ) : (
              <>
                <Save className="h-4 w-4" aria-hidden="true" />
                {isCreateMode ? t('skillDetail.createSkill') : t('skillDetail.saveChanges')}
              </>
            )}
          </Button>
        </div>
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            {t('skillDetail.deleteTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('skillDetail.deleteDesc')}</AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteSkill.isPending}>
              {deleteSkill.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {t('skillDetail.deleting')}
                </>
              ) : (
                t('skillDetail.deleteSkill')
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {skill?.remoteSource && canEdit ? (
        <RemoteSkillUpdateDialog
          open={remoteUpdateOpen}
          onOpenChange={setRemoteUpdateOpen}
          skill={skill}
          onUpdated={(updatedSkill) => {
            reset({
              name: updatedSkill.name,
              description: updatedSkill.description ?? '',
              content: updatedSkill.content ?? '',
              visibility: updatedSkill.visibility ?? 'private',
            })
          }}
        />
      ) : null}
    </form>
  )
}
