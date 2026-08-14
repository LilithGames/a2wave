import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import { CodexAgentEngine } from '../codex-agent.js'

const engineConfig = {
  path: 'codex',
  apiKey: '',
  timeoutMinutes: 5,
  force: true,
  approveMcps: true,
  defaultWorkDir: '/tmp',
}

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid = 22222
  kill = vi.fn()
}

type StreamRequest = Record<string, unknown>

function getExecuteStream(engine: CodexAgentEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (
        request: StreamRequest,
        model: string,
      ) => Promise<{ output: string; chatId?: string }>
    }
  ).executeStreamWithModel.bind(engine)
}

describe('CodexAgentEngine onLogEntry callbacks', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('emits tool_call started/completed for command_execution items', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_codex_1',
        workDir: '/tmp',
        prompt: 'run ls',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'gpt-5.3-codex',
    )

    child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'th_1' })}\n`)
    child.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`)
    child.stdout.write(
      `${JSON.stringify({
        type: 'item.started',
        item: { id: 'i1', type: 'command_execution', command: 'ls -la' },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'i1',
          type: 'command_execution',
          command: 'ls -la',
          status: 'completed',
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 3 },
      })}\n`,
    )
    child.emit('close', 0)

    const result = await promise
    expect(result.chatId).toBe('th_1')

    const started = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string }]) =>
        e.type === 'tool_call' && e.subtype === 'started',
    )
    expect(started).toBeDefined()
    expect(started?.[0]).toMatchObject({
      type: 'tool_call',
      subtype: 'started',
      callId: 'i1',
      toolName: 'shell',
      input: { command: 'ls -la' },
    })

    const completed = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string }]) =>
        e.type === 'tool_call' && e.subtype === 'completed',
    )
    expect(completed).toBeDefined()
    expect(completed?.[0]).toMatchObject({
      type: 'tool_call',
      subtype: 'completed',
      callId: 'i1',
      toolName: 'shell',
    })
  })

  it('emits assistant text and success result for agent_message', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()
    const onUpdate = vi.fn()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_codex_2',
        workDir: '/tmp',
        prompt: 'hi',
        onUpdate,
        onLogEntry,
        agentConfig: {},
      },
      'gpt-5.3-codex',
    )

    child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'th_2' })}\n`)
    child.stdout.write(
      `${JSON.stringify({
        type: 'item.completed',
        item: { id: 'a1', type: 'agent_message', text: 'final answer' },
      })}\n`,
    )
    child.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
    child.emit('close', 0)

    const result = await promise
    expect(result.output).toBe('final answer')

    const assistant = onLogEntry.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'assistant',
    )
    expect(assistant).toBeDefined()
    expect(assistant?.[0]).toMatchObject({ type: 'assistant', text: 'final answer' })

    const resultEntry = onLogEntry.mock.calls.find(([e]: [{ type: string }]) => e.type === 'result')
    expect(resultEntry).toBeDefined()
    expect(resultEntry?.[0]).toMatchObject({ type: 'result', subtype: 'success' })

    expect(onUpdate).toHaveBeenCalledWith('final answer')
  })

  it('rejects on turn.failed with error text', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine(engineConfig)
    const onLogEntry =
      vi.fn<(entry: { type: string; subtype?: string; [k: string]: unknown }) => void>()

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_codex_3',
        workDir: '/tmp',
        prompt: 'broken',
        onLogEntry,
        agentConfig: {},
      },
      'gpt-5.3-codex',
    )

    child.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: 'model refused' })}\n`)
    child.emit('close', 1)

    await expect(promise).rejects.toThrow(/model refused/)

    const resultEntry = onLogEntry.mock.calls.find(
      ([e]: [{ type: string; subtype?: string }]) => e.type === 'result' && e.subtype === 'error',
    )
    expect(resultEntry).toBeDefined()
  })
})
