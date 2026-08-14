import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
/**
 * Observability smoke for the Cursor engine — mirrors the Claude Code
 * unavailable scenarios: ENOENT, immediate exit, stuck tool (heartbeat),
 * and kill mid-stream.
 *
 * Reuses the parser-level cursor event shape; see cursor-stream-parser.ts
 * for the exact message envelopes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import { CursorAgentEngine } from '../cursor-agent.js'
import type { StreamLogEntry } from '../types.js'

const engineConfig = {
  apiKey: '',
  timeoutMinutes: 5,
  agentForce: true,
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

function getExecuteStream(engine: CursorAgentEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (
        request: Record<string, unknown>,
        model: string,
      ) => Promise<{ output: string }>
    }
  ).executeStreamWithModel.bind(engine)
}

describe('CursorAgentEngine — provider unavailable scenarios', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('CLI missing (ENOENT): preparing emitted, spawned absent', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(
      engineConfig as unknown as ConstructorParameters<typeof CursorAgentEngine>[0],
    )
    const entries: StreamLogEntry[] = []

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_cursor_enoent',
        workDir: '/tmp',
        prompt: 'hi',
        onLogEntry: (e: StreamLogEntry) => entries.push(e),
        agentConfig: {},
      },
      'auto',
    )

    const enoent = new Error('spawn cursor-agent ENOENT') as NodeJS.ErrnoException
    enoent.code = 'ENOENT'
    child.emit('error', enoent)

    await expect(promise).rejects.toThrow(/not found/i)

    expect(entries.find((e) => e.type === 'system' && e.subtype === 'preparing')).toBeDefined()
    expect(entries.find((e) => e.type === 'system' && e.subtype === 'spawned')).toBeUndefined()
  })

  it('immediate non-zero exit: preparing + spawned emitted, rejects', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CursorAgentEngine(
      engineConfig as unknown as ConstructorParameters<typeof CursorAgentEngine>[0],
    )
    const entries: StreamLogEntry[] = []

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_cursor_exit1',
        workDir: '/tmp',
        prompt: 'hi',
        onLogEntry: (e: StreamLogEntry) => entries.push(e),
        agentConfig: {},
      },
      'auto',
    )

    child.emit('spawn')
    child.stderr.write('cursor-agent: auth required\n')
    child.emit('close', 1)

    await expect(promise).rejects.toThrow()

    expect(entries.find((e) => e.type === 'system' && e.subtype === 'preparing')).toBeDefined()
    expect(entries.find((e) => e.type === 'system' && e.subtype === 'spawned')).toBeDefined()
  })

  it('stuck tool: heartbeats fire for started tool_call until close', async () => {
    vi.useFakeTimers()
    try {
      const child = new MockChildProcess()
      mockSpawn.mockReturnValue(child)

      const engine = new CursorAgentEngine(
        engineConfig as unknown as ConstructorParameters<typeof CursorAgentEngine>[0],
      )
      const entries: StreamLogEntry[] = []

      const promise = getExecuteStream(engine)(
        {
          taskId: 'task_cursor_stuck',
          workDir: '/tmp',
          prompt: 'run long bash',
          onLogEntry: (e: StreamLogEntry) => entries.push(e),
          agentConfig: {},
        },
        'auto',
      )

      child.emit('spawn')
      // Cursor emits a top-level tool_call; parseToolCall reads call_id +
      // tool_name + input.
      child.stdout.write(
        `${JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          call_id: 'call_stuck',
          tool_name: 'Bash',
          input: { command: 'sleep 3600' },
        })}\n`,
      )
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(20_000)
      await vi.advanceTimersByTimeAsync(20_000)

      const heartbeats = entries.filter(
        (e) => e.type === 'tool_heartbeat' && e.callId === 'call_stuck',
      )
      expect(heartbeats.length).toBeGreaterThanOrEqual(2)

      // Close the child; tracker must stop.
      child.stdout.write(
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
      )
      await vi.advanceTimersByTimeAsync(0)
      child.emit('close', 0)
      await promise

      const beforeClose = entries.filter((e) => e.type === 'tool_heartbeat').length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(entries.filter((e) => e.type === 'tool_heartbeat').length).toBe(beforeClose)
    } finally {
      vi.useRealTimers()
    }
  })
})
