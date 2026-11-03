import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * Smoke test for the MCP Group form modal (create mode).
 *
 * A group is a higher-level composition, not a transport type: the group form
 * shows the Group Configuration section outright and exposes NO stdio/SSE/HTTP
 * transport switcher (that choice only exists for the plain server form).
 */
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

const mutationStub = () => ({
  mutateAsync: vi.fn().mockResolvedValue({ data: { id: 'mcp_new' } }),
  mutate: vi.fn(),
  isPending: false,
  isSuccess: false,
  isError: false,
  error: null,
})

vi.mock('@/hooks/use-mcp-servers', () => ({
  useMcpServer: vi.fn(() => ({ data: undefined, isLoading: false })),
  useMcpServers: vi.fn(() => ({ data: { data: [] } })),
  useMcpServerTools: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    isFetching: false,
  })),
  useProbeTools: vi.fn(() => mutationStub()),
  useCreateMcpServer: vi.fn(() => mutationStub()),
  useUpdateMcpServer: vi.fn(() => mutationStub()),
  useDeleteMcpServer: vi.fn(() => mutationStub()),
  useCloneMcpServer: vi.fn(() => mutationStub()),
}))

vi.mock('@/hooks/use-auth', () => ({
  useCurrentUser: vi.fn(() => ({ data: { id: 'usr_admin', role: 'admin' } })),
}))

import { McpGroupFormModal } from '../mcp-group-form-modal'

function renderCreateModal() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return render(<McpGroupFormModal open onOpenChange={() => {}} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  })
}

describe('McpGroupFormModal — create mode', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('renders the new-group title', () => {
    renderCreateModal()
    expect(screen.getByText(/新建 MCP Group/)).not.toBeNull()
  })

  it('shows the Group Configuration section and no transport switcher', () => {
    renderCreateModal()
    expect(screen.getByText('Group 配置')).not.toBeNull()
    // The plain-server transport picker must NOT appear on the group form.
    expect(screen.queryByRole('button', { name: 'stdio' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'SSE' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'HTTP' })).toBeNull()
  })
})
