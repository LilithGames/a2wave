import { renderWithProviders, screen, userEvent, waitFor } from '@/test/render'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    upload: vi.fn(),
  },
}))

vi.mock('@/hooks/use-chat-history', () => ({
  useAgentChats: () => ({ data: [], refetch: vi.fn() }),
  useChatMessages: () => ({ data: undefined, refetch: vi.fn() }),
}))

vi.mock('@/hooks/use-artifacts', () => ({
  useArtifacts: () => ({ data: [] }),
  getArtifactDownloadUrl: (id: string) => `/api/artifacts/${id}/download`,
}))

import { TestDrawer } from '../test-drawer'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TestDrawer memory refresh', () => {
  it('refreshes immediately and after background memory extraction can finish', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('event: done\ndata: {"reply":"saved","runId":"run_1"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    const { unmount } = renderWithProviders(
      <TestDrawer open onClose={() => {}} agentId="agt_1" agentStatus="active" agentIcon="" />,
    )

    await userEvent.type(screen.getByLabelText('聊天消息'), '请记住这条规则。')
    const timeoutCallBaseline = timeoutSpy.mock.calls.length
    await userEvent.click(screen.getByLabelText('发送消息'))

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['memories', 'agt_1'] }),
    )

    const delayedRefreshes = timeoutSpy.mock.calls
      .slice(timeoutCallBaseline)
      .filter(([, delay]) => delay === 20_000 || delay === 60_000)
    expect(delayedRefreshes.map(([, delay]) => delay)).toEqual([20_000, 60_000])

    const immediateCalls = invalidateSpy.mock.calls.length
    for (const [callback] of delayedRefreshes) {
      ;(callback as () => void)()
    }
    expect(invalidateSpy.mock.calls.length).toBe(immediateCalls + 2)

    unmount()
  })
})
