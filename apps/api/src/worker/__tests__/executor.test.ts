import { existsSync } from 'node:fs'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../engine/index.js', () => ({
  engineRegistry: {
    get: vi.fn(),
    cancel: vi.fn(),
    types: ['cursor'],
  },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('../../lib/settings.js', () => ({
  getSetting: vi.fn().mockReturnValue('15'),
}))

import { emitExecutionProcessLogLine } from '../../engine/execution-process-log.js'
import { engineRegistry } from '../../engine/index.js'
import { executeInWorker } from '../executor.js'

const mockEngine = {
  executeStream: vi.fn(),
  type: 'cursor',
  healthCheck: vi.fn().mockResolvedValue(true),
}

function makePayload(
  overrides?: Partial<import('../types.js').WorkerTaskPayload>,
): import('../types.js').WorkerTaskPayload {
  return {
    taskId: 'task_1',
    prompt: 'do something',
    workDir: '/tmp/work',
    agentConfig: { engineType: 'cursor' },
    ...overrides,
  }
}

function makeGroupPayload(
  overrides?: Partial<import('../types.js').WorkerTaskPayload>,
): import('../types.js').WorkerTaskPayload {
  return makePayload({
    agentConfig: {
      engineType: 'cursor',
      resolvedMcpServers: [
        {
          name: 'group',
          type: 'stdio',
          command: 'node',
          runtimeGroupConfig: {
            legacyMcpServerId: 'mcp_group',
            config: { backends: { default: [] } },
          },
        },
      ],
    },
    ...overrides,
  })
}

function requireMaterializedPath(path: string | undefined): string {
  expect(path).toBeTypeOf('string')
  if (!path) throw new Error('Expected a materialized runtime group config path')
  return path
}

describe('executeInWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    ;(engineRegistry.get as Mock).mockReturnValue(mockEngine)
    ;(engineRegistry.cancel as Mock).mockResolvedValue(false)
  })

  it('returns failure when engine is not found', async () => {
    ;(engineRegistry.get as Mock).mockReturnValue(undefined)

    const result = await executeInWorker('task_1', makePayload())

    expect(result.success).toBe(false)
    expect(result.error).toContain('No engine registered')
  })

  it('calls engine.executeStream with correct parameters', async () => {
    mockEngine.executeStream.mockResolvedValue({
      success: true,
      output: 'ok',
      durationMs: 100,
    })
    const onUpdate = vi.fn()
    const onLogEntry = vi.fn()

    await executeInWorker('task_1', makePayload(), { onUpdate, onLogEntry })

    expect(mockEngine.executeStream).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_1',
        workDir: '/tmp/work',
        prompt: 'do something',
        onUpdate,
        onLogEntry: expect.any(Function),
      }),
    )
  })

  it('returns success result from engine', async () => {
    mockEngine.executeStream.mockResolvedValue({
      success: true,
      output: 'Done',
      chatId: 'c1',
    })

    const result = await executeInWorker('task_1', makePayload())

    expect(result.success).toBe(true)
    expect(result.output).toBe('Done')
    expect(result.chatId).toBe('c1')
    expect(typeof result.durationMs).toBe('number')
  })

  it('returns failure result from engine', async () => {
    mockEngine.executeStream.mockResolvedValue({
      success: false,
      output: '',
      error: 'model failed',
    })

    const result = await executeInWorker('task_1', makePayload())

    expect(result.success).toBe(false)
    expect(result.error).toBe('model failed')
  })

  it.each([
    ['success', { success: true, output: 'ok' }],
    ['failure', { success: false, output: '', error: 'failed' }],
  ])('cleans runtime group config after engine %s', async (_label, result) => {
    let materializedPath: string | undefined
    mockEngine.executeStream.mockImplementation(async (request) => {
      materializedPath = request.agentConfig.resolvedMcpServers[0].env.A2WAVE_GROUP_CONFIG_PATH
      expect(existsSync(requireMaterializedPath(materializedPath))).toBe(true)
      expect(request.agentConfig.resolvedMcpServers[0].runtimeGroupConfig).toBeUndefined()
      return result
    })

    await executeInWorker('task_1', makeGroupPayload())

    expect(existsSync(requireMaterializedPath(materializedPath))).toBe(false)
  })

  it('handles engine throw gracefully', async () => {
    let materializedPath: string | undefined
    mockEngine.executeStream.mockImplementation(async (request) => {
      materializedPath = request.agentConfig.resolvedMcpServers[0].env.A2WAVE_GROUP_CONFIG_PATH
      throw new Error('crash')
    })

    const result = await executeInWorker('task_1', makeGroupPayload())

    expect(result.success).toBe(false)
    expect(result.error).toBe('crash')
    expect(existsSync(requireMaterializedPath(materializedPath))).toBe(false)
  })

  it('times out when engine takes too long', async () => {
    vi.useFakeTimers()
    let materializedPath: string | undefined
    mockEngine.executeStream.mockImplementation((request) => {
      materializedPath = request.agentConfig.resolvedMcpServers[0].env.A2WAVE_GROUP_CONFIG_PATH
      return new Promise(() => {})
    }) // never resolves

    // Hold the promise instead of awaiting: it only settles once the fake timers
    // below fire the timeout, so awaiting here would deadlock the test.
    const promise = executeInWorker('task_1', makeGroupPayload(), { timeoutMs: 60_000 })

    // Advance past timeout (1 minute = 60000ms)
    await vi.advanceTimersByTimeAsync(61_000)

    const result = await promise

    expect(result.success).toBe(false)
    expect(result.error).toContain('timeout')
    expect(engineRegistry.cancel).toHaveBeenCalledWith('task_1')
    expect(existsSync(requireMaterializedPath(materializedPath))).toBe(false)
  })

  it('preserves usage emitted before the worker timeout', async () => {
    vi.useFakeTimers()
    mockEngine.executeStream.mockImplementation((request) => {
      request.onLogEntry?.({
        type: 'result',
        subtype: 'partial',
        usage: { inputTokens: 25, reasoningTokens: 6 },
        ts: Date.now(),
      })
      return new Promise(() => {})
    })

    const promise = executeInWorker('task_1', makePayload(), { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(250)

    await expect(promise).resolves.toMatchObject({
      success: false,
      usage: { inputTokens: 25, reasoningTokens: 6 },
    })
  })

  it('uses usage from the engine rejection that follows timeout cancellation', async () => {
    vi.useFakeTimers()
    let rejectExecution!: (error: Error) => void
    mockEngine.executeStream.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectExecution = reject
      }),
    )
    ;(engineRegistry.cancel as Mock).mockImplementationOnce(async () => {
      const error = new Error('cancelled') as Error & {
        usage?: { inputTokens: number; cacheReadTokens: number }
      }
      error.usage = { inputTokens: 30, cacheReadTokens: 70 }
      rejectExecution(error)
      return true
    })

    const promise = executeInWorker('task_1', makePayload(), { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(promise).resolves.toMatchObject({
      success: false,
      usage: { inputTokens: 30, cacheReadTokens: 70 },
    })
  })

  it('uses late engine usage after timeout when cancellation finds no active process', async () => {
    vi.useFakeTimers()
    let resolveExecution!: (result: {
      success: boolean
      output: string
      usage: { inputTokens: number; outputTokens: number }
    }) => void
    mockEngine.executeStream.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveExecution = resolve
      }),
    )
    ;(engineRegistry.cancel as Mock).mockImplementationOnce(async () => {
      resolveExecution({
        success: false,
        output: '',
        usage: { inputTokens: 12, outputTokens: 3 },
      })
      return false
    })

    const promise = executeInWorker('task_1', makePayload(), { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(promise).resolves.toMatchObject({
      success: false,
      usage: { inputTokens: 12, outputTokens: 3 },
    })
  })

  it('waits for process cancellation cleanup before returning a timeout', async () => {
    vi.useFakeTimers()
    mockEngine.executeStream.mockImplementation(() => new Promise(() => {}))
    let finishCancellation!: () => void
    ;(engineRegistry.cancel as Mock).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishCancellation = () => resolve(true)
      }),
    )
    let settled = false

    const promise = executeInWorker('task_1', makePayload(), { timeoutMs: 100 }).then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(engineRegistry.cancel).toHaveBeenCalledWith('task_1')
    expect(settled).toBe(false)

    finishCancellation()
    await vi.advanceTimersByTimeAsync(250)
    await expect(promise).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('timeout'),
    })
  })

  it('passes onUpdate to the engine and forwards onLogEntry events', async () => {
    mockEngine.executeStream.mockResolvedValue({
      success: true,
      output: 'ok',
      durationMs: 50,
    })
    const onUpdate = vi.fn()
    const onLogEntry = vi.fn()

    await executeInWorker('task_1', makePayload(), { onUpdate, onLogEntry })

    const callArg = mockEngine.executeStream.mock.calls[0][0]
    expect(callArg.onUpdate).toBe(onUpdate)
    const entry = { type: 'system' as const, subtype: 'init', ts: Date.now() }
    callArg.onLogEntry?.(entry)
    expect(onLogEntry).toHaveBeenCalledWith(entry)
  })

  it('registers the Run log callback for Agent Router child-process events', async () => {
    mockEngine.executeStream.mockImplementation(async () => {
      emitExecutionProcessLogLine(
        'task_1',
        '[agent-router] {"event":"a2a.task.cancel_result","target":"payment","taskId":"task-remote","state":"TASK_STATE_CANCELED"}',
      )
      return { success: true, output: 'ok', durationMs: 50 }
    })
    const onLogEntry = vi.fn()

    await executeInWorker('task_1', makePayload(), { onLogEntry })

    expect(onLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        subtype: 'a2a.task.cancel_result',
        metadata: expect.objectContaining({ taskId: 'task-remote', state: 'TASK_STATE_CANCELED' }),
      }),
    )
  })

  it('uses agentConfig.timeoutMinutes for timeout resolution', async () => {
    vi.useFakeTimers()
    mockEngine.executeStream.mockImplementation(() => new Promise(() => {})) // never resolves

    // timeoutMinutes: 2 → 120000ms timeout
    const promise = executeInWorker(
      'task_1',
      makePayload({
        agentConfig: { engineType: 'cursor', timeoutMinutes: 2 } as any,
      }),
    )

    // Should NOT timeout at 1 minute
    await vi.advanceTimersByTimeAsync(60_000)

    // Advance past 2 minutes
    await vi.advanceTimersByTimeAsync(61_000)

    const result = await promise

    expect(result.success).toBe(false)
    expect(result.error).toContain('timeout')
    // Timeout message should reflect 120s (2 minutes)
    expect(result.error).toContain('120')
    expect(engineRegistry.cancel).toHaveBeenCalledWith('task_1')
  })
})
