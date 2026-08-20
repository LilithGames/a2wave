import { Button, Input, Popover, Tooltip } from 'antd'
import i18n from 'i18next'
import {
  BookText,
  Check,
  ChevronRight,
  Globe,
  Info,
  KeyRound,
  LogOut,
  Palette,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AboutDialog } from '@/components/about-dialog'
import { ThemePickerDialog } from '@/components/theme-picker-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  useChangePassword,
  useCurrentUser,
  useLogout,
  useOauthConfig,
  useUpdateLocale,
} from '@/hooks/use-auth'
import { message } from '@/lib/antd-static'
import { formatApiError } from '@/lib/api-error'
import { cn, copyToClipboard } from '@/lib/utils'
import { resolveSsoMethods, startSsoMethod } from '@/pages/login'

/** Install command for the a2wave CLI, published to the public npm registry. */
export const CLI_INSTALL_COMMAND = 'npm i -g a2wave'

/** Protocol names the badge spells out; anything else renders the generic mark. */
const NAMED_SSO_PROTOCOLS = ['oidc', 'saml'] as const

/** Full accessible description for a bound identity, by recorded protocol. */
function ssoBindLabel(
  protocol: string | null | undefined,
  t: ReturnType<typeof useTranslation>['t'],
) {
  if (protocol && (NAMED_SSO_PROTOCOLS as readonly string[]).includes(protocol)) {
    return t('auth.idaasBoundVia', { protocol: protocol.toUpperCase() })
  }
  // Null = a row written before the column existed: bound, protocol unknown.
  return t('auth.idaasBound')
}

/** Ties the hidden bind-state text to the menu trigger via aria-describedby. */
const SSO_BIND_DESCRIPTION_ID = 'sso-bind-state'

/**
 * The visible badge glyph. Purely presentational: it is `aria-hidden` in BOTH
 * placements, because a `role="img"` descendant contributes its own aria-label to
 * the enclosing button's name-from-contents computation — which turned the trigger
 * into "A · Name · 企业身份已绑定（OIDC） · admin", a control whose name enumerates
 * state instead of describing an action.
 */
function SsoIdentityBadge({ protocol }: { protocol: string | null | undefined }) {
  const { t } = useTranslation()
  const named = NAMED_SSO_PROTOCOLS.find((p) => p === protocol) ?? null

  return (
    <Tooltip title={ssoBindLabel(protocol, t)}>
      <span
        aria-hidden
        className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-2xs font-medium uppercase leading-none tracking-wide text-muted-foreground ring-1 ring-border"
      >
        <ShieldCheck className="h-2.5 w-2.5" aria-hidden />
        {named ?? 'SSO'}
      </span>
    </Tooltip>
  )
}

/**
 * Screen-reader-only description of the bind state, referenced by the menu
 * trigger's `aria-describedby`.
 *
 * Deliberately carries NO role. A live region is the wrong primitive for state
 * that simply exists on mount: screen readers generally do not announce content
 * already present when the region enters the tree, and this node is inserted only
 * once /auth/me resolves. As a described-by target it is announced after the
 * control's name, on demand, explicitly associated, and never live.
 */
function SsoIdentityDescription({ protocol }: { protocol: string | null | undefined }) {
  const { t } = useTranslation()
  return (
    <span id={SSO_BIND_DESCRIPTION_ID} className="sr-only">
      {ssoBindLabel(protocol, t)}
    </span>
  )
}

function checkPolicy(password: string) {
  return {
    minLength: password.length >= 8,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasDigit: /\d/.test(password),
  }
}

export function UserMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation()
  const { data: user } = useCurrentUser()
  const { data: oauthConfig } = useOauthConfig()
  // 绑定企业身份走与登录同一批方式（OIDC/SAML）；多方式时取第一个（菜单项不做交互选择）。
  const bindMethod = resolveSsoMethods(oauthConfig)[0] ?? null
  const logout = useLogout()
  const updateLocale = useUpdateLocale()
  const [open, setOpen] = useState(false)
  const [changePwOpen, setChangePwOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  // `useLogout` is a bare async callback, not a mutation, so the in-flight state
  // is tracked here. Without it a slow /auth/logout leaves the dialog idle and
  // clickable, and an impatient double-click fires two logouts.
  const [loggingOut, setLoggingOut] = useState(false)
  /**
   * Set aria-describedby imperatively via a callback ref: antd's Popover clones
   * its trigger child and forwards only a known prop set, silently dropping the
   * JSX attribute (verified — aria-label and title survive, aria-describedby does
   * not). A callback ref re-applies it if antd re-clones onto a fresh node.
   */
  const describedBy = user?.idaasBound ? SSO_BIND_DESCRIPTION_ID : null
  const triggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (!node) return
      if (describedBy) node.setAttribute('aria-describedby', describedBy)
      else node.removeAttribute('aria-describedby')
    },
    [describedBy],
  )
  const [aboutOpen, setAboutOpen] = useState(false)
  const [themePickerOpen, setThemePickerOpen] = useState(false)

  if (!user) return null

  const initial = (user.displayName || user.username).charAt(0).toUpperCase()
  const currentLocale = user.locale || 'zh'

  const handleLocaleSwitch = (locale: 'zh' | 'en') => {
    if (locale === currentLocale) return
    updateLocale.mutate(locale, {
      onSuccess: () => {
        i18n.changeLanguage(locale)
      },
    })
  }

  const LOCALE_OPTIONS: { value: 'zh' | 'en'; label: string }[] = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
  ]

  const content = (
    // data-testid so E2E can scope to the open menu without reaching into antd's
    // private overlay class names, which change across major versions.
    <div data-testid="user-menu-popover" className="w-48 space-y-1">
      {/* The badge also lives here, not only on the trigger: a collapsed sidebar
          (forced below 640px, where there is no way to expand) hides the
          trigger's name and badge entirely. */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
        <span className="truncate">{user.username}</span>
        {user.idaasBound && <SsoIdentityBadge protocol={user.idaasProtocol} />}
      </div>
      <div className="h-px bg-border" />
      <div className="group/lang relative">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover transition-colors"
        >
          <Globe className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">{t('auth.switchLanguage')}</span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
        <div className="invisible absolute bottom-full right-0 mb-1 w-36 rounded-lg border border-border bg-card p-1 shadow-md transition-[visibility] group-hover/lang:visible sm:bottom-0 sm:right-auto sm:left-full sm:mb-0 sm:ml-1">
          {LOCALE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover transition-colors"
              onClick={() => {
                handleLocaleSwitch(opt.value)
                setOpen(false)
              }}
            >
              <Check
                className={`h-3.5 w-3.5 ${currentLocale === opt.value ? 'opacity-100' : 'opacity-0'}`}
              />
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover transition-colors"
        onClick={() => {
          setOpen(false)
          setThemePickerOpen(true)
        }}
      >
        <Palette className="h-3.5 w-3.5" />
        {t('appearance.menuItem')}
      </button>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover transition-colors"
        onClick={() => {
          setOpen(false)
          setChangePwOpen(true)
        }}
      >
        <KeyRound className="h-3.5 w-3.5" />
        {t('auth.changePassword')}
      </button>
      {/* Bound identity is surfaced as a badge on the identity, so this row only
          exists while there is still a bind to perform. */}
      {bindMethod && !user.idaasBound && (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover transition-colors disabled:cursor-default disabled:hover:bg-transparent"
          disabled={!!user.idaasBound}
          onClick={() => {
            setOpen(false)
            // 回跳到当前页，绑定完成后用户回到原处（如 agent 发布页）
            startSsoMethod(bindMethod, 'bind', window.location.pathname + window.location.search)
          }}
        >
          <ShieldCheck
            className={`h-3.5 w-3.5 shrink-0 ${user.idaasBound ? 'text-emerald-500' : ''}`}
          />
          <span className="flex-1 text-left whitespace-nowrap">
            {user.idaasBound ? t('auth.idaasBound') : t('auth.bindIdaas')}
          </span>
        </button>
      )}
      {/* Splits account actions (password, identity binding) from the resource
          links below (CLI, manual, about). Sits after the bind row so the two
          groups stay separated whether or not that conditional row renders. */}
      <div className="h-px bg-border" />
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover transition-colors"
        onClick={async () => {
          setOpen(false)
          try {
            await copyToClipboard(CLI_INSTALL_COMMAND)
            message.success(t('auth.cliCommandCopied'))
          } catch {
            message.error(t('auth.cliCommandCopyFailed'))
          }
        }}
      >
        <Terminal className="h-3.5 w-3.5" />
        {t('auth.getCli')}
      </button>
      {/* A real <Link>, not a button + navigate(): the manual is a navigation
          target, so cmd/ctrl+click and middle-click must open it in a new tab. */}
      {/* text-foreground is explicit: as an <a> this inherits the link-blue `a`
          reset, which made it the only tinted row among identical-looking buttons. */}
      <Link
        to="/cli-access"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:text-foreground hover:bg-surface-hover transition-colors"
        onClick={() => setOpen(false)}
      >
        <KeyRound className="h-3.5 w-3.5" />
        {t('cli.title')}
      </Link>
      <Link
        to="/wiki"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:text-foreground hover:bg-surface-hover transition-colors"
        onClick={() => setOpen(false)}
      >
        <BookText className="h-3.5 w-3.5" />
        {t('nav.wiki')}
      </Link>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover transition-colors"
        onClick={() => {
          setOpen(false)
          setAboutOpen(true)
        }}
      >
        <Info className="h-3.5 w-3.5" />
        {t('about.menuItem')}
      </button>
      <div className="h-px bg-border" />
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
        onClick={() => {
          setOpen(false)
          setLogoutOpen(true)
        }}
      >
        <LogOut className="h-3.5 w-3.5" />
        {t('auth.logout')}
      </button>
    </div>
  )

  return (
    <>
      <Popover
        content={content}
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement={collapsed ? 'rightBottom' : 'topLeft'}
        arrow={false}
        // antd's popover surface is near-identical to the sidebar background, so the
        // panel edge disappears. Ring rather than border: it draws outside the box,
        // so it can't shift antd's internal padding/placement math.
        //
        // `.ant-popover-container` is the node that actually carries the radius,
        // background and shadow. Its parent `.ant-popover-content` is a transparent
        // wrapper with NO radius — ringing that one drew a hard square inside the
        // rounded panel. (v5's `.ant-popover-inner` no longer exists at all.)
        classNames={{
          root: '[&_.ant-popover-container]:ring-1 [&_.ant-popover-container]:ring-border',
        }}
      >
        <button
          type="button"
          title={collapsed ? user.displayName || user.username : undefined}
          aria-label={collapsed ? user.displayName || user.username : undefined}
          ref={triggerRef}
          className={cn(
            'flex w-full items-center rounded-lg py-1.5 hover:bg-surface-hover transition-colors',
            collapsed ? 'justify-center px-0' : 'gap-2.5 px-2',
          )}
        >
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-interactive-foreground">
            {initial}
          </div>
          {!collapsed && (
            <div className="flex-1 text-left min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-sm font-medium text-foreground truncate">
                  {user.displayName || user.username}
                </span>
              </div>
              {/* Badge sits on the role row and is pushed right by the role's
                  `flex-1`, so it trails the row rather than the (variable-width)
                  role text — keeping it aligned across accounts. */}
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="flex-1 text-2xs text-muted-foreground/60 truncate">
                  {user.role}
                </span>
                {user.idaasBound && <SsoIdentityBadge protocol={user.idaasProtocol} />}
              </div>
            </div>
          )}
        </button>
      </Popover>

      {/* Outside the trigger button on purpose: inside, it would be folded into
          the button's name-from-contents. Rendered regardless of `collapsed`. */}
      {user.idaasBound && <SsoIdentityDescription protocol={user.idaasProtocol} />}

      <ChangePasswordDialog open={changePwOpen} onOpenChange={setChangePwOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <ThemePickerDialog open={themePickerOpen} onOpenChange={setThemePickerOpen} />

      <Dialog
        open={logoutOpen}
        onOpenChange={(next) => {
          // Ignore close attempts once the request is away: the page is about to
          // navigate, and reopening the menu mid-logout only invites a second click.
          if (loggingOut) return
          setLogoutOpen(next)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('auth.logoutConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('auth.logoutConfirmDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outlined" disabled={loggingOut} onClick={() => setLogoutOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              danger
              type="primary"
              loading={loggingOut}
              onClick={() => {
                setLoggingOut(true)
                // No reset: success ends in a full page navigation, and failure
                // force-redirects too, so this never returns to an idle state.
                logout()
              }}
            >
              {t('auth.logout')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const changePassword = useChangePassword()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')

  const policy = checkPolicy(newPassword)
  const allValid = policy.minLength && policy.hasUpper && policy.hasLower && policy.hasDigit

  const handleSubmit = async () => {
    setError('')
    if (!allValid) return
    if (newPassword !== confirmPassword) {
      setError(t('auth.passwordMismatch'))
      return
    }
    try {
      await changePassword.mutateAsync({ oldPassword, newPassword })
      onOpenChange(false)
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  const PolicyItem = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className="flex items-center gap-1.5 text-xs">
      {ok ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <X className="h-3.5 w-3.5 text-muted-foreground/40" />
      )}
      <span className={ok ? 'text-emerald-600' : 'text-muted-foreground'}>{label}</span>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('auth.changePasswordTitle')}</DialogTitle>
          <DialogDescription>{t('auth.changePasswordDesc')}</DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="current-password" className="text-sm font-medium text-foreground">
              {t('auth.currentPassword')}
            </label>
            <Input.Password
              id="current-password"
              className="mt-1"
              placeholder={t('auth.currentPasswordPlaceholder')}
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="new-password" className="text-sm font-medium text-foreground">
              {t('auth.newPassword')}
            </label>
            <Input.Password
              id="new-password"
              className="mt-1"
              placeholder={t('auth.newPasswordPlaceholder')}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="confirm-new-password" className="text-sm font-medium text-foreground">
              {t('auth.confirmNewPassword')}
            </label>
            <Input.Password
              id="confirm-new-password"
              className="mt-1"
              placeholder={t('auth.confirmNewPasswordPlaceholder')}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>

          {newPassword.length > 0 && (
            <div className="info-panel px-3 py-2.5 space-y-1">
              <PolicyItem ok={policy.minLength} label={t('auth.policyMinLength')} />
              <PolicyItem ok={policy.hasUpper} label={t('auth.policyUppercase')} />
              <PolicyItem ok={policy.hasLower} label={t('auth.policyLowercase')} />
              <PolicyItem ok={policy.hasDigit} label={t('auth.policyDigit')} />
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-600">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outlined" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="primary"
            loading={changePassword.isPending}
            disabled={!oldPassword || !allValid || newPassword !== confirmPassword}
            onClick={handleSubmit}
          >
            {t('auth.changePasswordButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
