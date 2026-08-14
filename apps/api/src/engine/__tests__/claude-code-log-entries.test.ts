import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import { ClaudeCodeEngine } from '../claude-code.js'

const engineConfig = {
  path: 'claude',
  apiKey: '',
  baseUrl: '',
  timeoutMinutes: 5,
  force: true,
  approveMcps: true,
  defaultWorkDir: '/tmp',
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid = 12345
  kill = vi.fn()
}

type StreamRequest = Record<string, unknown>

function getExecuteStream(engine: ClaudeCodeEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (request: StreamRequest, model: string) => Promise<{ output: string }>
    }
  ).executeStreamWithModel.bind(engine)
}

describe('ClaudeCodeEngine onLogEntry callbacks', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('emits tool_call started with input from assistant tool_use block', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_cc_1',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'claude-sonnet-4-6',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: { command: 'ls -la' },
            },
          ],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'done',
        duration_ms: 200,
      })}\n`,
    )
    child.emit('close', 0)

    await promise

    const toolEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string }]) =>
        e.type === 'tool_call' && e.subtype === 'started',
    )
    expect(toolEntry).toBeDefined()
    expect(toolEntry?.[0]).toMatchObject({
      type: 'tool_call',
      subtype: 'started',
      callId: 'toolu_1',
      toolName: 'Bash',
      input: { command: 'ls -la' },
    })
  })

  it('emits tool_call without input when input is not an object', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_cc_2',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'claude-sonnet-4-6',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_2',
              name: 'Read',
              input: 'not-an-object',
            },
          ],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'done',
      })}\n`,
    )
    child.emit('close', 0)

    await promise

    const toolEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'tool_call',
    )
    expect(toolEntry).toBeDefined()
    expect(toolEntry?.[0].input).toBeUndefined()
  })

  it('emits assistant text and result log entries', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_cc_3',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'claude-sonnet-4-6',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'thinking...' }] },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'final answer',
        duration_ms: 3000,
      })}\n`,
    )
    child.emit('close', 0)

    await promise

    const assistantEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'assistant',
    )
    expect(assistantEntry).toBeDefined()
    expect(assistantEntry?.[0]).toMatchObject({ type: 'assistant', text: 'thinking...' })

    const resultEntry = onLogEntry.mock.calls.find(([e]: [{ type: string }]) => e.type === 'result')
    expect(resultEntry).toBeDefined()
    expect(resultEntry?.[0]).toMatchObject({ type: 'result', subtype: 'success', durationMs: 3000 })
  })

  it('keeps captured usage when a later result omits it', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new ClaudeCodeEngine(engineConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task_cc_usage_guard', workDir: '/tmp', prompt: 'hello', agentConfig: {} },
      'claude-sonnet-4-6',
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'first',
        usage: { input_tokens: 100, output_tokens: 20 },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'final' })}\n`,
    )
    child.emit('close', 0)
    const result = await promise
    expect((result as { usage?: unknown }).usage).toEqual({ inputTokens: 100, outputTokens: 20 })
  })

  it('attaches usage from an error result to the rejected Error', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)
    const engine = new ClaudeCodeEngine(engineConfig)
    const promise = getExecuteStream(engine)(
      { taskId: 'task_cc_err_usage', workDir: '/tmp', prompt: 'hello', agentConfig: {} },
      'claude-sonnet-4-6',
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'max turns exceeded',
        usage: { input_tokens: 80000, output_tokens: 4000 },
      })}\n`,
    )
    child.emit('close', 1)
    await expect(promise).rejects.toMatchObject({
      message: 'max turns exceeded',
      usage: { inputTokens: 80000, outputTokens: 4000 },
    })
  })

  it('emits preparing + spawned lifecycle markers', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const onLogEntry = vi.fn<(entry: { type: string; subtype?: string }) => void>()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_cc_lifecycle',
        workDir: '/tmp',
        prompt: 'hi',
        onLogEntry,
        agentConfig: {},
      },
      'claude-sonnet-4-6',
    )

    // Emit 'spawn' once so the lifecycle marker fires.
    child.emit('spawn')
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`)
    child.emit('close', 0)
    await promise

    const preparing = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string }]) =>
        e.type === 'system' && e.subtype === 'preparing',
    )
    const spawned = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string }]) => e.type === 'system' && e.subtype === 'spawned',
    )
    expect(preparing).toBeDefined()
    expect(spawned).toBeDefined()
  })

  it('emits tool_call:completed from a user tool_result block', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const onLogEntry =
      vi.fn<
        (entry: { type: string; subtype?: string; callId?: string; toolName?: string }) => void
      >()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_cc_tool_completed',
        workDir: '/tmp',
        prompt: 'hi',
        onLogEntry,
        agentConfig: {},
      },
      'claude-sonnet-4-6',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: { command: 'ls' } }],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_ok', content: 'file1\nfile2' }],
        },
      })}\n`,
    )
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`)
    child.emit('close', 0)
    await promise

    const completed = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string; callId?: string; toolName?: string }]) =>
        e.type === 'tool_call' && e.subtype === 'completed' && e.callId === 'toolu_ok',
    )
    expect(completed).toBeDefined()
    // Completion entries must carry the tool name so the UI can render
    // "✓ Bash" rather than a blank ✓ row.
    expect(completed?.[0].toolName).toBe('Bash')
  })

  it('emits tool_call:failed when tool_result.is_error is true', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const onLogEntry =
      vi.fn<
        (entry: {
          type: string
          subtype?: string
          callId?: string
          error?: string
          toolName?: string
        }) => void
      >()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_cc_tool_failed',
        workDir: '/tmp',
        prompt: 'hi',
        onLogEntry,
        agentConfig: {},
      },
      'claude-sonnet-4-6',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_err', name: 'Bash', input: { command: 'bad' } }],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_err',
              is_error: true,
              content: [{ type: 'text', text: 'command not found' }],
            },
          ],
        },
      })}\n`,
    )
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`)
    child.emit('close', 0)
    await promise

    const failed = onLogEntry.mock.calls.find(
      ([e]: [
        { type: string; subtype?: string; callId?: string; error?: string; toolName?: string },
      ]) => e.type === 'tool_call' && e.subtype === 'failed' && e.callId === 'toolu_err',
    )
    expect(failed).toBeDefined()
    expect(failed?.[0].error).toContain('command not found')
    expect(failed?.[0].toolName).toBe('Bash')
  })

  it('drops high-frequency noise system events (thinking_tokens) but keeps meaningful ones', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_cc_noise',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'claude-sonnet-4-6',
    )

    child.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-6' })}\n`,
    )
    for (let i = 0; i < 50; i++) {
      child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'thinking_tokens' })}\n`)
    }
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`)
    child.emit('close', 0)
    await promise

    const systemEntries = onLogEntry.mock.calls
      .map(([e]: [{ type: string; subtype?: string }]) => e)
      .filter((e) => e.type === 'system')
    expect(systemEntries.every((e) => e.subtype !== 'thinking_tokens')).toBe(true)
    expect(systemEntries.some((e) => e.subtype === 'init')).toBe(true)
  })
})
