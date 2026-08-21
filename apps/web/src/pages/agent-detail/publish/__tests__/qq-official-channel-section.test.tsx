import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/render'
import { QQOfficialChannelSection } from '../qq-official-channel-section'

vi.mock('@/lib/api', () => ({ api: { post: vi.fn() } }))

describe('QQOfficialChannelSection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a QR task, polls it, and fills the official credentials', async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce({
        data: {
          taskId: 'task-1',
          bindKey: 'key-1',
          qrCodeUrl: 'https://q.qq.com/connect?task_id=task-1',
          intervalMs: 1,
        },
      } as never)
      .mockResolvedValueOnce({
        data: { status: 'completed', appId: '102000000', appSecret: 'secret' },
      } as never)
    const onAppIdChange = vi.fn()
    const onAppSecretChange = vi.fn()

    renderWithProviders(
      <QQOfficialChannelSection
        agentId="agent-1"
        appId=""
        onAppIdChange={onAppIdChange}
        appSecret=""
        onAppSecretChange={onAppSecretChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /scan.*qr|扫码/i }))

    expect(await screen.findByTestId('qq-official-registration-qr')).toBeInTheDocument()
    await waitFor(() => expect(onAppIdChange).toHaveBeenCalledWith('102000000'))
    expect(onAppSecretChange).toHaveBeenCalledWith('secret')
  })

  it('closes an expired QR task instead of leaving an empty waiting dialog', async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce({
        data: {
          taskId: 'task-1',
          bindKey: 'key-1',
          qrCodeUrl: 'https://q.qq.com/connect?task_id=task-1',
          intervalMs: 1,
        },
      } as never)
      .mockResolvedValueOnce({ data: { status: 'expired' } } as never)

    renderWithProviders(
      <QQOfficialChannelSection
        agentId="agent-1"
        appId=""
        onAppIdChange={vi.fn()}
        appSecret=""
        onAppSecretChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /scan.*qr|扫码/i }))

    expect(await screen.findByTestId('qq-official-registration-qr')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('qq-official-registration-qr')).not.toBeInTheDocument(),
    )
  })

  it('offers only QQ group and C2C settings for the MVP', () => {
    renderWithProviders(
      <QQOfficialChannelSection
        agentId="agent-1"
        appId=""
        onAppIdChange={vi.fn()}
        appSecret=""
        onAppSecretChange={vi.fn()}
      />,
    )

    expect(screen.queryByText(/guild|QQ 频道|频道私信/i)).not.toBeInTheDocument()
    expect(screen.getAllByRole('switch')).toHaveLength(2)
    expect(screen.getAllByRole('combobox')).toHaveLength(2)
  })
})
