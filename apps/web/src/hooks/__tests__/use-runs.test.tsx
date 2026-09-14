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

import { useRun, useRunSession, useRunSessions, useRuns } from '../use-runs'

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

  it('requests the session list with the same filters as the run list', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [],
        pagination: { total: 0, page: 2, pageSize: 15, totalPages: 0 },
      }),
    })

    const { result } = renderHook(
      () =>
        useRunSessions({
          agentId: 'agt_1',
          startDate: '2026-08-01T00:00:00.000Z',
          endDate: '2026-08-31T23:59:59.999Z',
          page: 2,
          pageSize: 15,
        }),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/runs/sessions?agentId=agt_1&startDate=2026-08-01T00%3A00%3A00.000Z&endDate=2026-08-31T23%3A59%3A59.999Z&page=2&pageSize=15',
      { credentials: 'include' },
    )
  })

  it('polls the session list while any session has an active run', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'run_1',
            conversationId: 'cvs_1',
            status: 'running',
            latestRun: makeRun('running', 'run_1'),
            runCount: 1,
            turnCount: 1,
            failedCount: 0,
            failedRunIds: [],
            hasActiveRun: true,
            activeRunId: 'run_1',
            createdAt: '2026-08-14T00:00:00.000Z',
            updatedAt: '2026-08-14T00:00:00.000Z',
          },
        ],
        pagination: { total: 1, page: 1, pageSize: 20, totalPages: 1 },
      }),
    })

    const { result } = renderHook(() => useRunSessions(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await vi.advanceTimersByTimeAsync(2_000)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('loads a whole session through any member run id and keeps polling while active', async () => {
    getMock.mockResolvedValue({
      data: {
        summary: {
          id: 'run_2',
          conversationId: 'cvs_1',
          status: 'queued',
          latestRun: makeRun('queued', 'run_2'),
          runCount: 2,
          turnCount: 2,
          failedCount: 0,
          failedRunIds: [],
          hasActiveRun: true,
          activeRunId: 'run_2',
          createdAt: '2026-08-14T00:00:00.000Z',
          updatedAt: '2026-08-14T00:01:00.000Z',
        },
        runs: [],
      },
    })

    const { result } = renderHook(() => useRunSession('run_1'), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getMock).toHaveBeenCalledWith('/runs/run_1/session')
    await vi.advanceTimersByTimeAsync(2_000)
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
  })
})
