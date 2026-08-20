import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen, waitFor } from '@/test/render'
import { CliTokensCard } from '../cli-tokens-card'

const { apiGetMock, apiPostMock, apiDeleteMock, confirmMock, copyTextMock, messageErrorMock } =
  vi.hoisted(() => ({
    copyTextMock: vi.fn(),
    messageErrorMock: vi.fn(),
    apiGetMock: vi.fn(),
    apiPostMock: vi.fn(),
    apiDeleteMock: vi.fn(),
    confirmMock: vi.fn(),
  }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => apiGetMock(path),
    post: (path: string, body: unknown) => apiPostMock(path, body),
    delete: (path: string) => apiDeleteMock(path),
  },
}))

// message is bound by AntdStaticBridge, which the test harness never renders, so
// without this the copy-failure path throws on an undefined import.
vi.mock('@/lib/antd-static', () => ({
  message: { error: messageErrorMock, success: vi.fn() },
  AntdStaticBridge: () => null,
}))

vi.mock('@/lib/clipboard', () => ({ copyText: (t: string) => copyTextMock(t) }))

vi.mock('@/lib/confirm', () => ({
  confirm: (opts: { onOk?: () => unknown }) => confirmMock(opts),
}))

function token(over: Record<string, unknown> = {}) {
  return {
    id: 'clt_1',
    name: 'CI runner',
    tokenPrefix: 'a2wc_abc123',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  }
}

function mockList(rows: unknown[]) {
  apiGetMock.mockImplementation((path: string) =>
    path.includes('session-policy')
      ? Promise.resolve({ data: { sessionTtlDays: 1, configurable: false } })
      : Promise.resolve({ data: rows }),
  )
}

beforeEach(() => {
  apiGetMock.mockReset()
  mockList([token()])
  apiPostMock.mockReset().mockResolvedValue({ data: { token: 'a2wc_PLAINTEXT_SECRET' } })
  apiDeleteMock.mockReset().mockResolvedValue({ data: {} })
  // Run the confirmed action straight away so the destructive path is exercised.
  confirmMock.mockReset().mockImplementation((opts: { onOk?: () => unknown }) => opts.onOk?.())
  copyTextMock.mockReset().mockResolvedValue(true)
  messageErrorMock.mockReset()
})

describe('CliTokensCard', () => {
  it('leads with the list, not a creation form', async () => {
    renderWithProviders(<CliTokensCard />)
    expect(await screen.findByText('CI runner')).toBeInTheDocument()
    // The name field belongs in the dialog; showing it inline would make an
    // occasional action dominate a page people mostly visit to audit.
    expect(screen.queryByLabelText(/名称/)).not.toBeInTheDocument()
  })

  it('opens creation in a dialog behind the button', async () => {
    renderWithProviders(<CliTokensCard />)
    await userEvent.click(await screen.findByRole('button', { name: /新建令牌/ }))
    expect(await screen.findByText('创建 CLI 令牌')).toBeInTheDocument()
  })

  it('shows the plaintext once, with a warning that it will not reappear', async () => {
    renderWithProviders(<CliTokensCard />)
    await userEvent.click(await screen.findByRole('button', { name: /新建令牌/ }))
    await userEvent.type(await screen.findByLabelText(/名称/), 'CI runner')
    await userEvent.click(screen.getByRole('button', { name: /^创建令牌$/ }))
    expect(await screen.findByText('a2wc_PLAINTEXT_SECRET')).toBeInTheDocument()
    expect(screen.getByText(/不会再次显示/)).toBeInTheDocument()
  })

  it('confirms the copy succeeded, so the user knows the secret is safe to lose', async () => {
    renderWithProviders(<CliTokensCard />)
    await userEvent.click(await screen.findByRole('button', { name: /新建令牌/ }))
    await userEvent.type(await screen.findByLabelText(/名称/), 'CI')
    await userEvent.click(screen.getByRole('button', { name: /^创建令牌$/ }))
    await userEvent.click(await screen.findByRole('button', { name: /复制/ }))
    expect(copyTextMock).toHaveBeenCalledWith('a2wc_PLAINTEXT_SECRET')
    expect(await screen.findByText('已复制')).toBeInTheDocument()
  })

  it('does not claim success when the copy actually failed', async () => {
    // The token is unrecoverable; a false success sends the user away empty-handed.
    copyTextMock.mockResolvedValue(false)
    renderWithProviders(<CliTokensCard />)
    await userEvent.click(await screen.findByRole('button', { name: /新建令牌/ }))
    await userEvent.type(await screen.findByLabelText(/名称/), 'CI')
    await userEvent.click(screen.getByRole('button', { name: /^创建令牌$/ }))
    await userEvent.click(await screen.findByRole('button', { name: /复制/ }))
    expect(screen.queryByText('已复制')).not.toBeInTheDocument()
    // And says so, rather than failing silently on a value that cannot be recovered.
    expect(messageErrorMock).toHaveBeenCalled()
  })

  it('refuses to create a nameless token', async () => {
    renderWithProviders(<CliTokensCard />)
    await userEvent.click(await screen.findByRole('button', { name: /新建令牌/ }))
    await userEvent.click(await screen.findByRole('button', { name: /^创建令牌$/ }))
    expect(await screen.findByText(/必须填名称/)).toBeInTheDocument()
    expect(apiPostMock).not.toHaveBeenCalled()
  })

  it('sends no expiry when "never" is chosen', async () => {
    renderWithProviders(<CliTokensCard />)
    await userEvent.click(await screen.findByRole('button', { name: /新建令牌/ }))
    await userEvent.type(await screen.findByLabelText(/名称/), 'CI')
    await userEvent.click(screen.getByRole('button', { name: /永不过期/ }))
    await userEvent.click(screen.getByRole('button', { name: /^创建令牌$/ }))
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/cli-tokens', { name: 'CI' }))
  })

  it('confirms before deleting, because anything using it breaks immediately', async () => {
    confirmMock.mockImplementation(() => undefined)
    renderWithProviders(<CliTokensCard />)
    await userEvent.click(await screen.findByRole('button', { name: /删除/ }))
    expect(confirmMock).toHaveBeenCalled()
    expect(apiDeleteMock).not.toHaveBeenCalled()
  })

  it('deletes once confirmed', async () => {
    renderWithProviders(<CliTokensCard />)
    await userEvent.click(await screen.findByRole('button', { name: /删除/ }))
    await waitFor(() => expect(apiDeleteMock).toHaveBeenCalledWith('/cli-tokens/clt_1'))
  })

  it('surfaces the session lifetime and says it is not editable here', async () => {
    renderWithProviders(<CliTokensCard />)
    expect(await screen.findByText(/会话令牌有效期/)).toBeInTheDocument()
    expect(screen.getByText(/AUTH_SESSION_TTL_DAYS/)).toBeInTheDocument()
  })

  it('distinguishes deleted and expired tokens from live ones', async () => {
    mockList([
      token({ id: 'a', name: 'gone', revokedAt: new Date().toISOString() }),
      token({ id: 'b', name: 'stale', expiresAt: new Date(Date.now() - 1000).toISOString() }),
      token({ id: 'c', name: 'live' }),
    ])
    renderWithProviders(<CliTokensCard />)
    expect(await screen.findByText('已删除')).toBeInTheDocument()
    expect(screen.getByText('已过期')).toBeInTheDocument()
    expect(screen.getByText('生效中')).toBeInTheDocument()
  })

  it('says a token was never used, since that is what makes it safe to delete', async () => {
    renderWithProviders(<CliTokensCard />)
    expect(await screen.findByText('从未使用')).toBeInTheDocument()
  })
})
