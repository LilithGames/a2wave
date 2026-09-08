import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRuns } from '@/hooks/use-runs'
import { formatRelativeTime } from '@/lib/utils'

/**
 * The Agent's most recent failed Run, shown in the Provider section.
 *
 * Every credential probe on this page asks a CLI, and most CLIs answer from a
 * local file: a revoked token still reads as "logged in" while every Run dies
 * on a 401. The last real failure is the one piece of evidence that cannot be
 * wrong about whether the configuration works, so it belongs next to the
 * configuration rather than only in the Runs tab.
 */

/**
 * Errors that mean "the credential is no longer accepted".
 *
 * Kept deliberately narrow — a false "your login died" sends an operator to
 * re-authenticate over an unrelated failure, which is worse than saying
 * nothing. Matched against the vendor's own wording seen in practice
 * (revoked refresh tokens, 401/403, expired sessions).
 */
const CREDENTIAL_ERROR_PATTERN =
  /\b(401|403)\b|unauthorized|forbidden|revoked|invalid[_ -]?api[_ -]?key|authentication failed|token (?:was )?(?:expired|revoked)|could not be refreshed|please (?:log ?out and )?sign in again|not logged in/i

export function isCredentialError(error: string): boolean {
  return CREDENTIAL_ERROR_PATTERN.test(error)
}

// One page, with the exact arguments the Runs tab uses, so this reads the
// cached result instead of firing a second query.
const RUNS_PAGE_SIZE = 15

export function AgentRecentFailureNotice({ agentId }: { agentId: string | undefined }) {
  const { t } = useTranslation()
  const { data } = useRuns({ agentId, page: 1, pageSize: RUNS_PAGE_SIZE })

  const latestFailure = data?.data?.find((run) => run.status === 'failed')
  const error =
    typeof (latestFailure?.result as { error?: unknown } | null)?.error === 'string'
      ? ((latestFailure?.result as { error: string }).error as string)
      : undefined
  if (!latestFailure || !error) return null

  const credentialLooking = isCredentialError(error)

  return (
    <div
      role="status"
      data-testid="agent-recent-failure"
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
        credentialLooking
          ? 'border-destructive/30 bg-destructive/5'
          : 'border-border/60 bg-muted/25'
      }`}
    >
      <AlertTriangle
        className={`mt-0.5 h-4 w-4 shrink-0 ${
          credentialLooking ? 'text-destructive' : 'text-muted-foreground'
        }`}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">
          {t('agentDetail.recentFailureTitle', {
            time: formatRelativeTime(latestFailure.createdAt),
          })}
        </p>
        <p className="mt-0.5 break-words font-mono text-xs text-muted-foreground">{error}</p>
        {credentialLooking && (
          <p className="mt-1 text-xs text-destructive">{t('agentDetail.recentFailureAuthHint')}</p>
        )}
      </div>
    </div>
  )
}
