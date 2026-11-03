import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerSession } from '../codex-app-server.js'

function harness(overrides: Record<string, unknown> = {}) {
  const sent: Record<string, unknown>[] = []
  const end = vi.fn()
  const onUpdate = vi.fn()
  const onLogEntry = vi.fn()
  const session = new CodexAppServerSession({
    model: 'account-model',
    prompt: 'Do the work',
    cwd: '/workspace',
    version: '1.2.3',
    sandbox: 'read-only',
    onUpdate,
    onLogEntry,
    ...overrides,
  })
  session.start({ write: (line: string) => sent.push(JSON.parse(line)), end })
  const receive = (data: unknown) => session.receive(JSON.stringify(data))
  const initialize = () => {
    receive({ id: 1, result: {} })
    receive({ id: 2, result: { thread: { id: 'thread-1' } } })
    receive({ id: 3, result: { turn: { id: 'turn-1', status: 'inProgress' } } })
  }
  return { session, sent, end, onUpdate, onLogEntry, receive, initialize }
}

describe('Codex SIWC app-server session', () => {
  it('initializes attribution before creating the thread and starts one turn', () => {
    const h = harness({ reasoningEffort: 'high', fastMode: true })
    expect(h.sent).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'a2wave', title: 'a2wave', version: '1.2.3' },
        },
      },
    ])
    h.receive({ id: 1, result: {} })
    expect(h.sent[1]).toEqual({ method: 'initialized' })
    expect(h.sent[2]).toMatchObject({
      id: 2,
      method: 'thread/start',
      params: {
        model: 'account-model',
        modelProvider: 'openai_chatgpt_plan',
        cwd: '/workspace',
        sandbox: 'read-only',
        approvalPolicy: 'never',
      },
    })
    expect(h.sent).toHaveLength(3)
    h.receive({ id: 2, result: { thread: { id: 'thread-1' } } })
    expect(h.sent[3]).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Do the work', text_elements: [] }],
        effort: 'high',
        serviceTier: 'priority',
      },
    })
  })

  it('resumes persisted history with the current model and sandbox settings', () => {
    const h = harness({ chatId: 'previous-thread', sandbox: 'workspace-write' })
    h.receive({ id: 1, result: {} })
    expect(h.sent[2]).toMatchObject({
      method: 'thread/resume',
      params: {
        threadId: 'previous-thread',
        model: 'account-model',
        sandbox: 'workspace-write',
      },
    })
  })

  it('streams deltas, keeps final messages once and normalizes tool output and usage', () => {
    const h = harness()
    h.initialize()
    h.receive({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Hello' } })
    h.receive({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: ' world' } })
    expect(h.onUpdate).toHaveBeenLastCalledWith('Hello world')
    h.receive({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'a', text: 'Hello world' } },
    })
    h.receive({
      method: 'item/started',
      params: { item: { type: 'commandExecution', id: 'c', command: 'ls' } },
    })
    h.receive({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'c',
          command: 'ls',
          exitCode: 0,
          aggregatedOutput: 'file.txt',
          status: 'completed',
        },
      },
    })
    h.receive({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          last: {
            inputTokens: 12,
            cachedInputTokens: 2,
            outputTokens: 3,
            reasoningOutputTokens: 1,
          },
        },
      },
    })
    h.receive({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
    expect(h.session.result).toMatchObject({
      success: true,
      output: 'Hello world',
      chatId: 'thread-1',
      usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 3, reasoningTokens: 1 },
    })
    expect(h.onLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_call',
        toolName: 'shell',
        subtype: 'completed',
        callId: 'c',
        metadata: { exit_code: 0 },
        output: 'file.txt',
      }),
    )
    expect(h.end).toHaveBeenCalledOnce()
  })

  it('accounts for all model calls in this turn without billing resumed history or duplicate usage updates', () => {
    const h = harness({ chatId: 'thread-1' })
    h.initialize()
    const notify = (total: Record<string, number>, last: Record<string, number>) =>
      h.receive({
        method: 'thread/tokenUsage/updated',
        params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { total, last } },
      })
    notify(
      { inputTokens: 112, cachedInputTokens: 22, outputTokens: 13, reasoningOutputTokens: 4 },
      { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 },
    )
    const total = {
      inputTokens: 132,
      cachedInputTokens: 26,
      outputTokens: 18,
      reasoningOutputTokens: 6,
    }
    const last = {
      inputTokens: 20,
      cachedInputTokens: 4,
      outputTokens: 5,
      reasoningOutputTokens: 2,
    }
    notify(total, last)
    notify(total, last)
    h.receive({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
    expect(h.session.result?.usage).toEqual({
      inputTokens: 26,
      cacheReadTokens: 6,
      outputTokens: 8,
      reasoningTokens: 3,
    })
  })

  it('ignores historical usage replayed after thread/resume before the new turn starts', () => {
    const h = harness({ chatId: 'thread-1' })
    h.receive({ id: 1, result: {} })
    h.receive({ id: 2, result: { thread: { id: 'thread-1' } } })
    h.receive({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'old-turn',
        tokenUsage: {
          total: { inputTokens: 100, outputTokens: 10 },
          last: { inputTokens: 40, outputTokens: 4 },
        },
      },
    })
    h.receive({ id: 3, result: { turn: { id: 'turn-1' } } })
    h.receive({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: { inputTokens: 120, outputTokens: 15 },
          last: { inputTokens: 20, outputTokens: 5 },
        },
      },
    })
    expect(h.session.usage).toEqual({ inputTokens: 20, outputTokens: 5 })
  })

  it.each(['failed', 'interrupted'])('does not report %s turns as successful', (status) => {
    const h = harness()
    h.initialize()
    h.receive({
      method: 'turn/completed',
      params: { turn: { status, error: { message: 'Token rejected' } } },
    })
    expect(h.session.result).toMatchObject({ success: false, error: 'Token rejected' })
    expect(h.end).toHaveBeenCalledOnce()
  })

  it('fails an RPC rejection and an unsupported interactive request without hanging', () => {
    const h = harness()
    h.receive({ id: 1, error: { code: -32600, message: 'Unsupported protocol' } })
    expect(h.session.result).toMatchObject({ success: false, error: 'Unsupported protocol' })
    expect(h.end).toHaveBeenCalledOnce()
    const interactive = harness()
    interactive.initialize()
    interactive.receive({
      id: 'approval',
      method: 'item/commandExecution/requestApproval',
      params: {},
    })
    expect(interactive.sent.at(-1)).toMatchObject({ id: 'approval', error: { code: -32601 } })
    expect(interactive.session.result?.success).toBe(false)
  })

  it('cleanResult streams only the latest assistant message', () => {
    const h = harness({ cleanResult: true })
    h.initialize()
    h.receive({
      method: 'item/completed',
      params: { item: { id: 'a', type: 'agentMessage', text: 'Working' } },
    })
    h.receive({ method: 'item/agentMessage/delta', params: { itemId: 'b', delta: 'Final answer' } })
    h.receive({
      method: 'item/completed',
      params: { item: { id: 'b', type: 'agentMessage', text: 'Final answer' } },
    })
    h.receive({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
    expect(h.session.result?.output).toBe('Final answer')
  })
})
