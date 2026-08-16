import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import type { agents } from '../db/schema.js'
import { providers as providersTable } from '../db/schema.js'
import { evaluateProviderVersion, providerCatalog } from '../engine/provider-catalog.js'
import { buildAgentConfig } from './agent-helpers.js'
import { probeProviderCli } from './cli-installer.js'
import { ProviderBindingInvalidError, ProviderConfigurationError } from './errors.js'
import type { DiagnoseCheck } from './feishu-diagnose.js'

type AgentRow = typeof agents.$inferSelect

/**
 * Name the binary the way an operator would.
 *
 * `displayName` is the preset name, and seven of the eight already end in "CLI"
 * ("Qoder CLI"), so appending it unconditionally rendered "Qoder CLI CLI".
 * "Claude Code" is the one that still needs the suffix.
 */
function cliDisplayName(displayName: string): string {
  return displayName.endsWith(' CLI') ? displayName : `${displayName} CLI`
}

export async function collectAgentExecutionChecks(agent: AgentRow): Promise<DiagnoseCheck[]> {
  const checks: DiagnoseCheck[] = []

  // A broken provider chain is precisely what this endpoint exists to report, so
  // it must become a check rather than propagate: letting it throw turns the
  // diagnosis into a 409 and hides every other check the operator came for.
  let config: Awaited<ReturnType<typeof buildAgentConfig>>
  try {
    config = await buildAgentConfig(agent)
  } catch (err) {
    if (err instanceof ProviderBindingInvalidError) {
      return [
        {
          id: 'provider_binding_invalid',
          severity: 'error',
          message: err.message,
        },
      ]
    }
    if (err instanceof ProviderConfigurationError) {
      return [
        {
          id: 'provider_chain_unusable',
          severity: 'error',
          message: err.message,
        },
      ]
    }
    throw err
  }

  const providerId = String((await config).providerId ?? agent.providerId ?? '').trim()

  if (!providerId) {
    checks.push({
      id: 'provider_not_selected',
      severity: 'warn',
      message:
        'No execution Provider is selected. Bind a Provider on the configuration page so engine and model capabilities are resolved consistently.',
    })
    return checks
  }

  const provider = (
    await db.select().from(providersTable).where(eq(providersTable.id, providerId)).limit(1)
  )[0]
  if (!provider) {
    checks.push({
      id: 'provider_record_missing',
      severity: 'error',
      message: `The bound Provider (${providerId}) does not exist; select a Provider before running the Agent.`,
    })
    return checks
  }

  const adapter = providerCatalog.get(provider.kind)
  if (!adapter) {
    checks.push({
      id: 'provider_kind_invalid',
      severity: 'error',
      message: `The bound Provider (${providerId}) has an unsupported kind: ${provider.kind}. Apply the latest database migrations.`,
    })
    return checks
  }

  // The image ships no Provider CLI, so a fully-configured Agent still fails at
  // spawn time until someone installs one. Probe before the credential checks
  // below: without this the diagnosis reports all-green and the actual ENOENT
  // only surfaces mid-run, which is the confusing failure this check prevents.
  // Placed after the kind check so `adapter` is known valid, and before every
  // early return below so a missing CLI is never masked by an unrelated warning.
  // Probe the engine's own configured command when it exposes one: an engine can
  // be pointed at an explicit path (CLAUDE_CODE_PATH etc.), and probing the lock's
  // canonical name instead would report "installed" for a binary this Agent will
  // never actually spawn. Fall back to the lock probe when the engine has no
  // version probe of its own.
  const engineVersion = await adapter
    .getEngine()
    ?.getVersion?.()
    .catch(() => null)
  const cli =
    engineVersion === undefined
      ? await probeProviderCli(provider.kind)
      : { managed: true as const, version: engineVersion }
  if (cli.managed && cli.version === null) {
    checks.push({
      id: 'provider_cli_not_installed',
      severity: 'error',
      message: `${cliDisplayName(adapter.manifest.displayName)} is not installed, so every run fails at spawn. Install it from this Provider's page (admin), or point the deployment at an existing binary.`,
    })
  }

  if (cli.managed && cli.version) {
    const { minVersion, versionOk } = evaluateProviderVersion(
      cli.version,
      adapter.manifest.minVersion,
    )
    if (versionOk === false) {
      checks.push({
        id: 'provider_cli_version_below_minimum',
        severity: 'error',
        message: `The installed ${cliDisplayName(adapter.manifest.displayName)} is too old (installed ${cli.version}, requires >= ${minVersion}); subcommands or flags this Agent depends on may be missing, so a run can fail with an unclear CLI error. This does not block runs. Upgrade it from this Provider's page (admin), or point the deployment at a newer binary.`,
      })
    }
  }

  // Providers no longer carry a stored model catalog — the list is probed from
  // the CLI against the bound credentials — so the only model question left to
  // diagnose is whether this Agent actually picked one.
  const selectedModel = String(config.model ?? '').trim()
  if (!selectedModel) {
    checks.push({
      id: 'provider_no_model_selected',
      severity: 'warn',
      message:
        'No model is selected for this Provider. Open the configuration page, load the model list, and pick one before running the Agent.',
    })
  } else {
    checks.push({
      id: 'provider_bound_ok',
      severity: 'info',
      message: `Execution Provider "${provider.name}" (${providerId}) resolves to "${provider.kind}" with model "${selectedModel}".`,
    })
  }

  // A control stored against a Provider whose CLI has no such setting is dropped
  // silently at spawn time. The web form clears both when a chain entry changes
  // Provider, but an imported Agent or a direct API write can still leave one
  // behind, and diagnose is then the only place it would ever be noticed.
  //
  // EVERY entry is checked, not just the bound one. A control belongs to its
  // chain entry, so a mismatch on a fallback is just as real — and strictly
  // harder to notice, because it only bites once the primary has already failed
  // and nobody is watching that run closely.
  //
  // Each entry carries its own `providerKind`, so this costs no extra query.
  //
  // Whether the *model* accepts a given level is deliberately not checked here:
  // that answer only exists in a live probe, the model can still change mid-Run
  // through fallback, and the CLI already rejects a bad level with the accepted
  // set named in its error.
  const chain = Array.isArray(config.providerChain) ? config.providerChain : []
  const bindingsToCheck = chain.length > 0 ? chain : [config]
  for (const [index, binding] of bindingsToCheck.entries()) {
    const kind = 'providerKind' in binding ? binding.providerKind : provider.kind
    const manifest = providerCatalog.get(kind)?.manifest ?? adapter.manifest
    // Named only when there is more than one, so a single-Provider Agent keeps
    // the message it had.
    const where = bindingsToCheck.length > 1 ? ` on chain entry ${index + 1}` : ''
    const cliName = cliDisplayName(manifest.displayName)

    const configuredEffort = String(binding.reasoningEffort ?? '').trim()
    if (configuredEffort && !manifest.capabilities.reasoningEffort) {
      checks.push({
        id: 'provider_reasoning_effort_unsupported',
        severity: 'warn',
        message: `A reasoning level ("${configuredEffort}") is configured${where}, but ${cliName} has no such setting, so it is ignored on every run. Clear it, or bind a Provider that supports one.`,
      })
    }
    if (binding.fastMode === true && !manifest.capabilities.fastMode) {
      checks.push({
        id: 'provider_fast_mode_unsupported',
        severity: 'warn',
        message: `Fast mode is on${where}, but ${cliName} has no fast mode, so runs proceed at normal speed. Turn it off, or bind a Provider that supports one.`,
      })
    }
  }

  const authMode = (await config).authMode ?? adapter.manifest.capabilities.defaultAuthMode
  const credentials = {
    authMode,
    apiKey: (await config).providerApiKey,
    baseUrl: (await config).providerBaseUrl,
    oauthToken: (await config).providerOauthToken,
  }
  const validation = adapter.validateBinding(credentials)
  if (validation.code === 'unsupported_mode') {
    checks.push({
      id: 'provider_auth_mode_unsupported',
      severity: 'warn',
      message: `${adapter.manifest.displayName} does not support the "${authMode}" credential mode. Select one of the modes declared by this Provider.`,
    })
    return checks
  }

  if (authMode === 'localSession') {
    const command = adapter.manifest.capabilities.localSessionLoginCommand
    checks.push({
      id: 'provider_local_session_mode',
      severity: 'info',
      message: `${adapter.manifest.displayName} will use the process owner's local login session${command ? `; run \`${command}\` to sign in` : ''}.`,
    })
    return checks
  }

  const requiredFields = (adapter.manifest.capabilities.credentialFields[authMode] ?? [])
    .filter((descriptor) => descriptor.required)
    .map((descriptor) => descriptor.field)
  const missingFields = requiredFields.filter((field) => !credentials[field]?.trim())
  if (missingFields.length > 0) {
    const envVar = adapter.manifest.capabilities.apiKeyEnvVar
    checks.push({
      id: 'provider_credentials_from_environment',
      severity: 'info',
      message: `${adapter.manifest.displayName} is missing ${missingFields.join(', ')} in this binding and will rely on the process environment${envVar ? ` (for example, ${envVar})` : ''} or the CLI's default authentication.`,
    })
  } else {
    checks.push({
      id: 'provider_credentials_configured',
      severity: 'info',
      message: `${adapter.manifest.displayName} has all required credentials configured for this binding.`,
    })
  }

  return checks
}
