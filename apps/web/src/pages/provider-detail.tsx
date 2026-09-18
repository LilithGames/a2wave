import { AlertTriangle, ArrowLeft, Bot, Shield } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { CodexQuotaDisplay } from '@/components/codex-quota'
import {
  ProviderCliInstallControl,
  ProviderCliStatusChip,
} from '@/components/provider-cli-install-control'
import { getProviderIconSpec, PROVIDER_ICON_TILE } from '@/components/provider-icon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrentUser } from '@/hooks/use-auth'
import { useProviderClis } from '@/hooks/use-provider-clis'
import { useProvider, useProviderDependents } from '@/hooks/use-providers'

/**
 * Provider detail — read-only by design.
 *
 * Every field is owned by code: identity, scripts and paths come from the
 * preset definition, capabilities from the manifest, and the model catalog is
 * probed from the CLI against each Agent's own credentials (so it lives on the
 * Agent configuration page, not here). The only action left is installing or
 * updating the CLI that actually runs the Provider.
 */
export function ProviderDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  // Both hooks are gated on `enabled: !!id`, so an empty id parks the query
  // instead of firing a request for `/providers/undefined`.
  const providerId = id ?? ''
  const { data: provider, isLoading } = useProvider(providerId)
  const { data: dependents } = useProviderDependents(providerId)

  // Installing is admin-only, so only admins query it — the shared query client
  // retries, and an unguarded call would fire 403s for data a normal user can
  // never act on.
  const { data: currentUser } = useCurrentUser()
  const isAdmin = currentUser?.role === 'admin'
  const {
    data: cliData,
    isError: cliError,
    refetch: refetchClis,
  } = useProviderClis({ enabled: isAdmin })
  const cli = cliData?.data?.find((entry) => entry.kind === provider?.kind)

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full rounded-xl" />
      </div>
    )
  }

  if (!provider) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-muted-foreground mb-4">{t('providerDetail.notFound')}</p>
        <Link to="/providers">
          <Button variant="outline">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('providerDetail.backToProviders')}
          </Button>
        </Link>
      </div>
    )
  }

  const { Icon: ProviderBrandIcon, fgClass: providerFg } = getProviderIconSpec(provider.kind)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          to="/providers"
          className="flex size-8 items-center justify-center rounded-lg border border-border/50 text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors"
          aria-label={t('providerDetail.backToProviders')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {/* Same shared tile as the Providers list; see PROVIDER_ICON_TILE. */}
          <div
            className={`flex size-11 items-center justify-center rounded-xl shrink-0 ${PROVIDER_ICON_TILE} ${providerFg}`}
          >
            <ProviderBrandIcon className="size-8 rounded-lg object-contain" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight text-foreground truncate">
              {provider.name}
            </h2>
            <p className="text-xs text-muted-foreground/60 font-mono">{provider.id}</p>
          </div>
        </div>
        <Badge variant="secondary">{t('providerDetail.preset')}</Badge>
      </div>

      {/* Preset info banner */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 flex items-center gap-3">
        <Shield className="h-4 w-4 text-interactive-foreground shrink-0" aria-hidden="true" />
        <p className="text-sm text-foreground">{t('providerDetail.presetInfo')}</p>
      </div>

      {/* Basic Information */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('providerDetail.basicInfo')}</CardTitle>
          <CardDescription className="text-sm">{t('providerDetail.basicInfoDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{t('providerDetail.name')}</p>
            <p className="text-sm text-foreground">{provider.name}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{t('providerDetail.description')}</p>
            <p className="text-sm text-foreground" style={{ textWrap: 'pretty' }}>
              {provider.description || t('common.noDescription')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Models — probed per Agent, never stored on the Provider, so this card
          points at where the list actually comes from instead of showing a
          catalog that no credential was checked against. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('providerDetail.models')}</CardTitle>
          <CardDescription className="text-sm">{t('providerDetail.modelsDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground" style={{ textWrap: 'pretty' }}>
            {t('providerDetail.modelsProbedHint')}
          </p>
        </CardContent>
      </Card>

      {/* Agent CLI — the binary that actually runs this Provider. The image
          preinstalls none of them, so this is where an operator gets one.
          A failed catalog read still renders the card: folding it into "no CLI"
          would look identical to a healthy Provider while its Agents fail at
          spawn time with ENOENT, and would hide the install entry that replaced
          the standalone Agent CLI page. */}
      {isAdmin && (cli || cliError || provider.kind === 'codex') ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('providerDetail.agentCli')}</CardTitle>
            <CardDescription className="text-sm">
              {t('providerDetail.agentCliDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!cli && cliError ? (
              <div className="flex items-start gap-3" role="alert">
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">{t('providerClis.loadFailed')}</p>
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
            ) : cli ? (
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm text-foreground">{cli.binary}</code>
                    <ProviderCliStatusChip cli={cli} />
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {t('providerClis.lockedVersion', { version: cli.lockedVersion })}
                    {cli.installedVersion
                      ? ` · ${t('providerClis.installedVersion', { version: cli.installedVersion })}`
                      : null}
                  </p>
                  {cli.lastError ? (
                    <p className="mt-1.5 break-words text-xs text-destructive" role="alert">
                      {cli.lastError}
                    </p>
                  ) : null}
                </div>
                <ProviderCliInstallControl cli={cli} showUninstall />
              </div>
            ) : null}
            {provider.kind === 'codex' ? <CodexQuotaDisplay providerId={providerId} /> : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Environment Scripts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('providerDetail.envScripts')}</CardTitle>
          <CardDescription className="text-sm">
            {t('providerDetail.envScriptsDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">{t('providerDetail.initScript')}</p>
            <code className="block break-all rounded-md bg-muted/60 px-3 py-2 font-mono text-sm text-foreground">
              {provider.initScript || '—'}
            </code>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">{t('providerDetail.checkScript')}</p>
            <code className="block break-all rounded-md bg-muted/60 px-3 py-2 font-mono text-sm text-foreground">
              {provider.checkScript || '—'}
            </code>
          </div>
        </CardContent>
      </Card>

      {/* Dependent Agents */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('providerDetail.dependentAgents')}</CardTitle>
          <CardDescription className="text-sm">
            {t('providerDetail.dependentAgentsDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!dependents?.agents?.length ? (
            <p className="text-sm text-muted-foreground/60 italic">
              {t('providerDetail.noDependentAgents')}
            </p>
          ) : (
            <div className="space-y-2">
              {dependents.agents.map((agent) => (
                /* `text-foreground` is not decorative: antd's static feedback
                   instances inject an unlayered `a` reset that outranks every
                   layered rule, so an unstyled link here renders browser-blue
                   and ignores the design tokens. */
                <Link
                  key={agent.id}
                  to={`/agents/${agent.id}`}
                  className="flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2 text-foreground hover:bg-surface-hover hover:text-foreground transition-colors"
                >
                  <Bot className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
                  <span className="text-sm font-medium truncate">{agent.name}</span>
                  <span className="text-2xs text-muted-foreground/50 font-mono ml-auto shrink-0">
                    {agent.id}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
