import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * Characterization test for useAgentForm — focused on the dirty-check
 * truth table that PR 5 will rewrite from ref-diff to react-hook-form's
 * formState.dirtyFields + collection diffs.
 *
 * Purpose: lock the current behavior of `hasSelectionChanges` (the boolean
 * that drives the unsaved-changes warning) BEFORE the implementation
 * changes. PR 5 must keep this test green without modification.
 *
 * Scope: edit-mode only. Does not exercise create-mode draft save/restore.
 *
 * Following Karpathy guidelines: this file is purely additive and asserts
 * current behavior — including any quirks. It does not "improve" anything.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hook mocks (must come before importing useAgentForm)
// ---------------------------------------------------------------------------

const mutateAsyncStub = vi.fn().mockResolvedValue({ data: { id: 'agt_test1' } })

const mutationStub = () => ({
  mutateAsync: mutateAsyncStub,
  mutate: vi.fn(),
  isPending: false,
  isSuccess: false,
  isError: false,
  error: null,
})

const agentFixture = {
  id: 'agt_test1',
  name: 'Fixture Agent',
  description: 'desc',
  type: 'cursor',
  config: {
    model: 'gpt-4',
    readOnly: false,
    force: true,
    cleanResult: true,
    timeoutMinutes: 10,
    maxRetries: 2,
  },
  status: 'active',
  icon: '🤖',
  systemPrompt: 'sp',
  skills: ['skl_a', 'skl_b'],
  mcpServerIds: ['mcp_a'],
  kbDocumentIds: ['kbd_a'],
  publishStatus: 'draft',
  publishChannels: ['api'],
  providerApiKey: 'key',
  providerBaseUrl: '',
  providerOauthToken: null,
  authMode: 'apiKey',
  endpointApiKey: null,
  publishAuthType: 'api_key',
  publishIpWhitelist: [],
  feishuConfig: null,
  scheduleConfig: null,
  providerId: 'prv_default',
  env: { DB_HOST: { value: 'localhost', sensitive: false } },
  workspaceType: 'temp',
  scmSourceId: null,
  maxConcurrency: 1,
  showLocalChildOutput: true,
  showRemoteChildOutput: true,
  a2aRouteTargets: null,
  userId: 'usr_admin',
}

vi.mock('@/hooks/use-agents', () => ({
  useAgent: vi.fn((id: string) => ({
    data: id ? { data: agentFixture, permission: 'owner' } : undefined,
    isLoading: false,
  })),
  useCreateAgent: vi.fn(() => mutationStub()),
  useUpdateAgent: vi.fn(() => mutationStub()),
  useDeleteAgent: vi.fn(() => mutationStub()),
  useCloneAgent: vi.fn(() => mutationStub()),
  usePublishAgent: vi.fn(() => mutationStub()),
  useStopAgent: vi.fn(() => mutationStub()),
  useResumeAgent: vi.fn(() => mutationStub()),
}))

vi.mock('@/hooks/use-auth', () => ({
  useCurrentUser: vi.fn(() => ({
    data: { id: 'usr_admin', role: 'admin' },
  })),
}))

vi.mock('@/hooks/use-providers', () => ({
  useProviders: vi.fn(() => ({
    data: [
      { id: 'prv_default', name: 'default', kind: 'claude-code' },
      { id: 'prv_cursor', name: 'cursor', kind: 'cursor' },
      {
        id: 'prv_pi',
        name: 'Pi CLI',
        kind: 'pi',
        capabilities: { defaultAuthMode: 'localSession' },
      },
    ],
  })),
}))

vi.mock('@/hooks/use-mcp-servers', () => ({
  useMcpServers: vi.fn(() => ({ data: { data: [{ id: 'mcp_a', name: 'mcp a' }] } })),
}))

vi.mock('@/hooks/use-scm-sources', () => ({
  useScmSources: vi.fn(() => ({
    data: { data: [{ id: 'scm_p4_1', type: 'p4', localPath: '/p4', name: 's' }] },
  })),
}))

vi.mock('@/hooks/use-skills', () => ({
  useSkills: vi.fn(() => ({
    data: {
      data: [
        { id: 'skl_a', name: 'A' },
        { id: 'skl_b', name: 'B' },
        { id: 'skl_c', name: 'C' },
        // Mirrors the API's newest-first order: the user collision precedes the seeded built-in.
        {
          id: 'skl_user_sample',
          name: 'sample-builtin',
          userId: 'usr_other',
          visibility: 'private',
        },
        {
          id: 'skl_builtin_sample',
          name: 'sample-builtin',
          userId: null,
          visibility: 'all-users',
        },
      ],
    },
  })),
}))

vi.mock('@/hooks/use-kb-documents', () => ({
  useKbDocuments: vi.fn(() => ({ data: { data: [{ id: 'kbd_a', name: 'A' }] } })),
}))

vi.mock('@/hooks/use-settings', () => ({
  useSettings: vi.fn(() => ({ data: { general: { workspacePath: '/tmp/sandbox' } } })),
}))

vi.mock('@/hooks/use-form-draft', () => ({
  useFormDraft: vi.fn(() => ({ clearDraft: vi.fn() })),
}))

vi.mock('@/hooks/use-unsaved-changes', () => ({
  useUnsavedChanges: vi.fn(() => null),
}))

vi.mock('@/lib/antd-static', () => ({
  message: { error: vi.fn(), success: vi.fn() },
  modal: { confirm: vi.fn() },
}))

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd')
  return {
    ...actual,
    Modal: { ...actual.Modal, confirm: vi.fn() },
  }
})

const navigateStub = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: vi.fn(() => navigateStub),
  }
})

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { useAgent } from '@/hooks/use-agents'
import { message } from '@/lib/antd-static'
import { useAgentForm } from '../use-agent-form'

function wrapperFactory() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/agents/agt_test1']}>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
}

function renderForm({
  createMode = false,
  templateData,
}: { createMode?: boolean; templateData?: Parameters<typeof useAgentForm>[2] } = {}) {
  return renderHook(
    () => useAgentForm(createMode ? undefined : 'agt_test1', createMode, templateData),
    {
      wrapper: wrapperFactory(),
    },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAgentForm — initialization (edit mode)', () => {
  beforeEach(() => {
    mutateAsyncStub.mockClear()
    vi.mocked(message.error).mockClear()
  })

  it('hydrates all 14 state slots from the fetched agent', async () => {
    const { result } = renderForm()

    await waitFor(() => {
      expect(result.current.selectedSkills).toEqual(['skl_a', 'skl_b'])
    })

    expect(result.current.selectedMcpServerIds).toEqual(['mcp_a'])
    expect(result.current.selectedKbDocumentIds).toEqual(['kbd_a'])
    expect(result.current.workspaceType).toBe('temp')
    expect(result.current.selectedScmSourceId).toBeNull()
    expect(result.current.envEntries).toHaveLength(1)
    expect(result.current.envEntries[0]).toMatchObject({
      key: 'DB_HOST',
      value: 'localhost',
      sensitive: false,
    })
    expect(result.current.routeEnabled).toBe(false)
    expect(result.current.localAgentIds).toEqual([])
    expect(result.current.showLocalChildOutput).toBe(true)
    expect(result.current.showRemoteChildOutput).toBe(true)
    expect(result.current.remoteEntries).toEqual([])
    // Legacy top-level Provider bindings are normalized into the chain state
    // consumed by ConfigTab's MCP compatibility warning.
    expect(result.current.providerChainEntries[0].providerId).toBe('prv_default')
    expect(result.current.providerChainEntries[0]?.authHeaderStyle).toBe('x-api-key')

    // Form values mirror agent.config
    expect(result.current.form.getValues('name')).toBe('Fixture Agent')
    expect(result.current.form.getValues('model')).toBe('gpt-4')
    expect(result.current.form.getValues('cleanResult')).toBe(true)
    expect(result.current.form.getValues('timeoutMinutes')).toBe(10)
    expect(result.current.form.getValues('maxRetries')).toBe(2)
  })

  it('saves cleanResult into agent config', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.form.getValues('name')).toBe('Fixture Agent'))

    act(() => {
      result.current.form.setValue('cleanResult', false)
    })
    await act(async () => {
      await result.current.onSubmit(result.current.form.getValues())
    })

    expect(mutateAsyncStub).toHaveBeenCalledOnce()
    expect(mutateAsyncStub.mock.calls[0][0].config.cleanResult).toBe(false)
    expect(mutateAsyncStub.mock.calls[0][0].skills).toEqual(['skl_a', 'skl_b'])
  })

  it('hydrates legacy remote targets as direct A2A 0.3 endpoints', async () => {
    vi.mocked(useAgent).mockReturnValueOnce({
      data: {
        data: {
          ...agentFixture,
          a2aRouteTargets: [
            { type: 'remote', name: 'Legacy', url: 'https://legacy.example.com/a2a' },
          ],
        },
        permission: 'owner',
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useAgent>)

    const { result } = renderForm()
    await waitFor(() => expect(result.current.remoteEntries).toHaveLength(1))

    expect(result.current.remoteEntries[0]).toMatchObject({
      connectionMode: 'direct',
      protocolVersion: '0.3',
    })
  })

  it('persists Agent Card discovery without a redundant protocol version', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.remoteEntries).toEqual([]))

    act(() => {
      result.current.setRouteEnabled(true)
      result.current.setRemoteEntries([
        {
          id: 're_card',
          name: 'Standard',
          url: 'https://standard.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          protocolVersion: '1.0',
          description: '',
          apiKey: '',
          showApiKey: false,
        },
      ])
    })
    await act(async () => {
      await result.current.onSubmit(result.current.form.getValues())
    })

    expect(mutateAsyncStub.mock.calls[0][0].a2aRouteTargets).toEqual([
      {
        type: 'remote',
        name: 'Standard',
        url: 'https://standard.example.com/.well-known/agent-card.json',
        connectionMode: 'agent_card',
        protocolVersion: undefined,
        description: undefined,
        apiKey: undefined,
      },
    ])
  })

  it('preserves the Provider default when a Pi chain entry omits authMode', async () => {
    vi.mocked(useAgent).mockReturnValueOnce({
      data: {
        data: {
          ...agentFixture,
          providerId: 'prv_pi',
          authMode: undefined,
          providerApiKey: null,
          config: {
            ...agentFixture.config,
            providerChain: [
              {
                id: 'chain_pi',
                providerId: 'prv_pi',
                model: 'anthropic/claude-sonnet-4',
                enabled: true,
              },
            ],
          },
        },
        permission: 'owner',
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useAgent>)

    const { result } = renderForm()
    await waitFor(() => {
      expect(result.current.providerChainEntries[0]?.authMode).toBe('localSession')
    })

    act(() => {
      result.current.form.setValue('description', 'Unrelated edit')
    })
    await act(async () => {
      await result.current.onSubmit(result.current.form.getValues())
    })

    expect(mutateAsyncStub).toHaveBeenCalledOnce()
    expect(mutateAsyncStub.mock.calls[0][0]).toMatchObject({
      providerId: 'prv_pi',
      authMode: 'localSession',
      providerApiKey: null,
      config: {
        providerChain: [
          expect.objectContaining({
            id: 'chain_pi',
            providerId: 'prv_pi',
            authMode: 'localSession',
          }),
        ],
      },
    })
  })

  it('submits an explicit removal of an existing Skill reference', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.selectedSkills).toEqual(['skl_a', 'skl_b']))

    act(() => result.current.setSelectedSkills(['skl_a']))
    await act(async () => {
      await result.current.onSubmit(result.current.form.getValues())
    })

    expect(mutateAsyncStub).toHaveBeenCalledOnce()
    expect(mutateAsyncStub.mock.calls[0][0].skills).toEqual(['skl_a'])
  })

  it('shows the actionable Provider/MCP diagnosis when saving is rejected', async () => {
    const diagnosis =
      'Agent "agt_test1" uses MCP-backed capabilities, but Provider "Pi CLI" (pi) does not support MCP delivery; remove mounted MCP Servers and A2A routes, or choose a Provider with MCP support'
    mutateAsyncStub.mockRejectedValueOnce(new Error(diagnosis))
    const { result } = renderForm()
    await waitFor(() => expect(result.current.form.getValues('name')).toBe('Fixture Agent'))

    await act(async () => {
      await result.current.onSubmit(result.current.form.getValues())
    })

    expect(message.error).toHaveBeenCalledWith(diagnosis)
  })

  /**
   * Create used to swallow every server message behind a generic "create failed"
   * toast, unlike the update path. The masked-env rejection names the offending
   * variable, and that name is the only way to act on it — the field itself renders
   * as dots, so a generic toast leaves the user with nothing to go on.
   */
  it('surfaces the server message when creating is rejected', async () => {
    const diagnosis =
      "Environment variable 'API_TOKEN' was sent masked but no stored value exists to restore. Re-enter its value."
    mutateAsyncStub.mockRejectedValueOnce(new Error(diagnosis))
    const { result } = renderForm({ createMode: true })

    await act(async () => {
      await result.current.onSubmit(result.current.form.getValues())
    })

    expect(message.error).toHaveBeenCalledWith(diagnosis)
  })

  it('shows the actionable Provider/MCP diagnosis when publishing is rejected', async () => {
    const diagnosis =
      'Agent "agt_test1" uses MCP-backed capabilities, but Provider "Pi CLI" (pi) does not support MCP delivery; remove mounted MCP Servers and A2A routes, or choose a Provider with MCP support'
    mutateAsyncStub.mockRejectedValueOnce(new Error(diagnosis))
    const { result } = renderForm()

    await expect(
      result.current.handlePublishConfirm({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
      }),
    ).rejects.toThrow(diagnosis)

    expect(message.error).toHaveBeenCalledWith(diagnosis)
  })

  it('shows the actionable Provider/MCP diagnosis when resuming is rejected', async () => {
    const diagnosis =
      'Agent "agt_test1" uses MCP-backed capabilities, but Provider "Pi CLI" (pi) does not support MCP delivery; remove mounted MCP Servers and A2A routes, or choose a Provider with MCP support'
    mutateAsyncStub.mockRejectedValueOnce(new Error(diagnosis))
    const { result } = renderForm()

    await act(async () => {
      await result.current.handleResume()
    })

    expect(message.error).toHaveBeenCalledWith(diagnosis)
  })

  it('submits cloned OAuth agents using the provider chain token when top-level token is empty', async () => {
    vi.mocked(useAgent).mockReturnValueOnce({
      data: {
        data: {
          ...agentFixture,
          authMode: 'oauth',
          providerOauthToken: null,
          config: {
            ...agentFixture.config,
            providerChain: [
              {
                id: 'chain_1',
                providerId: 'prv_default',
                model: 'gpt-4',
                authMode: 'oauth',
                providerOauthToken: 'fresh-oauth-token',
                enabled: true,
              },
            ],
          },
        },
        permission: 'owner',
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useAgent>)

    const { result } = renderForm()
    await waitFor(() => {
      expect(result.current.form.getValues('authMode')).toBe('oauth')
      expect(result.current.form.getValues('providerOauthToken')).toBe('')
      expect(result.current.providerChainEntries[0].providerOauthToken).toBe('fresh-oauth-token')
    })

    await act(async () => {
      await result.current.form.handleSubmit(result.current.onSubmit)()
    })

    expect(mutateAsyncStub).toHaveBeenCalledOnce()
    expect(mutateAsyncStub.mock.calls[0][0].providerOauthToken).toBe('fresh-oauth-token')
  })

  it('creates agents with provider chain credentials from the same submission helper', async () => {
    const { result } = renderForm({ createMode: true })

    act(() => {
      result.current.form.setValue('name', 'Created Agent')
      result.current.setProviderChainEntries([
        {
          id: 'chain_create',
          providerId: 'prv_default',
          model: 'gpt-4.1',
          authMode: 'oauth',
          providerApiKey: '',
          providerBaseUrl: '',
          providerOauthToken: 'create-oauth-token',
          enabled: true,
          expanded: false,
        },
      ])
    })

    await act(async () => {
      await result.current.form.handleSubmit(result.current.onSubmit)()
    })

    expect(mutateAsyncStub).toHaveBeenCalledOnce()
    expect(mutateAsyncStub.mock.calls[0][0]).toMatchObject({
      name: 'Created Agent',
      providerId: 'prv_default',
      authMode: 'oauth',
      providerOauthToken: 'create-oauth-token',
      config: {
        model: 'gpt-4.1',
        providerChain: [
          expect.objectContaining({
            id: 'chain_create',
            providerId: 'prv_default',
            authMode: 'oauth',
            providerOauthToken: 'create-oauth-token',
            enabled: true,
          }),
        ],
      },
    })
  })

  it('selects the system-owned built-in when a newer user Skill has the same name', async () => {
    const { result } = renderForm({
      createMode: true,
      templateData: {
        name: 'Web App',
        icon: '📱',
        description: 'Build a web app',
        systemPrompt: 'Build a web app.',
        providerKind: 'cursor',
        readOnly: false,
        builtinSkillNames: ['sample-builtin'],
      },
    })

    await waitFor(() => {
      expect(result.current.selectedSkills).toEqual(['skl_builtin_sample'])
    })
  })

  it('keeps regular template Skill names matched by visible list order', async () => {
    const { result } = renderForm({
      createMode: true,
      templateData: {
        name: 'Custom Template',
        icon: '🧩',
        description: 'Use a caller-visible Skill',
        systemPrompt: 'Use the selected Skill.',
        providerKind: 'cursor',
        readOnly: false,
        skillNames: ['sample-builtin'],
      },
    })

    await waitFor(() => {
      expect(result.current.selectedSkills).toEqual(['skl_user_sample'])
    })
  })

  it('selects a portable Provider kind and SCM mode, then requires an explicit source', async () => {
    const { result } = renderForm({
      createMode: true,
      templateData: {
        name: 'Codebase Q&A',
        icon: '💻',
        description: 'Answer from code',
        systemPrompt: 'Read the selected repository.',
        providerKind: 'cursor',
        readOnly: true,
        workspaceType: 'scm',
        scmSubType: 'git',
      },
    })

    await waitFor(() => {
      expect(result.current.form.getValues('name')).toBe('Codebase Q&A')
      expect(result.current.form.getValues('providerId')).toBe('prv_cursor')
    })

    expect(result.current.form.getValues('readOnly')).toBe(true)
    expect(result.current.providerChainEntries[0].providerId).toBe('prv_cursor')
    expect(result.current.workspaceType).toBe('scm')
    expect(result.current.scmSubType).toBe('git')
    expect(result.current.selectedScmSourceId).toBeNull()

    await act(async () => {
      await result.current.onSubmit(result.current.form.getValues())
    })

    expect(mutateAsyncStub).not.toHaveBeenCalled()
    expect(message.error).toHaveBeenCalledWith('请选择一个已完成初次同步的Git 代码源')
  })

  it('hasSelectionChanges is false right after initial hydration', async () => {
    const { result } = renderForm()

    await waitFor(() => {
      expect(result.current.selectedSkills).toEqual(['skl_a', 'skl_b'])
    })

    expect(result.current.hasSelectionChanges).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// hasSelectionChanges truth table (the load-bearing dirty signal)
// ---------------------------------------------------------------------------
describe('useAgentForm — hasSelectionChanges truth table', () => {
  it('flips true when selectedSkills add a new id', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.selectedSkills).toEqual(['skl_a', 'skl_b']))

    act(() => result.current.setSelectedSkills(['skl_a', 'skl_b', 'skl_c']))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })

  it('stays false when selectedSkills are reordered with same content', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.selectedSkills).toEqual(['skl_a', 'skl_b']))

    act(() => result.current.setSelectedSkills(['skl_b', 'skl_a']))
    // sameItems uses set membership not order — reorder should NOT mark dirty
    expect(result.current.hasSelectionChanges).toBe(false)
  })

  it('flips true when workspaceType changes from temp to scm', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.workspaceType).toBe('temp'))

    act(() => result.current.setWorkspaceType('scm'))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })

  it('flips true when selectedScmSourceId changes', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.selectedScmSourceId).toBeNull())

    act(() => result.current.setSelectedScmSourceId('scm_p4_1'))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })

  it('flips true when env entry value changes', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.envEntries).toHaveLength(1))
    const entry = result.current.envEntries[0]

    act(() => result.current.setEnvEntries([{ ...entry, value: 'remotehost' }]))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })

  it('flips true when env entry sensitive flag toggles', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.envEntries).toHaveLength(1))
    const entry = result.current.envEntries[0]

    act(() => result.current.setEnvEntries([{ ...entry, sensitive: true }]))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })

  it('stays false when env entry id changes but key/value/sensitive unchanged', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.envEntries).toHaveLength(1))
    const entry = result.current.envEntries[0]

    // Re-create with new id but same content — sameEnv compares by key only
    act(() => result.current.setEnvEntries([{ ...entry, id: 'new_id' }]))
    expect(result.current.hasSelectionChanges).toBe(false)
  })

  it('flips true when routeEnabled toggles on', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.routeEnabled).toBe(false))

    act(() => result.current.setRouteEnabled(true))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })

  it('flips true when localAgentIds add a new id', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.localAgentIds).toEqual([]))

    act(() => result.current.setLocalAgentIds(['agt_other']))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })

  it('flips true when showLocalChildOutput toggles', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.showLocalChildOutput).toBe(true))

    act(() => result.current.setShowLocalChildOutput(false))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })

  it('flips true when showRemoteChildOutput toggles', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.showRemoteChildOutput).toBe(true))

    act(() => result.current.setShowRemoteChildOutput(false))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })

  it('flips true when a remote entry is added', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.remoteEntries).toEqual([]))

    act(() =>
      result.current.setRemoteEntries([
        {
          id: 're_1',
          name: 'r1',
          url: 'https://r1',
          description: '',
          apiKey: '',
          showApiKey: false,
        },
      ]),
    )
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })

  // BUG (current behavior, intentionally locked):
  // sameRemoteEntries (use-agent-form.ts:146-152) compares POSITIONALLY with
  // `a.every((entry, i) => ... === b[i].xxx)`, while sameItems (skills) and
  // sameEnv (env) compare by content. This means swapping two existing remote
  // entries with identical content flips hasSelectionChanges to true.
  //
  // This is inconsistent with the other "same" helpers. Tracked for PR 5 to
  // either (a) make sameRemoteEntries content-comparing (by name+url map), or
  // (b) document the position-sensitive intent if actually wanted.
  //
  // We lock the buggy current behavior so PR 5's fix is a deliberate, reviewed
  // change — not an accidental side effect of the rewrite.
  it('flips true when existing remote entries are reordered with identical content (BUG, locked for PR 5)', async () => {
    // Override the agent fixture for this one render so initial remoteEntries
    // is [a, b] — needed to actually exercise the positional comparison path.
    vi.mocked(useAgent).mockReturnValueOnce({
      data: {
        data: {
          ...agentFixture,
          a2aRouteTargets: [
            { type: 'remote', name: 'A', url: 'https://a' },
            { type: 'remote', name: 'B', url: 'https://b' },
          ],
        },
        permission: 'owner',
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useAgent>)

    const { result } = renderForm()
    await waitFor(() => expect(result.current.remoteEntries).toHaveLength(2))
    expect(result.current.hasSelectionChanges).toBe(false)

    // Reorder [A, B] → [B, A] keeping the SAME ids and content
    const [first, second] = result.current.remoteEntries
    act(() => result.current.setRemoteEntries([second, first]))

    // Current (buggy) behavior: positional compare flips dirty even though
    // the set is identical.
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))
  })
})

// ---------------------------------------------------------------------------
// discardChanges
// ---------------------------------------------------------------------------
describe('useAgentForm — discardChanges', () => {
  it('reverts all selection state back to initial after dirty mutations', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.selectedSkills).toEqual(['skl_a', 'skl_b']))

    act(() => {
      result.current.setSelectedSkills(['skl_a', 'skl_b', 'skl_c'])
      result.current.setWorkspaceType('scm')
      result.current.setRouteEnabled(true)
    })
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))

    act(() => result.current.discardChanges())

    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(false))
    expect(result.current.selectedSkills).toEqual(['skl_a', 'skl_b'])
    expect(result.current.workspaceType).toBe('temp')
    expect(result.current.routeEnabled).toBe(false)
  })

  it('resets showLocalChildOutput when only that switch was toggled', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.showLocalChildOutput).toBe(true))

    act(() => result.current.setShowLocalChildOutput(false))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))

    act(() => result.current.discardChanges())

    await waitFor(() => expect(result.current.showLocalChildOutput).toBe(true))
    expect(result.current.hasSelectionChanges).toBe(false)
  })

  it('resets showRemoteChildOutput when only that switch was toggled', async () => {
    const { result } = renderForm()
    await waitFor(() => expect(result.current.showRemoteChildOutput).toBe(true))

    act(() => result.current.setShowRemoteChildOutput(false))
    await waitFor(() => expect(result.current.hasSelectionChanges).toBe(true))

    act(() => result.current.discardChanges())

    await waitFor(() => expect(result.current.showRemoteChildOutput).toBe(true))
    expect(result.current.hasSelectionChanges).toBe(false)
  })
})

/**
 * `?publishTab=<key>` used to mean "which publish sub-tab is active", and creation
 * appended `publishTab=feishu` to land guided users on that tab. channel-config-modal
 * later repurposed the very same param to mean "which channel's config dialog is
 * OPEN", so the untouched redirect started popping the Feishu dialog over a brand-new
 * Agent. `onboarding=1` alone still pins Feishu first in the grid, which is all the
 * redirect was ever meant to do.
 */
describe('useAgentForm — post-create redirect does not force a channel dialog open', () => {
  beforeEach(() => {
    mutateAsyncStub.mockClear()
    navigateStub.mockClear()
    localStorage.clear()
  })

  const formValues: Parameters<ReturnType<typeof useAgentForm>['onSubmit']>[0] = {
    name: 'New Agent',
    description: '',
    systemPrompt: '',
    icon: '🤖',
    providerApiKey: '',
    providerBaseUrl: '',
    providerOauthToken: '',
    authMode: 'apiKey',
    providerId: 'prv_a',
    model: 'gpt-4',
    readOnly: false,
    force: true,
    cleanResult: true,
    maxConcurrency: 1,
    timeoutMinutes: 10,
    maxRetries: 2,
    totalTimeoutMinutes: null,
  }

  async function submitCreate(templateData?: Parameters<typeof useAgentForm>[2]) {
    const { result } = renderForm({ createMode: true, templateData })
    await act(async () => {
      await result.current.onSubmit(formValues)
    })
    await waitFor(() => expect(navigateStub).toHaveBeenCalled())
    return String(navigateStub.mock.calls.at(-1)?.[0] ?? '')
  }

  it('keeps the Feishu dialog closed for a guided template with no tour running', async () => {
    // The reported bug: a template landed the user on a brand-new Agent with the
    // Feishu config dialog already open. onboarding=1 pins Feishu first in the
    // grid, which is all this path ever needed.
    const target = await submitCreate({
      name: 'Guided',
      gotoPublishAfterCreate: true,
    } as Parameters<typeof useAgentForm>[2])

    expect(target).not.toContain('publishTab=feishu')
    expect(target).toContain('tab=publish')
    expect(target).toContain('onboarding=1')
  })

  it('opens the Feishu dialog while the onboarding tour is active', async () => {
    // The tour's whole Feishu branch is gated on publishTab=feishu, and the
    // choose-method step targets an element inside that dialog — so here the
    // parameter is required, not a bug.
    localStorage.setItem('a2wave:onboarding:active', '1')

    const target = await submitCreate()

    expect(target).toContain('publishTab=feishu')
    expect(target).toContain('tab=publish')
    expect(target).toContain('onboarding=1')
  })

  it('lands on the plain detail page for an ordinary creation', async () => {
    const target = await submitCreate()

    expect(target).toBe('/agents/agt_test1')
  })
})
