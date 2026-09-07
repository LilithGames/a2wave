import type { ProviderKind } from '@a2wave/shared'
import { Tooltip } from 'antd'
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useProviderLoginStatus } from '@/hooks/use-providers'

/**
 * Server-side login state for one `localSession` Provider entry, plus the
 * how-to that explains where that state has to be created.
 *
 * In `localSession` mode the credential is not in the Agent's config at all: it
 * lives in the CLI HOME of the machine running a2wave. A deployment with a
 * single Provider therefore fails *every* Run the moment that session expires,
 * while the config page keeps looking perfectly valid. Probing on expand — and
 * offering a re-check right where an operator goes to look — turns that silent
 * failure into a visible one.
 */

const CHIP_BASE =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium'

export function ProviderLoginSessionStatus({
  providerKind,
  loginCommand,
}: {
  providerKind: ProviderKind
  loginCommand: string
}) {
  const { t } = useTranslation()
  const { data, isPending, isFetching, isError, refetch } = useProviderLoginStatus(providerKind)

  // `isFetching` rather than `isPending`: a re-check keeps the previous answer
  // on screen, and reporting the stale verdict as current is exactly what this
  // strip exists to prevent.
  const checking = isPending || isFetching
  // The route answers 200 with an installed:false body when the probe throws,
  // which is exactly the shape of the engine's "CLI not found" verdict — the
  // tag is the only thing separating a broken check from a missing CLI, and
  // sending an operator to install a CLI that is already there wastes the one
  // thing an outage does not have.
  const probeFailed = isError || data?.code === 'PROBE_FAILED'
  const settled = !checking && !probeFailed
  const notInstalled = settled && data?.installed === false
  const loggedIn = settled && data?.loggedIn === true
  const notLoggedIn = settled && data?.installed !== false && data?.loggedIn !== true
  // Whatever the server said about *why*: the verdict alone ("not logged in")
  // is not actionable, and this line is where a version floor warning or a
  // spawn error becomes visible.
  const explanation = !checking && !loggedIn ? (data?.error ?? data?.detail) : data?.detail

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid={`provider-login-status-${providerKind}`}
    >
      {checking && (
        <span className={`${CHIP_BASE} bg-primary/10 text-interactive-foreground`}>
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          {t('agentDetail.loginStatusChecking')}
        </span>
      )}
      {probeFailed && (
        <span className={`${CHIP_BASE} bg-destructive/10 text-destructive`}>
          <XCircle className="size-3" aria-hidden="true" />
          {t('agentDetail.loginStatusError')}
        </span>
      )}
      {notInstalled && (
        <span className={`${CHIP_BASE} bg-warning/10 text-warning`}>
          <AlertTriangle className="size-3" aria-hidden="true" />
          {t('agentDetail.loginStatusNotInstalled')}
        </span>
      )}
      {loggedIn && (
        <span className={`${CHIP_BASE} bg-success/10 text-success`}>
          <CheckCircle2 className="size-3" aria-hidden="true" />
          {t('agentDetail.loginStatusLoggedIn')}
        </span>
      )}
      {notLoggedIn && (
        <span className={`${CHIP_BASE} bg-warning/10 text-warning`}>
          <AlertTriangle className="size-3" aria-hidden="true" />
          {t('agentDetail.loginStatusNotLoggedIn')}
        </span>
      )}
      {data?.version && (
        <span className="font-mono text-[11px] text-muted-foreground">{data.version}</span>
      )}
      {notLoggedIn && loginCommand && (
        <span className="text-xs text-muted-foreground">
          {t('agentDetail.loginStatusRunHint', { command: loginCommand })}
        </span>
      )}
      {explanation && (
        <span className="max-w-full truncate text-xs text-muted-foreground" title={explanation}>
          {explanation}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
        disabled={checking}
        onClick={() => {
          void refetch()
        }}
      >
        <RefreshCw className={`size-3 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
        {t('agentDetail.loginStatusRecheck')}
      </Button>
    </div>
  )
}

/**
 * Hover help for the `localSession` credential mode.
 *
 * The mode's own hint says where the session lives; this says how to put one
 * there — including that the steps can simply be handed to an Agent with shell
 * access to that server, which is the fastest route for an operator who does
 * not hold the login themselves.
 */
export function LocalSessionGuideIcon({ loginCommand }: { loginCommand: string }) {
  const { t } = useTranslation()

  return (
    <Tooltip
      placement="top"
      title={
        <div className="space-y-1 text-xs">
          <p className="font-medium">{t('agentDetail.localSessionGuideTitle')}</p>
          <p>{t('agentDetail.localSessionGuideStep1')}</p>
          <p>{t('agentDetail.localSessionGuideStep2', { command: loginCommand })}</p>
          <p>{t('agentDetail.localSessionGuideStep3')}</p>
          <p className="opacity-80">{t('agentDetail.localSessionGuideAgent')}</p>
        </div>
      }
    >
      <button
        type="button"
        // The icon sits inside the radio's own label, so a plain click would
        // switch the Agent's credential mode just for reading the help.
        onClick={(event) => event.preventDefault()}
        className="inline-flex text-muted-foreground hover:text-foreground"
        aria-label={t('agentDetail.localSessionGuideAria')}
      >
        <Info className="size-3.5" aria-hidden="true" />
      </button>
    </Tooltip>
  )
}
