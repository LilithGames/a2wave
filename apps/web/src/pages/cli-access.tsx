import { useTranslation } from 'react-i18next'
import { CliTokensCard } from '@/components/cli-tokens-card'

/**
 * CLI access, on its own route rather than only inside Settings.
 *
 * A CLI token is a personal credential — the API scopes every route to the caller,
 * so even an admin manages only their own. Settings is reachable from the sidebar
 * for admins alone, which would have left ordinary users with no way to discover a
 * feature that exists precisely for them.
 */
export function CliAccessPage() {
  const { t } = useTranslation()

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="text-xl font-semibold text-foreground">{t('cli.title')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('cli.pageDesc')}</p>
      <div className="mt-6">
        <CliTokensCard />
      </div>
    </div>
  )
}
