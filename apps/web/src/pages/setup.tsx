import { Input } from 'antd'
import { Check, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate } from 'react-router-dom'
import { BrandMarkFallback } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { useAuthStatus, useSetup } from '@/hooks/use-auth'
import { formatApiError } from '@/lib/api-error'

function checkPolicy(password: string) {
  return {
    minLength: password.length >= 8,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasDigit: /\d/.test(password),
  }
}

export function SetupPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data: status, isLoading: statusLoading } = useAuthStatus()
  const setup = useSetup()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')

  const policy = checkPolicy(password)
  const allValid = policy.minLength && policy.hasUpper && policy.hasLower && policy.hasDigit

  const handleSubmit = async () => {
    setError('')
    if (!allValid) {
      setError(t('auth.passwordPolicyError'))
      return
    }
    if (password !== confirmPassword) {
      setError(t('auth.passwordMismatch'))
      return
    }
    try {
      await setup.mutateAsync({
        password,
        confirmPassword,
      })
      navigate('/')
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  const PolicyItem = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className="flex items-center gap-1.5 text-xs">
      {ok ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <X className="h-3.5 w-3.5 text-muted-foreground/40" />
      )}
      <span className={ok ? 'text-success' : 'text-muted-foreground'}>{label}</span>
    </div>
  )

  if (statusLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  if (status && !status.needSetup) {
    return <Navigate to="/login" replace />
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-background overflow-hidden">
      {/* Background decoration */}
      <div className="pointer-events-none absolute inset-0 dot-pattern opacity-60" />
      <div className="pointer-events-none absolute -top-[40%] -right-[20%] h-[80%] w-[60%] rounded-full bg-brand-gradient opacity-[0.03] blur-3xl" />
      <div className="pointer-events-none absolute -bottom-[30%] -left-[15%] h-[60%] w-[50%] rounded-full bg-brand-gradient opacity-[0.02] blur-3xl" />

      <div className="relative z-10 w-full max-w-[380px] px-6 animate-fade-in">
        {/* Brand header */}
        <div className="flex items-center justify-center gap-3.5 mb-8">
          {/* Settings do not exist yet, so first-time setup deliberately renders
              the same semantic fallback used by BrandMark without making an
              authenticated settings request. */}
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

        {/* Setup card */}
        <div
          data-testid="setup-card"
          className="rounded-xl border border-border bg-card p-6 shadow-sm card-glow"
        >
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-foreground">{t('auth.setupTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('auth.setupDesc')}</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="setup-password">
                {t('auth.password')}
              </label>
              <Input.Password
                id="setup-password"
                className="mt-1.5"
                size="large"
                placeholder={t('auth.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onPressEnter={handleSubmit}
                autoFocus
              />
            </div>
            <div>
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="setup-confirm-password"
              >
                {t('auth.confirmPassword')}
              </label>
              <Input.Password
                id="setup-confirm-password"
                className="mt-1.5"
                size="large"
                placeholder={t('auth.confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onPressEnter={handleSubmit}
              />
            </div>

            {password.length > 0 && (
              <div className="info-panel px-3 py-2.5 space-y-1">
                <PolicyItem ok={policy.minLength} label={t('auth.policyMinLength')} />
                <PolicyItem ok={policy.hasUpper} label={t('auth.policyUppercase')} />
                <PolicyItem ok={policy.hasLower} label={t('auth.policyLowercase')} />
                <PolicyItem ok={policy.hasDigit} label={t('auth.policyDigit')} />
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-destructive-subtle px-3 py-2.5 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="pt-1">
              <Button
                className="w-full"
                size="lg"
                disabled={!allValid || password !== confirmPassword || setup.isPending}
                onClick={handleSubmit}
              >
                {setup.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('auth.setupButton')}
              </Button>
            </div>
          </div>
        </div>

        {/* Footer — same copyright line as the login page */}
        <p className="mt-6 text-center text-2xs text-muted-foreground/75">{t('app.copyright')}</p>
      </div>
    </div>
  )
}
