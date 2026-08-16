import {
  type AuthMode,
  PRESET_PROVIDERS,
  type ProviderCapabilities,
  type ProviderCredentialField,
  type ProviderKind,
  type ProviderManifest,
  isVersionAtLeast,
  providerKindSchema,
  providerManifestSchema,
} from '@a2wave/shared'
import type { AgentEngine, ListModelsOptions, LoginStatus, ModelListResult } from './types.js'

export interface ProviderBindingValidation {
  valid: boolean
  code?: 'unsupported_mode' | 'invalid_input'
  message?: string
  missingFields: ProviderCredentialField[]
}

export interface ProviderAdapter {
  readonly manifest: ProviderManifest
  attachEngine(engine: AgentEngine): void
  getEngine(): AgentEngine | undefined
  validateBinding(input: ListModelsOptions): ProviderBindingValidation
  probeModels(input: ListModelsOptions): Promise<ModelListResult>
  checkLoginStatus(): Promise<LoginStatus>
}

/**
 * Compare an installed CLI version against a Provider's minVersion floor.
 * Returns `{}` when no floor is configured, `{ minVersion }` alone when the
 * comparison is undecidable (unparsable version token), and both fields once
 * a verdict is possible.
 */
export function evaluateProviderVersion(
  version: string,
  minVersion: string | null,
): { minVersion?: string; versionOk?: boolean } {
  if (!minVersion) return {}
  const versionOk = isVersionAtLeast(version, minVersion)
  return versionOk === null ? { minVersion } : { minVersion, versionOk }
}

function missingCredentialFields(
  capabilities: ProviderCapabilities,
  input: ListModelsOptions,
): ProviderCredentialField[] {
  const fields = capabilities.credentialFields[input.authMode] ?? []
  return fields
    .filter((descriptor) => descriptor.required && !input[descriptor.field]?.trim())
    .map((descriptor) => descriptor.field)
}

class DefaultProviderAdapter implements ProviderAdapter {
  private engine?: AgentEngine

  constructor(readonly manifest: ProviderManifest) {}

  attachEngine(engine: AgentEngine): void {
    if (engine.type !== this.manifest.kind) {
      throw new Error(
        `Cannot attach engine "${engine.type}" to Provider adapter "${this.manifest.kind}"`,
      )
    }
    this.engine = engine
  }

  getEngine(): AgentEngine | undefined {
    return this.engine
  }

  validateBinding(input: ListModelsOptions): ProviderBindingValidation {
    const { capabilities } = this.manifest
    if (!capabilities.authModes.includes(input.authMode)) {
      return {
        valid: false,
        code: 'unsupported_mode',
        message: `${this.manifest.displayName} does not support auth mode "${input.authMode}"`,
        missingFields: [],
      }
    }

    const missingFields = missingCredentialFields(capabilities, input)
    if (missingFields.length > 0) {
      return {
        valid: false,
        code: 'invalid_input',
        message: `Missing required credentials: ${missingFields.join(', ')}`,
        missingFields,
      }
    }

    return { valid: true, missingFields: [] }
  }

  async probeModels(input: ListModelsOptions): Promise<ModelListResult> {
    const validation = this.validateBinding(input)
    if (!validation.valid) {
      return {
        models: [],
        code: validation.code,
        error: validation.message,
      }
    }

    const engine = this.requireEngine()
    if (!engine.listAvailableModels) {
      return {
        models: [],
        code: 'unsupported_mode',
        error: `Provider "${this.manifest.kind}" does not support model discovery`,
      }
    }
    return engine.listAvailableModels(input)
  }

  async checkLoginStatus(): Promise<LoginStatus> {
    const engine = this.requireEngine()
    if (!engine.checkLoginStatus) {
      throw new Error(`Provider "${this.manifest.kind}" does not support login-status detection`)
    }

    const versionProbe = engine.getVersion
      ? Promise.resolve()
          .then(() => engine.getVersion?.() ?? null)
          .catch(() => null)
      : Promise.resolve(null)
    const [status, version] = await Promise.all([engine.checkLoginStatus(), versionProbe])
    if (!version) return status

    status.version = version
    const { minVersion, versionOk } = evaluateProviderVersion(version, this.manifest.minVersion)
    if (minVersion === undefined) return status

    status.minVersion = minVersion
    if (versionOk === undefined) return status

    status.versionOk = versionOk
    if (!versionOk) {
      status.error = [
        status.error,
        `CLI version too old (installed ${version}, requires >= ${minVersion}); subcommands the engine depends on may be missing — please upgrade`,
      ]
        .filter(Boolean)
        .join('; ')
    }
    return status
  }

  private requireEngine(): AgentEngine {
    if (!this.engine) {
      throw new Error(`Provider adapter "${this.manifest.kind}" has no attached engine`)
    }
    return this.engine
  }
}

export function createProviderAdapter(manifest: ProviderManifest): ProviderAdapter {
  return new DefaultProviderAdapter(providerManifestSchema.parse(manifest))
}

export class ProviderCatalog {
  private readonly adapters = new Map<ProviderKind, ProviderAdapter>()

  register(adapter: ProviderAdapter): void {
    const { kind } = adapter.manifest
    if (this.adapters.has(kind)) throw new Error(`Provider adapter already registered: ${kind}`)
    this.adapters.set(kind, adapter)
  }

  get(kind: string): ProviderAdapter | undefined {
    const parsed = providerKindSchema.safeParse(kind)
    return parsed.success ? this.adapters.get(parsed.data) : undefined
  }

  getOrThrow(kind: string): ProviderAdapter {
    const adapter = this.get(kind)
    if (!adapter) throw new Error(`Unknown Provider kind: ${kind}`)
    return adapter
  }

  attachEngine(engine: AgentEngine): void {
    this.getOrThrow(engine.type).attachEngine(engine)
  }

  toProviderDto<T extends { kind: ProviderKind }>(
    provider: T,
  ): T & { minVersion: string | null; capabilities: ProviderCapabilities } {
    const { manifest } = this.getOrThrow(provider.kind)
    return {
      ...provider,
      minVersion: manifest.minVersion,
      capabilities: manifest.capabilities,
    }
  }
}

function manifest(kind: ProviderKind, capabilities: ProviderCapabilities): ProviderManifest {
  const preset = PRESET_PROVIDERS.find((provider) => provider.kind === kind)
  if (!preset) throw new Error(`Missing preset metadata for Provider kind: ${kind}`)
  return providerManifestSchema.parse({
    kind,
    displayName: preset.name,
    minVersion: preset.minVersion,
    capabilities,
  })
}

const required = (field: ProviderCredentialField) => ({ field, required: true })
const optional = (field: ProviderCredentialField) => ({ field, required: false })

export const BUILTIN_PROVIDER_MANIFESTS = {
  cursor: manifest('cursor', {
    authModes: ['apiKey', 'localSession'],
    defaultAuthMode: 'apiKey',
    modelDiscovery: { apiKey: 'manual', localSession: 'automatic' },
    credentialFields: { apiKey: [required('apiKey')] },
    mcpDelivery: { mode: 'workspace-file', defaultPath: '.cursor/mcp.json' },
    executionOptions: ['readOnly', 'force'],
    reasoningEffort: false,
    fastMode: false,
    sessionResume: true,
    sandbox: 'cli-controlled',
    localSessionLoginCommand: 'cursor-agent login',
    apiKeyEnvVar: 'CURSOR_API_KEY',
  }),
  'claude-code': manifest('claude-code', {
    authModes: ['apiKey', 'oauth', 'localSession'],
    defaultAuthMode: 'apiKey',
    modelDiscovery: { apiKey: 'manual', oauth: 'manual', localSession: 'automatic' },
    credentialFields: {
      apiKey: [required('apiKey'), required('baseUrl')],
      oauth: [required('oauthToken')],
    },
    mcpDelivery: { mode: 'workspace-file', defaultPath: '.mcp.json' },
    executionOptions: ['readOnly', 'force', 'approveMcps'],
    // `--effort` takes a level, and which levels are legal is a property of the
    // model, so the values are probed rather than declared. Fast mode is the
    // opposite: a plain switch (`--settings {"fastMode":true}`) with nothing to
    // discover — whether a run really gets the faster path depends on the model,
    // the plan and the endpoint, and the run reports that itself.
    reasoningEffort: true,
    fastMode: true,
    sessionResume: true,
    // Native OS-level sandbox: macOS Seatbelt / Linux bubblewrap; the platform can
    // force it on non-bypassably via managed settings.
    sandbox: 'native',
    localSessionLoginCommand: 'claude login',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  }),
  codex: manifest('codex', {
    authModes: ['apiKey', 'localSession'],
    defaultAuthMode: 'apiKey',
    modelDiscovery: { apiKey: 'automatic', localSession: 'automatic' },
    credentialFields: { apiKey: [required('apiKey'), optional('baseUrl')] },
    mcpDelivery: { mode: 'runtime-injection' },
    executionOptions: ['readOnly', 'force', 'cleanResult'],
    // `-c model_reasoning_effort=<level>`; the levels come from `codex debug
    // models`, which reports a different set per model. Fast mode is the
    // `priority` service tier — a switch, but one codex silently omits (with a
    // warning) when the selected model does not advertise it.
    reasoningEffort: true,
    fastMode: true,
    sessionResume: true,
    sandbox: 'native',
    localSessionLoginCommand: 'codex login',
    apiKeyEnvVar: 'OPENAI_API_KEY',
  }),
  opencode: manifest('opencode', {
    authModes: ['localSession'],
    defaultAuthMode: 'localSession',
    modelDiscovery: { localSession: 'automatic' },
    credentialFields: {},
    mcpDelivery: { mode: 'runtime-injection' },
    executionOptions: [],
    reasoningEffort: false,
    fastMode: false,
    sessionResume: true,
    // No OS-level sandbox — only an in-process tool-approval gate, no filesystem
    // or network isolation.
    sandbox: 'unsupported',
    localSessionLoginCommand: 'opencode auth login',
  }),
  qoder: manifest('qoder', {
    authModes: ['apiKey', 'localSession'],
    defaultAuthMode: 'apiKey',
    modelDiscovery: { apiKey: 'manual', localSession: 'automatic' },
    credentialFields: { apiKey: [required('apiKey')] },
    mcpDelivery: { mode: 'workspace-file', defaultPath: '.mcp.json' },
    executionOptions: ['readOnly', 'force', 'approveMcps'],
    reasoningEffort: false,
    fastMode: false,
    sessionResume: true,
    sandbox: 'cli-controlled',
    localSessionLoginCommand: 'qodercli login',
    apiKeyEnvVar: 'QODER_PERSONAL_ACCESS_TOKEN',
  }),
  trae: manifest('trae', {
    authModes: ['apiKey', 'localSession'],
    defaultAuthMode: 'apiKey',
    modelDiscovery: { apiKey: 'manual', localSession: 'automatic' },
    credentialFields: { apiKey: [required('apiKey'), optional('baseUrl')] },
    mcpDelivery: { mode: 'workspace-file', defaultPath: '.trae/mcp.json' },
    executionOptions: ['readOnly', 'force', 'approveMcps'],
    reasoningEffort: false,
    fastMode: false,
    sessionResume: true,
    sandbox: 'cli-controlled',
    localSessionLoginCommand: 'traecli',
    apiKeyEnvVar: 'TRAECLI_PERSONAL_ACCESS_TOKEN',
  }),
  kimi: manifest('kimi', {
    // localSession only: Kimi authenticates via device-code OAuth and, by
    // design, does not read API keys from the environment (they must live in
    // config.toml), so there is no per-agent credential channel to expose.
    authModes: ['localSession'],
    defaultAuthMode: 'localSession',
    modelDiscovery: { localSession: 'automatic' },
    credentialFields: {},
    mcpDelivery: { mode: 'workspace-file', defaultPath: '.kimi-code/mcp.json' },
    // `-p` rejects --yolo/--auto/--plan and always runs under the `auto`
    // permission policy, so readOnly/force/approveMcps have no valid flag.
    executionOptions: [],
    reasoningEffort: false,
    fastMode: false,
    sessionResume: true,
    // No OS-level sandbox — only an in-process approval gate, which `-p`
    // resolves automatically.
    sandbox: 'unsupported',
    localSessionLoginCommand: 'kimi login',
  }),
  pi: manifest('pi', {
    // API-key mode scopes the key and optional base URL to Pi's built-in OpenAI
    // provider, whose models are enumerated by the CLI. localSession keeps using
    // the deployment's multi-provider Pi auth store and remains the default for
    // backward compatibility with existing Agents.
    authModes: ['apiKey', 'localSession'],
    defaultAuthMode: 'localSession',
    modelDiscovery: { apiKey: 'manual', localSession: 'automatic' },
    credentialFields: { apiKey: [required('apiKey'), optional('baseUrl')] },
    // Pi intentionally ships without an MCP client. Extensions may implement
    // one, but silently installing code is outside the Provider contract.
    mcpDelivery: { mode: 'none' },
    executionOptions: ['readOnly'],
    reasoningEffort: false,
    fastMode: false,
    sessionResume: true,
    sandbox: 'unsupported',
    localSessionLoginCommand: 'pi',
  }),
} satisfies Record<ProviderKind, ProviderManifest>

export function createBuiltinProviderCatalog(): ProviderCatalog {
  const catalog = new ProviderCatalog()
  for (const providerManifest of Object.values(BUILTIN_PROVIDER_MANIFESTS)) {
    catalog.register(createProviderAdapter(providerManifest))
  }
  return catalog
}

export const providerCatalog = createBuiltinProviderCatalog()

export function providerSupportsAuthMode(
  capabilities: ProviderCapabilities,
  authMode: AuthMode,
): boolean {
  return capabilities.authModes.includes(authMode)
}
