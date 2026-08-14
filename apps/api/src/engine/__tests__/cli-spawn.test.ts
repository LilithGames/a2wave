import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  crossSpawn: vi.fn(),
  nodeExecFile: vi.fn(),
  nodeSpawn: vi.fn(),
  terminateCliProcess: vi.fn(() => Promise.resolve()),
}))

vi.mock('node:child_process', () => ({ execFile: mocks.nodeExecFile, spawn: mocks.nodeSpawn }))
vi.mock('cross-spawn', () => ({ default: mocks.crossSpawn }))
vi.mock('../windows-process-tree.js', () => ({
  terminateCliProcess: mocks.terminateCliProcess,
}))

import { execCli, spawnCli } from '../cli-spawn.js'

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 1234
  kill = vi.fn(() => true)
}

describe('spawnCli', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps Linux on the native Node spawn path', () => {
    const child = {} as ChildProcess
    mocks.nodeSpawn.mockReturnValueOnce(child)

    expect(spawnCli('codex', ['exec'], { cwd: '/work' }, 'linux')).toBe(child)
    expect(mocks.nodeSpawn).toHaveBeenCalledWith('codex', ['exec'], { cwd: '/work' })
    expect(mocks.crossSpawn).not.toHaveBeenCalled()
  })

  it('uses cross-spawn for Windows npm command shims', () => {
    const child = {} as ChildProcess
    mocks.crossSpawn.mockReturnValueOnce(child)

    expect(spawnCli('codex', ['exec'], { cwd: 'C:\\work' }, 'win32')).toBe(child)
    expect(mocks.crossSpawn).toHaveBeenCalledWith('codex', ['exec'], { cwd: 'C:\\work' })
    expect(mocks.nodeSpawn).not.toHaveBeenCalled()
  })

  it('keeps buffered Linux execution on native execFile', async () => {
    mocks.nodeExecFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: null, stdout: string, stderr: string) => void,
      ) => callback(null, 'indexed', ''),
    )

    await expect(execCli('codegraph', ['sync', '/repo'], {}, 'linux')).resolves.toEqual({
      stdout: 'indexed',
      stderr: '',
    })
    expect(mocks.nodeExecFile).toHaveBeenCalledWith(
      'codegraph',
      ['sync', '/repo'],
      {},
      expect.any(Function),
    )
    expect(mocks.crossSpawn).not.toHaveBeenCalled()
  })

  it('buffers output while using the Windows npm-shim spawn path', async () => {
    const child = new MockChildProcess()
    mocks.crossSpawn.mockReturnValueOnce(child)

    const resultPromise = execCli('codegraph', ['sync', 'C:\\repo'], {}, 'win32')
    child.stdout.write('indexed')
    child.stderr.write('warning')
    child.emit('close', 0)

    await expect(resultPromise).resolves.toEqual({ stdout: 'indexed', stderr: 'warning' })
    expect(mocks.crossSpawn).toHaveBeenCalledWith('codegraph', ['sync', 'C:\\repo'], {
      cwd: undefined,
      env: undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })

  it('rejects on timeout without waiting for the child close event', async () => {
    vi.useFakeTimers()
    try {
      const child = new MockChildProcess()
      mocks.crossSpawn.mockReturnValueOnce(child)

      const resultPromise = execCli('codegraph', ['sync', 'C:\\repo'], { timeout: 100 }, 'win32')
      const rejection = expect(resultPromise).rejects.toMatchObject({ code: 'ETIMEDOUT' })
      await vi.advanceTimersByTimeAsync(100)

      await rejection
      expect(mocks.terminateCliProcess).toHaveBeenCalledWith(child, 'SIGTERM', 'win32')
    } finally {
      vi.useRealTimers()
    }
  })
})
