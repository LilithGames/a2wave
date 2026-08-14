/**
 * Tests for the connection probe in the SCM source form.
 *
 * The probe tests the config *currently in the form* (unlike the Sync tab's
 * "Check Connection", which tests the saved config by id), so the properties
 * that matter are: it is reachable in create mode, it submits the edited values
 * rather than the stored ones, and a multi-repo failure names the repo that
 * failed instead of only reporting a count.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

const idleMutation = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ data: {} }),
  isPending: false,
  isError: false,
  isSuccess: false,
  error: null as Error | null,
  data: undefined as unknown,
  reset: vi.fn(),
})

const GIT_SOURCE = {
  id: 'scm_1',
  name: 'My Repo',
  description: '',
  type: 'git',
  localPath: '/tmp/repo',
  workspacesPath: null,
  isEnabled: true,
  initialSyncCompletedAt: null,
  config: { type: 'git', repoUrl: 'https://example.com/x.git', branch: 'main', pat: '********' },
}

const MULTI_REPO_SOURCE = {
  ...GIT_SOURCE,
  config: {
    type: 'git',
    repoUrl: '',
    branch: 'main',
    repos: [{ repoUrl: 'https://example.com/a.git', branch: 'main', directory: '' }],
  },
}
const P4_SOURCE = {
  ...GIT_SOURCE,
  type: 'p4',
  localPath: '/data/p4/client',
  config: {
    type: 'p4',
    p4port: 'ssl:p4.example.com:1666',
    p4user: 'builder',
    p4passwd: '********',
    p4client: 'builder-client',
  },
}

/**
 * `useScmSource`'s result feeds a `useEffect([source, reset])` that resets the
 * form. Returning a fresh object identity per call therefore re-runs that effect
 * forever and hangs the worker — so every query result here must be a stable
 * module-level constant, never an inline literal.
 */
const GIT_RESULT = { data: GIT_SOURCE, isPending: false, error: null }
const MULTI_REPO_RESULT = { data: MULTI_REPO_SOURCE, isPending: false, error: null }
const P4_RESULT = { data: P4_SOURCE, isPending: false, error: null }
const EMPTY_RESULT = { data: undefined, isPending: false, error: null }

const probeMock = vi.fn(idleMutation)
const createMock = vi.fn(idleMutation)
const sourceMock = vi.fn(() => GIT_RESULT)

vi.mock('@/hooks/use-scm-sources', () => ({
  useScmSource: (...args: unknown[]) => sourceMock(...(args as [])),
  useScmSourceStatus: vi.fn(() => ({ data: { syncStatus: 'idle' } })),
  useScmSourceWorkspaces: vi.fn(() => ({
    data: { workspaces: [] },
    isLoading: false,
    refetch: vi.fn(),
  })),
  useCreateScmSource: (...args: unknown[]) => createMock(...(args as [])),
  useUpdateScmSource: vi.fn(() => idleMutation()),
  useDeleteScmSource: vi.fn(() => idleMutation()),
  useSyncScmSource: vi.fn(() => idleMutation()),
  useCheckScmSource: vi.fn(() => idleMutation()),
  useProbeScmSource: (...args: unknown[]) => probeMock(...(args as [])),
  useReindexScmCodegraph: vi.fn(() => idleMutation()),
  useDeleteScmWorkspace: vi.fn(() => idleMutation()),
}))

import { ScmSourceForm } from '../scm-source-form'

function renderForm(sourceId?: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
  return render(<ScmSourceForm sourceId={sourceId} onSaved={() => {}} onDeleted={() => {}} />, {
    wrapper: Wrapper,
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.clearAllMocks()
  probeMock.mockImplementation(idleMutation)
  createMock.mockImplementation(idleMutation)
  sourceMock.mockImplementation(() => GIT_RESULT)
})

describe('ScmSourceForm — connection probe', () => {
  it('uses managed storage by default and submits no localPath', async () => {
    sourceMock.mockImplementation(() => EMPTY_RESULT as never)
    const mutate = vi.fn()
    createMock.mockImplementation(() => ({ ...idleMutation(), mutate }))
    const user = userEvent.setup()
    renderForm(undefined)

    expect(screen.getByText(/Managed storage/i)).toBeInTheDocument()
    expect(
      screen.queryByText('Basic source information and local path configuration'),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Local Path/i)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText(/^Name/i), 'Managed repo')
    await user.type(screen.getByLabelText(/Repository URL/i), 'https://example.com/new.git')
    await user.click(screen.getByRole('button', { name: /^Create$/i }))

    expect(mutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ localPath: expect.anything() }),
      expect.anything(),
    )
  })

  it('keeps the custom path input inside the custom storage choice', async () => {
    sourceMock.mockImplementation(() => EMPTY_RESULT as never)
    renderForm(undefined)

    const customStorage = screen.getByRole('radio', { name: /Custom path/i })
    expect(customStorage.closest('.ant-segmented')).not.toBeNull()
    fireEvent.click(customStorage)

    const customStorageRow = screen
      .getByLabelText(/^Local Path/i)
      .closest('[data-storage-choice="custom"]')
    expect(customStorageRow).not.toBeNull()
    expect(screen.getByLabelText(/^Local Path/i)).toBeInTheDocument()
    expect(customStorageRow).toContainElement(screen.getByLabelText(/^Local Path/i))
  })

  it('requires a custom local path for a new P4 source', async () => {
    sourceMock.mockImplementation(() => EMPTY_RESULT as never)
    const user = userEvent.setup()
    renderForm(undefined)

    await user.click(screen.getByText('Perforce (P4)'))

    expect(screen.queryByText(/Managed storage/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^Local Path/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Create$/i }))
    expect(screen.getByText('Local path is required')).toBeInTheDocument()
  })

  it('probes P4 root coverage using the current local path', async () => {
    sourceMock.mockImplementation(() => EMPTY_RESULT as never)
    const mutate = vi.fn()
    probeMock.mockImplementation(() => ({ ...idleMutation(), mutate }))
    const user = userEvent.setup()
    renderForm(undefined)

    await user.click(screen.getByText('Perforce (P4)'))
    await user.type(screen.getByLabelText(/^Local Path/i), '/data/p4/client-a')
    await user.type(screen.getByLabelText(/P4PORT/i), 'ssl:p4.example.com:1666')
    await user.type(screen.getByLabelText(/P4USER/i), 'builder')
    await user.type(screen.getByLabelText(/P4CLIENT/i), 'client-a')
    await user.click(screen.getByRole('button', { name: /Test Connection/i }))

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'p4', localPath: '/data/p4/client-a' }),
    )
  })

  it('allows an existing P4 source path to be repaired in place', () => {
    sourceMock.mockImplementation(() => P4_RESULT as never)
    renderForm('scm_p4')

    expect(screen.getByLabelText(/^Local Path/i)).not.toHaveAttribute('readonly')
  })

  it('uses the standard field rhythm and placeholder for an existing P4 path', () => {
    sourceMock.mockImplementation(() => P4_RESULT as never)
    renderForm('scm_p4')

    const input = screen.getByLabelText(/^Local Path/i)
    expect(input).toHaveAttribute('placeholder', '/data/p4/client')
    expect(input.parentElement).toHaveClass('space-y-1.5')
    expect(screen.getByText(/^Local Path$/i)).toHaveClass('text-sm')
  })

  it('keeps the same standard field contract for a read-only Git path', () => {
    renderForm('scm_1')

    const input = screen.getByLabelText(/^Local Path/i)
    expect(input).toHaveAttribute('placeholder', '/data/repos/repository')
    expect(input).toHaveAttribute('readonly')
    expect(input.parentElement).toHaveClass('space-y-1.5')
  })

  it('offers the probe button in create mode, before a source exists', () => {
    sourceMock.mockImplementation(() => EMPTY_RESULT as never)
    renderForm(undefined)

    expect(screen.getByRole('button', { name: /Test Connection/i })).toBeInTheDocument()
  })

  it('submits the edited form values, not the stored config', async () => {
    const mutate = vi.fn()
    probeMock.mockImplementation(() => ({ ...idleMutation(), mutate }))
    const user = userEvent.setup()
    renderForm('scm_1')

    const repoUrl = screen.getByLabelText(/Repository URL/i)
    await user.clear(repoUrl)
    await user.type(repoUrl, 'https://example.com/edited.git')
    await user.click(screen.getByRole('button', { name: /Test Connection/i }))

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'git',
        sourceId: 'scm_1',
        config: expect.objectContaining({ repoUrl: 'https://example.com/edited.git' }),
      }),
    )
  })

  it('passes no sourceId in create mode', async () => {
    sourceMock.mockImplementation(() => EMPTY_RESULT as never)
    const mutate = vi.fn()
    probeMock.mockImplementation(() => ({ ...idleMutation(), mutate }))
    const user = userEvent.setup()
    renderForm(undefined)

    await user.type(screen.getByLabelText(/Repository URL/i), 'https://example.com/new.git')
    await user.click(screen.getByRole('button', { name: /Test Connection/i }))

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ sourceId: undefined }))
  })

  it('blocks the probe in create mode when no repo URL has been entered', async () => {
    sourceMock.mockImplementation(() => EMPTY_RESULT as never)
    const mutate = vi.fn()
    probeMock.mockImplementation(() => ({ ...idleMutation(), mutate }))
    const user = userEvent.setup()
    renderForm(undefined)

    await user.click(screen.getByRole('button', { name: /Test Connection/i }))

    expect(mutate).not.toHaveBeenCalled()
    expect(screen.getByText(/Enter a repository URL first/i)).toBeInTheDocument()
  })

  it('blocks the probe when a multi-repo entry has a blank directory', async () => {
    // `directory` is `.min(1)` in the schema, so submitting a blank one returns a
    // bare "Invalid probe input" that names no field. Catch it client-side and
    // say which field is missing instead.
    sourceMock.mockImplementation(() => MULTI_REPO_RESULT as never)
    const mutate = vi.fn()
    probeMock.mockImplementation(() => ({ ...idleMutation(), mutate }))
    const user = userEvent.setup()
    renderForm('scm_1')

    await user.click(screen.getByRole('button', { name: /Test All Repos/i }))

    expect(mutate).not.toHaveBeenCalled()
    expect(screen.getByText(/Give every repository a directory name first/i)).toBeInTheDocument()
  })

  it('names the failing repo in a multi-repo result instead of only a count', () => {
    sourceMock.mockImplementation(() => MULTI_REPO_RESULT as never)
    probeMock.mockImplementation(() => ({
      ...idleMutation(),
      data: {
        data: {
          ok: false,
          message: '1/2 repos connected, failed: repo-b',
          repos: [
            { directory: 'repo-a', repoUrl: 'https://x/a.git', ok: true, message: 'healthy' },
            {
              directory: 'repo-b',
              repoUrl: 'https://x/b.git',
              ok: false,
              message: 'Authentication failed',
            },
          ],
        },
      },
    }))
    renderForm('scm_1')

    expect(screen.getByText('repo-b')).toBeInTheDocument()
    expect(screen.getByText(/Authentication failed/i)).toBeInTheDocument()
    expect(screen.getByText('repo-a')).toBeInTheDocument()
  })

  /**
   * A one-repo multi-repo source aggregates to "0/1 repos connected, failed:
   * <dir>" — a count with no reason, which is precisely what the per-repo
   * breakdown exists to replace. Gating the list on repo *count* hid it in the
   * one case that needed it most.
   */
  it('gives the reason for a single repo in multi-repo mode', () => {
    sourceMock.mockImplementation(() => MULTI_REPO_RESULT as never)
    probeMock.mockImplementation(() => ({
      ...idleMutation(),
      data: {
        data: {
          ok: false,
          message: '0/1 repos connected, failed: only-repo',
          repos: [
            {
              directory: 'only-repo',
              repoUrl: 'https://x/a.git',
              ok: false,
              message: 'Repository not found',
            },
          ],
        },
      },
    }))
    renderForm('scm_1')

    expect(screen.getByText(/Repository not found/i)).toBeInTheDocument()
  })

  /**
   * `scmType` is `useState`, not a react-hook-form field, so switching it never
   * sets `isDirty` — an invalidation guard keyed only on `isDirty` would skip
   * the reset and leave a Git result sitting next to empty Perforce fields.
   */
  it('clears a probe result when the SCM type is switched in create mode', async () => {
    sourceMock.mockImplementation(() => EMPTY_RESULT as never)
    const reset = vi.fn()
    probeMock.mockImplementation(() => ({
      ...idleMutation(),
      reset,
      data: { data: { ok: true, message: 'Connected', repos: [] } },
    }))
    renderForm(undefined)

    expect(reset).not.toHaveBeenCalled()

    // antd's Segmented renders the real radio under `pointer-events: none`, so
    // drive it with a change event rather than a synthetic pointer click.
    fireEvent.click(screen.getByRole('radio', { name: /Perforce/i }))

    expect(reset).toHaveBeenCalled()
  })

  /**
   * A green check must never outlive the config it describes: probe URL A, edit
   * the field to B, and a result left on screen would invite saving B as though
   * it had been tested.
   */
  it('clears a probe result once a connection field is edited', async () => {
    const reset = vi.fn()
    probeMock.mockImplementation(() => ({
      ...idleMutation(),
      reset,
      data: { data: { ok: true, message: 'Connected', repos: [] } },
    }))
    renderForm('scm_1')

    expect(reset).not.toHaveBeenCalled()

    const urlInput = screen.getByDisplayValue('https://example.com/x.git')
    await userEvent.type(urlInput, '-edited')

    expect(reset).toHaveBeenCalled()
  })

  /**
   * `localPath` is a probed parameter for P4, not just a saved field: the probe
   * verifies the client Root/AltRoots actually cover it. It was missing from the
   * invalidation snapshot, which watched only the credential/URL fields — so
   * probing path A, then editing the path to B, left the green check sitting
   * next to an untested B.
   */
  it('clears a probe result once the P4 local path is edited', async () => {
    sourceMock.mockImplementation(() => P4_RESULT as never)
    const reset = vi.fn()
    probeMock.mockImplementation(() => ({
      ...idleMutation(),
      reset,
      data: { data: { ok: true, message: 'P4 connection is healthy' } },
    }))
    renderForm('scm_1')

    // Loading a P4 row flips `scmType`, which legitimately invalidates once.
    // The delta across the edit is what this test is about.
    const beforeEdit = reset.mock.calls.length

    const pathInput = screen.getByLabelText(/local path/i)
    await userEvent.type(pathInput, '-edited')

    expect(reset.mock.calls.length).toBeGreaterThan(beforeEdit)
  })

  it('shows a successful probe result', () => {
    probeMock.mockImplementation(() => ({
      ...idleMutation(),
      data: { data: { ok: true, message: '2/2 repos connected', repos: [] } },
    }))
    renderForm('scm_1')

    expect(screen.getByText(/2\/2 repos connected/i)).toBeInTheDocument()
  })

  it('shows the detected P4 root and a separate verification warning', () => {
    sourceMock.mockImplementation(() => P4_RESULT as never)
    probeMock.mockImplementation(() => ({
      ...idleMutation(),
      data: {
        data: {
          ok: true,
          message: 'P4 connection is healthy',
          clientRoot: '/data/p4/client',
          clientRootWarning: 'P4 client Root could not be verified',
        },
      },
    }))

    renderForm('scm_p4')

    expect(screen.getByText(/P4 Client Root: \/data\/p4\/client/)).toBeInTheDocument()
    expect(screen.getByText(/could not be verified/)).toBeInTheDocument()
  })

  it('surfaces a rejected probe request rather than failing silently', () => {
    probeMock.mockImplementation(() => ({
      ...idleMutation(),
      isError: true,
      error: new Error('SCM source not found'),
    }))
    renderForm('scm_1')

    expect(screen.getByText(/SCM source not found/i)).toBeInTheDocument()
  })
})
