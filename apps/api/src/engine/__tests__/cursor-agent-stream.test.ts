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

describe('CursorAgentEngine stream updates', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('forwards assistant text blocks to onUpdate before final result', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(engineConfig)
    const onUpdate = vi.fn()

    const promise = (
      engine as unknown as {
        executeStreamWithModel: (
          request: Record<string, unknown>,
          model: string,
        ) => Promise<{ output: string }>
      }
    ).executeStreamWithModel(
      {
        taskId: 'task_stream_1',
        workDir: '/tmp',
        prompt: 'hello',
        onUpdate,
        agentConfig: {},
      },
      'composer-1.5',
    )

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'partial answer' }],
        },
      })}\n`,
    )
    child.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'final answer',
        duration_ms: 123,
      })}\n`,
    )
    child.emit('close', 0)

    const result = await promise

    expect(onUpdate).toHaveBeenNthCalledWith(1, 'partial answer')
    expect(onUpdate).toHaveBeenNthCalledWith(2, 'final answer')
    expect(result.output).toBe('final answer')
  })
})
