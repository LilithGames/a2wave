import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Input } from 'antd'
import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { BrandMarkFallback } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatApiError } from '@/lib/api-error'
import { cn } from '@/lib/utils'

type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked'

interface InvitationCheck {
  status: InvitationStatus
  /** Pinned address, echoed only while the invitation is still usable. */
  email: string | null
  expiresAt: string
}

function checkPolicy(password: string) {
  return {
    minLength: password.length >= 8,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasDigit: /\d/.test(password),
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * Self-registration from an invitation link.
 *
 * Public and unauthenticated by necessity — the visitor has no account yet, which is the
 * whole point. The code in the URL is the only credential, so the page asks the server
 * whether it is still usable *before* rendering a form: showing fields the submit can never
 * accept is how an expired link turns into a confusing failure rather than a clear one.
 */
export function InvitePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { code = '' } = useParams<{ code: string }>()

  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')

  const {
    data: invitation,
    isLoading,
    error: checkError,
  } = useQuery({
    queryKey: ['invitation', code],
    queryFn: () =>
      api
        .get<InvitationCheck>(`/auth/invitations/${encodeURIComponent(code)}`)
        .then((res) => res.data),
    // A bad code is a permanent answer, not a blip — retrying only delays the message.
    retry: false,
    enabled: !!code,
  })

  // A pinned invitation already names the address; prefilling it (read-only) removes the
  // one field the invitee could get wrong in a way the server would reject.
  const pinnedEmail = invitation?.status === 'pending' ? invitation.email : null
  useEffect(() => {
    if (pinnedEmail) setEmail(pinnedEmail)
  }, [pinnedEmail])

  const policy = checkPolicy(password)
  const passwordValid = policy.minLength && policy.hasUpper && policy.hasLower && policy.hasDigit
  const passwordsMatch = password.length > 0 && password === confirmPassword
  const usernameValid =
    username.length >= 3 && username.length <= 32 && USERNAME_PATTERN.test(username)
  const emailValid = EMAIL_PATTERN.test(email.trim())
  const canSubmit = usernameValid && emailValid && passwordValid && passwordsMatch

  const acceptMutation = useMutation({
    meta: { handleLocally: true },
    // No displayName: registration asks only for what an account cannot exist without, so
    // the invitee is through in four fields. The API still accepts one (the CLI and import
    // paths set it), and the user can add it later from their own profile.
    mutationFn: (data: {
      username: string
      email: string
      password: string
      confirmPassword: string
    }) => api.post(`/auth/invitations/${encodeURIComponent(code)}/accept`, data),
  })

  const handleSubmit = async () => {
    setError('')
    if (!canSubmit) return
    try {
      await acceptMutation.mutateAsync({
        username,
        email: email.trim(),
        password,
        confirmPassword,
      })
      // Accept signs the new account in and sets the session cookie, so the cached
      // "not logged in" answer must go before navigating or the guard bounces to /login.
      queryClient.clear()
      navigate('/', { replace: true })
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

  const unusableReason = resolveUnusableReason(invitation?.status, !!checkError)

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-background overflow-hidden">
      <div className="pointer-events-none absolute inset-0 dot-pattern opacity-60" />
      <div className="pointer-events-none absolute -top-[40%] -right-[20%] h-[80%] w-[60%] rounded-full bg-brand-gradient opacity-[0.03] blur-3xl" />
      <div className="pointer-events-none absolute -bottom-[30%] -left-[15%] h-[60%] w-[50%] rounded-full bg-brand-gradient opacity-[0.02] blur-3xl" />

      {/* Wider than the login/setup cards on purpose: this form has five fields plus a
          policy checklist, which at their ~380px width scrolls past the fold. The card
          narrows itself back down for the short unusable-link states below. */}
      <div
        className={cn(
          'relative z-10 w-full px-6 animate-fade-in',
          unusableReason || isLoading ? 'max-w-[420px]' : 'max-w-[760px]',
        )}
      >
        <div className="flex items-center justify-center gap-3.5 mb-8">
          {/* Same semantic fallback as first-time setup: this page is unauthenticated, so
              it cannot make the settings request BrandMark relies on. */}
          <BrandMarkFallback
            className="size-11 rounded-xl shadow-lg animate-wave-pulse"
            iconClassName="h-5.5 w-5.5"
          />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground leading-tight">
              {t('app.name')}
            </h1>
            <p className="text-2xs text-muted-foreground/60 tracking-wide uppercase">
              {t('app.subtitle')}
            </p>
          </div>
        </div>

        <div
          data-testid="invite-card"
          className="rounded-xl border border-border bg-card p-6 shadow-sm card-glow"
        >
          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <div className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : unusableReason ? (
            <div data-testid="invite-unusable">
              <h2 className="text-lg font-semibold text-foreground">
                {t(`invite.unusable.${unusableReason}.title`)}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(`invite.unusable.${unusableReason}.desc`)}
              </p>
              <Button className="mt-5 w-full" onClick={() => navigate('/login')}>
                {t('invite.goToLogin')}
              </Button>
            </div>
          ) : (
            <>
              <div className="mb-5">
                <h2 className="text-lg font-semibold text-foreground">{t('invite.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('invite.desc')}</p>
              </div>

              {/* A 2x2 grid: identity (username, email) on the first row, credentials
                  (password, confirmation) on the second, so the pair that must match sits
                  side by side. Four fields is the whole form — nothing optional is asked
                  for at registration. Collapses to one column below sm. */}
              <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <div>
                  <label className="text-sm font-medium text-foreground" htmlFor="invite-username">
                    {t('users.username')}
                    <span className="ml-0.5 text-destructive" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <Input
                    id="invite-username"
                    className="mt-1.5"
                    size="large"
                    placeholder={t('invite.usernamePlaceholder')}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                  />
                  {username.length > 0 && !usernameValid && (
                    <p className="mt-1 text-xs text-destructive">{t('invite.usernameInvalid')}</p>
                  )}
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground" htmlFor="invite-email">
                    {t('invite.email')}
                    <span className="ml-0.5 text-destructive" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <Input
                    id="invite-email"
                    className="mt-1.5"
                    size="large"
                    type="email"
                    placeholder={t('invite.emailPlaceholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    // A pinned invitation may only be accepted by the address it names, so
                    // the field is locked rather than left editable to be rejected later.
                    disabled={!!pinnedEmail}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pinnedEmail ? t('invite.emailPinnedHint') : t('invite.emailHint')}
                  </p>
                  {email.length > 0 && !emailValid && (
                    <p className="mt-1 text-xs text-destructive">{t('invite.emailInvalid')}</p>
                  )}
                </div>

                <div>
                  <label className="text-sm font-medium text-foreground" htmlFor="invite-password">
                    {t('auth.password')}
                    <span className="ml-0.5 text-destructive" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <Input.Password
                    id="invite-password"
                    className="mt-1.5"
                    size="large"
                    placeholder={t('auth.passwordPlaceholder')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                <div>
                  <label
                    className="text-sm font-medium text-foreground"
                    htmlFor="invite-confirm-password"
                  >
                    {t('auth.confirmPassword')}
                    <span className="ml-0.5 text-destructive" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <Input.Password
                    id="invite-confirm-password"
                    className="mt-1.5"
                    size="large"
                    placeholder={t('auth.confirmPasswordPlaceholder')}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    onPressEnter={handleSubmit}
                  />
                  {confirmPassword.length > 0 && !passwordsMatch && (
                    <p className="mt-1 text-xs text-destructive">{t('auth.passwordMismatch')}</p>
                  )}
                </div>

                {/* The checklist, the error and the submit each span both columns: they are
                    feedback on, and the action for, the whole form rather than one field. */}
                {password.length > 0 && (
                  <div className="info-panel px-3 py-2.5 space-y-1 sm:col-span-2">
                    <PolicyItem ok={policy.minLength} label={t('auth.policyMinLength')} />
                    <PolicyItem ok={policy.hasUpper} label={t('auth.policyUppercase')} />
                    <PolicyItem ok={policy.hasLower} label={t('auth.policyLowercase')} />
                    <PolicyItem ok={policy.hasDigit} label={t('auth.policyDigit')} />
                  </div>
                )}

                {error && (
                  <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-600 sm:col-span-2">
                    {error}
                  </div>
                )}

                <Button
                  className="w-full sm:col-span-2"
                  loading={acceptMutation.isPending}
                  disabled={!canSubmit}
                  onClick={handleSubmit}
                >
                  {t('invite.submit')}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Which "you cannot use this link" message to show, or null when the form should render.
 *
 * A failed lookup and a code the server has never heard of are the same thing to the
 * visitor — there is nothing they can do about either beyond checking the URL — so both
 * collapse onto `notFound` rather than exposing a distinction they cannot act on.
 */
function resolveUnusableReason(
  status: InvitationStatus | undefined,
  lookupFailed: boolean,
): 'notFound' | 'expired' | 'revoked' | 'accepted' | null {
  if (lookupFailed) return 'notFound'
  if (!status) return null
  if (status === 'pending') return null
  return status
}
