import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'
import type { WorkerTaskPayload } from '../../worker/types.js'

const mockExecuteInWorker = vi.fn()
vi.mock('../../worker/index.js', () => ({
  executeInWorker: (...args: unknown[]) => mockExecuteInWorker(...args),
}))

vi.mock('../settings.js', () => ({
  getCategorySettings: vi.fn(() => ({})),
  getSetting: vi.fn(() => undefined),
}))

const mockDbFrom = vi.fn()
vi.mock('../../db/client.js', () => ({ db: { select: () => ({ from: mockDbFrom }) } }))
vi.mock('../../db/schema.js', () => ({ runs: { id: 'runs.id', status: 'runs.status' } }))
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock('../run-log-file.js', () => ({
  createRunLogFileWriter: () => ({ write: vi.fn(), close: vi.fn(() => Promise.resolve()) }),
}))

const events: string[] = []
let traceEnabled = true
const mockStartAttempt = vi.fn()
const mockFinish = vi.fn()
const mockOnLogEntry = vi.fn()
const mockStartRunTrace = vi.fn()
vi.mock('../otel/run-tracer.js', () => ({
  startRunTrace: (...args: unknown[]) => mockStartRunTrace(...args),
}))

import { executeWithRetry, isHardQuotaError, isPermanentError } from '../execute-with-retry.js'

const ROUTER = 'a2wave-agent-router'
const payload: WorkerTaskPayload = {
  taskId: 'task_1',
  prompt: 'hello',
  model: 'model-a',
  agentConfig: {
    maxRetries: 1,
    engineType: 'claude-code',
    resolvedMcpServers: [
      { name: ROUTER, type: 'stdio', env: { KEEP: '1' } },
      { name: 'other', type: 'stdio', env: {} },
    ],
  },
}

const ok = { success: true, output: 'done', durationMs: 5, usage: { inputTokens: 3 } }
const transientFailure = { success: false, output: '', durationMs: 5, error: 'socket hang up' }

function chainResult(value: unknown) {
  return { where: () => asyncQuery({ get: () => value }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  traceEnabled = true
  mockDbFrom.mockReturnValue(chainResult({ status: 'running' }))
  let n = 0
  mockStartAttempt.mockImplementation(() => {
    const id = ++n
    events.push(`attempt:start:${id}`)
    return {
      traceparent: () =>
        traceEnabled ? `00-${'a'.repeat(32)}-${String(id).padStart(16, '0')}-01` : undefined,
      end: (result: { success: boolean }) => events.push(`attempt:end:${id}:${result.success}`),
    }
  })
  mockFinish.mockImplementation(() => events.push('finish'))
  mockStartRunTrace.mockImplementation(() => ({
    enabled: traceEnabled,
    baggage: () => (traceEnabled ? 'session.id=run_1' : undefined),
    onLogEntry: mockOnLogEntry,
    startAttempt: mockStartAttempt,
    finish: mockFinish,
  }))
})

describe('executeWithRetry — OpenTelemetry wiring', () => {
  it('starts the run trace with the run id and the retry classifiers', async () => {
    mockExecuteInWorker.mockResolvedValue(ok)
    await executeWithRetry('task_1', payload, { runId: 'run_1' })
    expect(mockStartRunTrace).toHaveBeenCalledWith('task_1', payload, {
      runId: 'run_1',
      classifiers: { isPermanent: isPermanentError, isHardQuota: isHardQuotaError },
    })
  })

  it('wraps every attempt and finishes once with the final result', async () => {
    vi.useFakeTimers()
    mockExecuteInWorker.mockResolvedValueOnce(transientFailure).mockResolvedValueOnce(ok)
    const pending = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    const { result } = await pending
    vi.useRealTimers()

    expect(events).toEqual([
      'attempt:start:1',
      'attempt:end:1:false',
      'attempt:start:2',
      'attempt:end:2:true',
      'finish',
    ])
    expect(mockStartAttempt.mock.calls[0][0]).toMatchObject({
      attempt: 1,
      providerIndex: 0,
      model: 'model-a',
      engineType: 'claude-code',
      resetChat: false,
    })
    expect(mockFinish).toHaveBeenCalledWith({ result, retries: 1, cancelled: false })
  })

  it('ends the attempt with that attempt’s own usage, before accumulation', async () => {
    vi.useFakeTimers()
    const endedWith: unknown[] = []
    mockStartAttempt.mockImplementation(() => ({
      traceparent: () => undefined,
      end: (result: { usage?: unknown }) => endedWith.push(result.usage),
    }))
    mockExecuteInWorker
      .mockResolvedValueOnce({ ...transientFailure, usage: { inputTokens: 2 } })
      .mockResolvedValueOnce(ok)
    const pending = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    const { result } = await pending
    vi.useRealTimers()
    expect(endedWith).toEqual([{ inputTokens: 2 }, { inputTokens: 3 }])
    expect(result.usage).toEqual({ inputTokens: 5 })
  })

  it('hands each attempt’s traceparent to the CLI child and the agent-router MCP', async () => {
    vi.useFakeTimers()
    mockExecuteInWorker.mockResolvedValueOnce(transientFailure).mockResolvedValueOnce(ok)
    const pending = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    await pending
    vi.useRealTimers()

    const [first, second] = mockExecuteInWorker.mock.calls.map(
      (call) => (call[1] as WorkerTaskPayload).agentConfig,
    )
    const tp = (id: number) => `00-${'a'.repeat(32)}-${String(id).padStart(16, '0')}-01`
    expect(first.agentEnv?.TRACEPARENT).toBe(tp(1))
    expect(second.agentEnv?.TRACEPARENT).toBe(tp(2))
    const router = first.resolvedMcpServers?.find((s) => s.name === ROUTER)
    expect(first.agentEnv?.BAGGAGE).toBe('session.id=run_1')
    expect(router?.env).toEqual({ KEEP: '1', TRACEPARENT: tp(1), BAGGAGE: 'session.id=run_1' })
    expect(first.resolvedMcpServers?.find((s) => s.name === 'other')?.env).toEqual({})
  })

  it('injects nothing when tracing is off', async () => {
    traceEnabled = false
    mockExecuteInWorker.mockResolvedValue(ok)
    await executeWithRetry('task_1', payload)
    const agentConfig = (mockExecuteInWorker.mock.calls[0][1] as WorkerTaskPayload).agentConfig
    expect(agentConfig).toBe(payload.agentConfig)
  })

  it('tees every log entry — including retry events — into the trace', async () => {
    vi.useFakeTimers()
    mockExecuteInWorker
      .mockImplementationOnce(async (_t, _p, opts) => {
        opts.onLogEntry({ type: 'assistant', text: 'hi', ts: 1 })
        return transientFailure
      })
      .mockResolvedValueOnce(ok)
    const external = vi.fn()
    const pending = executeWithRetry('task_1', payload, { onLogEntry: external })
    await vi.runAllTimersAsync()
    await pending
    vi.useRealTimers()
    const types = mockOnLogEntry.mock.calls.map((c) => c[0].type)
    expect(types).toEqual(expect.arrayContaining(['assistant', 'retry']))
    expect(external).toHaveBeenCalledTimes(mockOnLogEntry.mock.calls.length)
  })

  it('reports a cancelled run', async () => {
    mockExecuteInWorker.mockResolvedValue({ ...transientFailure, error: 'Invalid API key' })
    mockDbFrom
      .mockReturnValueOnce(chainResult({ status: 'running' }))
      .mockReturnValue(chainResult({ status: 'cancelled' }))
    await executeWithRetry('task_1', payload, { runId: 'run_1' })
    expect(mockFinish).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }))
  })

  it('adds exactly one cancellation lookup, and only when tracing is on', async () => {
    mockExecuteInWorker.mockResolvedValue({ ...transientFailure, error: 'Invalid API key' })
    await executeWithRetry('task_1', payload, { runId: 'run_1' })
    const withTracing = mockDbFrom.mock.calls.length

    mockDbFrom.mockClear()
    traceEnabled = false
    await executeWithRetry('task_1', payload, { runId: 'run_1' })
    expect(withTracing).toBe(mockDbFrom.mock.calls.length + 1)
  })

  it('finishes the trace and rethrows when execution throws', async () => {
    const boom = new Error('worker crashed')
    mockExecuteInWorker.mockRejectedValue(boom)
    await expect(executeWithRetry('task_1', payload)).rejects.toBe(boom)
    expect(mockFinish).toHaveBeenCalledWith({ thrown: boom, retries: 0 })
  })
})
