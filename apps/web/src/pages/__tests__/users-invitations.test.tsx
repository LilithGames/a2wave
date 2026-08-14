import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen, waitFor, within } from '@/test/render'
import { UsersPage } from '../users'

const { apiGetMock, apiPostMock, apiDeleteMock, confirmMock, messageMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiDeleteMock: vi.fn(),
  confirmMock: vi.fn(),
  messageMock: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => apiGetMock(path),
    post: (path: string, body: unknown) => apiPostMock(path, body),
    delete: (path: string) => apiDeleteMock(path),
  },
}))

vi.mock('@/lib/confirm', () => ({ confirm: (opts: unknown) => confirmMock(opts) }))

vi.mock('@/lib/antd-static', () => ({
  message: messageMock,
  modal: { confirm: vi.fn() },
  notification: { open: vi.fn() },
}))

const FUTURE = new Date(Date.now() + 86_400_000).toISOString()

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv_1',
    code: 'CODE123',
    email: 'dev@company.com',
    role: 'user',
    status: 'pending',
    note: null,
    invitedBy: 'usr_admin',
    invitedByName: 'Admin',
    acceptedUserId: null,
    acceptedAt: null,
    expiresAt: FUTURE,
    createdAt: FUTURE,
    ...overrides,
  }
}

/** The users table is fetched with bare `fetch`, not the api client. */
function stubUserList() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [],
        pagination: { total: 0, page: 1, pageSize: 20, totalPages: 0 },
      }),
    }),
  )
}

/** URLs the page requested through bare `fetch` (the roster query). */
function fetchCalls(): string[] {
  const mock = globalThis.fetch as unknown as { mock?: { calls: unknown[][] } }
  return (mock.mock?.calls ?? []).map(([url]) => String(url))
}

function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    writable: true,
    configurable: true,
  })
  return writeText
}

describe('UsersPage — invitations drawer', () => {
  beforeEach(() => {
    apiGetMock.mockReset()
    apiPostMock.mockReset()
    apiDeleteMock.mockReset()
    confirmMock.mockReset()
    messageMock.success.mockReset()
    messageMock.error.mockReset()
    stubUserList()
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://a2wave.test', pathname: '/users' },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Render the page and open the invitations drawer. */
  async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
    renderWithProviders(<UsersPage />)
    await user.click(await screen.findByRole('button', { name: /邀请记录/ }))
  }

  // The drawer's open state lives in the URL so it can be linked and survives a reload.
  it('opens straight from a deep link without a click', async () => {
    apiGetMock.mockResolvedValue({ data: [invitation()] })
    renderWithProviders(<UsersPage />, {
      routerProps: { initialEntries: ['/users?view=invitations'] },
    })

    expect(await screen.findByText('dev@company.com')).toBeInTheDocument()
    expect(apiGetMock).toHaveBeenCalledWith('/users/invitations')
  })

  it('stays closed for an unrelated view param', async () => {
    apiGetMock.mockResolvedValue({ data: [invitation()] })
    renderWithProviders(<UsersPage />, {
      routerProps: { initialEntries: ['/users?view=something-else'] },
    })

    await screen.findByRole('button', { name: /邀请记录/ })
    expect(apiGetMock).not.toHaveBeenCalled()
  })

  it('preserves the current page when the drawer is opened and closed', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: [invitation()] })
    // Rendered on page 3 with the drawer already open: closing it must drop only `view`.
    renderWithProviders(<UsersPage />, {
      routerProps: { initialEntries: ['/users?page=3&view=invitations'] },
    })

    await screen.findByText('dev@company.com')
    await user.click(screen.getByRole('button', { name: /Close/i }))

    // Back to the roster, still on page 3 — closing a drawer must not reset where the
    // admin was in the list.
    await waitFor(() => {
      expect(screen.queryByText('dev@company.com')).not.toBeInTheDocument()
    })
    expect(fetchCalls().some((url) => url.includes('page=3'))).toBe(true)
  })

  // The page's subject is the roster, so the invitations request must not fire until the
  // drawer is actually opened.
  it('does not fetch invitations until the drawer is opened', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: [invitation()] })
    renderWithProviders(<UsersPage />)

    await screen.findByRole('button', { name: /邀请记录/ })
    expect(apiGetMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /邀请记录/ }))
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/users/invitations')
    })
  })

  it('lists outstanding invitations', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: [invitation()] })
    await openDrawer(user)

    expect(await screen.findByText('dev@company.com')).toBeInTheDocument()
    expect(screen.getByText('待接受')).toBeInTheDocument()
  })

  it('labels an unpinned invitation rather than leaving the cell blank', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: [invitation({ email: null })] })
    await openDrawer(user)

    expect(await screen.findByText('不限邮箱')).toBeInTheDocument()
  })

  // Copy and revoke act on a live credential; offering them on a spent link would be an
  // action that silently does nothing.
  it.each([
    ['accepted', '已注册'],
    ['expired', '已过期'],
    ['revoked', '已撤销'],
  ])('offers no actions on a %s invitation', async (status, label) => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: [invitation({ status })] })
    await openDrawer(user)

    expect(await screen.findByText(label)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /复制链接/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /撤销邀请/ })).not.toBeInTheDocument()
  })

  it('copies the invite link against the current origin', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    apiGetMock.mockResolvedValue({ data: [invitation()] })
    await openDrawer(user)

    await screen.findByText('dev@company.com')
    await user.click(screen.getAllByRole('button', { name: /复制链接/ })[0])

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('https://a2wave.test/invite/CODE123')
    })
  })

  it('revokes only after the confirmation is accepted', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue({ data: [invitation()] })
    confirmMock.mockResolvedValue(false)
    await openDrawer(user)

    await screen.findByText('dev@company.com')
    await user.click(screen.getAllByRole('button', { name: /撤销邀请/ })[0])

    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(apiPostMock).not.toHaveBeenCalled()

    confirmMock.mockResolvedValue(true)
    await user.click(screen.getAllByRole('button', { name: /撤销邀请/ })[0])

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/users/invitations/inv_1/revoke', {})
    })
  })
})

describe('UsersPage — invite dialog', () => {
  beforeEach(() => {
    apiGetMock.mockReset()
    apiPostMock.mockReset()
    messageMock.success.mockReset()
    messageMock.error.mockReset()
    apiGetMock.mockResolvedValue({ data: [] })
    stubUserList()
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://a2wave.test', pathname: '/users' },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    renderWithProviders(<UsersPage />)
    await user.click(await screen.findByRole('button', { name: /邀请用户/ }))
    return await screen.findByRole('dialog')
  }

  // The console offers no expiry choice, so it must not send one: the value has a single
  // home in the shared schema's default, and restating it here would let the two drift.
  it('creates an invitation without restating the expiry', async () => {
    const user = userEvent.setup()
    apiPostMock.mockResolvedValue({ data: invitation() })
    const dialog = await openDialog(user)

    await user.click(within(dialog).getByRole('button', { name: /生成邀请链接/ }))

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/users/invitations', {
        email: undefined,
        role: 'user',
        note: undefined,
      })
    })
  })

  it('states the fixed validity up front instead of offering a picker', async () => {
    const user = userEvent.setup()
    const dialog = await openDialog(user)

    expect(within(dialog).getByText(/有效期 1 小时/)).toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/有效期/)).not.toBeInTheDocument()
  })

  it('passes the typed email and note through', async () => {
    const user = userEvent.setup()
    apiPostMock.mockResolvedValue({ data: invitation() })
    const dialog = await openDialog(user)

    await user.type(within(dialog).getByLabelText(/邮箱/), 'new@company.com')
    await user.type(within(dialog).getByLabelText(/备注/), 'platform team')
    await user.click(within(dialog).getByRole('button', { name: /生成邀请链接/ }))

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/users/invitations', {
        email: 'new@company.com',
        role: 'user',
        note: 'platform team',
      })
    })
  })

  it('blocks submission on a malformed email', async () => {
    const user = userEvent.setup()
    const dialog = await openDialog(user)

    await user.type(within(dialog).getByLabelText(/邮箱/), 'not-an-email')

    expect(await within(dialog).findByText(/邮箱格式不正确/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /生成邀请链接/ })).toBeDisabled()
    expect(apiPostMock).not.toHaveBeenCalled()
  })

  // The link is the one thing the admin came for, so success must show it rather than
  // closing the dialog.
  it('shows the generated link instead of closing on success', async () => {
    const user = userEvent.setup()
    apiPostMock.mockResolvedValue({ data: invitation() })
    const dialog = await openDialog(user)

    await user.click(within(dialog).getByRole('button', { name: /生成邀请链接/ }))

    expect(await screen.findByText('https://a2wave.test/invite/CODE123')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /生成邀请链接/ })).not.toBeInTheDocument()
  })

  it('surfaces a duplicate-email rejection in the dialog', async () => {
    const user = userEvent.setup()
    apiPostMock.mockRejectedValue(new Error('EMAIL_ALREADY_REGISTERED'))
    const dialog = await openDialog(user)

    await user.type(within(dialog).getByLabelText(/邮箱/), 'taken@company.com')
    await user.click(within(dialog).getByRole('button', { name: /生成邀请链接/ }))

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled())
    expect(screen.queryByText(/invite\/CODE123/)).not.toBeInTheDocument()
  })
})
