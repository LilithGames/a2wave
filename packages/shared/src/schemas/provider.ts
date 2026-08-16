import { z } from 'zod'
import { authModeEnum } from './agent.js'

// ============================================================
// Provider — execution engine environment configuration
// ============================================================

/**
 * Stable runtime identity. Display names are intentionally not part of engine dispatch.
 *
 * A kind may only be listed here if its CLI can enumerate the models available
 * to the bound credentials at runtime — see `providerModelDiscoverySchema`.
 * `copilot` was retired for exactly that reason: the GitHub Copilot CLI ships no
 * model-listing command, so its catalog could only ever be a hand-maintained
 * constant that silently drifts from what the account can actually run.
 */
export const PROVIDER_KINDS = [
  'cursor',
  'claude-code',
  'codex',
  'opencode',
  'qoder',
  'trae',
  'kimi',
  'pi',
] as const
export const providerKindSchema = z.enum(PROVIDER_KINDS)
export type ProviderKind = z.infer<typeof providerKindSchema>

/**
 * How a Provider discovers the models a given credential can run.
 *
 * Being able to enumerate models is a **hard requirement** for a Provider, so
 * the only axis left is *when* the probe runs: `automatic` fires on mount,
 * `manual` waits for the operator to supply credentials and press the button.
 * There is deliberately no `static` or `unsupported` member — a Provider that
 * cannot answer "which models may this credential use?" cannot be onboarded,
 * which is what keeps the model list truthful instead of a stale constant.
 */
export const providerModelDiscoverySchema = z.enum(['automatic', 'manual'])
export type ProviderModelDiscovery = z.infer<typeof providerModelDiscoverySchema>

export const providerCredentialFieldSchema = z.enum(['apiKey', 'baseUrl', 'oauthToken'])
export type ProviderCredentialField = z.infer<typeof providerCredentialFieldSchema>

export const providerExecutionOptionSchema = z.enum([
  'readOnly',
  'force',
  'approveMcps',
  'cleanResult',
])
export type ProviderExecutionOption = z.infer<typeof providerExecutionOptionSchema>

const authModeCapabilitiesSchema = z.object({
  apiKey: providerModelDiscoverySchema.optional(),
  oauth: providerModelDiscoverySchema.optional(),
  localSession: providerModelDiscoverySchema.optional(),
})

export const providerCredentialDescriptorSchema = z.object({
  field: providerCredentialFieldSchema,
  required: z.boolean(),
})
export type ProviderCredentialDescriptor = z.infer<typeof providerCredentialDescriptorSchema>

const credentialFieldsSchema = z.object({
  apiKey: z.array(providerCredentialDescriptorSchema).optional(),
  oauth: z.array(providerCredentialDescriptorSchema).optional(),
  localSession: z.array(providerCredentialDescriptorSchema).optional(),
})

export const providerMcpDeliverySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('workspace-file'), defaultPath: z.string().min(1) }),
  z.object({ mode: z.literal('runtime-injection') }),
  z.object({ mode: z.literal('none') }),
])
export type ProviderMcpDelivery = z.infer<typeof providerMcpDeliverySchema>

export const providerCapabilitiesSchema = z
  .object({
    authModes: z.array(authModeEnum).min(1),
    defaultAuthMode: authModeEnum,
    modelDiscovery: authModeCapabilitiesSchema,
    credentialFields: credentialFieldsSchema,
    mcpDelivery: providerMcpDeliverySchema,
    executionOptions: z.array(providerExecutionOptionSchema),
    /**
     * Whether the CLI accepts a reasoning-effort setting at all. Only that —
     * *which* levels are legal is reported per model by discovery, never
     * declared here. The flag exists so the UI can tell "this Provider has no
     * such knob" apart from "it has one but this credential could not be
     * probed"; the two deserve different treatment and look identical without it.
     */
    reasoningEffort: z.boolean(),
    /**
     * Whether the CLI accepts a fast-mode switch. Unlike effort this is a plain
     * boolean with nothing to discover, so a static declaration is the whole
     * story. Whether a given run actually gets the faster path depends on the
     * model, the account tier and the endpoint, and is reported by the run
     * itself rather than predicted here.
     */
    fastMode: z.boolean(),
    sessionResume: z.boolean(),
    sandbox: z.enum(['native', 'cli-controlled', 'unsupported']),
    localSessionLoginCommand: z.string().min(1).optional(),
    apiKeyEnvVar: z.string().min(1).optional(),
  })
  .superRefine((capabilities, ctx) => {
    const seen = new Set<string>()
    for (const [index, authMode] of capabilities.authModes.entries()) {
      if (seen.has(authMode)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['authModes', index],
          message: `Duplicate auth mode: ${authMode}`,
        })
      }
      seen.add(authMode)
      if (!capabilities.modelDiscovery[authMode]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modelDiscovery', authMode],
          message: `Missing model discovery strategy for auth mode: ${authMode}`,
        })
      }
    }
    if (!capabilities.authModes.includes(capabilities.defaultAuthMode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultAuthMode'],
        message: 'Default auth mode must be included in authModes',
      })
    }

    for (const authMode of authModeEnum.options) {
      const credentialDescriptors = capabilities.credentialFields[authMode] ?? []
      if (!capabilities.authModes.includes(authMode)) {
        if (capabilities.modelDiscovery[authMode] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['modelDiscovery', authMode],
            message: `Model discovery is defined for unsupported auth mode: ${authMode}`,
          })
        }
        if (credentialDescriptors.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['credentialFields', authMode],
            message: `Credential fields are defined for unsupported auth mode: ${authMode}`,
          })
        }
      }

      const seenFields = new Set<ProviderCredentialField>()
      for (const [index, descriptor] of credentialDescriptors.entries()) {
        if (seenFields.has(descriptor.field)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['credentialFields', authMode, index, 'field'],
            message: `Duplicate credential field for ${authMode}: ${descriptor.field}`,
          })
        }
        seenFields.add(descriptor.field)
      }
    }
  })
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>

export const providerManifestSchema = z.object({
  kind: providerKindSchema,
  displayName: z.string().min(1),
  minVersion: z.string().min(1).nullable(),
  capabilities: providerCapabilitiesSchema,
})
export type ProviderManifest = z.infer<typeof providerManifestSchema>

export const providerSchema = z.object({
  id: z.string(),
  kind: providerKindSchema,
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
  /** Built-in preset that cannot be modified or deleted. */
  isPreset: z.boolean().default(false),
  /** Initialization script that installs engine dependencies. */
  initScript: z.string().nullable().optional(),
  /** Probe script that verifies the engine is installed, for example `xxx --version`. */
  checkScript: z.string().nullable().optional(),
  /** Skill synchronization root relative to workDir; null means prompt injection. */
  skillsDir: z.string().nullable().optional(),
  /** MCP configuration path relative to workDir. */
  mcpConfigPath: z.string().nullable().optional(),
  /** Provider-specific extension configuration. */
  config: z.record(z.unknown()).nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type Provider = z.infer<typeof providerSchema>

/** API projection: persisted Provider data enriched with code-owned capabilities. */
export const providerDtoSchema = providerSchema.extend({
  minVersion: z.string().min(1).nullable(),
  capabilities: providerCapabilitiesSchema,
})
export type ProviderDto = z.infer<typeof providerDtoSchema>

export const unsupportedProviderDiagnosticSchema = z.object({
  code: z.literal('PROVIDER_KIND_UNSUPPORTED'),
  message: z.string().min(1),
})
export type UnsupportedProviderDiagnostic = z.infer<typeof unsupportedProviderDiagnosticSchema>

/**
 * Read-only placeholder returned by list APIs when persisted data references an
 * engine kind that this application version cannot execute.
 */
export const unsupportedProviderDtoSchema = providerSchema.omit({ kind: true }).extend({
  kind: z.string().min(1),
  status: z.literal('unsupported'),
  diagnostic: unsupportedProviderDiagnosticSchema,
})
export type UnsupportedProviderDto = z.infer<typeof unsupportedProviderDtoSchema>

export const providerListItemSchema = z.union([providerDtoSchema, unsupportedProviderDtoSchema])
export type ProviderListItem = z.infer<typeof providerListItemSchema>

// ============================================================
// Preset Provider definitions
// ============================================================

/**
 * Definition used to seed a preset Provider.
 *
 * Deliberately carries no model catalog: the list of models an Agent may pick
 * is probed from the CLI against the bound credentials, never seeded. See
 * `providerModelDiscoverySchema`.
 */
export interface PresetProvider {
  kind: ProviderKind
  name: string
  description: string
  initScript: string
  checkScript: string
  skillsDir: string | null
  mcpConfigPath: string | null
  /**
   * Minimum required CLI version (null = no check). Below this version the
   * subcommands/flags the engine depends on may not exist (e.g. qodercli 0.x
   * has neither `status` nor `--list-models`). Login-status probes attach the
   * installed version and the comparison result so UI/CLI can suggest upgrading.
   *
   * Raise this whenever an engine adapter starts depending on a newer CLI
   * capability. `apps/api/src/engine/__tests__/cli-invocation-surface.test.ts`
   * snapshots each adapter's CLI tokens and fails on drift to force that check.
   *
   * The snapshot catches drift but cannot decide whether a floor is *right*.
   * To check one against reality, run `pnpm provider-min-versions:verify` — it
   * installs the declared floor from npm and confirms it accepts every flag the
   * adapter passes. A floor set too LOW is the dangerous case: users clear the
   * version gate, then fail at spawn time on a flag their CLI does not have.
   */
  minVersion: string | null
}

const PRESET_PROVIDER_DEFS: PresetProvider[] = [
  {
    kind: 'cursor',
    name: 'Cursor CLI',
    description: 'Cursor Agent CLI — AI-powered coding agent',
    initScript: 'curl https://cursor.com/install -fsS | bash',
    checkScript: 'cursor-agent --version',
    skillsDir: '.cursor/skills',
    mcpConfigPath: '.cursor/mcp.json',
    minVersion: null,
  },
  {
    kind: 'claude-code',
    name: 'Claude Code',
    description: 'Claude Code CLI — Anthropic AI coding agent',
    initScript: 'curl -fsSL https://claude.ai/install.sh | bash',
    checkScript: 'claude --version',
    skillsDir: '.claude/skills',
    mcpConfigPath: '.mcp.json',
    // `--effort` first shipped in 2.1.47 (2.1.45 rejects it; 2.1.46 was never
    // published). An unknown option is fatal to the CLI's argument parser, so a
    // build below this floor fails at spawn the moment an Agent configures a
    // reasoning level. `--settings` is older and already present at that
    // version, so one floor covers both. The floor guards the FLAG only: which
    // levels are legal is a property of the model and is discovered per
    // credential — 2.1.47 itself advertised just low/medium/high.
    minVersion: '2.1.47',
  },
  {
    kind: 'codex',
    name: 'Codex CLI',
    description: 'OpenAI Codex CLI — GPT-powered coding agent',
    initScript: 'npm i -g @openai/codex',
    checkScript: 'codex --version',
    skillsDir: '.codex/skills',
    // Codex does not read a workspace-local JSON mcp file. a2wave injects the
    // selected MCP servers into `codex exec` with `-c mcp_servers=...` per run.
    mcpConfigPath: null,
    minVersion: null,
  },
  {
    kind: 'opencode',
    name: 'OpenCode CLI',
    description: 'OpenCode CLI — open-source multi-provider coding agent',
    initScript: 'curl -fsSL https://opencode.ai/install | bash',
    checkScript: 'opencode --version',
    skillsDir: '.opencode/skills',
    // OpenCode reads MCP servers from its config. a2wave injects the selected
    // MCP servers per run via the `OPENCODE_CONFIG_CONTENT` env var (merged
    // with the user's global config), so no workspace file is written.
    mcpConfigPath: null,
    // OPENCODE_CONFIG_CONTENT merge semantics verified on 1.18.x.
    minVersion: '1.18.0',
  },
  {
    kind: 'qoder',
    name: 'Qoder CLI',
    description: 'Qoder CLI — Qoder AI coding agent (Claude-Code-compatible stream-json)',
    initScript: 'npm i -g @qoder-ai/qodercli',
    checkScript: 'qodercli --version',
    skillsDir: '.qoder/skills',
    // Qoder reads the project-shared `.mcp.json` (same convention as Claude
    // Code); a2wave syncs agent-scoped MCP servers into it per run.
    mcpConfigPath: '.mcp.json',
    // `qodercli status` / `--list-models` only exist on 1.x (0.2.x lacks both).
    minVersion: '1.0.0',
  },
  {
    kind: 'kimi',
    name: 'Kimi Code CLI',
    description: 'Kimi Code CLI — Moonshot AI coding agent',
    // npm, not the official `curl | bash`: that installer pins no version, so
    // an operator following the Provider page could land on a build newer than
    // the container's, while everything here (stream-json, `provider list
    // --json`, minVersion) is verified against 0.30.0. The npm package is the
    // same artifact provider-cli-lock.json pins, and is what codex/qoder do.
    // It also works on Alpine/musl, which the native installer refuses.
    initScript: 'npm i -g @moonshot-ai/kimi-code',
    checkScript: 'kimi --version',
    // Project-level Kimi-specific skills; `.agents/skills` is also scanned but
    // is the cross-tool shared location, so a2wave writes the Kimi-owned tier.
    skillsDir: '.kimi-code/skills',
    // Kimi reads the project-local `.kimi-code/mcp.json` (standard `mcpServers`
    // shape), merged over the user-level `$KIMI_CODE_HOME/mcp.json`.
    mcpConfigPath: '.kimi-code/mcp.json',
    // `--output-format stream-json` and `provider list --json` verified on 0.30.0.
    minVersion: '0.30.0',
  },
  {
    kind: 'pi',
    name: 'Pi CLI',
    description: 'Pi CLI — minimal multi-provider coding agent',
    // Pi's official npm install disables lifecycle scripts. Keep the preset
    // aligned with the pinned runtime installer below.
    initScript: 'npm i -g --ignore-scripts @earendil-works/pi-coding-agent',
    checkScript: 'pi --version',
    // a2wave explicitly passes this directory with `--skill`; project trust
    // therefore cannot hide the selected Agent skills in headless runs.
    skillsDir: '.pi/skills',
    // Pi deliberately has no built-in MCP client. Extensions can add one, but
    // a2wave does not install or trust an arbitrary extension implicitly.
    mcpConfigPath: null,
    // JSON mode, exact session IDs and `--list-models` are verified on 0.83.0.
    minVersion: '0.83.0',
  },
  {
    kind: 'trae',
    name: 'Trae CLI',
    description: 'Trae CLI — ByteDance Trae enterprise coding agent',
    initScript: 'sh -c "$(curl -fsSL https://trae.cn/trae-cli/install.sh)"',
    checkScript: 'traecli --version',
    skillsDir: '.traecli/skills',
    // Trae reads the project-level `.trae/mcp.json` (TRAE IDE compatible,
    // standard `mcpServers` shape); a2wave syncs agent-scoped servers into it.
    mcpConfigPath: '.trae/mcp.json',
    // `--output-format stream-json` / `models` subcommand verified on 0.120.x
    // (docs-era builds only had monolithic `--json`).
    minVersion: '0.120.0',
  },
]

/** Preset providers, alphabetical by name (drives seeding and any list display). */
export const PRESET_PROVIDERS: PresetProvider[] = [...PRESET_PROVIDER_DEFS].sort((a, b) =>
  a.name.localeCompare(b.name),
)

// Providers are entirely preset-owned: identity, scripts and paths come from
// PRESET_PROVIDERS, capabilities from the code-owned manifest, and the model
// catalog is probed live from the CLI. Nothing is left for an operator to edit,
// so there is no update input and no PATCH route.

// ============================================================
// Provider Dependents (agents referencing this provider)
// ============================================================

export const providerDependentsSchema = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
})

export type ProviderDependents = z.infer<typeof providerDependentsSchema>
