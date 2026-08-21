import { AlertTriangle, Blocks } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  needsInstallAction,
  ProviderCliInstallControl,
  ProviderCliStatusChip,
} from '@/components/provider-cli-install-control'
import { getProviderIconSpec, PROVIDER_ICON_TILE } from '@/components/provider-icon'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrentUser } from '@/hooks/use-auth'
import { useProviderClis } from '@/hooks/use-provider-clis'
import { useProviders, useUnsupportedProviders } from '@/hooks/use-providers'

/**
 * Base chip shape — reused from the former "Preset" tag for visual consistency.
 *
 * Deliberately not `uppercase tracking-wide font-semibold`: at a fixed 11px those
 * three together made English chips read as oversized (caps are wider and have no
 * descenders, letter-spacing widens them further, and the heavy weight shouts).
 * Chinese has no case, so the problem only showed up in the English UI.
 */
const CHIP_BASE =
  'inline-flex items-center whitespace-nowrap rounded-md border border-transparent px-2 py-0.5 text-[11px] font-medium'
/** Neutral chip (min version) keeps the original preset-tag color. */
const CHIP_NEUTRAL = `${CHIP_BASE} bg-primary/10 text-interactive-foreground`

/**
 * Sandbox capability → badge label + hint + tier color. The color encodes the
 * safety tier so it reads at a glance: system sandbox = success (safe), CLI-only
 * = warning (partial), none = destructive (no isolation).
 */
const SANDBOX_BADGE: Record<string, { labelKey: string; hintKey: string; className: string }> = {
  native: {
    labelKey: 'providers.capSandboxNative',
    hintKey: 'providers.capSandboxNativeHint',
    className: `${CHIP_BASE} bg-success/10 text-success`,
  },
  'cli-controlled': {
    labelKey: 'providers.capSandboxCli',
    hintKey: 'providers.capSandboxCliHint',
    className: `${CHIP_BASE} bg-warning/10 text-warning`,
  },
  unsupported: {
    labelKey: 'providers.capSandboxNone',
    hintKey: 'providers.capSandboxNoneHint',
    className: `${CHIP_BASE} bg-destructive/10 text-destructive`,
  },
}

export function ProvidersPage() {
  const { t } = useTranslation()
  const { data: providers, isLoading } = useProviders()
  const { data: unsupportedProviders } = useUnsupportedProviders()
  // Installing is admin-only, so only admins query it; other users' cards simply
  // omit the CLI row rather than firing 403s for data they cannot act on.
  const { data: currentUser } = useCurrentUser()
  const {
    data: cliData,
    isError: cliError,
    refetch: refetchClis,
  } = useProviderClis({ enabled: currentUser?.role === 'admin' })
  const cliByKind = new Map((cliData?.data ?? []).map((cli) => [cli.kind, cli]))

  return (
    <div className="space-y-6">
      <div>
        <h2
          className="text-2xl font-semibold tracking-tight text-foreground"
          style={{ textWrap: 'balance' }}
        >
          {t('providers.title')}
        </h2>
        <p className="text-sm text-muted-foreground mt-1.5">{t('providers.subtitle')}</p>
      </div>

      {/* Without this, a failed CLI catalog read renders identically to "every
          CLI is fine" — no card shows a CLI row at all — while every Agent bound
          to an uninstalled Provider fails at spawn time with ENOENT. */}
      {cliError ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-foreground">{t('providerClis.loadFailed')}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => refetchClis()}
              >
                {t('providerClis.retry')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {unsupportedProviders && unsupportedProviders.length > 0 ? (
        <div
          role="alert"
          className="rounded-xl border border-warning/30 bg-warning-subtle p-4 text-sm"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-medium text-foreground">{t('providers.unsupportedTitle')}</p>
              <p className="mt-1 text-muted-foreground">{t('providers.unsupportedDescription')}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs text-foreground">
                {unsupportedProviders.map((provider) => (
                  <li key={provider.id}>
                    {provider.name} ({provider.kind})
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-live="polite">
          <span className="sr-only">{t('common.loading')}</span>
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder, fixed count
            <Card key={i}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Skeleton className="size-10 rounded-xl" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-full mb-2" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : providers?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20 px-8">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-gradient-subtle text-interactive-foreground mb-5">
              <Blocks className="h-7 w-7" aria-hidden="true" />
            </div>
            <h3 className="font-semibold text-base mb-1 text-foreground">
              {t('providers.emptyTitle')}
            </h3>
            <p
              className="text-sm text-muted-foreground text-center max-w-xs"
              style={{ textWrap: 'pretty' }}
            >
              {t('providers.emptyDesc')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {providers?.map((provider) => {
            const { Icon, fgClass } = getProviderIconSpec(provider.kind)
            const cli = cliByKind.get(provider.kind)
            return (
              /* The install action must not live inside the card's <Link>: a
                 <button> nested in an <a> is invalid, and it only avoids
                 navigating on click because the control stop-propagates. That
                 makes the next button added here silently navigate away. The
                 link wraps the navigational content only. */
              <Card
                key={provider.id}
                className="group h-full flex flex-col hover:border-primary/15 transition-colors focus-within:ring-2 focus-within:ring-ring"
              >
                <Link
                  to={`/providers/${provider.id}`}
                  className="flex flex-1 flex-col cursor-pointer focus-visible:outline-none"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`flex size-11 items-center justify-center rounded-xl shrink-0 ${PROVIDER_ICON_TILE} ${fgClass}`}
                      >
                        <Icon className="size-8 rounded-lg object-contain" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="text-base truncate font-semibold">
                          {provider.name}
                        </CardTitle>
                        <CardDescription className="text-xs mt-0.5 font-mono">
                          {provider.kind}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pb-0">
                    <p
                      className="text-sm text-muted-foreground line-clamp-2 leading-relaxed"
                      style={{ textWrap: 'pretty' }}
                    >
                      {provider.description || t('common.noDescription')}
                    </p>
                  </CardContent>
                </Link>
                {/* Two fixed-height rows at the card's foot — tags, then the CLI
                    action — pinned by mt-auto so every card in the grid shares a
                    baseline. Sharing one row could not: a variable number of
                    chips beside a variable-width button wraps on some cards and
                    not others, which is what left the grid ragged.

                    The action sits outside the <Link> because a <button> inside
                    an <a> is invalid — which is also why it cannot simply be
                    folded into the link's content above. */}
                <CardContent className="mt-auto pt-4">
                  {/* One chip line is reserved, and the row grows if a card needs
                      a second. Reserving two unconditionally kept the baselines
                      aligned but left a blank line above the button on every card
                      whose chips fit on one — which is most of them at any width
                      wide enough to matter. */}
                  <div className="flex min-h-6 flex-wrap content-start items-start gap-1.5">
                    {(() => {
                      const sandbox = provider.capabilities?.sandbox
                      const badge = sandbox ? SANDBOX_BADGE[sandbox] : undefined
                      return badge ? (
                        <span className={badge.className} title={t(badge.hintKey)}>
                          {t(badge.labelKey)}
                        </span>
                      ) : null
                    })()}
                    {provider.minVersion ? (
                      <span className={CHIP_NEUTRAL}>
                        {t('providers.minVersion', { version: provider.minVersion })}
                      </span>
                    ) : null}
                    {/* "Not installed" is omitted here on purpose: the Install
                        button below already says it, and stacking both made the
                        state read as two separate problems. The other states
                        have no button, so their chip is the only signal. */}
                    {cli?.installed ? <ProviderCliStatusChip cli={cli} /> : null}
                  </div>
                  {/* Always occupies its slot, so an installed CLI (no action)
                      and a missing one keep the same card height. */}
                  <div className="mt-1.5 flex min-h-7 items-center gap-1.5">
                    {/* A failed install returns 202 and reports itself only here,
                        so without this the card would look exactly as it did
                        before the click and the operator would just retry
                        forever. Reduced to an icon: the full message is far too
                        long for this row, and truncating it informed nobody. */}
                    {cli && needsInstallAction(cli) ? (
                      <>
                        {cli.lastError ? (
                          // The tooltip rides on a wrapper: lucide icons take no
                          // `title` prop, and passing one silently drops it.
                          <span className="flex shrink-0 items-center" title={cli.lastError}>
                            <AlertTriangle
                              className="size-3.5 text-destructive"
                              aria-label={cli.lastError}
                            />
                          </span>
                        ) : null}
                        <ProviderCliInstallControl cli={cli} />
                      </>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
