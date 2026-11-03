import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * Smoke test for the plain MCP server form modal (create mode).
 *
 * Locks the post-split contract: the plain-server form exposes exactly the
 * three transport types stdio / SSE / HTTP — Group is NO LONGER a transport
 * option here (groups now have their own top-level entry + modal). Also guards
 * against silent field loss when switching transport types (react-hook-form
 * keeps unmounted field values).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

// ---------------------------------------------------------------------------
// Hook mocks
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { McpServerFormModal } from '../mcp-server-form-modal'

function renderCreateModal() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return render(<McpServerFormModal open onOpenChange={() => {}} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('McpServerFormModal — create mode', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('renders the new-server title', () => {
    renderCreateModal()
    expect(screen.getByText(/新建 MCP Server/)).not.toBeNull()
  })

  it('renders exactly the 3 transport-type buttons — no Group option', () => {
    renderCreateModal()
    // The transport picker is an antd Segmented (radio-style), not buttons.
    expect(screen.getByText('stdio')).not.toBeNull()
    expect(screen.getByText('SSE')).not.toBeNull()
    expect(screen.getByText('HTTP')).not.toBeNull()
    // Group is no longer a transport type on the plain server form.
    expect(screen.queryByText('Group')).toBeNull()
  })

  it('shows stdio config by default and switches to SSE config on SSE click', () => {
    renderCreateModal()
    expect(screen.getByText('stdio 配置')).not.toBeNull()
    expect(screen.queryByText('SSE 配置')).toBeNull()

    fireEvent.click(screen.getByText('SSE'))

    expect(screen.getByText('SSE 配置')).not.toBeNull()
    expect(screen.queryByText('stdio 配置')).toBeNull()
  })

  it('preserves the stdio command value across stdio → SSE → stdio switch', () => {
    renderCreateModal()

    const commandInput = screen.getByPlaceholderText(/node|python|npx/) as HTMLInputElement
    fireEvent.change(commandInput, { target: { value: 'node my-server.js' } })
    expect(commandInput.value).toBe('node my-server.js')

    fireEvent.click(screen.getByText('SSE'))
    expect(screen.queryByPlaceholderText(/node|python|npx/)).toBeNull()

    fireEvent.click(screen.getByText('stdio'))
    const restored = screen.getByPlaceholderText(/node|python|npx/) as HTMLInputElement
    expect(restored.value).toBe('node my-server.js')
  })
})
