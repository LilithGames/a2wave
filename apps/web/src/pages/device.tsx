import { useMutation, useQuery } from '@tanstack/react-query'
import { Input } from 'antd'
import { Check, Monitor, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatApiError } from '@/lib/api-error'

interface PendingDevice {
  userCode: string
  status: string
  clientIp: string | null
  userAgent: string | null
  requestedAt: string
  expiresAt: string
}

/** Mirrors the server's alphabet so a bad code is caught before a round trip. */
const USER_CODE_PATTERN =
  /^[ABCDEFGHJKLMNPQRSTVWXYZ23456789]{4}-?[ABCDEFGHJKLMNPQRSTVWXYZ23456789]{4}$/

function normalize(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '')
}

function formatCode(input: string): string {
  const compact = normalize(input).slice(0, 8)
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact
}

/**
 * Approve a headless `a2wave login` (RFC 8628 device grant).
 *
 * Authenticated by the surrounding route guard — the whole point is to lend an
 * existing browser session to a machine that cannot open a browser. The page shows
 * where the request came from before offering the button: that metadata is the only
 * way an approver can tell their own SSH session apart from a code someone phoned
 * them, which is the one attack this flow is actually exposed to.
 */
export function DevicePage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()

  // Prefilled from verificationUriComplete, and looked up immediately so the
  // approver lands straight on the confirm step. It is never auto-*approved*:
  // the decision itself is the security control, so a link must not skip it.
  const prefilled = formatCode(searchParams.get('code') ?? '')
  const [code, setCode] = useState(prefilled)
  const [submittedCode, setSubmittedCode] = useState(() =>
    USER_CODE_PATTERN.test(prefilled) ? normalize(prefilled) : '',
  )
  const [outcome, setOutcome] = useState<'approved' | 'denied' | null>(null)
  const [error, setError] = useState('')

  const codeValid = USER_CODE_PATTERN.test(code)

  const {
    data: pending,
    error: lookupError,
    isFetching,
  } = useQuery({
    queryKey: ['device-authorization', submittedCode],
    queryFn: () =>
      api
        .get<PendingDevice>(`/auth/device/pending?userCode=${encodeURIComponent(submittedCode)}`)
        .then((res) => res.data),
    // An expired or unknown code is a settled answer; retrying only delays the message.
    retry: false,
    enabled: !!submittedCode && !outcome,
  })

  const decide = useMutation({
    meta: { handleLocally: true },
    mutationFn: (approve: boolean) =>
      api.post(`/auth/device/${approve ? 'approve' : 'deny'}`, { userCode: submittedCode }),
  })

  const handleDecision = async (approve: boolean) => {
    setError('')
    try {
      await decide.mutateAsync(approve)
      setOutcome(approve ? 'approved' : 'denied')
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  return (
    <div className="mx-auto w-full max-w-md py-10">
      {outcome ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            {outcome === 'approved' ? (
              <Check className="h-6 w-6 text-success" />
            ) : (
              <X className="h-6 w-6 text-muted-foreground" />
            )}
          </div>
          <h1 className="text-lg font-semibold text-foreground">
            {t(outcome === 'approved' ? 'device.approved' : 'device.denied')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t(outcome === 'approved' ? 'device.approvedDesc' : 'device.deniedDesc')}
          </p>
        </div>
      ) : pending ? (
        <div className="rounded-xl border border-border bg-card p-8">
          <h1 className="text-lg font-semibold text-foreground">{t('device.confirmTitle')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('device.confirmDesc')}</p>

          <div className="mt-6 rounded-lg bg-muted/50 p-4 font-mono text-2xl tracking-[0.2em] text-center text-foreground">
            {pending.userCode}
          </div>

          <dl className="mt-6 space-y-3 text-sm">
            <div className="flex items-start justify-between gap-4">
              <dt className="text-muted-foreground">{t('device.requestedFrom')}</dt>
              <dd className="text-right font-mono text-foreground">
                {pending.clientIp ?? t('device.unknownAddress')}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-muted-foreground">{t('device.client')}</dt>
              <dd className="text-right break-all text-foreground">
                {pending.userAgent ?? t('device.unknownClient')}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-muted-foreground">{t('device.requestedAt')}</dt>
              <dd className="text-right text-foreground">
                {new Date(pending.requestedAt).toLocaleString()}
              </dd>
            </div>
          </dl>

          {/* Semantic warning tokens rather than raw amber: those carry dark-mode
              values, which a hardcoded shade does not. */}
          <div className="mt-6 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-xs text-warning">{t('device.warning')}</p>
          </div>

          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

          <div className="mt-6 flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              disabled={decide.isPending}
              onClick={() => handleDecision(false)}
            >
              {t('device.deny')}
            </Button>
            <Button
              className="flex-1"
              disabled={decide.isPending}
              onClick={() => handleDecision(true)}
            >
              {t('device.approve')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-8">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Monitor className="h-6 w-6 text-muted-foreground" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">{t('device.title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('device.desc')}</p>

          <label htmlFor="device-code" className="mt-6 block text-sm font-medium text-foreground">
            {t('device.codeLabel')}
          </label>
          <Input
            id="device-code"
            value={code}
            onChange={(e) => setCode(formatCode(e.target.value))}
            onPressEnter={() => codeValid && setSubmittedCode(normalize(code))}
            placeholder={t('device.codePlaceholder')}
            className="mt-2 font-mono text-center tracking-[0.2em]"
            size="large"
            autoFocus
          />

          {lookupError && (
            <p className="mt-3 text-sm text-destructive">
              {/* A rejected code and a lapsed one are different user mistakes and get
                  different copy; both are settled answers, so neither retries. */}
              {(lookupError as Error).message === 'INVALID_USER_CODE'
                ? t('device.invalidCode')
                : t('device.notFound')}
            </p>
          )}

          <Button
            className="mt-6 w-full"
            disabled={!codeValid || isFetching}
            onClick={() => setSubmittedCode(normalize(code))}
          >
            {isFetching ? t('common.loading') : t('device.continue')}
          </Button>
        </div>
      )}
    </div>
  )
}
