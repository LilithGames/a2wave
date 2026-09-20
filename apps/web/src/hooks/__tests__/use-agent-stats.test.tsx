import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { type TimeseriesRange, useAgentStats, useAgentTimeseries } from '../use-runs'

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
afterEach(() => {
  client.clear()
  vi.unstubAllGlobals()
})

it('requests the same calendar range and timezone for summaries and trends, refetching on range changes', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ askerCount: 2 }) })
  vi.stubGlobal('fetch', fetchMock)
  const initialRange: TimeseriesRange = { from: '2026-09-01', to: '2026-09-07', bucket: 'day' }
  const { rerender } = renderHook(
    ({ range }) => {
      useAgentStats('agt_1', range)
      useAgentTimeseries('agt_1', range)
    },
    { initialProps: { range: initialRange }, wrapper },
  )
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  const urls = fetchMock.mock.calls.map(([url]) => new URL(url, 'http://localhost'))
  expect(urls[0].pathname).toBe('/api/agents/agt_1/stats')
  expect(urls[0].searchParams.get('from')).toBe(initialRange.from)
  expect(urls[0].searchParams.get('to')).toBe(initialRange.to)
  expect(urls[0].search).toBe(urls[1].search)

  rerender({ range: { from: '2026-09-20', to: '2026-09-20', bucket: 'hour' } })
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
  const updated = new URL(fetchMock.mock.calls[2][0], 'http://localhost')
  expect(updated.searchParams.get('from')).toBe('2026-09-20')
  expect(updated.searchParams.get('to')).toBe('2026-09-20')
})

it('keeps requests without a range compatible with lifetime stats', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ askerCount: 2 }) })
  vi.stubGlobal('fetch', fetchMock)
  renderHook(() => useAgentStats('agt_1'), { wrapper })
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/agt_1/stats', { credentials: 'include' }),
  )
})
