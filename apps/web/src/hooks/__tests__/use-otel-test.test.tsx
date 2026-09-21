import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOtelTest } from '@/hooks/use-settings'

const post = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { post, get: vi.fn(), patch: vi.fn() } }))

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

describe('useOtelTest', () => {
  beforeEach(() => post.mockReset())

  it('posts the unsaved draft and resolves to the verdict', async () => {
    post.mockResolvedValue({ data: { ok: true, traceId: 'ab'.repeat(16) } })
    const draft = { endpoint: 'http://c:4318', serviceName: '', resourceAttributes: '' }

    const { result } = renderHook(() => useOtelTest(), { wrapper })
    act(() => result.current.mutate(draft))

    await waitFor(() => expect(result.current.data?.traceId).toBe('ab'.repeat(16)))
    expect(post).toHaveBeenCalledWith('/settings/otel/test', draft)
  })
})
