import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen, waitFor } from '@/test/render'
import { DevicePage } from '../device'

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => apiGetMock(path),
    post: (path: string, body: unknown) => apiPostMock(path, body),
  },
}))

function pendingDevice(over: Record<string, unknown> = {}) {
  return {
    data: {
      userCode: 'WDJB-MJHT',
      status: 'pending',
      clientIp: '10.0.0.9',
      userAgent: 'a2wave-cli',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...over,
    },
  }
}

function renderPage(search = '') {
  return renderWithProviders(<DevicePage />, {
    routerProps: { initialEntries: [`/device${search}`] },
  })
}

beforeEach(() => {
  apiGetMock.mockReset()
  apiPostMock.mockReset().mockResolvedValue({ data: {} })
})

describe('DevicePage', () => {
  it('asks for a code before touching the server', () => {
    renderPage()
    expect(screen.getByLabelText(/设备验证码/)).toBeInTheDocument()
    expect(apiGetMock).not.toHaveBeenCalled()
  })

  it('prefills a code from the link but still requires an explicit approval', async () => {
    // The link is emailable; if it could approve on its own it would be a one-click grant.
    apiGetMock.mockResolvedValue(pendingDevice())
    renderPage('?code=WDJB-MJHT')
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled())
    expect(apiPostMock).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: /^批准$/ })).toBeInTheDocument()
  })

  it('shows where the request came from, so the approver can recognise it', async () => {
    apiGetMock.mockResolvedValue(pendingDevice())
    renderPage('?code=WDJB-MJHT')
    expect(await screen.findByText('10.0.0.9')).toBeInTheDocument()
    expect(screen.getByText('a2wave-cli')).toBeInTheDocument()
    expect(screen.getByText('WDJB-MJHT')).toBeInTheDocument()
  })

  it('warns against approving a code someone else supplied', async () => {
    apiGetMock.mockResolvedValue(pendingDevice())
    renderPage('?code=WDJB-MJHT')
    expect(await screen.findByText(/绝不要批准别人发给你的验证码/)).toBeInTheDocument()
  })

  it('approves and confirms without asking the user to go back to the browser', async () => {
    apiGetMock.mockResolvedValue(pendingDevice())
    renderPage('?code=WDJB-MJHT')
    await userEvent.click(await screen.findByRole('button', { name: /^批准$/ }))
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/auth/device/approve', {
        userCode: 'WDJBMJHT',
      }),
    )
    expect(await screen.findByText(/设备已授权/)).toBeInTheDocument()
  })

  it('denies through the deny endpoint, not by approving with a flag', async () => {
    apiGetMock.mockResolvedValue(pendingDevice())
    renderPage('?code=WDJB-MJHT')
    await userEvent.click(await screen.findByRole('button', { name: /^拒绝$/ }))
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/auth/device/deny', { userCode: 'WDJBMJHT' }),
    )
    expect(await screen.findByText(/已拒绝设备登录/)).toBeInTheDocument()
  })

  it('explains an expired code instead of leaving the form silent', async () => {
    apiGetMock.mockRejectedValue(new Error('DEVICE_REQUEST_NOT_FOUND'))
    renderPage('?code=WDJB-MJHT')
    expect(await screen.findByText(/已过期或已被使用/)).toBeInTheDocument()
  })

  it('distinguishes a rejected code from a lapsed one', async () => {
    apiGetMock.mockRejectedValue(new Error('INVALID_USER_CODE'))
    renderPage('?code=WDJB-MJHT')
    expect(await screen.findByText(/验证码无效/)).toBeInTheDocument()
  })

  it('explains an approve that fails because the code lapsed mid-decision', async () => {
    // Without the code registered in KNOWN_CODES this renders generic "unknown error"
    // copy, which tells the user nothing about what to do next.
    apiGetMock.mockResolvedValue(pendingDevice())
    apiPostMock.mockRejectedValue(new Error('DEVICE_REQUEST_NOT_FOUND'))
    renderPage('?code=WDJB-MJHT')
    await userEvent.click(await screen.findByRole('button', { name: /^批准$/ }))
    expect(await screen.findByText(/已过期或已被使用/)).toBeInTheDocument()
  })

  it('keeps continue disabled until the code is well-formed', async () => {
    renderPage()
    const button = screen.getByRole('button', { name: /继续/ })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/设备验证码/), 'WDJBMJHT')
    await waitFor(() => expect(button).toBeEnabled())
  })
})
