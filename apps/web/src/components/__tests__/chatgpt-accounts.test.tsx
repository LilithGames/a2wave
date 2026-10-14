import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { confirm } from '@/lib/confirm'
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from '@/test/render'
import { ChatGPTAccountPicker, ChatGPTAccountsCard } from '../chatgpt-accounts'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/confirm', () => ({ confirm: vi.fn() }))
vi.mock('@/lib/antd-static', () => ({ message: { success: vi.fn(), error: vi.fn() } }))

const ownAccount = {
  id: 'poa_own',
  providerId: 'prv_codex',
  label: 'Work',
  email: 'same@example.com',
  chatgptAccountId: 'workspace_1',
  status: 'ready',
  canManage: true,
  createdByUserId: 'usr_1',
  expiresAt: null,
  createdAt: '2026-09-30T00:00:00Z',
  updatedAt: '2026-09-30T00:00:00Z',
}

describe('ChatGPT shared accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue({
      data: [ownAccount, { ...ownAccount, id: 'poa_other', label: 'Personal', canManage: false }],
    })
    vi.mocked(api.post).mockResolvedValue({
      data: {
        loginId: 'login_123',
        loginToken: 'one-time-private-code',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    })
    vi.mocked(api.patch).mockResolvedValue({ data: ownAccount })
  })

  it('keeps same-email registrations separate and only exposes management for permitted accounts', async () => {
    renderWithProviders(<ChatGPTAccountsCard providerId="prv_codex" />)
    expect(await screen.findByText('Work')).toBeInTheDocument()
    expect(screen.getByText('Personal')).toBeInTheDocument()
    expect(screen.getAllByText('same@example.com')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '重命名' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '重新登录' })).toHaveLength(1)
    expect(screen.getByText(/绑定 Agent 后将消耗所选账号授权的 ChatGPT 额度/)).toBeInTheDocument()
  })

  it('starts a local CLI handoff without putting the one-time code into command arguments', async () => {
    vi.mocked(api.get).mockImplementation(async (path) => ({
      data: path.includes('/logins/') ? { status: 'pending' } : [],
    }))
    renderWithProviders(<ChatGPTAccountsCard providerId="prv_codex" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with ChatGPT' }))
    fireEvent.click(screen.getByRole('button', { name: '生成连接码' }))
    const command = await screen.findByTestId('chatgpt-login-command')
    expect(command.textContent).toContain('a2wave providers accounts login --server')
    expect(command.textContent).toContain('--login-id login_123')
    expect(command.textContent).not.toContain('one-time-private-code')
    expect(screen.getByText(/在打开浏览器的这台电脑上运行命令/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制连接码' }))
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('one-time-private-code'))
  })

  it('selects the newly connected account without saving the Agent', async () => {
    const onChange = vi.fn()
    vi.mocked(api.get).mockImplementation(async (path) => ({
      data: path.includes('/logins/') ? { status: 'completed', accountId: 'poa_new' } : [],
    }))
    renderWithProviders(<ChatGPTAccountPicker providerId="prv_codex" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
    fireEvent.click(screen.getByRole('button', { name: '生成连接码' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith('poa_new'))
    expect(api.post).toHaveBeenCalledWith('/providers/prv_codex/oauth-accounts/login', {})
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('preserves the target registration during re-login and rename', async () => {
    vi.mocked(api.get).mockImplementation(async (path) => ({
      data: path.includes('/logins/') ? { status: 'pending' } : [ownAccount],
    }))
    renderWithProviders(<ChatGPTAccountsCard providerId="prv_codex" />)
    fireEvent.click(await screen.findByRole('button', { name: '重命名' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Renamed' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/providers/prv_codex/oauth-accounts/poa_own', {
        label: 'Renamed',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
    fireEvent.click(screen.getByRole('button', { name: '生成连接码' }))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/providers/prv_codex/oauth-accounts/login', {
        accountId: 'poa_own',
      }),
    )
  })

  it('reports list failures instead of pretending the shared pool is empty', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('NETWORK_ERROR'))
    renderWithProviders(<ChatGPTAccountsCard providerId="prv_codex" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载 ChatGPT 账号')
  })

  it.each(['failed', 'expired'] as const)(
    'keeps failed authorization out of the selected account (%s)',
    async (status) => {
      const onChange = vi.fn()
      vi.mocked(api.get).mockImplementation(async (path) => ({
        data: path.includes('/logins/') ? { status } : [],
      }))
      renderWithProviders(<ChatGPTAccountPicker providerId="prv_codex" onChange={onChange} />)
      fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }))
      fireEvent.click(screen.getByRole('button', { name: '生成连接码' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        status === 'expired' ? '已过期' : '授权失败',
      )
      expect(screen.queryByRole('button', { name: '复制连接码' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '生成连接码' })).toBeEnabled()
      expect(onChange).not.toHaveBeenCalled()
    },
  )

  it('deletes the explicitly selected shared account after confirmation', async () => {
    vi.mocked(api.delete).mockResolvedValue({ data: {} })
    renderWithProviders(<ChatGPTAccountsCard providerId="prv_codex" />)
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    expect(api.delete).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true, content: expect.stringContaining('Work') }),
    )
    await act(async () => {
      await vi.mocked(confirm).mock.calls[0]?.[0].onOk?.()
    })
    expect(api.delete).toHaveBeenCalledWith('/providers/prv_codex/oauth-accounts/poa_own')
  })
})
