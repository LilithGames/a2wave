import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen, waitFor } from '@/test/render'
import { InvitePage } from '../invite'

const { apiGetMock, apiPostMock, navigateMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  navigateMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => apiGetMock(path),
    post: (path: string, body: unknown) => apiPostMock(path, body),
  },
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useParams: () => ({ code: 'CODE123' }),
    useNavigate: () => navigateMock,
  }
})

/** A still-usable invitation, unpinned unless a test says otherwise. */
function pendingInvitation(email: string | null = null) {
  return {
    data: {
      status: 'pending',
      email,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  }
}

function renderPage() {
  return renderWithProviders(<InvitePage />, {
    routerProps: { initialEntries: ['/invite/CODE123'] },
  })
}

describe('InvitePage', () => {
  beforeEach(() => {
    apiGetMock.mockReset()
    apiPostMock.mockReset()
    navigateMock.mockReset()
  })

  it('renders the registration form for a pending invitation', async () => {
    apiGetMock.mockResolvedValue(pendingInvitation())
    renderPage()

    await waitFor(() => {
      expect(screen.getByLabelText(/用户名/)).toBeInTheDocument()
    })
    expect(apiGetMock).toHaveBeenCalledWith('/auth/invitations/CODE123')
    expect(screen.queryByTestId('invite-unusable')).not.toBeInTheDocument()
  })

  // Registration asks for what an account cannot exist without, and nothing else — an
  // optional field here is one more thing between the invitee and a working account.
  it('asks for exactly the four required fields', async () => {
    apiGetMock.mockResolvedValue(pendingInvitation())
    renderPage()

    await screen.findByLabelText(/用户名/)
    expect(screen.getByLabelText(/邮箱/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^密码/)).toBeInTheDocument()
    expect(screen.getByLabelText(/确认密码/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/显示名称/)).not.toBeInTheDocument()
  })

  // The four unusable states are the whole reason the page checks before rendering: each
  // one needs its own message, and none of them may show a form the submit would reject.
  it.each([
    ['expired', '已过期'],
    ['revoked', '已撤销'],
    ['accepted', '已被使用'],
  ])('shows the %s state instead of the form', async (status, copy) => {
    apiGetMock.mockResolvedValue({
      data: { status, email: null, expiresAt: new Date().toISOString() },
    })
    renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-unusable')).toBeInTheDocument()
    })
    expect(screen.getByText(new RegExp(copy))).toBeInTheDocument()
    expect(screen.queryByLabelText(/用户名/)).not.toBeInTheDocument()
  })

  it('treats an unknown code as not-found rather than a blank form', async () => {
    apiGetMock.mockRejectedValue(new Error('INVITATION_NOT_FOUND'))
    renderPage()

    await waitFor(() => {
      expect(screen.getByTestId('invite-unusable')).toBeInTheDocument()
    })
    expect(screen.getByText(/无效/)).toBeInTheDocument()
  })

  it('prefills and locks the email when the invitation is pinned to an address', async () => {
    apiGetMock.mockResolvedValue(pendingInvitation('dev@company.com'))
    renderPage()

    const emailField = await screen.findByLabelText(/邮箱/)
    await waitFor(() => {
      expect(emailField).toHaveValue('dev@company.com')
    })
    expect(emailField).toBeDisabled()
  })

  it('keeps submit disabled until every required field is valid', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue(pendingInvitation())
    renderPage()

    const submit = await screen.findByRole('button', { name: /创建账号/ })
    expect(submit).toBeDisabled()

    await user.type(screen.getByLabelText(/用户名/), 'newdev')
    await user.type(screen.getByLabelText(/邮箱/), 'dev@company.com')
    await user.type(screen.getByLabelText(/^密码/), 'Passw0rd')
    // Still disabled: the confirmation has not been typed, so the two do not match yet.
    expect(submit).toBeDisabled()

    await user.type(screen.getByLabelText(/确认密码/), 'Passw0rd')
    await waitFor(() => {
      expect(submit).toBeEnabled()
    })
  })

  it('keeps submit disabled when the password confirmation differs', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue(pendingInvitation())
    renderPage()

    await screen.findByLabelText(/用户名/)
    await user.type(screen.getByLabelText(/用户名/), 'newdev')
    await user.type(screen.getByLabelText(/邮箱/), 'dev@company.com')
    await user.type(screen.getByLabelText(/^密码/), 'Passw0rd')
    await user.type(screen.getByLabelText(/确认密码/), 'Passw0rdX')

    expect(await screen.findByText(/两次输入的密码不一致/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /创建账号/ })).toBeDisabled()
  })

  it('rejects a username that does not meet the policy', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue(pendingInvitation())
    renderPage()

    await screen.findByLabelText(/用户名/)
    // Leading punctuation: allowed inside a username but not as the first character.
    await user.type(screen.getByLabelText(/用户名/), '_bad')

    expect(await screen.findByText(/用户名需 3-32 位/)).toBeInTheDocument()
  })

  it('submits the accept request and lands the new user on the dashboard', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue(pendingInvitation())
    apiPostMock.mockResolvedValue({ data: { user: { id: 'usr_1' } } })
    renderPage()

    await screen.findByLabelText(/用户名/)
    await user.type(screen.getByLabelText(/用户名/), 'newdev')
    await user.type(screen.getByLabelText(/邮箱/), 'dev@company.com')
    await user.type(screen.getByLabelText(/^密码/), 'Passw0rd')
    await user.type(screen.getByLabelText(/确认密码/), 'Passw0rd')

    await user.click(screen.getByRole('button', { name: /创建账号/ }))

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/auth/invitations/CODE123/accept', {
        username: 'newdev',
        email: 'dev@company.com',
        password: 'Passw0rd',
        confirmPassword: 'Passw0rd',
      })
    })
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/', { replace: true })
    })
  })

  it('surfaces a server rejection without navigating away', async () => {
    const user = userEvent.setup()
    apiGetMock.mockResolvedValue(pendingInvitation())
    apiPostMock.mockRejectedValue(new Error('USERNAME_EXISTS'))
    renderPage()

    await screen.findByLabelText(/用户名/)
    await user.type(screen.getByLabelText(/用户名/), 'taken')
    await user.type(screen.getByLabelText(/邮箱/), 'dev@company.com')
    await user.type(screen.getByLabelText(/^密码/), 'Passw0rd')
    await user.type(screen.getByLabelText(/确认密码/), 'Passw0rd')

    await user.click(screen.getByRole('button', { name: /创建账号/ }))

    await waitFor(() => {
      expect(navigateMock).not.toHaveBeenCalledWith('/', { replace: true })
    })
    expect(apiPostMock).toHaveBeenCalled()
  })
})
