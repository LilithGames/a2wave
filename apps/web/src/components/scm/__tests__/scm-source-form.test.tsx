import i18n from '@/i18n'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * Regression tests for SCM save-error visibility.
 *
 * The bug: create/update mutation errors were rendered inside the Config tab's
 * pane. Saving from the "Sync & Workspaces" tab keeps that pane unmounted, so a
 * legitimately-triggerable failure (e.g. the 409 returned when a sync is in
 * progress) produced no feedback at all — the spinner just stopped and the
 * modal stayed open. Delete failures were likewise only logged to the console.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const idleMutation = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ data: {} }),
  isPending: false,
  isError: false,
  isSuccess: false,
  error: null as Error | null,
  data: undefined,
  reset: vi.fn(),
})

const SOURCE = {
  id: 'scm_1',
  name: 'My Repo',
  description: '',
  type: 'git',
  localPath: '/tmp/repo',
  workspacesPath: null,
  isEnabled: true,
  initialSyncCompletedAt: null,
  config: { type: 'git', repoUrl: 'https://example.com/x.git', branch: 'main' },
}

const updateMock = vi.fn(idleMutation)
const deleteMock = vi.fn(idleMutation)

vi.mock('@/hooks/use-scm-sources', () => ({
  useScmSource: vi.fn(() => ({ data: SOURCE, isPending: false, error: null })),
  useScmSourceStatus: vi.fn(() => ({ data: { syncStatus: 'idle' } })),
  useScmSourceWorkspaces: vi.fn(() => ({
    data: { workspaces: [] },
    isLoading: false,
    refetch: vi.fn(),
  })),
  useCreateScmSource: vi.fn(() => idleMutation()),
  useUpdateScmSource: (...args: unknown[]) => updateMock(...(args as [])),
  useDeleteScmSource: (...args: unknown[]) => deleteMock(...(args as [])),
  useSyncScmSource: vi.fn(() => idleMutation()),
  useCheckScmSource: vi.fn(() => idleMutation()),
  useProbeScmSource: vi.fn(() => idleMutation()),
  useReindexScmCodegraph: vi.fn(() => idleMutation()),
  useDeleteScmWorkspace: vi.fn(() => idleMutation()),
}))

import { ScmSourceForm } from '../scm-source-form'

function renderForm() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return render(<ScmSourceForm sourceId="scm_1" onSaved={() => {}} onDeleted={() => {}} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  })
}

describe('ScmSourceForm — mutation error visibility', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    updateMock.mockImplementation(idleMutation)
    deleteMock.mockImplementation(idleMutation)
  })

  it('shows the save error while the Sync & Workspaces tab is active', () => {
    updateMock.mockImplementation(() => ({
      ...idleMutation(),
      isError: true,
      error: new Error('A sync is currently in progress'),
    }))
    renderForm()

    // Switch away from Config — this is the tab where the error used to vanish.
    // The tab bar is an antd Segmented, whose items are radios (not `tab`s), and
    // antd renders the real radio under `pointer-events: none` — so drive it
    // with a change event rather than a synthetic pointer click.
    fireEvent.click(screen.getByRole('radio', { name: '同步与工作区' }))

    expect(screen.getByText('A sync is currently in progress')).not.toBeNull()
  })

  it('shows the save error on the Config tab too', () => {
    updateMock.mockImplementation(() => ({
      ...idleMutation(),
      isError: true,
      error: new Error('Cannot delete: referenced by agents: Alpha, Beta'),
    }))
    renderForm()
    expect(screen.getByText('Cannot delete: referenced by agents: Alpha, Beta')).not.toBeNull()
  })

  it('shows a delete failure inside the still-open confirm dialog', async () => {
    // The real interaction: confirm the delete, the request 409s, and the dialog
    // stays open. The error has to render *inside* the dialog — a banner in the
    // form underneath would sit below the dialog overlay and never be seen.
    const reject = vi
      .fn()
      .mockRejectedValue(new Error('Workspace is occupied by a running or pending run'))
    deleteMock.mockImplementation(() => ({
      ...idleMutation(),
      mutateAsync: reject,
      isError: true,
      error: new Error('Workspace is occupied by a running or pending run'),
    }))
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole('button', { name: '更多操作' }))
    await user.click(await screen.findByText('删除 Git Source'))

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '删除' }))

    // Still open, and the reason is visible within the dialog itself.
    expect(
      within(dialog).getByText('Workspace is occupied by a running or pending run'),
    ).not.toBeNull()
    expect(reject).toHaveBeenCalled()
  })

  it('surfaces a delete failure in the save bar once the dialog is dismissed', () => {
    deleteMock.mockImplementation(() => ({
      ...idleMutation(),
      isError: true,
      error: new Error('Source is in use by a running job'),
    }))
    renderForm()
    // Dialog closed → the underlying banner is the only place left to show it.
    expect(screen.getByText('Source is in use by a running job')).not.toBeNull()
  })

  it('renders no error banner when both mutations are idle', () => {
    renderForm()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
