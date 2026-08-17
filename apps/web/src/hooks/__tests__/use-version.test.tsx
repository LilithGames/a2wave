import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useVersion } from '@/hooks/use-version'

const fetchMock = vi.fn()

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useVersion', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('reads the version from the lightweight /api/version endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: 'v0.7.3' }) })

    const { result } = renderHook(() => useVersion(), { wrapper })

    await waitFor(() => expect(result.current.data).toBe('v0.7.3'))
    expect(fetchMock).toHaveBeenCalledWith('/api/version', expect.anything())
  })

  /**
   * Every surface showing the version is decorative — a failed fetch must
   * degrade to "no version shown", never to an error state that the login page
   * would have to render.
   */
  it('resolves to null rather than throwing when the request fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) })

    const { result } = renderHook(() => useVersion(), { wrapper })

    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.data).toBeNull()
    expect(result.current.isError).toBe(false)
  })

  it('resolves to null when the endpoint answers without a version field', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })

    const { result } = renderHook(() => useVersion(), { wrapper })

    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(result.current.data).toBeNull()
  })
})
