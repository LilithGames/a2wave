import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'
import { ProviderBindingInvalidError } from '../errors.js'

const mockDbFrom = vi.fn()

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: { id: 'agents.id' },
  providers: { id: 'providers.id' },
  skills: { id: 'skills.id', groupId: 'skills.groupId' },
  scmSources: { id: 'scmSources.id' },
  mcpServers: { id: 'mcpServers.id' },
  kbDocuments: { id: 'kbDocuments.id' },
  users: { id: 'users.id', role: 'users.role', isActive: 'users.isActive' },
  auditLogs: {},
  runs: { id: 'runs.id', workDir: 'runs.workDir', status: 'runs.status' },
  settings: {},
}))

vi.mock('../scm-source.js', () => ({
  createScmSource: vi.fn(),
}))

vi.mock('../../engine/mcp-sync.js', () => ({}))

vi.mock('../seed-builtin-mcp.js', () => ({
  resolveBuiltinMcpConfig: vi.fn(),
  isOwnerSafeBuiltinMcp: vi.fn().mockReturnValue(false),
}))

vi.mock('../settings.js', () => ({
  getCategorySettings: vi.fn().mockReturnValue({ workspacePath: '/workspace' }),
}))

vi.mock('../slug.js', () => ({
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}))

import { validateAgentProviderConfiguration } from '../agent-helpers.js'

type AgentRow = Parameters<typeof validateAgentProviderConfiguration>[0]

function chainResult(value: unknown) {
  // asyncQuery: validateAgentProviderConfiguration is async on this branch, and
  // its provider lookup ends in `.limit(1)` rather than `.get()`.
  return asyncQuery({
    where: () => asyncQuery({ get: () => value, limit: () => asyncQuery({ get: () => value }) }),
    limit: () => asyncQuery({ get: () => value }),
  })
}

function provider(kind: 'pi' | 'codex') {
  return {
    id: `prv_${kind}`,
    name: kind === 'pi' ? 'Pi CLI' : 'Codex CLI',
    kind,
    initScript: null,
    checkScript: null,
    skillsDir: null,
    mcpConfigPath: null,
  }
}

function agent(kind: 'pi' | 'codex', binding: Record<string, unknown>): AgentRow {
  return {
    id: `agt_${kind}`,
    name: `${kind} validation`,
    config: {
      providerChain: [
        {
          id: `pc_${kind}`,
          providerId: `prv_${kind}`,
          authMode: 'apiKey',
          model: kind === 'pi' ? 'openai/gpt-5.4' : 'gpt-5.4',
          enabled: true,
          ...binding,
        },
      ],
    },
    providerId: null,
    mcpServerIds: [],
    a2aRouteTargets: null,
  } as unknown as AgentRow
}

describe('Provider activation credential validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects Pi apiKey mode without an Agent-scoped key', async () => {
    mockDbFrom.mockReturnValueOnce(chainResult(provider('pi')))

    let caught: unknown
    try {
      await validateAgentProviderConfiguration(agent('pi', {}))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ProviderBindingInvalidError)
    expect(caught).toMatchObject({
      code: 'PROVIDER_BINDING_INVALID',
      missingFields: ['apiKey'],
      providerId: 'prv_pi',
      providerKind: 'pi',
    })
  })

  it('uses Pi localSession when a legacy chain entry has no auth mode', async () => {
    mockDbFrom.mockReturnValueOnce(chainResult(provider('pi')))

    await expect(
      validateAgentProviderConfiguration(
        agent('pi', {
          authMode: undefined,
          model: 'anthropic/claude-sonnet-4-6',
          providerApiKey: 'stale-key-that-local-session-must-ignore',
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it('keeps migrated Pi localSession bindings usable with stale apiKey-era fields', async () => {
    mockDbFrom.mockReturnValueOnce(chainResult(provider('pi')))

    await expect(
      validateAgentProviderConfiguration(
        agent('pi', {
          authMode: 'localSession',
          model: 'anthropic/claude-sonnet-4-6',
          providerApiKey: 'stale-key-that-local-session-must-ignore',
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it('rejects a Codex Agent proxy without a key from the same binding', async () => {
    mockDbFrom.mockReturnValueOnce(chainResult(provider('codex')))

    await expect(
      validateAgentProviderConfiguration(
        agent('codex', { providerBaseUrl: 'https://agent-controlled.example.com/v1' }),
      ),
    ).rejects.toBeInstanceOf(ProviderBindingInvalidError)
  })

  it('keeps Codex deployment-key fallback when no Agent proxy is configured', async () => {
    mockDbFrom.mockReturnValueOnce(chainResult(provider('codex')))

    await expect(validateAgentProviderConfiguration(agent('codex', {}))).resolves.toBeUndefined()
  })

  it('rejects a Codex OAuth binding without a selected account instead of using a deployment key', async () => {
    mockDbFrom.mockReturnValueOnce(chainResult(provider('codex')))
    await expect(
      validateAgentProviderConfiguration(agent('codex', { authMode: 'oauth' })),
    ).rejects.toThrow()
  })
})
