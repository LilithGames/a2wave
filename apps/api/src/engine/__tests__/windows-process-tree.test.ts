import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSpawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: mockSpawn }))

import { killWindowsProcessTree, terminateCliProcess } from '../windows-process-tree.js'

class FakeTaskkillProcess extends EventEmitter {
  kill = vi.fn()
  unref = vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('killWindowsProcessTree', () => {
  it('runs taskkill asynchronously and reports success after it exits', () => {
    const taskkill = new FakeTaskkillProcess()
    const onComplete = vi.fn()
    mockSpawn.mockReturnValueOnce(taskkill)

    killWindowsProcessTree(1234, onComplete)

    expect(mockSpawn).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '1234', '/T', '/F'],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true }),
    )
    expect(taskkill.unref).toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()

    taskkill.emit('close', 0)
    expect(onComplete).toHaveBeenCalledWith(true)
  })

  it('bounds a stuck taskkill and reports failure', async () => {
    vi.useFakeTimers()
    const taskkill = new FakeTaskkillProcess()
    const onComplete = vi.fn()
    mockSpawn.mockReturnValueOnce(taskkill)

    killWindowsProcessTree(1234, onComplete)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(taskkill.kill).toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith(false)
  })
})

describe('terminateCliProcess', () => {
  it('uses taskkill-compatible tree termination on Windows', () => {
    const child = { pid: 1234, kill: vi.fn() } as unknown as ChildProcess
    const killProcessTree = vi.fn((_pid: number, onComplete: (success: boolean) => void) => {
      onComplete(true)
    })

    terminateCliProcess(child, 'SIGTERM', 'win32', killProcessTree)

    expect(killProcessTree).toHaveBeenCalledWith(1234, expect.any(Function))
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('keeps POSIX termination on the native child-process path', () => {
    const child = { pid: 1234, kill: vi.fn() } as unknown as ChildProcess
    const killProcessTree = vi.fn()

    terminateCliProcess(child, 'SIGTERM', 'linux', killProcessTree)

    expect(killProcessTree).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('falls back to the child when Windows tree termination is unavailable', () => {
    const child = { pid: 1234, kill: vi.fn() } as unknown as ChildProcess
    const killProcessTree = (_pid: number, onComplete: (success: boolean) => void) => {
      onComplete(false)
    }

    terminateCliProcess(child, 'SIGKILL', 'win32', killProcessTree)

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
