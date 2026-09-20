import {
  ATTACHMENT_ALL_EXTS,
  ATTACHMENT_MAX_FILE_SIZE_BYTES,
  ATTACHMENT_MAX_FILES,
  type OtelStatus,
  type OtelTestResult,
  type SettingsMap,
  type UpdateSettingsInput,
} from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { message } from '@/lib/antd-static'
import { api } from '@/lib/api'

const SETTINGS_KEY = ['settings'] as const

// ─────────────────────────────────────────────────────────────
// SSO 登录方式（设置 → 企业登录 → 登录方式面板）
// ─────────────────────────────────────────────────────────────
export type SsoConfigSource = 'settings' | 'env' | null

export interface SsoStatus {
  oidc: {
    configured: boolean
    enabled: boolean
    source: SsoConfigSource
    issuer: string | null
    clientId: string | null
    scopes: string | null
    clientSecretSet: boolean
    redirectUri: string
    callbackOrigin: string
  }
  saml: {
    configured: boolean
    enabled: boolean
    source: SsoConfigSource
    entryPoint: string | null
    spEntityId: string | null
    certPresent: boolean
    acsUrl: string
    metadataUrl: string
    callbackOrigin: string
  }
}

export interface SsoTestResult {
  ok: boolean
  /** 稳定的失败原因码（客户端据此 i18n）；旧响应可能只有 error。 */
  reason?: string
  /** REDIRECT_URI_REJECTED 等需要插值的上下文（status / idpError / redirectUri）。 */
  reasonContext?: Record<string, unknown>
  /** 非可本地化的原始错误文本（运行时异常）；有 reason 时优先用 reason。 */
  error?: string
  detail?: Record<string, unknown>
}

const SSO_STATUS_KEY = ['settings', 'sso', 'status'] as const

/** 两种 SSO 登录方式的生效状态（admin；含 IdP 侧注册地址）。 */
export function useSsoStatus(enabled = true) {
  return useQuery({
    queryKey: SSO_STATUS_KEY,
    queryFn: () => api.get<SsoStatus>('/settings/sso/status').then((r) => r.data),
    enabled,
  })
}

/** 测试某种 SSO 登录方式的当前生效配置（OIDC discovery / SAML 证书）。 */
export function useSsoTest() {
  return useMutation({
    mutationFn: (type: 'oidc' | 'saml') =>
      api.post<SsoTestResult>('/settings/sso/test', { type }).then((r) => r.data),
  })
}

/** 管理员可配的附件上限（前端预校验用），从 settings.attachments 读取，拿不到回退 shared 默认。 */
export interface AttachmentConfig {
  maxFileSizeBytes: number
  maxFilesPerRequest: number
  allowedExtensions: string[]
}

const ATTACHMENT_CONFIG_DEFAULT: AttachmentConfig = {
  maxFileSizeBytes: ATTACHMENT_MAX_FILE_SIZE_BYTES,
  maxFilesPerRequest: ATTACHMENT_MAX_FILES,
  allowedExtensions: [...ATTACHMENT_ALL_EXTS],
}

/**
 * 读取当前生效的附件上限，驱动测试抽屉的 accept / 预校验，与后端动态配置保持一致。
 * 端点仅需登录（非 admin），只返回非敏感的大小/数量/类型。拿不到时回退编译期默认。
 */
export function useAttachmentConfig(): AttachmentConfig {
  const { data } = useQuery({
    queryKey: [...SETTINGS_KEY, 'attachments'],
    queryFn: () => api.get<Record<string, string>>('/settings/attachments'),
    select: (res) => res.data,
    staleTime: 60_000,
  })
  if (!data) return ATTACHMENT_CONFIG_DEFAULT
  const size = Number(data.maxFileSizeBytes)
  const count = Number(data.maxFilesPerRequest)
  const exts = (data.allowedExtensions ?? '')
    .split(',')
    .map((e) => e.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean)
  return {
    maxFileSizeBytes:
      Number.isFinite(size) && size > 0 ? size : ATTACHMENT_CONFIG_DEFAULT.maxFileSizeBytes,
    maxFilesPerRequest:
      Number.isFinite(count) && count > 0 ? count : ATTACHMENT_CONFIG_DEFAULT.maxFilesPerRequest,
    allowedExtensions: exts.length > 0 ? exts : ATTACHMENT_CONFIG_DEFAULT.allowedExtensions,
  }
}

/**
 * Agent 创建模板的 Provider 预填配置（settings.templates，非 admin 也可读）。
 * 企业部署配置内部 LLM 网关后，新手/网页应用模板恢复「只粘一个 key」的预填体验。
 */
export function useTemplatePresetSettings() {
  return useQuery({
    queryKey: [...SETTINGS_KEY, 'templates'],
    queryFn: () =>
      api.get<{ providerBaseUrl?: string; providerModel?: string }>('/settings/templates'),
    select: (res) => res.data,
    staleTime: 1000 * 60 * 5,
  })
}

export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api.get<SettingsMap>('/settings'),
    select: (res) => res.data,
  })
}

/** The settings response envelope, which carries per-key versions in `meta`. */
type SettingsResponse = { data: SettingsMap; meta?: { versions?: Record<string, string> } }

/**
 * Per-key write versions, read from the cache at CALL time rather than captured
 * during render: two saves dispatched from the same React commit would otherwise
 * both send the pre-write map, and the second would conflict with the first.
 */
function readSettingsVersions(
  qc: ReturnType<typeof useQueryClient>,
): Record<string, string> | undefined {
  return qc.getQueryData<SettingsResponse>(SETTINGS_KEY)?.meta?.versions
}

/** The single way to write settings, so no caller can silently opt out. */
function patchSettings(input: UpdateSettingsInput, versions: Record<string, string> | undefined) {
  return api.patch<SettingsMap>('/settings', {
    ...input,
    ...(versions ? { expectedVersions: versions } : {}),
  })
}

/**
 * Write the response straight into the cache instead of invalidating and awaiting
 * a refetch, closing the window where a follow-up save reuses the pre-write map.
 */
function syncSettingsCache(qc: ReturnType<typeof useQueryClient>, res: SettingsResponse) {
  qc.setQueryData(SETTINGS_KEY, res)
  // setQueryData does not mark descendants stale, and `['settings', ...]` has
  // derived sub-queries with long staleTimes. Scoped by predicate so the exact key
  // is not refetched away.
  qc.invalidateQueries({
    predicate: (query) =>
      query.queryKey.length > SETTINGS_KEY.length && query.queryKey[0] === SETTINGS_KEY[0],
  })
}

export function useUpdateSettings() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  // Mount the settings query so the versions map is guaranteed fetched; reading
  // the cache alone would silently degrade the write to last-write-wins on a miss.
  useSettings()
  return useMutation({
    // 本地已处理错误提示，避免 main.tsx 的全局 MutationCache 再弹一次（双 toast）。
    meta: { handleLocally: true },
    mutationFn: (input: UpdateSettingsInput) => patchSettings(input, readSettingsVersions(qc)),
    onSuccess: (res) => {
      syncSettingsCache(qc, res as SettingsResponse)
      message.success(t('common.saved'))
    },
    // Refetch on failure so a 409 does not wedge: without it every retry resends
    // the same stale map, and the only escape (reloading) destroys the edit.
    onError: () => {
      qc.invalidateQueries({ queryKey: SETTINGS_KEY })
    },
    // No error toast: every caller renders the failure inline via `SaveButton`,
    // which formats the actual code. A toast here would repeat that with strictly
    // less information — it only ever said "save failed".
  })
}

/**
 * SSO 配置专用更新：PATCH 后失效 sso status/raw（让状态徽标与表单即时刷新）。
 * 与通用 useUpdateSettings 分开，使「保存」与「启用开关切换」各有独立的 pending 态，
 * 互不干扰 —— 切开关不会让保存按钮转圈。
 */
export function useUpdateSso() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  // See useUpdateSettings: keeps the versions map loaded rather than hoping it is.
  useSettings()
  return useMutation({
    // 本地已处理错误提示，避免 main.tsx 的全局 MutationCache 再弹一次（双 toast）。
    meta: { handleLocally: true },
    mutationFn: (input: UpdateSettingsInput) => patchSettings(input, readSettingsVersions(qc)),
    onSuccess: (res) => {
      syncSettingsCache(qc, res as SettingsResponse)
      qc.invalidateQueries({ queryKey: SSO_STATUS_KEY })
      qc.invalidateQueries({ queryKey: ['settings', 'sso', 'raw'] })
      message.success(t('common.saved'))
    },
    onError: () => {
      message.error(t('settings.saveFailed'))
    },
  })
}

// ─────────────────────────────────────────────────────────────
// OpenTelemetry trace export (Settings → Observability)
// ─────────────────────────────────────────────────────────────
const OTEL_STATUS_KEY = ['settings', 'otel', 'status'] as const

/** Export config + this API instance's exporter health (admin; never carries header values). */
export function useOtelStatus(enabled = true) {
  return useQuery({
    queryKey: OTEL_STATUS_KEY,
    queryFn: () => api.get<OtelStatus>('/settings/otel/status').then((r) => r.data),
    enabled,
  })
}

/** Sends one test span to the SAVED endpoint; the verdict is in `ok`, never an HTTP error. */
export function useOtelTest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<OtelTestResult>('/settings/otel/test', {}).then((r) => r.data),
    onSettled: () => qc.invalidateQueries({ queryKey: OTEL_STATUS_KEY }),
  })
}

/** PATCH the `otel` section; separate from useUpdateSettings so its pending state is its own. */
export function useUpdateOtel() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  // See useUpdateSettings: keeps the versions map loaded rather than hoping it is.
  useSettings()
  return useMutation({
    meta: { handleLocally: true },
    mutationFn: (otel: Record<string, string>) => patchSettings({ otel }, readSettingsVersions(qc)),
    onSuccess: (res) => {
      syncSettingsCache(qc, res as SettingsResponse)
      qc.invalidateQueries({ queryKey: OTEL_STATUS_KEY })
      message.success(t('common.saved'))
    },
    onError: () => {
      message.error(t('settings.saveFailed'))
    },
  })
}
