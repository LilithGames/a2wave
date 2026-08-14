import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
/**
 * Observability smoke for the Codex engine — ENOENT, immediate exit,
 * stuck tool (heartbeat). Mirrors Claude Code / Cursor coverage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import { CodexAgentEngine } from '../codex-agent.js'
import type { StreamLogEntry } from '../types.js'

const engineConfig = {
  path: 'codex',
  apiKey: '',
  timeoutMinutes: 5,
  force: true,
  approveMcps: true,
  defaultWorkDir: '/tmp',
} as unknown as ConstructorParameters<typeof CodexAgentEngine>[0]

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = null
  pid = 12345
  kill = vi.fn()
}

function getExecuteStream(engine: CodexAgentEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (
        request: Record<string, unknown>,
        model: string,
      ) => Promise<{ output: string }>
    }
  ).executeStreamWithModel.bind(engine)
}

describe('CodexAgentEngine — provider unavailable scenarios', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('CLI missing (ENOENT): preparing emitted, spawned absent', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine(engineConfig)
    const entries: StreamLogEntry[] = []

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_codex_enoent',
        workDir: '/tmp',
        prompt: 'hi',
        onLogEntry: (e: StreamLogEntry) => entries.push(e),
        agentConfig: {},
      },
      'auto',
    )

    const enoent = new Error('spawn codex ENOENT') as NodeJS.ErrnoException
    enoent.code = 'ENOENT'
    child.emit('error', enoent)

    await expect(promise).rejects.toThrow(/not found in PATH/i)

    expect(entries.find((e) => e.type === 'system' && e.subtype === 'preparing')).toBeDefined()
    expect(entries.find((e) => e.type === 'system' && e.subtype === 'spawned')).toBeUndefined()
  })

  it('immediate non-zero exit: preparing + spawned emitted, rejects', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new CodexAgentEngine(engineConfig)
    const entries: StreamLogEntry[] = []

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_codex_exit',
        workDir: '/tmp',
        prompt: 'hi',
        onLogEntry: (e: StreamLogEntry) => entries.push(e),
        agentConfig: {},
      },
      'auto',
    )

    child.emit('spawn')
    child.stderr.write('codex: unauthorized\n')
    child.emit('close', 1)

    await expect(promise).rejects.toThrow()

    expect(entries.find((e) => e.type === 'system' && e.subtype === 'preparing')).toBeDefined()
    expect(entries.find((e) => e.type === 'system' && e.subtype === 'spawned')).toBeDefined()
  })

  it('stuck tool: heartbeats fire for item.started until close', async () => {
    vi.useFakeTimers()
    try {
      const child = new MockChildProcess()
      mockSpawn.mockReturnValue(child)

      const engine = new CodexAgentEngine(engineConfig)
      const entries: StreamLogEntry[] = []

      const promise = getExecuteStream(engine)(
        {
          taskId: 'task_codex_stuck',
          workDir: '/tmp',
          prompt: 'run shell',
          onLogEntry: (e: StreamLogEntry) => entries.push(e),
          agentConfig: {},
        },
        'auto',
      )

      child.emit('spawn')
      // Codex emits item.started with item.type=command_execution.
      child.stdout.write(
        `${JSON.stringify({
          type: 'item.started',
          item: {
            id: 'item_stuck',
            type: 'command_execution',
            command: 'sleep 3600',
          },
        })}\n`,
      )
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(20_000)
      await vi.advanceTimersByTimeAsync(20_000)

      const heartbeats = entries.filter(
        (e) => e.type === 'tool_heartbeat' && e.callId === 'item_stuck',
      )
      expect(heartbeats.length).toBeGreaterThanOrEqual(2)

      // Turn completes — tracker stops.
      child.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`)
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
