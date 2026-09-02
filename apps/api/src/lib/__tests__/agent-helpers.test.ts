import { PROVIDER_CHAIN_MAX } from '@a2wave/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProviderConfigurationError,
  ProviderMcpUnsupportedError,
  UnusableProviderChainError,
} from '../errors.js'

// --- Mocks ---

const mockDbSelect = vi.fn()
const mockDbFrom = vi.fn()
const mockDbWhere = vi.fn()
const mockDbGet = vi.fn()
const mockDbAll = vi.fn()

const { mockDbUpdate, mockDbUpdateSet, mockDbUpdateWhere, mockDbUpdateRun } = vi.hoisted(() => {
  const update = vi.fn()
  const set = vi.fn()
  const where = vi.fn()
  const run = vi.fn()
  update.mockImplementation(() => asyncQuery({ set }))
  set.mockImplementation(() => asyncQuery({ where }))
  where.mockImplementation(() => asyncQuery({ run }))
  return {
    mockDbUpdate: update,
    mockDbUpdateSet: set,
    mockDbUpdateWhere: where,
    mockDbUpdateRun: run,
  }
})

vi.mock('../../db/client.js', () => {
  const dbMock = {
    select: () => ({ from: mockDbFrom }),
    update: mockDbUpdate,
    // Audit inserts (logBackgroundAudit) go through this; swallow them.
    insert: () => ({ values: () => asyncQuery({ run: () => ({ changes: 1 }) }) }),
    // transaction 在 better-sqlite3 中是同步执行 callback，mock 透传 dbMock 本身
    // 作为 tx 参数，让被测代码内部的 select/update 调用走到同一套 mock 上。
    transaction: (cb: (tx: unknown) => unknown) => cb(dbMock),
  }
  // db/transaction.ts reads isPostgres + sqliteDatabase at module load, so the
  // mock must expose them or importing agent-helpers throws.
  return { db: dbMock, isPostgres: false, sqliteDatabase: { inTransaction: false, exec: vi.fn() } }
})

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

const mockCreateScmSource = vi.hoisted(() => vi.fn())
vi.mock('../scm-source.js', () => ({
  createScmSource: mockCreateScmSource,
}))

vi.mock('../../engine/mcp-sync.js', () => ({}))

vi.mock('../seed-builtin-mcp.js', () => ({
  resolveBuiltinMcpConfig: vi.fn().mockReturnValue({
    command: '/usr/local/bin/node',
    args: ['dist/mcp-servers/a2wave-mcp-group-proxy.js'],
    env: {},
  }),
  isOwnerSafeBuiltinMcp: (name: string, userId: string | null) =>
    userId === null && name === 'a2wave-agent-router',
  isControlPlaneOnlyBuiltinMcp: (name: string, userId: string | null) =>
    userId === null && name === 'a2wave-platform-admin',
}))

vi.mock('../settings.js', () => ({
  getCategorySettings: vi.fn().mockReturnValue({ workspacePath: '/workspace' }),
}))

vi.mock('../slug.js', () => ({
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}))

import { asyncQuery } from '../../test/async-query.js'
import {
  _resetTtlCleanupDebounce,
  buildAgentConfig,
  injectScmEnv,
  resolveWorkDir,
  validateAgentProviderConfiguration,
  WorktreeOccupiedError,
} from '../agent-helpers.js'

function chainResult(value: unknown) {
  // An array stands for a multi-row result and must surface through `all`; the
  // adapter consults `get` first, so also exposing it there would wrap the whole
  // array as a single row.
  const terminator = Array.isArray(value)
    ? { all: () => value }
    : { get: () => value, all: () => [] }
  return {
    where: () => asyncQuery(terminator),
  }
}

describe('buildAgentConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default fallback for any un-queued select (e.g. the admin-owner / agent-owner
    // role lookups added for shared-scope resolution): empty results = non-admin,
    // no admin owners. Tests that assert a specific query still use
    // mockReturnValueOnce, which takes precedence in order.
    mockDbFrom.mockReturnValue(chainResult(undefined))
  })

  it('returns agent config spread from agent.config', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: { model: 'claude-sonnet' },
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).model).toBe('claude-sonnet')
  })

  it('merges provider config when providerId is set', async () => {
    const provider = {
      kind: 'cursor',
      name: 'Cursor CLI',
      initScript: 'init.sh',
      checkScript: 'check.sh',
      skillsDir: '.cursor/skills',
      mcpConfigPath: '.cursor/mcp.json',
    }

    mockDbFrom.mockReturnValueOnce(chainResult(provider)).mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: 'prv_1',
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).engineType).toBe('cursor')
    expect((await result).initScript).toBe('init.sh')
    expect((await result).skillsDir).toBe('.cursor/skills')
    expect((await result).mcpConfigPath).toBe('.cursor/mcp.json')
  })

  it('uses the stable provider kind when the display name changes', async () => {
    const provider = {
      kind: 'cursor',
      name: 'Renamed Coding Engine',
      initScript: null,
      checkScript: null,
      skillsDir: null,
      mcpConfigPath: null,
    }

    mockDbFrom.mockReturnValueOnce(chainResult(provider)).mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: 'prv_1',
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)

    expect((await result).engineType).toBe('cursor')
    expect((await result).providerName).toBe('Renamed Coding Engine')
  })

  it('rejects a provider without a stable kind instead of deriving it from the name', async () => {
    const provider = {
      id: 'prv_legacy',
      name: 'Cursor CLI',
      initScript: 'init.sh',
      checkScript: null,
      skillsDir: null,
    }

    mockDbFrom.mockReturnValueOnce(chainResult(provider)).mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: 'prv_1',
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    let error: unknown
    try {
      await buildAgentConfig(agent)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ProviderConfigurationError)
    expect(error).toMatchObject({
      message:
        'Provider "prv_legacy" has unsupported kind "undefined"; correct the Provider configuration before retrying',
    })
  })

  it('does not leak legacy provider credentials into providerChain entries', async () => {
    const primaryProvider = {
      id: 'prv_primary',
      kind: 'cursor',
      name: 'Cursor CLI',
      initScript: null,
      checkScript: null,
      skillsDir: null,
      mcpConfigPath: null,
    }
    const fallbackProvider = {
      id: 'prv_fallback',
      kind: 'codex',
      name: 'Codex CLI',
      initScript: null,
      checkScript: null,
      skillsDir: null,
      mcpConfigPath: null,
    }

    mockDbFrom
      .mockReturnValueOnce(chainResult(primaryProvider))
      .mockReturnValueOnce(chainResult(fallbackProvider))
      .mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_primary',
            authMode: 'apiKey',
            providerApiKey: 'primary-key',
            enabled: true,
          },
          {
            id: 'pc_2',
            providerId: 'prv_fallback',
            authMode: 'apiKey',
            providerApiKey: null,
            enabled: true,
          },
        ],
      },
      providerId: 'prv_primary',
      providerApiKey: 'legacy-primary-key',
      providerBaseUrl: 'https://legacy.example.com',
      providerOauthToken: 'legacy-token',
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    const providerChain = (await result).providerChain as Array<Record<string, unknown>>

    expect(providerChain[0]?.providerApiKey).toBe('primary-key')
    expect(providerChain[1]?.providerApiKey).toBeUndefined()
    expect(providerChain[1]?.providerBaseUrl).toBeUndefined()
    expect(providerChain[1]?.providerOauthToken).toBeUndefined()
  })

  it('defaults existing Claude bindings to x-api-key and preserves explicit Bearer bindings', async () => {
    const provider = {
      id: 'prv_claude',
      kind: 'claude-code',
      name: 'Claude Code',
      initScript: null,
      checkScript: null,
      osRequirement: null,
      skillsDir: null,
      mcpConfigPath: null,
    }
    mockDbFrom
      .mockReturnValueOnce(chainResult(provider))
      .mockReturnValueOnce(chainResult(provider))
      .mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_claude',
      name: 'Claude',
      config: {
        providerChain: [
          {
            id: 'pc_legacy',
            providerId: provider.id,
            authMode: 'apiKey',
            providerApiKey: 'opaque-legacy-key',
            enabled: true,
          },
          {
            id: 'pc_bearer',
            providerId: provider.id,
            authMode: 'apiKey',
            authHeaderStyle: 'bearer',
            providerApiKey: 'opaque-bearer-token',
            enabled: true,
          },
        ],
      },
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    const providerChain = (await result).providerChain as Array<Record<string, unknown>>

    expect((await result).authHeaderStyle).toBe('x-api-key')
    expect(providerChain.map((binding) => binding.authHeaderStyle)).toEqual(['x-api-key', 'bearer'])
  })

  it('does not fall back to legacy provider columns when providerChain is configured but disabled', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_disabled',
            authMode: 'apiKey',
            enabled: false,
          },
        ],
      },
      providerId: 'prv_legacy',
      providerApiKey: 'legacy-key',
      providerBaseUrl: null,
      providerOauthToken: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    // Disabling every entry is an explicit operator choice, not a broken config,
    // so it resolves to no provider rather than throwing. The invariant that
    // matters is that it must NOT silently keep running on the legacy top-level
    // credentials the operator moved away from.
    const result = await buildAgentConfig(agent)

    expect((await result).providerChain).toEqual([])
    expect((await result).providerId).toBeUndefined()
    expect((await result).providerApiKey).toBeUndefined()
  })

  it('throws when every enabled provider in the chain has been deleted', async () => {
    // Providers resolve via a DB lookup that returns undefined for deleted rows —
    // schema validation can't catch this, only runtime resolution can. Without
    // this, executor.ts defaults engineType to 'cursor' and launches a CLI with
    // no credentials, failing far from the actual cause.
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {
        providerChain: [
          { id: 'pc_1', providerId: 'prv_deleted', authMode: 'apiKey', enabled: true },
        ],
      },
      providerId: null,
      providerApiKey: null,
      providerBaseUrl: null,
      providerOauthToken: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    await expect(buildAgentConfig(agent)).rejects.toThrow(UnusableProviderChainError)
    // Must stay catchable where ProviderConfigurationError already is, so the
    // gateway routes answer 424 AGENT_CONFIGURATION_ERROR instead of a bare 500.
    await expect(buildAgentConfig(agent)).rejects.toThrow(ProviderConfigurationError)
  })

  it('does not throw for an empty chain — a draft Agent has no provider yet', async () => {
    // The web client persists `providerChain: []` for an Agent saved before a
    // Provider is chosen. Throwing here would make every such draft unopenable
    // AND block the very save that would repair it.
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Draft',
      config: { providerChain: [] },
      providerId: null,
      providerApiKey: null,
      providerBaseUrl: null,
      providerOauthToken: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)

    expect((await result).providerChain).toEqual([])
    expect((await result).providerId).toBeUndefined()
  })

  it('rejects mounted MCP servers when the legacy Provider cannot deliver them', async () => {
    mockDbFrom.mockReturnValueOnce(
      chainResult({
        id: 'prv_pi',
        name: 'Pi CLI',
        kind: 'pi',
        initScript: null,
        checkScript: null,
        skillsDir: null,
        mcpConfigPath: null,
      }),
    )

    const agent = {
      id: 'agt_pi',
      name: 'Pi with tools',
      config: {},
      providerId: 'prv_pi',
      authMode: 'localSession',
      systemPrompt: null,
      skills: null,
      mcpServerIds: ['mcp_1'],
      a2aRouteTargets: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    let error: unknown
    try {
      await buildAgentConfig(agent)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ProviderMcpUnsupportedError)
    expect(error).toMatchObject({
      message: expect.stringContaining('does not support MCP delivery'),
    })
  })

  it('rejects MCP-backed A2A routes when an enabled fallback cannot deliver MCP', async () => {
    const cursorProvider = {
      id: 'prv_cursor',
      name: 'Cursor CLI',
      kind: 'cursor',
      initScript: null,
      checkScript: null,
      skillsDir: null,
      mcpConfigPath: null,
    }
    const piProvider = {
      id: 'prv_pi',
      name: 'Pi CLI',
      kind: 'pi',
      initScript: null,
      checkScript: null,
      skillsDir: null,
      mcpConfigPath: null,
    }
    mockDbFrom
      .mockReturnValueOnce(chainResult(cursorProvider))
      .mockReturnValueOnce(chainResult(piProvider))

    const agent = {
      id: 'agt_chain',
      name: 'Fallback chain',
      config: {
        providerChain: [
          {
            id: 'pc_cursor',
            providerId: 'prv_cursor',
            authMode: 'localSession',
            enabled: true,
          },
          { id: 'pc_pi', providerId: 'prv_pi', authMode: 'localSession', enabled: true },
        ],
      },
      providerId: null,
      systemPrompt: null,
      skills: null,
      mcpServerIds: [],
      a2aRouteTargets: [{ type: 'local', agentId: 'agt_child' }],
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    await expect(buildAgentConfig(agent)).rejects.toThrow(ProviderMcpUnsupportedError)
  })

  it('allows an MCP-less Provider when the Agent has no MCP-backed capability', async () => {
    mockDbFrom.mockReturnValueOnce(
      chainResult({
        id: 'prv_pi',
        name: 'Pi CLI',
        kind: 'pi',
        initScript: null,
        checkScript: null,
        skillsDir: null,
        mcpConfigPath: null,
      }),
    )

    const agent = {
      id: 'agt_pi',
      name: 'Pi without MCP',
      config: {},
      providerId: 'prv_pi',
      authMode: 'localSession',
      systemPrompt: null,
      skills: null,
      mcpServerIds: [],
      a2aRouteTargets: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      userId: null,
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    expect((await buildAgentConfig(agent)).engineType).toBe('pi')
  })

  it('validates Provider configuration without resolving runtime resources', async () => {
    mockDbFrom
      .mockReturnValueOnce(
        chainResult({
          id: 'prv_cursor',
          name: 'Cursor CLI',
          kind: 'cursor',
          initScript: null,
          checkScript: null,
          skillsDir: null,
          mcpConfigPath: null,
        }),
      )
      .mockImplementation(() => {
        throw new Error('Runtime resource resolution should not run during Provider validation')
      })

    const agent = {
      id: 'agt_preflight',
      name: 'Provider preflight',
      config: { memoryEnabled: true },
      providerId: 'prv_cursor',
      authMode: 'localSession',
      systemPrompt: 'Use every configured capability',
      skills: ['skl_1'],
      skillGroupIds: ['skg_1'],
      mcpServerIds: ['mcp_1'],
      kbDocumentIds: ['kbd_1'],
      a2aRouteTargets: [{ type: 'local', agentId: 'agt_child' }],
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      userId: 'usr_owner',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    await expect(validateAgentProviderConfiguration(agent)).resolves.not.toThrow()
    expect(mockDbFrom).toHaveBeenCalledTimes(1)
  })

  it('rejects Provider/MCP conflicts through the side-effect-free validator', async () => {
    mockDbFrom.mockReturnValueOnce(
      chainResult({
        id: 'prv_pi',
        name: 'Pi CLI',
        kind: 'pi',
        initScript: null,
        checkScript: null,
        skillsDir: null,
        mcpConfigPath: null,
      }),
    )

    const agent = {
      id: 'agt_pi',
      name: 'Pi with tools',
      config: {},
      providerId: 'prv_pi',
      authMode: 'localSession',
      mcpServerIds: ['mcp_1'],
      a2aRouteTargets: null,
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    await expect(validateAgentProviderConfiguration(agent)).rejects.toThrow(
      ProviderMcpUnsupportedError,
    )
    expect(mockDbFrom).toHaveBeenCalledTimes(1)
  })

  it('does not inject the agent-router MCP for an empty A2A target list', async () => {
    const piProvider = {
      id: 'prv_pi',
      name: 'Pi CLI',
      kind: 'pi',
      initScript: null,
      checkScript: null,
      skillsDir: null,
      mcpConfigPath: null,
    }
    mockDbFrom.mockReturnValueOnce(chainResult(piProvider))

    const agent = {
      id: 'agt_pi',
      name: 'Pi without routes',
      config: {},
      providerId: 'prv_pi',
      authMode: 'localSession',
      systemPrompt: null,
      skills: null,
      mcpServerIds: [],
      a2aRouteTargets: [],
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      userId: null,
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    expect((await buildAgentConfig(agent)).resolvedMcpServers).toEqual([])
  })

  it('rejects a chain longer than the cap regardless of how it was written', async () => {
    // The create/update schema is not the only way a config reaches the DB —
    // import and clone copy `config` verbatim, and rows predate the cap. Without a
    // runtime check the cap is not a system invariant, and an oversized chain still
    // multiplies into (maxRetries + 1) × chainLength subprocess launches.
    mockDbFrom.mockReturnValue(
      chainResult({
        id: 'prv_1',
        name: 'Cursor',
        kind: 'cursor',
        engineType: 'cursor',
        apiKey: 'k',
      }),
    )

    const agent = {
      id: 'agt_1',
      name: 'Oversized',
      config: {
        providerChain: Array.from({ length: PROVIDER_CHAIN_MAX + 1 }, (_, i) => ({
          id: `pc_${i}`,
          providerId: 'prv_1',
          authMode: 'apiKey',
          enabled: true,
        })),
      },
      providerId: null,
      providerApiKey: null,
      providerBaseUrl: null,
      providerOauthToken: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    await expect(buildAgentConfig(agent)).rejects.toThrow(ProviderConfigurationError)
  })

  it('accepts a chain exactly at the cap', async () => {
    mockDbFrom.mockReturnValue(
      chainResult({
        id: 'prv_1',
        name: 'Cursor',
        kind: 'cursor',
        engineType: 'cursor',
        apiKey: 'k',
      }),
    )

    const agent = {
      id: 'agt_1',
      name: 'At cap',
      config: {
        providerChain: Array.from({ length: PROVIDER_CHAIN_MAX }, (_, i) => ({
          id: `pc_${i}`,
          providerId: 'prv_1',
          authMode: 'apiKey',
          enabled: true,
        })),
      },
      providerId: null,
      providerApiKey: null,
      providerBaseUrl: null,
      providerOauthToken: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    expect(() => buildAgentConfig(agent)).not.toThrow()
  })

  it('injects systemPrompt into config', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: 'You are a helpful agent',
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).systemPrompt).toBe('You are a helpful agent')
  })

  it('resolves skills by IDs including storagePath', async () => {
    const skillRows = [
      {
        id: 'skl_1',
        name: 'code-review',
        content: 'review instructions',
        storagePath: 'skl_1',
        userId: 'usr_owner',
        visibility: 'private',
      },
      {
        id: 'skl_2',
        name: 'testing',
        content: 'testing instructions',
        storagePath: null,
        userId: 'usr_owner',
        visibility: 'private',
      },
    ]

    // providerId is null → no provider lookup
    // First from() call: skills lookup → .all()
    mockDbFrom.mockReturnValueOnce(
      asyncQuery({
        where: () => asyncQuery({ get: () => null, all: () => skillRows }),
      }),
    )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: ['skl_1', 'skl_2'],
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      userId: 'usr_owner',
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).resolvedSkills).toEqual([
      { name: 'code-review', content: 'review instructions', storagePath: 'skl_1' },
      { name: 'testing', content: 'testing instructions', storagePath: null },
    ])
  })

  it('merges direct skills with skillGroupIds members and dedupes', async () => {
    const directRows = [
      {
        id: 'skl_direct',
        name: 'direct',
        content: 'x',
        storagePath: 'skl_direct',
        userId: 'usr_owner',
        visibility: 'private',
      },
    ]
    const groupRows = [
      {
        id: 'skl_a',
        name: 'a',
        content: 'a',
        storagePath: 'skl_a',
        userId: 'usr_owner',
        visibility: 'private',
      },
      {
        id: 'skl_direct',
        name: 'direct',
        content: 'x',
        storagePath: 'skl_direct',
        userId: 'usr_owner',
        visibility: 'private',
      }, // overlap with direct
      {
        id: 'skl_b',
        name: 'b',
        content: 'b',
        storagePath: 'skl_b',
        userId: 'usr_owner',
        visibility: 'private',
      },
    ]

    // 1st from(): skills.id IN [direct] → directRows
    // 2nd from(): skills.groupId IN [...] → groupRows
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => directRows }) }),
      )
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => groupRows }) }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: ['skl_direct'],
      skillGroupIds: ['skg_1'],
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      userId: 'usr_owner',
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).resolvedSkills).toHaveLength(3)
    const names = (await result).resolvedSkills?.map((s: { name: string }) => s.name).sort()
    expect(names).toEqual(['a', 'b', 'direct'])
  })

  it('skips skill resolution entirely when both skills and skillGroupIds are empty', async () => {
    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: [],
      skillGroupIds: [],
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).resolvedSkills).toBeUndefined()
  })

  it('resolves mcpServerIds to resolvedMcpServers', async () => {
    const mcpRows = [
      {
        name: 'w3-feishu-mcp',
        type: 'stdio',
        command: 'uvx',
        args: ['feishu-mcp'],
        url: null,
        headers: null,
        env: { TOKEN: 'secret' },
      },
    ]

    // providerId is null → no provider lookup
    // skills is empty → no skills lookup
    // First from() call: mcpServers lookup → .all()
    // Second: the runtime stdio guard rechecks the explicit requester.
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce(
        asyncQuery({
          where: () =>
            asyncQuery({ get: () => ({ role: 'admin', isActive: true }), all: () => [] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_1'],
      userId: 'usr_admin',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent, { runtimeAdminRequesterUserId: 'usr_admin' })
    expect(result.resolvedMcpServers).toEqual([
      {
        name: 'w3-feishu-mcp',
        type: 'stdio',
        command: 'uvx',
        args: ['feishu-mcp'],
        url: null,
        headers: undefined,
        env: { TOKEN: 'secret' },
      },
    ])
  })

  it('runtime RCE guard: drops a stdio MCP when the owning agent is NOT owned by an admin', async () => {
    // The blocking gap: bind-time gates + adminOnly backfill do not cover an
    // already-bound stdio server; buildAgentConfig must refuse to spawn it for a
    // non-admin owner. This is the surface a chat/API/A2A run would otherwise
    // execute on the host.
    const mcpRows = [
      {
        id: 'mcp_stdio',
        name: 'legacy-stdio',
        type: 'stdio',
        command: 'node',
        args: ['evil.js'],
        url: null,
        headers: null,
        env: null,
        groupConfig: null,
      },
    ]
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      // Owner role lookup → a plain user, NOT admin.
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => ({ role: 'user' }), all: () => [] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_stdio'],
      userId: 'usr_editor',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toEqual([])
  })

  it('keeps an admin-bound stdio MCP for an externally triggered admin-owned agent', async () => {
    const mcpRows = [
      {
        id: 'mcp_stdio',
        name: 'legacy-stdio',
        type: 'stdio',
        command: 'node',
        args: ['host-command.js'],
        url: null,
        headers: null,
        env: null,
        groupConfig: null,
        usageScope: 'admin-only',
        userId: 'usr_admin_owner',
      },
    ]
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce({
        where: () => asyncQuery({ get: () => ({ role: 'admin', isActive: true }), all: () => [] }),
      })

    const result = await buildAgentConfig({
      id: 'agt_admin_owned',
      name: 'Admin owned',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_stdio'],
      userId: 'usr_admin_owner',
    } as unknown as Parameters<typeof buildAgentConfig>[0])

    expect(result.resolvedMcpServers).toHaveLength(1)
    expect(result.resolvedMcpServers?.[0]?.name).toBe('legacy-stdio')
  })

  it('keeps the system platform-admin MCP control-plane-only for external triggers', async () => {
    const mcpRows = [
      {
        id: 'mcp_platform_admin',
        name: 'a2wave-platform-admin',
        type: 'stdio',
        command: 'node',
        args: ['platform-admin.js'],
        url: null,
        headers: null,
        env: { A2WAVE_API_URL: 'http://127.0.0.1:3502' },
        groupConfig: null,
        usageScope: 'admin-only',
        userId: null,
      },
    ]
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce({
        where: () => asyncQuery({ get: () => ({ role: 'admin', isActive: true }), all: () => [] }),
      })

    const result = await buildAgentConfig({
      id: 'agt_admin_owned',
      name: 'Admin owned',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_platform_admin'],
      userId: 'usr_admin_owner',
    } as unknown as Parameters<typeof buildAgentConfig>[0])

    expect(result.resolvedMcpServers).toEqual([])
  })

  it('permits an admin-bound stdio MCP for an explicitly named active admin requester', async () => {
    const mcpRows = [
      {
        id: 'mcp_stdio',
        name: 'admin-tool',
        type: 'stdio',
        command: 'node',
        args: ['admin-tool.js'],
        url: null,
        headers: null,
        env: null,
        groupConfig: null,
        usageScope: 'admin-only',
        userId: 'usr_admin_owner',
      },
    ]
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce({
        where: () => asyncQuery({ get: () => ({ role: 'user', isActive: true }), all: () => [] }),
      })
      .mockReturnValueOnce({
        where: () => asyncQuery({ get: () => ({ role: 'admin', isActive: true }), all: () => [] }),
      })

    const result = await buildAgentConfig(
      {
        id: 'agt_admin_owned',
        name: 'Admin owned',
        config: {},
        providerId: null,
        systemPrompt: null,
        skills: null,
        env: null,
        workspaceType: 'temp',
        scmSourceId: null,
        mcpServerIds: ['mcp_stdio'],
        userId: 'usr_admin_owner',
      } as unknown as Parameters<typeof buildAgentConfig>[0],
      { runtimeAdminRequesterUserId: 'usr_current_admin' },
    )

    expect(result.resolvedMcpServers).toHaveLength(1)
  })

  it.each([
    { role: 'user', isActive: true },
    { role: 'admin', isActive: false },
  ])(
    'rechecks the explicit requester role and active state at execution time',
    async (requester) => {
      const mcpRows = [
        {
          id: 'mcp_stdio',
          name: 'admin-tool',
          type: 'stdio',
          command: 'node',
          args: ['admin-tool.js'],
          url: null,
          headers: null,
          env: null,
          groupConfig: null,
          usageScope: 'admin-only',
          userId: 'usr_admin_owner',
        },
      ]
      mockDbFrom
        .mockReturnValueOnce(
          asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
        )
        .mockReturnValueOnce(
          asyncQuery({
            where: () =>
              asyncQuery({ get: () => ({ role: 'user', isActive: true }), all: () => [] }),
          }),
        )
        .mockReturnValueOnce(
          asyncQuery({ where: () => asyncQuery({ get: () => requester, all: () => [] }) }),
        )

      const result = await buildAgentConfig(
        {
          id: 'agt_admin_owned',
          name: 'Admin owned',
          config: {},
          providerId: null,
          systemPrompt: null,
          skills: null,
          env: null,
          workspaceType: 'temp',
          scmSourceId: null,
          mcpServerIds: ['mcp_stdio'],
          userId: 'usr_admin_owner',
        } as unknown as Parameters<typeof buildAgentConfig>[0],
        { runtimeAdminRequesterUserId: 'usr_queued_requester' },
      )

      expect(result.resolvedMcpServers).toEqual([])
    },
  )

  it.each([
    { owner: { role: 'admin', isActive: false }, state: 'disabled' },
    { owner: { role: 'user', isActive: true }, state: 'demoted' },
    { owner: undefined, state: 'deleted' },
  ])(
    'revokes externally triggered admin-bound stdio when the Agent owner is $state',
    async ({ owner }) => {
      const mcpRows = [
        {
          id: 'mcp_stdio',
          name: 'approved-stdio',
          type: 'stdio',
          command: 'node',
          args: ['approved-tool.js'],
          url: null,
          headers: null,
          env: null,
          groupConfig: null,
          usageScope: 'admin-only',
          userId: 'usr_former_admin',
        },
      ]
      mockDbFrom
        .mockReturnValueOnce(
          asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
        )
        .mockReturnValueOnce(
          asyncQuery({ where: () => asyncQuery({ get: () => owner, all: () => [] }) }),
        )

      const result = await buildAgentConfig({
        id: 'agt_former_admin_owned',
        name: 'Former admin owned',
        config: {},
        providerId: null,
        systemPrompt: null,
        skills: null,
        env: null,
        workspaceType: 'temp',
        scmSourceId: null,
        mcpServerIds: ['mcp_stdio'],
        userId: 'usr_former_admin',
      } as unknown as Parameters<typeof buildAgentConfig>[0])

      expect(result.resolvedMcpServers).toEqual([])
    },
  )

  it('runtime RCE guard: keeps an sse MCP for a non-admin owner (only stdio is host RCE)', async () => {
    const mcpRows = [
      {
        id: 'mcp_sse',
        name: 'remote-sse',
        type: 'sse',
        command: null,
        args: null,
        url: 'https://mcp.example.com/sse',
        headers: null,
        env: null,
        groupConfig: null,
        usageScope: 'all-users',
        userId: 'usr_editor', // owned by the agent's owner → allowed
      },
    ]
    // Owned, all-users, non-stdio → not restricted → guard never looks up the owner role.
    mockDbFrom.mockReturnValueOnce(
      asyncQuery({
        where: () => asyncQuery({ get: () => null, all: () => mcpRows }),
      }),
    )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_sse'],
      userId: 'usr_editor',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toHaveLength(1)
    expect((await result).resolvedMcpServers?.[0]?.type).toBe('sse')
  })

  it('runtime backstop: DROPS a cross-owner sse MCP for a non-admin agent (legacy IDOR binding)', async () => {
    // Pre-fix bindings survive because PATCH skips existing ids and the runtime
    // never checked ownership. An sse MCP owned by another user must be dropped at
    // execution so its URL/headers/credentials are not resolved under this agent.
    const mcpRows = [
      {
        id: 'mcp_other',
        name: 'alices-sse',
        type: 'sse',
        command: null,
        args: null,
        url: 'https://alice.example.com/sse',
        headers: { Authorization: 'Bearer alice-secret' },
        env: null,
        groupConfig: null,
        usageScope: 'private', // private + cross-owner → dropped (its creds must not leak)
        userId: 'usr_alice', // NOT the agent owner
      },
    ]
    // 1st from() = mcpServers lookup; subsequent role/admin-owner lookups fall to
    // the default (non-admin agent owner, alice not an admin owner) → cross-owner
    // sse is dropped.
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValue(
        asyncQuery({
          where: () => asyncQuery({ get: () => ({ role: 'user' }), all: () => [] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_other'],
      userId: 'usr_bob',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toEqual([])
  })

  it('confused-deputy: a non-admin agent binding an admin all-users GROUP cannot resolve the admin’s private ref', async () => {
    // The group MCP is admin-owned and shared (all-users), so a non-admin may bind
    // it. But its ref points at the ADMIN's OWN private sse. Ref access must be
    // decided against the AGENT owner (usr_bob), not the group's owner (usr_admin) —
    // otherwise usr_bob's run would resolve and execute the admin's private
    // credentials. The private ref must be dropped, leaving the group with no
    // usable backends.
    const groupRow = {
      id: 'mcp_group',
      name: 'shared-group',
      type: 'group',
      command: null,
      args: null,
      url: null,
      headers: null,
      env: null,
      groupConfig: {
        backends: { d: [{ mode: 'ref', mcpServerId: 'mcp_admin_private' }] },
      },
      usageScope: 'all-users', // admin shared the GROUP
      userId: 'usr_admin',
    }
    const adminPrivateRef = {
      id: 'mcp_admin_private',
      name: 'admin-secret-sse',
      type: 'sse',
      command: null,
      args: null,
      url: 'https://admin.example.com/sse',
      headers: { Authorization: 'Bearer admin-secret' },
      env: { API_KEY: 'admin-secret' },
      groupConfig: null,
      usageScope: 'private', // owner-only; usr_bob must NOT reach it
      userId: 'usr_admin',
    }
    mockDbFrom
      // 1) mcpServers lookup for the agent's bound ids → the shared group
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => [groupRow] }) }),
      )
      // 2) agent owner role lookup → usr_bob is a plain user (non-admin)
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => ({ role: 'user' }), all: () => [] }),
        }),
      )
      // 3) resolveGroupRefs ref lookup — even if the query returned the admin's
      //    private row, the per-row canNonAdminUseMcp(ownerId=usr_bob) must reject it.
      .mockReturnValue(
        asyncQuery({
          where: () => asyncQuery({ get: () => null, all: () => [adminPrivateRef] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_group'],
      userId: 'usr_bob',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    // The group still resolves (it is shared), but its private ref is dropped, and
    // the admin's secret URL/headers/env never appear in the resolved config.
    const serialized = JSON.stringify((await result).resolvedMcpServers ?? [])
    expect(serialized).not.toContain('admin.example.com')
    expect(serialized).not.toContain('admin-secret')
  })

  it('runtime backstop: an ADMIN-owned agent keeps a cross-owner sse MCP (admins see all)', async () => {
    const mcpRows = [
      {
        id: 'mcp_other',
        name: 'alices-sse',
        type: 'sse',
        command: null,
        args: null,
        url: 'https://alice.example.com/sse',
        headers: null,
        env: null,
        groupConfig: null,
        usageScope: 'all-users',
        userId: 'usr_alice',
      },
    ]
    // mcpServers lookup first; all role/admin-owner lookups → admin → agent owner
    // is admin, so the cross-owner sse is kept (admins see everything).
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValue(
        asyncQuery({
          where: () => asyncQuery({ get: () => ({ role: 'admin' }), all: () => [] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_other'],
      userId: 'usr_admin',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toHaveLength(1)
  })

  it('runtime RCE guard: exempts platform builtin stdio (agent-router) for non-admin owners', async () => {
    // The builtin router is stdio but platform-controlled; dropping it would break
    // A2A routing for every non-admin-owned agent.
    const mcpRows = [
      {
        id: 'mcp_router',
        name: 'a2wave-agent-router',
        type: 'stdio',
        command: 'node',
        args: ['router.js'],
        url: null,
        headers: null,
        env: null,
        groupConfig: null,
        userId: null, // system-owned → genuine builtin
      },
    ]
    // Builtin is exempt → no owner-role lookup happens; a single from() call.
    mockDbFrom.mockReturnValueOnce(
      asyncQuery({
        where: () => asyncQuery({ get: () => null, all: () => mcpRows }),
      }),
    )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_router'],
      userId: 'usr_editor',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toHaveLength(1)
    expect((await result).resolvedMcpServers?.[0]?.name).toBe('a2wave-agent-router')
  })

  it('runtime guard: a USER-owned same-named "a2wave-agent-router" stdio is NOT exempt', async () => {
    // mcp_servers.name is not unique — an admin could seed a same-named stdio row
    // and, after demotion, have it treated as the safe builtin. The exemption
    // requires userId === null, which a user-created row can never have.
    const mcpRows = [
      {
        id: 'mcp_fake',
        name: 'a2wave-agent-router', // forged name
        type: 'stdio',
        command: 'node',
        args: ['evil.js'],
        url: null,
        headers: null,
        env: null,
        groupConfig: null,
        usageScope: 'admin-only', // stdio ⇒ admin-only
        userId: 'usr_demoted', // NOT system-owned
      },
    ]
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => ({ role: 'user' }), all: () => [] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_fake'],
      userId: 'usr_demoted',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toEqual([])
  })

  it('runtime guard: BLOCKS platform-admin (adminOnly) for a non-admin owner (demoted admin)', async () => {
    // platform-admin is a builtin but adminOnly — it exposes global MCP/Provider/
    // Settings/user/audit data. It must NOT be exempt: an admin who bound it and
    // was later demoted must not keep reading global data through their agent.
    const mcpRows = [
      {
        id: 'mcp_admin',
        name: 'a2wave-platform-admin',
        type: 'stdio',
        usageScope: 'admin-only',
        command: 'node',
        args: ['platform-admin.js'],
        url: null,
        headers: null,
        env: null,
        groupConfig: null,
      },
    ]
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      // Owner role lookup → demoted to plain user.
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => ({ role: 'user' }), all: () => [] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_admin'],
      userId: 'usr_demoted',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toEqual([])
  })

  it('injects the process credential only into the system platform-admin MCP for an active admin requester', async () => {
    const mcpRows = [
      {
        id: 'mcp_admin',
        name: 'a2wave-platform-admin',
        type: 'stdio',
        usageScope: 'admin-only',
        command: 'node',
        args: ['platform-admin.js'],
        url: null,
        headers: null,
        env: { A2WAVE_API_URL: 'http://127.0.0.1:3502' },
        groupConfig: null,
        userId: null,
      },
      {
        id: 'mcp_other',
        name: 'admin-owned-tool',
        type: 'stdio',
        usageScope: 'admin-only',
        command: 'node',
        args: ['other.js'],
        url: null,
        headers: null,
        env: null,
        groupConfig: null,
        userId: 'usr_admin',
      },
    ]
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce(
        asyncQuery({
          where: () =>
            asyncQuery({ get: () => ({ role: 'admin', isActive: true }), all: () => [] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Admin Agent',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_admin', 'mcp_other'],
      userId: 'usr_admin',
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent, { runtimeAdminRequesterUserId: 'usr_admin' })
    const platformAdmin = (await result).resolvedMcpServers?.find(
      (server) => server.name === 'a2wave-platform-admin',
    )
    const other = (await result).resolvedMcpServers?.find(
      (server) => server.name === 'admin-owned-tool',
    )

    expect(platformAdmin?.env?.A2WAVE_INTERNAL_ADMIN_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(other?.env?.A2WAVE_INTERNAL_ADMIN_TOKEN).toBeUndefined()
  })

  it('injects A2WAVE_ROUTE_TARGETS env for a2wave-agent-router when a2aRouteTargets is set', async () => {
    const mcpRows = [
      {
        name: 'a2wave-agent-router',
        type: 'stdio',
        command: 'node',
        args: ['a2wave-agent-router.js'],
        userId: null,
        cwd: null,
        url: null,
        headers: null,
        env: { A2WAVE_API_URL: 'http://127.0.0.1:3502' },
      },
    ]
    const localAgents = [
      {
        id: 'agt_1',
        name: 'Test',
        description: 'Local test agent',
        publishDescription: 'Published test agent',
        publishStatus: 'published',
        publishChannels: ['a2a'],
      },
    ]

    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => localAgents }) }),
      )

    const routeTargets = [
      { type: 'local', agentId: 'agt_1' },
      { type: 'remote', name: 'remote-agent', url: 'https://remote.example.com/a2a' },
    ]

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_1'],
      a2aRouteTargets: routeTargets,
    } as any

    const result = await buildAgentConfig(agent)
    const router = (await result).resolvedMcpServers?.find((s) => s.name === 'a2wave-agent-router')
    expect(router?.env).toBeDefined()
    expect(router?.env?.A2WAVE_API_URL).toBe('http://127.0.0.1:3502')
    expect(router?.env?.A2WAVE_ROUTE_TARGETS).toBe(JSON.stringify(routeTargets))
    expect(router?.env?.A2WAVE_CALLER_AGENT_ID).toBe('agt_1')
    expect(router?.env?.A2WAVE_CALLER_AGENT_NAME).toBe('Test')
    // Every /api/internal/* route requires the process credential; without it the
    // router cannot list agents or invoke them.
    expect(router?.env?.A2WAVE_INTERNAL_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })

  it('withholds the internal token from a USER row squatting on the router name', async () => {
    // The reserved name is not unique. An admin-owned stdio row named
    // 'a2wave-agent-router' still runs (admin-bound MCPs are allowed for an
    // active admin requester), but it is not the platform's router and must not
    // receive the process credential for /api/internal/*.
    const mcpRows = [
      {
        id: 'mcp_squat',
        name: 'a2wave-agent-router',
        type: 'stdio',
        usageScope: 'admin-only',
        command: 'node',
        args: ['squatter.js'],
        cwd: null,
        url: null,
        headers: null,
        env: null,
        groupConfig: null,
        userId: 'usr_admin',
      },
    ]
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce(
        asyncQuery({
          where: () =>
            asyncQuery({ get: () => ({ role: 'admin', isActive: true }), all: () => [] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_squat'],
      a2aRouteTargets: null,
      userId: 'usr_admin',
    } as any

    const result = await buildAgentConfig(agent, { runtimeAdminRequesterUserId: 'usr_admin' })
    const router = result.resolvedMcpServers?.find((s) => s.name === 'a2wave-agent-router')
    expect(router).toBeDefined()
    expect(router?.env?.A2WAVE_INTERNAL_TOKEN).toBeUndefined()
  })

  it('does not inject A2WAVE_ROUTE_TARGETS when a2aRouteTargets is null', async () => {
    const mcpRows = [
      {
        name: 'a2wave-agent-router',
        type: 'stdio',
        command: 'node',
        args: ['a2wave-agent-router.js'],
        userId: null,
        cwd: null,
        url: null,
        headers: null,
        env: null,
      },
    ]

    mockDbFrom.mockReturnValueOnce(
      asyncQuery({
        where: () => asyncQuery({ get: () => null, all: () => mcpRows }),
      }),
    )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_1'],
      a2aRouteTargets: null,
    } as any

    const result = await buildAgentConfig(agent)
    const router = (await result).resolvedMcpServers?.find((s) => s.name === 'a2wave-agent-router')
    expect(router?.env).toEqual({
      A2WAVE_CALLER_AGENT_ID: 'agt_1',
      A2WAVE_CALLER_AGENT_NAME: 'Test',
      A2WAVE_INTERNAL_TOKEN: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/),
    })
  })

  it('auto-injects a2wave-agent-router when a2aRouteTargets is set but router not in mcpServerIds', async () => {
    const routerMcp = {
      name: 'a2wave-agent-router',
      type: 'stdio',
      command: 'node',
      args: ['a2wave-agent-router.js'],
      userId: null,
      cwd: null,
      url: null,
      headers: null,
      env: { A2WAVE_API_URL: 'http://127.0.0.1:3502' },
    }
    const localAgents = [
      {
        id: 'agt_2',
        name: 'Worker',
        description: 'Local worker',
        publishDescription: null,
        publishStatus: 'published',
        publishChannels: ['a2a'],
      },
    ]

    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => routerMcp, all: () => [routerMcp] }),
        }),
      )
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => localAgents }) }),
      )

    const routeTargets = [{ type: 'local', agentId: 'agt_2' }]

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: null,
      a2aRouteTargets: routeTargets,
    } as any

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toHaveLength(1)
    const router = (await result).resolvedMcpServers?.[0]
    expect(router?.name).toBe('a2wave-agent-router')
    expect(router?.env?.A2WAVE_API_URL).toBe('http://127.0.0.1:3502')
    expect(router?.env?.A2WAVE_ROUTE_TARGETS).toBe(JSON.stringify(routeTargets))
    expect(router?.env?.A2WAVE_CALLER_AGENT_ID).toBe('agt_1')
    expect(router?.env?.A2WAVE_CALLER_AGENT_NAME).toBe('Test')
    expect(router?.env?.A2WAVE_INTERNAL_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })

  it('does NOT auto-inject a same-named USER stdio router (system router absent)', async () => {
    // The real system router (userId IS NULL) was deleted; a user seeded a stdio
    // MCP with the reserved name to be auto-injected and executed. The auto-inject
    // query filters userId IS NULL, so it finds no system router → the lookup .get()
    // returns null (the user row does not match) → nothing is injected.
    mockDbFrom
      // mcpServerIds is null → first from() is the router lookup (userId IS NULL → none).
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => [] }) }),
      )
      // route-target resolution: no local agents.
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => [] }) }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: null,
      a2aRouteTargets: [{ type: 'local', agentId: 'agt_2' }],
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toEqual([])
  })

  it('does not duplicate a2wave-agent-router when already in mcpServerIds', async () => {
    const mcpRows = [
      {
        name: 'a2wave-agent-router',
        type: 'stdio',
        command: 'node',
        args: ['a2wave-agent-router.js'],
        userId: null,
        cwd: null,
        url: null,
        headers: null,
        env: { A2WAVE_API_URL: 'http://127.0.0.1:3502' },
      },
    ]
    const localAgents = [
      {
        id: 'agt_2',
        name: 'Worker',
        description: 'Local worker',
        publishDescription: null,
        publishStatus: 'published',
        publishChannels: ['a2a'],
      },
    ]

    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => localAgents }) }),
      )

    const routeTargets = [{ type: 'local', agentId: 'agt_2' }]

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_router'],
      a2aRouteTargets: routeTargets,
    } as any

    const result = await buildAgentConfig(agent)
    const routers = (await result).resolvedMcpServers?.filter(
      (s) => s.name === 'a2wave-agent-router',
    )
    expect(routers).toHaveLength(1)
  })

  it('resolves availableAgentsSummary from local and remote route targets in order', async () => {
    const mcpRows = [
      {
        name: 'a2wave-agent-router',
        type: 'stdio',
        command: 'node',
        args: ['a2wave-agent-router.js'],
        userId: null,
        cwd: null,
        url: null,
        headers: null,
        env: { A2WAVE_API_URL: 'http://127.0.0.1:3502' },
      },
    ]
    const localAgents = [
      {
        id: 'agt_2',
        name: 'Planner',
        description: 'Fallback description',
        publishDescription: 'Published planner',
        publishStatus: 'published',
        publishChannels: ['api', 'a2a'],
      },
    ]

    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => localAgents }) }),
      )

    const routeTargets = [
      {
        type: 'remote',
        name: 'translator',
        url: 'https://remote.example.com/a2a',
        description: 'Translates docs',
      },
      { type: 'local', agentId: 'agt_2' },
    ]

    const agent = {
      id: 'agt_1',
      name: 'Caller',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_router'],
      a2aRouteTargets: routeTargets,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).availableAgentsSummary).toEqual([
      {
        id: 'remote:translator',
        name: 'translator',
        description: 'Translates docs',
        source: 'remote',
      },
      {
        id: 'agt_2',
        name: 'Planner',
        description: 'Published planner',
        source: 'local',
      },
    ])
  })

  it('injects a CodeGraph skill when the bound SCM source enables CodeGraph', async () => {
    mockDbFrom.mockReturnValue(
      chainResult({
        id: 'scm_1',
        type: 'git',
        localPath: '/repo',
        config: { type: 'git', branch: 'main', codegraphEnabled: true },
      }),
    )

    const agent = {
      id: 'agt_1',
      name: 'Code Expert',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'scm',
      scmSourceId: 'scm_1',
      mcpServerIds: [],
      a2aRouteTargets: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).agentEnv?.A2WAVE_CODEGRAPH_ENABLED).toBe('true')
    expect((await result).resolvedSkills?.some((s) => s.name === 'CodeGraph')).toBe(true)
    const codegraphSkill = (await result).resolvedSkills?.find((s) => s.name === 'CodeGraph')
    expect(codegraphSkill?.content).toContain('codegraph explore')
    expect(codegraphSkill?.content).toContain('codegraph node')
  })

  it('does not inject a CodeGraph skill when the bound SCM source disables CodeGraph', async () => {
    mockDbFrom.mockReturnValue(
      chainResult({
        id: 'scm_1',
        type: 'git',
        localPath: '/repo',
        config: { type: 'git', branch: 'main', codegraphEnabled: false },
      }),
    )

    const agent = {
      id: 'agt_1',
      name: 'Code Expert',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'scm',
      scmSourceId: 'scm_1',
      mcpServerIds: [],
      a2aRouteTargets: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).agentEnv?.A2WAVE_CODEGRAPH_ENABLED).toBeUndefined()
    expect((await result).resolvedSkills?.some((s) => s.name === 'CodeGraph')).not.toBe(true)
  })

  it('injects a CodeGraph skill for P4 SCM sources that enable CodeGraph', async () => {
    mockDbFrom.mockReturnValue(
      chainResult({
        id: 'scm_1',
        type: 'p4',
        localPath: '/repo',
        config: {
          type: 'p4',
          p4port: 'ssl:p4.example.com:1666',
          p4user: 'build',
          p4passwd: 'secret',
          p4client: 'client',
          codegraphEnabled: true,
        },
      }),
    )

    const agent = {
      id: 'agt_1',
      name: 'P4 Expert',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'scm',
      scmSourceId: 'scm_1',
      mcpServerIds: [],
      a2aRouteTargets: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).agentEnv?.A2WAVE_CODEGRAPH_ENABLED).toBe('true')
    expect((await result).agentEnv?.P4CLIENT).toBe('client')
    expect((await result).resolvedSkills?.some((s) => s.name === 'CodeGraph')).toBe(true)
  })

  it('filters local availableAgentsSummary entries to published A2A agents only', async () => {
    const mcpRows = [
      {
        name: 'a2wave-agent-router',
        type: 'stdio',
        command: 'node',
        args: ['a2wave-agent-router.js'],
        userId: null,
        cwd: null,
        url: null,
        headers: null,
        env: { A2WAVE_API_URL: 'http://127.0.0.1:3502' },
      },
    ]
    const localAgents = [
      {
        id: 'agt_good',
        name: 'Valid Agent',
        description: 'desc',
        publishDescription: null,
        publishStatus: 'published',
        publishChannels: ['a2a'],
      },
      {
        id: 'agt_draft',
        name: 'Draft Agent',
        description: 'desc',
        publishDescription: null,
        publishStatus: 'draft',
        publishChannels: ['a2a'],
      },
      {
        id: 'agt_api_only',
        name: 'API Only Agent',
        description: 'desc',
        publishDescription: null,
        publishStatus: 'published',
        publishChannels: ['api'],
      },
    ]

    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => mcpRows }) }),
      )
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => localAgents }) }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Caller',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_router'],
      a2aRouteTargets: [
        { type: 'local', agentId: 'agt_good' },
        { type: 'local', agentId: 'agt_draft' },
        { type: 'local', agentId: 'agt_api_only' },
      ],
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).availableAgentsSummary).toEqual([
      {
        id: 'agt_good',
        name: 'Valid Agent',
        description: 'desc',
        source: 'local',
      },
    ])
  })

  it('clears stale availableAgentsSummary inherited from agent.config', async () => {
    // agent.config JSON 列可能残留旧的 availableAgentsSummary（前次写入、手工编辑等）。
    // buildAgentConfig 必须在无当前 a2aRouteTargets 时把它清空，避免 prompt 渲染幽灵 agent。
    mockDbFrom.mockReturnValue(chainResult(undefined))
    const agent = {
      id: 'agt_1',
      name: 'Caller',
      config: {
        availableAgentsSummary: [
          { id: 'agt_stale', name: 'Ghost', description: 'removed target', source: 'local' },
        ],
      },
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: null,
      a2aRouteTargets: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).availableAgentsSummary).toBeUndefined()
  })

  it('sets resolvedMcpServers to empty array when no mcpServerIds', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toEqual([])
  })

  it('flattens env variables', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: {
        API_KEY: { value: 'secret123', sensitive: true },
        DEBUG: { value: 'true', sensitive: false },
      },
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).agentEnv).toMatchObject({ API_KEY: 'secret123', DEBUG: 'true' })
    expect((await result).agentEnv).toHaveProperty('A2WAVE_AGENT_ID', 'agt_1')
    expect((await result).agentEnv).toHaveProperty('A2WAVE_API_URL')
  })

  it('injects per-agent provider credentials', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      providerApiKey: 'sk-agent-key',
      providerBaseUrl: 'https://proxy.example.com',
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).providerApiKey).toBe('sk-agent-key')
    expect((await result).providerBaseUrl).toBe('https://proxy.example.com')
  })

  it('oauth mode 仍透传 providerApiKey/baseUrl，让不支持 oauth 的引擎能回退到 apiKey', async () => {
    // 场景：用户把 Claude Code agent 改成 oauth 后又把 provider 切回 Cursor，
    // Cursor 引擎的 buildEnv 会把 oauth 当 apiKey 处理；helper 必须把 providerApiKey
    // 透传过去，否则 Cursor 只能用全局 fallback / 直接缺凭证失败。
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      authMode: 'oauth',
      providerApiKey: 'agent-cursor-key',
      providerBaseUrl: 'https://proxy.example.com',
      providerOauthToken: 'sk-ant-oat01-claude-only',
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).authMode).toBe('oauth')
    expect((await result).providerApiKey).toBe('agent-cursor-key')
    expect((await result).providerBaseUrl).toBe('https://proxy.example.com')
    expect((await result).providerOauthToken).toBe('sk-ant-oat01-claude-only')
  })

  it('localSession mode 不透传任何 per-agent 凭证字段', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      authMode: 'localSession',
      providerApiKey: 'should-be-stripped',
      providerBaseUrl: 'https://should-be-stripped.example.com',
      providerOauthToken: 'should-also-be-stripped',
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).authMode).toBe('localSession')
    expect((await result).providerApiKey).toBeUndefined()
    expect((await result).providerBaseUrl).toBeUndefined()
    expect((await result).providerOauthToken).toBeUndefined()
  })

  it('injects timeoutMinutes and maxRetries with defaults and clamp', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect((await result).timeoutMinutes).toBe(10)
    expect((await result).maxRetries).toBe(2)
  })

  it('clamps timeoutMinutes to 5-120 range', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agentLow = {
      id: 'agt_1',
      name: 'Test',
      config: { timeoutMinutes: 1 },
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any
    expect((await buildAgentConfig(agentLow)).timeoutMinutes).toBe(5)

    const agentHigh = {
      id: 'agt_2',
      name: 'Test',
      config: { timeoutMinutes: 121 },
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any
    expect((await buildAgentConfig(agentHigh)).timeoutMinutes).toBe(120)
  })

  it('clamps maxRetries to 0-5 range', async () => {
    mockDbFrom.mockReturnValue(chainResult(undefined))

    const agentZero = {
      id: 'agt_1',
      name: 'Test',
      config: { maxRetries: 0 },
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any
    expect((await buildAgentConfig(agentZero)).maxRetries).toBe(0)

    const agentNeg = {
      id: 'agt_1',
      name: 'Test',
      config: { maxRetries: -1 },
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any
    expect((await buildAgentConfig(agentNeg)).maxRetries).toBe(0)

    const agentHigh = {
      id: 'agt_2',
      name: 'Test',
      config: { maxRetries: 10 },
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
    } as any
    expect((await buildAgentConfig(agentHigh)).maxRetries).toBe(5)
  })

  it('converts group type MCP server to stdio proxy config', async () => {
    const groupServer = {
      id: 'mcp_group1',
      name: 'My Group',
      type: 'group',
      usageScope: 'all-users',
      groupConfig: {
        backends: {
          default: [
            {
              mode: 'inline',
              name: 'svc-a',
              type: 'stdio',
              command: 'npx',
              args: ['-y', 'server-a'],
            },
          ],
        },
      },
      command: null,
      args: null,
      cwd: null,
      url: null,
      headers: null,
      env: null,
    }

    // providerId null, skills null, kbDocumentIds null → first from() call is mcpServers lookup.
    // A group with an inline stdio backend is stdio-capable, so the runtime guard
    // then rechecks the explicit requester — active admin here → kept.
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => null, all: () => [groupServer] }),
        }),
      )
      .mockReturnValueOnce(
        asyncQuery({
          where: () =>
            asyncQuery({ get: () => ({ role: 'admin', isActive: true }), all: () => [] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_group1'],
      userId: 'usr_admin',
      a2aRouteTargets: null,
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent, { runtimeAdminRequesterUserId: 'usr_admin' })
    expect(result.resolvedMcpServers).toHaveLength(1)
    const resolved = (await result).resolvedMcpServers![0]
    expect(resolved.type).toBe('stdio')
    expect(resolved.command).toBe('/usr/local/bin/node')
    expect(resolved.args).toEqual(['dist/mcp-servers/a2wave-mcp-group-proxy.js'])
    expect(resolved.env).toBeDefined()
    expect(resolved.env!.A2WAVE_GROUP_CONFIG_PATH).toBeUndefined()
    expect(resolved.env!.A2WAVE_GROUP_NAME).toBe('My Group')
    expect(resolved.publicEnvKeys).toEqual(['A2WAVE_GROUP_NAME'])
    expect(resolved.runtimeGroupConfig).toBeDefined()
  })

  it('resolves ref backends in group config from DB', async () => {
    const groupServer = {
      id: 'mcp_group1',
      name: 'My Group',
      type: 'group',
      usageScope: 'all-users',
      userId: null,
      groupConfig: {
        backends: {
          default: [{ mode: 'ref', mcpServerId: 'mcp_ref1' }],
        },
      },
      command: null,
      args: null,
      cwd: null,
      url: null,
      headers: null,
      env: null,
    }

    // sse ref (URL-only, not host execution) — the legitimate ref-resolution path.
    const refServer = {
      id: 'mcp_ref1',
      name: 'ref-server',
      type: 'sse',
      command: null,
      args: null,
      cwd: null,
      url: 'https://mcp.example.com/sse',
      headers: null,
      env: { SECRET: 'val' },
      usageScope: 'all-users',
      userId: null,
    }

    // agent + group are system-owned (userId null) so the admin-owner / agent-owner
    // role lookups short-circuit WITHOUT a query — the only selects are the group
    // lookup then the ref resolution.
    // 1. mcpServers lookup by IDs → [groupServer]
    // 2. resolveGroupRefs: ref lookup → .get() returns refServer
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => null, all: () => [groupServer] }),
        }),
      )
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => refServer, all: () => [refServer] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_group1'],
      userId: null,
      a2aRouteTargets: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toHaveLength(1)
    const resolved = (await result).resolvedMcpServers![0]
    expect(resolved.type).toBe('stdio') // the group PROXY is always stdio
    // The filtered config stays in memory until a real worker execution starts.
    const written = resolved.runtimeGroupConfig!.config as any
    expect(written.backends.default).toHaveLength(1)
    const inlineBackend = written.backends.default[0]
    expect(inlineBackend.mode).toBe('inline')
    expect(inlineBackend.name).toContain('ref-server')
    expect(inlineBackend.type).toBe('sse')
    expect(inlineBackend.url).toBe('https://mcp.example.com/sse')
  })

  it('does not resolve an admin-bound stdio group ref for a non-admin-owned agent', async () => {
    // A group ref to a stdio server executes host commands just like an inline
    // stdio backend. A non-admin Agent owner must not reach it through a ref.
    const groupServer = {
      id: 'mcp_group1',
      name: 'My Group',
      type: 'group',
      usageScope: 'all-users',
      groupConfig: { backends: { default: [{ mode: 'ref', mcpServerId: 'mcp_stdio_ref' }] } },
      command: null,
      args: null,
      cwd: null,
      url: null,
      headers: null,
      env: null,
      userId: 'usr_user', // owned by the agent owner → not cross-owner
    }
    const stdioRef = {
      id: 'mcp_stdio_ref',
      name: 'approved-stdio',
      type: 'stdio',
      command: 'node',
      args: ['approved-tool.js'],
      cwd: null,
      url: null,
      headers: null,
      env: null,
      usageScope: 'admin-only',
      userId: 'usr_user',
    }
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => null, all: () => [groupServer] }) }),
      )
      .mockReturnValueOnce({
        where: () => asyncQuery({ get: () => ({ role: 'user', isActive: true }), all: () => [] }),
      })
      .mockReturnValueOnce(
        asyncQuery({ where: () => asyncQuery({ get: () => stdioRef, all: () => [stdioRef] }) }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_group1'],
      userId: 'usr_user',
      a2aRouteTargets: null,
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    const resolved = (await result).resolvedMcpServers![0]
    const written = resolved.runtimeGroupConfig!.config as any
    expect(written.backends.default ?? []).toHaveLength(0)
  })

  it('group ref guard: SKIPS an admin-narrowed (admin-only) sse ref for a non-admin agent', async () => {
    // Alice owns an sse an admin later narrowed to admin-only, and a group that
    // references it. A non-admin owner must NOT reach it via the ref — otherwise
    // the admin's narrowing is bypassed and the sse URL/headers/env run.
    const groupServer = {
      id: 'mcp_group1',
      name: 'My Group',
      type: 'group',
      usageScope: 'all-users',
      userId: 'usr_alice',
      groupConfig: { backends: { default: [{ mode: 'ref', mcpServerId: 'mcp_narrowed' }] } },
      command: null,
      args: null,
      cwd: null,
      url: null,
      headers: null,
      env: null,
    }
    const narrowedRef = {
      id: 'mcp_narrowed',
      name: 'alices-sse',
      type: 'sse',
      command: null,
      args: null,
      cwd: null,
      url: 'https://alice.example.com/sse',
      headers: { Authorization: 'Bearer secret' },
      env: null,
      usageScope: 'admin-only', // an admin narrowed it
      userId: 'usr_alice',
    }
    // group lookup → agent-owner role (non-admin) → getAdminOwnerIdSet → ref lookup.
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => null, all: () => [groupServer] }),
        }),
      )
      .mockReturnValue(
        asyncQuery({ where: () => asyncQuery({ get: () => narrowedRef, all: () => [] }) }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_group1'],
      userId: 'usr_alice', // non-admin owner
    } as unknown as Parameters<typeof buildAgentConfig>[0]

    const result = await buildAgentConfig(agent)
    const resolved = (await result).resolvedMcpServers![0]
    const written = resolved.runtimeGroupConfig!.config as any
    // Admin-narrowed ref dropped for the non-admin agent owner.
    expect(written.backends.default ?? []).toHaveLength(0)
  })

  it('skips ref backends targeting group type servers', async () => {
    const groupServer = {
      id: 'mcp_group1',
      name: 'My Group',
      type: 'group',
      usageScope: 'all-users',
      userId: null,
      groupConfig: {
        backends: {
          default: [{ mode: 'ref', mcpServerId: 'mcp_nested_group' }],
        },
      },
      command: null,
      args: null,
      cwd: null,
      url: null,
      headers: null,
      env: null,
    }

    const nestedGroupServer = {
      id: 'mcp_nested_group',
      name: 'Nested Group',
      type: 'group',
      groupConfig: { backends: { default: [] } },
      command: null,
      args: null,
      cwd: null,
      url: null,
      headers: null,
      env: null,
      usageScope: 'all-users',
    }

    // 1. mcpServers lookup → [groupServer]
    // 2. resolveGroupRefs ref lookup for mcp_nested_group → returns nestedGroupServer (type=group, should be skipped)
    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => null, all: () => [groupServer] }),
        }),
      )
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => nestedGroupServer, all: () => [] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_group1'],
      userId: null,
      a2aRouteTargets: null,
    } as any

    const result = await buildAgentConfig(agent)
    expect(result.resolvedMcpServers).toHaveLength(1)
    const resolved = (await result).resolvedMcpServers![0]
    // The group server was converted to stdio proxy
    expect(resolved.type).toBe('stdio')
    // The in-memory filtered config should have an empty backends (nested group was skipped)
    const written = resolved.runtimeGroupConfig!.config as any
    // default key should be absent because no backends survived filtering
    expect(written.backends.default).toBeUndefined()
  })

  it('sanitizes ref names with short ID suffix', async () => {
    const groupServer = {
      id: 'mcp_group1',
      name: 'My Group',
      type: 'group',
      usageScope: 'all-users',
      userId: null,
      groupConfig: {
        backends: {
          default: [{ mode: 'ref', mcpServerId: 'mcp_abc123' }],
        },
      },
      command: null,
      args: null,
      cwd: null,
      url: null,
      headers: null,
      env: null,
    }

    // sse ref: name sanitization is type-agnostic, and an sse ref is not blocked
    // by the stdio-ref guard, so it exercises the naming path cleanly.
    const refServer = {
      id: 'mcp_abc123',
      name: 'My MCP:Server',
      type: 'sse',
      command: null,
      args: null,
      cwd: null,
      url: 'https://mcp.example.com/sse',
      headers: null,
      env: null,
      usageScope: 'all-users',
      userId: null,
    }

    mockDbFrom
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => null, all: () => [groupServer] }),
        }),
      )
      .mockReturnValueOnce(
        asyncQuery({
          where: () => asyncQuery({ get: () => refServer, all: () => [refServer] }),
        }),
      )

    const agent = {
      id: 'agt_1',
      name: 'Test',
      config: {},
      providerId: null,
      systemPrompt: null,
      skills: null,
      env: null,
      workspaceType: 'temp',
      scmSourceId: null,
      mcpServerIds: ['mcp_group1'],
      userId: null,
      a2aRouteTargets: null,
    } as any

    const result = await buildAgentConfig(agent)
    const resolved = (await result).resolvedMcpServers![0]
    const written = resolved.runtimeGroupConfig!.config as any
    const inlineBackend = written.backends.default[0]
    // "My MCP:Server" → "My-MCP-Server" after replacing colons and spaces, then lowered not required
    // sanitize: replace [^a-zA-Z0-9_-] with '-', collapse multiple '-', trim leading/trailing '-'
    // "My MCP:Server" → "My-MCP-Server" → short id = 'abc123'.slice(0,6) = 'abc123'
    expect(inlineBackend.name).toMatch(/^My-MCP-Server-abc123$/)
  })
})
