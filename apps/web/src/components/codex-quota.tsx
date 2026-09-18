import type { CodexQuota, CodexQuotaWindow } from '@a2wave/shared'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'

export function CodexQuotaDisplay({ providerId }: { providerId: string }) {
  const { t, i18n } = useTranslation()
  const { data, isPending, isError } = useQuery({
    queryKey: ['provider-quota', providerId],
    queryFn: () => api.get<CodexQuota>(`/providers/${providerId}/quota`),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: 'always',
  })
  const quota = data?.data

  function windowLabel(window: CodexQuotaWindow) {
    const duration = window.windowDurationMins
    let period: string | null = null
    if (duration === 10080) period = t('codexQuota.weekly')
    else if (duration === 300) period = t('codexQuota.fiveHours')
    else if (duration != null) period = t('codexQuota.minutes', { count: duration })
    return [window.label, period].filter(Boolean).join(' · ') || t('codexQuota.window')
  }

  let status: CodexQuota['status'] | 'loading' = quota?.status ?? 'unavailable'
  if (isPending) status = 'loading'
  else if (isError || (quota?.status === 'available' && quota.windows.length === 0)) {
    status = 'unavailable'
  }

  return (
    <section
      className="mt-5 space-y-3 border-t border-border pt-4"
      aria-label={t('codexQuota.title')}
    >
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('codexQuota.title')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('codexQuota.scope')}</p>
      </div>
      {status !== 'available' ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t(`codexQuota.${status}`)}
        </p>
      ) : (
        quota?.windows.map((window) => {
          const remaining =
            Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)) * 10) / 10
          const label = windowLabel(window)
          const reset = window.resetsAt == null ? null : new Date(window.resetsAt * 1000)
          return (
            <div key={window.id} className="space-y-1.5">
              <div className="flex flex-wrap justify-between gap-2 text-sm text-foreground">
                <span>{label}</span>
                <span>{t('codexQuota.remaining', { percent: remaining })}</span>
              </div>
              <div
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={remaining}
                aria-valuetext={t('codexQuota.remaining', { percent: remaining })}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${remaining}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {reset ? (
                  <>
                    {t('codexQuota.resetsAt')}{' '}
                    <time dateTime={reset.toISOString()}>
                      {reset.toLocaleString(i18n.language)}
                    </time>
                  </>
                ) : (
                  t('codexQuota.resetUnavailable')
                )}
              </p>
            </div>
          )
        })
      )}
    </section>
  )
}
