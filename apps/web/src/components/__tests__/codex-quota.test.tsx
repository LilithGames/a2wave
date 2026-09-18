import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { renderWithProviders, screen, waitFor } from '@/test/render'
import { CodexQuotaDisplay } from '../codex-quota'

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))

describe('CodexQuotaDisplay', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches server account quota and displays only returned windows and reset times', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        status: 'available',
        windows: [
          {
            id: 'weekly',
            label: null,
            usedPercent: 24,
            windowDurationMins: 10080,
            resetsAt: 1800000000,
          },
        ],
      },
    })
    renderWithProviders(<CodexQuotaDisplay providerId="prv_codex" />)
    const bar = await screen.findByRole('progressbar', { name: '每周额度' })
    expect(bar).toHaveAttribute('aria-valuenow', '76')
    expect(screen.getByText('剩余 76%')).toBeInTheDocument()
    expect(screen.getByText(/包含在 a2wave 之外的使用/)).toBeInTheDocument()
    expect(document.querySelector('time')).toHaveAttribute(
      'dateTime',
      new Date(1800000000000).toISOString(),
    )
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(api.get).toHaveBeenCalledExactlyOnceWith('/providers/prv_codex/quota')
  })

  it('renders loading without inventing a quota', () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => {}))
    renderWithProviders(<CodexQuotaDisplay providerId="prv_codex" />)
    expect(screen.getByText('正在获取额度…')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it.each([
    ['not_logged_in', '服务端 Codex 尚未登录。'],
    ['unsupported', '当前 Codex CLI 版本或登录方式不支持账号额度查询。'],
    ['unavailable', '暂时无法获取账号额度。'],
    ['available', '暂时无法获取账号额度。'],
  ])('handles %s without displaying zero usage', async (status, message) => {
    vi.mocked(api.get).mockResolvedValue({ data: { status, windows: [] } })
    renderWithProviders(<CodexQuotaDisplay providerId="prv_codex" />)
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('handles request failure without retrying', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('unavailable'))
    renderWithProviders(<CodexQuotaDisplay providerId="prv_codex" />)
    expect(await screen.findByText('暂时无法获取账号额度。')).toBeInTheDocument()
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1))
  })

  it('labels actual durations and missing resets, retaining bucket labels', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        status: 'available',
        windows: [
          {
            id: 'primary',
            label: 'Codex',
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: null,
          },
          { id: 'other', label: null, usedPercent: 0, windowDurationMins: 90, resetsAt: null },
          {
            id: 'unknown',
            label: 'Review',
            usedPercent: 12.5,
            windowDurationMins: null,
            resetsAt: null,
          },
        ],
      },
    })
    renderWithProviders(<CodexQuotaDisplay providerId="prv_codex" />)
    expect(await screen.findByRole('progressbar', { name: 'Codex · 5 小时额度' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    )
    expect(screen.getByRole('progressbar', { name: '90 分钟额度' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    )
    expect(screen.getByRole('progressbar', { name: 'Review' })).toHaveAttribute(
      'aria-valuenow',
      '87.5',
    )
    expect(screen.getAllByText('重置时间暂不可用')).toHaveLength(3)
  })
})
