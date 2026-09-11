import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), taskkill: vi.fn() }))

vi.mock('../cli-spawn.js', () => ({ spawnCli: mocks.spawn }))
vi.mock('node:child_process', () => ({ spawn: mocks.taskkill }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../runtime-context.js', () => ({ buildSafeAgentProcessEnv: () => ({ PATH: '/bin' }) }))

import { logger } from '../../lib/logger.js'
import { probeCliVersion, runStatusProbe } from '../login-status-helper.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 1234
  kill = vi.fn(() => true)
  unref = vi.fn()
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform') ?? {
  value: process.platform,
  configurable: true,
}
const OUTPUT_LIMIT_BYTES = 1024 * 1024

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  setPlatform('linux')
  vi.spyOn(process, 'kill').mockReturnValue(true)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', platformDescriptor)
})

describe('status probe resource ownership', () => {
  it('creates an isolated POSIX process group without changing the complete environment', async () => {
    const child = new FakeChild()
    mocks.spawn.mockReturnValue(child)
    const completeEnv = { PATH: '/custom/bin' }
    const promise = runStatusProbe('probe', [], { completeEnv })

    expect(mocks.spawn).toHaveBeenCalledWith(
      'probe',
      [],
      expect.objectContaining({ detached: true, env: completeEnv }),
    )
    child.emit('close', 0)
    await promise
  })

  it('keeps force-kill armed when a timed-out POSIX leader exits before its descendants', async () => {
    const child = new FakeChild()
    mocks.spawn.mockReturnValue(child)
    const promise = runStatusProbe('probe', [], { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(promise).resolves.toMatchObject({ timedOut: true, notFound: false })
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
    child.emit('exit', 0)
    child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not signal a vanished group after timeout cleanup has completed', async () => {
    const child = new FakeChild()
    mocks.spawn.mockReturnValue(child)
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      return true
    })
    const promise = runStatusProbe('probe', [], { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    child.emit('exit', 0)
    child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(2_000)

    await promise
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
    expect(process.kill).not.toHaveBeenCalledWith(-child.pid, 'SIGKILL')
  })

  it('stops retaining output after the timeout result has been returned', async () => {
    const child = new FakeChild()
    mocks.spawn.mockReturnValue(child)
    const promise = runStatusProbe('probe', [], { timeoutMs: 100 })
    child.stdout.write('before')
    await vi.advanceTimersByTimeAsync(100)
    await expect(promise).resolves.toMatchObject({ stdout: 'before', timedOut: true })

    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    child.stdout.write('after')
    child.stderr.write('late error')
    child.emit('close', 0)

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ stdoutLen: 11 }),
      '[login-status] probe finished',
    )
    await vi.advanceTimersByTimeAsync(2_000)
  })

  it.each(['stdout', 'stderr'] as const)(
    'fails and releases a probe exceeding the %s byte limit',
    async (stream) => {
      const child = new FakeChild()
      mocks.spawn.mockReturnValue(child)
      const promise = runStatusProbe('probe', [], { timeoutMs: 60_000 })
      child.stdout.write('{"loggedIn":true}\n')
      child[stream].write(Buffer.alloc(OUTPUT_LIMIT_BYTES / 2, 'x'))
      child[stream].write(Buffer.alloc(OUTPUT_LIMIT_BYTES / 2, 'x'))
      child[stream].write('x')
      // A successful leader exit must not turn truncated output into a successful probe.
      child.emit('exit', 0)
      child.emit('close', 0)
      const result = await promise

      expect(result.exitCode).toBeNull()
      expect(result).toMatchObject({ stdout: '', timedOut: false, notFound: false })
      expect(result.stderr).toContain(`${stream} exceeded`)
      expect(Buffer.byteLength(result.stderr)).toBeLessThan(OUTPUT_LIMIT_BYTES)
      expect(child[stream].listenerCount('data')).toBe(0)
      expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL')
    },
  )

  it('preserves split UTF-8 characters and ANSI cleanup in successful results', async () => {
    const child = new FakeChild()
    mocks.spawn.mockReturnValue(child)
    const promise = runStatusProbe('probe', [])
    const output = Buffer.from('\u001b[32mready \u2713\u001b[0m\r\n')
    const characterIndex = output.indexOf(Buffer.from('\u2713'))
    child.stdout.write(output.subarray(0, characterIndex + 1))
    child.stdout.write(output.subarray(characterIndex + 1))
    child.stderr.write('diagnostic\r\n')
    child.emit('close', 0)

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: 'ready \u2713\n',
      stderr: 'diagnostic\n',
      timedOut: false,
      notFound: false,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps version probes best-effort when startup fails synchronously', async () => {
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error('spawn EPERM')
    })
    await expect(probeCliVersion('missing')).resolves.toBeNull()
  })

  it('continues to terminate the complete Windows tree on timeout', async () => {
    setPlatform('win32')
    const child = new FakeChild()
    const taskkill = new FakeChild()
    mocks.spawn.mockReturnValue(child)
    mocks.taskkill.mockReturnValue(taskkill)
    const promise = runStatusProbe('probe.cmd', [], { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(promise).resolves.toMatchObject({ timedOut: true })
    expect(mocks.spawn).toHaveBeenCalledWith(
      'probe.cmd',
      [],
      expect.objectContaining({ detached: false }),
    )
    expect(mocks.taskkill).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '1234', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    )
    child.emit('exit', 0)
    child.emit('close', 0)
    taskkill.emit('close', 0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(child.kill).not.toHaveBeenCalled()
    expect(mocks.taskkill).toHaveBeenCalledTimes(1)
    expect(process.kill).not.toHaveBeenCalled()
  })
})
