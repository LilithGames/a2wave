/**
 * The card must never paint a state the server did not report. It used to render one frame from
 * an empty form (switches off, Advanced collapsed) and fill the real values in an effect, which
 * showed up as the "enabled" switch flipping from off to on when the page opened.
 */
import type { OtelStatus } from '@a2wave/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen } from '@/test/render'

const switchRenders: Array<{ label: string; checked: boolean }> = []

vi.mock('@/components/ui/switch', () => ({
  Switch: (props: { checked: boolean; 'aria-label': string }) => {
    switchRenders.push({ label: props['aria-label'], checked: props.checked })
    return (
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props['aria-label']}
      />
    )
  },
}))

const enabledStatus: OtelStatus = {
  enabled: true,
  endpoint: 'http://collector:4318',
  tracesUrl: 'http://collector:4318/v1/traces',
  serviceName: '',
  resourceAttributes: 'openinference.project.name=a2wave',
  captureContent: true,
  headersSet: false,
  headerNames: [],
  active: true,
  lastExportAt: null,
  lastError: null,
  droppedSpans: 0,
  scope: 'this-instance',
}

let query: { data: OtelStatus | undefined; isLoading: boolean; isFetchedAfterMount?: boolean }

vi.mock('@/hooks/use-settings', () => ({
  useOtelStatus: () => query,
  useOtelTest: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
  useUpdateOtel: () => ({ mutate: vi.fn(), isPending: false }),
}))

const { OtelExportCard } = await import('../otel-export-card')

describe('OtelExportCard initial state', () => {
  beforeEach(() => {
    switchRenders.length = 0
  })

  it('renders the reported switch states on the very first paint, never an "off" frame', () => {
    query = { data: enabledStatus, isLoading: false, isFetchedAfterMount: true }
    renderWithProviders(<OtelExportCard />)

    expect(switchRenders.length).toBeGreaterThan(0)
    expect(switchRenders.filter((r) => !r.checked)).toEqual([])
    expect(screen.getByLabelText('资源属性')).toBeVisible()
  })

  it("waits for this visit's fetch instead of seeding the form from a stale cache", () => {
    const stale: OtelStatus = { ...enabledStatus, enabled: false, captureContent: false }
    query = { data: stale, isLoading: false, isFetchedAfterMount: false }
    const view = renderWithProviders(<OtelExportCard />)

    expect(screen.queryByRole('switch')).not.toBeInTheDocument()

    query = { data: enabledStatus, isLoading: false, isFetchedAfterMount: true }
    view.rerender(<OtelExportCard />)

    expect(screen.getByRole('switch', { name: '启用导出' })).toHaveAttribute('aria-checked', 'true')
    expect(switchRenders.filter((r) => !r.checked)).toEqual([])
  })
})
