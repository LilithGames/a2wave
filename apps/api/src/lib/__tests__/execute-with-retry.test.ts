import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'
import type { WorkerTaskPayload } from '../../worker/types.js'
import {
  _getStickyProviderFallbackCacheSizeForTests,
  _resetStickyProviderFallbackForTests,
  executeWithRetry,
} from '../execute-with-retry.js'

const mockExecuteInWorker = vi.fn()
vi.mock('../../worker/index.js', () => ({
  executeInWorker: (...args: unknown[]) => mockExecuteInWorker(...args),
}))

vi.mock('../settings.js', () => ({
  getCategorySettings: vi.fn(() => ({})),
  getSetting: vi.fn(() => undefined),
}))

const mockDbFrom = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  runs: { id: 'runs.id', status: 'runs.status' },
}))

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

// 全量日志旁路：测试中不落真实磁盘文件
const mockRunLogWrite = vi.fn()
const mockRunLogClose = vi.fn(() => Promise.resolve())
const mockCreateRunLogFileWriter = vi.fn((_runId: string) => ({
  write: mockRunLogWrite,
  close: mockRunLogClose,
}))
vi.mock('../run-log-file.js', () => ({
  createRunLogFileWriter: (runId: string) => mockCreateRunLogFileWriter(runId),
}))

function chainResult(value: unknown) {
  return { where: () => asyncQuery({ get: () => value }) }
}

const basePayload: WorkerTaskPayload = {
  taskId: 'task_1',
  prompt: 'hello',
  agentConfig: { timeoutMinutes: 10, maxRetries: 2 },
}

describe('executeWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetStickyProviderFallbackForTests()
    mockDbFrom.mockReturnValue(chainResult({ status: 'running' }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns success on first attempt without retrying', async () => {
    mockExecuteInWorker.mockResolvedValue({
      success: true,
      output: 'done',
      chatId: null,
      durationMs: 100,
    })

    const { result, retries } = await executeWithRetry('task_1', basePayload)

    expect(result.success).toBe(true)
    expect(result.output).toBe('done')
    expect(retries).toHaveLength(0)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
  })

  it('injects channel context into a2wave-agent-router MCP env for A2A forwarding', async () => {
    mockExecuteInWorker.mockResolvedValue({
      success: true,
      output: 'done',
      chatId: null,
      durationMs: 100,
    })
    const channel = {
      channel_type: 'api',
      channel_info: { auth: 'oauth' },
      user_info: { email: 'alice@example.com', source: 'idaas' },
    }
    const payload: WorkerTaskPayload = {
      ...basePayload,
      context: { channel },
      agentConfig: {
        ...basePayload.agentConfig,
        agentEnv: { EXISTING: '1' },
        resolvedMcpServers: [
          {
            name: 'a2wave-agent-router',
            type: 'stdio',
            command: 'node',
            args: ['router.js'],
            env: { A2WAVE_ROUTE_TARGETS: '[]' },
          },
          {
            name: 'other-mcp',
            type: 'stdio',
            command: 'node',
            args: ['other.js'],
            env: {},
          },
        ],
      },
    }

    await executeWithRetry('task_1', payload)

    const forwardedPayload = mockExecuteInWorker.mock.calls[0][1] as WorkerTaskPayload
    const channelB64 = forwardedPayload.agentConfig.agentEnv?.A2WAVE_CHANNEL_B64
    expect(channelB64).toBe(Buffer.from(JSON.stringify(channel), 'utf8').toString('base64url'))
    expect(forwardedPayload.agentConfig.agentEnv).toMatchObject({ EXISTING: '1' })
    const router = forwardedPayload.agentConfig.resolvedMcpServers?.find(
      (server) => server.name === 'a2wave-agent-router',
    )
    const other = forwardedPayload.agentConfig.resolvedMcpServers?.find(
      (server) => server.name === 'other-mcp',
    )
    expect(router?.env).toMatchObject({
      A2WAVE_ROUTE_TARGETS: '[]',
      A2WAVE_CHANNEL_B64: channelB64,
    })
    expect(other?.env).not.toHaveProperty('A2WAVE_CHANNEL_B64')
  })

  it('injects referenced context only into the Agent and router environments', async () => {
    mockExecuteInWorker.mockResolvedValue({
      success: true,
      output: 'done',
      chatId: null,
      durationMs: 100,
    })
    const referencedPromptContext = {
      source: 'feishu',
      text: 'Grafana alert: dependency timed out.',
      messageId: 'om_alert',
      messageType: 'interactive',
      truncated: false,
    }
    const payload: WorkerTaskPayload = {
      ...basePayload,
      referencedPromptContext,
      agentConfig: {
        ...basePayload.agentConfig,
        agentEnv: { EXISTING: '1' },
        resolvedMcpServers: [
          {
            name: 'a2wave-agent-router',
            type: 'stdio',
            command: 'node',
            args: ['router.js'],
            env: { A2WAVE_ROUTE_TARGETS: '[]' },
          },
          {
            name: 'other-mcp',
            type: 'stdio',
            command: 'node',
            args: ['other.js'],
            env: {},
          },
        ],
      },
    }

    await executeWithRetry('task_1', payload)

    const forwardedPayload = mockExecuteInWorker.mock.calls[0][1] as WorkerTaskPayload
    const encoded = forwardedPayload.agentConfig.agentEnv?.A2WAVE_REFERENCED_CONTEXT_B64
    expect(encoded).toBe(
      Buffer.from(JSON.stringify(referencedPromptContext), 'utf8').toString('base64url'),
    )
    const router = forwardedPayload.agentConfig.resolvedMcpServers?.find(
      (server) => server.name === 'a2wave-agent-router',
    )
    const other = forwardedPayload.agentConfig.resolvedMcpServers?.find(
      (server) => server.name === 'other-mcp',
    )
    expect(router?.env?.A2WAVE_REFERENCED_CONTEXT_B64).toBe(encoded)
    expect(other?.env).not.toHaveProperty('A2WAVE_REFERENCED_CONTEXT_B64')
  })

  it('retries on failure and succeeds on second attempt', async () => {
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'timeout',
        durationMs: 60000,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'done',
        chatId: null,
        durationMs: 5000,
      })

    const { result, retries } = await executeWithRetry('task_1', basePayload, { runId: 'run_1' })

    expect(result.success).toBe(true)
    expect(result.output).toBe('done')
    expect(retries).toHaveLength(1)
    expect(retries[0]).toEqual({ attempt: 1, error: 'timeout', durationMs: expect.any(Number) })
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(2)
  })

  it('returns failure when all retries exhausted', async () => {
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'timeout',
      durationMs: 60000,
    })

    const { result, retries } = await executeWithRetry('task_1', basePayload)

    expect(result.success).toBe(false)
    expect(result.error).toBe('timeout')
    expect(retries).toHaveLength(3)
    expect(retries).toEqual([
      { attempt: 1, error: 'timeout', durationMs: expect.any(Number) },
      { attempt: 2, error: 'timeout', durationMs: expect.any(Number) },
      { attempt: 3, error: 'timeout', durationMs: expect.any(Number) },
    ])
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(3)
  })

  it('maxRetries=1: only 2 attempts total', async () => {
    const payload = { ...basePayload, agentConfig: { ...basePayload.agentConfig, maxRetries: 1 } }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'fail',
      durationMs: 100,
    })

    const { result, retries } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(false)
    expect(retries).toHaveLength(2)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(2)
  })

  it('skips retry when run is cancelled', async () => {
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'timeout',
      durationMs: 100,
    })
    mockDbFrom
      .mockReturnValueOnce(chainResult({ status: 'running' }))
      .mockReturnValueOnce(chainResult({ status: 'cancelled' }))

    const { result, retries } = await executeWithRetry('task_1', basePayload, { runId: 'run_1' })

    expect(result.success).toBe(false)
    expect(retries).toHaveLength(1)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
  })

  it('calls onLogEntry with retry entry when retrying', async () => {
    const onLogEntry = vi.fn()
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'fail',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'ok',
        chatId: null,
        durationMs: 50,
      })

    await executeWithRetry('task_1', basePayload, { runId: 'run_1', onLogEntry })

    expect(onLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'retry',
        attempt: 1,
        nextAttemptIn: expect.any(Number),
        ts: expect.any(Number),
      }),
    )
  })

  it('falls through to next provider on fallbackable provider failure', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 0,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            model: 'gpt-5',
            authMode: 'apiKey',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            model: 'gpt-5.3-codex',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '429 rate limit',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'ok',
        chatId: null,
        durationMs: 50,
      })

    const { result, retries } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(true)
    expect(retries).toHaveLength(0)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(2)
    expect(mockExecuteInWorker.mock.calls[1][1].agentConfig.engineType).toBe('codex')
    expect(mockExecuteInWorker.mock.calls[1][1].model).toBe('gpt-5.3-codex')
  })

  it('clears provider-derived fields before executing a fallback provider', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 0,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            model: 'gpt-5',
            skillsDir: '.cursor/skills',
            mcpConfigPath: '.cursor/mcp.json',
            authMode: 'apiKey',
            providerApiKey: 'primary-key',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            authMode: 'localSession',
          },
        ],
        model: 'gpt-5',
        skillsDir: '.cursor/skills',
        mcpConfigPath: '.cursor/mcp.json',
        providerApiKey: 'primary-key',
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        // Use a quota/limit error — 503 / overloaded / spawn etc. are now
        // classified as same-provider retry, not fallback (only account-level
        // quota errors switch providers).
        error: '429 rate limit',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'ok',
        chatId: null,
        durationMs: 50,
      })

    await executeWithRetry('task_1', payload)

    const fallbackPayload = mockExecuteInWorker.mock.calls[1][1]
    expect(fallbackPayload.model).toBeUndefined()
    expect(fallbackPayload.agentConfig.engineType).toBe('codex')
    expect(fallbackPayload.agentConfig.model).toBeUndefined()
    expect(fallbackPayload.agentConfig.skillsDir).toBeUndefined()
    expect(fallbackPayload.agentConfig.mcpConfigPath).toBeUndefined()
    expect(fallbackPayload.agentConfig.providerApiKey).toBeUndefined()
  })

  it('spends the whole per-provider budget on transient errors before switching', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 2,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            authMode: 'apiKey',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '503 unavailable',
        durationMs: 1,
      })
      .mockResolvedValueOnce({ success: true, output: 'ok', chatId: null, durationMs: 1 })
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const { result } = await executeWithRetry('task_1', payload)

    // Critical: a transient 5xx must not immediately burn the backup provider —
    // it retries the SAME provider first (the budget is what eventually moves on).
    expect(result.success).toBe(true)
    expect(mockExecuteInWorker.mock.calls.map((c) => c[1].agentConfig.engineType)).toEqual([
      'cursor',
      'cursor',
    ])
  })

  it('retries transient tools/list failures instead of treating them as capability errors', async () => {
    const payload = {
      ...basePayload,
      agentConfig: { ...basePayload.agentConfig, maxRetries: 2 },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'tools/list timeout',
      durationMs: 100,
    })

    const { result } = await executeWithRetry('task_1', payload, { runId: 'run_1' })

    expect(result.success).toBe(false)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(3)
  })

  it('retries group-proxy no-tools startup failures instead of treating them as capability errors', async () => {
    vi.useFakeTimers()
    const payload = {
      ...basePayload,
      agentConfig: { ...basePayload.agentConfig, maxRetries: 2 },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'No tools available for group "prod". Backends may be unreachable.',
      durationMs: 100,
    })

    // Not awaited yet: the retry backoff sleeps on fake timers, so the run only
    // finishes once runAllTimersAsync below advances them.
    const execution = executeWithRetry('task_1', payload, { runId: 'run_1' })
    await vi.runAllTimersAsync()
    const { result } = await execution

    expect(result.success).toBe(false)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(3)
  })

  it('provider-fallbacks on OAuth session limit error', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 0,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            authMode: 'oauth',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: "You've hit your session limit · resets 12:50pm (UTC)",
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'ok',
        chatId: null,
        durationMs: 50,
      })

    const { result } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(true)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(2)
    expect(mockExecuteInWorker.mock.calls[1][1].agentConfig.engineType).toBe('codex')
  })

  it('provider-fallbacks immediately on model/tool incompatibility and starts a new chat', async () => {
    const payload = {
      ...basePayload,
      chatId: 'chat_primary',
      agentConfig: {
        ...basePayload.agentConfig,
        agentId: 'agt_fast_fallback',
        maxRetries: 2,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            model: 'gpt-5',
            authMode: 'apiKey',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            model: 'gpt-5.3-codex',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'unsupported model: tools are not supported by this model',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'ok',
        chatId: 'chat_fallback',
        durationMs: 50,
      })

    const { result, retries } = await executeWithRetry('task_1', payload, { runId: 'run_1' })

    expect(result.success).toBe(true)
    expect(retries).toHaveLength(0)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(2)
    expect(mockExecuteInWorker.mock.calls[0][1].chatId).toBe('chat_primary')
    expect(mockExecuteInWorker.mock.calls[1][1].agentConfig.engineType).toBe('codex')
    expect(mockExecuteInWorker.mock.calls[1][1].chatId).toBeUndefined()
  })

  it.each(['invalid model: bad-model', 'model not found: bad-model'])(
    'provider-fallbacks immediately on deterministic model error: %s',
    async (error) => {
      const payload = {
        ...basePayload,
        agentConfig: {
          ...basePayload.agentConfig,
          maxRetries: 2,
          providerChain: [
            {
              id: 'pc_1',
              providerId: 'prv_cursor',
              providerName: 'Cursor CLI',
              engineType: 'cursor',
              model: 'bad-model',
              authMode: 'apiKey',
            },
            {
              id: 'pc_2',
              providerId: 'prv_codex',
              providerName: 'Codex CLI',
              engineType: 'codex',
              model: 'gpt-5.3-codex',
              authMode: 'apiKey',
            },
          ],
        },
      }
      mockExecuteInWorker
        .mockResolvedValueOnce({
          success: false,
          output: '',
          error,
          durationMs: 100,
        })
        .mockResolvedValueOnce({
          success: true,
          output: 'ok',
          chatId: null,
          durationMs: 50,
        })

      const { result, retries } = await executeWithRetry('task_1', payload, { runId: 'run_1' })

      expect(result.success).toBe(true)
      expect(retries).toHaveLength(0)
      expect(mockExecuteInWorker).toHaveBeenCalledTimes(2)
      expect(mockExecuteInWorker.mock.calls[1][1].agentConfig.engineType).toBe('codex')
    },
  )

  it('does not provider-fallback when a model/tool error is also permanent', async () => {
    const payload = {
      ...basePayload,
      chatId: 'chat_primary',
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 2,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            model: 'gpt-5',
            authMode: 'apiKey',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            model: 'gpt-5.3-codex',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: '401 Unauthorized: tools are not supported by this model',
      durationMs: 100,
    })

    const { result } = await executeWithRetry('task_1', payload, { runId: 'run_1' })

    expect(result.success).toBe(false)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
  })

  it('keeps retrying transient model runtime errors', async () => {
    const payload = {
      ...basePayload,
      agentConfig: { ...basePayload.agentConfig, maxRetries: 2 },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'model provider timeout while sampling',
      durationMs: 100,
    })

    const { result } = await executeWithRetry('task_1', payload, { runId: 'run_1' })

    expect(result.success).toBe(false)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(3)
  })

  it('keeps retrying temporary model availability errors', async () => {
    const payload = {
      ...basePayload,
      agentConfig: { ...basePayload.agentConfig, maxRetries: 2 },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'The model unavailable right now',
      durationMs: 100,
    })

    const { result } = await executeWithRetry('task_1', payload, { runId: 'run_1' })

    expect(result.success).toBe(false)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(3)
  })

  it('keeps using the fallback provider for a short sticky window after fallback succeeds', async () => {
    const payload = {
      ...basePayload,
      chatId: 'chat_primary',
      agentConfig: {
        ...basePayload.agentConfig,
        agentId: 'agt_sticky',
        maxRetries: 0,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            model: 'gpt-5',
            authMode: 'apiKey',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            model: 'gpt-5.3-codex',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '429 daily limit reached',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'ok',
        chatId: 'chat_fallback',
        durationMs: 50,
      })

    await executeWithRetry('task_1', payload, { runId: 'run_1' })
    mockExecuteInWorker.mockClear()
    mockExecuteInWorker.mockResolvedValueOnce({
      success: true,
      output: 'still ok',
      chatId: 'chat_fallback_2',
      durationMs: 40,
    })

    const followUpPayload = { ...payload, chatId: 'chat_fallback' }
    const { result } = await executeWithRetry('task_2', followUpPayload, { runId: 'run_2' })

    expect(result.success).toBe(true)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
    expect(mockExecuteInWorker.mock.calls[0][1].agentConfig.engineType).toBe('codex')
    expect(mockExecuteInWorker.mock.calls[0][1].chatId).toBe('chat_fallback')
  })

  it('preserves an unknown chat id when sticky fallback is active', async () => {
    const payload = {
      ...basePayload,
      chatId: 'chat_primary',
      agentConfig: {
        ...basePayload.agentConfig,
        agentId: 'agt_sticky_mismatch',
        maxRetries: 0,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            model: 'gpt-5',
            authMode: 'apiKey',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            model: 'gpt-5.3-codex',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '429 daily limit reached',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'ok',
        chatId: 'chat_fallback',
        durationMs: 50,
      })

    await executeWithRetry('task_1', payload, { runId: 'run_1' })
    mockExecuteInWorker.mockClear()
    mockExecuteInWorker.mockResolvedValueOnce({
      success: true,
      output: 'new sticky chat',
      chatId: 'chat_fallback_2',
      durationMs: 40,
    })

    await executeWithRetry(
      'task_2',
      { ...payload, chatId: 'chat_primary_other' },
      { runId: 'run_2' },
    )

    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
    expect(mockExecuteInWorker.mock.calls[0][1].agentConfig.engineType).toBe('codex')
    expect(mockExecuteInWorker.mock.calls[0][1].chatId).toBe('chat_primary_other')
  })

  it('starts a new chat when sticky fallback receives a known chat id from another binding', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        agentId: 'agt_sticky_known_mismatch',
        maxRetries: 0,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            model: 'gpt-5',
            authMode: 'apiKey',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            model: 'gpt-5.3-codex',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker.mockResolvedValueOnce({
      success: true,
      output: 'primary ok',
      chatId: 'chat_primary',
      durationMs: 40,
    })

    await executeWithRetry('task_1', payload, { runId: 'run_1' })
    mockExecuteInWorker.mockClear()
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '429 daily limit reached',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'fallback ok',
        chatId: 'chat_fallback',
        durationMs: 50,
      })

    await executeWithRetry('task_2', { ...payload, chatId: 'chat_primary' }, { runId: 'run_2' })
    mockExecuteInWorker.mockClear()
    mockExecuteInWorker.mockResolvedValueOnce({
      success: true,
      output: 'new sticky chat',
      chatId: 'chat_fallback_2',
      durationMs: 40,
    })

    await executeWithRetry('task_3', { ...payload, chatId: 'chat_primary' }, { runId: 'run_3' })

    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
    expect(mockExecuteInWorker.mock.calls[0][1].agentConfig.engineType).toBe('codex')
    expect(mockExecuteInWorker.mock.calls[0][1].chatId).toBeUndefined()
  })

  it('expires sticky fallback and evicts stale chat bindings after TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        agentId: 'agt_sticky_ttl',
        maxRetries: 0,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            model: 'gpt-5',
            authMode: 'apiKey',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            model: 'gpt-5.3-codex',
            authMode: 'apiKey',
          },
        ],
      },
    }

    mockExecuteInWorker.mockResolvedValueOnce({
      success: true,
      output: 'primary ok',
      chatId: 'chat_primary',
      durationMs: 40,
    })
    await executeWithRetry('task_1', { ...payload, chatId: 'chat_primary' }, { runId: 'run_1' })

    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '429 daily limit reached',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'fallback ok',
        chatId: 'chat_fallback',
        durationMs: 50,
      })
    await executeWithRetry('task_2', { ...payload, chatId: 'chat_primary' }, { runId: 'run_2' })

    vi.setSystemTime(new Date('2026-01-01T00:31:00.000Z'))
    mockExecuteInWorker.mockClear()
    mockExecuteInWorker.mockResolvedValueOnce({
      success: true,
      output: 'primary after ttl',
      chatId: null,
      durationMs: 40,
    })
    await executeWithRetry('task_3', { ...payload, chatId: undefined }, { runId: 'run_3' })

    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
    expect(mockExecuteInWorker.mock.calls[0][1].agentConfig.engineType).toBe('cursor')

    mockExecuteInWorker.mockClear()
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '429 daily limit reached',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'fallback again',
        chatId: 'chat_fallback_2',
        durationMs: 50,
      })
    await executeWithRetry('task_4', { ...payload, chatId: undefined }, { runId: 'run_4' })

    mockExecuteInWorker.mockClear()
    mockExecuteInWorker.mockResolvedValueOnce({
      success: true,
      output: 'sticky preserves unknown old chat',
      chatId: 'chat_fallback_3',
      durationMs: 40,
    })
    await executeWithRetry('task_5', { ...payload, chatId: 'chat_primary' }, { runId: 'run_5' })

    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
    expect(mockExecuteInWorker.mock.calls[0][1].agentConfig.engineType).toBe('codex')
    expect(mockExecuteInWorker.mock.calls[0][1].chatId).toBe('chat_primary')
  })

  it('prunes expired sticky fallback entries when recording a new sticky fallback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const providerChain = [
      {
        id: 'pc_1',
        providerId: 'prv_cursor',
        providerName: 'Cursor CLI',
        engineType: 'cursor',
        model: 'gpt-5',
        authMode: 'apiKey',
      },
      {
        id: 'pc_2',
        providerId: 'prv_codex',
        providerName: 'Codex CLI',
        engineType: 'codex',
        model: 'gpt-5.3-codex',
        authMode: 'apiKey',
      },
    ]

    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '429 daily limit reached',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'old fallback ok',
        chatId: 'chat_old_fallback',
        durationMs: 50,
      })
    await executeWithRetry(
      'task_1',
      {
        ...basePayload,
        agentConfig: {
          ...basePayload.agentConfig,
          agentId: 'agt_stale_sticky',
          maxRetries: 0,
          providerChain,
        },
      },
      { runId: 'run_1' },
    )
    expect(_getStickyProviderFallbackCacheSizeForTests()).toBe(1)

    vi.setSystemTime(new Date('2026-01-01T00:31:00.000Z'))
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '429 daily limit reached',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'new fallback ok',
        chatId: 'chat_new_fallback',
        durationMs: 50,
      })
    await executeWithRetry(
      'task_2',
      {
        ...basePayload,
        agentConfig: {
          ...basePayload.agentConfig,
          agentId: 'agt_fresh_sticky',
          maxRetries: 0,
          providerChain,
        },
      },
      { runId: 'run_2' },
    )

    expect(_getStickyProviderFallbackCacheSizeForTests()).toBe(1)
  })

  it('sticks to the successful provider chain entry when provider ids are repeated', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        agentId: 'agt_sticky_repeated_provider',
        maxRetries: 0,
        providerChain: [
          {
            id: 'pc_bad_model',
            providerId: 'prv_shared',
            providerName: 'Shared Provider',
            engineType: 'cursor',
            model: 'bad-model',
            authMode: 'apiKey',
          },
          {
            id: 'pc_good_model',
            providerId: 'prv_shared',
            providerName: 'Shared Provider',
            engineType: 'cursor',
            model: 'good-model',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '429 daily limit reached',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'ok',
        chatId: 'chat_good_model',
        durationMs: 50,
      })

    await executeWithRetry('task_1', payload, { runId: 'run_1' })
    mockExecuteInWorker.mockClear()
    mockExecuteInWorker.mockResolvedValueOnce({
      success: true,
      output: 'still ok',
      chatId: 'chat_good_model_2',
      durationMs: 40,
    })

    await executeWithRetry('task_2', payload, { runId: 'run_2' })

    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
    expect(mockExecuteInWorker.mock.calls[0][1].model).toBe('good-model')
    expect(mockExecuteInWorker.mock.calls[0][1].agentConfig.model).toBe('good-model')
  })

  it('does not clear chatId on retry when provider chain entries share providerId', async () => {
    vi.useFakeTimers()
    const payload = {
      ...basePayload,
      chatId: 'chat_existing',
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 1,
        providerChain: [
          {
            id: 'pc_bad_model',
            providerId: 'prv_shared',
            providerName: 'Shared Provider',
            engineType: 'cursor',
            model: 'bad-model',
            authMode: 'apiKey',
          },
          {
            id: 'pc_good_model',
            providerId: 'prv_shared',
            providerName: 'Shared Provider',
            engineType: 'cursor',
            model: 'good-model',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'invalid model: bad-model',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'timeout',
        durationMs: 100,
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'ok',
        chatId: 'chat_existing',
        durationMs: 50,
      })

    const execution = executeWithRetry('task_1', payload, { runId: 'run_1' })
    await vi.runAllTimersAsync()
    const { result } = await execution

    expect(result.success).toBe(true)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(3)
    // 1: primary binding keeps the caller's chat.
    expect(mockExecuteInWorker.mock.calls[0][1].chatId).toBe('chat_existing')
    // 2: switching binding starts a fresh chat, even though providerId is shared —
    //    the session belongs to the model, not the provider row.
    expect(mockExecuteInWorker.mock.calls[1][1].chatId).toBeUndefined()
    expect(mockExecuteInWorker.mock.calls[1][1].model).toBe('good-model')
    // 3: a same-provider retry after a transient timeout must NOT clear the chat
    //    again — it stays on the binding it switched to.
    expect(mockExecuteInWorker.mock.calls[2][1].chatId).toBeUndefined()
    expect(mockExecuteInWorker.mock.calls[2][1].model).toBe('good-model')
  })

  it.each(['401 Unauthorized', '403 Forbidden', 'permission denied'])(
    'short-circuits without retry on permanent error: %s',
    async (error) => {
      const payload = {
        ...basePayload,
        agentConfig: { ...basePayload.agentConfig, maxRetries: 2 },
      }
      mockExecuteInWorker.mockResolvedValue({
        success: false,
        output: '',
        error,
        durationMs: 100,
      })

      const { result } = await executeWithRetry('task_1', payload)

      expect(result.success).toBe(false)
      // Permanent errors must NOT retry — 1 call, not maxRetries+1
      expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
    },
  )

  it('short-circuits on capability error with no fallback chain (no backoff retry)', async () => {
    const payload = {
      ...basePayload,
      agentConfig: { ...basePayload.agentConfig, maxRetries: 2 },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'empty tool list',
      durationMs: 100,
    })

    const { result } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(false)
    // Capability mismatch + no fallback chain → don't waste retries on the same config
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
  })

  it('short-circuits on HARD quota error with no fallback chain (no backoff retry)', async () => {
    const payload = {
      ...basePayload,
      agentConfig: { ...basePayload.agentConfig, maxRetries: 2 },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      // hard quota — resets in hours/days; a same-provider backoff can't clear it
      error: '429 daily limit reached',
      durationMs: 100,
    })

    const { result } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(false)
    // Hard quota + no fallback chain → don't waste retries on the same wall
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
  })

  it('SOFT rate-limit (429) with no fallback chain STILL backoff-retries', async () => {
    // Regression guard: soft per-minute 429 must keep its backoff retry — a single
    // retry usually clears the rate window. Only hard quota fast-fails.
    const payload = {
      ...basePayload,
      agentConfig: { ...basePayload.agentConfig, maxRetries: 2 },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: '429 Too Many Requests: rate limit exceeded',
      durationMs: 100,
    })

    const { result } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(false)
    // soft 429 + no fallback → retries up to maxRetries+1 (NOT fast-fail)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(3)
  })

  it('stops before provider fallback when run is cancelled', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 0,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            authMode: 'apiKey',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockDbFrom
      .mockReturnValueOnce(chainResult({ status: 'running' }))
      .mockReturnValueOnce(chainResult({ status: 'cancelled' }))
    mockExecuteInWorker.mockResolvedValueOnce({
      success: false,
      output: '',
      error: '429 rate limit',
      durationMs: 100,
    })

    const { result } = await executeWithRetry('task_1', payload, { runId: 'run_1' })

    expect(result.success).toBe(false)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
  })

  it('does not provider-fallback on non-provider errors', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 0,
        providerChain: [
          {
            id: 'pc_1',
            providerId: 'prv_cursor',
            providerName: 'Cursor CLI',
            engineType: 'cursor',
            authMode: 'apiKey',
          },
          {
            id: 'pc_2',
            providerId: 'prv_codex',
            providerName: 'Codex CLI',
            engineType: 'codex',
            authMode: 'apiKey',
          },
        ],
      },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'permission denied',
      durationMs: 100,
    })

    const { result } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(false)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
  })
})

// ─── Per-provider retry budget (depth-first) ──────────────────────────────
//
// `maxRetries` is a PER-PROVIDER budget, not a whole-chain round count: each
// provider gets maxRetries+1 executions before the chain moves on, and the
// chain is walked exactly once (no round-robin back to the head).
//
// Which errors consume that budget is deliberately split:
//   - transient (timeout / 5xx / network)  → consume budget, backoff retry
//   - soft rate limit (429)                → do NOT consume; switch immediately
//   - hard quota / capability / model      → do NOT consume; switch immediately
// The three no-consume classes are all "this provider is unusable right now",
// where a different account is the direct fix and same-provider backoff is not.
describe('executeWithRetry — per-provider retry budget', () => {
  const twoProviderChain = [
    {
      id: 'pc_1',
      providerId: 'prv_cursor',
      providerName: 'Cursor CLI',
      engineType: 'cursor',
      authMode: 'apiKey',
    },
    {
      id: 'pc_2',
      providerId: 'prv_codex',
      providerName: 'Codex CLI',
      engineType: 'codex',
      authMode: 'apiKey',
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    _resetStickyProviderFallbackForTests()
    mockDbFrom.mockReturnValue(chainResult({ status: 'running' }))
    // Backoff sleeps are real time; advance them automatically so a
    // budget-exhausting test doesn't spend seconds of wall clock.
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function engineTypesOfCalls(): string[] {
    return mockExecuteInWorker.mock.calls.map((call) => call[1].agentConfig.engineType)
  }

  it('spends the whole budget on one provider before moving to the next', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 2,
        providerChain: twoProviderChain,
      },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    const { result } = await execution

    expect(result.success).toBe(false)
    // Depth-first: 3 executions on cursor, THEN 3 on codex — never interleaved.
    expect(engineTypesOfCalls()).toEqual(['cursor', 'cursor', 'cursor', 'codex', 'codex', 'codex'])
  })

  it('walks the chain exactly once and does not round-robin back to the head', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 1,
        providerChain: twoProviderChain,
      },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    await execution

    // (maxRetries + 1) * chainLength = 2 * 2 = 4 — and then STOP.
    expect(engineTypesOfCalls()).toEqual(['cursor', 'cursor', 'codex', 'codex'])
  })

  it('does not spend the budget on a soft rate limit — switches immediately', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 2,
        providerChain: twoProviderChain,
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: '429 Too Many Requests: rate limit exceeded',
        durationMs: 10,
      })
      .mockResolvedValueOnce({ success: true, output: 'ok', chatId: null, durationMs: 10 })

    const { result } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(true)
    // 429 means "this account is unusable right now" — a different account is the
    // direct fix, so don't burn 2 more backoff retries on the same key first.
    expect(engineTypesOfCalls()).toEqual(['cursor', 'codex'])
  })

  it('does not spend the budget on hard quota or capability errors', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 2,
        providerChain: twoProviderChain,
      },
    }
    mockExecuteInWorker
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'You hit your session limit',
        durationMs: 10,
      })
      .mockResolvedValueOnce({ success: true, output: 'ok', chatId: null, durationMs: 10 })

    const { result } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(true)
    expect(engineTypesOfCalls()).toEqual(['cursor', 'codex'])
  })

  it('still fails fast on a permanent error without touching the next provider', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 2,
        providerChain: twoProviderChain,
      },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'permission denied',
      durationMs: 10,
    })

    const { result } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(false)
    expect(engineTypesOfCalls()).toEqual(['cursor'])
  })

  it('keeps the per-provider budget when there is no chain configured', async () => {
    const payload = {
      ...basePayload,
      agentConfig: { ...basePayload.agentConfig, maxRetries: 2 },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    await execution

    expect(mockExecuteInWorker).toHaveBeenCalledTimes(3)
  })

  it('starts a fresh chat when budget exhaustion moves to the next provider', async () => {
    // A chatId is a session owned by one engine/model. The fallback path already
    // reset it; reaching a provider by exhausting the previous one's budget is the
    // OTHER way in, and used to leak the old session into the new CLI.
    const payload = {
      ...basePayload,
      chatId: 'chat_p1',
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 1,
        providerChain: twoProviderChain,
      },
    }
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    await execution

    const chatIds = mockExecuteInWorker.mock.calls.map((call) => call[1].chatId)
    // cursor keeps the caller's chat; codex must start clean.
    expect(chatIds).toEqual(['chat_p1', 'chat_p1', undefined, undefined])
  })

  it('stops mid-budget when the run is cancelled', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 2,
        providerChain: twoProviderChain,
      },
    }
    mockDbFrom
      .mockReturnValueOnce(chainResult({ status: 'running' }))
      .mockReturnValue(chainResult({ status: 'cancelled' }))
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const { result } = await executeWithRetry('task_1', payload, { runId: 'run_1' })

    expect(result.success).toBe(false)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
  })
})

// ─── Run-level wall-clock budget ──────────────────────────────────────────
//
// `timeoutMinutes` bounds ONE worker execution; with a provider chain a run can
// otherwise stack (maxRetries+1) * chainLength of them. `totalTimeoutMinutes` is
// the separate ceiling on the whole run — checked between executions, so it never
// interrupts an in-flight worker, it just stops the next one from starting.
describe('executeWithRetry — run-level deadline', () => {
  const twoProviderChain = [
    {
      id: 'pc_1',
      providerId: 'prv_cursor',
      providerName: 'Cursor CLI',
      engineType: 'cursor',
      authMode: 'apiKey',
    },
    {
      id: 'pc_2',
      providerId: 'prv_codex',
      providerName: 'Codex CLI',
      engineType: 'codex',
      authMode: 'apiKey',
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    _resetStickyProviderFallbackForTests()
    mockDbFrom.mockReturnValue(chainResult({ status: 'running' }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops starting new executions once the total budget is exhausted', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 2,
        totalTimeoutMinutes: 5,
        providerChain: twoProviderChain,
      },
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'))
    // Each worker burns the entire 5-minute budget, so the second execution
    // must never start.
    mockExecuteInWorker.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000 + 1))
      return { success: false, output: '', error: 'connect ETIMEDOUT', durationMs: 10 }
    })

    const { result } = await executeWithRetry('task_1', payload)

    expect(result.success).toBe(false)
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
    expect(result.error).toContain('connect ETIMEDOUT')
  })

  it('runs the full chain when the total budget is generous', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 1,
        totalTimeoutMinutes: 120,
        providerChain: twoProviderChain,
      },
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    await execution

    expect(mockExecuteInWorker).toHaveBeenCalledTimes(4)
  })

  it('does not sleep a backoff that would outlast the budget', async () => {
    // The retry that backoff waits for would be rejected by the deadline check at
    // the top of the loop anyway, so sleeping through it only burns wall clock the
    // caller explicitly capped.
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 5,
        totalTimeoutMinutes: 5,
      },
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'))
    // Burn almost the whole budget in the first execution, leaving less than the
    // first backoff interval.
    mockExecuteInWorker.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000 - 100))
      return { success: false, output: '', error: 'connect ETIMEDOUT', durationMs: 1 }
    })
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 1,
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    await execution

    // Returns after the first execution instead of sleeping past the deadline.
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
  })

  it('is unbounded when totalTimeoutMinutes is not configured', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 1,
        providerChain: twoProviderChain,
      },
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    await execution

    expect(mockExecuteInWorker).toHaveBeenCalledTimes(4)
  })

  // Provider switches are expressed by the provider_fallback log entry (retries[]
  // deliberately records same-provider retries only). A switch caused by a spent
  // retry budget is still a switch, so it must emit the same entry — otherwise run
  // logs cannot tell "retried in place" from "moved on after exhausting budget".
  it('emits provider_fallback when a spent retry budget moves to the next provider', async () => {
    const onLogEntry = vi.fn()
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 1,
        providerChain: twoProviderChain,
      },
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // Transient errors only: they consume the budget rather than switching early.
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const execution = executeWithRetry('task_1', payload, { runId: 'run_budget', onLogEntry })
    await vi.runAllTimersAsync()
    await execution

    expect(onLogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        subtype: 'provider_fallback',
        providerName: 'Cursor CLI',
        nextProviderName: 'Codex CLI',
      }),
    )
  })

  it('does not emit provider_fallback when the last provider exhausts its budget', async () => {
    const onLogEntry = vi.fn()
    const payload = {
      ...basePayload,
      agentConfig: { ...basePayload.agentConfig, maxRetries: 1, providerChain: twoProviderChain },
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const execution = executeWithRetry('task_1', payload, {
      runId: 'run_budget2',
      onLogEntry,
    })
    await vi.runAllTimersAsync()
    await execution

    // Exactly one switch for a two-provider chain — none after the tail.
    const fallbacks = onLogEntry.mock.calls.filter(
      ([entry]) => entry?.subtype === 'provider_fallback',
    )
    expect(fallbacks).toHaveLength(1)
  })

  // A between-executions check alone does not bound the run: a single worker that
  // hangs outlives the budget no matter what the check decides afterwards. The
  // budget only binds if it is handed to the worker as ITS timeout.
  it('caps a single worker timeout at the remaining run budget', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 0,
        timeoutMinutes: 120,
        totalTimeoutMinutes: 5,
      },
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'))
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    await execution

    // 5-minute run budget wins over the 120-minute per-execution timeout.
    expect(mockExecuteInWorker).toHaveBeenCalledWith(
      'task_1',
      expect.anything(),
      expect.objectContaining({ timeoutMs: 5 * 60 * 1000 }),
    )
  })

  it('shrinks the worker timeout to the budget left after earlier attempts', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 1,
        timeoutMinutes: 120,
        totalTimeoutMinutes: 10,
      },
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'))
    // First execution burns 4 of the 10 minutes.
    mockExecuteInWorker.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(Date.now() + 4 * 60 * 1000))
      return { success: false, output: '', error: 'connect ETIMEDOUT', durationMs: 1 }
    })
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 1,
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    await execution

    // The retry may only use what is left of the run budget, not a fresh 120min.
    const secondCallTimeout = mockExecuteInWorker.mock.calls[1]?.[2]?.timeoutMs
    expect(secondCallTimeout).toBeLessThanOrEqual(6 * 60 * 1000)
    expect(secondCallTimeout).toBeGreaterThan(0)
  })

  it('reports a run-level timeout distinctly when the budget kills the worker', async () => {
    const payload = {
      ...basePayload,
      agentConfig: {
        ...basePayload.agentConfig,
        maxRetries: 2,
        timeoutMinutes: 120,
        totalTimeoutMinutes: 5,
        providerChain: twoProviderChain,
      },
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'))
    // The worker is killed by the capped timeout: it burns the whole budget and
    // fails the way executor.ts reports a timeout.
    mockExecuteInWorker.mockImplementation(async (_taskId, _payload, options) => {
      vi.setSystemTime(new Date(Date.now() + (options?.timeoutMs ?? 0)))
      return {
        success: false,
        output: '',
        error: `Task execution timeout (${(options?.timeoutMs ?? 0) / 1000}s)`,
        durationMs: options?.timeoutMs ?? 0,
      }
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    const { result } = await execution

    expect(result.success).toBe(false)
    expect(result.error).toContain('total timeout')
    // Budget is spent: no retry and no provider switch after it.
    expect(mockExecuteInWorker).toHaveBeenCalledTimes(1)
  })

  it('uses the remaining budget even when no per-execution timeout is set', async () => {
    const { timeoutMinutes: _omitted, ...agentConfigWithoutTimeout } = basePayload.agentConfig as {
      timeoutMinutes?: number
    } & Record<string, unknown>
    const payload = {
      ...basePayload,
      agentConfig: {
        ...agentConfigWithoutTimeout,
        maxRetries: 0,
        totalTimeoutMinutes: 5,
      },
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'))
    mockExecuteInWorker.mockResolvedValue({
      success: false,
      output: '',
      error: 'connect ETIMEDOUT',
      durationMs: 10,
    })

    const execution = executeWithRetry('task_1', payload)
    await vi.runAllTimersAsync()
    await execution

    // Without this, executor.ts would fall back to the global default (15min)
    // and overshoot a 5-minute budget.
    expect(mockExecuteInWorker).toHaveBeenCalledWith(
      'task_1',
      expect.anything(),
      expect.objectContaining({ timeoutMs: 5 * 60 * 1000 }),
    )
  })
})

describe('executeWithRetry — full-log NDJSON sidecar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbFrom.mockReturnValue(chainResult({ status: 'running' }))
  })

  it('tees every log entry to the run log file and closes it', async () => {
    mockExecuteInWorker
      .mockResolvedValueOnce({ success: false, output: '', error: 'fail', durationMs: 100 })
      .mockResolvedValueOnce({ success: true, output: 'ok', chatId: null, durationMs: 50 })

    await executeWithRetry('task_1', basePayload, { runId: 'run_tee' })

    expect(mockCreateRunLogFileWriter).toHaveBeenCalledWith('run_tee')
    // 重试产生的 retry 系统条目也必须进文件
    expect(mockRunLogWrite).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'retry', attempt: 1 }),
    )
    expect(mockRunLogClose).toHaveBeenCalledTimes(1)
  })

  it('still forwards entries to the caller onLogEntry when teeing', async () => {
    const onLogEntry = vi.fn()
    mockExecuteInWorker
      .mockResolvedValueOnce({ success: false, output: '', error: 'fail', durationMs: 100 })
      .mockResolvedValueOnce({ success: true, output: 'ok', chatId: null, durationMs: 50 })

    await executeWithRetry('task_1', basePayload, { runId: 'run_tee2', onLogEntry })

    expect(onLogEntry).toHaveBeenCalledWith(expect.objectContaining({ type: 'retry' }))
  })

  it('does not create a writer when runId is absent', async () => {
    mockExecuteInWorker.mockResolvedValue({
      success: true,
      output: 'ok',
      chatId: null,
      durationMs: 50,
    })

    await executeWithRetry('task_1', basePayload)

    expect(mockCreateRunLogFileWriter).not.toHaveBeenCalled()
  })

  it('executes normally when the writer cannot be created', async () => {
    mockCreateRunLogFileWriter.mockReturnValueOnce(null as never)
    mockExecuteInWorker.mockResolvedValue({
      success: true,
      output: 'ok',
      chatId: null,
      durationMs: 50,
    })

    const { result } = await executeWithRetry('task_1', basePayload, { runId: 'run_nofile' })

    expect(result.success).toBe(true)
    expect(mockRunLogWrite).not.toHaveBeenCalled()
  })
})
