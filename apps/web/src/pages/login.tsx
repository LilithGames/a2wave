import type { InputRef } from 'antd'
import { Input } from 'antd'
import { Loader2, Waves } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import oidcIconUrl from '@/assets/sso-icons/oidc.svg'
import samlIconUrl from '@/assets/sso-icons/saml.svg'
import { BrandWaveField } from '@/components/brand-wave-field'
import { Button } from '@/components/ui/button'
import { type SsoLoginMethod, useAuthStatus, useLogin, useOauthConfig } from '@/hooks/use-auth'
import { useVersion } from '@/hooks/use-version'
import { formatApiError } from '@/lib/api-error'

/**
 * 'login'（默认）换 a2wave 登录态；'bind' 把 SSO 身份钉到当前用户；
 * 'share' 只验证 SSO 身份放行分享页，不建/不碰 a2wave 用户。
 * 三者都由服务端 OIDC/SAML 回调分发（作为 loginUrl 的 query 参数下发）。
 */
export type SsoPurpose = 'login' | 'bind' | 'share'

/**
 * Validate a post-login redirect target.
 *
 * Only same-origin absolute paths are allowed. `//host` and `/\host` are rejected
 * because browsers resolve both as protocol-relative external URLs, which would
 * turn the login page into an open redirect.
 */
export function safeReturnTo(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/')) return null
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null
  // Prefix checks alone are not enough: the URL parser strips leading control
  // characters, so `/\t/evil.example` resolves to `https://evil.example/` — an
  // external redirect that passes every string test above. Resolve against a
  // throwaway origin and require the result to still be same-origin.
  try {
    const probeOrigin = 'https://a2wave.invalid'
    const resolved = new URL(raw, probeOrigin)
    if (resolved.origin !== probeOrigin) return null
    // The prefix checks above run BEFORE parsing, and the parser applies
    // dot-segment normalisation: `/.//evil.com` and `/%2e%2e//evil.com` both
    // resolve to the protocol-relative `//evil.com`, which would break this
    // function's own same-origin-path contract.
    if (resolved.pathname.startsWith('//')) return null
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return null
  }
}

/** 各方式的完整标签（单方式时用横向大按钮）与短标签（多方式并排时用）。 */
const SSO_METHOD_LABEL_KEY: Record<SsoLoginMethod['type'], string> = {
  oidc: 'auth.oidcLogin',
  saml: 'auth.samlLogin',
}
const SSO_METHOD_SHORT_KEY: Record<SsoLoginMethod['type'], string> = {
  oidc: 'auth.oidcLoginShort',
  saml: 'auth.samlLoginShort',
}
/** Brand logos for the standardized protocols (original colors). */
const SSO_BRAND_ICON: Record<SsoLoginMethod['type'], string> = {
  oidc: oidcIconUrl,
  saml: samlIconUrl,
}

/** Icon node for a method — each protocol renders its original-color brand logo. */
function ssoMethodIcon(type: SsoLoginMethod['type'], className: string) {
  return <img src={SSO_BRAND_ICON[type]} alt="" className={className} />
}

/**
 * 发起某个 SSO 方式：服务端主导，整页跳到 loginUrl，
 * purpose/returnTo 作 query 由服务端回调处理。
 */
export function startSsoMethod(
  method: SsoLoginMethod,
  purpose: SsoPurpose = 'login',
  returnTo?: string,
): void {
  // 无附加参数时保留相对 loginUrl（如 /api/auth/oidc/login）；有 purpose/returnTo 才拼 query。
  const params = new URLSearchParams()
  if (purpose !== 'login') params.set('purpose', purpose)
  if (returnTo) params.set('returnTo', returnTo)
  const query = params.toString()
  window.location.href = query ? `${method.loginUrl}?${query}` : method.loginUrl
}

/** 从 oauth config 解析可用登录方式（未启用或无方式时为空数组）。 */
export function resolveSsoMethods(
  config: { enabled: boolean; methods?: SsoLoginMethod[] } | undefined,
): SsoLoginMethod[] {
  if (!config?.enabled) return []
  return config.methods ?? []
}

/**
 * SSO method picker — stacked icon-tile cards (icon-in-tile on top, label
 * below). Refined light-violet treatment: layered ring/border, a soft brand
 * glow that blooms on hover, tactile press state.
 */
function SsoMethodPicker({
  methods,
  t,
  returnTo,
}: {
  methods: SsoLoginMethod[]
  t: (k: string) => string
  /** Carried through SSO so a shared link survives the IdP round trip too. */
  returnTo?: string
}) {
  return (
    <div className={`grid gap-3 ${methods.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
      {methods.map((method) => (
        <button
          key={method.type}
          type="button"
          onClick={() => startSsoMethod(method, 'login', returnTo)}
          className="group relative flex flex-col items-center gap-2.5 overflow-hidden rounded-2xl border border-border/70 bg-card px-2 py-4 text-center shadow-sm transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-card active:translate-y-0 active:shadow-sm active:duration-100"
        >
          {/* bare icon (no tile) — brand logos sit directly on the card; a
              subtle lift on hover keeps it tactile */}
          <span className="relative flex size-7 items-center justify-center transition-transform duration-300 group-hover:scale-[1.1] group-active:scale-100">
            {ssoMethodIcon(method.type, 'h-6 w-6')}
          </span>
          <span className="text-xs font-medium tracking-tight text-foreground/90 transition-colors group-hover:text-foreground">
            {t(SSO_METHOD_SHORT_KEY[method.type])}
          </span>
        </button>
      ))}
    </div>
  )
}

export function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // Validated once here so every sign-in path (password AND SSO) carries the same
  // target — AuthGuard attaches it for any protected route, chat_app included.
  const returnTo = safeReturnTo(searchParams.get('returnTo')) ?? undefined
  const { data: status, isLoading: statusLoading } = useAuthStatus()
  const {
    data: oauthConfig,
    isLoading: oauthConfigLoading,
    isError: oauthConfigFailed,
  } = useOauthConfig()
  const usernameRef = useRef<InputRef>(null)
  // Called before the early returns below so hook order stays stable across the
  // loading / needSetup branches.
  const { data: version } = useVersion()
  const login = useLogin()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  // oidc/saml 标准流失败时服务端 302 回 /login?ssoError=<CODE>；只读一次并从 URL 清掉，防刷新重现。
  const [ssoErrorCode, setSsoErrorCode] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('ssoError'),
  )
  // SSO 按钮按服务端下发的 methods 渲染；仅 OAuth 启用时展示
  const ssoMethods = resolveSsoMethods(oauthConfig)

  // Focus imperatively rather than via autoFocus: the decision depends on the
  // config query, which resolves after mount, and autoFocus is only honoured at
  // mount — so gating it on a later value silently focuses nothing.
  useEffect(() => {
    if (oauthConfigLoading || ssoMethods.length > 0) return
    usernameRef.current?.focus()
  }, [oauthConfigLoading, ssoMethods.length])

  useEffect(() => {
    if (!ssoErrorCode) return
    const params = new URLSearchParams(window.location.search)
    if (!params.has('ssoError')) return
    params.delete('ssoError')
    const query = params.toString()
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    )
  }, [ssoErrorCode])

  if (statusLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  if (status?.needSetup) {
    return <Navigate to="/setup" replace />
  }

  const displayError =
    error ||
    (ssoErrorCode
      ? t(`auth.ssoError.${ssoErrorCode}`, { defaultValue: t('auth.ssoError.GENERIC') })
      : '')

  const handleSubmit = async () => {
    setError('')
    setSsoErrorCode(null)
    if (!username || !password) return
    try {
      await login.mutateAsync({ username, password })
      navigate(returnTo ?? '/')
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-background overflow-hidden p-6">
      {/* Background decoration */}
      <div className="pointer-events-none absolute inset-0 dot-pattern opacity-60" />
      <div className="pointer-events-none absolute -top-[40%] -right-[20%] h-[80%] w-[60%] rounded-full bg-brand-gradient opacity-[0.03] blur-3xl" />
      <div className="pointer-events-none absolute -bottom-[30%] -left-[15%] h-[60%] w-[50%] rounded-full bg-brand-gradient opacity-[0.02] blur-3xl" />

      <div className="relative z-10 w-full max-w-[860px] animate-fade-in">
        <div className="grid overflow-hidden rounded-2xl border border-border bg-card shadow-sm card-glow md:min-h-[440px] md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          {/* Brand panel — a theme-aware instrument screen with semantic text
              roles. The signal field supplies depth without fixing this public
              route to a light-only palette. */}
          <div
            data-testid="login-brand-panel"
            className="login-brand-panel relative hidden flex-col justify-between overflow-hidden border-r border-brand-panel-foreground/15 p-8 text-brand-panel-foreground md:flex"
          >
            <BrandWaveField />
            <div className="relative flex items-center gap-3.5">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-primary-foreground shadow-md">
                <Waves className="h-5.5 w-5.5" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight leading-tight text-brand-panel-foreground">
                  {t('app.name')}
                </h1>
                <p className="text-2xs text-brand-panel-muted-foreground tracking-[0.2em] uppercase font-[family-name:var(--font-mono,ui-monospace,monospace)]">
                  {t('app.subtitle')}
                </p>
              </div>
            </div>
            <p className="relative mt-8 max-w-[30ch] text-sm leading-relaxed text-brand-panel-muted-foreground">
              {t('app.tagline')}
            </p>
          </div>

          {/* Login card — vertically centered so its height stays stable
              whether or not SSO methods render, aligning with the brand panel. */}
          <div className="flex flex-col justify-center p-8 sm:p-10">
            {/* Compact brand header — only visible when the brand panel is hidden (narrow screens) */}
            <div className="mb-6 flex items-center justify-center gap-3 md:hidden">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-primary-foreground shadow-lg animate-wave-pulse">
                <Waves className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-foreground leading-tight">
                  {t('app.name')}
                </h1>
                <p className="text-2xs text-muted-foreground/60 tracking-wide uppercase">
                  {t('app.subtitle')}
                </p>
              </div>
            </div>
            <h2 className="mb-5 text-center text-lg font-semibold text-foreground">
              {t('auth.loginTitle')}
            </h2>

            <div className="space-y-4">
              {/* Never render "don't know yet" as "no SSO": one cold-start failure
                  would silently swallow the enterprise login entry. */}
              {oauthConfigLoading && (
                <div
                  data-testid="sso-methods-loading"
                  aria-hidden="true"
                  className="h-11 w-full animate-pulse rounded-md bg-muted"
                />
              )}
              {/* Retry exhaustion leaves no data, which renders identically to
                  "OAuth is disabled". Say which one it is, or the enterprise
                  entry just disappears again — the bug this branch started on. */}
              {oauthConfigFailed && (
                <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {t('auth.ssoConfigUnavailable')}
                </p>
              )}
              {!oauthConfigLoading && ssoMethods.length > 0 && (
                <>
                  {ssoMethods.length === 1 ? (
                    // 单方式：一个醒目的横向大按钮（用完整标签）
                    (() => {
                      const method = ssoMethods[0]
                      return (
                        <Button
                          variant="default"
                          className="w-full gap-2.5 bg-brand-gradient text-primary-foreground shadow-md transition-opacity hover:opacity-90"
                          size="lg"
                          onClick={() => startSsoMethod(method, 'login', returnTo)}
                        >
                          {/* white chip so any original-color brand logo reads on the gradient */}
                          <span className="flex size-5 items-center justify-center rounded-md bg-brand-mark-surface shadow-sm">
                            {ssoMethodIcon(method.type, 'h-3 w-3')}
                          </span>
                          {t(SSO_METHOD_LABEL_KEY[method.type])}
                        </Button>
                      )
                    })()
                  ) : (
                    // 多方式：样式由 ?sso=A|B|C 切换预览（默认 orig）
                    <SsoMethodPicker methods={ssoMethods} t={t} returnTo={returnTo} />
                  )}
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center text-xs">
                      <span className="bg-card px-2 text-muted-foreground">
                        {t('auth.orDivider')}
                      </span>
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="text-sm font-medium text-foreground" htmlFor="login-username">
                  {t('auth.username')}
                </label>
                <Input
                  id="login-username"
                  className="mt-1.5"
                  size="large"
                  placeholder={t('auth.usernamePlaceholder')}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onPressEnter={handleSubmit}
                  ref={usernameRef}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground" htmlFor="login-password">
                  {t('auth.password')}
                </label>
                <Input.Password
                  id="login-password"
                  className="mt-1.5"
                  size="large"
                  placeholder={t('auth.passwordPlaceholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onPressEnter={handleSubmit}
                />
              </div>

              {displayError && (
                <div className="rounded-lg bg-destructive-subtle px-3 py-2.5 text-sm text-destructive">
                  {displayError}
                </div>
              )}

              <div className="pt-1">
                <Button
                  variant="outline"
                  className="w-full"
                  size="lg"
                  disabled={!username || !password || login.isPending}
                  onClick={handleSubmit}
                >
                  {login.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('auth.loginButton')}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer — copyright plus, once known, the running server's version.
            The version is appended rather than given its own line: it is a
            short meta string and the footer is already this page's meta zone. */}
        <p data-testid="login-footer" className="mt-6 text-center text-2xs text-muted-foreground">
          {version
            ? t('app.copyrightWithVersion', { copyright: t('app.copyright'), version })
            : t('app.copyright')}
        </p>
      </div>
    </div>
  )
}
