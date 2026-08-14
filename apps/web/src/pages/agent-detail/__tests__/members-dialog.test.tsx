/**
 * Component tests for `<MembersDialog>`.
 *
 * What we lock here:
 * - Open=true wires the GET /agents/:id/members query (closed dialog must
 *   not fire it — important for cost and to keep audit logs clean).
 * - Owner row renders without delete/role-edit affordances; member rows do.
 * - Add flow: search → select → choose role → POST hits the right URL/body.
 * - Server error mapping: 409 'User is already a member' surfaces the
 *   `alreadyMember` translation in the inline banner.
 * - Update role triggers PATCH and Delete goes through the AlertDialog —
 *   confirming actually fires DELETE; cancel does not.
 *
 * We mock `@/lib/api` to keep this a pure UI/wiring test (no MSW server),
 * and we pre-seed the members query via `setQueryData` to bypass the loading
 * state and skip a `findByText` race.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { type ReactElement, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, userEvent, waitFor, within } from '@/test/render'
import i18n from '../../../i18n'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockDelete = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}))

import { MembersDialog } from '../members-dialog'

const AGENT_ID = 'agt_test1'

type MemberRowFixture = {
  userId: string
  username: string
  displayName: string | null
  email: string | null
  role: 'owner' | 'editor' | 'viewer'
  isOwner: boolean
  createdAt: string
}

const ownerRow: MemberRowFixture = {
  userId: 'usr_owner',
  username: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  role: 'owner',
  isOwner: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const editorRow: MemberRowFixture = {
  userId: 'usr_editor',
  username: 'bob',
  displayName: 'Bob',
  email: 'bob@example.com',
  role: 'editor',
  isOwner: false,
  createdAt: '2026-01-02T00:00:00.000Z',
}

const viewerRow: MemberRowFixture = {
  userId: 'usr_viewer',
  username: 'carol',
  displayName: 'Carol',
  email: 'carol@example.com',
  role: 'viewer',
  isOwner: false,
  createdAt: '2026-01-03T00:00:00.000Z',
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
}

function Harness({ initialOpen, agentId = AGENT_ID }: { initialOpen: boolean; agentId?: string }) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <>
      <button type="button" data-testid="harness-open" onClick={() => setOpen(true)}>
        open
      </button>
      <MembersDialog open={open} onClose={() => setOpen(false)} agentId={agentId} />
    </>
  )
}

/**
 * Custom render that lets us inject a specific QueryClient (so tests can
 * pre-seed the members query). We deliberately skip MemoryRouter — this
 * dialog doesn't navigate.
 */
function renderWithClient(ui: ReactElement, client: QueryClient) {
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
      </QueryClientProvider>
    ),
  })
}

function seedMembers(client: QueryClient, rows: MemberRowFixture[]) {
  client.setQueryData(['agents', AGENT_ID, 'members'], { data: rows })
}

describe('<MembersDialog>', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPost.mockReset()
    mockPatch.mockReset()
    mockDelete.mockReset()
  })

  it('does not fetch members when closed', () => {
    const client = makeClient()
    renderWithClient(<Harness initialOpen={false} />, client)
    // The dialog is rendered into ant-design portal lazily; either way no
    // /members request must have fired while open=false.
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('renders owner row + member rows when open', async () => {
    const client = makeClient()
    seedMembers(client, [ownerRow, editorRow, viewerRow])
    mockGet.mockResolvedValue({ data: [ownerRow, editorRow, viewerRow] })
    renderWithClient(<Harness initialOpen={true} />, client)

    // All three usernames should show up.
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument()
    })
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('carol')).toBeInTheDocument()

    // Owner row: no delete control. Other rows: delete present.
    expect(screen.queryByTestId('member-row-delete-usr_owner')).not.toBeInTheDocument()
    expect(screen.getByTestId('member-row-delete-usr_editor')).toBeInTheDocument()
    expect(screen.getByTestId('member-row-delete-usr_viewer')).toBeInTheDocument()
  })

  it('add flow: search → pick → POST', async () => {
    const client = makeClient()
    seedMembers(client, [ownerRow])

    // user-lookup fetch
    mockGet.mockImplementation((path: string) => {
      if (path.startsWith('/user-lookup')) {
        return Promise.resolve({
          data: [
            {
              id: 'usr_new',
              username: 'dave',
              displayName: 'Dave',
              email: 'dave@example.com',
            },
          ],
        })
      }
      // Fallback for any /agents/:id/members refetch from invalidation
      return Promise.resolve({ data: [ownerRow] })
    })

    mockPost.mockResolvedValueOnce({
      data: {
        userId: 'usr_new',
        username: 'dave',
        displayName: 'Dave',
        email: 'dave@example.com',
        role: 'viewer',
        isOwner: false,
        createdAt: '2026-04-01T00:00:00.000Z',
      },
    })

    renderWithClient(<Harness initialOpen={true} />, client)

    const searchInput = await screen.findByTestId('member-search-input')
    await userEvent.type(searchInput, 'dav')

    // Lookup result row appears, click it.
    const lookupRow = await screen.findByTestId('member-lookup-row-usr_new')
    await userEvent.click(lookupRow)

    const addBtn = screen.getByTestId('member-add-btn')
    await waitFor(() => expect(addBtn).not.toBeDisabled())

    await userEvent.click(addBtn)

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(`/agents/${AGENT_ID}/members`, {
        userId: 'usr_new',
        role: 'viewer',
      })
    })
  })

  it('add 409 surfaces the alreadyMember error banner', async () => {
    const client = makeClient()
    seedMembers(client, [ownerRow])

    mockGet.mockImplementation((path: string) => {
      if (path.startsWith('/user-lookup')) {
        return Promise.resolve({
          data: [
            {
              id: 'usr_new',
              username: 'dave',
              displayName: 'Dave',
              email: 'dave@example.com',
            },
          ],
        })
      }
      return Promise.resolve({ data: [ownerRow] })
    })

    mockPost.mockRejectedValueOnce(new Error('User is already a member'))

    renderWithClient(<Harness initialOpen={true} />, client)

    const searchInput = await screen.findByTestId('member-search-input')
    await userEvent.type(searchInput, 'dav')

    const lookupRow = await screen.findByTestId('member-lookup-row-usr_new')
    await userEvent.click(lookupRow)
    await userEvent.click(screen.getByTestId('member-add-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('member-error-banner')).toBeInTheDocument()
    })
    // Localized message — both zh and en variants of "already" mention member.
    expect(screen.getByTestId('member-error-banner').textContent ?? '').toMatch(
      /already a member|已经是成员/i,
    )
  })

  it('update role triggers PATCH', async () => {
    const client = makeClient()
    seedMembers(client, [ownerRow, viewerRow])

    // Keep the members query stable across refetches.
    mockGet.mockResolvedValue({ data: [ownerRow, viewerRow] })

    mockPatch.mockResolvedValueOnce({
      data: { ...viewerRow, role: 'editor' },
    })

    renderWithClient(<Harness initialOpen={true} />, client)

    // antd <Select> for role: open dropdown then click the editor option.
    const roleSel = await screen.findByTestId('member-row-role-usr_viewer')
    await userEvent.click(roleSel)
    const editorOption = await screen.findByText(/编辑|^Editor$/)
    await userEvent.click(editorOption)

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(`/agents/${AGENT_ID}/members/usr_viewer`, {
        role: 'editor',
      })
    })
  })

  it('delete confirm fires DELETE; cancel does not', async () => {
    const client = makeClient()
    seedMembers(client, [ownerRow, editorRow])

    mockGet.mockResolvedValue({ data: [ownerRow, editorRow] })
    mockDelete.mockResolvedValueOnce({ data: { ok: true } })

    renderWithClient(<Harness initialOpen={true} />, client)

    const deleteBtn = await screen.findByTestId('member-row-delete-usr_editor')
    await userEvent.click(deleteBtn)

    // AlertDialog title visible.
    const confirmDialog = await screen.findByTestId('member-remove-confirm')
    const cancelBtn = within(confirmDialog).getByTestId('member-remove-cancel')
    await userEvent.click(cancelBtn)

    // Cancel must NOT trigger DELETE.
    expect(mockDelete).not.toHaveBeenCalled()

    // Now click delete again, then confirm.
    await userEvent.click(screen.getByTestId('member-row-delete-usr_editor'))
    const confirmDialog2 = await screen.findByTestId('member-remove-confirm')
    await userEvent.click(within(confirmDialog2).getByTestId('member-remove-confirm-cta'))

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(`/agents/${AGENT_ID}/members/usr_editor`)
    })
  })

  it('disables Add button when selected user is already a member', async () => {
    const client = makeClient()
    seedMembers(client, [ownerRow, editorRow])

    mockGet.mockImplementation((path: string) => {
      if (path.startsWith('/user-lookup')) {
        return Promise.resolve({
          data: [
            {
              id: editorRow.userId,
              username: editorRow.username,
              displayName: editorRow.displayName,
              email: editorRow.email,
            },
          ],
        })
      }
      return Promise.resolve({ data: [ownerRow, editorRow] })
    })

    renderWithClient(<Harness initialOpen={true} />, client)

    const searchInput = await screen.findByTestId('member-search-input')
    await userEvent.type(searchInput, 'bob')

    const row = await screen.findByTestId(`member-lookup-row-${editorRow.userId}`)
    await userEvent.click(row)

    // Add stays disabled because the user is already a member.
    const addBtn = screen.getByTestId('member-add-btn')
    expect(addBtn).toBeDisabled()
  })
})
