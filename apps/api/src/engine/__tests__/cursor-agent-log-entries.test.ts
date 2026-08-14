import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import { CursorAgentEngine } from '../cursor-agent.js'

const engineConfig = {
  apiKey: 'test-key',
  timeoutMinutes: 5,
  agentForce: false,
  approveMcps: false,
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

function getExecuteStream(engine: CursorAgentEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (request: StreamRequest, model: string) => Promise<{ output: string }>
    }
  ).executeStreamWithModel.bind(engine)
}

describe('CursorAgentEngine onLogEntry callbacks', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('emits system init log entry', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_1',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'gpt-4' })}\n`)
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done', duration_ms: 100 })}\n`,
    )
    child.emit('close', 0)

    await promise

    // Skip the new `preparing` / `spawned` lifecycle markers — they're
    // expected on every run and tested elsewhere. Find the `init` entry.
    const systemEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string }]) => e.type === 'system' && e.subtype === 'init',
    )
    expect(systemEntry).toBeDefined()
    expect(systemEntry?.[0]).toMatchObject({ type: 'system', subtype: 'init', model: 'gpt-4' })
  })

  it('emits assistant text log entry', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_2',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello world' }] },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
    )
    child.emit('close', 0)

    await promise

    const assistantEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'assistant',
    )
    expect(assistantEntry).toBeDefined()
    expect(assistantEntry?.[0]).toMatchObject({ type: 'assistant', text: 'hello world' })
  })

  it('emits tool_call started with input from assistant tool_use block', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_3',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'read_file',
              input: { path: '/tmp/test.txt' },
            },
          ],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
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
      callId: 'call_1',
      toolName: 'read_file',
      input: { path: '/tmp/test.txt' },
    })
  })

  it('emits tool_call completed from assistant tool_use with result', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_4',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_2',
              name: 'read_file',
              input: { path: '/tmp/test.txt', result: { success: 'file contents' } },
            },
          ],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
    )
    child.emit('close', 0)

    await promise

    const toolEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string }]) =>
        e.type === 'tool_call' && e.subtype === 'completed',
    )
    expect(toolEntry).toBeDefined()
    expect(toolEntry?.[0]).toMatchObject({
      type: 'tool_call',
      subtype: 'completed',
      toolName: 'read_file',
    })
  })

  it('emits tool_call failed from assistant tool_use with error result', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_5',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_3',
              name: 'invoke_agent',
              input: {
                agentId: 'agt_123',
                result: { error: 'MCP error -32001: Request timed out' },
              },
            },
          ],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
    )
    child.emit('close', 0)

    await promise

    const toolEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string }]) =>
        e.type === 'tool_call' && e.subtype === 'failed',
    )
    expect(toolEntry).toBeDefined()
    expect(toolEntry?.[0]).toMatchObject({
      type: 'tool_call',
      subtype: 'failed',
      toolName: 'invoke_agent',
    })
  })

  it('emits tool_call from tool_call stream event with input', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_6',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call_10',
        tool_name: 'list_files',
        input: { directory: '/tmp' },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
    )
    child.emit('close', 0)

    await promise

    const toolEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string; toolName?: string }]) =>
        e.type === 'tool_call' && e.toolName === 'list_files',
    )
    expect(toolEntry).toBeDefined()
    expect(toolEntry?.[0]).toMatchObject({
      type: 'tool_call',
      subtype: 'started',
      callId: 'call_10',
      toolName: 'list_files',
      input: { directory: '/tmp' },
    })
  })

  it('emits tool_call failed from completed tool_call with error result', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_7',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'call_11',
        tool_name: 'invoke_agent',
        input: { result: { error: 'timeout' } },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
    )
    child.emit('close', 0)

    await promise

    const toolEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string; toolName?: string }]) =>
        e.type === 'tool_call' && e.toolName === 'invoke_agent',
    )
    expect(toolEntry).toBeDefined()
    expect(toolEntry?.[0].subtype).toBe('failed')
  })

  it('emits tool_call from tool_result with is_error', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_8',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'tool_result',
        tool_name: 'read_file',
        call_id: 'call_20',
        is_error: true,
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'tool_result',
        tool_name: 'write_file',
        call_id: 'call_21',
        is_error: false,
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
    )
    child.emit('close', 0)

    await promise

    const failedEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string; toolName?: string }]) =>
        e.type === 'tool_call' && e.toolName === 'read_file',
    )
    expect(failedEntry).toBeDefined()
    expect(failedEntry?.[0].subtype).toBe('failed')

    const completedEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string; toolName?: string }]) =>
        e.type === 'tool_call' && e.toolName === 'write_file',
    )
    expect(completedEntry).toBeDefined()
    expect(completedEntry?.[0].subtype).toBe('completed')
  })

  it('emits error log entry', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_9',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'error',
        error: 'Something went wrong',
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
    )
    child.emit('close', 0)

    await promise

    const errorEntry = onLogEntry.mock.calls.find(([e]: [{ type: string }]) => e.type === 'error')
    expect(errorEntry).toBeDefined()
    expect(errorEntry?.[0]).toMatchObject({ type: 'error', message: 'Something went wrong' })
  })

  it('emits result log entry with duration', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_10',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'final', duration_ms: 5000 })}\n`,
    )
    child.emit('close', 0)

    await promise

    const resultEntry = onLogEntry.mock.calls.find(([e]: [{ type: string }]) => e.type === 'result')
    expect(resultEntry).toBeDefined()
    expect(resultEntry?.[0]).toMatchObject({ type: 'result', subtype: 'success', durationMs: 5000 })
  })

  it('deduplicates tool_result when assistant tool_use already settled the call', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_dedup',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'auto',
    )

    // assistant tool_use with result → completed
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call_dedup_1',
              name: 'read_file',
              input: { path: '/tmp/x', result: { success: 'ok' } },
            },
          ],
        },
      })}\n`,
    )
    // tool_result for same callId — should be skipped
    child.stdout.write(
      `${JSON.stringify({
        type: 'tool_result',
        tool_name: 'read_file',
        call_id: 'call_dedup_1',
        is_error: false,
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
    )
    child.emit('close', 0)

    await promise

    const toolEntries = onLogEntry.mock.calls.filter(
      ([e]: [{ type: string; callId?: string }]) =>
        e.type === 'tool_call' && e.callId === 'call_dedup_1',
    )
    // Only 1 entry, not 2
    expect(toolEntries).toHaveLength(1)
    expect(toolEntries[0][0].subtype).toBe('completed')
  })
})
