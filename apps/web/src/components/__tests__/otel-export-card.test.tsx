import type { OtelStatus, OtelTestResult } from '@a2wave/shared'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen } from '@/test/render'
import { OtelExportCard } from '../otel-export-card'

const save = vi.fn()
const runTest = vi.fn()
let testResult: OtelTestResult | undefined

const baseStatus: OtelStatus = {
  enabled: false,
  endpoint: '',
  tracesUrl: '',
  serviceName: '',
  captureContent: false,
  headersSet: false,
  headerNames: [],
  active: false,
  lastExportAt: null,
  lastError: null,
  droppedSpans: 0,
  scope: 'this-instance',
}
let status: OtelStatus = baseStatus

vi.mock('@/hooks/use-settings', () => ({
  useOtelStatus: () => ({ data: status, isLoading: false }),
  useOtelTest: () => ({ mutate: runTest, isPending: false, data: testResult }),
  useUpdateOtel: () => ({ mutate: save, isPending: false }),
}))

describe('OtelExportCard', () => {
  beforeEach(() => {
    save.mockClear()
    runTest.mockClear()
    testResult = undefined
    status = baseStatus
  })

  it('saves the endpoint without touching headers when none were entered', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    await user.type(screen.getByLabelText('采集端地址（OTLP/HTTP）'), 'http://localhost:4318')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(save).toHaveBeenCalledTimes(1)
    const patch = save.mock.calls[0][0] as Record<string, string>
    expect(patch).toMatchObject({ enabled: 'false', endpoint: 'http://localhost:4318' })
    expect('headers' in patch).toBe(false)
  })

  it('shows saved header names but never a value, and submits newly entered headers', async () => {
    status = {
      ...baseStatus,
      enabled: true,
      endpoint: 'http://localhost:4318',
      tracesUrl: 'http://localhost:4318/v1/traces',
      headersSet: true,
      headerNames: ['Authorization'],
      active: true,
    }
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    expect(screen.getByText('已设置：Authorization（不填则保持不变）')).toBeInTheDocument()
    expect(screen.getByText('实际上报地址：http://localhost:4318/v1/traces')).toBeInTheDocument()
    expect(screen.getByText('导出中')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '添加请求头' }))
    await user.type(screen.getByLabelText('名称'), 'x-api-key')
    await user.type(screen.getByLabelText('值'), 'secret-value')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect((save.mock.calls[0][0] as Record<string, string>).headers).toBe(
      '{"x-api-key":"secret-value"}',
    )
  })

  it('blocks an invalid form with an inline error instead of saving', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    await user.type(screen.getByLabelText('采集端地址（OTLP/HTTP）'), 'grpc://collector:4317')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('采集端地址需为 http(s) 地址')
  })

  it('warns about data leaving the platform once content capture is switched on', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    expect(screen.queryByText(/会离开 a2wave/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: '采集内容' }))
    expect(screen.getByText(/会离开 a2wave/)).toBeInTheDocument()
  })

  it('clears the saved headers on request', async () => {
    status = { ...baseStatus, headersSet: true, headerNames: ['Authorization'] }
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    await user.click(screen.getByRole('button', { name: '清除已保存的请求头' }))

    expect(save).toHaveBeenCalledWith({ headers: '' })
  })

  it('runs the connection test and reports a failure reason', async () => {
    testResult = { ok: false, reason: 'EXPORT_FAILED', error: 'connect ECONNREFUSED' }
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    await user.click(screen.getByRole('button', { name: '测试连接' }))

    expect(runTest).toHaveBeenCalledTimes(1)
    expect(screen.getByText('上报失败：connect ECONNREFUSED')).toBeInTheDocument()
  })

  it('surfaces exporter health for this instance', () => {
    status = { ...baseStatus, lastError: 'Unauthorized', droppedSpans: 12 }
    renderWithProviders(<OtelExportCard />)

    expect(screen.getByText('最近错误：Unauthorized')).toBeInTheDocument()
    expect(screen.getByText('已丢弃 span：12')).toBeInTheDocument()
  })
})
