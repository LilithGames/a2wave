import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

const mockBuildAgentConfig = vi.hoisted(() => vi.fn())
const mockProviderGet = vi.hoisted(() => vi.fn())

vi.mock('../agent-helpers.js', () => ({
  buildAgentConfig: (agent: unknown) => mockBuildAgentConfig(agent),
}))

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          asyncQuery({
            get: () => mockProviderGet(),
          }),
      }),
    }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  providers: { id: 'providers.id' },
}))

// Default to an installed CLI so the pre-existing cases keep asserting what they
// were written for; the not-installed case overrides it explicitly.
const mockProbeProviderCli = vi.hoisted(() => vi.fn())
vi.mock('../cli-installer.js', () => ({
  probeProviderCli: (kind: string) => mockProbeProviderCli(kind),
}))

import type { agents } from '../../db/schema.js'
import { asyncQuery } from '../../test/async-query.js'
import { collectAgentExecutionChecks } from '../agent-execution-diagnose.js'
import {
  ProviderBindingInvalidError,
  ProviderMcpUnsupportedError,
  UnusableProviderChainError,
} from '../errors.js'

type AgentRow = typeof agents.$inferSelect

function row(p: Partial<AgentRow> & { id: string }): AgentRow {
  return p as AgentRow
}

describe('collectAgentExecutionChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProbeProviderCli.mockResolvedValue({ managed: true, version: '1.0.0' })
  })

  it('reports when no Provider is selected', async () => {
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor' })
    const checks = await collectAgentExecutionChecks(
      row({
        id: 'a1',
        providerId: null,
        type: 'cursor',
        providerApiKey: null,
      }),
    )
    expect(checks.some((c) => c.id === 'provider_not_selected' && c.severity === 'warn')).toBe(true)
  })

  // Diagnosing a broken config is the whole point of this endpoint, so an
  // unusable chain has to come back as a check. Letting it propagate turns the
  // diagnosis itself into a 409 — the operator gets no checks at all, precisely
  // when they most need them.
  it('reports an unusable provider chain as a check instead of throwing', async () => {
    mockBuildAgentConfig.mockImplementation(() => {
      throw new UnusableProviderChainError('agt_1')
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'agt_1', providerId: null, type: 'cursor', providerApiKey: null }),
    )

    expect(checks.some((c) => c.id === 'provider_chain_unusable' && c.severity === 'error')).toBe(
      true,
    )
  })

  it('reports unsupported Provider MCP delivery as a check instead of throwing', async () => {
    mockBuildAgentConfig.mockImplementation(() => {
      throw new ProviderMcpUnsupportedError('agt_1', 'prv_pi', 'pi', 'Pi CLI')
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'agt_1', providerId: 'prv_pi', type: 'llm', providerApiKey: null }),
    )

    expect(checks).toEqual([
      expect.objectContaining({ id: 'provider_chain_unusable', severity: 'error' }),
    ])
  })

  it('reports an invalid Provider binding as an actionable error check', async () => {
    mockBuildAgentConfig.mockImplementation(() => {
      throw new ProviderBindingInvalidError(
        'agt_1',
        'pc_pi',
        'prv_pi',
        'pi',
        'Pi CLI',
        'invalid_input',
        ['apiKey'],
        'Missing required credentials: apiKey',
      )
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'agt_1', providerId: 'prv_pi', type: 'llm', providerApiKey: null }),
    )

    expect(checks).toEqual([
      expect.objectContaining({ id: 'provider_binding_invalid', severity: 'error' }),
    ])
  })

  it('reports when the Provider record is missing', async () => {
    mockBuildAgentConfig.mockReturnValue({})
    mockProviderGet.mockReturnValue(undefined)
    const checks = await collectAgentExecutionChecks(
      row({
        id: 'a1',
        providerId: 'prv_missing',
        type: 'cursor',
        providerApiKey: 'k',
      }),
    )
    expect(checks.some((c) => c.id === 'provider_record_missing' && c.severity === 'error')).toBe(
      true,
    )
  })

  it('reports when the Agent has selected no model', async () => {
    // Providers carry no stored catalog any more — models are probed per
    // credential — so the diagnosable condition is an unset Agent model.
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor' })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'cursor',
      name: 'Cursor CLI',
    })
    const checks = await collectAgentExecutionChecks(
      row({
        id: 'a1',
        providerId: 'prv_1',
        type: 'cursor',
        providerApiKey: 'secret',
      }),
    )
    expect(checks.some((c) => c.id === 'provider_no_model_selected' && c.severity === 'warn')).toBe(
      true,
    )
    expect(checks.some((c) => c.id === 'engine_cursor_no_agent_api_key')).toBe(false)
  })

  it('reports a missing Provider CLI as an error', async () => {
    // The image preinstalls no CLI, so this is the difference between a diagnosis
    // that explains the problem and one that is green while every run ENOENTs.
    mockProbeProviderCli.mockResolvedValue({ managed: true, version: null })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor' })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'cursor',
      name: 'Cursor CLI',
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'secret' }),
    )

    expect(
      checks.some((c) => c.id === 'provider_cli_not_installed' && c.severity === 'error'),
    ).toBe(true)

    // 'Cursor CLI' already carries the suffix; appending it rendered
    // "Cursor CLI CLI". Its sibling check states that it does not block runs,
    // so this one states the consequence too rather than implying a gate.
    const missing = checks.find((c) => c.id === 'provider_cli_not_installed')
    expect(missing?.message).toContain('Cursor CLI is not installed')
    expect(missing?.message).not.toContain('CLI CLI')
    expect(missing?.message).not.toContain('before running this Agent')
  })

  it('still reports a missing CLI when the Agent has selected no model', async () => {
    // A missing CLI is the more fundamental blocker and must not be masked by
    // the unset-model warning.
    mockProbeProviderCli.mockResolvedValue({ managed: true, version: null })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor' })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'cursor',
      name: 'Cursor CLI',
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'secret' }),
    )

    expect(checks.some((c) => c.id === 'provider_cli_not_installed')).toBe(true)
    expect(checks.some((c) => c.id === 'provider_no_model_selected')).toBe(true)
  })

  it("prefers the engine's configured command over the lock's canonical name", async () => {
    // An engine can be pointed at an explicit path (CLAUDE_CODE_PATH etc.).
    // Probing the canonical name instead would report "installed" for a binary
    // this Agent never spawns, so a run would still fail with ENOENT.
    const { providerCatalog } = await import('../../engine/provider-catalog.js')
    const adapter = providerCatalog.getOrThrow('cursor')
    const getVersion = vi.fn().mockResolvedValue(null)
    // providerCatalog is a module singleton shared with the other cases here, so
    // restore the previous engine rather than leaking this stub into them.
    const previousEngine = adapter.getEngine()
    adapter.attachEngine({ type: 'cursor', getVersion } as never)
    onTestFinished(() => {
      // biome-ignore lint/suspicious/noExplicitAny: restoring the singleton's prior state
      ;(adapter as any).engine = previousEngine
    })
    // The lock probe would say installed; the engine's own path says otherwise.
    mockProbeProviderCli.mockResolvedValue({ managed: true, version: '1.0.0' })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor' })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'cursor',
      name: 'Cursor CLI',
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'secret' }),
    )

    expect(getVersion).toHaveBeenCalled()
    expect(checks.some((c) => c.id === 'provider_cli_not_installed')).toBe(true)
  })

  it('does not report a CLI a2wave does not manage as missing', async () => {
    // An unmanaged Provider has no lock entry; treating that as "not installed"
    // would fail its Agent's diagnosis for a CLI a2wave never installs.
    mockProbeProviderCli.mockResolvedValue({ managed: false })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor' })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'cursor',
      name: 'Cursor CLI',
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'secret' }),
    )

    expect(checks.some((c) => c.id === 'provider_cli_not_installed')).toBe(false)
  })

  it('uses adapter capabilities to report missing credentials', async () => {
    mockBuildAgentConfig.mockReturnValue({
      providerId: 'prv_1',
      providerKind: 'claude-code',
      engineType: 'claude-code',
      authMode: 'apiKey',
      model: 'claude-sonnet-4-6',
    })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'claude-code',
      name: 'Claude Code',
    })
    const checks = await collectAgentExecutionChecks(
      row({
        id: 'a1',
        providerId: 'prv_1',
        type: 'llm',
        providerApiKey: null,
      }),
    )
    expect(checks.some((c) => c.id === 'provider_bound_ok')).toBe(true)
    expect(checks.some((c) => c.id === 'provider_credentials_from_environment')).toBe(true)
  })

  it('uses resolved Provider chain credentials instead of stale top-level Agent fields', async () => {
    mockBuildAgentConfig.mockReturnValue({
      providerId: 'prv_1',
      providerKind: 'cursor',
      engineType: 'cursor',
      authMode: 'apiKey',
      model: 'composer-1',
      providerApiKey: 'chain-key',
    })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'cursor',
      name: 'Cursor CLI',
    })
    const checks = await collectAgentExecutionChecks(
      row({
        id: 'a1',
        providerId: 'prv_1',
        type: 'cursor',
        authMode: 'oauth',
        providerApiKey: null,
      }),
    )
    expect(checks.some((c) => c.id === 'provider_bound_ok')).toBe(true)
    expect(checks.some((c) => c.id === 'provider_credentials_configured')).toBe(true)
    expect(checks.some((c) => c.id === 'provider_auth_mode_unsupported')).toBe(false)
  })

  it('reports a Provider CLI below the minimum version as an error', async () => {
    // qoder is a real preset with minVersion '1.0.0'; providerCatalog/PRESET_PROVIDERS
    // are not mocked in this file, so its manifest is available for free.
    mockProbeProviderCli.mockResolvedValue({ managed: true, version: 'qodercli 0.2.8' })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'qoder' })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'qoder',
      name: 'Qoder CLI',
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'llm', providerApiKey: 'secret' }),
    )

    expect(
      checks.some((c) => c.id === 'provider_cli_version_below_minimum' && c.severity === 'error'),
    ).toBe(true)
    // Installed, just old — must not double-report as "not installed".
    expect(checks.some((c) => c.id === 'provider_cli_not_installed')).toBe(false)

    // No diagnose check gates execution, so the message must not imply the run
    // is held back until the CLI is upgraded — it said "before running this
    // Agent" while runs started regardless.
    const versionCheck = checks.find((c) => c.id === 'provider_cli_version_below_minimum')
    expect(versionCheck?.message).toContain('does not block runs')
    expect(versionCheck?.message).not.toContain('before running this Agent')

    // The preset name already ends in "CLI", so appending it rendered
    // "Qoder CLI CLI is too old".
    expect(versionCheck?.message).toContain('Qoder CLI is too old')
    expect(versionCheck?.message).not.toContain('CLI CLI')
  })

  it('does not report a version check when the installed CLI meets the minimum', async () => {
    mockProbeProviderCli.mockResolvedValue({ managed: true, version: 'qodercli 1.0.0' })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'qoder' })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'qoder',
      name: 'Qoder CLI',
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'llm', providerApiKey: 'secret' }),
    )

    expect(checks.some((c) => c.id === 'provider_cli_version_below_minimum')).toBe(false)
  })

  it('does not report a version check for a Provider with no minVersion', async () => {
    // cursor is a real preset with minVersion: null.
    mockProbeProviderCli.mockResolvedValue({ managed: true, version: '0.0.1' })
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor' })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'cursor',
      name: 'Cursor CLI',
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'secret' }),
    )

    expect(checks.some((c) => c.id === 'provider_cli_version_below_minimum')).toBe(false)
  })

  it('reports unsupported auth modes from the Provider manifest', async () => {
    mockBuildAgentConfig.mockReturnValue({
      providerId: 'prv_1',
      providerKind: 'codex',
      engineType: 'codex',
      authMode: 'oauth',
      providerOauthToken: 'token',
    })
    mockProviderGet.mockReturnValue({
      id: 'prv_1',
      kind: 'codex',
      name: 'Codex CLI',
    })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'llm' }),
    )

    expect(checks.some((c) => c.id === 'provider_auth_mode_unsupported')).toBe(true)
  })
})

describe('reasoning controls bound to a Provider that cannot use them', () => {
  /**
   * The web form clears both controls when the Provider of a chain entry
   * changes, but an imported Agent or a direct API write can still leave a level
   * attached to a CLI that has no such flag. It is silently dropped at run time,
   * so diagnose is the only place the operator would ever learn about it.
   */
  it('warns when a reasoning level is configured on a Provider without the setting', async () => {
    mockBuildAgentConfig.mockReturnValue({
      engineType: 'cursor',
      model: 'composer-1',
      reasoningEffort: 'xhigh',
    })
    mockProviderGet.mockReturnValue({ id: 'prv_1', kind: 'cursor', name: 'Cursor CLI' })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'k' }),
    )

    const check = checks.find((c) => c.id === 'provider_reasoning_effort_unsupported')
    expect(check?.severity).toBe('warn')
    expect(check?.message).toContain('xhigh')
  })

  /**
   * A control belongs to its chain entry, so a mismatch on a FALLBACK is just as
   * real — and harder to notice, since it only bites once the primary has
   * already failed and nobody is watching that run closely.
   */
  it('warns about a fallback entry, not just the bound one', async () => {
    mockBuildAgentConfig.mockReturnValue({
      engineType: 'claude-code',
      model: 'claude-opus-4-8',
      providerChain: [
        { providerId: 'prv_1', providerKind: 'claude-code', reasoningEffort: 'high' },
        { providerId: 'prv_2', providerKind: 'cursor', reasoningEffort: 'xhigh' },
      ],
    })
    mockProviderGet.mockReturnValue({ id: 'prv_1', kind: 'claude-code', name: 'Claude Code' })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'k' }),
    )

    const found = checks.filter((c) => c.id === 'provider_reasoning_effort_unsupported')
    expect(found).toHaveLength(1)
    // Positioned, because "somewhere in the chain" is not actionable.
    expect(found[0]?.message).toContain('chain entry 2')
    expect(found[0]?.message).toContain('xhigh')
  })

  it('names no position when the Agent has a single binding', async () => {
    mockBuildAgentConfig.mockReturnValue({
      engineType: 'cursor',
      model: 'composer-1',
      reasoningEffort: 'xhigh',
    })
    mockProviderGet.mockReturnValue({ id: 'prv_1', kind: 'cursor', name: 'Cursor CLI' })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'k' }),
    )

    expect(
      checks.find((c) => c.id === 'provider_reasoning_effort_unsupported')?.message,
    ).not.toContain('chain entry')
  })

  it('warns when fast mode is on for a Provider that has no fast mode', async () => {
    mockBuildAgentConfig.mockReturnValue({
      engineType: 'cursor',
      model: 'composer-1',
      fastMode: true,
    })
    mockProviderGet.mockReturnValue({ id: 'prv_1', kind: 'cursor', name: 'Cursor CLI' })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'k' }),
    )

    expect(
      checks.some((c) => c.id === 'provider_fast_mode_unsupported' && c.severity === 'warn'),
    ).toBe(true)
  })

  it('stays quiet for a Provider that does support both', async () => {
    mockBuildAgentConfig.mockReturnValue({
      engineType: 'claude-code',
      model: 'claude-opus-4-8',
      reasoningEffort: 'xhigh',
      fastMode: true,
    })
    mockProviderGet.mockReturnValue({ id: 'prv_1', kind: 'claude-code', name: 'Claude Code' })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'k' }),
    )

    expect(checks.some((c) => c.id === 'provider_reasoning_effort_unsupported')).toBe(false)
    expect(checks.some((c) => c.id === 'provider_fast_mode_unsupported')).toBe(false)
  })

  it('stays quiet when neither control is configured', async () => {
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'composer-1' })
    mockProviderGet.mockReturnValue({ id: 'prv_1', kind: 'cursor', name: 'Cursor CLI' })

    const checks = await collectAgentExecutionChecks(
      row({ id: 'a1', providerId: 'prv_1', type: 'cursor', providerApiKey: 'k' }),
    )

    expect(checks.some((c) => c.id === 'provider_reasoning_effort_unsupported')).toBe(false)
    expect(checks.some((c) => c.id === 'provider_fast_mode_unsupported')).toBe(false)
  })
})
