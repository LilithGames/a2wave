/**
 * Wiring test for the Provider/MCP compatibility warning inside `<ConfigTab>`.
 *
 * Why this exists as a component test rather than a helper test: the A2A
 * routing Switch was removed, so `routeEnabled` is no longer a prop — ConfigTab
 * now *derives* it from the configured targets and feeds that into
 * `hasConfiguredMcpBackedCapabilities`. The helpers are unit-tested separately,
 * but only rendering the component proves the derivation is actually plumbed
 * in: hardcoding `routeEnabled = false` keeps every helper test green while
 * silently dropping the warning for a route-only agent.
 */
import { renderWithProviders, screen } from '@/test/render'
import type { ProviderCapabilities, ProviderDto } from '@a2wave/shared'
import { useForm } from 'react-hook-form'
import { describe, expect, it, vi } from 'vitest'
import { ConfigTab } from '../config-tab'
import type { AgentFormMethods, ProviderChainEntry, RemoteEntry } from '../types'

vi.mock('@/hooks/use-agents', () => ({
  useAllAgents: () => ({ data: { data: [] } }),
}))
vi.mock('@/hooks/use-auth', () => ({
  useCurrentUser: () => ({ data: { role: 'admin' } }),
}))
vi.mock('@/hooks/use-providers', () => ({
  useProbeModels: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/use-mcp-servers', () => ({
  useMcpServerTools: () => ({ data: undefined, isLoading: false, isError: false }),
}))

const capabilities: ProviderCapabilities = {
  authModes: ['apiKey'],
  defaultAuthMode: 'apiKey',
  modelDiscovery: { apiKey: 'manual' },
  credentialFields: { apiKey: [{ field: 'apiKey', required: true }] },
  // The Provider under test cannot deliver MCP — this is what the warning is about.
  mcpDelivery: { mode: 'none' },
  executionOptions: [],
  reasoningEffort: false,
  fastMode: false,
  sessionResume: false,
  sandbox: 'native',
}

const noMcpProvider = {
  id: 'prv_no_mcp',
  name: 'Pi CLI',
  kind: 'pi',
  capabilities,
} as unknown as ProviderDto

const chainEntry: ProviderChainEntry = {
  id: 'pc_1',
  providerId: 'prv_no_mcp',
  model: '',
  authMode: 'apiKey',
  providerApiKey: '',
  providerBaseUrl: '',
  providerOauthToken: '',
  enabled: true,
  expanded: false,
}

const remote = (over: Partial<RemoteEntry> = {}): RemoteEntry => ({
  id: 're_1',
  name: 'qa-bot',
  url: 'https://example.com/api/a2a/agt_x',
  description: '',
  apiKey: '',
  showApiKey: false,
  ...over,
})

function Harness({
  remoteEntries,
  localAgentIds = [],
  provider = noMcpProvider,
  entry = chainEntry,
}: {
  remoteEntries: RemoteEntry[]
  localAgentIds?: string[]
  provider?: ProviderDto
  entry?: ProviderChainEntry
}) {
  const form = useForm({
    defaultValues: {
      description: '',
      systemPrompt: '',
      providerId: entry.providerId,
      model: entry.model,
    },
  }) as unknown as AgentFormMethods

  return (
    <ConfigTab
      form={form}
      agentId="agt_1"
      agent={undefined}
      skillBindingScope="all-visible"
      skillBindingOwnerId={null}
      providersList={[provider]}
      providerChainEntries={[entry]}
      setProviderChainEntries={vi.fn()}
      skillsList={[]}
      skillGroupsList={[]}
      mcpServersList={[]}
      scmSourcesList={[]}
      selectedSkills={[]}
      setSelectedSkills={vi.fn()}
      selectedSkillGroupIds={[]}
      setSelectedSkillGroupIds={vi.fn()}
      selectedMcpServerIds={[]}
      setSelectedMcpServerIds={vi.fn()}
      kbDocumentsList={[]}
      selectedKbDocumentIds={[]}
      setSelectedKbDocumentIds={vi.fn()}
      workspaceType="temp"
      setWorkspaceType={vi.fn()}
      scmSubType="git"
      setScmSubType={vi.fn()}
      selectedScmSourceId={null}
      setSelectedScmSourceId={vi.fn()}
      envEntries={[]}
      setEnvEntries={vi.fn()}
      visibleEnvIds={new Set()}
      setVisibleEnvIds={vi.fn()}
      setRouteEnabled={vi.fn()}
      localAgentIds={localAgentIds}
      setLocalAgentIds={vi.fn()}
      showLocalChildOutput={false}
      setShowLocalChildOutput={vi.fn()}
      showRemoteChildOutput={false}
      setShowRemoteChildOutput={vi.fn()}
      remoteEntries={remoteEntries}
      setRemoteEntries={vi.fn()}
      resolvedWorkDir={{ path: '/tmp/x', scmType: null }}
      showApiKey={false}
      setShowApiKey={vi.fn()}
    />
  )
}

describe('ConfigTab — Provider/MCP compatibility warning', () => {
  it('warns when a route target exists and the Provider cannot deliver MCP', () => {
    // No MCP servers are mounted: A2A routing is the only MCP-backed capability,
    // so this only passes if the derived `routeEnabled` reaches the helper.
    renderWithProviders(<Harness remoteEntries={[remote()]} />)

    expect(screen.getByTestId('provider-mcp-unsupported')).toBeInTheDocument()
  })

  it('warns when the route target is a local agent', () => {
    renderWithProviders(<Harness remoteEntries={[]} localAgentIds={['agt_2']} />)

    expect(screen.getByTestId('provider-mcp-unsupported')).toBeInTheDocument()
  })

  it('stays silent when nothing MCP-backed is configured', () => {
    renderWithProviders(<Harness remoteEntries={[]} />)

    expect(screen.queryByTestId('provider-mcp-unsupported')).not.toBeInTheDocument()
  })

  it('stays silent when the only route target is a half-filled draft', () => {
    // Matches the save filter: a nameless or URL-less row is not a target, so
    // it must not trip a warning about capabilities that will not be persisted.
    renderWithProviders(<Harness remoteEntries={[remote({ url: '' })]} />)

    expect(screen.queryByTestId('provider-mcp-unsupported')).not.toBeInTheDocument()
  })
})

describe('ConfigTab — Pi proxy credentials', () => {
  it('renders an optional Base URL and requires a model probe', () => {
    const piProvider = {
      ...noMcpProvider,
      capabilities: {
        ...capabilities,
        modelDiscovery: { apiKey: 'manual' },
        credentialFields: {
          apiKey: [
            { field: 'apiKey', required: true },
            { field: 'baseUrl', required: false },
          ],
        },
      },
    } as ProviderDto
    const piEntry = {
      ...chainEntry,
      providerApiKey: 'agent-key',
      expanded: true,
    }

    renderWithProviders(<Harness remoteEntries={[]} provider={piProvider} entry={piEntry} />)

    expect(screen.getByTestId('provider-chain-model-select-0')).toHaveClass('ant-select-disabled')
    expect(screen.getByTestId('provider-chain-base-url-0')).toHaveAttribute(
      'placeholder',
      'https://proxy.example.com/v1',
    )
    expect(screen.getByTestId('provider-chain-probe-models-0')).toBeEnabled()
  })
})
