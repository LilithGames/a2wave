import { OTEL_KEEP_HEADER_VALUE, type OtelStatus, type OtelTestResult } from '@a2wave/shared'
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
  resourceAttributes: '',
  captureContent: false,
  headersSet: false,
  headerNames: [],
  active: false,
  lastExportAt: null,
  lastError: null,
  droppedSpans: 0,
  scope: 'this-instance',
}
const withSavedHeader: OtelStatus = {
  ...baseStatus,
  enabled: true,
  endpoint: 'http://collector:4318',
  tracesUrl: 'http://collector:4318/v1/traces',
  headersSet: true,
  headerNames: ['Authorization'],
  active: true,
}
let status: OtelStatus = baseStatus

vi.mock('@/hooks/use-settings', () => ({
  useOtelStatus: () => ({ data: status, isLoading: false }),
  useOtelTest: () => ({ mutate: runTest, isPending: false, data: testResult }),
  useUpdateOtel: () => ({ mutate: save, isPending: false }),
}))

const endpointInput = () => screen.getByLabelText('采集端地址')
const savedPatch = () => save.mock.calls[0][0] as Record<string, string>

describe('OtelExportCard', () => {
  beforeEach(() => {
    save.mockReset()
    runTest.mockReset()
    testResult = undefined
    status = baseStatus
  })

  it('saves the endpoint without touching headers when none were entered', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    await user.type(endpointInput(), 'http://collector:4318')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(save).toHaveBeenCalledTimes(1)
    expect(savedPatch()).toMatchObject({ enabled: 'false', endpoint: 'http://collector:4318' })
    expect('headers' in savedPatch()).toBe(false)
  })

  it('lists saved headers as rows with a read-only name and a masked value', () => {
    status = withSavedHeader
    renderWithProviders(<OtelExportCard />)

    const name = screen.getByLabelText('名称')
    expect(name).toHaveValue('Authorization')
    expect(name).toHaveAttribute('readonly')
    // An empty box reads as "no value"; the mask says one is stored. It is display-only:
    // the real value never reaches the browser.
    expect(screen.getByLabelText('值')).toHaveValue(OTEL_KEEP_HEADER_VALUE)
    expect(screen.getByLabelText('值')).toHaveAttribute('type', 'password')
    expect(screen.getByText('导出中')).toBeInTheDocument()
  })

  it('clears the mask on focus so a new value can be typed, and restores it when left empty', async () => {
    status = withSavedHeader
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)
    const value = screen.getByLabelText('值')

    await user.click(value)
    expect(value).toHaveValue('')
    expect(value).toHaveAttribute('placeholder', '输入新值以替换，留空则保留原值')

    await user.tab()
    expect(value).toHaveValue(OTEL_KEEP_HEADER_VALUE)
  })

  it('keeps a typed replacement after blur and submits it instead of the keep marker', async () => {
    status = withSavedHeader
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)
    const value = screen.getByLabelText('值')

    await user.click(value)
    await user.type(value, 'Bearer new-key')
    await user.tab()
    expect(value).toHaveValue('Bearer new-key')

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(JSON.parse(savedPatch().headers)).toEqual({ Authorization: 'Bearer new-key' })
  })

  it('does not submit the display mask as a value when the saved header is untouched', async () => {
    status = withSavedHeader
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect('headers' in savedPatch()).toBe(false)
  })

  it('keeps the saved headers when another one is added', async () => {
    status = withSavedHeader
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    await user.click(screen.getByRole('button', { name: '添加请求头' }))
    await user.type(screen.getAllByLabelText('名称')[1], 'x-api-key')
    await user.type(screen.getAllByLabelText('值')[1], 'secret-value')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(JSON.parse(savedPatch().headers)).toEqual({
      Authorization: OTEL_KEEP_HEADER_VALUE,
      'x-api-key': 'secret-value',
    })
  })

  it('clears the saved headers once their rows are removed and the form is saved', async () => {
    status = withSavedHeader
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    await user.click(screen.getByRole('button', { name: '移除请求头 Authorization' }))
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(savedPatch().headers).toBe('')
  })

  it('turns newly saved headers into saved rows', async () => {
    save.mockImplementation((_patch, options) => options.onSuccess())
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    await user.type(endpointInput(), 'http://collector:4318')
    await user.click(screen.getByRole('button', { name: '添加请求头' }))
    await user.type(screen.getByLabelText('名称'), 'x-api-key')
    await user.type(screen.getByLabelText('值'), 'secret-value')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(screen.getByLabelText('名称')).toHaveAttribute('readonly')
    // The typed secret is dropped from the form; the saved row shows the display mask instead.
    expect(screen.getByLabelText('值')).toHaveValue(OTEL_KEEP_HEADER_VALUE)

    // A second save with nothing retyped must not resend the header set.
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect('headers' in (save.mock.calls[1][0] as Record<string, string>)).toBe(false)
  })

  it('keeps service name and resource attributes in a collapsed Advanced section', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    expect(screen.getByLabelText('服务名')).not.toBeVisible()
    await user.click(screen.getByText('高级选项'))
    expect(screen.getByLabelText('服务名')).toBeVisible()

    await user.type(endpointInput(), 'http://collector:4318')
    await user.type(screen.getByLabelText('资源属性'), 'openinference.project.name=a2wave')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(savedPatch().resourceAttributes).toBe('openinference.project.name=a2wave')
  })

  it('opens Advanced when a service name is already set', () => {
    status = { ...baseStatus, serviceName: 'agents' }
    renderWithProviders(<OtelExportCard />)

    expect(screen.getByLabelText('服务名')).toBeVisible()
  })

  it('shows the resolved traces URL live from what is typed', async () => {
    status = withSavedHeader
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    expect(screen.getByText('实际上报到：http://collector:4318/v1/traces')).toBeInTheDocument()

    await user.clear(endpointInput())
    expect(screen.queryByText(/实际上报到/)).not.toBeInTheDocument()

    await user.type(endpointInput(), 'https://apm.example.com/ingest/traces')
    expect(
      screen.getByText('实际上报到：https://apm.example.com/ingest/traces'),
    ).toBeInTheDocument()

    await user.clear(endpointInput())
    await user.type(endpointInput(), 'grpc://collector:4317')
    expect(screen.queryByText(/实际上报到/)).not.toBeInTheDocument()
  })

  it('hints at host.docker.internal for a loopback endpoint', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    expect(screen.queryByText(/host\.docker\.internal/)).not.toBeInTheDocument()
    await user.type(endpointInput(), 'http://localhost:4318')
    expect(screen.getByText(/host\.docker\.internal/)).toBeInTheDocument()
  })

  it('blocks an invalid form with an inline error instead of saving', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OtelExportCard />)

    await user.type(endpointInput(), 'grpc://collector:4317')
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

  describe('test connection', () => {
    it('posts the unsaved draft without saving it', async () => {
      status = withSavedHeader
      const user = userEvent.setup()
      renderWithProviders(<OtelExportCard />)

      await user.clear(endpointInput())
      await user.type(endpointInput(), 'http://draft-collector:4318/')
      await user.click(screen.getByRole('button', { name: '添加请求头' }))
      await user.type(screen.getAllByLabelText('名称')[1], 'x-api-key')
      await user.type(screen.getAllByLabelText('值')[1], 'k1')
      await user.click(screen.getByRole('button', { name: '测试连接' }))

      expect(save).not.toHaveBeenCalled()
      expect(runTest).toHaveBeenCalledTimes(1)
      expect(runTest.mock.calls[0][0]).toEqual({
        endpoint: 'http://draft-collector:4318',
        serviceName: '',
        resourceAttributes: '',
        headers: JSON.stringify({ Authorization: OTEL_KEEP_HEADER_VALUE, 'x-api-key': 'k1' }),
      })
    })

    it('shows the form error and sends nothing when the draft is invalid', async () => {
      const user = userEvent.setup()
      renderWithProviders(<OtelExportCard />)

      await user.type(endpointInput(), 'grpc://collector:4317')
      await user.click(screen.getByRole('button', { name: '测试连接' }))

      expect(runTest).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent('采集端地址需为 http(s) 地址')
    })

    it('shows the trace id and the tested URL on success', () => {
      const traceId = '0af7651916cd43dd8448eb211c80319c'
      testResult = { ok: true, traceId, testedUrl: 'http://collector:4318/v1/traces' }
      renderWithProviders(<OtelExportCard />)

      expect(screen.getByText('已写入一条测试 Trace')).toBeInTheDocument()
      expect(screen.getByText(traceId)).toHaveClass('select-all')
      expect(screen.getByText('上报地址：http://collector:4318/v1/traces')).toBeInTheDocument()
    })

    it('reports an export failure with the URL that was tried', () => {
      testResult = {
        ok: false,
        reason: 'EXPORT_FAILED',
        error: 'HTTP 401',
        testedUrl: 'http://collector:4318/v1/traces',
      }
      renderWithProviders(<OtelExportCard />)

      expect(screen.getByText('上报失败：HTTP 401')).toBeInTheDocument()
      expect(screen.getByText('上报地址：http://collector:4318/v1/traces')).toBeInTheDocument()
    })

    it('explains a refused loopback connection', () => {
      testResult = {
        ok: false,
        reason: 'LOOPBACK_REFUSED',
        testedUrl: 'http://127.0.0.1:4318/v1/traces',
      }
      renderWithProviders(<OtelExportCard />)

      expect(screen.getByText(/a2wave 容器自身.*host\.docker\.internal/)).toBeInTheDocument()
    })

    it('shows which rule an invalid draft broke', () => {
      testResult = { ok: false, reason: 'INVALID_CONFIG', error: 'Unknown saved header: x-old' }
      renderWithProviders(<OtelExportCard />)

      expect(screen.getByText('配置无效：Unknown saved header: x-old')).toBeInTheDocument()
    })
  })

  it('surfaces exporter health for this instance', () => {
    status = { ...baseStatus, lastError: 'Unauthorized', droppedSpans: 12 }
    renderWithProviders(<OtelExportCard />)

    expect(screen.getByText('最近错误：Unauthorized')).toBeInTheDocument()
    expect(screen.getByText('已丢弃 span：12')).toBeInTheDocument()
    expect(screen.getByText('未启用')).toHaveAttribute('title', '仅代表当前 API 实例')
  })
})
