import { SETTINGS_DEFAULTS } from '@a2wave/shared'
import { useMutation } from '@tanstack/react-query'
import type { LucideIcon } from 'lucide-react'
import {
  AtSign,
  Bell,
  Check,
  Clock,
  FileText,
  FolderOpen,
  Globe,
  Image,
  Key,
  KeyRound,
  Loader2,
  Lock,
  Package,
  Paperclip,
  ShieldCheck,
  Subtitles,
  Timer,
  UserCog,
  UserPlus,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FieldValues, UseFormReturn } from 'react-hook-form'
import { Controller, useForm } from 'react-hook-form'
import { Trans, useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { CliTokensCard } from '@/components/cli-tokens-card'
import { FaviconUpload } from '@/components/favicon-upload'
import { SsoMethodsCard } from '@/components/sso-methods-card'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModePicker } from '@/components/ui/mode-picker'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useSettings, useUpdateSettings } from '@/hooks/use-settings'
import { api } from '@/lib/api'
import { formatApiError } from '@/lib/api-error'
import { DEFAULT_BRAND_ICON_URL } from '@/lib/brand-presets'
import { cn } from '@/lib/utils'

const SETTINGS_TABS = [
  { id: 'general', labelKey: 'settings.tabs.general', icon: FolderOpen },
  { id: 'artifacts', labelKey: 'settings.tabs.artifacts', icon: Package },
  { id: 'attachments', labelKey: 'settings.tabs.attachments', icon: Paperclip },
  { id: 'branding', labelKey: 'settings.tabs.branding', icon: Image },
  { id: 'webhook', labelKey: 'settings.tabs.webhook', icon: Bell },
  { id: 'auth', labelKey: 'settings.tabs.auth', icon: ShieldCheck },
  { id: 'cli', labelKey: 'settings.tabs.cli', icon: KeyRound },
] as const satisfies ReadonlyArray<{ id: string; labelKey: string; icon: LucideIcon }>

type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']

type GeneralFormData = {
  workspacePath: string
  timeoutMinutes: number
}

type ArtifactsFormData = {
  storagePath: string
  retentionHours: number
  publicBaseUrl: string
  requireAuthForDownload: boolean
  // History retention (settings.dataRetention) — grouped under the same
  // "storage & retention" tab. Prunes terminal runs + audit logs after N days.
  historyRetentionEnabled: boolean
  historyRetentionDays: number
}

type AttachmentsFormData = {
  stagingTtlHours: number
  maxFileSizeMb: number
  maxFilesPerRequest: number
  allowedExtensions: string
}

type BrandingFormData = {
  subtitle: string
  faviconUrl: string
}

type WebhookFormData = {
  enabled: boolean
  type: 'feishu' | 'custom'
  url: string
  maxRetries: number
}

type AuthFormData = {
  oauthEnabled: boolean
  oauthAllowedEmailDomains: string
  oauthDefaultRole: 'user' | 'admin'
  oauthAutoProvision: boolean
  passwordLoginEnabled: boolean
}

function SaveButton({
  isPending,
  isSuccess,
  isDirty,
  isError,
  error,
  t,
}: {
  isPending: boolean
  isSuccess: boolean
  isDirty: boolean
  isError: boolean
  // The mutation's raw error rather than a pre-read `.message`: settings routes are
  // the only producer of `WEBHOOK_URL_BLOCKED`, `INVALID_SSO_CONFIG` and
  // `AUTH_LOCKDOWN_REFUSED`, and `api.ts` throws the bare code as the message — so
  // reading it here meant every save surfaced the raw identifier. Formatting inside
  // keeps all six call sites translated by construction.
  error?: unknown
  t: (key: string) => string
}) {
  return (
    <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border/50">
      {isError && (
        <p className="text-sm text-destructive mr-auto">
          {t('settings.saveFailed')}：{formatApiError(error, t)}
        </p>
      )}
      <Button type="submit" disabled={!isDirty || isPending} className="gap-1.5">
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : isSuccess && !isDirty ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : null}
        {isPending
          ? t('common.saving')
          : isSuccess && !isDirty
            ? t('common.saved')
            : t('common.save')}
      </Button>
    </div>
  )
}

/**
 * Re-seed a settings form from the server without discarding what the admin is
 * editing.
 *
 * A plain `reset()` on every refetch throws away in-progress edits; skipping the
 * reset whenever the form is dirty leaves the untouched fields frozen at their
 * page-load values — so after a 409 the admin is told the latest version has been
 * loaded, saves again, and writes those stale values over the other admin's
 * concurrent change, causing the very lost update the conflict check exists to
 * prevent.
 *
 * `keepDirty: true` alongside `keepDirtyValues`: RHF's `_reset` otherwise emits
 * `isDirty: false` literally while preserving `dirtyFields`, and recovery would
 * depend on `useForm`'s re-sync, which only runs because SaveButton happens to
 * read `formState.isDirty` during render.
 */
function rebaseFormFromServer<T extends FieldValues>(form: UseFormReturn<T>, incoming: T) {
  form.reset(incoming, { keepDirtyValues: true, keepDirty: true })
}

/**
 * Mutation options that clear `isDirty` after a successful save — the counterpart
 * the rebase needs, or a form stays dirty forever after its first save.
 */
function clearDirtyOnSuccess<T extends FieldValues>(form: UseFormReturn<T>) {
  return { onSuccess: () => form.reset(form.getValues(), { keepValues: true }) }
}

export function SettingsPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab: SettingsTabId = SETTINGS_TABS.some((s) => s.id === tabParam)
    ? (tabParam as SettingsTabId)
    : 'general'
  const handleTabChange = (next: SettingsTabId) => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    setSearchParams(params, { replace: true })
  }
  const { data: settings, isLoading } = useSettings()
  const updateGeneral = useUpdateSettings()
  const updateBranding = useUpdateSettings()
  const updateWebhook = useUpdateSettings()
  const updateArtifacts = useUpdateSettings()
  const updateAttachments = useUpdateSettings()
  const updateAuth = useUpdateSettings()

  const generalDefaults = SETTINGS_DEFAULTS.general
  const brandingDefaults = SETTINGS_DEFAULTS.branding
  const webhookDefaults = SETTINGS_DEFAULTS.webhook
  const artifactsDefaults = SETTINGS_DEFAULTS.artifacts
  const attachmentsDefaults = SETTINGS_DEFAULTS.attachments
  const dataRetentionDefaults = SETTINGS_DEFAULTS.dataRetention
  const authDefaults = SETTINGS_DEFAULTS.auth

  const generalForm = useForm<GeneralFormData>({
    defaultValues: {
      workspacePath: generalDefaults.workspacePath,
      timeoutMinutes: Number(generalDefaults.timeoutMinutes),
    },
  })

  const artifactsForm = useForm<ArtifactsFormData>({
    defaultValues: {
      storagePath: artifactsDefaults.storagePath,
      retentionHours: Number(artifactsDefaults.retentionHours),
      publicBaseUrl: artifactsDefaults.publicBaseUrl ?? '',
      requireAuthForDownload: artifactsDefaults.requireAuthForDownload === 'true',
      historyRetentionEnabled: dataRetentionDefaults.enabled === 'true',
      historyRetentionDays: Number(dataRetentionDefaults.retentionDays),
    },
  })

  const attachmentsForm = useForm<AttachmentsFormData>({
    defaultValues: {
      stagingTtlHours: Number(attachmentsDefaults.stagingTtlHours),
      maxFileSizeMb: Math.round(Number(attachmentsDefaults.maxFileSizeBytes) / 1024 / 1024),
      maxFilesPerRequest: Number(attachmentsDefaults.maxFilesPerRequest),
      allowedExtensions: attachmentsDefaults.allowedExtensions,
    },
  })

  const brandingForm = useForm<BrandingFormData>({
    defaultValues: {
      subtitle: brandingDefaults.subtitle,
      faviconUrl: brandingDefaults.faviconUrl,
    },
  })

  const webhookForm = useForm<WebhookFormData>({
    defaultValues: {
      enabled: webhookDefaults.enabled === 'true',
      type: (webhookDefaults.type as 'feishu' | 'custom') || 'feishu',
      url: webhookDefaults.url,
      maxRetries: Number(webhookDefaults.maxRetries) || 3,
    },
  })

  const authForm = useForm<AuthFormData>({
    defaultValues: {
      oauthEnabled: authDefaults.oauthEnabled === 'true',
      oauthAllowedEmailDomains: authDefaults.oauthAllowedEmailDomains,
      oauthDefaultRole: (authDefaults.oauthDefaultRole as 'user' | 'admin') || 'user',
      oauthAutoProvision: authDefaults.oauthAutoProvision === 'true',
      passwordLoginEnabled: authDefaults.passwordLoginEnabled === 'true',
    },
  })

  const [pendingDisablePassword, setPendingDisablePassword] = useState<AuthFormData | null>(null)

  useEffect(() => {
    if (settings?.general) {
      rebaseFormFromServer(generalForm, {
        workspacePath: settings.general.workspacePath || generalDefaults.workspacePath,
        timeoutMinutes:
          Number(settings.general.timeoutMinutes) || Number(generalDefaults.timeoutMinutes),
      })
    }
  }, [settings, generalForm, generalDefaults])

  useEffect(() => {
    if (settings) {
      rebaseFormFromServer(artifactsForm, {
        storagePath: settings.artifacts?.storagePath || artifactsDefaults.storagePath,
        retentionHours:
          Number(settings.artifacts?.retentionHours) || Number(artifactsDefaults.retentionHours),
        publicBaseUrl: settings.artifacts?.publicBaseUrl ?? artifactsDefaults.publicBaseUrl ?? '',
        requireAuthForDownload:
          (settings.artifacts?.requireAuthForDownload ??
            artifactsDefaults.requireAuthForDownload) === 'true',
        historyRetentionEnabled:
          (settings.dataRetention?.enabled ?? dataRetentionDefaults.enabled) !== 'false',
        historyRetentionDays:
          Number(settings.dataRetention?.retentionDays) ||
          Number(dataRetentionDefaults.retentionDays),
      })
    }
  }, [settings, artifactsForm, artifactsDefaults, dataRetentionDefaults])

  useEffect(() => {
    if (settings) {
      rebaseFormFromServer(attachmentsForm, {
        stagingTtlHours:
          Number(settings.attachments?.stagingTtlHours) ||
          Number(attachmentsDefaults.stagingTtlHours),
        maxFileSizeMb: Math.round(
          (Number(settings.attachments?.maxFileSizeBytes) ||
            Number(attachmentsDefaults.maxFileSizeBytes)) /
            1024 /
            1024,
        ),
        maxFilesPerRequest:
          Number(settings.attachments?.maxFilesPerRequest) ||
          Number(attachmentsDefaults.maxFilesPerRequest),
        allowedExtensions:
          settings.attachments?.allowedExtensions ?? attachmentsDefaults.allowedExtensions,
      })
    }
  }, [settings, attachmentsForm, attachmentsDefaults])

  useEffect(() => {
    if (settings) {
      rebaseFormFromServer(brandingForm, {
        subtitle: settings.branding?.subtitle || brandingDefaults.subtitle,
        faviconUrl: settings.branding?.faviconUrl || brandingDefaults.faviconUrl,
      })
    }
  }, [settings, brandingForm, brandingDefaults])

  // biome-ignore lint/correctness/useExhaustiveDependencies: webhookDefaults intentionally re-resets the form when defaults change
  useEffect(() => {
    if (settings?.webhook) {
      rebaseFormFromServer(webhookForm, {
        enabled: settings.webhook.enabled === 'true',
        type: (settings.webhook.type as 'feishu' | 'custom') || 'feishu',
        url: settings.webhook.url || '',
        maxRetries: Number(settings.webhook.maxRetries) || 3,
      })
    }
  }, [settings, webhookForm, webhookDefaults])

  useEffect(() => {
    if (settings?.auth) {
      rebaseFormFromServer(authForm, {
        oauthEnabled: settings.auth.oauthEnabled === 'true',
        oauthAllowedEmailDomains:
          settings.auth.oauthAllowedEmailDomains ?? authDefaults.oauthAllowedEmailDomains,
        oauthDefaultRole: (settings.auth.oauthDefaultRole as 'user' | 'admin') || 'user',
        oauthAutoProvision: settings.auth.oauthAutoProvision === 'true',
        passwordLoginEnabled: settings.auth.passwordLoginEnabled === 'true',
      })
    }
  }, [settings, authForm, authDefaults])

  const onGeneralSubmit = (data: GeneralFormData) => {
    updateGeneral.mutate(
      {
        general: {
          workspacePath: data.workspacePath,
          timeoutMinutes: String(data.timeoutMinutes),
        },
      },
      clearDirtyOnSuccess(generalForm),
    )
  }

  const onArtifactsSubmit = (data: ArtifactsFormData) => {
    updateArtifacts.mutate(
      {
        artifacts: {
          storagePath: data.storagePath,
          retentionHours: String(data.retentionHours),
          publicBaseUrl: data.publicBaseUrl,
          requireAuthForDownload: String(data.requireAuthForDownload),
        },
        dataRetention: {
          enabled: String(data.historyRetentionEnabled),
          retentionDays: String(data.historyRetentionDays),
        },
      },
      clearDirtyOnSuccess(artifactsForm),
    )
  }

  const onAttachmentsSubmit = (data: AttachmentsFormData) => {
    updateAttachments.mutate(
      {
        attachments: {
          stagingTtlHours: String(data.stagingTtlHours),
          maxFileSizeBytes: String(Math.round(data.maxFileSizeMb * 1024 * 1024)),
          maxFilesPerRequest: String(data.maxFilesPerRequest),
          allowedExtensions: data.allowedExtensions
            .split(',')
            .map((e) => e.trim().replace(/^\./, '').toLowerCase())
            .filter(Boolean)
            .join(','),
        },
      },
      clearDirtyOnSuccess(attachmentsForm),
    )
  }

  const onBrandingSubmit = (data: BrandingFormData) => {
    updateBranding.mutate(
      {
        branding: {
          subtitle: data.subtitle,
          faviconUrl: data.faviconUrl,
        },
      },
      clearDirtyOnSuccess(brandingForm),
    )
  }

  const onWebhookSubmit = (data: WebhookFormData) => {
    updateWebhook.mutate(
      {
        webhook: {
          enabled: String(data.enabled),
          type: data.type,
          url: data.url,
          maxRetries: String(data.maxRetries),
        },
      },
      clearDirtyOnSuccess(webhookForm),
    )
  }

  const submitAuth = (data: AuthFormData) => {
    updateAuth.mutate(
      {
        auth: {
          oauthEnabled: String(data.oauthEnabled),
          oauthAllowedEmailDomains: data.oauthAllowedEmailDomains.trim(),
          oauthDefaultRole: data.oauthDefaultRole,
          oauthAutoProvision: String(data.oauthAutoProvision),
          passwordLoginEnabled: String(data.passwordLoginEnabled),
        },
      },
      clearDirtyOnSuccess(authForm),
    )
  }

  const onAuthSubmit = (data: AuthFormData) => {
    // 关闭密码登录前必须强制确认 + 必须 OAuth 已启用，否则锁死
    const wasEnabled = settings?.auth?.passwordLoginEnabled !== 'false'
    if (wasEnabled && !data.passwordLoginEnabled) {
      if (!data.oauthEnabled) {
        // 服务端会再拦一次，但前端先给即时反馈
        authForm.setError('passwordLoginEnabled', {
          message: t('settings.auth.saveBlockedNoOauth'),
        })
        return
      }
      setPendingDisablePassword(data)
      return
    }
    submitAuth(data)
  }

  const testWebhook = useMutation({
    mutationFn: (data: { url: string; type: 'feishu' | 'custom' }) =>
      api.post<{ ok: boolean; error?: string }>('/settings/webhook/test', data),
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-32" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="flex gap-6 h-full">
      {/* Secondary sidebar — fix 200px，复用主菜单 token */}
      <aside
        className="w-[200px] shrink-0 sticky top-0 self-start"
        aria-label={t('settings.title')}
      >
        <nav className="space-y-0.5">
          {SETTINGS_TABS.map((tab) => {
            const Icon = tab.icon
            const isActive = tab.id === activeTab
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleTabChange(tab.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-3 py-[7px] text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? 'bg-surface-selected text-interactive-foreground ring-1 ring-inset ring-primary/10'
                    : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
                )}
              >
                <Icon
                  className={cn(
                    'h-[15px] w-[15px] shrink-0',
                    isActive ? 'text-interactive-foreground' : '',
                  )}
                  aria-hidden="true"
                />
                <span className="truncate">{t(tab.labelKey)}</span>
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Content — scrollable */}
      <div className="flex-1 min-w-0 space-y-6">
        {/* Page header */}
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground text-balance">
            {t('settings.title')}
          </h2>
        </div>

        {/* General section */}
        {activeTab === 'general' && (
          <form onSubmit={generalForm.handleSubmit(onGeneralSubmit)}>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('settings.general')}</CardTitle>
                <CardDescription>{t('settings.generalDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/50">
                  {/* Workspace Path */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="workspacePath"
                        required
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <FolderOpen
                          className="h-3.5 w-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                        {t('settings.workspacePath')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.workspacePathDesc')}
                      </p>
                    </div>
                    <div className="w-72 shrink-0">
                      <Input
                        id="workspacePath"
                        placeholder={generalDefaults.workspacePath}
                        {...generalForm.register('workspacePath', { required: true })}
                      />
                    </div>
                  </div>

                  {/* Timeout Minutes */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="timeoutMinutes"
                        required
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <Timer className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('settings.timeout')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.timeoutDesc')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Input
                        id="timeoutMinutes"
                        type="number"
                        min={1}
                        max={1440}
                        className="w-24"
                        placeholder={generalDefaults.timeoutMinutes}
                        {...generalForm.register('timeoutMinutes', {
                          required: true,
                          valueAsNumber: true,
                          min: 1,
                          max: 1440,
                        })}
                      />
                      <span className="text-sm text-muted-foreground">{t('settings.minutes')}</span>
                    </div>
                  </div>
                </div>

                <SaveButton
                  isPending={updateGeneral.isPending}
                  isSuccess={updateGeneral.isSuccess}
                  isDirty={generalForm.formState.isDirty}
                  isError={updateGeneral.isError}
                  error={updateGeneral.error}
                  t={t}
                />
              </CardContent>
            </Card>
          </form>
        )}

        {/* Artifacts section */}
        {activeTab === 'artifacts' && (
          <form onSubmit={artifactsForm.handleSubmit(onArtifactsSubmit)}>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('settings.artifactsTitle')}</CardTitle>
                <CardDescription>{t('settings.artifactsDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/50">
                  {/* Storage Path */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="artifactsStoragePath"
                        required
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <Package className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('settings.artifactsStoragePath')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.artifactsStoragePathDesc')}
                      </p>
                    </div>
                    <div className="w-72 shrink-0">
                      <Input
                        id="artifactsStoragePath"
                        placeholder={artifactsDefaults.storagePath}
                        {...artifactsForm.register('storagePath', { required: true })}
                      />
                    </div>
                  </div>

                  {/* Retention Hours */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="artifactsRetentionHours"
                        required
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('settings.artifactsRetentionHours')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.artifactsRetentionHoursDesc')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Input
                        id="artifactsRetentionHours"
                        type="number"
                        min={1}
                        max={8760}
                        className="w-24"
                        placeholder={artifactsDefaults.retentionHours}
                        {...artifactsForm.register('retentionHours', {
                          required: true,
                          valueAsNumber: true,
                          min: 1,
                          max: 8760,
                        })}
                      />
                      <span className="text-sm text-muted-foreground">{t('settings.hours')}</span>
                    </div>
                  </div>

                  {/* Public Base URL */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="artifactsPublicBaseUrl"
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('settings.artifactsPublicBaseUrl')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.artifactsPublicBaseUrlDesc')}
                      </p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <Trans
                          i18nKey="settings.artifactsPublicBaseUrlPorts"
                          components={{ b: <strong className="font-medium text-foreground" /> }}
                        />
                      </p>
                    </div>
                    <div className="w-72 shrink-0">
                      <Input
                        id="artifactsPublicBaseUrl"
                        placeholder="https://a2wave.example.com"
                        {...artifactsForm.register('publicBaseUrl', {
                          validate: (v) => {
                            if (!v?.trim()) return true
                            try {
                              const u = new URL(v.trim())
                              if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
                                return t('settings.artifactsPublicBaseUrlInvalidLocalhost')
                              }
                            } catch {
                              return t('settings.artifactsPublicBaseUrlInvalidFormat')
                            }
                            return true
                          },
                        })}
                      />
                      {artifactsForm.formState.errors.publicBaseUrl && (
                        <p className="text-xs text-destructive mt-1">
                          {artifactsForm.formState.errors.publicBaseUrl.message}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Require auth for download */}
                  <div className="flex items-center justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label className="flex items-center gap-1.5 text-sm font-medium">
                        <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('settings.artifactsRequireAuthForDownload')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.artifactsRequireAuthForDownloadDesc')}
                      </p>
                    </div>
                    <Controller
                      name="requireAuthForDownload"
                      control={artifactsForm.control}
                      render={({ field }) => (
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      )}
                    />
                  </div>

                  {/* History retention (dataRetention) */}
                  <div className="flex items-center justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label className="flex items-center gap-1.5 text-sm font-medium">
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('settings.historyRetentionEnabled')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.historyRetentionEnabledDesc')}
                      </p>
                    </div>
                    <Controller
                      name="historyRetentionEnabled"
                      control={artifactsForm.control}
                      render={({ field }) => (
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      )}
                    />
                  </div>

                  {/* History retention days */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="historyRetentionDays"
                        required
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('settings.historyRetentionDays')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.historyRetentionDaysDesc')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Input
                        id="historyRetentionDays"
                        type="number"
                        min={1}
                        max={3650}
                        className="w-24"
                        placeholder={dataRetentionDefaults.retentionDays}
                        {...artifactsForm.register('historyRetentionDays', {
                          required: true,
                          valueAsNumber: true,
                          min: 1,
                          max: 3650,
                        })}
                      />
                      <span className="text-sm text-muted-foreground">{t('settings.days')}</span>
                    </div>
                  </div>
                </div>

                <SaveButton
                  isPending={updateArtifacts.isPending}
                  isSuccess={updateArtifacts.isSuccess}
                  isDirty={artifactsForm.formState.isDirty}
                  isError={updateArtifacts.isError}
                  error={updateArtifacts.error}
                  t={t}
                />
              </CardContent>
            </Card>
          </form>
        )}

        {/* Attachments section */}
        {activeTab === 'attachments' && (
          <form onSubmit={attachmentsForm.handleSubmit(onAttachmentsSubmit)}>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('settings.attachmentsTitle')}</CardTitle>
                <CardDescription>{t('settings.attachmentsDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/50">
                  {/* Staging TTL */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="attachmentsTtl"
                        required
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('settings.attachmentsTtl')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.attachmentsTtlDesc')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Input
                        id="attachmentsTtl"
                        type="number"
                        min={1}
                        max={8760}
                        className="w-24"
                        {...attachmentsForm.register('stagingTtlHours', {
                          required: true,
                          valueAsNumber: true,
                          min: 1,
                          max: 8760,
                        })}
                      />
                      <span className="text-sm text-muted-foreground">{t('settings.hours')}</span>
                    </div>
                  </div>

                  {/* Max file size */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="attachmentsMaxSize"
                        required
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <Package className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('settings.attachmentsMaxSize')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.attachmentsMaxSizeDesc')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Input
                        id="attachmentsMaxSize"
                        type="number"
                        min={1}
                        max={100}
                        className="w-24"
                        {...attachmentsForm.register('maxFileSizeMb', {
                          required: true,
                          valueAsNumber: true,
                          min: 1,
                          max: 100,
                        })}
                      />
                      <span className="text-sm text-muted-foreground">MB</span>
                    </div>
                  </div>

                  {/* Max files per request */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="attachmentsMaxFiles"
                        required
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <Paperclip
                          className="h-3.5 w-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                        {t('settings.attachmentsMaxFiles')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.attachmentsMaxFilesDesc')}
                      </p>
                    </div>
                    <div className="shrink-0">
                      <Input
                        id="attachmentsMaxFiles"
                        type="number"
                        min={1}
                        max={10}
                        className="w-24"
                        {...attachmentsForm.register('maxFilesPerRequest', {
                          required: true,
                          valueAsNumber: true,
                          min: 1,
                          max: 10,
                        })}
                      />
                    </div>
                  </div>

                  {/* Allowed extensions */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="attachmentsExts"
                        required
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <FileText
                          className="h-3.5 w-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                        {t('settings.attachmentsAllowedExts')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.attachmentsAllowedExtsDesc')}
                      </p>
                    </div>
                    <div className="w-72 shrink-0">
                      <Input
                        id="attachmentsExts"
                        placeholder={attachmentsDefaults.allowedExtensions}
                        {...attachmentsForm.register('allowedExtensions', { required: true })}
                      />
                    </div>
                  </div>
                </div>

                <SaveButton
                  isPending={updateAttachments.isPending}
                  isSuccess={updateAttachments.isSuccess}
                  isDirty={attachmentsForm.formState.isDirty}
                  isError={updateAttachments.isError}
                  error={updateAttachments.error}
                  t={t}
                />
              </CardContent>
            </Card>
          </form>
        )}

        {/* Webhook section */}
        {activeTab === 'webhook' && (
          <form onSubmit={webhookForm.handleSubmit(onWebhookSubmit)}>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('settings.webhook')}</CardTitle>
                <CardDescription>{t('settings.webhookDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/50">
                  {/* Enabled toggle */}
                  <div className="flex items-center justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label className="flex items-center gap-1.5 text-sm font-medium">
                        <Bell className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('settings.webhookEnabled')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.webhookEnabledDesc')}
                      </p>
                    </div>
                    <Controller
                      name="enabled"
                      control={webhookForm.control}
                      render={({ field }) => (
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      )}
                    />
                  </div>

                  {/* Type selector */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label className="text-sm font-medium">{t('settings.webhookType')}</Label>
                    </div>
                    <div className="shrink-0">
                      <Controller
                        name="type"
                        control={webhookForm.control}
                        render={({ field }) => (
                          <ModePicker
                            value={field.value}
                            onChange={field.onChange}
                            options={[
                              { value: 'feishu', label: t('settings.webhookTypeFeishu') },
                              { value: 'custom', label: t('settings.webhookTypeCustom') },
                            ]}
                          />
                        )}
                      />
                    </div>
                  </div>

                  {/* Webhook URL */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label htmlFor="webhookUrl" className="text-sm font-medium">
                        {t('settings.webhookUrl')}
                      </Label>
                    </div>
                    <div className="w-[28rem] shrink-0">
                      <Controller
                        name="type"
                        control={webhookForm.control}
                        render={({ field: typeField }) => (
                          <Input
                            id="webhookUrl"
                            placeholder={
                              typeField.value === 'feishu'
                                ? t('settings.webhookUrlPlaceholder')
                                : t('settings.webhookCustomUrlPlaceholder')
                            }
                            {...webhookForm.register('url')}
                          />
                        )}
                      />
                    </div>
                  </div>

                  {/* Custom payload format */}
                  {webhookForm.watch('type') === 'custom' && (
                    <div className="flex items-start justify-between gap-8 px-6 py-5">
                      <div className="space-y-1 min-w-0 flex-1">
                        <Label className="text-sm font-medium">
                          {t('settings.webhookCustomPayload')}
                        </Label>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t('settings.webhookCustomPayloadDesc')}
                        </p>
                      </div>
                      <div className="w-[28rem] shrink-0">
                        <pre className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground overflow-auto">
                          {t('settings.webhookCustomPayloadExample')}
                        </pre>
                      </div>
                    </div>
                  )}

                  {/* Max retries */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label htmlFor="webhookMaxRetries" className="text-sm font-medium">
                        {t('settings.webhookMaxRetries')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.webhookMaxRetriesDesc')}
                      </p>
                    </div>
                    <div className="shrink-0">
                      <Input
                        id="webhookMaxRetries"
                        type="number"
                        min={3}
                        max={10}
                        className="w-24"
                        {...webhookForm.register('maxRetries', {
                          valueAsNumber: true,
                          min: 3,
                          max: 10,
                        })}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border/50">
                  {/* Test result feedback */}
                  <div className="flex items-center gap-1.5 text-sm">
                    {testWebhook.isPending && (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                    {testWebhook.isSuccess && testWebhook.data.data.ok && (
                      <Check className="h-3.5 w-3.5 text-green-500" aria-hidden="true" />
                    )}
                    {(testWebhook.isError ||
                      (testWebhook.isSuccess && !testWebhook.data.data.ok)) && (
                      <X className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                    )}
                    <span
                      className={
                        testWebhook.isSuccess && testWebhook.data.data.ok
                          ? 'text-green-500'
                          : testWebhook.isError ||
                              (testWebhook.isSuccess && !testWebhook.data.data.ok)
                            ? 'text-destructive'
                            : 'text-muted-foreground'
                      }
                    >
                      {testWebhook.isPending && t('settings.webhookTestSending')}
                      {testWebhook.isSuccess &&
                        testWebhook.data.data.ok &&
                        t('settings.webhookTestOk')}
                      {testWebhook.isSuccess &&
                        !testWebhook.data.data.ok &&
                        `${t('settings.webhookTestFail')}：${testWebhook.data.data.error ?? ''}`}
                      {testWebhook.isError &&
                        `${t('settings.webhookTestFail')}：${formatApiError(testWebhook.error, t)}`}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {updateWebhook.isError && (
                      <p className="text-sm text-destructive">
                        {t('settings.saveFailed')}：{formatApiError(updateWebhook.error, t)}
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={testWebhook.isPending || !webhookForm.watch('url')}
                      onClick={() => {
                        const { url, type } = webhookForm.getValues()
                        testWebhook.mutate({ url, type })
                      }}
                    >
                      {testWebhook.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : null}
                      {t('settings.webhookTest')}
                    </Button>
                    <Button
                      type="submit"
                      disabled={!webhookForm.formState.isDirty || updateWebhook.isPending}
                      className="gap-1.5"
                    >
                      {updateWebhook.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : updateWebhook.isSuccess && !webhookForm.formState.isDirty ? (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : null}
                      {updateWebhook.isPending
                        ? t('common.saving')
                        : updateWebhook.isSuccess && !webhookForm.formState.isDirty
                          ? t('common.saved')
                          : t('common.save')}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </form>
        )}

        {/* Branding section */}
        {activeTab === 'branding' && (
          <form onSubmit={brandingForm.handleSubmit(onBrandingSubmit)}>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('settings.branding')}</CardTitle>
                <CardDescription>{t('settings.brandingDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/50">
                  {/* Subtitle */}
                  <div className="flex items-start justify-between gap-8 px-6 py-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <Label
                        htmlFor="subtitle"
                        className="flex items-center gap-1.5 text-sm font-medium"
                      >
                        <Subtitles
                          className="h-3.5 w-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                        {t('settings.siteSubtitle')}
                      </Label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t('settings.siteSubtitleDesc')}
                      </p>
                    </div>
                    <div className="w-72 shrink-0">
                      <Input
                        id="subtitle"
                        placeholder={brandingDefaults.subtitle}
                        {...brandingForm.register('subtitle')}
                      />
                    </div>
                  </div>

                  {/* Favicon: upload only (remove restores the default icon) */}
                  <Controller
                    name="faviconUrl"
                    control={brandingForm.control}
                    render={({ field }) => {
                      const setFavicon = (url: string) => {
                        field.onChange(url)
                        brandingForm.trigger('faviconUrl')
                      }
                      return (
                        <div className="flex items-start justify-between gap-8 px-6 py-5">
                          <div className="space-y-1 min-w-0 flex-1">
                            <Label className="flex items-center gap-1.5 text-sm font-medium">
                              <Image
                                className="h-3.5 w-3.5 text-muted-foreground"
                                aria-hidden="true"
                              />
                              {t('settings.faviconUrl')}
                            </Label>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {t('settings.faviconUrlDesc')}
                            </p>
                          </div>

                          <div className="shrink-0 flex flex-col items-end">
                            <FaviconUpload
                              value={field.value}
                              onChange={setFavicon}
                              onRemove={() => setFavicon(DEFAULT_BRAND_ICON_URL)}
                            />
                          </div>
                        </div>
                      )
                    }}
                  />
                </div>

                <SaveButton
                  isPending={updateBranding.isPending}
                  isSuccess={updateBranding.isSuccess}
                  isDirty={brandingForm.formState.isDirty}
                  isError={updateBranding.isError}
                  error={updateBranding.error}
                  t={t}
                />
              </CardContent>
            </Card>
          </form>
        )}

        {/* Auth & Security section */}
        {activeTab === 'cli' && <CliTokensCard />}

        {activeTab === 'auth' && (
          <>
            {/* 登录方式配置（企业 SSO / OIDC / SAML；DB 为主 env 兜底，改完即时生效） */}
            <SsoMethodsCard />
            <form onSubmit={authForm.handleSubmit(onAuthSubmit)}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    {t('settings.auth.title')}
                  </CardTitle>
                  <CardDescription>{t('settings.auth.desc')}</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y divide-border/50">
                    {/* OAuth enabled */}
                    <div className="flex items-center justify-between gap-8 px-6 py-5">
                      <div className="space-y-1 min-w-0 flex-1">
                        <Label className="flex items-center gap-1.5 text-sm font-medium">
                          <Key className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                          {t('settings.auth.oauthEnabled')}
                        </Label>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t('settings.auth.oauthEnabledDesc')}
                        </p>
                      </div>
                      <Controller
                        name="oauthEnabled"
                        control={authForm.control}
                        render={({ field }) => (
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        )}
                      />
                    </div>

                    {/* Allowed email domains */}
                    <div className="flex items-start justify-between gap-8 px-6 py-5">
                      <div className="space-y-1 min-w-0 flex-1">
                        <Label
                          htmlFor="oauthAllowedEmailDomains"
                          className="flex items-center gap-1.5 text-sm font-medium"
                        >
                          <AtSign
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                          {t('settings.auth.oauthAllowedEmailDomains')}
                        </Label>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t('settings.auth.oauthAllowedEmailDomainsDesc')}
                        </p>
                      </div>
                      <div className="w-72 shrink-0">
                        <Input
                          id="oauthAllowedEmailDomains"
                          placeholder={t('settings.auth.oauthAllowedEmailDomainsPlaceholder')}
                          {...authForm.register('oauthAllowedEmailDomains')}
                        />
                      </div>
                    </div>

                    {/* Default role */}
                    <div className="flex items-start justify-between gap-8 px-6 py-5">
                      <div className="space-y-1 min-w-0 flex-1">
                        <Label className="flex items-center gap-1.5 text-sm font-medium">
                          <UserCog
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                          {t('settings.auth.oauthDefaultRole')}
                        </Label>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t('settings.auth.oauthDefaultRoleDesc')}
                        </p>
                      </div>
                      <div className="shrink-0">
                        <Controller
                          name="oauthDefaultRole"
                          control={authForm.control}
                          render={({ field }) => (
                            <ModePicker
                              value={field.value}
                              onChange={field.onChange}
                              options={[
                                {
                                  value: 'user',
                                  label: t('settings.auth.oauthDefaultRoleUser'),
                                },
                                {
                                  value: 'admin',
                                  label: t('settings.auth.oauthDefaultRoleAdmin'),
                                },
                              ]}
                            />
                          )}
                        />
                      </div>
                    </div>

                    {/* Auto provision */}
                    <div className="flex items-center justify-between gap-8 px-6 py-5">
                      <div className="space-y-1 min-w-0 flex-1">
                        <Label className="flex items-center gap-1.5 text-sm font-medium">
                          <UserPlus
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                          {t('settings.auth.oauthAutoProvision')}
                        </Label>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t('settings.auth.oauthAutoProvisionDesc')}
                        </p>
                      </div>
                      <Controller
                        name="oauthAutoProvision"
                        control={authForm.control}
                        render={({ field }) => (
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        )}
                      />
                    </div>

                    {/* Password login enabled — last + warning */}
                    <div className="flex items-center justify-between gap-8 px-6 py-5">
                      <div className="space-y-1 min-w-0 flex-1">
                        <Label className="flex items-center gap-1.5 text-sm font-medium">
                          <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                          {t('settings.auth.passwordLoginEnabled')}
                        </Label>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t('settings.auth.passwordLoginEnabledDesc')}
                        </p>
                        {!authForm.watch('passwordLoginEnabled') && (
                          <p className="mt-2 text-xs leading-relaxed text-warning">
                            {t('settings.auth.lockdownWarning')}
                          </p>
                        )}
                        {authForm.formState.errors.passwordLoginEnabled && (
                          <p className="text-xs text-destructive mt-1">
                            {authForm.formState.errors.passwordLoginEnabled.message}
                          </p>
                        )}
                      </div>
                      <Controller
                        name="passwordLoginEnabled"
                        control={authForm.control}
                        render={({ field }) => (
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        )}
                      />
                    </div>
                  </div>

                  <SaveButton
                    isPending={updateAuth.isPending}
                    isSuccess={updateAuth.isSuccess}
                    isDirty={authForm.formState.isDirty}
                    isError={updateAuth.isError}
                    error={updateAuth.error}
                    t={t}
                  />
                </CardContent>
              </Card>
            </form>
          </>
        )}
      </div>
      {/* /content column */}

      {/* Lockdown confirm dialog */}
      <AlertDialog
        open={pendingDisablePassword !== null}
        onOpenChange={(open) => !open && setPendingDisablePassword(null)}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t('settings.auth.lockdownConfirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('settings.auth.lockdownConfirmContent')}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setPendingDisablePassword(null)}>
              {t('settings.auth.lockdownConfirmCancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDisablePassword) {
                  submitAuth(pendingDisablePassword)
                  setPendingDisablePassword(null)
                }
              }}
            >
              {t('settings.auth.lockdownConfirmOk')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
