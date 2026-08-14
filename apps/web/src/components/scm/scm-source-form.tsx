import type { ScmSourceConfig } from '@a2wave/shared'
import { Dropdown, Segmented, Tooltip } from 'antd'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FolderGit2,
  FolderOpen,
  GitBranch,
  HardDrive,
  HelpCircle,
  Loader2,
  MoreHorizontal,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useFieldArray, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  useCheckScmSource,
  useCreateScmSource,
  useDeleteScmSource,
  useDeleteScmWorkspace,
  useProbeScmSource,
  useReindexScmCodegraph,
  useScmSource,
  useScmSourceStatus,
  useScmSourceWorkspaces,
  useSyncScmSource,
  useUpdateScmSource,
} from '@/hooks/use-scm-sources'
import { message } from '@/lib/antd-static'
import { formatApiError } from '@/lib/api-error'
import { confirm } from '@/lib/confirm'
import { idSuffix } from '@/lib/id-suffix'
import { cn, formatRelativeTime } from '@/lib/utils'

/** Strip the Node.js execFile "Command failed: p4/git ..." wrapper, keep the real error. */
function formatSyncError(msg: string): string {
  const cleaned = msg
    .replace(/^P4 sync failed:\s*Command failed: p4[^\n]*\n?/, 'P4 sync failed: ')
    .replace(/^Git sync failed:\s*Command failed: git[^\n]*\n?/, 'Git sync failed: ')
    .trim()
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned
}

/**
 * The one error surface for this form. A single tinted panel: title, then the
 * raw tool output as plain monospace text on the *same* fill.
 *
 * Deliberately not a box-inside-a-box — the previous version wrapped the
 * message in its own bordered destructive-tinted card nested in the banner's
 * destructive-tinted card, which doubled every edge and stacked two red washes
 * on top of each other. One border, one fill, and the hierarchy comes from
 * type weight and color alone.
 */
function ErrorNotice({
  title,
  message,
  className,
}: {
  title: string
  message?: string | null
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-lg border border-destructive/25 bg-destructive-subtle px-4 py-3',
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-px h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-destructive">{title}</p>
          {message && (
            <p className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-destructive/75">
              {formatSyncError(message)}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Mirrors the server's `node:path` isAbsolute check, which is what the API
 * validates against. Windows shapes are accepted because the API may run on
 * Windows, where `C:\work` and `\\server\share` are absolute — rejecting them
 * client-side would block a path the server would have taken.
 */
export function isAbsolutePath(value: string): boolean {
  const path = value.trim()
  if (!path) return false
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

type ScmType = 'p4' | 'git'

/** Status enums come straight from the API; map them to copy instead of rendering the raw value. */
const syncStatusLabelKeys: Record<string, string> = {
  idle: 'common.syncIdle',
  syncing: 'common.syncSyncing',
  synced: 'common.syncSynced',
  error: 'common.syncError',
}

const codegraphStatusLabelKeys: Record<string, string> = {
  idle: 'scmSources.codegraph.statusIdle',
  indexing: 'scmSources.codegraph.statusIndexing',
  error: 'scmSources.codegraph.statusError',
}

type FormData = {
  name: string
  description: string
  storageMode: 'managed' | 'custom'
  localPath: string
  workspacesPath: string
  isEnabled: boolean
  // P4 config
  p4port: string
  p4user: string
  p4passwd: string
  p4client: string
  depotPath: string
  // Git config
  repoUrl: string
  branch: string
  username: string
  pat: string
  multiRepo: boolean
  repos: Array<{ repoUrl: string; branch: string; directory: string }>
  // Common
  autoSync: boolean
  syncIntervalMin: number
  initialSyncTimeoutMin: number
  codegraphEnabled: boolean
}

function deriveDirectoryFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const lastSegment = pathname.split('/').filter(Boolean).pop() || ''
    return lastSegment.replace(/\.git$/, '') || 'repo'
  } catch {
    const parts = url.split('/').filter(Boolean)
    const last = parts[parts.length - 1] || 'repo'
    return last.replace(/\.git$/, '')
  }
}

interface Props {
  /** undefined = create mode; a value = edit mode */
  sourceId?: string
  /** Called after a successful create or update. */
  onSaved: () => void
  /** Called after a successful delete. */
  onDeleted?: () => void
}

/**
 * Create/edit form for an SCM Source. Laid out with two tabs:
 * - "Config" — everything the create flow needs (basic info, connection,
 *   auto-sync, and CodeGraph enablement).
 * - "Sync & Workspaces" — edit-only: check/sync actions, sync status,
 *   CodeGraph reindex + status, and (git) the worktrees list.
 */
export function ScmSourceForm({ sourceId, onSaved, onDeleted }: Props) {
  const { t } = useTranslation()
  const isCreateMode = !sourceId
  const { data: source } = useScmSource(sourceId ?? '')
  // Only poll status in edit mode so the interval stops when the modal closes.
  const { data: status } = useScmSourceStatus(sourceId ?? '')
  const createSource = useCreateScmSource()
  const updateSource = useUpdateScmSource()
  const deleteSource = useDeleteScmSource()
  const syncSource = useSyncScmSource()
  const checkSource = useCheckScmSource()
  const probeSource = useProbeScmSource()
  const reindexCodegraph = useReindexScmCodegraph()
  const deleteWorkspace = useDeleteScmWorkspace()
  const [showPassword, setShowPassword] = useState(false)
  const [scmType, setScmType] = useState<ScmType>('git')
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({})
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  // Client-side "you haven't filled this in yet" message for the probe button,
  // kept separate from the server's probe result so the two never overwrite.
  const [probeValidationError, setProbeValidationError] = useState<string | null>(null)
  // Controlled so a submit that fails validation can jump back to the Config
  // tab — its required fields (name/localPath) unmount on the Sync tab, so their
  // inline errors would otherwise be hidden and Save would look like a no-op.
  const [activeTab, setActiveTab] = useState<'config' | 'sync'>('config')

  const workspacesEnabled = !isCreateMode && !!sourceId && source?.type === 'git'
  const {
    data: workspaces,
    isLoading: workspacesLoading,
    refetch: refetchWorkspaces,
  } = useScmSourceWorkspaces(sourceId ?? '', workspacesEnabled)

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    getValues,
    control,
    formState: { errors, isDirty },
  } = useForm<FormData>({
    defaultValues: {
      name: '',
      description: '',
      storageMode: 'managed',
      localPath: '',
      workspacesPath: '',
      isEnabled: true,
      p4port: '',
      p4user: '',
      p4passwd: '',
      p4client: '',
      depotPath: '',
      repoUrl: '',
      branch: 'main',
      username: '',
      pat: '',
      multiRepo: false,
      repos: [],
      autoSync: false,
      syncIntervalMin: 30,
      initialSyncTimeoutMin: 60,
      codegraphEnabled: false,
    },
  })

  const { fields, append, remove } = useFieldArray({ control, name: 'repos' })

  const autoSync = watch('autoSync')
  const isEnabled = watch('isEnabled')
  const multiRepo = watch('multiRepo')
  const initialSyncCompletedAt =
    status?.initialSyncCompletedAt ?? source?.initialSyncCompletedAt ?? null

  // Restore type + fields from source in edit mode.
  useEffect(() => {
    if (source) {
      setScmType(source.type as ScmType)
      const config = source.config as Record<string, unknown>
      const repos = config?.repos as
        | Array<{ repoUrl: string; branch: string; directory: string }>
        | undefined
      const isMultiRepo = Array.isArray(repos) && repos.length > 0

      reset({
        name: source.name,
        description: source.description ?? '',
        storageMode: 'custom',
        localPath: source.localPath,
        workspacesPath: source.workspacesPath ?? '',
        isEnabled: source.isEnabled ?? true,
        // P4
        p4port: (config?.p4port as string) ?? '',
        p4user: (config?.p4user as string) ?? '',
        p4passwd: (config?.p4passwd as string) ?? '',
        p4client: (config?.p4client as string) ?? '',
        depotPath: (config?.depotPath as string) ?? '',
        // Git
        repoUrl: (config?.repoUrl as string) ?? '',
        branch: (config?.branch as string) ?? 'main',
        username: (config?.username as string) ?? '',
        pat: (config?.pat as string) ?? '',
        multiRepo: isMultiRepo,
        repos: isMultiRepo ? repos : [],
        // Common
        autoSync: (config?.autoSync as boolean) ?? false,
        syncIntervalMin: (config?.syncIntervalMin as number) ?? 30,
        initialSyncTimeoutMin: (config?.initialSyncTimeoutMin as number) ?? 60,
        codegraphEnabled: (config?.codegraphEnabled as boolean) ?? false,
      })
    }
  }, [source, reset])

  /**
   * Build the API `config` object from the current form values. Shared by save
   * and probe so the connection you test is exactly the one you would store.
   */
  const buildConfig = (data: FormData): ScmSourceConfig =>
    scmType === 'p4'
      ? {
          type: 'p4' as const,
          p4port: data.p4port,
          p4user: data.p4user,
          p4passwd: data.p4passwd,
          p4client: data.p4client,
          depotPath: data.depotPath || undefined,
          autoSync: data.autoSync,
          syncIntervalMin: data.syncIntervalMin,
          initialSyncTimeoutMin: data.initialSyncTimeoutMin,
          codegraphEnabled: data.codegraphEnabled,
        }
      : {
          type: 'git' as const,
          repoUrl: data.multiRepo ? '' : data.repoUrl,
          branch: data.multiRepo ? 'main' : data.branch || 'main',
          username: data.username || undefined,
          pat: data.pat || undefined,
          autoSync: data.autoSync,
          syncIntervalMin: data.syncIntervalMin,
          initialSyncTimeoutMin: data.initialSyncTimeoutMin,
          codegraphEnabled: data.codegraphEnabled,
          ...(data.multiRepo && data.repos.length > 0 ? { repos: data.repos } : {}),
        }

  const onSubmit = (data: FormData) => {
    const basePayload = {
      name: data.name,
      description: data.description || null,
      // Trimmed to match what the validator checked: it tests `value.trim()`, so
      // submitting the raw value let "  /srv/repo" pass the form and then fail
      // the API's node:path.isAbsolute with a 400.
      ...(!isCreateMode || data.storageMode === 'custom'
        ? { localPath: data.localPath.trim() }
        : {}),
      workspacesPath: scmType === 'git' ? data.workspacesPath.trim() || null : null,
      isEnabled: data.isEnabled,
    }

    const config = buildConfig(data)

    if (isCreateMode) {
      createSource.mutate(
        { ...basePayload, type: scmType, config },
        {
          onSuccess: () => onSaved(),
        },
      )
    } else if (sourceId) {
      updateSource.mutate(
        { id: sourceId, input: { ...basePayload, config } },
        {
          onSuccess: () => onSaved(),
        },
      )
    }
  }

  const handleDelete = async () => {
    if (!sourceId) return
    try {
      await deleteSource.mutateAsync(sourceId)
      setDeleteDialogOpen(false)
      onDeleted?.()
    } catch (error) {
      console.error('Failed to delete SCM source:', error)
    }
  }

  const handleCheck = () => {
    if (!sourceId) return
    checkSource.mutate(sourceId)
  }

  /**
   * Probe the connection using the values currently in the form — nothing is
   * saved. Works in create mode too, so credentials can be verified before the
   * source exists. `sourceId` is passed only so the server can resolve masked
   * credentials the form round-tripped unchanged.
   */
  const handleProbe = () => {
    const data = getValues()
    setProbeValidationError(null)

    if (scmType === 'git') {
      // A blank single repoUrl in edit mode is a masked round-trip the server can
      // still resolve from the stored row; in create mode there is nothing to
      // resolve it from. Multi-repo has no such fallback — a blank entry fails
      // schema validation, so always catch it here.
      const missingUrl = data.multiRepo
        ? data.repos.length === 0 || data.repos.some((r) => !r.repoUrl.trim())
        : !data.repoUrl.trim() && isCreateMode
      if (missingUrl) {
        setProbeValidationError(t('scmSources.detail.probeNeedsRepoUrl'))
        return
      }
      // `directory` is `.min(1)` in the schema; without this the server replies
      // with a bare "Invalid probe input" that names no field.
      if (data.multiRepo && data.repos.some((r) => !r.directory.trim())) {
        setProbeValidationError(t('scmSources.detail.probeNeedsRepoDirectory'))
        return
      }
    } else if (!data.p4port.trim() || !data.p4user.trim() || !data.p4client.trim()) {
      setProbeValidationError(t('scmSources.detail.probeNeedsP4Fields'))
      return
    } else if (!data.localPath.trim()) {
      setProbeValidationError(t('scmSources.detail.localPathRequired'))
      return
    }

    probeSource.mutate({
      type: scmType,
      config: buildConfig(data),
      sourceId,
      ...(scmType === 'p4' ? { localPath: data.localPath.trim() } : {}),
    })
  }

  const handleSync = () => {
    if (!sourceId) return
    syncSource.mutate(sourceId)
  }

  const handleToggleMultiRepo = () => {
    const currentMultiRepo = getValues('multiRepo')
    if (!currentMultiRepo) {
      const repoUrl = getValues('repoUrl')
      const branch = getValues('branch') || 'main'
      const directory = deriveDirectoryFromUrl(repoUrl)
      setValue('repos', [{ repoUrl, branch, directory }], { shouldDirty: true })
      setValue('multiRepo', true, { shouldDirty: true })
    } else {
      const repos = getValues('repos')
      if (repos.length <= 1) {
        if (repos.length === 1) {
          setValue('repoUrl', repos[0].repoUrl, { shouldDirty: true })
          setValue('branch', repos[0].branch, { shouldDirty: true })
        }
        setValue('multiRepo', false, { shouldDirty: true })
      } else {
        confirm({
          title: t('scmSources.detail.switchSingleTitle'),
          content: t('scmSources.detail.switchSingleContent', {
            count: repos.length,
            repoUrl: repos[0].repoUrl,
          }),
          okText: t('scmSources.detail.switchSingleOk'),
          onOk: () => {
            setValue('repoUrl', repos[0].repoUrl, { shouldDirty: true })
            setValue('branch', repos[0].branch, { shouldDirty: true })
            setValue('multiRepo', false, { shouldDirty: true })
          },
        })
      }
    }
  }

  const isSaving = createSource.isPending || updateSource.isPending
  // Only one of the two can be active for a given mode, so the first message wins.
  const saveError = createSource.error ?? updateSource.error ?? null
  const codegraphEnabled = watch('codegraphEnabled')
  const storageMode = watch('storageMode')

  // A result describes the exact connection parameters that were probed, so any
  // change to them invalidates it — clear rather than leave a stale ✓ next to
  // fields it never tested (test config A, edit the URL to B, and the green
  // check would otherwise still be sitting there when you save B untested).
  // Watching the connection fields themselves, not just the shape: repo layout
  // is only one of the ways a probed config stops matching the form.
  // Split by who owns the state, because only one half can be pristine.
  // `scmType` is useState and `multiRepo` is toggled with `shouldDirty`, so
  // neither is moved by the load-time `reset()` — they compare unconditionally.
  const shapeSnapshot = `${scmType}:${multiRepo}`
  const fieldSnapshot = JSON.stringify([
    watch('repoUrl'),
    watch('branch'),
    watch('username'),
    watch('pat'),
    watch('repos'),
    watch('p4port'),
    watch('p4user'),
    watch('p4passwd'),
    watch('p4client'),
    // A probed parameter, not merely a saved one: a P4 probe verifies the client
    // Root/AltRoots actually cover this path. Leaving it out let a green check
    // for path A survive an edit to path B, which is the state that then gets
    // saved untested.
    watch('localPath'),
  ])
  const probeReset = probeSource.reset
  const probedShapeRef = useRef<string | null>(null)
  const probedFieldsRef = useRef<string | null>(null)
  useEffect(() => {
    const firstRun = probedShapeRef.current === null
    const shapeChanged = !firstRun && probedShapeRef.current !== shapeSnapshot
    // `isDirty` gates ONLY the RHF fields: the `reset()` that populates the form
    // once the source loads moves all of them at once while the form is still
    // pristine, and that is not a user edit. It cannot be told apart by effect
    // ordering because a populate spans renders. `scmType` never participates in
    // `isDirty` at all (it is useState), so gating it this way would silently
    // drop the type-switch invalidation.
    const fieldsChanged = !firstRun && isDirty && probedFieldsRef.current !== fieldSnapshot

    probedShapeRef.current = shapeSnapshot
    probedFieldsRef.current = fieldSnapshot
    if (!shapeChanged && !fieldsChanged) return

    probeReset()
    setProbeValidationError(null)
  }, [shapeSnapshot, fieldSnapshot, probeReset, isDirty])

  const probeResult = probeSource.data?.data
  // A rejected mutation (network error, 400/404) has no result body — surface the
  // server's message rather than leaving the button looking like it did nothing.
  const probeRequestError = probeSource.error
    ? (probeSource.error.message ?? t('scmSources.detail.probeRequestFailed'))
    : null

  /**
   * Probe trigger + result, rendered at the foot of whichever connection section
   * is active. Placed next to the credential fields it tests — the Sync tab's
   * "Check Connection" button is the separate, edit-only check of the *saved*
   * config.
   */
  const probePanel = (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleProbe}
          disabled={probeSource.isPending}
          className="gap-1.5"
        >
          {probeSource.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <PlugZap className="h-4 w-4" />
          )}
          {probeSource.isPending
            ? t('scmSources.detail.probeConnectionTesting')
            : multiRepo && scmType === 'git'
              ? t('scmSources.detail.probeAllRepos')
              : t('scmSources.detail.probeConnection')}
        </Button>
        <p className="text-xs text-muted-foreground">
          {t('scmSources.detail.probeConnectionHint')}
        </p>
      </div>

      {!isCreateMode && (
        <p className="text-xs text-muted-foreground">
          {t('scmSources.detail.probeUnsavedCredentialHint')}
        </p>
      )}

      {probeValidationError && <p className="text-xs text-destructive">{probeValidationError}</p>}
      {probeRequestError && <p className="text-xs text-destructive">{probeRequestError}</p>}

      {probeResult && (
        <div className="space-y-1.5">
          <div
            className={cn(
              'flex items-start gap-2 text-sm',
              probeResult.ok ? 'text-success' : 'text-destructive',
            )}
          >
            {probeResult.ok ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
            )}
            <span className="break-all">
              {probeResult.ok
                ? t('scmSources.detail.probeSuccess')
                : t('scmSources.detail.probeFailed')}
              {': '}
              {probeResult.message}
              {probeResult.serverVersion && ` (${probeResult.serverVersion})`}
            </span>
          </div>

          {probeResult.clientRoot && (
            <p className="font-mono text-xs text-muted-foreground">
              {t('scmSources.detail.p4ClientRoot')}: {probeResult.clientRoot}
            </p>
          )}
          {probeResult.clientRootWarning && (
            <p className="text-xs text-warning">{probeResult.clientRootWarning}</p>
          )}

          {/* Per-repo breakdown: the aggregate message only counts passes, so this
              is what tells you which repo failed and why. Gated on multi-repo mode
              rather than on the count — a one-repo multi-repo source aggregates to
              "0/1 repos connected, failed: <dir>", which is exactly the message
              with no reason that the breakdown exists to replace. In single-repo
              mode the line above already carries the reason. */}
          {multiRepo && probeResult.repos && probeResult.repos.length > 0 && (
            <ul className="space-y-1 border-t border-border pt-1.5">
              {probeResult.repos.map((repo, index) => (
                <li
                  // Index-suffixed: repoUrl arrives redacted, so two repos that
                  // differ only in userinfo collapse to the same string.
                  key={`${repo.directory}:${repo.repoUrl}:${index}`}
                  className="flex items-start gap-2 text-xs"
                >
                  {repo.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-success" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-destructive" />
                  )}
                  <span className="font-mono font-medium shrink-0">
                    {repo.directory || repo.repoUrl}
                  </span>
                  <span
                    className={cn(
                      'break-all',
                      repo.ok ? 'text-muted-foreground' : 'text-destructive',
                    )}
                  >
                    {repo.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )

  // ── Config tab content ─────────────────────────────────────
  const configPane = (
    <div className="space-y-6">
      {/* Basic Info */}
      <section className="space-y-4">
        <h3 className="text-base font-semibold text-foreground">
          {t('scmSources.detail.basicInfo')}
        </h3>
        {/* Type Selector (create mode only) */}
        {isCreateMode && (
          <div className="flex flex-col items-start gap-1.5">
            <Label required>{t('scmSources.detail.sourceTypeLabel')}</Label>
            <Segmented
              value={scmType}
              onChange={(v) => {
                const nextType = v as ScmType
                setScmType(nextType)
                setValue('storageMode', nextType === 'git' ? 'managed' : 'custom', {
                  shouldDirty: true,
                })
              }}
              options={[
                {
                  value: 'git',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <GitBranch className="h-4 w-4" />
                      Git
                    </span>
                  ),
                },
                {
                  value: 'p4',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <FolderGit2 className="h-4 w-4" />
                      Perforce (P4)
                    </span>
                  ),
                },
              ]}
            />
          </div>
        )}
        {/* Edit mode: show type as badge */}
        {!isCreateMode && source && (
          <div className="space-y-2">
            <Label>{t('scmSources.detail.sourceTypeLabel')}</Label>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium ${
                  source.type === 'git'
                    ? 'border-orange-200/80 bg-orange-50 text-orange-700'
                    : 'border-blue-200/80 bg-blue-50 text-blue-700'
                }`}
              >
                {source.type === 'git' ? (
                  <GitBranch className="h-3 w-3" />
                ) : (
                  <FolderGit2 className="h-3 w-3" />
                )}
                {source.type === 'git' ? 'Git' : 'Perforce (P4)'}
              </span>
            </div>
          </div>
        )}
        <div className={cn('grid gap-4', !isCreateMode && 'sm:grid-cols-2')}>
          <div className="space-y-2">
            <Label htmlFor="name" required>
              {t('scmSources.detail.nameLabel')}
            </Label>
            <Input
              id="name"
              placeholder={
                scmType === 'git'
                  ? t('scmSources.detail.namePlaceholderGit')
                  : t('scmSources.detail.namePlaceholderP4')
              }
              {...register('name', { required: t('scmSources.detail.nameRequired') })}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          {!isCreateMode && (
            <div className="space-y-1.5">
              <Label htmlFor="localPath" className="text-sm">
                {t('scmSources.detail.localPathLabel')}
              </Label>
              <Input
                id="localPath"
                placeholder={source?.type === 'p4' ? '/data/p4/client' : '/data/repos/repository'}
                readOnly={source?.type === 'git'}
                className={cn('font-mono text-sm', source?.type === 'git' && 'bg-muted')}
                {...register('localPath', {
                  required:
                    source?.type === 'p4' ? t('scmSources.detail.localPathRequired') : false,
                  validate: (value) =>
                    source?.type !== 'p4' ||
                    isAbsolutePath(value) ||
                    t('scmSources.detail.localPathAbsolute'),
                })}
              />
              <p className="text-xs text-muted-foreground">
                {source?.type === 'p4'
                  ? t('scmSources.detail.p4LocalPathHint')
                  : t('scmSources.detail.savedPathHint')}
              </p>
              {errors.localPath && (
                <p className="text-xs text-destructive">{errors.localPath.message}</p>
              )}
            </div>
          )}
        </div>
        {isCreateMode && scmType === 'git' && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium leading-none text-foreground">
              {t('scmSources.detail.storageModeLabel')}
            </legend>
            <Segmented
              value={storageMode}
              onChange={(value) =>
                setValue('storageMode', value as 'managed' | 'custom', {
                  shouldDirty: true,
                })
              }
              options={[
                {
                  value: 'managed',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <HardDrive className="h-4 w-4" />
                      {t('scmSources.detail.storageManaged')}
                    </span>
                  ),
                },
                {
                  value: 'custom',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <FolderOpen className="h-4 w-4" />
                      {t('scmSources.detail.storageCustom')}
                    </span>
                  ),
                },
              ]}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              {storageMode === 'managed'
                ? `${t('scmSources.detail.storageManagedHint')} ${t('scmSources.detail.storageRecommended')}`
                : t('scmSources.detail.storageCustomHint')}
            </p>
            {storageMode === 'custom' && (
              <div data-storage-choice="custom" className="max-w-xl">
                <Input
                  id="localPath"
                  aria-label={t('scmSources.detail.localPathLabel')}
                  placeholder="/data/workspace/sources/my-repo"
                  className="font-mono text-sm"
                  {...register('localPath', {
                    required: t('scmSources.detail.localPathRequired'),
                    validate: (value) =>
                      isAbsolutePath(value) || t('scmSources.detail.localPathAbsolute'),
                  })}
                />
                {errors.localPath && (
                  <p className="mt-1 text-xs text-destructive">{errors.localPath.message}</p>
                )}
              </div>
            )}
          </fieldset>
        )}
        {isCreateMode && scmType === 'p4' && (
          <div className="space-y-2">
            <Label htmlFor="localPath" required>
              {t('scmSources.detail.localPathLabel')}
            </Label>
            <Input
              id="localPath"
              placeholder="/data/workspace/p4-client"
              className="font-mono text-sm"
              {...register('localPath', {
                required: t('scmSources.detail.localPathRequired'),
                validate: (value) =>
                  isAbsolutePath(value) || t('scmSources.detail.localPathAbsolute'),
              })}
            />
            <p className="text-xs text-muted-foreground">
              {t('scmSources.detail.p4LocalPathHint')}
            </p>
            {errors.localPath && (
              <p className="text-xs text-destructive">{errors.localPath.message}</p>
            )}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="description">{t('scmSources.detail.descriptionLabel')}</Label>
          <Textarea
            id="description"
            placeholder={t('scmSources.detail.descriptionPlaceholder')}
            rows={2}
            {...register('description')}
          />
        </div>
        <div className="flex items-center gap-3">
          <Switch
            aria-label={t('common.enabled')}
            checked={isEnabled}
            onCheckedChange={(val) => setValue('isEnabled', val, { shouldDirty: true })}
          />
          <Label>{t('common.enabled')}</Label>
        </div>
      </section>

      {/* Git connection */}
      {scmType === 'git' && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                {t('scmSources.detail.gitConnection')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('scmSources.detail.gitConnectionDesc')}
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={handleToggleMultiRepo}>
              {multiRepo
                ? t('scmSources.detail.switchToSingle')
                : t('scmSources.detail.multiRepoMode')}
            </Button>
          </div>
          {multiRepo ? (
            <div className="space-y-4">
              {fields.map((field, index) => (
                <div key={field.id} className="rounded-lg border border-border p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-muted-foreground">#{index + 1}</span>
                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => remove(index)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label required>{t('scmSources.detail.repoUrlLabel')}</Label>
                    <Input
                      placeholder="https://gitlab.com/org/repo.git"
                      className="font-mono text-sm"
                      {...register(`repos.${index}.repoUrl`, {
                        required: t('common.required'),
                      })}
                      onChange={(e) => {
                        const currentDir = getValues(`repos.${index}.directory`)
                        const oldUrl = getValues(`repos.${index}.repoUrl`)
                        const oldDerived = deriveDirectoryFromUrl(oldUrl)
                        const derivedDir = deriveDirectoryFromUrl(e.target.value)
                        if (!currentDir || currentDir === oldDerived) {
                          setValue(`repos.${index}.directory`, derivedDir)
                        }
                        register(`repos.${index}.repoUrl`).onChange(e)
                      }}
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>{t('scmSources.detail.branchLabel')}</Label>
                      <Input
                        placeholder="main"
                        className="font-mono text-sm"
                        {...register(`repos.${index}.branch`)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label required>{t('scmSources.detail.directoryLabel')}</Label>
                      <Input
                        placeholder="project-name"
                        className="font-mono text-sm"
                        {...register(`repos.${index}.directory`, {
                          required: t('common.required'),
                        })}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => append({ repoUrl: '', branch: 'main', directory: '' })}
                className="gap-1.5"
              >
                <Plus className="h-4 w-4" />
                {t('scmSources.detail.addRepo')}
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="repoUrl" required>
                  {t('scmSources.detail.repoUrlLabel')}
                </Label>
                <Input
                  id="repoUrl"
                  placeholder="https://github.com/org/repo.git"
                  className="font-mono text-sm"
                  {...register('repoUrl', {
                    required:
                      scmType === 'git' && !multiRepo
                        ? t('scmSources.detail.repoUrlRequired')
                        : false,
                  })}
                />
                {errors.repoUrl && (
                  <p className="text-xs text-destructive">{errors.repoUrl.message}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('scmSources.detail.repoUrlProtocolHint')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch">{t('scmSources.detail.branchLabel')}</Label>
                <Input
                  id="branch"
                  placeholder="main"
                  className="font-mono text-sm"
                  {...register('branch')}
                />
              </div>
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="username">{t('scmSources.detail.usernameLabel')}</Label>
              <Input
                id="username"
                placeholder="git-user"
                className="font-mono text-sm"
                {...register('username')}
              />
              <p className="text-xs text-muted-foreground">{t('scmSources.detail.usernameHint')}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pat">Personal Access Token (PAT)</Label>
            <div className="relative">
              <Input
                id="pat"
                type={showPassword ? 'text' : 'password'}
                placeholder="ghp_xxxxxxxxxxxx"
                className="pr-10 font-mono text-sm"
                autoComplete="new-password"
                {...register('pat')}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full w-10 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={
                  showPassword
                    ? t('scmSources.detail.hidePassword')
                    : t('scmSources.detail.showPassword')
                }
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('scmSources.gitPatHint')}</p>
          </div>
          {/* workspacesPath field (git). Kept here in Config since it configures where
              worktrees live; the worktrees list itself is on the Sync & Workspaces tab. */}
          {!isCreateMode && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="workspacesPath" className="!mb-0">
                  {t('scmSources.workspacesPathLabel')}
                </Label>
                <Tooltip title={t('scmSources.workspacesPathHint')} placement="top">
                  <HelpCircle
                    className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground cursor-help"
                    aria-label={t('scmSources.workspacesPathHint')}
                  />
                </Tooltip>
              </div>
              <Input
                id="workspacesPath"
                placeholder={`~/.a2wave/workspaces/${idSuffix(sourceId)}`}
                className="font-mono text-sm"
                {...register('workspacesPath', {
                  // Optional: blank means "use the default", so only a filled-in
                  // value has to be absolute.
                  validate: (value) =>
                    !value.trim() ||
                    isAbsolutePath(value) ||
                    t('scmSources.detail.workspacesPathAbsolute'),
                })}
              />
              {errors.workspacesPath && (
                <p className="text-xs text-destructive">{errors.workspacesPath.message}</p>
              )}
            </div>
          )}
          {probePanel}
        </section>
      )}

      {/* P4 connection */}
      {scmType === 'p4' && (
        <section className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-foreground">P4 Connection</h3>
            <p className="text-sm text-muted-foreground">
              {t('scmSources.detail.p4ConnectionDesc')}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="p4port" required>
                P4PORT
              </Label>
              <Input
                id="p4port"
                placeholder="ssl:perforce.example.com:1666"
                className="font-mono text-sm"
                {...register('p4port', {
                  required: scmType === 'p4' ? 'P4PORT is required' : false,
                })}
              />
              {errors.p4port && <p className="text-xs text-destructive">{errors.p4port.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="p4user" required>
                P4USER
              </Label>
              <Input
                id="p4user"
                placeholder="username"
                className="font-mono text-sm"
                autoComplete="off"
                {...register('p4user', {
                  required: scmType === 'p4' ? 'P4USER is required' : false,
                })}
              />
              {errors.p4user && <p className="text-xs text-destructive">{errors.p4user.message}</p>}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="p4passwd">P4PASSWD</Label>
              <div className="relative">
                <Input
                  id="p4passwd"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  className="pr-10 font-mono text-sm"
                  autoComplete="new-password"
                  {...register('p4passwd')}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full w-10 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={
                    showPassword
                      ? t('scmSources.detail.hidePassword')
                      : t('scmSources.detail.showPassword')
                  }
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="p4client" required>
                P4CLIENT
              </Label>
              <Input
                id="p4client"
                placeholder="client-workspace-name"
                className="font-mono text-sm"
                {...register('p4client', {
                  required: scmType === 'p4' ? 'P4CLIENT is required' : false,
                })}
              />
              {errors.p4client && (
                <p className="text-xs text-destructive">{errors.p4client.message}</p>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="depotPath">{t('scmSources.detail.depotPathLabel')}</Label>
            <Input
              id="depotPath"
              placeholder="//depot/project/"
              className="font-mono text-sm"
              {...register('depotPath')}
            />
            <p className="text-xs text-muted-foreground">{t('scmSources.detail.depotPathHint')}</p>
          </div>
          {probePanel}
        </section>
      )}

      {/* Auto Sync */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-foreground">
            {t('scmSources.detail.autoSyncTitle')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('scmSources.detail.autoSyncDesc')}</p>
        </div>
        <div className="space-y-2 max-w-xs">
          <Label htmlFor="initialSyncTimeoutMin">
            {t('scmSources.detail.initialSyncTimeoutLabel')}
          </Label>
          <Input
            id="initialSyncTimeoutMin"
            type="number"
            min={1}
            {...register('initialSyncTimeoutMin', { valueAsNumber: true, min: 1 })}
          />
          <p className="text-xs text-muted-foreground">
            {t('scmSources.detail.initialSyncTimeoutHint')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            aria-label={t('scmSources.detail.enableAutoSync')}
            checked={autoSync}
            onCheckedChange={(val) => setValue('autoSync', val, { shouldDirty: true })}
          />
          <Label>{t('scmSources.detail.enableAutoSync')}</Label>
        </div>
        {autoSync && (
          <div className="space-y-2 max-w-xs">
            <Label htmlFor="syncIntervalMin">{t('scmSources.detail.syncIntervalLabel')}</Label>
            <Input
              id="syncIntervalMin"
              type="number"
              min={1}
              {...register('syncIntervalMin', { valueAsNumber: true, min: 1 })}
            />
          </div>
        )}
      </section>

      {/* CodeGraph enable (status readout lives on the Sync tab) */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-foreground">
            {t('scmSources.codegraph.title')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('scmSources.codegraph.description')}</p>
        </div>
        <div className="flex items-start gap-3">
          <Switch
            aria-label={t('scmSources.codegraph.enable')}
            checked={codegraphEnabled}
            onCheckedChange={(val) => setValue('codegraphEnabled', val, { shouldDirty: true })}
          />
          <div className="space-y-1">
            <Label>{t('scmSources.codegraph.enable')}</Label>
            <p className="text-xs text-muted-foreground">{t('scmSources.codegraph.enableHint')}</p>
          </div>
        </div>
      </section>
    </div>
  )

  // ── Sync & Workspaces tab content (edit-only) ──────────────
  const syncPane = (
    <div className="space-y-4">
      {/* Check + Sync actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={handleCheck}
          disabled={checkSource.isPending}
          type="button"
        >
          {checkSource.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : checkSource.data?.data?.ok ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : checkSource.data ? (
            <XCircle className="h-4 w-4 text-destructive" />
          ) : null}
          {t('scmSources.detail.checkConnection')}
        </Button>
        <Button
          variant="outline"
          onClick={handleSync}
          disabled={syncSource.isPending || status?.syncStatus === 'syncing'}
          type="button"
        >
          {syncSource.isPending || status?.syncStatus === 'syncing' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {t('scmSources.detail.syncNow')}
        </Button>
      </div>

      {/* Check result */}
      {checkSource.data?.data && (
        <div
          className={cn(
            'rounded-lg border px-4 py-3 space-y-1 text-sm',
            checkSource.data.data.ok ? 'border-success/30' : 'border-destructive/30',
          )}
        >
          <div className="flex items-center gap-2">
            {checkSource.data.data.ok ? (
              <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
            ) : (
              <XCircle className="h-4 w-4 text-destructive shrink-0" />
            )}
            <span>{checkSource.data.data.message}</span>
            {checkSource.data.data.serverVersion && (
              <span className="text-muted-foreground ml-2">
                ({checkSource.data.data.serverVersion})
              </span>
            )}
          </div>
          {checkSource.data.data.clientRoot && (
            <p className="pl-6 font-mono text-xs text-muted-foreground">
              {t('scmSources.detail.p4ClientRoot')}: {checkSource.data.data.clientRoot}
            </p>
          )}
          {checkSource.data.data.clientRootWarning && (
            <p className="pl-6 text-xs text-warning">{checkSource.data.data.clientRootWarning}</p>
          )}
        </div>
      )}

      {/* Live sync banners (from polling) */}
      {status?.syncStatus === 'syncing' && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <div className="flex items-center gap-2.5 text-sm text-interactive-foreground">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>{t('scmSources.detail.syncing')}</span>
          </div>
        </div>
      )}
      {status?.syncStatus === 'error' && status.lastSyncError && (
        <ErrorNotice title={t('scmSources.detail.syncFailed')} message={status.lastSyncError} />
      )}

      {/* Sync status readout */}
      {source && (
        <section className="space-y-2 text-sm">
          <h3 className="text-base font-semibold text-foreground">
            {t('scmSources.detail.syncStatusTitle')}
          </h3>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-28">
                {t('scmSources.detail.initialSyncLabel')}
              </span>
              <span className="font-medium">
                {initialSyncCompletedAt != null
                  ? t('scmSources.detail.initialSyncDone')
                  : t('scmSources.detail.initialSyncPending')}
              </span>
            </div>
            {initialSyncCompletedAt == null && (
              <p className="text-xs text-muted-foreground pl-[7rem]">
                {t('scmSources.detail.initialSyncPendingHint')}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-28">{t('scmSources.detail.statusLabel')}</span>
            <span className="font-medium">
              {(() => {
                const s = status?.syncStatus ?? source.syncStatus ?? 'idle'
                return syncStatusLabelKeys[s] ? t(syncStatusLabelKeys[s]) : s
              })()}
            </span>
          </div>
          {(status?.lastSyncAt ?? source.lastSyncAt) && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-28">{t('common.lastSync')}</span>
              <span>
                {new Date((status?.lastSyncAt ?? source.lastSyncAt) as string).toLocaleString()}
              </span>
            </div>
          )}
          {/* Only when the banner above isn't already showing this exact
              message — a live sync error renders there, and repeating it
              verbatim two rows later was pure duplication. This row remains
              for the stale case: a past failure on a source no longer in the
              `error` state. */}
          {(() => {
            const lastError = status !== undefined ? status.lastSyncError : source.lastSyncError
            const shownInBanner = status?.syncStatus === 'error' && !!status.lastSyncError
            if (!lastError || shownInBanner) return null
            return (
              <ErrorNotice
                title={t('scmSources.detail.lastErrorLabel')}
                message={lastError}
                className="mt-1"
              />
            )
          })()}
        </section>
      )}

      {/* CodeGraph status + reindex */}
      {source && (
        <section className="space-y-2 text-sm">
          <div className="flex items-start justify-between gap-4">
            <h3 className="text-base font-semibold text-foreground">
              {t('scmSources.codegraph.title')}
            </h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                !((source.config as Record<string, unknown> | null)?.codegraphEnabled === true) ||
                reindexCodegraph.isPending ||
                status?.codegraphStatus === 'indexing'
              }
              onClick={() => sourceId && reindexCodegraph.mutate(sourceId)}
            >
              {status?.codegraphStatus === 'indexing' || reindexCodegraph.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {status?.codegraphStatus === 'indexing'
                ? t('scmSources.codegraph.indexing')
                : t('scmSources.codegraph.reindex')}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-32">
              {t('scmSources.codegraph.statusLabel')}
            </span>
            <span className="font-medium">
              {(() => {
                const s = status?.codegraphStatus ?? source.codegraphStatus ?? 'idle'
                return codegraphStatusLabelKeys[s] ? t(codegraphStatusLabelKeys[s]) : s
              })()}
            </span>
          </div>
          {(status?.codegraphLastIndexedAt ?? source.codegraphLastIndexedAt) && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-32">
                {t('scmSources.codegraph.lastIndexed')}
              </span>
              <span>
                {new Date(
                  (status?.codegraphLastIndexedAt ?? source.codegraphLastIndexedAt) as string,
                ).toLocaleString()}
              </span>
            </div>
          )}
          {(status?.codegraphLastError ?? source.codegraphLastError) && (
            <ErrorNotice
              title={t('scmSources.codegraph.lastError')}
              message={status?.codegraphLastError ?? source.codegraphLastError}
              className="mt-1"
            />
          )}
        </section>
      )}

      {/* Workspaces (git only) */}
      {workspacesEnabled && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-foreground">
              {t('scmSources.workspaces.title')}
            </h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => refetchWorkspaces()}
              disabled={workspacesLoading}
            >
              {workspacesLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {t('scmSources.workspaces.refresh')}
            </Button>
          </div>
          {workspaces && workspaces.length > 0 ? (
            <div className="space-y-3">
              {workspaces.map((ws) => {
                const hasError = ws.repos.some((r) => !!r.error)
                const confirmDelete = () => {
                  if (!sourceId) return
                  confirm({
                    title: t('scmSources.workspaces.deleteTitle'),
                    content: t('scmSources.workspaces.deleteContent', { name: ws.name }),
                    okText: t('common.delete'),
                    danger: true,
                    onOk: async () => {
                      try {
                        await deleteWorkspace.mutateAsync({ id: sourceId, name: ws.name })
                      } catch (error) {
                        console.error('Failed to delete workspace:', error)
                      }
                    },
                  })
                }
                const cleanupStyles: Record<string, string> = {
                  ephemeral: 'border-red-200 bg-red-50 text-red-700',
                  ttl: 'border-blue-200 bg-blue-50 text-blue-700',
                  persistent: 'border-emerald-200 bg-emerald-50 text-emerald-700',
                }
                const cleanupLabel = ws.cleanup
                  ? t(`scmSources.workspaces.cleanup.${ws.cleanup}`)
                  : null
                const relTime = ws.lastActivityAt
                  ? formatRelativeTime(ws.lastActivityAt)
                  : t('scmSources.workspaces.neverUsed')
                const isExpanded = !!expandedWorkspaces[ws.name]
                const toggleExpanded = () =>
                  setExpandedWorkspaces((prev) => ({ ...prev, [ws.name]: !prev[ws.name] }))
                return (
                  <div
                    key={ws.name}
                    className={cn(
                      'rounded-lg border bg-card',
                      hasError ? 'border-destructive/40 bg-destructive/5' : 'border-border',
                    )}
                  >
                    <div
                      className={cn(
                        'flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-surface-hover',
                        isExpanded && 'border-b border-border/60',
                      )}
                      onClick={toggleExpanded}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleExpanded()
                        }
                      }}
                      // biome-ignore lint/a11y/useSemanticElements: this expand/collapse header
                      // row contains nested <button>s (copy path, rebuild, delete), and nesting a
                      // button inside a button is invalid HTML — so it stays a div.
                      role="button"
                      tabIndex={0}
                      aria-expanded={isExpanded}
                    >
                      <div className="shrink-0 text-muted-foreground">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-base font-semibold font-mono truncate">
                            {ws.name}
                          </span>
                          {ws.occupied ? (
                            <span className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-xs font-medium text-orange-700">
                              {t('scmSources.workspaces.occupied')}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                              {t('scmSources.workspaces.idle')}
                            </span>
                          )}
                          <Tooltip title={ws.path} placement="top">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                navigator.clipboard
                                  ?.writeText(ws.path)
                                  .then(() =>
                                    message.success(t('scmSources.workspaces.pathCopied')),
                                  )
                                  .catch(() => {})
                              }}
                              className={cn(
                                'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium transition-colors hover:brightness-95',
                                ws.cleanup
                                  ? cleanupStyles[ws.cleanup as string]
                                  : 'border-border bg-muted/40 text-muted-foreground',
                              )}
                              aria-label={ws.path}
                            >
                              <FolderGit2 className="h-3 w-3" />
                              {cleanupLabel ?? t('scmSources.workspaces.cleanupUnknown')}
                            </button>
                          </Tooltip>
                          {hasError && (
                            <span className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                              <AlertCircle className="h-3 w-3" />
                              {t('scmSources.workspaces.needsRepair')}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* Keeps the action buttons from toggling the row: the click handler stops
                          pointer activation, and the key handler does the same for Enter/Space so
                          keyboard users are not silently collapsing the row they just acted on. */}
                      <div
                        className="flex items-center gap-2 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
                        }}
                      >
                        <span className="text-xs text-muted-foreground">{relTime}</span>
                        {hasError && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={ws.occupied || deleteWorkspace.isPending}
                            onClick={confirmDelete}
                          >
                            {t('scmSources.workspaces.rebuild')}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground hover:text-destructive"
                          aria-label={t('scmSources.workspaces.deleteAria', { name: ws.name })}
                          disabled={ws.occupied || deleteWorkspace.isPending}
                          onClick={confirmDelete}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="divide-y divide-border/50">
                        {ws.repos.map((r, idx) => (
                          <div
                            key={`${ws.name}-${idx}`}
                            className="flex items-center gap-3 px-4 py-2"
                          >
                            {r.directory ? (
                              <span className="text-sm font-medium font-mono shrink-0 min-w-24 truncate">
                                {r.directory}
                              </span>
                            ) : (
                              <span className="text-sm font-medium text-muted-foreground shrink-0 min-w-24">
                                {t('scmSources.workspaces.rootRepo')}
                              </span>
                            )}
                            {r.error ? (
                              <span className="flex-1 min-w-0 inline-flex items-center gap-1 text-xs text-destructive">
                                <AlertCircle className="h-3 w-3 shrink-0" />
                                <span className="truncate">{r.error}</span>
                              </span>
                            ) : (
                              <div className="flex-1 min-w-0 flex items-center gap-2">
                                <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5">
                                  <GitBranch className="h-3 w-3 text-muted-foreground" />
                                  {r.branch ? (
                                    <code className="text-xs font-mono font-medium">
                                      {r.branch}
                                    </code>
                                  ) : (
                                    <span className="text-xs italic text-muted-foreground">
                                      {t('scmSources.workspaces.detached')}
                                    </span>
                                  )}
                                </span>
                                {r.commit && (
                                  <code className="text-xs font-mono text-muted-foreground">
                                    {r.commit}
                                  </code>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="info-panel px-3 py-2.5 text-sm text-muted-foreground">
              {t('scmSources.workspaces.empty')}
            </div>
          )}
          {deleteWorkspace.isError && (
            <p className="mt-2 text-sm text-destructive">
              {formatApiError(deleteWorkspace.error, t)}
            </p>
          )}
        </section>
      )}
    </div>
  )

  return (
    <form
      onSubmit={handleSubmit(onSubmit, () => {
        // Validation failed — the required fields live on the Config tab, so
        // surface it (otherwise the error is on an unmounted pane and Save looks
        // like it did nothing).
        setActiveTab('config')
      })}
      className="flex max-h-[70vh] flex-col"
    >
      {isCreateMode ? (
        // Create mode: only Config — no source exists yet to sync/manage workspaces for.
        <div className="min-h-0 flex-1 overflow-y-auto -mr-5 pr-5">
          <div className="min-h-[24rem] space-y-6">{configPane}</div>
        </div>
      ) : (
        // Edit mode: the tab bar (+ actions) stays pinned; only the active tab's
        // content scrolls. Tabs spans the whole column so its context wraps both.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 pb-3">
            <Segmented
              value={activeTab}
              onChange={(v) => setActiveTab(v as 'config' | 'sync')}
              options={[
                { value: 'config', label: t('scmSources.configTab') },
                { value: 'sync', label: t('scmSources.syncWorkspacesTab') },
              ]}
            />
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'delete',
                    label: source
                      ? t('scmSources.detail.deleteMenu', {
                          type: source.type === 'git' ? 'Git' : 'P4',
                        })
                      : t('common.delete'),
                    icon: <Trash2 className="h-4 w-4" />,
                    danger: true,
                    disabled: deleteSource.isPending,
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
                aria-label={t('scmSources.detail.moreActions')}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </Dropdown>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto -mr-5 pr-5">
            <div className="min-h-[24rem]">{activeTab === 'config' ? configPane : syncPane}</div>
          </div>
        </div>
      )}

      {/* Pinned save bar. Mutation errors live here rather than inside a tab
          pane: saving from the "Sync & Workspaces" tab can still fail (e.g. a
          409 when a sync is in progress), and an error rendered into the
          unmounted Config pane would leave the modal silently doing nothing. */}
      <div className="mt-3 flex shrink-0 flex-col gap-2 border-t border-border/60 pt-3">
        {saveError && (
          <p className="text-sm text-destructive" role="alert">
            {formatApiError(saveError, t)}
          </p>
        )}
        {/* Only once the confirm dialog is gone — while it is open it renders the
            same error on top, and showing both would just duplicate it. */}
        {deleteSource.isError && !deleteDialogOpen && (
          <p className="text-sm text-destructive" role="alert">
            {formatApiError(deleteSource.error, t)}
          </p>
        )}
        <div className="flex items-center justify-end">
          <Button type="submit" disabled={isSaving || (!isCreateMode && !isDirty)}>
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {isCreateMode ? t('common.create') : t('common.save')}
          </Button>
        </div>
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            {t('scmSources.detail.deleteConfirmTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {source
              ? t('scmSources.detail.deleteConfirmContent', {
                  type: source.type === 'git' ? 'Git' : 'P4',
                  name: source.name,
                })
              : ''}
          </AlertDialogDescription>
          {/* The dialog stays open on failure so the user can read why and retry
              or cancel. The error must live in here rather than only in the save
              bar below — the dialog and its overlay sit on top, so a banner in
              the underlying form would be covered up and never seen. */}
          {deleteSource.isError && (
            <p className="text-sm text-destructive" role="alert">
              {formatApiError(deleteSource.error, t)}
            </p>
          )}
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteSource.isPending}>
              {deleteSource.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t('scmSources.detail.deleteConfirmOk')
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  )
}
