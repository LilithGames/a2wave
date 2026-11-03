/**
 * Permission-driven UI gating for the Agent Detail page.
 *
 * The backend's `GET /api/agents/:id` returns `{ data, meta: { permission } }`,
 * where permission is `'owner' | 'editor' | 'viewer'`. This page must:
 *   - Show the "Members" menu item only for owners.
 *   - Disable the Save button for viewers.
 *   - Keep Save enabled for editors and owners.
 *
 * To keep the test focused, we mock `useAgentForm` directly so we can vary
 * the returned `permission` without standing up the full agent fixture +
 * mutation graph.
 */
import { renderWithProviders, screen, userEvent, waitFor } from '@/test/render'
import type { AgentPermission } from '@a2wave/shared'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const baseAgent = {
  id: 'agt_test1',
  name: 'Fixture Agent',
  description: '',
  type: 'cursor',
  config: {},
  status: 'active',
  icon: '🤖',
  systemPrompt: '',
  skills: [],
  mcpServerIds: [],
  kbDocumentIds: [],
  publishStatus: 'draft',
  publishChannels: [],
  providerApiKey: null,
  providerBaseUrl: null,
  providerOauthToken: null,
  authMode: 'apiKey',
  endpointApiKey: null,
  publishAuthType: 'api_key',
  publishIpWhitelist: [],
  feishuConfig: null,
  scheduleConfig: null,
  providerId: null,
  env: {},
  workspaceType: 'temp',
  scmSourceId: null,
  maxConcurrency: 1,
  showLocalChildOutput: true,
  showRemoteChildOutput: true,
  a2aRouteTargets: null,
  userId: 'usr_owner',
}

// Hoisted shared mock so each test can rewire `permission`.
const useAgentFormMock = vi.hoisted(() => vi.fn())

vi.mock('../use-agent-form', () => ({
  useAgentForm: useAgentFormMock,
}))

// Side-quest mocks — page imports these but they're not under test here.
// Every query key the page imports must be listed: a missing one is `undefined`
// at the call site, and `invalidateQueries({queryKey: undefined})` matches every
// query in the client, so a future diagnose test would debug a mass
// invalidation instead of its own behaviour.
vi.mock('@/hooks/use-agents', () => ({
  FEISHU_CONNECTIONS_QUERY_KEY: ['feishu-connections'],
  CHAT_CONNECTIONS_QUERY_KEY: ['chat-connections'],
  useFeishuConnections: vi.fn(() => ({ data: undefined, isLoading: false })),
  useChatConnections: vi.fn(() => ({ data: undefined, isLoading: false })),
  useNativeChatConnections: vi.fn(() => ({
    connections: undefined,
    isLoading: false,
    errorByChannel: { feishu: false, slack: false, discord: false },
  })),
  useUpdateAgent: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}))

vi.mock('../config-tab', () => ({
  ConfigTab: () => <div data-testid="config-tab" />,
}))
vi.mock('../publish-tab', () => ({
  PublishTab: () => <div data-testid="publish-tab" />,
}))
vi.mock('../runs-tab', () => ({
  RunsTab: () => <div data-testid="runs-tab" />,
}))
vi.mock('../test-drawer', () => ({
  TestDrawer: () => null,
}))

import { AgentDetailPage } from '../index'

type FormStub = {
  register: ReturnType<typeof vi.fn>
  handleSubmit: (cb: (data: unknown) => unknown) => (e?: Event) => void
  watch: ReturnType<typeof vi.fn>
  setValue: ReturnType<typeof vi.fn>
  formState: { isDirty: boolean; errors: Record<string, never> }
}

function buildFormStub(): FormStub {
  return {
    register: vi.fn(() => ({})),
    handleSubmit: (cb) => (e) => {
      e?.preventDefault?.()
      return cb({})
    },
    watch: vi.fn(() => '🤖'),
    setValue: vi.fn(),
    formState: { isDirty: false, errors: {} },
  }
}

function mountWithPermission(permission: AgentPermission) {
  useAgentFormMock.mockReturnValue({
    agent: baseAgent,
    permission,
    isLoading: false,
    form: buildFormStub(),
    blocker: { state: 'unblocked' },
    providersList: [],
    skillsList: [],
    skillGroupsList: [],
    mcpServersList: [],
    scmSourcesList: [],
    kbDocumentsList: [],
    showApiKey: false,
    setShowApiKey: vi.fn(),
    selectedSkills: [],
    setSelectedSkills: vi.fn(),
    selectedSkillGroupIds: [],
    setSelectedSkillGroupIds: vi.fn(),
    selectedMcpServerIds: [],
    setSelectedMcpServerIds: vi.fn(),
    selectedKbDocumentIds: [],
    setSelectedKbDocumentIds: vi.fn(),
    workspaceType: 'temp',
    setWorkspaceType: vi.fn(),
    scmSubType: 'p4',
    setScmSubType: vi.fn(),
    selectedScmSourceId: null,
    setSelectedScmSourceId: vi.fn(),
    envEntries: [],
    setEnvEntries: vi.fn(),
    visibleEnvIds: new Set<string>(),
    setVisibleEnvIds: vi.fn(),
    routeEnabled: false,
    setRouteEnabled: vi.fn(),
    localAgentIds: [],
    setLocalAgentIds: vi.fn(),
    showLocalChildOutput: true,
    setShowLocalChildOutput: vi.fn(),
    showRemoteChildOutput: true,
    setShowRemoteChildOutput: vi.fn(),
    remoteEntries: [],
    setRemoteEntries: vi.fn(),
    resolvedWorkDir: { path: '/tmp/x', scmType: null },
    hasSelectionChanges: true, // keep true so save is gated only on canWrite
    discardChanges: vi.fn(),
    onSubmit: vi.fn(),
    handleDelete: vi.fn(),
    handleClone: vi.fn(),
    handlePublishConfirm: vi.fn(),
    handleStop: vi.fn(),
    handleResume: vi.fn(),
    isSaving: false,
    isDeleting: false,
    publishAgent: { isPending: false },
    stopAgent: { isPending: false },
    resumeAgent: { isPending: false },
    cloneAgent: { isPending: false },
  })

  return renderWithProviders(
    <Routes>
      <Route path="/agents/:id" element={<AgentDetailPage />} />
    </Routes>,
    { routerProps: { initialEntries: ['/agents/agt_test1'] } },
  )
}

describe('AgentDetailPage — permission gating', () => {
  it('viewer: Save disabled and Members menu item not rendered', async () => {
    mountWithPermission('viewer')

    const save = screen.getByTestId('agent-detail-save')
    await waitFor(() => expect(save).toBeDisabled())

    // Open the dropdown to inspect menu items.
    const more = screen.getByTestId('agent-detail-more-actions')
    await userEvent.click(more)

    expect(screen.queryByTestId('agent-members-menu-item')).not.toBeInTheDocument()
  })

  it('editor: Save enabled but Members menu item still hidden', async () => {
    mountWithPermission('editor')

    const save = screen.getByTestId('agent-detail-save')
    await waitFor(() => expect(save).not.toBeDisabled())

    const more = screen.getByTestId('agent-detail-more-actions')
    await userEvent.click(more)

    expect(screen.queryByTestId('agent-members-menu-item')).not.toBeInTheDocument()
  })

  it('owner: Save enabled and Members menu item visible', async () => {
    mountWithPermission('owner')

    const save = screen.getByTestId('agent-detail-save')
    await waitFor(() => expect(save).not.toBeDisabled())

    const more = screen.getByTestId('agent-detail-more-actions')
    await userEvent.click(more)

    await waitFor(() => {
      expect(screen.getByTestId('agent-members-menu-item')).toBeInTheDocument()
    })
  })
})
