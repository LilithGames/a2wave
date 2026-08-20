import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen, waitFor } from '@/test/render'
import { CliTokensCard } from '../cli-tokens-card'

const { apiGetMock, apiPostMock, apiDeleteMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiDeleteMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => apiGetMock(path),
    post: (path: string, body: unknown) => apiPostMock(path, body),
    delete: (path: string) => apiDeleteMock(path),
  },
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

beforeEach(() => {
  apiGetMock
    .mockReset()
    .mockImplementation((path: string) =>
      path.includes('session-policy')
        ? Promise.resolve({ data: { sessionTtlDays: 1, configurable: false } })
        : Promise.resolve({ data: [token()] }),
    )
  apiPostMock.mockReset().mockResolvedValue({ data: { token: 'a2wc_PLAINTEXT_SECRET' } })
  apiDeleteMock.mockReset().mockResolvedValue({ data: {} })
})

describe('CliTokensCard', () => {
  it('lists tokens by name and prefix, never a usable credential', async () => {
    renderWithProviders(<CliTokensCard />)
    expect(await screen.findByText('CI runner')).toBeInTheDocument()
    expect(screen.getByText(/a2wc_abc123/)).toBeInTheDocument()
  })

  it('shows the plaintext once, with a warning that it will not reappear', async () => {
    renderWithProviders(<CliTokensCard />)
    await userEvent.type(await screen.findByLabelText(/名称/), 'CI runner')
    await userEvent.click(screen.getByRole('button', { name: /新建令牌/ }))
    expect(await screen.findByText('a2wc_PLAINTEXT_SECRET')).toBeInTheDocument()
    expect(screen.getByText(/不会再次显示/)).toBeInTheDocument()
  })

  it('refuses to create a nameless token', async () => {
    // Without a name the token cannot be told apart from another in the list.
    renderWithProviders(<CliTokensCard />)
    await userEvent.click(await screen.findByRole('button', { name: /新建令牌/ }))
    expect(await screen.findByText(/必须填名称/)).toBeInTheDocument()
    expect(apiPostMock).not.toHaveBeenCalled()
  })

  it('sends no expiry when "never" is chosen', async () => {
    renderWithProviders(<CliTokensCard />)
    await userEvent.type(await screen.findByLabelText(/名称/), 'CI')
    await userEvent.click(screen.getByRole('button', { name: /永不过期/ }))
    await userEvent.click(screen.getByRole('button', { name: /新建令牌/ }))
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/cli-tokens', { name: 'CI' }))
  })

  it('confirms before revoking, because anything using it breaks immediately', async () => {
    renderWithProviders(<CliTokensCard />)
    await userEvent.click(await screen.findByRole('button', { name: /^吊销$/ }))
    expect(await screen.findByText(/会立刻失效/)).toBeInTheDocument()
    expect(apiDeleteMock).not.toHaveBeenCalled()
  })

  it('surfaces the session lifetime and says it is not editable here', async () => {
    renderWithProviders(<CliTokensCard />)
    expect(await screen.findByText(/会话令牌有效期/)).toBeInTheDocument()
    expect(screen.getByText(/AUTH_SESSION_TTL_DAYS/)).toBeInTheDocument()
  })

  it('marks a revoked token instead of offering to revoke it again', async () => {
    apiGetMock.mockImplementation((path: string) =>
      path.includes('session-policy')
        ? Promise.resolve({ data: { sessionTtlDays: 1, configurable: false } })
        : Promise.resolve({ data: [token({ revokedAt: new Date().toISOString() })] }),
    )
    renderWithProviders(<CliTokensCard />)
    expect(await screen.findByText(/已吊销/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^吊销$/ })).not.toBeInTheDocument()
  })
})
