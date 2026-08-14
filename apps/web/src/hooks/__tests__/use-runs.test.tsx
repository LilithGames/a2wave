import type { RunWithAgent } from '@a2wave/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getMock = vi.fn()
const fetchMock = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: vi.fn(),
  },
}))

import { useRun, useRuns } from '../use-runs'

function makeRun(status: RunWithAgent['status'], id = `run_${status}`): RunWithAgent {
  return {
    id,
    intent: 'test run',
    status,
    triggerSource: 'debug',
    initiatorAgentId: 'agt_1',
    agentName: 'Agent',
    createdAt: new Date('2026-08-14T00:00:00.000Z'),
    updatedAt: new Date('2026-08-14T00:00:00.000Z'),
  }
}

function runsResponse(statuses: RunWithAgent['status'][]) {
  return {
    ok: true,
    json: async () => ({
      data: statuses.map((status) => makeRun(status)),
      pagination: { total: statuses.length, page: 1, pageSize: 20, totalPages: 1 },
    }),
  }
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
    },
  })

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('run status polling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getMock.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.each(['pending', 'queued', 'running'] as const)(
    'polls the run list while it contains a %s run',
    async (status) => {
      fetchMock.mockResolvedValue(runsResponse([status, 'completed']))

      const { result } = renderHook(() => useRuns({ agentId: 'agt_1' }), {
        wrapper: makeWrapper(),
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2_000)

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    },
  )

  it('stops polling the run list after every run becomes terminal', async () => {
    fetchMock
      .mockResolvedValueOnce(runsResponse(['running']))
      .mockResolvedValue(runsResponse(['completed', 'failed', 'cancelled']))

    const { result } = renderHook(() => useRuns(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await vi.advanceTimersByTimeAsync(2_000)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await vi.advanceTimersByTimeAsync(4_000)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('continues polling a queued run detail', async () => {
    getMock.mockResolvedValue({
      data: { ...makeRun('queued'), steps: [], messages: [] },
    })

    const { result } = renderHook(() => useRun('run_queued'), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2_000)

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
  })
})
