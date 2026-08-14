import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CliProcessRunOptions,
  CliProcessRunner,
  type CliProcessRunnerOptions,
  createLineDecoder,
} from '../cli-process-runner.js'
import {
  _resetExecutionLeasesForTests,
  beginExecutionLease,
  cancelExecutionLease,
} from '../execution-lease-registry.js'
import { registerExecutionProcessLogSink } from '../execution-process-log.js'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}))

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
  readonly pid = 1234
}

function createHarness(
  overrides: Partial<CliProcessRunOptions> = {},
  runnerOverrides: Omit<CliProcessRunnerOptions, 'spawnProcess' | 'stderrLimitBytes'> = {},
) {
  const children: FakeChildProcess[] = []
  const spawnProcess = vi.fn(() => {
    const child = new FakeChildProcess()
    children.push(child)
    return child as unknown as ChildProcess
  })
  const runner = new CliProcessRunner({
    spawnProcess,
    stderrLimitBytes: 16,
    platform: 'win32',
    killWindowsProcessTree: (_pid, onComplete) => onComplete(false),
    ...runnerOverrides,
  })
  const options: CliProcessRunOptions = {
    taskId: 'task_1',
    command: 'example-cli',
    args: [],
    cwd: '/tmp',
    env: {},
    timeoutMs: 60_000,
    label: 'Example CLI',
    onStdoutLine: vi.fn(),
    cleanup: vi.fn(),
    ...overrides,
  }
  return { runner, spawnProcess, children, options }
}

afterEach(() => {
  vi.useRealTimers()
  _resetExecutionLeasesForTests()
})

describe('CliProcessRunner contract', () => {
  it('drops an overlong unterminated line before retaining later process-log lines', () => {
    const lines: string[] = []
    const decoder = createLineDecoder((line) => lines.push(line), { maxLineChars: 64 })

    decoder.write(Buffer.from('x'.repeat(65)))
    decoder.write(Buffer.from('\nkept\n'))
    decoder.flush()

    expect(lines).toEqual(['kept'])
  })

  it('persists sanitized Agent Router lifecycle events from child stderr', async () => {
    const sink = vi.fn()
    const unregister = registerExecutionProcessLogSink('task_1', sink)
    const { runner, children, options } = createHarness()
    const execution = runner.run(options)

    children[0].stderr.write(
      '[agent-router] {"event":"a2a.task.cancel_result","target":"payment","taskId":"task-remote","state":"TASK_STATE_CANCELED","apiKey":"must-not-persist"}\n',
    )
    children[0].emit('close', 0)
    await execution

    expect(sink).toHaveBeenCalledWith({
      type: 'system',
      subtype: 'a2a.task.cancel_result',
      metadata: {
        target: 'payment',
        taskId: 'task-remote',
        state: 'TASK_STATE_CANCELED',
      },
      ts: expect.any(Number),
    })
    expect(JSON.stringify(sink.mock.calls)).not.toContain('must-not-persist')
    unregister()
  })

  it('does not spawn when its execution lease was cancelled during async preparation', async () => {
    const lease = beginExecutionLease('run_1', 'task_1', 'agt_1')
    cancelExecutionLease('run_1')
    const { runner, spawnProcess, options } = createHarness()

    await expect(runner.run(options)).resolves.toMatchObject({ reason: 'cancelled' })
    expect(spawnProcess).not.toHaveBeenCalled()
    lease.finish()
  })

  it('spawns CLI processes in a dedicated process group on POSIX', async () => {
    const { spawnProcess, children, runner, options } = createHarness({}, { platform: 'linux' })
    const execution = runner.run(options)

    expect(spawnProcess).toHaveBeenCalledWith(
      'example-cli',
      [],
      expect.objectContaining({ detached: true }),
    )

    children[0].emit('close', 0)
    return execution
  })

  it('signals the POSIX process group when cancelled', async () => {
    const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      return true
    })
    const { runner, children, options } = createHarness({}, { platform: 'linux', signalProcess })
    const execution = runner.run(options)

    expect(runner.cancel(options.taskId)).toBe(true)
    expect(signalProcess).toHaveBeenCalledWith(-1234, 'SIGTERM')
    expect(children[0].kill).not.toHaveBeenCalled()

    children[0].emit('close', null, 'SIGTERM')
    await expect(execution).resolves.toMatchObject({ reason: 'cancelled' })
  })

  it('terminates the complete Windows process tree when cancelled', async () => {
    const killWindowsProcessTree = vi.fn((_pid: number, onComplete: (success: boolean) => void) =>
      onComplete(true),
    )
    const { runner, children, options } = createHarness({}, { killWindowsProcessTree })
    const execution = runner.run(options)

    expect(runner.cancel(options.taskId)).toBe(true)
    expect(killWindowsProcessTree).toHaveBeenCalledWith(1234, expect.any(Function))
    expect(children[0].kill).not.toHaveBeenCalled()

    children[0].emit('close', null, 'SIGTERM')
    await expect(execution).resolves.toMatchObject({ reason: 'cancelled' })
  })

  it('terminates an active process when its execution lease is cancelled', async () => {
    const lease = beginExecutionLease('run_1', 'task_1', 'agt_1')
    const { runner, children, options } = createHarness()
    const execution = runner.run(options)

    const completion = cancelExecutionLease('run_1')
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    children[0].emit('close', null, 'SIGTERM')

    await expect(execution).resolves.toMatchObject({ reason: 'cancelled' })
    lease.finish()
    await expect(completion).resolves.toBeUndefined()
  })

  it('escalates against a surviving POSIX process group after the leader exits', async () => {
    vi.useFakeTimers()
    const signalProcess = vi.fn(() => true)
    const { runner, children, options } = createHarness(
      { timeoutMs: 100 },
      { platform: 'linux', signalProcess },
    )
    const execution = runner.run(options)

    await vi.advanceTimersByTimeAsync(100)
    children[0].emit('close', null, 'SIGTERM')

    let settled = false
    void execution.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(signalProcess).toHaveBeenCalledWith(-1234, 'SIGKILL')
    await expect(execution).resolves.toMatchObject({ reason: 'timeout' })
  })

  it('finalizes after SIGKILL even when the process group probe is still alive', async () => {
    vi.useFakeTimers()
    const signalProcess = vi.fn(() => true)
    const { runner, children, options } = createHarness(
      { timeoutMs: 100 },
      { platform: 'linux', signalProcess },
    )
    const execution = runner.run(options)

    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(signalProcess).toHaveBeenCalledWith(-1234, 'SIGKILL')

    children[0].emit('close', null, 'SIGKILL')
    await expect(execution).resolves.toMatchObject({ reason: 'timeout' })
  })

  it('falls back to the direct child when POSIX group signalling fails', async () => {
    const signalProcess = vi.fn(() => {
      throw Object.assign(new Error('missing group'), { code: 'ESRCH' })
    })
    const { runner, children, options } = createHarness({}, { platform: 'linux', signalProcess })
    const execution = runner.run(options)

    runner.cancel(options.taskId)

    expect(signalProcess).toHaveBeenCalledWith(-1234, 'SIGTERM')
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    children[0].emit('close', null, 'SIGTERM')
    return execution
  })

  it('reports duration and signal from one monotonic run measurement', async () => {
    let now = 100
    const { runner, children, options } = createHarness({}, { now: () => now })
    const execution = runner.run(options)

    now = 145
    children[0].emit('close', 0, null)

    await expect(execution).resolves.toMatchObject({
      reason: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 45,
    })
  })

  it('decodes UTF-8 and complete lines correctly across chunk boundaries', async () => {
    const onStdoutLine = vi.fn()
    const { runner, children, options } = createHarness({ onStdoutLine })
    const execution = runner.run(options)
    const child = children[0]

    const bytes = Buffer.from('你好\nnext', 'utf8')
    child.stdout.write(bytes.subarray(0, 2))
    child.stdout.write(bytes.subarray(2, 5))
    child.stdout.write(bytes.subarray(5))
    child.emit('close', 0)

    await expect(execution).resolves.toMatchObject({ reason: 'completed', exitCode: 0 })
    expect(onStdoutLine.mock.calls.map(([line]) => line)).toEqual(['你好', 'next'])
  })

  it('rejects a duplicate taskId without replacing the active process', async () => {
    const cleanup = vi.fn()
    const { runner, children, options } = createHarness({ cleanup })
    const first = runner.run(options)

    await expect(runner.run(options)).resolves.toMatchObject({
      reason: 'spawn-error',
      error: expect.objectContaining({ message: expect.stringContaining('already running') }),
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(children).toHaveLength(1)
    expect(runner.cancel(options.taskId)).toBe(true)
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    children[0].emit('close', null)
    await expect(first).resolves.toMatchObject({ reason: 'cancelled' })
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('finalizes and cleans up only once when error is followed by close', async () => {
    const cleanup = vi.fn()
    const { runner, children, options } = createHarness({ cleanup })
    const execution = runner.run(options)
    const child = children[0]

    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }))
    child.emit('close', 1)

    await expect(execution).resolves.toMatchObject({
      reason: 'spawn-error',
      error: expect.objectContaining({ message: 'missing' }),
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(runner.activeCount).toBe(0)
  })

  it('still finalizes when cleanup throws', async () => {
    const { runner, children, options } = createHarness({
      cleanup: () => {
        throw new Error('cleanup failed')
      },
    })
    const execution = runner.run(options)

    expect(() => children[0].emit('close', 0)).not.toThrow()
    await expect(execution).resolves.toMatchObject({ reason: 'completed' })
    expect(runner.activeCount).toBe(0)
  })

  it('keeps stderr bounded while retaining its most recent bytes', async () => {
    const { runner, children, options } = createHarness()
    const execution = runner.run(options)
    const child = children[0]

    child.stderr.write('0123456789')
    child.stderr.write('abcdefghijklmnop')
    child.emit('close', 1)

    await expect(execution).resolves.toMatchObject({
      reason: 'completed',
      stderr: 'abcdefghijklmnop',
    })
  })

  it('reports timeout and escalates SIGTERM to SIGKILL', async () => {
    vi.useFakeTimers()
    const { runner, children, options } = createHarness({ timeoutMs: 100 })
    const execution = runner.run(options)
    const child = children[0]

    await vi.advanceTimersByTimeAsync(100)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('close', null)

    await expect(execution).resolves.toMatchObject({ reason: 'timeout' })
  })

  it('preserves timeout as the process-level first cause when cancellation follows it', async () => {
    vi.useFakeTimers()
    const { runner, children, options } = createHarness({ timeoutMs: 100 })
    const execution = runner.run(options)
    const child = children[0]

    await vi.advanceTimersByTimeAsync(100)
    expect(runner.cancel(options.taskId)).toBe(true)
    child.emit('close', null, 'SIGTERM')

    await expect(execution).resolves.toMatchObject({ reason: 'timeout' })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('cancelAndWait resolves only after the process has finalized', async () => {
    const { runner, children, options } = createHarness()
    const execution = runner.run(options)
    const child = children[0]
    let settled = false

    const cancellation = runner.cancelAndWait(options.taskId).then((result) => {
      settled = true
      return result
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    child.emit('close', null)
    await expect(cancellation).resolves.toBe(true)
    await expect(execution).resolves.toMatchObject({ reason: 'cancelled' })
  })

  it('waits for asynchronous Windows tree termination after the CLI leader closes', async () => {
    let finishTreeTermination: ((success: boolean) => void) | undefined
    const killWindowsProcessTree = vi.fn((_pid: number, onComplete: (success: boolean) => void) => {
      finishTreeTermination = onComplete
    })
    const { runner, children, options } = createHarness({}, { killWindowsProcessTree })
    const execution = runner.run(options)
    let cancellationSettled = false

    const cancellation = runner.cancelAndWait(options.taskId).then((result) => {
      cancellationSettled = true
      return result
    })
    children[0].emit('close', null, 'SIGTERM')
    await Promise.resolve()

    expect(cancellationSettled).toBe(false)
    expect(runner.activeCount).toBe(1)

    finishTreeTermination?.(true)
    await expect(cancellation).resolves.toBe(true)
    await expect(execution).resolves.toMatchObject({ reason: 'cancelled' })
    expect(runner.activeCount).toBe(0)
  })

  it('waits for asynchronous Windows tree termination after the CLI leader errors', async () => {
    let finishTreeTermination: ((success: boolean) => void) | undefined
    const killWindowsProcessTree = vi.fn((_pid: number, onComplete: (success: boolean) => void) => {
      finishTreeTermination = onComplete
    })
    const { runner, children, options } = createHarness({}, { killWindowsProcessTree })
    const execution = runner.run(options)
    const cancellation = runner.cancelAndWait(options.taskId)

    children[0].emit('error', new Error('leader failed while cancelling'))
    await Promise.resolve()
    expect(runner.activeCount).toBe(1)

    finishTreeTermination?.(true)
    await expect(cancellation).resolves.toBe(true)
    await expect(execution).resolves.toMatchObject({ reason: 'cancelled' })
    expect(runner.activeCount).toBe(0)
  })

  it('shutdown terminates every task and waits for all processes to finalize', async () => {
    const { runner, children, options } = createHarness()
    const first = runner.run(options)
    const second = runner.run({ ...options, taskId: 'task_2' })
    let shutdownSettled = false

    const shutdown = runner.shutdown().then(() => {
      shutdownSettled = true
    })
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect(children[1].kill).toHaveBeenCalledWith('SIGTERM')

    children[0].emit('close', null, 'SIGTERM')
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)

    children[1].emit('close', null, 'SIGTERM')
    await shutdown
    await Promise.all([first, second])
    expect(shutdownSettled).toBe(true)
    expect(runner.activeCount).toBe(0)
  })

  it('returns spawn-error and cleanup when work-directory creation fails', async () => {
    const cleanup = vi.fn()
    const ensureWorkDir = vi.fn(() => {
      throw new Error('permission denied')
    })
    const { runner, spawnProcess, options } = createHarness({ cleanup }, { ensureWorkDir })

    await expect(runner.run(options)).resolves.toMatchObject({
      reason: 'spawn-error',
      error: expect.objectContaining({ message: 'permission denied' }),
    })
    expect(ensureWorkDir).toHaveBeenCalledWith('/tmp')
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})
