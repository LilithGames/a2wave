import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
/**
 * Provider-unavailable observability tests.
 *
 * Verifies the log trajectory when the Claude Code CLI is:
 *   1. Missing from PATH (ENOENT)
 *   2. Present but exits immediately (e.g. not logged in)
 *   3. Running but stuck on a tool that never returns (heartbeat path)
 *   4. Interrupted mid-run by an external kill (cancel race)
 *
 * All four paths must leave the log stream in a state the UI can render
 * coherently — at minimum, the `preparing` marker always appears, and
 * `spawned` appears iff the child process actually launched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('../cli-spawn.js', () => ({ spawnCli: mockSpawn }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}))

import { ClaudeCodeEngine } from '../claude-code.js'
import type { StreamLogEntry } from '../types.js'

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

function getExecuteStream(engine: ClaudeCodeEngine) {
  return (
    engine as unknown as {
      executeStreamWithModel: (
        request: Record<string, unknown>,
        model: string,
      ) => Promise<{ output: string }>
    }
  ).executeStreamWithModel.bind(engine)
}

describe('ClaudeCodeEngine — provider unavailable scenarios', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('CLI missing (ENOENT): emits preparing but NOT spawned, rejects cleanly', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const entries: StreamLogEntry[] = []

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_enoent',
        workDir: '/tmp',
        prompt: 'hi',
        onLogEntry: (e: StreamLogEntry) => entries.push(e),
        agentConfig: {},
      },
      'claude-sonnet-4-6',
    )

    // Simulate Node.js ENOENT error path — spawn invoked but child process
    // never reaches 'spawn' event. Instead 'error' fires with code='ENOENT'.
    const enoent = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
    enoent.code = 'ENOENT'
    child.emit('error', enoent)

    await expect(promise).rejects.toThrow(/not found in PATH/i)

    const preparing = entries.find((e) => e.type === 'system' && e.subtype === 'preparing')
    const spawned = entries.find((e) => e.type === 'system' && e.subtype === 'spawned')
    expect(preparing).toBeDefined()
    expect(spawned).toBeUndefined()
  })

  it('immediate exit (e.g. not logged in): emits preparing + spawned, rejects with exit code', async () => {
    const child = new MockChildProcess()
    mockSpawn.mockReturnValue(child)

    const engine = new ClaudeCodeEngine(engineConfig)
    const entries: StreamLogEntry[] = []

    const promise = getExecuteStream(engine)(
      {
        taskId: 'task_exit1',
        workDir: '/tmp',
        prompt: 'hi',
        onLogEntry: (e: StreamLogEntry) => entries.push(e),
        agentConfig: {},
      },
      'claude-sonnet-4-6',
    )

    child.emit('spawn')
    child.stderr.write('Not logged in. Run `claude auth login`.\n')
    child.emit('close', 1)

    await expect(promise).rejects.toThrow(/Claude Code execution failed|Not logged in/i)

    const preparing = entries.find((e) => e.type === 'system' && e.subtype === 'preparing')
    const spawned = entries.find((e) => e.type === 'system' && e.subtype === 'spawned')
    expect(preparing).toBeDefined()
    expect(spawned).toBeDefined()
  })

  it('stuck tool: heartbeat entries accumulate until close stops the tracker', async () => {
    vi.useFakeTimers()
    try {
      const child = new MockChildProcess()
      mockSpawn.mockReturnValue(child)

      const engine = new ClaudeCodeEngine(engineConfig)
      const entries: StreamLogEntry[] = []

      const promise = getExecuteStream(engine)(
        {
          taskId: 'task_stuck',
          workDir: '/tmp',
          prompt: 'run a long bash',
          onLogEntry: (e: StreamLogEntry) => entries.push(e),
          agentConfig: {},
        },
        'claude-sonnet-4-6',
      )

      child.emit('spawn')
      // tool_use arrives but no tool_result will ever be written.
      child.stdout.write(
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_stuck',
                name: 'Bash',
                input: { command: 'sleep 3600' },
              },
            ],
          },
        })}\n`,
      )

      // Allow microtasks to flush the stdout data event synchronously.
      await vi.advanceTimersByTimeAsync(0)

      // Interval is 20s in the engine. Tick through 3 cycles.
      await vi.advanceTimersByTimeAsync(20_000)
      await vi.advanceTimersByTimeAsync(20_000)
      await vi.advanceTimersByTimeAsync(20_000)

      const heartbeats = entries.filter((e) => e.type === 'tool_heartbeat')
      expect(heartbeats.length).toBeGreaterThanOrEqual(3)
      expect(
        heartbeats.every((h) => h.type === 'tool_heartbeat' && h.callId === 'toolu_stuck'),
      ).toBe(true)

      // Now the process is killed (simulating user cancel / timeout).
      child.stdout.write(
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'killed' })}\n`,
      )
      await vi.advanceTimersByTimeAsync(0)
      child.emit('close', 0)
      await promise

      const beforeCloseCount = entries.filter((e) => e.type === 'tool_heartbeat').length

      // After close, heartbeat tracker is stopped — no new entries should
      // ever appear, even if timers keep advancing.
      await vi.advanceTimersByTimeAsync(60_000)
      const afterCloseCount = entries.filter((e) => e.type === 'tool_heartbeat').length
      expect(afterCloseCount).toBe(beforeCloseCount)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tool settles: heartbeat stops for that callId but continues for other open calls', async () => {
    vi.useFakeTimers()
    try {
      const child = new MockChildProcess()
      mockSpawn.mockReturnValue(child)

      const engine = new ClaudeCodeEngine(engineConfig)
      const entries: StreamLogEntry[] = []

      const promise = getExecuteStream(engine)(
        {
          taskId: 'task_mixed',
          workDir: '/tmp',
          prompt: 'run two tools',
          onLogEntry: (e: StreamLogEntry) => entries.push(e),
          agentConfig: {},
        },
        'claude-sonnet-4-6',
      )

      child.emit('spawn')
      // Two parallel tool_use blocks in one assistant message.
      child.stdout.write(
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_fast', name: 'Read', input: { path: '/tmp/a' } },
              { type: 'tool_use', id: 'toolu_slow', name: 'Bash', input: { command: 'sleep 60' } },
            ],
          },
        })}\n`,
      )
      await vi.advanceTimersByTimeAsync(0)

      // After 20s: both tools should have one heartbeat each.
      await vi.advanceTimersByTimeAsync(20_000)
      let hbFast = entries.filter(
        (e) => e.type === 'tool_heartbeat' && e.callId === 'toolu_fast',
      ).length
      let hbSlow = entries.filter(
        (e) => e.type === 'tool_heartbeat' && e.callId === 'toolu_slow',
      ).length
      expect(hbFast).toBe(1)
      expect(hbSlow).toBe(1)

      // Fast tool completes.
      child.stdout.write(
        `${JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_fast', content: 'content' }],
          },
        })}\n`,
      )
      await vi.advanceTimersByTimeAsync(0)

      // Next 20s: only toolu_slow emits a heartbeat, toolu_fast is quiet.
      await vi.advanceTimersByTimeAsync(20_000)
      hbFast = entries.filter(
        (e) => e.type === 'tool_heartbeat' && e.callId === 'toolu_fast',
      ).length
      hbSlow = entries.filter(
        (e) => e.type === 'tool_heartbeat' && e.callId === 'toolu_slow',
      ).length
      expect(hbFast).toBe(1)
      expect(hbSlow).toBe(2)

      child.stdout.write(
        `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
      )
      await vi.advanceTimersByTimeAsync(0)
      child.emit('close', 0)
      await promise
    } finally {
      vi.useRealTimers()
    }
  })

  it('external kill mid-stream: heartbeat.stop() is called, promise rejects with exit error', async () => {
    vi.useFakeTimers()
    try {
      const child = new MockChildProcess()
      mockSpawn.mockReturnValue(child)

      const engine = new ClaudeCodeEngine(engineConfig)
      const entries: StreamLogEntry[] = []

      const promise = getExecuteStream(engine)(
        {
          taskId: 'task_killed',
          workDir: '/tmp',
          prompt: 'run a tool',
          onLogEntry: (e: StreamLogEntry) => entries.push(e),
          agentConfig: {},
        },
        'claude-sonnet-4-6',
      )

      child.emit('spawn')
      child.stdout.write(
        `${JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_mid',
                name: 'Bash',
                input: { command: 'sleep 10' },
              },
            ],
          },
        })}\n`,
      )
      await vi.advanceTimersByTimeAsync(0)

      // 15s in, external kill — process closes with SIGTERM code 143.
      await vi.advanceTimersByTimeAsync(15_000)
      child.emit('close', 143)

      // Emit code path rejects with the 143 exit code message.
      await expect(promise).rejects.toThrow(/Execution cancelled/)

      const heartbeatCountAtKill = entries.filter((e) => e.type === 'tool_heartbeat').length

      // Advance far past 20s interval — no more heartbeats since stop() cleared the timer.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(entries.filter((e) => e.type === 'tool_heartbeat').length).toBe(heartbeatCountAtKill)
    } finally {
      vi.useRealTimers()
    }
  })
})
