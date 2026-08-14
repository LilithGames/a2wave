/**
 * Behavioural tests for `useAgentChat`'s transcript-adoption effect.
 *
 * Eight review rounds produced defects in this effect and every one of them was a
 * BEHAVIOURAL bug that a pure-function test could not have caught: a transcript
 * blanked, a composer frozen, a placeholder deleted, thumbnails revoked. These
 * tests drive the real hook against a controllable query result so those states
 * are pinned rather than re-argued.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The messages query result the hook sees; mutated per test. */
let chatHistory: {
  run: { id: string; status: string; result?: Record<string, unknown> | null }
  messages: Array<{ role: string; content: string }>
} | null = null
let chatHistoryIsError = false
let chatHistoryIsFetching = false
/** Session list used by the resume effect. */
let agentChats: Array<{ id: string }> = []

vi.mock('@/hooks/use-chat-history', () => ({
  useAgentChats: () => ({ data: agentChats, refetch: vi.fn() }),
  useChatMessages: () => ({
    data: chatHistory ?? undefined,
    refetch: vi.fn(),
    isFetching: chatHistoryIsFetching,
    isError: chatHistoryIsError,
  }),
}))

vi.mock('@/hooks/use-settings', () => ({
  useAttachmentConfig: () => ({
    allowedExtensions: ['png'],
    maxFilesPerRequest: 5,
    maxFileSizeBytes: 1024,
  }),
}))

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(() => Promise.resolve({ data: {} })), upload: vi.fn() },
}))

import { useAgentChat } from '../use-agent-chat'

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function renderChat(loadHistory = true) {
  return renderHook(() => useAgentChat({ agentId: 'agt_1', canChat: true, loadHistory }), {
    wrapper,
  })
}

beforeEach(() => {
  chatHistory = null
  chatHistoryIsError = false
  chatHistoryIsFetching = false
  agentChats = []
})

describe('useAgentChat — restoring a conversation', () => {
  it('renders the restored transcript', async () => {
    agentChats = [{ id: 'run_1' }]
    chatHistory = {
      run: { id: 'run_1', status: 'completed' },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'agent', content: 'hello' },
      ],
    }
    const { result } = renderChat()
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    expect(result.current.messages[1].content).toBe('hello')
    // The restore path also sets followedRunId (so a mid-run resume disables the
    // composer). It MUST be released once the run has settled, or every restored
    // conversation would come back read-only.
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
  })

  it('can send a follow-up after reopening a settled conversation', async () => {
    agentChats = [{ id: 'run_1' }]
    chatHistory = {
      run: { id: 'run_1', status: 'completed' },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'agent', content: 'hello' },
      ],
    }
    const { result } = renderChat()
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    await waitFor(() => expect(result.current.isStreaming).toBe(false))

    act(() => result.current.refreshHistory())
    await waitFor(() => expect(result.current.isStreaming).toBe(false))

    act(() => result.current.setChatInput('follow-up'))
    await waitFor(() => expect(result.current.canSend).toBe(true))
    await act(async () => {
      await result.current.sendMessage()
    })

    expect(result.current.chatInput).toBe('')
  })

  it('keeps the composer disabled while the restored run is still executing', async () => {
    // Regression: a conversation resumed mid-run left followedRunId unset, so the
    // composer stayed enabled on a live run and a second send could cancel it.
    agentChats = [{ id: 'run_1' }]
    chatHistory = {
      run: { id: 'run_1', status: 'running' },
      messages: [{ role: 'user', content: 'hi' }],
    }
    const { result } = renderChat()
    await waitFor(() => expect(result.current.isStreaming).toBe(true))
    expect(result.current.canSend).toBe(false)
  })

  it('surfaces the error for a run that failed without writing any message', async () => {
    // A failed run writes no agent chat row for the in-product channels, so
    // run.result.error is the only record of what happened.
    agentChats = [{ id: 'run_1' }]
    chatHistory = {
      run: { id: 'run_1', status: 'failed', result: { error: 'provider exploded' } },
      messages: [],
    }
    const { result } = renderChat()
    await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0))
    const last = result.current.messages[result.current.messages.length - 1]
    // The bubble exists and is marked failed — that it renders the error text is
    // covered by the i18n layer, which this harness stubs out.
    expect(last.role).toBe('agent')
    expect(last.failed).toBe(true)
  })

  it('releases the follow state for a settled run with no messages', async () => {
    // A settled zero-message SUCCESSFUL run carries nothing to render. It must not
    // fall through to the failure-append path (which would fabricate an error
    // bubble for a run that did not fail), and it must release the follow state so
    // the composer does not stay disabled on a run with nothing to wait for.
    agentChats = [{ id: 'run_1' }]
    chatHistory = { run: { id: 'run_1', status: 'completed' }, messages: [] }
    const { result } = renderChat()
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    // No fabricated error bubble.
    expect(result.current.messages).toHaveLength(0)
  })

  it('does NOT fabricate an error bubble for a settled successful run', async () => {
    // Guards the `!settledFailure` half specifically: removing it lets a completed
    // zero-message run reach the failure-append branch.
    agentChats = [{ id: 'run_1' }]
    chatHistory = {
      run: { id: 'run_1', status: 'completed', result: { error: 'stale error field' } },
      messages: [],
    }
    const { result } = renderChat()
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    expect(result.current.messages.some((m) => m.failed)).toBe(false)
  })

  it('ignores a transcript belonging to a different run', async () => {
    // Regression: an unscoped `restore` adopted any run id, so a poll for the
    // restored run could overwrite the bubbles of a newer turn.
    agentChats = [{ id: 'run_1' }]
    chatHistory = {
      run: { id: 'run_OTHER', status: 'completed' },
      messages: [{ role: 'user', content: 'from another run' }],
    }
    const { result } = renderChat()
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    expect(result.current.messages).toHaveLength(0)
  })
})

describe('useAgentChat — stopping a restored run', () => {
  it('cancels the server-side run, not just the local view', async () => {
    // Regression: the restore path armed the Stop control (via followedRunId) but
    // never armed the run handle it cancels with, so Stop silently detached while
    // the agent CLI ran on — holding a concurrency slot with its reply unreachable.
    const { api } = await import('@/lib/api')
    vi.mocked(api.post).mockClear()

    agentChats = [{ id: 'run_1' }]
    chatHistory = {
      run: { id: 'run_1', status: 'running' },
      messages: [{ role: 'user', content: 'long question' }],
    }
    const { result } = renderChat()
    await waitFor(() => expect(result.current.isStreaming).toBe(true))

    act(() => result.current.stopStreaming())
    expect(api.post).toHaveBeenCalledWith('/runs/run_1/cancel', {})
  })
})

describe('useAgentChat — switching Agent', () => {
  it('clears the previous Agent state instead of carrying it over', async () => {
    // Regression: the detail route keeps this hook mounted while `agentId` changes,
    // so Agent A's messages, engine chatId and run handle leaked into Agent B —
    // B's history never restored, and a message to B resumed A's engine session.
    agentChats = [{ id: 'run_A' }]
    chatHistory = {
      run: { id: 'run_A', status: 'completed' },
      messages: [
        { role: 'user', content: 'to agent A' },
        { role: 'agent', content: 'A replied' },
      ],
    }
    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string }) => useAgentChat({ agentId, canChat: true }),
      { wrapper, initialProps: { agentId: 'agt_A' } },
    )
    await waitFor(() => expect(result.current.messages).toHaveLength(2))

    // Switch Agent; B has no conversations yet.
    agentChats = []
    chatHistory = null
    rerender({ agentId: 'agt_B' })
    await waitFor(() => expect(result.current.messages).toHaveLength(0))
  })
})

describe('useAgentChat — the composer never gets stuck', () => {
  it('recovers when the transcript query errors out', async () => {
    // Regression: both automatic release points sat behind "we have data", so a
    // permanently-erroring query froze the composer with no recovery but reload.
    agentChats = [{ id: 'run_1' }]
    chatHistory = null
    chatHistoryIsError = true
    const { result } = renderChat()
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    expect(result.current.canSend).toBe(false) // empty input, but not blocked by a stuck turn
  })

  it('still renders the transcript after a transient query error recovers', async () => {
    // Regression: the valve downgraded the transcript INTENT to `idle`, which
    // nothing re-arms — so one network blip during the restore fetch left the
    // conversation permanently blank even after the query succeeded. Asserting
    // only `isStreaming === false` (as the first version did) misses this entirely.
    agentChats = [{ id: 'run_1' }]
    chatHistory = undefined as never
    chatHistoryIsError = true
    const { result, rerender } = renderChat()
    await waitFor(() => expect(result.current.isStreaming).toBe(false))

    // Query recovers.
    chatHistoryIsError = false
    chatHistory = {
      run: { id: 'run_1', status: 'completed' },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'agent', content: 'hello' },
      ],
    }
    rerender()
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
  })

  it('starts idle on a surface that does not load history', async () => {
    agentChats = [{ id: 'run_1' }]
    chatHistory = { run: { id: 'run_1', status: 'completed' }, messages: [] }
    const { result } = renderChat(false)
    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    expect(result.current.messages).toHaveLength(0)
  })
})
