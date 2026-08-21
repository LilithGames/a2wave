/**
 * 登录方式配置卡片（设置 → 企业登录）：OIDC / SAML 两种方式。
 *
 * 配置真源 DB（本卡片保存的即 settings.sso.*）> env 兜底；改完即时生效（无需重启）。
 * 视觉沿用设置页语言：Card + 行式 divide-y + 设计 token。
 *
 * client_secret 只在用户输入时随 PATCH 提交（明文，服务端加密）；读接口不回明文，
 * 占位符按 clientSecretSet 提示「已设置（留空保持不变）」。
 */

import { useQuery } from '@tanstack/react-query'
import { Check, Copy, Globe, KeyRound, Loader2, ShieldHalf, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  type SsoStatus,
  type SsoTestResult,
  useSsoStatus,
  useSsoTest,
  useUpdateSso,
} from '@/hooks/use-settings'
import { api } from '@/lib/api'
import {
  buildOidcConfig,
  buildSamlConfig,
  type OidcFormValues,
  parseOidcConfig,
  parseSamlConfig,
  type SamlFormValues,
} from '@/lib/sso-config-form'

type MethodKey = 'oidc' | 'saml'

/** settings.sso 原始 JSON 值（表单预填用）——从 GET /settings/sso 读取（含 admin 敏感键）。 */
function useSsoRawSettings() {
  return useQuery({
    queryKey: ['settings', 'sso', 'raw'],
    queryFn: () => api.get<Record<string, string>>('/settings/sso').then((r) => r.data),
  })
}

/** 只读复制字段：常规「标题 + 内容」布局（无边框），内容为等宽值 + 右侧复制按钮。 */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard 无权限时静默
    }
  }
  return (
    <div>
      <Label className="text-sm font-medium">{label}</Label>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{value}</span>
        <button
          type="button"
          onClick={onCopy}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          aria-label="copy"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  )
}

/**
 * 回调地址字段：origin 可编辑，路径固定。
 *
 * 为什么不让用户整条编辑：路径由代码写死（/api/auth/oidc/callback 与 /api/auth/saml/acs），
 * 可变的只有「部署在哪个 IP / 域名」。
 * 把不可变的部分做成后缀展示，用户改不坏它，也一眼看清最终要登记给 IdP 的完整地址。
 *
 * 留空 = 回落各自的默认 origin，此时输入框以该 origin 作 placeholder，
 * 并把完整回调地址显示在下方供复制。
 *
 * 两条回调路径都由 API 提供（/api/auth/oidc/callback、/api/auth/saml/acs），dev 双端口下
 * 一律填 API 端口——文案里点明这一点，否则只能靠试错。
 */
function CallbackUrlField({
  value,
  onChange,
  path,
  effectiveUrl,
  hint,
}: {
  value: string
  onChange: (next: string) => void
  path: string
  effectiveUrl: string
  hint: string
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  // 留空时服务端按 publicBaseUrl 拼回调，placeholder 如实反映那个值。
  const fallbackOrigin = effectiveUrl.endsWith(path)
    ? effectiveUrl.slice(0, -path.length)
    : effectiveUrl
  // 用户填了 origin 就按它预览，否则按上面的回落 origin 拼出实际生效地址。
  const preview = value.trim()
    ? `${value.trim().replace(/\/$/, '')}${path}`
    : `${fallbackOrigin}${path}`

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(preview)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard 无权限时静默
    }
  }

  return (
    <Field
      label={t('settings.sso.field.callbackUrl')}
      hint={`${t('settings.sso.field.servedBy.api')} ${hint}`}
    >
      <div className="flex items-center gap-2">
        <Input
          className="flex-1 font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={fallbackOrigin}
          aria-label={t('settings.sso.field.callbackOriginAria')}
        />
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{path}</span>
        <button
          type="button"
          onClick={onCopy}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          aria-label="copy"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">{preview}</p>
    </Field>
  )
}

/**
 * 状态徽标：tab 里只用两种安静的颜色——灰（未配置 / 已停用）与绿（已启用）。
 * 琥珀等警示色一律不进 tab；「缺登录入口」这类细化状态在面板内用提示条说明。
 */
function StatusBadge({ configured, enabled }: { configured: boolean; enabled: boolean }) {
  const { t } = useTranslation()
  if (!configured || !enabled) {
    return (
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/50" />
        {t(configured ? 'settings.sso.badgeDisabled' : 'settings.sso.badgeUnconfigured')}
      </span>
    )
  }
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
      <span className="size-1.5 rounded-full bg-success" />
      {t('settings.sso.badgeEnabled')}
    </span>
  )
}

/**
 * 富卡片式方式选择：基于通用 Tabs 的 TabsTrigger，选中态由 data-[state=active] 驱动，
 * 承载「图标 + 标题 + 状态徽标」。选中态用 primary 描边 + 浅底，无需手写 state / 接缝对齐。
 */
function MethodTab({
  value,
  icon,
  title,
  configured,
  enabled,
}: {
  value: MethodKey
  icon: ReactNode
  title: string
  configured: boolean
  enabled: boolean
}) {
  return (
    <TabsTrigger
      value={value}
      className="group flex h-auto flex-col items-stretch gap-2 rounded-lg border border-border bg-card p-3 text-left transition-all hover:border-primary/40 hover:bg-surface-hover data-[state=active]:border-primary data-[state=active]:bg-primary/[0.06] data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-primary/15"
    >
      <span className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground transition-colors group-data-[state=active]:bg-primary/10 group-data-[state=active]:text-interactive-foreground">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
      </span>
      <StatusBadge configured={configured} enabled={enabled} />
    </TabsTrigger>
  )
}

/**
 * 测试通过时的摘要：优先展示需要去 IdP 侧登记的地址（回调 / ACS / EntityID），
 * 其次才是 issuer / entryPoint —— 让「测试通过」同时告诉用户下一步要注册什么。
 */
function summarizeTestDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return ''
  const picked = ['redirectUri', 'acsUrl', 'spEntityId', 'issuer', 'entryPoint']
    .map((k) => detail[k])
    .filter((v): v is string => typeof v === 'string' && !!v)
    .slice(0, 2)
  return picked.length ? ` · ${picked.join(' · ')}` : ''
}

type TFn = ReturnType<typeof useTranslation>['t']

/**
 * SSO 测试失败文案：优先按稳定 reason 码本地化（含 REDIRECT_URI_REJECTED 的上下文插值），
 * 缺 reason 时回落原始 error 文本（运行时异常/旧响应），都没有则通用「测试失败」。
 */
function describeTestError(t: TFn, data: SsoTestResult): string {
  if (data.reason === 'REDIRECT_URI_REJECTED') {
    const ctx = data.reasonContext ?? {}
    const status = typeof ctx.status === 'number' ? ctx.status : ''
    const idpError = typeof ctx.idpError === 'string' ? ctx.idpError : ''
    const redirectUri = typeof ctx.redirectUri === 'string' ? ctx.redirectUri : ''
    return t('settings.sso.testErr.redirectUriRejected', {
      status,
      idpError: idpError ? `，${idpError}` : '',
      redirectUri,
    })
  }
  if (data.reason && data.reason !== 'TEST_EXCEPTION') {
    // OIDC_NOT_CONFIGURED / SAML_NOT_CONFIGURED / JWT_REDIRECT_NOT_CONFIGURED
    return t(`settings.sso.testErr.${data.reason}`, { defaultValue: data.reason })
  }
  return data.error ?? t('settings.sso.testFail')
}

/**
 * 底部操作行：启用开关（已配置时）+ 来源提示 + 测试结果 + 测试/清除/保存。
 * 清除配置不可逆，走二次确认。
 */
function PanelActions({
  method,
  configured,
  enabled,
  source,
  onSave,
  onClear,
  onToggleEnabled,
  saving,
}: {
  method: 'oidc' | 'saml'
  configured: boolean
  enabled: boolean
  source: SsoStatus[MethodKey]['source']
  onSave: () => void
  onClear: () => void
  onToggleEnabled: (next: boolean) => void
  saving: boolean
}) {
  const { t } = useTranslation()
  const test = useSsoTest()
  const [confirmClear, setConfirmClear] = useState(false)
  return (
    <div className="mt-5 space-y-3">
      {/* 启用开关：仅配置存在时显示；env 来源不可切（改 env 需重启）。顶部一条分隔线，无外框 */}
      {configured && (
        <div className="flex items-center justify-between gap-4 border-t border-border/50 pt-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              {t('settings.sso.enableLabel')}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {source === 'env' ? t('settings.sso.enableEnvHint') : t('settings.sso.enableHint')}
            </p>
            {/* 这个开关只管登录入口。OAuth 发布渠道刻意与它解耦（否则关掉登录会同时
                打断所有已发布 Agent 的对外集成），但不写出来管理员无从知道。 */}
            {method === 'oidc' && !enabled && (
              <p className="mt-1 text-xs text-warning">
                {t('settings.sso.oidcDisabledChannelNote')}
              </p>
            )}
          </div>
          <Switch checked={enabled} disabled={source === 'env'} onCheckedChange={onToggleEnabled} />
        </div>
      )}
      {source === 'env' && (
        <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t('settings.sso.envSourceHint')}
        </p>
      )}
      {test.data && (
        <div
          className={`flex items-start gap-1.5 text-xs ${test.data.ok ? 'text-success' : 'text-destructive'}`}
        >
          {test.data.ok ? (
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 break-words">
            {test.data.ok
              ? `${t('settings.sso.testOk')}${summarizeTestDetail(test.data.detail)}`
              : `${t('settings.sso.testFail')}：${describeTestError(t, test.data)}`}
          </span>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mr-auto text-muted-foreground hover:text-destructive"
          onClick={() => setConfirmClear(true)}
        >
          {t('settings.sso.clear')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={test.isPending}
          onClick={() => test.mutate(method)}
          className="relative"
        >
          {/* spinner 绝对定位覆盖在左侧，不占布局流：文字始终居中，pending 与否宽度不变、不闪 */}
          {test.isPending && (
            <Loader2 className="absolute left-3 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          )}
          {t('settings.sso.test')}
        </Button>
        <Button type="button" size="sm" disabled={saving} onClick={onSave} className="relative">
          {saving && (
            <Loader2 className="absolute left-3 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          )}
          {t('common.save')}
        </Button>
      </div>

      {/* 清除配置二次确认（不可逆：删除整份配置，将回落到环境变量） */}
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogTitle>{t('settings.sso.clearConfirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('settings.sso.clearConfirmContent')}</AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onClear()
                setConfirmClear(false)
              }}
            >
              {t('settings.sso.clearConfirmOk')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * 字段：标题 + 一句描述 + 控件。用 flex-col 让控件贴底对齐——
 * 并排两列即使一侧无描述，用 ` ` 占位撑高，两列输入框始终顶对齐。
 */
function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex h-full flex-col">
      <Label className="text-sm font-medium" required={required}>
        {label}
      </Label>
      <p className="mt-1 min-h-4 text-xs leading-relaxed text-muted-foreground">{hint ?? ' '}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

const SSO_METHOD_KEYS: MethodKey[] = ['oidc', 'saml']
const SSO_METHOD_PARAM = 'ssoMethod'

export function SsoMethodsCard() {
  const { t } = useTranslation()
  const statusQuery = useSsoStatus()
  const settingsQuery = useSsoRawSettings()
  // 保存/清除 与 启用开关切换 用独立 mutation 实例：各自的 pending 态互不干扰，
  // 切开关不会让「保存」按钮转圈。两者成功后都会失效 sso status/raw 使状态即时刷新。
  const saveUpdate = useUpdateSso()
  const toggleUpdate = useUpdateSso()
  // 选中方式走 URL query（?ssoMethod=oidc）：可分享 / 刷新保持 / 浏览器回退可用
  const [searchParams, setSearchParams] = useSearchParams()
  const methodParam = searchParams.get(SSO_METHOD_PARAM)
  const activeMethod: MethodKey = SSO_METHOD_KEYS.includes(methodParam as MethodKey)
    ? (methodParam as MethodKey)
    : 'oidc'
  const [saveError, setSaveError] = useState<{ method: MethodKey; message: string } | null>(null)

  const [oidcForm, setOidcForm] = useState<OidcFormValues>(parseOidcConfig(undefined))
  const [samlForm, setSamlForm] = useState<SamlFormValues>(parseSamlConfig(undefined))
  const [oidcSecret, setOidcSecret] = useState('')

  const sso = settingsQuery.data
  // 只在**首次**拿到 DB 原值时回填一次表单。此后表单归用户所有——
  // 保存/切开关/清除都会失效并重拉 raw 查询，若每次都回填会把其他 tab 里
  // 未保存的输入静默清空。ref 守卫确保回填只发生一次。
  const backfilledRef = useRef(false)
  useEffect(() => {
    if (!sso || backfilledRef.current) return
    backfilledRef.current = true
    setOidcForm(parseOidcConfig(sso.oidcConfig))
    setSamlForm(parseSamlConfig(sso.samlConfig))
  }, [sso])

  const status = statusQuery.data
  // Tabs 受控：切换方式写入 URL query（replace 不堆历史），并清掉上一个方式的保存错误
  const selectMethod = (k: string) => {
    setSaveError(null)
    setSearchParams(
      (cur) => {
        const next = new URLSearchParams(cur)
        next.set(SSO_METHOD_PARAM, k)
        return next
      },
      { replace: true },
    )
  }

  // 保存 / 清除走 saveUpdate（驱动「保存」按钮 loading）
  const patchSso = (patch: Record<string, string>) => saveUpdate.mutate({ sso: patch })

  // 保存表单时保留各方式当前的 enabled 值（开关未动时不误改启用态）
  const saveOidc = () => {
    const built = buildOidcConfig(oidcForm, status?.oidc.enabled ?? true)
    if (!built.ok) {
      setSaveError({ method: 'oidc', message: t(`settings.sso.err.${built.error}`) })
      return
    }
    setSaveError(null)
    const patch: Record<string, string> = { oidcConfig: built.value }
    // secret 仅在用户输入时提交（明文，服务端加密）；留空 = 保持现有密文不变
    if (oidcSecret) patch.oidcClientSecret = oidcSecret
    patchSso(patch)
    setOidcSecret('')
  }
  const saveSaml = () => {
    const built = buildSamlConfig(samlForm, status?.saml.enabled ?? true)
    if (!built.ok) {
      setSaveError({ method: 'saml', message: t(`settings.sso.err.${built.error}`) })
      return
    }
    setSaveError(null)
    patchSso({ samlConfig: built.value })
  }

  /**
   * 切换某方式的启用态：用当前表单值重新 build 配置、覆盖 enabled 后 PATCH。
   * 仅在配置已存在时可切（未配置时开关不显示）。表单值缺字段会 build 失败——
   * 但已配置意味着 DB 有完整配置，表单已从 DB 回填，故 build 必成功。
   */
  const toggleEnabled = (method: MethodKey, next: boolean) => {
    setSaveError(null)
    // 走独立的 toggleUpdate，不触发「保存」按钮 loading
    if (method === 'oidc') {
      const built = buildOidcConfig(oidcForm, next)
      if (built.ok) toggleUpdate.mutate({ sso: { oidcConfig: built.value } })
    } else {
      const built = buildSamlConfig(samlForm, next)
      if (built.ok) toggleUpdate.mutate({ sso: { samlConfig: built.value } })
    }
  }

  const errFor = (m: MethodKey) =>
    saveError?.method === m ? <p className="text-xs text-destructive">{saveError.message}</p> : null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('settings.sso.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {statusQuery.isLoading || !status ? (
          <div className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('settings.sso.loading')}
          </div>
        ) : (
          // 页签头 + 表单同处一个外框，天然连体（无双盒 / 无接缝间隙）
          <Tabs
            value={activeMethod}
            onValueChange={selectMethod}
            className="mx-6 mb-6 mt-1 overflow-hidden rounded-xl border border-border"
          >
            {/* 页签头：一排三张富卡片，底部一条淡分隔线接向表单 */}
            <TabsList className="grid h-auto grid-cols-1 items-stretch gap-2.5 rounded-none border-b border-border/60 bg-muted/[0.25] p-3 sm:grid-cols-2">
              <MethodTab
                value="oidc"
                icon={<Globe className="h-4 w-4" />}
                title={t('settings.sso.oidc')}
                configured={status.oidc.configured}
                enabled={status.oidc.enabled}
              />
              <MethodTab
                value="saml"
                icon={<ShieldHalf className="h-4 w-4" />}
                title={t('settings.sso.saml')}
                configured={status.saml.configured}
                enabled={status.saml.enabled}
              />
            </TabsList>

            {/* 表单区：在外框内，无独立边框 */}
            <TabsContent value="oidc" className="mt-0 px-5 py-5">
              <div className="space-y-4">
                <Field
                  label={t('settings.sso.field.oidcIssuer')}
                  required
                  hint={t('settings.sso.field.oidcIssuerHint')}
                >
                  <Input
                    value={oidcForm.issuer}
                    onChange={(e) => setOidcForm({ ...oidcForm, issuer: e.target.value })}
                    placeholder="https://login.example.com/realms/acme"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field
                    label={t('settings.sso.field.clientId')}
                    required
                    hint={t('settings.sso.field.clientIdHint')}
                  >
                    <Input
                      value={oidcForm.clientId}
                      onChange={(e) => setOidcForm({ ...oidcForm, clientId: e.target.value })}
                    />
                  </Field>
                  <Field
                    label={t('settings.sso.field.scopes')}
                    hint={t('settings.sso.field.scopesHint')}
                  >
                    <Input
                      value={oidcForm.scopes}
                      onChange={(e) => setOidcForm({ ...oidcForm, scopes: e.target.value })}
                      placeholder="openid profile email"
                    />
                  </Field>
                </div>
                <Field
                  label={t('settings.sso.field.channelAudiences')}
                  hint={t('settings.sso.field.channelAudiencesHint')}
                >
                  <Input
                    value={oidcForm.channelAudiences}
                    onChange={(e) => setOidcForm({ ...oidcForm, channelAudiences: e.target.value })}
                    placeholder="partner-service, data-platform"
                  />
                </Field>
                <Field
                  label={t('settings.sso.field.clientSecret')}
                  hint={t('settings.sso.field.clientSecretHint')}
                >
                  <Input
                    type="password"
                    value={oidcSecret}
                    onChange={(e) => setOidcSecret(e.target.value)}
                    placeholder={
                      status.oidc.clientSecretSet
                        ? t('settings.sso.field.clientSecretSet')
                        : t('settings.sso.field.clientSecretPublic')
                    }
                  />
                </Field>
                <CallbackUrlField
                  value={oidcForm.callbackOrigin}
                  onChange={(callbackOrigin) => setOidcForm({ ...oidcForm, callbackOrigin })}
                  path="/api/auth/oidc/callback"
                  effectiveUrl={status.oidc.redirectUri}
                  hint={t('settings.sso.field.redirectUriHint')}
                />
                {errFor('oidc')}
                <PanelActions
                  method="oidc"
                  configured={status.oidc.configured}
                  enabled={status.oidc.enabled}
                  source={status.oidc.source}
                  onSave={saveOidc}
                  onClear={() => patchSso({ oidcConfig: '', oidcClientSecret: '' })}
                  onToggleEnabled={(next) => toggleEnabled('oidc', next)}
                  saving={saveUpdate.isPending}
                />
              </div>
            </TabsContent>

            <TabsContent value="saml" className="mt-0 px-5 py-5">
              <div className="space-y-4">
                <Field
                  label={t('settings.sso.field.entryPoint')}
                  required
                  hint={t('settings.sso.field.entryPointHint')}
                >
                  <Input
                    value={samlForm.entryPoint}
                    onChange={(e) => setSamlForm({ ...samlForm, entryPoint: e.target.value })}
                    placeholder="https://idp.example.com/sso/saml"
                  />
                </Field>
                <Field
                  label={t('settings.sso.field.spEntityId')}
                  hint={t('settings.sso.field.spEntityIdHint')}
                >
                  <Input
                    value={samlForm.spEntityId}
                    onChange={(e) => setSamlForm({ ...samlForm, spEntityId: e.target.value })}
                    placeholder={status.saml.metadataUrl}
                  />
                </Field>
                <Field
                  label={t('settings.sso.field.idpCert')}
                  required
                  hint={t('settings.sso.field.idpCertHint')}
                >
                  <Textarea
                    rows={5}
                    className="font-mono text-xs"
                    value={samlForm.idpCert}
                    onChange={(e) => setSamlForm({ ...samlForm, idpCert: e.target.value })}
                    placeholder="-----BEGIN CERTIFICATE-----&#10;..."
                  />
                </Field>
                <CallbackUrlField
                  value={samlForm.callbackOrigin}
                  onChange={(callbackOrigin) => setSamlForm({ ...samlForm, callbackOrigin })}
                  path="/api/auth/saml/acs"
                  effectiveUrl={status.saml.acsUrl}
                  hint={t('settings.sso.field.acsUrlHint')}
                />
                {/* SP 元数据地址与 ACS 同源，随上面的 origin 一起变，无需单独编辑。 */}
                <CopyField
                  label={t('settings.sso.field.metadataUrl')}
                  value={status.saml.metadataUrl}
                />
                {errFor('saml')}
                <PanelActions
                  method="saml"
                  configured={status.saml.configured}
                  enabled={status.saml.enabled}
                  source={status.saml.source}
                  onSave={saveSaml}
                  onClear={() => patchSso({ samlConfig: '' })}
                  onToggleEnabled={(next) => toggleEnabled('saml', next)}
                  saving={saveUpdate.isPending}
                />
              </div>
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  )
}
